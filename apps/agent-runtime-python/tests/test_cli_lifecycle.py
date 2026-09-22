"""Lifecycle of the real CLI: EOF, deadlines, refusals and exit status.

These are the paths where a supervisor's guarantees live. Each test runs the actual
worker and asserts the process outcome, not an in-process return: a run that ends is
only trustworthy if the child stopped, said one thing, and exited nonzero.

No test here uses a real model, a credential, a database or a network.
"""

from __future__ import annotations

import json
import re
import time

import pytest

import support_cli as cli

pytestmark = pytest.mark.anyio

EXIT_SUCCESS = 0
EXIT_APPLICATION_ERROR = 1
EXIT_PROTOCOL_ERROR = 2

REASON_PATTERN = re.compile(r"^[a-z0-9_]{1,64}$")
TIMING_BOUND_SECONDS = 10.0


def _terminal(frames: list[object]) -> dict[str, object]:
    terminal = [
        frame
        for frame in frames
        if isinstance(frame, dict) and frame.get("id") == cli.PARENT_ID
    ]
    assert len(terminal) == 1, terminal
    return terminal[0]


def _reason(frame: dict[str, object]) -> str:
    error = frame["error"]
    assert set(error) == {"code", "message", "data"}
    assert error["code"] == -32000
    assert error["message"] == "Runtime operation refused"
    reason = error["data"]["reason"]
    assert isinstance(reason, str)
    assert REASON_PATTERN.match(reason), reason
    return reason


def _failed_run(worker: cli.Worker) -> tuple[int, list[object], str, str]:
    """Collect a refused run and return ``(exit, frames, stderr, reason)``."""
    frames = worker.collect()
    code, _, stderr_text = worker.finish()
    assert code == EXIT_APPLICATION_ERROR
    assert stderr_text == ""
    terminal = _terminal(frames)
    assert "error" in terminal, terminal
    assert "result" not in terminal
    return code, frames, stderr_text, _reason(terminal)


def _reply_at_model(worker: cli.Worker, reply: dict[str, object]) -> cli.Driver:
    """Reply to the first model step, then drive to the terminal frame.

    The run re-checks authority after the model port returns, so the reply is
    followed by one more ``authority.check`` before the outcome is published.
    Answering it is the parent's job; skipping it would strand the run on its
    deadline instead of observing the refusal under test.
    """
    driver = cli.Driver(worker)
    request_id, method, _ = driver.advance_until("model.generate")
    assert method == "model.generate"
    worker.reply(request_id, reply)
    driver.answer_to_terminal()
    return driver


# --- parent EOF ---------------------------------------------------------------


def test_eof_before_any_request_exits_without_a_frame() -> None:
    with cli.Worker() as worker:
        worker.close_stdin()
        frames = worker.collect()
        code, _, stderr_text = worker.finish()
    assert code == EXIT_PROTOCOL_ERROR
    assert frames == []
    assert stderr_text == ""


def test_eof_while_awaiting_the_model_response_cancels_the_run() -> None:
    with cli.Worker() as worker:
        worker.send(cli.execute_request(tools=[cli.tool()]))
        driver = cli.Driver(worker)
        started = time.monotonic()
        driver.advance_until("model.generate")
        worker.close_stdin()
        frames = worker.collect()
        code, _, stderr_text = worker.finish()
    elapsed = time.monotonic() - started
    assert code == EXIT_PROTOCOL_ERROR
    assert stderr_text == ""
    assert elapsed < TIMING_BOUND_SECONDS
    assert not [frame for frame in frames if frame.get("id") == cli.PARENT_ID]


def test_eof_while_awaiting_the_tool_response_cancels_the_run() -> None:
    with cli.Worker() as worker:
        worker.send(cli.execute_request(tools=[cli.tool()]))
        driver = cli.Driver(worker)
        started = time.monotonic()
        driver.advance_until("tool.execute")
        worker.close_stdin()
        frames = worker.collect()
        code, _, stderr_text = worker.finish()
    elapsed = time.monotonic() - started
    assert code == EXIT_PROTOCOL_ERROR
    assert stderr_text == ""
    assert elapsed < TIMING_BOUND_SECONDS
    assert not [frame for frame in frames if frame.get("id") == cli.PARENT_ID]


