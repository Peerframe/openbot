"""Contract tests for the parent-side wire codec in ``runtime_wire``.

Expectations were produced from the released TypeScript profile *first*, not from this module: one
90-value and one 37-framing case set was run through ``apps/server/dist/agent-runtime-wire.js`` and
through ``runtime_wire`` with byte-identical inputs. Both sides agree on every case except

* the two deliberate deviations the module documents (duplicate object keys, and unpaired
  surrogates, which ``JSON.parse`` admits and this parent refuses); and
* cases the TypeScript *reader* refuses only because it also applies the released MCP JSON-RPC
  union (``{"foo": 1}``, a numeric ``id``, a notification frame). Framing here is codec-only; every
  decoded frame still goes through :func:`validate_worker_message`, and the tests below assert that
  the profile refuses those shapes as well.

These are codec tests. They say nothing about authority, model traffic, tools or persistence.
"""

import json

import pytest

from openbot_server import runtime_wire

CHECK = "Continue the Server-bound task."
DELIVERED = "Delivered."
CANARY = "OB-CANARY-child-text"
ASTRA = "\U0001f600"


def request(identity="w1", method="authority.check", params=None):
    return {"jsonrpc": "2.0", "id": identity, "method": method, "params": {} if params is None else params}


def deliver(text=DELIVERED):
    return {"jsonrpc": "2.0", "id": "run", "result": {"text": text}}


def denial(reason="step_limit"):
    return {
        "jsonrpc": "2.0",
        "id": "run",
        "error": {
            "code": -32000,
            "message": "Runtime operation refused",
            "data": {"reason": reason},
        },
    }


def intent(**overrides):
    value = {"id": "i1", "name": "read", "arguments": {}}
    value.update(overrides)
    return value


def generate(messages):
    return request("w1", "model.generate", {"messages": messages})


def nested(depth):
    value = {}
    for _ in range(depth):
        value = {"next": value}
    return value


