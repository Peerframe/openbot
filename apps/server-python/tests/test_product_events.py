"""Mechanical Owner SSE loop: exact frames, 3 s pacing, end conditions, cancellation and no retry."""
import asyncio
import inspect

import pytest

from openbot_server import product_events
from openbot_server.product_events import HEARTBEAT, event_stream, poll_events, ready_event

PAYLOAD = {'type': 'workspace.ready', 'nodes': []}
READY = 'event: workspace.ready\nretry: 2000\ndata: {"type": "workspace.ready", "nodes": []}\n\n'


class Connection:
    """Reports disconnect once `polls` connected checks have passed."""
    def __init__(self, polls):
        self.polls = polls
        self.checks = 0

    async def is_disconnected(self):
        self.checks += 1
        return self.checks > self.polls


class Observer:
    def __init__(self, *outcomes):
        self.outcomes = list(outcomes)
        self.calls = 0

    async def __call__(self):
        self.calls += 1
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


class Pacing:
    def __init__(self):
        self.delays = []

    async def __call__(self, delay):
        self.delays.append(delay)


def collect(connection, observer, pacing, name='workspace.ready'):
    async def run():
        return [frame async for frame in poll_events(connection, name, observer, sleep=pacing)]
    return asyncio.run(run())


def test_ready_frame_is_byte_compatible_and_uses_default_json_encoding():
    assert ready_event('workspace.ready', PAYLOAD) == READY
    assert ready_event('channel.ready', {'type': 'channel.ready', 'channelId': '中'}) == (
        'event: channel.ready\nretry: 2000\ndata: {"type": "channel.ready", "channelId": "\\u4e2d"}\n\n')
    assert HEARTBEAT == 'event: heartbeat\ndata: alive\n\n'


def test_ready_then_heartbeat_then_ready_when_compared_state_changes():
    connection = Connection(4)
    observer = Observer(('[{}, 0]', PAYLOAD), ('[{}, 0]', PAYLOAD), ('[{}, 1]', PAYLOAD), ('[{}, 1]', PAYLOAD))
    pacing = Pacing()
    assert collect(connection, observer, pacing) == [READY, HEARTBEAT, READY, HEARTBEAT]
    assert observer.calls == 4
    assert pacing.delays == [3, 3, 3, 3]
    assert connection.checks == 5


def test_invalidated_authority_ends_stream_without_another_wait():
    observer = Observer(('state', PAYLOAD), None, ('unused', PAYLOAD))
    pacing = Pacing()
    assert collect(Connection(10), observer, pacing) == [READY]
    assert observer.calls == 2
    assert pacing.delays == [3]
    assert len(observer.outcomes) == 1


def test_disconnect_before_first_poll_reads_nothing():
    observer = Observer()
    pacing = Pacing()
    assert collect(Connection(0), observer, pacing) == []
    assert observer.calls == 0
    assert pacing.delays == []


def test_disconnect_after_ready_stops_before_next_observation():
    connection = Connection(1)
    observer = Observer(('a', PAYLOAD), ('b', PAYLOAD))
    pacing = Pacing()
    assert collect(connection, observer, pacing) == [READY]
    assert observer.calls == 1
    assert connection.checks == 2
    assert pacing.delays == [3]


def test_observation_error_propagates_once_without_retry_or_wait():
    observer = Observer(('a', PAYLOAD), RuntimeError('store failed'), ('a', PAYLOAD))
    pacing = Pacing()
    frames = []
    async def run():
        async for frame in poll_events(Connection(10), 'workspace.ready', observer, sleep=pacing):
            frames.append(frame)
    with pytest.raises(RuntimeError, match='store failed'):
        asyncio.run(run())
    assert frames == [READY]
    assert observer.calls == 2
    assert pacing.delays == [3]
    assert len(observer.outcomes) == 1


def test_cancelled_consumer_closes_loop_without_leftover_tasks():
    async def check():
        observer = Observer(('a', PAYLOAD), ('b', PAYLOAD))
        waiting = asyncio.Event()
        async def pacing(_delay):
            waiting.set()
            await asyncio.Event().wait()
        frames = []
        async def consume():
            async for frame in poll_events(Connection(10), 'workspace.ready', observer, sleep=pacing):
                frames.append(frame)
        job = asyncio.create_task(consume())
        await waiting.wait()
        job.cancel()
        with pytest.raises(asyncio.CancelledError):
            await job
        assert frames == [READY]
        assert observer.calls == 1
        assert asyncio.all_tasks() == {asyncio.current_task()}
    asyncio.run(check())


def test_closing_stream_after_first_frame_stops_observation():
    async def check():
        observer = Observer(('a', PAYLOAD), ('b', PAYLOAD))
        pacing = Pacing()
        stream = poll_events(Connection(10), 'workspace.ready', observer, sleep=pacing)
        assert await anext(stream) == READY
        await stream.aclose()
        with pytest.raises(StopAsyncIteration):
            await anext(stream)
        assert observer.calls == 1
        assert pacing.delays == []
    asyncio.run(check())


def test_event_stream_response_headers_and_defaults():
    async def frames():
        yield HEARTBEAT
    response = event_stream(frames())
    assert response.media_type == 'text/event-stream'
    assert response.headers['content-type'].startswith('text/event-stream')
    assert response.headers['cache-control'] == 'no-store'
    assert response.headers['x-accel-buffering'] == 'no'
    assert product_events.POLL_SECONDS == 3
    assert inspect.signature(poll_events).parameters['sleep'].default is asyncio.sleep