def test_eof_is_observed_without_waiting_for_the_run_to_finish() -> None:
    """A close pipe must not leave a process waiting on a reply that cannot come."""
    with cli.Worker() as worker:
        worker.send(cli.execute_request(tools=[cli.tool()], deadline_ms=300_000))
        driver = cli.Driver(worker)
        driver.advance_until("model.generate")
        started = time.monotonic()
        worker.close_stdin()
        code = worker.proc.wait(timeout=TIMING_BOUND_SECONDS)
    elapsed = time.monotonic() - started
    assert code == EXIT_PROTOCOL_ERROR
    assert elapsed < TIMING_BOUND_SECONDS


def test_a_request_followed_immediately_by_eof_never_publishes() -> None:
    with cli.Worker() as worker:
        worker.send(cli.execute_request(tools=[cli.tool()]))
        worker.close_stdin()
        frames = worker.collect()
        code, _, stderr_text = worker.finish()
    assert code == EXIT_PROTOCOL_ERROR
    assert stderr_text == ""
    assert not [frame for frame in frames if frame.get("id") == cli.PARENT_ID]


# --- deadlines ----------------------------------------------------------------


def test_a_deadline_that_expires_while_the_parent_stalls_is_reported() -> None:
    with cli.Worker() as worker:
        worker.send(cli.execute_request(tools=[cli.tool()], deadline_ms=200))
        driver = cli.Driver(worker)
        driver.next()
        time.sleep(1.0)
        code, frames, _, reason = _failed_run(worker)
    assert code == EXIT_APPLICATION_ERROR
    assert reason == "deadline_exceeded"


def test_a_one_millisecond_deadline_refuses_rather_than_hanging() -> None:
    worker = cli.Worker()
    try:
        worker.send(cli.execute_request(tools=[cli.tool()], deadline_ms=1))
        started = time.monotonic()
        code, frames, _, reason = _failed_run(worker)
        elapsed = time.monotonic() - started
    finally:
        worker.close()
    assert code == EXIT_APPLICATION_ERROR
    assert reason == "deadline_exceeded"
    assert elapsed < TIMING_BOUND_SECONDS
    assert [frame for _, _, _ in [] if False] == []


def test_the_deadline_covers_the_whole_run_not_only_the_model_loop() -> None:
    """A stall on the first authority check must still expire the run.

    The parent deliberately never answers: the run is stuck inside the first
    ``authority.check`` await, so only the deadline can end it. It must publish a
    fixed refusal rather than wait forever on a reply that will not come.
    """
    with cli.Worker() as worker:
        worker.send(cli.execute_request(tools=[cli.tool()], deadline_ms=150))
        driver = cli.Driver(worker)
        _, method, _ = driver.next()
        assert method == "authority.check"
        code, frames, _, reason = _failed_run(worker)
    assert code == EXIT_APPLICATION_ERROR
    assert reason == "deadline_exceeded"


def test_a_run_that_fits_its_deadline_succeeds() -> None:
    code, frames, _, _ = cli.journey(deadline_ms=5_000)
    assert code == EXIT_SUCCESS
    assert _terminal(frames)["result"] == {"text": "final answer"}


# --- refusals the parent supplies --------------------------------------------


@pytest.mark.parametrize(
    ("cut_at", "expected"),
    [
        pytest.param("authority.check", "authority_revoked", id="authority"),
        pytest.param("model.generate", "model_port_error", id="model"),
        pytest.param("tool.execute", "tool_port_error", id="tool"),
    ],
)
def test_a_refused_child_request_is_terminal(cut_at: str, expected: str) -> None:
    with cli.Worker() as worker:
        worker.send(cli.execute_request(tools=[cli.tool()]))
        driver = cli.Driver(worker)
        request_id, method, _ = driver.advance_until(cut_at)
        assert method == cut_at
        worker.reply_error(request_id, "a-parent-reason-that-must-not-be-echoed")
        code, frames, _, reason = _failed_run(worker)
    assert code == EXIT_APPLICATION_ERROR
    assert reason == expected
    assert "a-parent-reason-that-must-not-be-echoed" not in json.dumps(frames)
    # The refused operation is never retried: the terminal error is the next frame.
    assert [name for _, name, _ in driver.requests].count(cut_at) == 1


