"""Framing tests for :mod:`openbot_agent_runtime.wire`.

Every bound in the frozen profile is exercised on a real pipe rather than a stub,
because the properties that matter — a frame split across reads, an unterminated
frame, a partial write, a direction budget — only exist on a descriptor. A pipe holds
far less than a profile-sized payload, so the synthetic parent here always feeds and
reads concurrently; a test that wrote first and read later would deadlock on the pipe
rather than on the code under test. The data is synthetic throughout: no provider, no
credential, no network.
"""

from __future__ import annotations

import asyncio
import json
import os

import pytest

from openbot_agent_runtime import wire

pytestmark = pytest.mark.anyio

TIMEOUT = 10.0
FEED_CHUNK = 16 * 1024


class _Channel:
    """A reader and a writer over one real pipe pair."""

    def __init__(self) -> None:
        self.read_fd, self.write_fd = os.pipe()
        self.reader = wire.FrameReader(self.read_fd)
        self.writer = wire.FrameWriter(self.write_fd)
        self._input_closed = False

    def close(self) -> None:
        self.reader.close()
        for fd in (self.read_fd, self.write_fd):
            try:
                os.close(fd)
            except OSError:
                pass

    async def feed(self, data: bytes) -> None:
        """Write ``data`` into the pipe without ever blocking the event loop.

        The write end is non-blocking (the writer made it so), so a full pipe is
        retried after yielding instead of stalling the reader.
        """
        view = memoryview(data)
        while view:
            try:
                written = os.write(self.write_fd, view[:FEED_CHUNK])
            except BlockingIOError:
                await asyncio.sleep(0.001)
                continue
            view = view[written:]
            await asyncio.sleep(0)

    def end_input(self) -> None:
        if self._input_closed:
            return
        self._input_closed = True
        os.close(self.write_fd)

    async def drain(self, expected: int) -> bytes:
        """Read exactly ``expected`` bytes in a worker thread."""
        return await asyncio.to_thread(self._drain, expected)

    def _drain(self, expected: int) -> bytes:
        chunks: list[bytes] = []
        total = 0
        while total < expected:
            chunk = os.read(self.read_fd, min(64 * 1024, expected - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        return b"".join(chunks)


async def _pump(channel: _Channel, data: bytes) -> list[object]:
    """Feed ``data`` while reading; close the write end when the feed ends.

    Returns every decoded value up to EOF, or raises the reader's refusal.
    """
    feeder = asyncio.create_task(channel.feed(data))
    values: list[object] = []
    try:
        next_task = asyncio.create_task(channel.reader.next_value())
        while True:
            await asyncio.wait({next_task, feeder}, return_when=asyncio.FIRST_COMPLETED)
            if next_task.done():
                value = next_task.result()
                if value is None:
                    return values
                values.append(value)
                next_task = asyncio.create_task(channel.reader.next_value())
                continue
            channel.end_input()
            await feeder
    finally:
        if not feeder.done():
            feeder.cancel()
            await asyncio.gather(feeder, return_exceptions=True)


async def _refusal(channel: _Channel, data: bytes) -> wire.ProtocolViolation:
    with pytest.raises(wire.ProtocolViolation) as caught:
        await _pump(channel, data)
    return caught.value


# --- the happy path -----------------------------------------------------------


async def test_frames_are_lf_delimited_values() -> None:
    channel = _Channel()
    try:
        assert await _pump(channel, b'{"a":1}\n{"b":[2,3]}\n') == [{"a": 1}, {"b": [2, 3]}]
        assert channel.reader.frames_read == 2
    finally:
        channel.close()


async def test_a_frame_split_across_reads_is_reassembled() -> None:
    channel = _Channel()

    async def feed_two_halves() -> None:
        await channel.feed(b'{"hello":"wo')
        await asyncio.sleep(0.05)
        await channel.feed(b'rld"}\n')

    feeder = asyncio.create_task(feed_two_halves())
    try:
        value = await asyncio.wait_for(channel.reader.next_value(), timeout=TIMEOUT)
        assert value == {"hello": "world"}
    finally:
        await feeder
        channel.end_input()
        channel.close()


async def test_many_frames_in_one_read_are_all_returned_in_order() -> None:
    channel = _Channel()
    try:
        payload = b"".join(b'{"n":%d}\n' % index for index in range(50))
        assert await _pump(channel, payload) == [{"n": index} for index in range(50)]
    finally:
        channel.close()


async def test_a_frame_of_exactly_the_limit_is_accepted() -> None:
    body = ('"' + "x" * (wire.MAX_FRAME_BYTES - 2) + '"').encode("utf-8")
    assert len(body) == wire.MAX_FRAME_BYTES
    channel = _Channel()
    try:
        values = await _pump(channel, body + b"\n" + b'{"after":true}\n')
        assert values == [body[1:-1].decode(), {"after": True}]
    finally:
        channel.close()


# --- frame and direction bounds ----------------------------------------------


async def test_an_unterminated_frame_at_eof_is_refused() -> None:
    channel = _Channel()
    try:
        violation = await _refusal(channel, b'{"a":1}')
        assert violation.code == wire.INVALID_REQUEST_CODE
    finally:
        channel.close()


async def test_an_oversize_frame_is_refused_before_its_delimiter_arrives() -> None:
    channel = _Channel()
    try:
        violation = await _refusal(channel, b"x" * (wire.MAX_FRAME_BYTES + 1))
        assert violation.code == wire.INVALID_REQUEST_CODE
    finally:
        channel.close()


async def test_an_oversize_frame_with_its_delimiter_is_refused() -> None:
    channel = _Channel()
    try:
        violation = await _refusal(channel, b"x" * (wire.MAX_FRAME_BYTES + 1) + b"\n")
        assert violation.code == wire.INVALID_REQUEST_CODE
    finally:
        channel.close()


async def test_the_frame_count_bound_is_enforced() -> None:
    channel = _Channel()
    try:
        violation = await _refusal(channel, b"{}\n" * (wire.MAX_DIRECTION_FRAMES + 1))
        assert violation.code == wire.INVALID_REQUEST_CODE
    finally:
        channel.close()


async def test_the_direction_byte_bound_is_enforced() -> None:
    body = b"[" + b"0," * 262_142 + b"0]"
    assert len(body) <= wire.MAX_FRAME_BYTES
    frames = wire.MAX_DIRECTION_BYTES // len(body) + 2
    assert frames < wire.MAX_DIRECTION_FRAMES
    channel = _Channel()
    try:
        violation = await _refusal(channel, (body + b"\n") * frames)
        assert violation.code == wire.INVALID_REQUEST_CODE
    finally:
        channel.close()


# --- codec refusals -----------------------------------------------------------


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param(b"not json\n", id="not-json"),
        pytest.param(b"\n", id="blank-frame"),
        pytest.param(b"[1,2,3]\xff\n", id="invalid-utf8"),
        pytest.param(b'{"a":NaN}\n', id="nan"),
        pytest.param(b'{"a":Infinity}\n', id="infinity"),
        pytest.param(b'{"a":-Infinity}\n', id="negative-infinity"),
        pytest.param(b'{"a":1e400}\n', id="overflow-to-infinity"),
        pytest.param(b'{"a":-1e400}\n', id="overflow-to-negative-infinity"),
        pytest.param(b'{"a":[{"b":1e999}]}\n', id="nested-overflow"),
        pytest.param(b'{"a":1,"a":2}\n', id="duplicate-key"),
        pytest.param(b'"\\ud800"\n', id="lone-surrogate-escape"),
        pytest.param(b'{"a":"\\udfff"}\n', id="lone-surrogate-in-value"),
    ],
)
async def test_a_frame_the_profile_cannot_carry_is_refused(payload: bytes) -> None:
    channel = _Channel()
    try:
        violation = await _refusal(channel, payload)
        assert (violation.code, violation.message) == (
            wire.INVALID_REQUEST_CODE,
            "Invalid request",
        )
    finally:
        channel.close()


