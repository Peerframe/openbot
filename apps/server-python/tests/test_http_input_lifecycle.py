"""Real Starlette input and disconnect lifetime used by both attachment route families."""
import asyncio

import pytest
from starlette.requests import Request

from openbot_server import http_input
from openbot_server.control_errors import ControlError
from openbot_server.http_input import read_attachment_upload, request_signal

RAW = 'application/octet-stream'


def scope(headers):
    return {'type': 'http', 'method': 'POST', 'path': '/upload', 'query_string': b'', 'headers': headers}


def upload_request(chunks, *, content_type=RAW, filename='brief.txt'):
    pending = [{'type': 'http.request', 'body': chunk, 'more_body': index < len(chunks) - 1}
               for index, chunk in enumerate(chunks)]
    headers = []
    if content_type is not None:
        headers.append((b'content-type', content_type.encode('latin-1')))
    if filename is not None:
        headers.append((b'x-openbot-filename', filename.encode('latin-1')))
    async def receive():
        return pending.pop(0)
    return Request(scope(headers), receive), pending


def rejected(request, max_bytes=4):
    with pytest.raises(ControlError) as error:
        asyncio.run(read_attachment_upload(request, max_bytes=max_bytes))
    return error.value.status, error.value.code


def test_upload_returns_decoded_name_and_exact_bytes_at_limit():
    request, pending = upload_request([b'ab', b'', b'cd'], filename='%E4%B8%AD%E6%96%87.txt')
    assert asyncio.run(read_attachment_upload(request, max_bytes=4)) == ('中文.txt', b'abcd')
    assert pending == []


def test_upload_rejects_oversize_without_reading_remaining_stream():
    request, pending = upload_request([b'abc', b'de', b'unread'])
    assert rejected(request) == (413, 'attachment_size_limit')
    assert len(pending) == 1


@pytest.mark.parametrize('content_type', [None, RAW + '; charset=binary', 'Application/Octet-Stream',
                                          'application/json'])
def test_upload_requires_exact_raw_content_type_before_reading(content_type):
    request, pending = upload_request([b'unread'], content_type=content_type)
    assert rejected(request) == (415, 'raw_attachment_required')
    assert len(pending) == 1


@pytest.mark.parametrize('filename', [None, '', 'a' * 2049])
def test_upload_requires_bounded_filename_header_before_reading(filename):
    request, pending = upload_request([b'unread'], filename=filename)
    assert rejected(request) == (400, 'attachment_name_required')
    assert len(pending) == 1


def test_upload_accepts_maximum_filename_header_length():
    request, _ = upload_request([b'x'], filename='a' * 2048)
    assert asyncio.run(read_attachment_upload(request, max_bytes=1)) == ('a' * 2048, b'x')


def test_upload_filename_uses_strict_percent_decoding_before_reading():
    request, pending = upload_request([b'unread'], filename='%FF.txt')
    with pytest.raises(UnicodeDecodeError):
        asyncio.run(read_attachment_upload(request, max_bytes=4))
    assert len(pending) == 1


def test_upload_stream_uses_ten_second_timeout(monkeypatch):
    delays = []
    real_timeout = asyncio.timeout
    def observed(delay):
        delays.append(delay)
        return real_timeout(.01)
    monkeypatch.setattr(http_input.asyncio, 'timeout', observed)
    async def receive():
        await asyncio.Event().wait()
    request = Request(scope([(b'content-type', RAW.encode()), (b'x-openbot-filename', b'a.txt')]), receive)
    with pytest.raises(TimeoutError):
        asyncio.run(read_attachment_upload(request, max_bytes=4))
    assert delays == [10]


def disconnect_request():
    gate = asyncio.Event()
    async def receive():
        await gate.wait()
        return {'type': 'http.disconnect'}
    return Request(scope([]), receive), gate


def only_current_task():
    return asyncio.all_tasks() == {asyncio.current_task()}


def test_request_signal_delivers_disconnect_and_cleans_up_after_normal_exit():
    async def check():
        request, gate = disconnect_request()
        async with request_signal(request) as signal:
            await asyncio.sleep(.25)
            assert not signal.is_set()
            gate.set()
            await asyncio.wait_for(signal.wait(), 1)
        assert only_current_task()
    asyncio.run(check())


def test_request_signal_cleans_up_when_body_raises():
    async def check():
        request, _ = disconnect_request()
        with pytest.raises(RuntimeError, match='operation failed'):
            async with request_signal(request) as signal:
                await asyncio.sleep(.15)
                raise RuntimeError('operation failed')
        assert not signal.is_set()
        assert only_current_task()
    asyncio.run(check())


def test_request_signal_cleans_up_after_outer_cancellation():
    async def check():
        request, _ = disconnect_request()
        entered = asyncio.Event()
        async def operation():
            async with request_signal(request):
                entered.set()
                await asyncio.Event().wait()
        job = asyncio.create_task(operation())
        await entered.wait()
        await asyncio.sleep(.15)
        job.cancel()
        with pytest.raises(asyncio.CancelledError):
            await job
        assert only_current_task()
    asyncio.run(check())


@pytest.mark.parametrize('outcome', ['success', 'error', 'disconnect', 'timeout', 'cancel'])
def test_connected_request_preserves_outcome_and_owns_all_tasks(outcome):
    from openbot_server.product_extensions import connected_request
    async def check():
        request, disconnected = disconnect_request()
        started = asyncio.Event()
        finished = asyncio.Event()
        async def operation():
            started.set()
            try:
                if outcome == 'success':
                    return {'models': ['synthetic']}
                if outcome == 'error':
                    raise RuntimeError('provider failed')
                await asyncio.Event().wait()
            finally:
                finished.set()
        job = asyncio.create_task(connected_request(request, operation,
            timeout=.05 if outcome == 'timeout' else 2))
        await started.wait()
        if outcome == 'success':
            assert await job == {'models': ['synthetic']}
        elif outcome == 'error':
            with pytest.raises(RuntimeError, match='provider failed'):
                await job
        elif outcome == 'disconnect':
            disconnected.set()
            with pytest.raises(ControlError) as error:
                await job
            assert (error.value.status, error.value.code) == (409, 'request_cancelled')
        elif outcome == 'timeout':
            with pytest.raises(TimeoutError):
                await job
        else:
            job.cancel()
            with pytest.raises(asyncio.CancelledError):
                await job
        assert finished.is_set()
        assert only_current_task()
    asyncio.run(check())


@pytest.mark.parametrize('outcome', ['success', 'error'])
def test_request_signal_stops_when_disconnect_poll_consumes_cancellation(monkeypatch, outcome):
    """ASGI cancellation scopes may consume cancel(); cleanup still owns the poller's exit."""
    async def check():
        request, _ = disconnect_request()
        polling = asyncio.Event()
        attempts = 0
        async def poll():
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                polling.set()
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    return False
            # An unfixed loop remains here until the outer deadline cancels it again.
            await asyncio.Event().wait()
        monkeypatch.setattr(request, 'is_disconnected', poll)
        async def operation():
            async with request_signal(request) as signal:
                await polling.wait()
                assert not signal.is_set()
                if outcome == 'error':
                    raise RuntimeError('operation failed')
            assert not signal.is_set()
        async with asyncio.timeout(.5):
            if outcome == 'error':
                with pytest.raises(RuntimeError, match='operation failed'):
                    await operation()
            else:
                await operation()
        assert attempts == 1
        assert only_current_task()
    asyncio.run(check())