def test_a_refused_authority_check_is_never_followed_by_a_model_request() -> None:
    """Withdrawal before the model step must stop the step, observably.

    The in-process defect was that a revocation landing after an awaited boundary
    still produced a model call. Over the frozen profile the same invariant is
    visible as an *absent* ``model.generate``: once the parent refuses an
    ``authority.check``, no model request may follow it. Asserting on the frames
    rather than on the driver's bookkeeping keeps this true regardless of how the
    parent reads them.
    """
    with cli.Worker() as worker:
        worker.send(cli.execute_request(tools=[cli.tool()]))
        driver = cli.Driver(worker)
        request_id, method, _ = driver.next()
        assert method == "authority.check"
        worker.reply_error(request_id, "scope_revoked")
        code, frames, _, reason = _failed_run(worker)

    assert code == EXIT_APPLICATION_ERROR
    assert reason == "authority_revoked"
    assert driver.methods() == ["authority.check"]
    observed = [frame["method"] for frame in frames if isinstance(frame, dict) and "method" in frame]
    assert observed == ["authority.check"], f"a request followed the refused authority check: {observed}"


def test_a_refused_call_is_not_converted_into_a_retry() -> None:
    """The SDK turns ``ToolFailed``/``ModelRetry`` into observations; this must not."""
    with cli.Worker() as worker:
        worker.send(cli.execute_request(tools=[cli.tool()]))
        driver = cli.Driver(worker)
        tool_id, method, _ = driver.advance_until("tool.execute")
        assert method == "tool.execute"
        worker.reply_error(tool_id, "tool_unavailable")
        code, frames, _, reason = _failed_run(worker)
    assert reason == "tool_port_error"
    assert driver.methods().count("model.generate") == 1
    assert driver.methods().count("tool.execute") == 1


# --- payloads the child cannot honour ----------------------------------------


@pytest.mark.parametrize(
    ("reply", "expected"),
    [
        pytest.param(
            {"text": 5, "tools": [], "usage": {"inputTokens": None, "outputTokens": None}},
            "model_response_invalid",
            id="model-text-not-a-string",
        ),
        pytest.param(
            {
                "text": "x",
                "tools": [],
                "usage": {"inputTokens": None, "outputTokens": None},
                "extra": 1,
            },
            "model_response_invalid",
            id="model-unknown-field",
        ),
        pytest.param(
            {"text": "x", "tools": [], "usage": {"inputTokens": -1, "outputTokens": None}},
            "model_response_invalid",
            id="model-negative-usage",
        ),
        pytest.param(
            {"text": "", "tools": [], "usage": {"inputTokens": None, "outputTokens": None}},
            "model_response_invalid",
            id="model-answer-is-empty",
        ),
    ],
)
def test_a_model_payload_the_child_cannot_honour_refuses_the_run(
    reply: dict[str, object], expected: str
) -> None:
    with cli.Worker() as worker:
        worker.send(cli.execute_request(tools=[cli.tool()]))
        _reply_at_model(worker, reply)
        code, frames, _, reason = _failed_run(worker)
    assert code == EXIT_APPLICATION_ERROR
    assert reason == expected


def test_a_whitespace_only_answer_is_refused_by_the_run_not_the_codec() -> None:
    """Two different layers refuse two different blanks, and both must fire.

    An *empty* string is refused by the profile's own payload check
    (``model_response_invalid``, pinned above). A *whitespace-only* string is a
    perfectly valid wire value, so it travels all the way to the run's blank-output
    guard and is refused there as ``output_invalid``. Collapsing the two would let a
    payload-shaped refusal hide the run-level one, so the distinction is pinned here.
    """
    with cli.Worker() as worker:
        worker.send(cli.execute_request(tools=[cli.tool()]))
        _reply_at_model(worker, cli.model_result(text="   \n\t ", tools=[]))
        code, frames, _, reason = _failed_run(worker)

    assert code == EXIT_APPLICATION_ERROR
    assert reason == "output_invalid"


def test_an_authority_reply_that_is_not_empty_refuses_the_run() -> None:
    with cli.Worker() as worker:
        worker.send(cli.execute_request(tools=[cli.tool()]))
        driver = cli.Driver(worker)
        request_id, _, _ = driver.next()
        worker.reply(request_id, {"ok": True})
        code, frames, _, reason = _failed_run(worker)
    assert reason == "authority_invalid"


@pytest.mark.parametrize(
    "reply",
    [
        pytest.param({"value": 1, "extra": 2}, id="unknown-field"),
        pytest.param({"other": 1}, id="no-value-key"),
        pytest.param([], id="not-an-object"),
    ],
)
def test_a_tool_payload_the_child_cannot_honour_refuses_the_run(reply: object) -> None:
    with cli.Worker() as worker:
        worker.send(cli.execute_request(tools=[cli.tool()]))
        driver = cli.Driver(worker)
        request_id, method, _ = driver.advance_until("tool.execute")
        worker.reply(request_id, reply)
        code, frames, _, reason = _failed_run(worker)
    assert reason == "tool_result_invalid"


