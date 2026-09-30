"""The real HTTP fixture preserves refusals and never retries side effects."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.cookiejar import CookieJar
from threading import Thread
import unittest
from urllib.request import HTTPCookieProcessor, build_opener

from product_http_fixture import API, ReadUnavailable

STORAGE = b'{"error":"Control-plane storage is unavailable."}'


class ProductHTTPFixtureTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.response = (503, STORAGE)
        outer = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self): self.reply()
            def do_POST(self): self.reply()
            def reply(self):
                outer.calls.append((self.command, self.path))
                self.rfile.read(int(self.headers.get('Content-Length', '0')))
                code, body = outer.response
                self.send_response(code)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(body)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = Thread(target=self.server.serve_forever)
        self.thread.start()
        self.api = object.__new__(API)
        self.api.url = 'http://127.0.0.1:' + str(self.server.server_port)
        self.api.request_timeout = 2
        self.api.opener = build_opener(HTTPCookieProcessor(CookieJar()))

    def tearDown(self):
        self.server.shutdown()
        self.thread.join(timeout=2)
        self.server.server_close()
        self.assertFalse(self.thread.is_alive())

    def test_snapshot_refusal_is_visible_and_each_call_sends_only_one_read(self):
        for _ in range(2):
            with self.assertRaises(ReadUnavailable): self.api.snapshot('synthetic-task')
        self.assertEqual(self.calls, [('GET', '/api/v1/tasks/synthetic-task')] * 2)

    def test_a_later_success_is_read_from_the_server(self):
        with self.assertRaises(ReadUnavailable): self.api.snapshot('synthetic-task')
        self.response = (200, b'{"status":"completed"}')
        self.assertEqual(self.api.snapshot('synthetic-task'), {'status': 'completed'})
        self.assertEqual(len(self.calls), 2)

    def test_writes_are_neither_reclassified_nor_retried(self):
        with self.assertRaises(AssertionError) as error:
            self.api.call('/api/v1/tasks/synthetic-task', {'operation': 'cancel'})
        self.assertNotIsInstance(error.exception, ReadUnavailable)
        self.assertEqual(self.calls, [('POST', '/api/v1/tasks/synthetic-task')])

    def test_other_http_failures_remain_fatal(self):
        for response in [(403, STORAGE), (500, STORAGE), (503, b'{"error":"other"}'), (503, b'broken')]:
            with self.subTest(response=response):
                self.response = response
                with self.assertRaises(AssertionError) as error: self.api.snapshot('synthetic-task')
                self.assertNotIsInstance(error.exception, ReadUnavailable)
        self.assertEqual(len(self.calls), 4)

    def test_non_snapshot_reads_remain_fatal(self):
        with self.assertRaises(AssertionError) as error: self.api.call('/health')
        self.assertNotIsInstance(error.exception, ReadUnavailable)
        self.assertEqual(self.calls, [('GET', '/health')])

    def test_an_explicit_expected_refusal_is_not_reclassified(self):
        self.assertEqual(self.api.call('/api/v1/tasks/synthetic-task', expected=503),
                         {'error': 'Control-plane storage is unavailable.'})
        self.assertEqual(len(self.calls), 1)

    def test_download_failures_remain_fatal(self):
        with self.assertRaises(AssertionError) as error:
            self.api.call('/api/v1/tasks/synthetic-task', raw=True)
        self.assertNotIsInstance(error.exception, ReadUnavailable)
        self.assertEqual(len(self.calls), 1)


if __name__ == '__main__': unittest.main()
