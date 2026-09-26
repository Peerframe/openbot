"""Channel failures of the real CLI: the frozen profile is refused, not reinterpreted.

Every case here runs the actual worker as a child process. A channel failure must be
observable as three things at once: the standard JSON-RPC error with a fixed message,
the absence of any terminal ``result``, and a nonzero exit. Two of those are not enough
— a child that refused but still published, or refused and hung, would pass a weaker
assertion.

Nothing here carries a private value: the fixed-message check is paired with a test
that plants a distinctive string in an offending frame and requires it to appear
nowhere in the child's output.
"""

from __future__ import annotations

import json

import pytest

import support_cli as cli

pytestmark = pytest.mark.anyio

FIXED = {
    -32600: "Invalid request",
    -32601: "Method not found",
    -32602: "Invalid params",
}
CANARY = "private-value-that-must-not-be-echoed"


def _closed_without_result(
    worker: cli.Worker, *, expect_id: object, expect_code: int
) -> dict[str, object]:
    """Assert a channel failure: one fixed error, no result, exit 2, clean stderr."""
    frames = worker.collect()
    code, _, stderr_text = worker.finish()
    assert code == 2
    assert stderr_text == ""
    results = [frame for frame in frames if "result" in frame]
    assert results == [], results
    errors = [frame for frame in frames if "error" in frame]
    assert len(errors) == 1, errors
    assert errors[0] == {
        "jsonrpc": "2.0",
        "id": expect_id,
        "error": {"code": expect_code, "message": FIXED[expect_code]},
    }
    return errors[0]


def _raw_case(payload: bytes, *, expect_id: object, expect_code: int) -> None:
    with cli.Worker() as worker:
        worker.send_raw(payload)
        worker.close_stdin()
        _closed_without_result(worker, expect_id=expect_id, expect_code=expect_code)


def _params_case(params: object, *, expect_code: int = -32602) -> None:
    frame = cli.execute_request()
    frame["params"] = params
    _raw_case(json.dumps(frame).encode() + b"\n", expect_id=cli.PARENT_ID, expect_code=expect_code)


# --- frames the profile cannot decode -----------------------------------------


@pytest.mark.parametrize(
    ("payload", "expect_code"),
    [
        pytest.param(b"not json\n", -32600, id="not-json"),
        pytest.param(b"\n", -32600, id="blank-frame"),
        pytest.param(b"[1,2,3]\xff\n", -32600, id="invalid-utf8"),
        pytest.param(b'{"a":NaN}\n', -32600, id="nan"),
        pytest.param(b'{"a":Infinity}\n', -32600, id="infinity"),
        pytest.param(b'{"a":-Infinity}\n', -32600, id="negative-infinity"),
        pytest.param(b'{"a":1e400}\n', -32600, id="overflow-to-infinity"),
        pytest.param(b'{"a":-1e400}\n', -32600, id="overflow-to-negative-infinity"),
        pytest.param(b'{"a":1,"a":2}\n', -32600, id="duplicate-key"),
        pytest.param(b'"\\ud800"\n', -32600, id="lone-surrogate"),
        pytest.param(b"[" * 100 + b"]" * 100 + b"\n", -32600, id="depth-100"),
        pytest.param(b"[1,2,3]\n", -32600, id="batch"),
        pytest.param(b"true\n", -32600, id="scalar-frame"),
        pytest.param(b"x" * 524_289, -32600, id="oversize-unterminated"),
        pytest.param(b'{"jsonrpc":"2.0"', -32600, id="valid-json-without-delimiter"),
    ],
)
def test_a_frame_that_cannot_be_decoded_closes_the_channel(payload: bytes, expect_code: int) -> None:
    _raw_case(payload, expect_id=None, expect_code=expect_code)


def test_the_refusal_never_echoes_the_offending_bytes() -> None:
    """The error is fixed text; a planted private value must not travel back."""
    frame = cli.execute_request()
    frame["params"]["protocol"] = f"{cli.PROTOCOL_NAME} {CANARY}"
    payload = json.dumps(frame).encode() + b"\n"
    with cli.Worker() as worker:
        worker.send_raw(payload)
        worker.close_stdin()
        error = _closed_without_result(worker, expect_id=cli.PARENT_ID, expect_code=-32602)
        rendered = json.dumps(error)
        assert CANARY not in rendered
        assert worker.stderr() == ""


