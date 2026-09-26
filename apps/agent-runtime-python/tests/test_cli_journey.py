"""The real CLI journey: one child process, a synthetic parent, no provider.

These tests are the evidence for the profile's happy path. They assert what crosses
the pipes — the exact frames, the preserved tool identity, the bounded terminal
result — plus the process facts the Server depends on: a clean stdout, an untouched
stderr, and exit zero. All content is synthetic: a scripted model, a recording tool
authority and a fixed authority reply.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

import support_cli as cli

pytestmark = pytest.mark.anyio

PACKAGE = Path(__file__).resolve().parents[1]

PROVIDER_MODULES = (
    "openai",
    "anthropic",
    "google",
    "genai",
    "cohere",
    "mistralai",
    "groq",
    "boto3",
    "botocore",
    "litellm",
    "vertexai",
    "bedrock",
)


def _terminal(frames: list[object]) -> dict[str, object]:
    for frame in frames:
        if isinstance(frame, dict) and frame.get("id") == cli.PARENT_ID:
            return frame
    raise AssertionError(f"no terminal frame in {frames!r}")


def _requests(frames: list[object]) -> list[tuple[str, str, dict[str, object]]]:
    out = []
    for frame in frames:
        if isinstance(frame, dict) and "method" in frame:
            out.append((frame["id"], frame["method"], frame["params"]))
    return out


def test_the_two_step_journey_completes_with_a_clean_stdout_and_exit_zero() -> None:
    with cli.Worker() as worker:
        worker.send(cli.execute_request())
        server = cli.ScriptedServer(worker, cli.deterministic_script())
        server.serve_until()
        raw = list(worker.raw_frames)
        code, frames, stderr_text = worker.finish()
    assert code == 0
    assert stderr_text == ""
    assert _terminal(frames) == {
        "jsonrpc": "2.0",
        "id": cli.PARENT_ID,
        "result": {"text": "final answer"},
    }
    # Every frame the child wrote is a protocol frame: one JSON object per line.
    assert raw
    for line in raw:
        assert line.endswith(b"\n")
        assert json.loads(line.decode("utf-8")) is not None


def test_child_identifiers_are_monotonic_and_contiguous() -> None:
    _, _, _, requests = cli.journey()
    assert cli.ids_are_monotonic(requests)
    assert [item[0] for item in requests] == [f"w{i + 1}" for i in range(len(requests))]


def test_authority_is_checked_around_every_model_step_and_tool_call() -> None:
    _, _, _, requests = cli.journey()
    methods = [item[1] for item in requests]
    assert set(methods) == {"authority.check", "model.generate", "tool.execute"}
    assert [name for name in methods if name != "authority.check"] == [
        "model.generate",
        "tool.execute",
        "model.generate",
    ]
    for index, (_, method, _) in enumerate(requests):
        if method == "authority.check":
            continue
        assert requests[index - 1][1] == "authority.check", index
        assert requests[index + 1][1] == "authority.check", index


def test_the_model_receives_the_frozen_message_shapes() -> None:
    _, _, _, requests = cli.journey()
    model_messages = [
        params["messages"] for _, method, params in requests if method == "model.generate"
    ]
    assert model_messages[0] == [{"role": "user", "content": cli.CONTROL_PROMPT}]
    assert model_messages[1] == [
        {"role": "user", "content": cli.CONTROL_PROMPT},
        {
            "role": "assistant",
            "content": [
                {
                    "type": "tool-call",
                    "toolCallId": "tc-1",
                    "toolName": "search",
                    "input": {"query": "a"},
                }
            ],
        },
        {
            "role": "tool",
            "content": [
                {
                    "type": "tool-result",
                    "toolCallId": "tc-1",
                    "toolName": "search",
                    "output": {"type": "json", "value": {"hits": [1, 2]}},
                }
            ],
        },
    ]


def test_the_sdk_part_mapping_is_exactly_the_frozen_shapes() -> None:
    """Every message the child sends uses one of the three admitted shapes."""
    _, _, _, requests = cli.journey()
    for _, method, params in requests:
        if method != "model.generate":
            continue
        for message in params["messages"]:
            assert message["role"] in {"user", "assistant", "tool"}
            if message["role"] == "user":
                assert set(message) == {"role", "content"}
                assert isinstance(message["content"], str)
            else:
                assert set(message) == {"role", "content"}
                kinds = {part["type"] for part in message["content"]}
                assert kinds <= {"text", "tool-call", "tool-result"}


def test_the_tool_intent_identity_and_arguments_are_preserved_verbatim() -> None:
    _, _, _, requests = cli.journey()
    tool_calls = [params for _, method, params in requests if method == "tool.execute"]
    assert tool_calls == [{"id": "tc-1", "name": "search", "arguments": {"query": "a"}}]


def test_a_tool_value_of_any_json_shape_round_trips_through_the_loop() -> None:
    for value in ({"hits": [1, 2]}, "plain text", 7, None, [1, {"deep": True}]):
        _, _, _, requests = cli.journey(
            script=cli.deterministic_script(tool_value=value)
        )
        model_payloads = [
            params["messages"] for _, method, params in requests if method == "model.generate"
        ]
        assert model_payloads[1][2]["content"][0]["output"] == {"type": "json", "value": value}


def test_the_terminal_result_carries_text_and_nothing_else() -> None:
    _, frames, _, _ = cli.journey()
    terminal = _terminal(frames)
    assert set(terminal) == {"jsonrpc", "id", "result"}
    assert set(terminal["result"]) == {"text"}
    assert terminal["result"]["text"] == "final answer"


def test_a_second_model_step_can_answer_without_any_tool_call() -> None:
    code, frames, _, requests = cli.journey(
        script=lambda method, params, index: (
            {}
            if method == "authority.check"
            else (
                cli.model_result(text="direct answer")
                if method == "model.generate"
                else (_ for _ in ()).throw(AssertionError("no tool call expected"))
            )
        )
    )
    assert code == 0
    assert [method for _, method, _ in requests if method != "authority.check"] == [
        "model.generate"
    ]
    assert _terminal(frames)["result"] == {"text": "direct answer"}


def test_the_child_runs_from_an_unrelated_directory_with_a_planted_shadow_module() -> None:
    """The working directory must not be an import root.

    A module named after the package is planted in the child's working directory. If
    the profile's ``-I`` plus explicit ``src`` insertion left the working directory on
    ``sys.path``, this file would shadow the real package and the journey would fail.
    """
    worker = cli.Worker()
    try:
        shadow = Path(worker.cwd) / "openbot_agent_runtime.py"
        shadow.write_text("raise ImportError('the working directory was on sys.path')\n")
        assert Path(worker.cwd) != PACKAGE
        worker.send(cli.execute_request())
        server = cli.ScriptedServer(worker, cli.deterministic_script())
        server.serve_until()
        code, frames, stderr_text = worker.finish()
        assert code == 0
        assert stderr_text == ""
        assert _terminal(frames)["result"] == {"text": "final answer"}
    finally:
        worker.close()


def test_the_child_reads_no_environment_variable() -> None:
    """A credential or endpoint could only arrive through the environment.

    The same journey runs twice with different poisoned values; the observed frames
    must be byte-identical, and no poisoned value may appear anywhere.
    """
    poison = {name: "poisoned-credential-value" for name in cli.CREDENTIAL_NAMES}
    first = cli.journey(env={**poison, cli.ENV_CANARY_NAME: cli.ENV_CANARY_VALUE})
    second = cli.journey(
        env={**poison, cli.ENV_CANARY_NAME: "a-different-canary-value"}
    )
    assert first[0] == 0 and second[0] == 0
    assert first[3] == second[3]
    assert first[1] == second[1]
    for _, _, stderr_text, _ in (first, second):
        assert stderr_text == ""
    for _, frames, _, _ in (first, second):
        rendered = json.dumps(frames)
        assert cli.ENV_CANARY_VALUE not in rendered
        assert "poisoned-credential-value" not in rendered


def test_an_empty_environment_is_enough_to_run() -> None:
    """The profile supplies everything the child needs: two pipes."""
    code, frames, stderr_text, _ = cli.journey(env={})
    assert code == 0
    assert stderr_text == ""
    assert _terminal(frames)["result"] == {"text": "final answer"}


def test_no_provider_client_is_loaded_by_the_run() -> None:
    """The run's model surface is the wire port, not a provider client.

    This is an import-graph guard, not a packet-capture claim: ``pydantic_ai`` itself
    does pull in an HTTP library, and the review notes say so. What it establishes is
    that no provider client — the thing that would hold an endpoint and a credential —
    is loaded at all, and that the journey's frames are unchanged when reported.
    """
    code, frames, stderr_text, requests = cli.journey(python_args=("-X", "importtime"))
    assert code == 0
    imported = set()
    for line in stderr_text.splitlines():
        if line.startswith("import time:"):
            fields = line.split("|")
            if len(fields) >= 3:
                imported.add(fields[2].strip().split(".")[0])
    assert imported, "the import report must not be empty"
    assert imported & set(PROVIDER_MODULES) == set()
    assert _terminal(frames)["result"] == {"text": "final answer"}
    assert [item[1] for item in requests if item[1] != "authority.check"] == [
        "model.generate",
        "tool.execute",
        "model.generate",
    ]


def test_the_package_closure_declares_no_provider_client() -> None:
    """The locked closure cannot supply a provider client to the child."""
    lock = (PACKAGE / "requirements.lock").read_text(encoding="utf-8").lower()
    pinned = {
        line.split("==")[0].strip()
        for line in lock.splitlines()
        if "==" in line and not line.startswith("#")
    }
    assert pinned
    for name in PROVIDER_MODULES:
        assert name not in pinned, name


def test_the_child_writes_nothing_to_stderr_on_a_clean_run() -> None:
    code, _, stderr_text, _ = cli.journey()
    assert code == 0
    assert stderr_text == ""


def test_the_protocol_stream_contains_no_diagnostic_text() -> None:
    """Stdout carries protocol only: no banner, no warning, no traceback."""
    with cli.Worker() as worker:
        worker.send(cli.execute_request())
        server = cli.ScriptedServer(worker, cli.deterministic_script())
        server.serve_until()
        lines = list(worker.raw_frames)
        code, _, _ = worker.finish()
    assert code == 0
    for line in lines:
        assert line.startswith(b"{"), line
        assert json.loads(line)["jsonrpc"] == "2.0"


def test_the_report_is_not_polluted_by_the_environment_canary() -> None:
    code, frames, stderr_text, _ = cli.journey()
    assert code == 0
    assert cli.ENV_CANARY_VALUE not in json.dumps(frames)
    assert cli.ENV_CANARY_VALUE not in stderr_text
    assert os.environ.get(cli.ENV_CANARY_NAME, "unset") == "unset"