def encoded(value):
    """The bytes a well-behaved worker would write for ``value`` (stdlib only, never the module)."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"


# The compact form of an empty-text final frame, excluding its line feed. Every byte-boundary case
# is built from it, so an off-by-one in the padding would fail the test rather than pass it.
EMPTY_DELIVERED_BYTES = len(
    json.dumps({"jsonrpc": "2.0", "id": "run", "result": {"text": ""}},
               ensure_ascii=False, separators=(",", ":")).encode("utf-8")
)


def padded_frame(content_bytes):
    """One final frame whose content, excluding the line feed, is exactly ``content_bytes``."""
    return {"jsonrpc": "2.0", "id": "run",
            "result": {"text": "x" * (content_bytes - EMPTY_DELIVERED_BYTES)}}


# ---------------------------------------------------------------------------
# FrameDecoder
# ---------------------------------------------------------------------------

def test_decoder_returns_every_completed_frame_in_order():
    decoder = runtime_wire.FrameDecoder()
    assert decoder.push(encoded(request())) == [request()]
    both = encoded(request(identity="w1")) + encoded(request(identity="w2"))
    assert decoder.push(both) == [request(identity="w1"), request(identity="w2")]
    decoder.finish()


def test_decoder_streams_one_byte_at_a_time_across_a_multibyte_character():
    decoder = runtime_wire.FrameDecoder()
    frames = []
    for byte in encoded(deliver("\u4ea4\u4ed8")):
        frames.extend(decoder.push(bytes([byte])))
    assert frames == [deliver("\u4ea4\u4ed8")]
    decoder.finish()


def test_decoder_holds_an_incomplete_frame_until_its_line_feed_arrives():
    decoder = runtime_wire.FrameDecoder()
    whole = encoded(deliver())
    assert decoder.push(whole[:-2]) == []
    assert decoder.push(whole[-2:]) == [deliver()]
    decoder.finish()


def test_decoder_accepts_one_trailing_carriage_return_like_the_reference_reader():
    decoder = runtime_wire.FrameDecoder()
    body = json.dumps(request()).encode("utf-8")
    assert decoder.push(body + b"\r\n") == [request()]
    decoder.finish()


def test_decoder_accepts_trailing_whitespace_inside_the_frame():
    decoder = runtime_wire.FrameDecoder()
    assert decoder.push(b" " + json.dumps(request()).encode("utf-8") + b" \n") == [request()]
    decoder.finish()


@pytest.mark.parametrize(
    "label, chunk",
    [
        ("invalid continuation", b"{\"\xc3\x28\n"),
        ("lone continuation byte", b"\x80\n"),
        ("overlong encoding", b"\xc0\xaf\n"),
        ("utf8 surrogate encoding", b"\xed\xa0\x80\n"),
        ("truncated sequence before the line feed", b'{"a":"\xe4"}\n'),
    ],
)
def test_decoder_refuses_bytes_that_are_not_utf8(label, chunk):
    with pytest.raises(runtime_wire.RuntimeProtocolError):
        runtime_wire.FrameDecoder().push(chunk)


@pytest.mark.parametrize(
    "raw",
    [
        b"not-json\n",
        b"\n",
        b" \n",
        b"NaN\n",
        b"Infinity\n",
        b"-Infinity\n",
        b"[]\n",
        b"5\n",
        b"null\n",
        b'"x"\n',
        b"\xef\xbb\xbf{ }\n",
        b'{"a":1,}\n',
        b'{"a":01}\n',
    ],
)
def test_decoder_refuses_anything_that_is_not_a_json_object_frame(raw):
    with pytest.raises(runtime_wire.RuntimeProtocolError):
        runtime_wire.FrameDecoder().push(raw)


def test_decoder_refuses_duplicate_object_keys_before_any_callback():
    duplicate = b'{"jsonrpc":"2.0","id":"w1","method":"authority.check","params":{},"params":{}}\n'
    with pytest.raises(runtime_wire.RuntimeProtocolError):
        runtime_wire.FrameDecoder().push(duplicate)


def test_decoder_refuses_an_unpaired_surrogate_escape():
    with pytest.raises(runtime_wire.RuntimeProtocolError):
        runtime_wire.FrameDecoder().push(b'{"jsonrpc":"2.0","id":"run","result":{"text":"\\ud800"}}\n')
    # A correctly paired escape is the same character JSON.parse produces, and is admitted.
    decoder = runtime_wire.FrameDecoder()
    assert decoder.push(b'{"jsonrpc":"2.0","id":"run","result":{"text":"\\ud83d\\ude00"}}\n') == [
        deliver(ASTRA)
    ]


@pytest.mark.parametrize("raw", [b'{"v":1e400}\n', b'{"v":-1e400}\n', b'{"v":' + b"1" + b"0" * 400 + b"}\n"])
def test_decoder_refuses_numbers_that_are_not_finite_doubles(raw):
    with pytest.raises(runtime_wire.RuntimeProtocolError):
        runtime_wire.FrameDecoder().push(raw)


def test_decoder_accepts_the_smallest_denormal_double():
    decoder = runtime_wire.FrameDecoder()
    assert decoder.push(b'{"v":5e-324}\n') == [{"v": 5e-324}]


def test_decoder_refuses_a_frame_one_byte_over_the_frame_bound():
    at_limit = encoded(padded_frame(runtime_wire.RUNTIME_FRAME_BYTES))
    assert len(at_limit) - 1 == runtime_wire.RUNTIME_FRAME_BYTES
    decoder = runtime_wire.FrameDecoder()
    assert len(decoder.push(at_limit)) == 1
    decoder.finish()
    with pytest.raises(runtime_wire.RuntimeProtocolError):
        runtime_wire.FrameDecoder().push(encoded(padded_frame(runtime_wire.RUNTIME_FRAME_BYTES + 1)))
    with pytest.raises(runtime_wire.RuntimeProtocolError):
        runtime_wire.FrameDecoder().push(b"x" * (runtime_wire.RUNTIME_FRAME_BYTES + 1))


def test_decoder_refuses_a_lifetime_total_over_eight_mebibytes():
    frame = encoded(padded_frame(10_000))
    assert len(frame) == 10_001
    assert 838 * len(frame) <= runtime_wire.RUNTIME_TOTAL_BYTES < 839 * len(frame)
    decoder = runtime_wire.FrameDecoder()
    for _ in range(838):
        decoder.push(frame)
    decoder.finish()
    with pytest.raises(runtime_wire.RuntimeProtocolError):
        decoder.push(frame)


def test_decoder_refuses_more_than_the_frame_count_bound():
    decoder = runtime_wire.FrameDecoder()
    for _ in range(runtime_wire.RUNTIME_MAX_FRAMES):
        assert len(decoder.push(encoded(request()))) == 1
    decoder.finish()
    with pytest.raises(runtime_wire.RuntimeProtocolError):
        decoder.push(encoded(request()))


def test_decoder_refuses_nesting_deeper_than_sixty_four_nodes():
    decoder = runtime_wire.FrameDecoder()
    assert decoder.push(encoded({"jsonrpc": "2.0", "id": "run", "result": nested(63)})) == [
        {"jsonrpc": "2.0", "id": "run", "result": nested(63)}
    ]
    with pytest.raises(runtime_wire.RuntimeProtocolError):
        runtime_wire.FrameDecoder().push(encoded({"jsonrpc": "2.0", "id": "run", "result": nested(64)}))


def test_finish_refuses_a_stream_that_ended_inside_a_frame():
    decoder = runtime_wire.FrameDecoder()
    decoder.push(b'{"jsonrpc":')
    with pytest.raises(runtime_wire.RuntimeProtocolError):
        decoder.finish()
    complete = runtime_wire.FrameDecoder()
    complete.push(encoded(request()))
    complete.finish()
    complete.finish()


def test_a_refused_push_returns_nothing_at_all():
    decoder = runtime_wire.FrameDecoder()
    with pytest.raises(runtime_wire.RuntimeProtocolError):
        # The first frame is complete, the second one is oversized: neither may be observed.
        decoder.push(encoded(request()) + b"x" * (runtime_wire.RUNTIME_FRAME_BYTES + 1))


# ---------------------------------------------------------------------------
# FrameEncoder
# ---------------------------------------------------------------------------

def test_encoder_emits_one_compact_lf_terminated_utf8_frame():
    assert runtime_wire.FrameEncoder().encode(deliver("\u4ea4\u4ed8")) == (
        b'{"jsonrpc":"2.0","id":"run","result":{"text":"\xe4\xba\xa4\xe4\xbb\x98"}}\n'
    )


def test_encoder_freezes_the_request_and_denial_spellings():
    encoder = runtime_wire.FrameEncoder()
    assert encoder.encode(request()) == b'{"jsonrpc":"2.0","id":"w1","method":"authority.check","params":{}}\n'
    assert encoder.encode(denial("step_limit")) == (
        b'{"jsonrpc":"2.0","id":"run","error":{"code":-32000,'
        b'"message":"Runtime operation refused","data":{"reason":"step_limit"}}}\n'
    )


@pytest.mark.parametrize("value", ["text", 5, None, [1, 2]])
def test_encoder_refuses_a_frame_that_is_not_an_object(value):
    with pytest.raises(runtime_wire.RuntimeProtocolError):
        runtime_wire.FrameEncoder().encode(value)


@pytest.mark.parametrize(
    "value",
    [
        {"v": float("inf")},
        {"v": float("nan")},
        {"v": 10**400},
        {"v": nested(65)},
        {"v": ("tuple",)},
        {"v": b"bytes"},
        {"v": {1: "int key"}},
        {"v": "\ud800"},
    ],
)
def test_encoder_refuses_a_value_the_profile_cannot_carry(value):
    with pytest.raises(runtime_wire.RuntimeProtocolError):
        runtime_wire.FrameEncoder().encode(value)


def test_encoder_refuses_frames_over_each_bound_and_never_truncates():
    encoder = runtime_wire.FrameEncoder()
    assert len(encoder.encode(padded_frame(runtime_wire.RUNTIME_FRAME_BYTES))) - 1 == runtime_wire.RUNTIME_FRAME_BYTES
    with pytest.raises(runtime_wire.RuntimeProtocolError):
        encoder.encode(padded_frame(runtime_wire.RUNTIME_FRAME_BYTES + 1))

    lifetime = runtime_wire.FrameEncoder()
    for _ in range(838):
        lifetime.encode(padded_frame(10_000))
    with pytest.raises(runtime_wire.RuntimeProtocolError):
        lifetime.encode(padded_frame(10_000))

    counts = runtime_wire.FrameEncoder()
    for _ in range(runtime_wire.RUNTIME_MAX_FRAMES):
        counts.encode(request())
    with pytest.raises(runtime_wire.RuntimeProtocolError):
        counts.encode(request())


def test_encoder_and_decoder_agree_on_a_maximum_size_frame():
    payload = padded_frame(runtime_wire.RUNTIME_FRAME_BYTES)
    bytes_ = runtime_wire.FrameEncoder().encode(payload)
    decoder = runtime_wire.FrameDecoder()
    assert decoder.push(bytes_[:10]) == []
    assert decoder.push(bytes_[10:]) == [payload]
    decoder.finish()


# ---------------------------------------------------------------------------
# validate_worker_message: accepted values
# ---------------------------------------------------------------------------

ACCEPTED_WORKER_MESSAGES = [
    ("authority check", request()),
    ("authority check w512", request(identity="w512")),
    ("authority check w999", request(identity="w999")),
    ("control prompt message", generate([{"role": "user", "content": CHECK}])),
    ("empty user content", generate([{"role": "user", "content": ""}])),
    ("128 messages", generate([{"role": "user", "content": "x"}] * 128)),
    ("assistant text part", generate([{"role": "assistant", "content": [{"type": "text", "text": ""}]}])),
    (
        "assistant text then tool call",
        generate([
            {"role": "assistant", "content": [
                {"type": "text", "text": "thinking"},
                {"type": "tool-call", "toolCallId": "c1", "toolName": "read", "input": {"a": [1, {"b": None}]}},
            ]},
        ]),
    ),
    (
        "tool results grouped as one message",
        generate([
            {"role": "tool", "content": [
                {"type": "tool-result", "toolCallId": "c1", "toolName": "read",
                 "output": {"type": "json", "value": {"evidence": "facts"}}},
                {"type": "tool-result", "toolCallId": "c2", "toolName": "read",
                 "output": {"type": "json", "value": None}},
            ]},
        ]),
    ),
    ("intent with nested arguments", request("w1", "tool.execute", intent(arguments={"a": [1, {"b": None}]}))),
    ("intent id 256 astral", request("w1", "tool.execute", intent(id=ASTRA * 256))),
    ("intent name 64 astral", request("w1", "tool.execute", intent(name=ASTRA * 64))),
    ("final one character", deliver("a")),
    ("final 8000 astral", deliver(ASTRA * 8000)),
    ("final whitespace only", deliver("\u00a0")),
    ("final NUL only", deliver("\u0000")),
    ("denial step limit", denial()),
    ("denial 64 character reason", denial("a" * 64)),
]


@pytest.mark.parametrize("label, value", ACCEPTED_WORKER_MESSAGES)
def test_worker_profile_accepts(label, value):
    parsed = runtime_wire.validate_worker_message(value)
    assert parsed == value
    assert parsed is not value


@pytest.mark.parametrize("reason", ["deadline_exceeded", "step_limit", "tool_call_limit", "message_limit",
                                    "output_limit", "catalog_limit", "limit_exceeded", "server_interrupted"])
def test_worker_profile_admits_every_bounded_denial_reason(reason):
    """The wire layer only bounds the reason; the supervisor decides which class it maps to."""
    assert runtime_wire.validate_worker_message(denial(reason))["error"]["data"]["reason"] == reason


def test_worker_profile_measures_text_in_unicode_code_points():
    assert runtime_wire.validate_worker_message(deliver(ASTRA * 8000))["result"]["text"] == ASTRA * 8000
    assert runtime_wire.validate_worker_message(request("w1", "tool.execute", intent(name=ASTRA * 64)))
    with pytest.raises(runtime_wire.RuntimeProtocolError):
        runtime_wire.validate_worker_message(deliver(ASTRA * 8001))
    with pytest.raises(runtime_wire.RuntimeProtocolError):
        runtime_wire.validate_worker_message(request("w1", "tool.execute", intent(name=ASTRA * 65)))


def test_worker_profile_does_not_invent_a_blank_text_rule():
    """Blank-only text is a supervisor rule; the schema matches Zod and admits it."""
    assert runtime_wire.validate_worker_message(deliver("   "))["result"]["text"] == "   "


# ---------------------------------------------------------------------------
# validate_worker_message: refused values
# ---------------------------------------------------------------------------

REFUSED_WORKER_MESSAGES = [
    ("authority check with a params member", request(params={"_meta": {}})),
    ("authority check without params", {"jsonrpc": "2.0", "id": "w1", "method": "authority.check"}),
    ("authority check null params", {"jsonrpc": "2.0", "id": "w1", "method": "authority.check",
                                    "params": None}),
    ("unknown method", request("w1", "approval.grant")),
    ("extra top-level key", dict(request(), extra=True)),
    ("numeric id", dict(request(), id=1)),
    ("missing id", {"jsonrpc": "2.0", "method": "authority.check", "params": {}}),
    ("id w0", request(identity="w0")),
    ("id w01", request(identity="w01")),
    ("id w1000", request(identity="w1000")),
    ("jsonrpc 2.1", dict(request(), jsonrpc="2.1")),
    ("missing jsonrpc", {"id": "w1", "method": "authority.check", "params": {}}),
    ("request plus result", dict(request(), result={})),
    ("not an object", 5),
    ("result and error together", dict(deliver(), error=denial()["error"])),
    ("final empty text", deliver("")),
    ("final 8001 characters", deliver("a" * 8001)),
    ("final with an extra key", {"jsonrpc": "2.0", "id": "run", "result": {"text": "x", "status": "y"}}),
    ("final without text", {"jsonrpc": "2.0", "id": "run", "result": {}}),
    ("final for another id", {"jsonrpc": "2.0", "id": "w1", "result": {"text": "x"}}),
    ("final with an extra top-level key", dict(deliver(), extra=1)),
    ("denial wrong code", {"jsonrpc": "2.0", "id": "run", "error": {
        "code": -32001, "message": "Runtime operation refused", "data": {"reason": "x"}}}),
    ("denial string code", {"jsonrpc": "2.0", "id": "run", "error": {
        "code": "-32000", "message": "Runtime operation refused", "data": {"reason": "x"}}}),
    ("denial other message", {"jsonrpc": "2.0", "id": "run", "error": {
        "code": -32000, "message": "refused", "data": {"reason": "x"}}}),
    ("denial uppercase reason", denial("Step_Limit")),
    ("denial empty reason", denial("")),
    ("denial 65 character reason", denial("a" * 65)),
    ("denial dashed reason", denial("step-limit")),
    ("denial numeric reason", {"jsonrpc": "2.0", "id": "run", "error": {
        "code": -32000, "message": "Runtime operation refused", "data": {"reason": 5}}}),
    ("denial extra data key", {"jsonrpc": "2.0", "id": "run", "error": {
        "code": -32000, "message": "Runtime operation refused", "data": {"reason": "x", "y": 1}}}),
    ("denial without data", {"jsonrpc": "2.0", "id": "run", "error": {
        "code": -32000, "message": "Runtime operation refused"}}),
    ("no messages", request("w1", "model.generate", {})),
    ("messages not an array", request("w1", "model.generate", {"messages": {}})),
    ("no messages at all", generate([])),
    ("129 messages", generate([{"role": "user", "content": "x"}] * 129)),
    ("numeric user content", generate([{"role": "user", "content": 5}])),
    ("user extra key", generate([{"role": "user", "content": "x", "extra": 1}])),
    ("system role", generate([{"role": "system", "content": "x"}])),
    ("unknown role", generate([{"role": "developer", "content": "x"}])),
    ("empty assistant content", generate([{"role": "assistant", "content": []}])),
    ("unknown assistant part", generate([{"role": "assistant", "content": [{"type": "image", "image": "x"}]}])),
    ("assistant text part extra key", generate([
        {"role": "assistant", "content": [{"type": "text", "text": "a", "extra": 1}]}])),
    ("tool call string input", generate([
        {"role": "assistant", "content": [
            {"type": "tool-call", "toolCallId": "c1", "toolName": "read", "input": "{}"}]}])),
    ("tool call empty id", generate([
        {"role": "assistant", "content": [
            {"type": "tool-call", "toolCallId": "", "toolName": "read", "input": {}}]}])),
    ("tool call name 65 characters", generate([
        {"role": "assistant", "content": [
            {"type": "tool-call", "toolCallId": "c1", "toolName": "n" * 65, "input": {}}]}])),
    ("tool call id 257 astral", generate([
        {"role": "assistant", "content": [
            {"type": "tool-call", "toolCallId": ASTRA * 257, "toolName": "read", "input": {}}]}])),
    ("text part inside a tool message", generate([
        {"role": "tool", "content": [{"type": "text", "text": "x"}]}])),
    ("empty tool content", generate([{"role": "tool", "content": []}])),
    ("tool output not json", generate([
        {"role": "tool", "content": [
            {"type": "tool-result", "toolCallId": "c1", "toolName": "read",
             "output": {"type": "text", "value": 1}}]}])),
    ("tool output without a value", generate([
        {"role": "tool", "content": [
            {"type": "tool-result", "toolCallId": "c1", "toolName": "read",
             "output": {"type": "json"}}]}])),
    ("tool result part extra key", generate([
        {"role": "tool", "content": [
            {"type": "tool-result", "toolCallId": "c1", "toolName": "read",
             "output": {"type": "json", "value": 1}, "extra": 1}]}])),
    ("intent arguments array", request("w1", "tool.execute", intent(arguments=[]))),
    ("intent arguments null", request("w1", "tool.execute", intent(arguments=None))),
    ("intent missing arguments", request("w1", "tool.execute", {"id": "i1", "name": "read"})),
    ("intent extra param", request("w1", "tool.execute", intent(web=True))),
    ("intent empty id", request("w1", "tool.execute", intent(id=""))),
    ("intent empty name", request("w1", "tool.execute", intent(name=""))),
    ("intent non-finite argument", request("w1", "tool.execute", intent(arguments={"x": float("inf")}))),
    ("intent huge integer argument", request("w1", "tool.execute", intent(arguments={"x": 10**400}))),
    ("intent unpaired surrogate", request("w1", "tool.execute", intent(arguments={"x": "\ud800"}))),
    ("intent arguments nested past the depth bound", request("w1", "tool.execute", intent(arguments=nested(63)))),
    ("unpaired surrogate in the final text", deliver("\ud800")),
    ("unpaired surrogate in a key", {"jsonrpc": "2.0", "id": "run", "result": {"\ud800": 1}}),
]


@pytest.mark.parametrize("label, value", REFUSED_WORKER_MESSAGES)
def test_worker_profile_refuses(label, value):
    with pytest.raises(runtime_wire.RuntimeProtocolError):
        runtime_wire.validate_worker_message(value)


def test_worker_profile_bounds_message_arrays_at_128():
    assert len(runtime_wire.validate_worker_message(
        generate([{"role": "user", "content": "x"}] * runtime_wire.RUNTIME_MAX_MESSAGES))
        ["params"]["messages"]) == 128


def test_worker_profile_admits_a_nested_argument_exactly_at_the_depth_bound():
    assert runtime_wire.validate_worker_message(
        request("w1", "tool.execute", intent(arguments=nested(62))))
    with pytest.raises(runtime_wire.RuntimeProtocolError):
        runtime_wire.validate_worker_message(
            request("w1", "tool.execute", intent(arguments=nested(63))))


def test_protocol_error_text_is_fixed_and_carries_no_child_data():
    refusing = (
        {"jsonrpc": "2.0", "id": "run", "result": {"text": CANARY, "extra": CANARY}},
        request(params={CANARY: 1}),
        request("w1", "tool.execute", intent(arguments={CANARY: float("inf")})),
        5,
    )
    for value in refusing:
        with pytest.raises(runtime_wire.RuntimeProtocolError) as raised:
            runtime_wire.validate_worker_message(value)
        assert str(raised.value) == runtime_wire.PROTOCOL_FAILURE_TEXT
        assert CANARY not in str(raised.value)


# ---------------------------------------------------------------------------
# validate_invocation
# ---------------------------------------------------------------------------

FROZEN_INVOCATION = {
    "jsonrpc": "2.0",
    "id": "run",
    "method": "runtime.execute",
    "params": {"protocol": "openbot-agent-runtime/1", "tools": [], "deadlineMs": 90_000},
}


def test_invocation_accepts_the_frozen_request():
    tool = {"name": "read", "description": "", "inputSchema": {"type": "object"}}
    value = dict(FROZEN_INVOCATION)
    value["params"] = dict(FROZEN_INVOCATION["params"], tools=[tool])
    parsed = runtime_wire.validate_invocation(value)
    assert parsed == {"jsonrpc": "2.0", "id": "run", "method": "runtime.execute",
                      "params": {"protocol": "openbot-agent-runtime/1", "tools": [tool],
                                 "deadlineMs": 90_000}}
    assert parsed is not value


@pytest.mark.parametrize(
    "params",
    [
        {"protocol": "openbot-agent-runtime/1", "tools": [], "deadlineMs": 90_000.0},
        {"protocol": "openbot-agent-runtime/1", "tools": [], "deadlineMs": 1},
        {"protocol": "openbot-agent-runtime/1", "tools": [], "deadlineMs": 300_000},
        {"protocol": "openbot-agent-runtime/1",
         "tools": [{"name": "n", "description": "d", "inputSchema": {}}] * 64,
         "deadlineMs": 90_000},
    ],
)
def test_invocation_accepts_bounded_variants(params):
    runtime_wire.validate_invocation({"jsonrpc": "2.0", "id": "run",
                                      "method": "runtime.execute", "params": params})


@pytest.mark.parametrize(
    "value",
    [
        {"jsonrpc": "2.0", "id": "run", "method": "runtime.execute", "params": {}},
        {"jsonrpc": "2.0", "id": "run", "method": "runtime.execute"},
        {"jsonrpc": "2.0", "id": "w1", "method": "runtime.execute",
         "params": {"protocol": "openbot-agent-runtime/1", "tools": [], "deadlineMs": 1}},
        {"jsonrpc": "2.0", "id": "run", "method": "runtime.abort",
         "params": {"protocol": "openbot-agent-runtime/1", "tools": [], "deadlineMs": 1}},
        {"jsonrpc": "2.1", "id": "run", "method": "runtime.execute",
         "params": {"protocol": "openbot-agent-runtime/1", "tools": [], "deadlineMs": 1}},
        {"jsonrpc": "2.0", "id": "run", "method": "runtime.execute",
         "params": {"protocol": "openbot-agent-runtime/2", "tools": [], "deadlineMs": 1}},
        {"jsonrpc": "2.0", "id": "run", "method": "runtime.execute",
         "params": {"protocol": "openbot-agent-runtime/1", "tools": [], "deadlineMs": 0}},
        {"jsonrpc": "2.0", "id": "run", "method": "runtime.execute",
         "params": {"protocol": "openbot-agent-runtime/1", "tools": [], "deadlineMs": 300_001}},
        {"jsonrpc": "2.0", "id": "run", "method": "runtime.execute",
         "params": {"protocol": "openbot-agent-runtime/1", "tools": [], "deadlineMs": 1.5}},
        {"jsonrpc": "2.0", "id": "run", "method": "runtime.execute",
         "params": {"protocol": "openbot-agent-runtime/1", "tools": [], "deadlineMs": True}},
        {"jsonrpc": "2.0", "id": "run", "method": "runtime.execute",
         "params": {"protocol": "openbot-agent-runtime/1", "tools": [], "deadlineMs": "90000"}},
        {"jsonrpc": "2.0", "id": "run", "method": "runtime.execute",
         "params": {"protocol": "openbot-agent-runtime/1", "tools": {}, "deadlineMs": 1}},
        {"jsonrpc": "2.0", "id": "run", "method": "runtime.execute",
         "params": {"protocol": "openbot-agent-runtime/1",
                    "tools": [{"name": "n", "description": "d", "inputSchema": {}}] * 65,
                    "deadlineMs": 1}},
        {"jsonrpc": "2.0", "id": "run", "method": "runtime.execute",
         "params": {"protocol": "openbot-agent-runtime/1", "tools": [], "deadlineMs": 1, "extra": 1}},
        {"jsonrpc": "2.0", "id": "run", "method": "runtime.execute",
         "params": {"protocol": "openbot-agent-runtime/1", "tools": [], "deadlineMs": 1}, "extra": 1},
        [{"jsonrpc": "2.0", "id": "run", "method": "runtime.execute",
          "params": {"protocol": "openbot-agent-runtime/1", "tools": [], "deadlineMs": 1}}],
        {"jsonrpc": "2.0", "id": "run", "method": "runtime.execute",
         "params": {"protocol": "openbot-agent-runtime/1",
                    "tools": [{"name": "", "description": "", "inputSchema": {}}], "deadlineMs": 1}},
        {"jsonrpc": "2.0", "id": "run", "method": "runtime.execute",
         "params": {"protocol": "openbot-agent-runtime/1",
                    "tools": [{"name": "n", "description": 5, "inputSchema": {}}], "deadlineMs": 1}},
        {"jsonrpc": "2.0", "id": "run", "method": "runtime.execute",
         "params": {"protocol": "openbot-agent-runtime/1",
                    "tools": [{"name": "n", "description": "", "inputSchema": []}], "deadlineMs": 1}},
        {"jsonrpc": "2.0", "id": "run", "method": "runtime.execute",
         "params": {"protocol": "openbot-agent-runtime/1",
                    "tools": [{"name": "n", "description": "", "inputSchema": {}, "extra": 1}],
                    "deadlineMs": 1}},
        {"jsonrpc": "2.0", "id": "run", "method": "runtime.execute",
         "params": {"protocol": "openbot-agent-runtime/1",
                    "tools": [{"name": "n", "description": "d" * 70_000, "inputSchema": {}}],
                    "deadlineMs": 1}},
        {"jsonrpc": "2.0", "id": "run", "method": "runtime.execute",
         "params": {"protocol": "openbot-agent-runtime/1", "tools": [], "deadlineMs": float("inf")}},
    ],
)
def test_invocation_refuses_anything_but_the_single_frozen_request(value):
    with pytest.raises(runtime_wire.RuntimeProtocolError):
        runtime_wire.validate_invocation(value)


def test_invocation_bounds_the_encoded_catalog_at_64_kibibytes():
    descriptor = {"name": "n", "description": "d" * 900, "inputSchema": {}}
    accepted = [descriptor] * 64
    assert len(json.dumps(accepted, separators=(",", ":")).encode("utf-8")) < runtime_wire.RUNTIME_CATALOG_BYTES
    runtime_wire.validate_invocation({"jsonrpc": "2.0", "id": "run", "method": "runtime.execute",
                                      "params": {"protocol": "openbot-agent-runtime/1",
                                                 "tools": accepted, "deadlineMs": 1}})
    oversized = [{"name": "n", "description": "d" * 2000, "inputSchema": {}}] * 64
    assert len(json.dumps(oversized, separators=(",", ":")).encode("utf-8")) > runtime_wire.RUNTIME_CATALOG_BYTES
    with pytest.raises(runtime_wire.RuntimeProtocolError):
        runtime_wire.validate_invocation({"jsonrpc": "2.0", "id": "run", "method": "runtime.execute",
                                          "params": {"protocol": "openbot-agent-runtime/1",
                                                     "tools": oversized, "deadlineMs": 1}})


def test_invocation_refuses_an_out_of_range_deadline_even_with_a_valid_catalog():
    tool = {"name": "read", "description": "", "inputSchema": {"type": "object"}}
    value = dict(FROZEN_INVOCATION)
    value["params"] = dict(value["params"], tools=[tool], deadlineMs=300_001)
    with pytest.raises(runtime_wire.RuntimeProtocolError):
        runtime_wire.validate_invocation(value)