# --- envelopes the profile does not admit -------------------------------------


@pytest.mark.parametrize(
    ("frame", "expect_id", "expect_code"),
    [
        pytest.param([1, 2, 3], None, -32600, id="batch-envelope"),
        pytest.param(
            {"jsonrpc": "2.0", "method": "runtime.execute", "params": {}}, None, -32600, id="no-id"
        ),
        pytest.param(
            {"jsonrpc": "2.0", "id": 7, "method": "runtime.execute", "params": {}},
            None,
            -32600,
            id="numeric-id",
        ),
        pytest.param(
            {"jsonrpc": "1.0", "id": "run", "method": "runtime.execute", "params": {}},
            "run",
            -32600,
            id="wrong-jsonrpc",
        ),
        pytest.param(
            {"jsonrpc": "2.0", "id": "other", "method": "runtime.execute", "params": {}},
            "other",
            -32600,
            id="wrong-id",
        ),
        pytest.param(
            {"jsonrpc": "2.0", "id": "run", "method": "runtime.execute"}, "run", -32600,
            id="missing-params",
        ),
        pytest.param(
            {
                "jsonrpc": "2.0",
                "id": "run",
                "method": "runtime.execute",
                "params": {},
                "extra": 1,
            },
            "run",
            -32600,
            id="unknown-envelope-field",
        ),
        pytest.param(
            {"jsonrpc": "2.0", "id": "run", "method": "runtime.other", "params": {}},
            "run",
            -32601,
            id="unknown-method",
        ),
        pytest.param(
            {"jsonrpc": "2.0", "id": "run", "notification": True, "method": "runtime.execute"},
            "run",
            -32600,
            id="notification-shaped",
        ),
    ],
)
def test_an_envelope_the_profile_does_not_admit_closes_the_channel(
    frame: object, expect_id: object, expect_code: int
) -> None:
    _raw_case(json.dumps(frame).encode() + b"\n", expect_id=expect_id, expect_code=expect_code)


@pytest.mark.parametrize(
    "params",
    [
        pytest.param(None, id="params-null"),
        pytest.param([], id="params-list"),
        pytest.param({}, id="params-empty"),
        pytest.param(
            {"protocol": cli.PROTOCOL_NAME, "tools": [], "deadlineMs": 1000, "extra": 1},
            id="unknown-params-field",
        ),
        pytest.param(
            {"protocol": "openbot-agent-runtime/2", "tools": [], "deadlineMs": 1000},
            id="wrong-protocol",
        ),
        pytest.param(
            {"protocol": cli.PROTOCOL_NAME, "tools": {}, "deadlineMs": 1000},
            id="tools-not-a-list",
        ),
        pytest.param(
            {"protocol": cli.PROTOCOL_NAME, "tools": [{"name": "s"}], "deadlineMs": 1000},
            id="tool-missing-key",
        ),
        pytest.param(
            {
                "protocol": cli.PROTOCOL_NAME,
                "tools": [{"name": "s", "description": "d", "inputSchema": []}],
                "deadlineMs": 1000,
            },
            id="schema-not-an-object",
        ),
        pytest.param(
            {"protocol": cli.PROTOCOL_NAME, "tools": [], "deadlineMs": 0}, id="deadline-zero"
        ),
        pytest.param(
            {"protocol": cli.PROTOCOL_NAME, "tools": [], "deadlineMs": 300_001},
            id="deadline-too-large",
        ),
        pytest.param(
            {"protocol": cli.PROTOCOL_NAME, "tools": [], "deadlineMs": 1.5}, id="deadline-float"
        ),
        pytest.param(
            {"protocol": cli.PROTOCOL_NAME, "tools": [cli.tool()] * 65, "deadlineMs": 1000},
            id="too-many-tools",
        ),
    ],
)
def test_params_the_profile_does_not_admit_close_the_channel(params: object) -> None:
    _params_case(params)


# --- replies the profile does not correlate -----------------------------------


def test_a_reply_with_the_wrong_identifier_closes_the_channel() -> None:
    with cli.Worker() as worker:
        worker.send(cli.execute_request(tools=[cli.tool()]))
        driver = cli.Driver(worker)
        request_id, method, _ = driver.next()
        driver.worker.reply(request_id.replace("w1", "w99"), {})
        _closed_without_result(worker, expect_id=cli.PARENT_ID, expect_code=-32600)