async def test_depth_at_the_limit_is_accepted() -> None:
    value: object = 1
    for _ in range(wire.MAX_JSON_DEPTH):
        value = [value]
    assert wire.json_depth(value) == wire.MAX_JSON_DEPTH
    channel = _Channel()
    try:
        assert await _pump(channel, json.dumps(value).encode() + b"\n") == [value]
    finally:
        channel.close()


async def test_depth_beyond_the_limit_is_refused() -> None:
    value: object = 1
    for _ in range(wire.MAX_JSON_DEPTH + 1):
        value = [value]
    assert wire.json_depth(value) == wire.MAX_JSON_DEPTH + 1
    channel = _Channel()
    try:
        violation = await _refusal(channel, json.dumps(value).encode() + b"\n")
        assert violation.code == wire.INVALID_REQUEST_CODE
    finally:
        channel.close()


async def test_a_container_chain_at_the_limit_is_accepted() -> None:
    """A chain ending in an empty container, not a scalar, uses the same bound."""
    value: object = []
    for _ in range(wire.MAX_JSON_DEPTH):
        value = [value]
    assert wire.json_depth(value) == wire.MAX_JSON_DEPTH
    channel = _Channel()
    try:
        assert await _pump(channel, json.dumps(value).encode() + b"\n") == [value]
    finally:
        channel.close()


async def test_a_container_chain_beyond_the_limit_is_refused() -> None:
    value: object = []
    for _ in range(wire.MAX_JSON_DEPTH + 1):
        value = [value]
    channel = _Channel()
    try:
        violation = await _refusal(channel, json.dumps(value).encode() + b"\n")
        assert violation.code == wire.INVALID_REQUEST_CODE
    finally:
        channel.close()


