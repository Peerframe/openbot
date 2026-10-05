"""Pinned fixture downloads retry transport failures, never integrity or file errors."""
import hashlib
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import call, patch
from urllib.error import HTTPError, URLError

import product_browser_upstream as upstream

CONTENT = b'Synthetic upstream license\n'


class FakeConnection(BytesIO):
    def __init__(self, content=CONTENT, error=None):
        super().__init__(content)
        self.error = error
        self.read_limits = []

    def read(self, size=-1):
        self.read_limits.append(size)
        if self.error is not None:
            raise self.error
        return super().read(size)


class ProductBrowserUpstreamTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / 'upstream'
        self.entry = {'path': 'LICENSE', 'bytes': len(CONTENT),
                      'sha256': hashlib.sha256(CONTENT).hexdigest()}
        manifest = {'repository': upstream.MANIFEST['repository'], 'commit': upstream.MANIFEST['commit'], 'files': [self.entry]}
        self.url = ('https://raw.githubusercontent.com/'+manifest['repository']+'/'
                    + manifest['commit'] + '/LICENSE')
        patcher = patch.object(upstream, 'MANIFEST', manifest)
        patcher.start()
        self.addCleanup(patcher.stop)
        opener = patch.object(upstream, 'urlopen')
        self.urlopen = opener.start()
        self.addCleanup(opener.stop)
        sleeper = patch.object(upstream, 'sleep')
        self.sleep = sleeper.start()
        self.addCleanup(sleeper.stop)

    def test_two_network_failures_then_success_prepares_verified_fixture(self):
        response = FakeConnection()
        self.urlopen.side_effect = [URLError(ConnectionResetError(104, 'Connection reset by peer')),
                                   TimeoutError('Timed out'), response]
        upstream.prepare(self.root)
        upstream.verify(self.root)
        self.assertEqual((self.root / 'LICENSE').read_bytes(), CONTENT)
        self.assertEqual(self.urlopen.call_args_list, [call(self.url, timeout=30)] * 3)
        self.assertEqual(self.sleep.call_args_list, [call(1), call(2)])
        self.assertEqual(response.read_limits, [len(CONTENT) + 1])
        self.assertTrue(response.closed)

    def test_response_read_network_errors_are_retried_and_connections_closed(self):
        responses = [FakeConnection(error=ConnectionResetError(104, 'Connection reset by peer')),
                     FakeConnection(error=TimeoutError('Timed out')), FakeConnection()]
        self.urlopen.side_effect = responses
        upstream.prepare(self.root)
        self.assertEqual(self.urlopen.call_count, 3)
        self.assertEqual(self.sleep.call_args_list, [call(1), call(2)])
        self.assertTrue(all(response.closed for response in responses))

    def test_two_server_errors_then_success(self):
        self.urlopen.side_effect = [HTTPError(self.url, 500, 'Server error', None, None),
                                   HTTPError(self.url, 503, 'Unavailable', None, None),
                                   FakeConnection()]
        upstream.prepare(self.root)
        self.assertEqual(self.urlopen.call_count, 3)
        self.assertEqual(self.sleep.call_args_list, [call(1), call(2)])

    def test_network_and_server_errors_stop_after_three_attempts(self):
        for error in [URLError(ConnectionResetError(104, 'Connection reset by peer')),
                      HTTPError(self.url, 502, 'Bad gateway', None, None)]:
            with self.subTest(error=error), TemporaryDirectory() as directory:
                self.urlopen.reset_mock()
                self.sleep.reset_mock()
                self.urlopen.side_effect = [error] * 3
                root = Path(directory) / 'upstream'
                with self.assertRaises(type(error)) as caught:
                    upstream.prepare(root)
                self.assertIs(caught.exception, error)
                self.assertEqual(self.urlopen.call_count, 3)
                self.assertEqual(self.sleep.call_args_list, [call(1), call(2)])
                self.assertFalse((root / 'LICENSE').exists())

    def test_non_server_http_errors_are_not_retried(self):
        for code in [400, 403, 404, 429, 600]:
            with self.subTest(code=code), TemporaryDirectory() as directory:
                self.urlopen.reset_mock()
                self.sleep.reset_mock()
                error = HTTPError(self.url, code, 'Refused', None, None)
                self.urlopen.side_effect = [error]
                with self.assertRaises(HTTPError) as caught:
                    upstream.prepare(Path(directory) / 'upstream')
                self.assertIs(caught.exception, error)
                self.assertEqual(self.urlopen.call_count, 1)
                self.sleep.assert_not_called()

    def test_size_and_hash_failures_are_not_retried_even_after_network_recovery(self):
        for content in [CONTENT[:-1], CONTENT + b'extra', b'X' * len(CONTENT)]:
            for prior_failures in [0, 1]:
                with self.subTest(content=content, prior_failures=prior_failures), TemporaryDirectory() as directory:
                    self.urlopen.reset_mock()
                    self.sleep.reset_mock()
                    response = FakeConnection(content)
                    self.urlopen.side_effect = ([URLError('Connection reset')] * prior_failures
                                                + [response, FakeConnection()])
                    root = Path(directory) / 'upstream'
                    with self.assertRaisesRegex(ValueError, 'Public upstream hash mismatch: LICENSE'):
                        upstream.prepare(root)
                    self.assertEqual(self.urlopen.call_count, prior_failures + 1)
                    self.assertEqual(self.sleep.call_args_list, [call(1)] * prior_failures)
                    self.assertEqual(response.read_limits, [len(CONTENT) + 1])
                    self.assertTrue(response.closed)
                    self.assertFalse((root / 'LICENSE').exists())

    def test_local_write_errors_are_not_retried(self):
        self.urlopen.side_effect = [FakeConnection()]
        with patch.object(Path, 'write_bytes', side_effect=PermissionError('Read-only fixture')):
            with self.assertRaises(PermissionError):
                upstream.prepare(self.root)
        self.assertEqual(self.urlopen.call_count, 1)
        self.sleep.assert_not_called()


if __name__ == '__main__': unittest.main()