def test_a_replayed_identifier_closes_the_channel() -> None:
    with cli.Worker() as worker:
        worker.send(cli.execute_request(tools=[cli.tool()]))
        driver = cli.Driver(worker)
        first_id, _, _ = driver.next()
        driver.worker.reply(first_id, {})
        driver.advance_until("model.generate", occurrence=2)
        driver.worker.reply(first_id, {})  # the identifier of an already-answered request
        _closed_without_result(worker, expect_id=cli.PARENT_ID, expect_code=-32600)


@pytest.mark.parametrize(
    "reply",
    [
        pytest.param({"jsonrpc": "2.0", "id": "w1"}, id="neither-result-nor-error"),
        pytest.param(
            {"jsonrpc": "2.0", "id": "w1", "result": {}, "error": {"code": -32000}},
            id="both-result-and-error",
        ),
        pytest.param({"jsonrpc": "1.0", "id": "w1", "result": {}}, id="wrong-jsonrpc"),
        pytest.param(
            {"jsonrpc": "2.0", "id": "w1", "result": {}, "extra": 1}, id="unknown-field"
        ),
        pytest.param(
            {"jsonrpc": "2.0", "id": "w1", "result": {}, "params": {}}, id="extra-field"
        ),
    ],
)
def test_a_reply_envelope_the_profile_does_not_admit_closes_the_channel(
    reply: dict[str, object],
) -> None:
    with cli.Worker() as worker:
        worker.send(cli.execute_request(tools=[cli.tool()]))
        driver = cli.Driver(worker)
        request_id, _, _ = driver.next()
        reply = dict(reply)
        reply["id"] = request_id
        worker.send(reply)
        _closed_without_result(worker, expect_id=cli.PARENT_ID, expect_code=-32600)


def test_an_extra_frame_after_the_last_reply_closes_the_channel() -> None:
    with cli.Worker() as worker:
        worker.send(cli.execute_request(tools=[cli.tool()]))
        driver = cli.Driver(worker)
        request_id, method, params = driver.advance_until("model.generate", occurrence=2)
        worker.send({"jsonrpc": "2.0", "id": request_id, "result": cli.model_result(text="ok")})
        # The parent must not speak again until the child asks. Its next request is
        # the post-step authority check, which cannot match this identifier.
        worker.send({"jsonrpc": "2.0", "id": cli.PARENT_ID, "result": {}})
        _closed_without_result(worker, expect_id=cli.PARENT_ID, expect_code=-32600)


def test_a_duplicate_reply_closes_the_channel() -> None:
    """Two replies for one identifier must never survive as the next call's result.

    Both copies are written back-to-back, so the child may read them in one chunk and
    deliver the second while the first call is still outstanding. The expected
    identifier is reserved on delivery, so the duplicate is uncorrelated whichever way
    the reads land, and the channel closes rather than the stale frame being reused.
    """
    with cli.Worker() as worker:
        worker.send(cli.execute_request(tools=[cli.tool()]))
        driver = cli.Driver(worker)
        request_id, _, _ = driver.next()
        worker.reply(request_id, {})
        worker.reply(request_id, {})  # the same identifier, before the call resumes
        _closed_without_result(worker, expect_id=cli.PARENT_ID, expect_code=-32600)


def test_the_frame_count_bound_closes_the_channel() -> None:
    """A flood of small frames is refused once the invocation's budget is spent.

    The batch is sent after the run has started, so the violation belongs to the
    accepted request and the refusal answers ``run`` rather than a null identifier.
    """
    with cli.Worker() as worker:
        worker.send(cli.execute_request(tools=[cli.tool()]))
        cli.Driver(worker).next()
        worker.send_raw(b"{}\n" * 1024)
        _closed_without_result(worker, expect_id=cli.PARENT_ID, expect_code=-32600)


def test_a_channel_failure_does_not_publish_a_result() -> None:
    """The one property every case above shares, asserted once on its own."""
    with cli.Worker() as worker:
        worker.send_raw(b'{"jsonrpc":' + b"?" * 32 + b"\n")
        frames = worker.collect()
        code, _, stderr_text = worker.finish()
    assert code == 2
    assert stderr_text == ""
    assert all(frame.get("id") != cli.PARENT_ID for frame in frames if "result" in frame)