async def test_depth_far_beyond_the_scanner_limit_is_a_refusal_not_a_crash() -> None:
    """The C scanner raises RecursionError long before any value exists."""
    channel = _Channel()
    try:
        violation = await _refusal(channel, b"[" * 200_000 + b"]" * 200_000 + b"\n")
        assert violation.code == wire.INVALID_REQUEST_CODE
    finally:
        channel.close()


def test_a_violation_carries_only_a_fixed_code_and_message() -> None:
    violation = wire.ProtocolViolation()
    assert (violation.code, violation.message) == (wire.INVALID_REQUEST_CODE, "Invalid request")
    assert str(violation) == "Invalid request"
    with pytest.raises(AssertionError):
        wire.ProtocolViolation(-99999)


# --- encoding -----------------------------------------------------------------


def test_encode_frame_is_compact_utf8_without_escaping() -> None:
    payload = wire.encode_frame({"text": "答案"})
    assert payload == '{"text":"答案"}'.encode("utf-8")
    assert b"\\u" not in payload


@pytest.mark.parametrize(
    "value",
    [
        pytest.param(float("nan"), id="nan"),
        pytest.param(float("inf"), id="infinity"),
        pytest.param("\ud800", id="lone-surrogate"),
        pytest.param(object(), id="no-json-form"),
    ],
)
def test_encode_refuses_a_value_the_profile_cannot_carry(value: object) -> None:
    with pytest.raises(wire.ProtocolViolation):
        wire.encode_frame(value)


def test_encode_refuses_excess_depth_and_oversize_bodies() -> None:
    deep: object = 1
    for _ in range(wire.MAX_JSON_DEPTH + 1):
        deep = [deep]
    with pytest.raises(wire.ProtocolViolation):
        wire.encode_frame(deep)
    with pytest.raises(wire.ProtocolViolation):
        wire.encode_frame("x" * (wire.MAX_FRAME_BYTES + 1))


# --- writing ------------------------------------------------------------------


async def test_the_writer_emits_one_lf_terminated_frame_per_value() -> None:
    channel = _Channel()
    try:
        await channel.writer.write_value({"a": 1})
        await channel.writer.write_value({"b": 2})
        raw = await channel.drain(len(b'{"a":1}\n{"b":2}\n'))
        assert raw == b'{"a":1}\n{"b":2}\n'
        assert channel.writer.frames_written == 2
        assert channel.writer.bytes_written == len(raw)
    finally:
        channel.close()


async def test_the_writer_survives_partial_writes_of_large_frames() -> None:
    """Frames far larger than a pipe buffer must arrive whole and in order."""
    channel = _Channel()
    try:
        payloads = [{"n": index, "blob": "y" * (wire.MAX_FRAME_BYTES - 64)} for index in range(4)]
        expected = b"".join(wire.encode_frame(item) + b"\n" for item in payloads)
        assert len(expected) > 1024 * 1024

        async def write_all() -> None:
            for item in payloads:
                await channel.writer.write_value(item)

        writer_task = asyncio.create_task(write_all())
        raw = await channel.drain(len(expected))
        await writer_task
        assert raw == expected
        assert [json.loads(line) for line in raw.split(b"\n") if line] == payloads
    finally:
        channel.close()


async def test_the_writer_refuses_a_frame_count_over_its_budget() -> None:
    channel = _Channel()
    try:
        for _ in range(wire.MAX_DIRECTION_FRAMES):
            await channel.writer.write_value({})
        with pytest.raises(wire.WireLimitExceeded):
            await channel.writer.write_value({})
    finally:
        channel.close()


async def test_the_writer_reports_a_closed_channel_as_a_violation() -> None:
    read_fd, write_fd = os.pipe()
    os.close(read_fd)
    writer = wire.FrameWriter(write_fd)
    try:
        with pytest.raises(wire.ProtocolViolation):
            await writer.write_value({"a": 1})
    finally:
        try:
            os.close(write_fd)
        except OSError:
            pass


# --- pure helpers -------------------------------------------------------------


def test_json_depth_matches_the_server_root_at_zero_convention() -> None:
    """Depth is the deepest node's level, with the root at 0.

    Matches ``assertRuntimeJson`` in the Server's ``agent-runtime-wire.ts``: an
    empty *root* container is depth 0, and a container contributes its own level.
    """
    assert wire.json_depth(1) == 0
    assert wire.json_depth("not a container") == 0
    assert wire.json_depth({}) == 0
    assert wire.json_depth([]) == 0
    assert wire.json_depth([1]) == 1
    assert wire.json_depth([[]]) == 1
    assert wire.json_depth({"a": {"b": [1]}}) == 3
    assert wire.json_depth([[[[]]]]) == 3


def test_the_fixed_messages_are_the_only_protocol_messages() -> None:
    assert set(wire.FIXED_MESSAGES) == {-32600, -32601, -32602}
    assert all(message.isascii() for message in wire.FIXED_MESSAGES.values())
    assert set(wire.FIXED_MESSAGES.values()) == {
        "Invalid request",
        "Method not found",
        "Invalid params",
    }