def test_a_tool_name_the_model_answers_with_but_the_catalog_lacks_is_refused() -> None:
    with cli.Worker() as worker:
        worker.send(cli.execute_request(tools=[cli.tool()]))
        driver = _reply_at_model(
            worker,
            cli.model_result(
                tools=[cli.intent("tc-1", name="not_declared")],
                usage={"inputTokens": 1, "outputTokens": 1},
            ),
        )
        code, frames, _, reason = _failed_run(worker)
    assert reason == "unknown_tool"
    assert driver.methods().count("tool.execute") == 0


def test_arguments_that_violate_the_declared_schema_stop_before_the_tool_port() -> None:
    with cli.Worker() as worker:
        worker.send(cli.execute_request(tools=[cli.tool()]))
        driver = _reply_at_model(
            worker,
            cli.model_result(
                tools=[cli.intent("tc-1", arguments={"query": 5})],
                usage={"inputTokens": 1, "outputTokens": 1},
            ),
        )
        code, frames, _, reason = _failed_run(worker)
    assert reason == "invalid_arguments"
    assert driver.methods().count("tool.execute") == 0


# --- schemas ------------------------------------------------------------------


EXTERNAL_REF_SCHEMA = {
    "type": "object",
    "properties": {"query": {"$ref": "https://example.invalid/schema.json"}},
    "additionalProperties": False,
}
SELF_CONTAINED_SCHEMA = {
    "type": "object",
    "$defs": {"query": {"type": "string"}},
    "properties": {"query": {"$ref": "#/$defs/query"}},
    "required": ["query"],
    "additionalProperties": False,
}


def test_an_external_schema_reference_is_refused_without_being_fetched() -> None:
    """A ``$ref`` that leaves the schema is a retrieval request, and there is none."""
    with cli.Worker() as worker:
        worker.send(cli.execute_request(tools=[cli.tool(schema=EXTERNAL_REF_SCHEMA)]))
        server = cli.ScriptedServer(worker, cli.deterministic_script())
        server.serve_until()
        code, frames, _, reason = _failed_run(worker)
    assert reason == "catalog_invalid"
    assert [name for _, name, _ in server.requests].count("model.generate") == 0


def test_a_self_contained_schema_reference_still_resolves() -> None:
    code, frames, _, requests = cli.journey(tools=[cli.tool(schema=SELF_CONTAINED_SCHEMA)])
    assert code == EXIT_SUCCESS
    assert _terminal(frames)["result"] == {"text": "final answer"}
    assert [name for _, name, _ in requests].count("tool.execute") == 1


# --- exit status --------------------------------------------------------------


def test_a_successful_run_exits_zero_with_stdin_still_open() -> None:
    """Completion does not wait for the parent to close its end of the pipe."""
    with cli.Worker() as worker:
        worker.send(cli.execute_request(tools=[cli.tool()]))
        server = cli.ScriptedServer(worker, cli.deterministic_script())
        server.serve_until()
        code, _, stderr_text = worker.finish()
    assert code == EXIT_SUCCESS
    assert stderr_text == ""


@pytest.mark.parametrize(
    "mangle",
    [
        pytest.param("wrong-id", id="wrong-identifier"),
        pytest.param("no-result", id="no-result"),
        pytest.param("bad-payload", id="bad-payload"),
    ],
)
def test_a_failure_path_never_ends_in_exit_zero(mangle: str) -> None:
    worker = cli.Worker()
    try:
        worker.send(cli.execute_request(tools=[cli.tool()]))
        driver = cli.Driver(worker)
        request_id, method, _ = driver.advance_until("model.generate")
        if mangle == "wrong-id":
            worker.reply("w999", {})
        elif mangle == "no-result":
            worker.send({"jsonrpc": "2.0", "id": request_id})
        else:
            worker.reply(request_id, {"text": 5, "tools": [], "usage": {}})
        frames = worker.collect()
        code, _, _ = worker.finish()
    finally:
        worker.close()
    assert code in {EXIT_APPLICATION_ERROR, EXIT_PROTOCOL_ERROR}
    assert not [
        frame
        for frame in frames
        if isinstance(frame, dict) and frame.get("id") == cli.PARENT_ID and "result" in frame
    ]
