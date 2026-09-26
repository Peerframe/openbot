"""Request and projection contracts for the two Owner run commands.

Focused on the released Zod schemas, the stored steering row, and the acknowledgement bodies. The
store, the authority check and the routes are Root's; nothing here opens a connection or dispatches
anything.
"""

from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from openbot_server import run_commands, task_models
from openbot_server.run_commands import (
    CancelRunResponse,
    SteeringResponse,
    parse_cancel,
    parse_steering,
    project_steering,
)

_ASTRAL = "\U0001f600"
_COMBINING = "\u0301"
_ECMA_SPACE = "\u00a0"  # NBSP: trimmed by String.prototype.trim
_NOT_SPACE = "\u200b"  # zero-width space: kept by String.prototype.trim


def _event(**overrides) -> dict:
    row = {
        "id": "e1",
        "run_id": "r1",
        "channel_id": "c1",
        "bot_id": "b1",
        "payload": {"instruction": "Keep going.", "actor": "owner", "note": "internal"},
        "created_at": datetime(2026, 9, 23, 6, 30, 0, 999999, tzinfo=timezone.utc),
    }
    row.update(overrides)
    return row


def _without(column: str) -> dict:
    row = _event()
    del row[column]
    return row


def _run_row(**overrides) -> dict:
    row = {
        "id": "r1",
        "channel_id": "c1",
        "bot_id": "b1",
        "execution_profile": "none",
        "instruction": "Do the task.",
        "title": "Do the task.",
        "status": "running",
        "model_usage": {"provider": "openai", "model": "gpt-4o-mini", "steps": 1,
                        "inputTokens": 10, "outputTokens": None},
        "created_at": datetime(2026, 9, 23, 6, 0, 0, tzinfo=timezone.utc),
        "updated_at": datetime(2026, 9, 23, 6, 1, 0, tzinfo=timezone.utc),
    }
    row.update(overrides)
    return row


# ---------------------------------------------------------------------------
# SteerRunInput: one trimmed, bounded instruction and nothing else
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "instruction, expected",
    [
        ("Continue the task.", "Continue the task."),
        ("\t\n\u00a0 Continue the task. \u3000\ufeff", "Continue the task."),
        ("  a   b  ", "a   b"),
        ("\u001c", "\u001c"),
        ("\u0085", "\u0085"),
        (_NOT_SPACE, _NOT_SPACE),
        ("x" * 4000, "x" * 4000),
        (_ASTRAL * 4000, _ASTRAL * 4000),
        ("e" + _COMBINING * 3999, "e" + _COMBINING * 3999),
        (" " + _ASTRAL * 4000 + " ", _ASTRAL * 4000),
    ],
)
def test_accepts_one_bounded_instruction(instruction, expected):
    assert parse_steering({"instruction": instruction}).instruction == expected


@pytest.mark.parametrize(
    "value",
    [
        {},
        {"instruction": ""},
        {"instruction": "   "},
        {"instruction": _ECMA_SPACE},
        {"instruction": "\ufeff"},
        {"instruction": "x" * 4001},
        {"instruction": _ASTRAL * 4001},
        {"instruction": "e" + _COMBINING * 4000},
        {"instruction": " " + _ASTRAL * 4001 + " "},
        {"instruction": "ok", "extra": 1},
        {"instruction": "ok", "InStRuCtIoN": "other"},
        {"instruction": "ok", "id": "r1"},
        {"instruction": None},
        {"instruction": 1},
        {"instruction": {}},
        {"instruction": []},
        None,
        [],
        "instruction",
        5,
    ],
)
def test_refuses_anything_that_is_not_the_strict_request(value):
    with pytest.raises(ValidationError):
        parse_steering(value)


def test_the_published_bounds_are_the_bounds_it_enforces():
    """Metadata and validator come from one pair of numbers; a drift either way fails here."""
    schema = run_commands.SteerRunInput.model_json_schema()
    assert (schema["properties"]["instruction"]["minLength"],
            schema["properties"]["instruction"]["maxLength"]) == (1, 4000)
    assert schema["additionalProperties"] is False
    assert parse_steering({"instruction": "\u00a0" + "x" * 4000 + "\u00a0"}).instruction == "x" * 4000
    for rejected in ({"instruction": "x" * 4001}, {"instruction": _ECMA_SPACE},
                     {"instruction": "ok", "extra": 1}):
        with pytest.raises(ValidationError):
            parse_steering(rejected)


# ---------------------------------------------------------------------------
# CancelRunInput: the empty strict object
# ---------------------------------------------------------------------------

def test_cancellation_accepts_the_empty_object():
    assert parse_cancel({}).model_dump(mode="json") == {}


@pytest.mark.parametrize("value", [{"extra": 1}, {"runId": "r1"}, None, [], "x", 5, True])
def test_cancellation_refuses_any_field_or_other_shape(value):
    with pytest.raises(ValidationError):
        parse_cancel(value)


# ---------------------------------------------------------------------------
# project_steering: the six public fields, and nothing from the row beyond them
# ---------------------------------------------------------------------------

def test_projects_one_stored_steering_event():
    steering = project_steering(_event())
    assert steering.model_dump(mode="json") == {
        "id": "e1",
        "runId": "r1",
        "channelId": "c1",
        "botId": "b1",
        "instruction": "Keep going.",
        "createdAt": "2026-09-23T06:30:00.999Z",
    }
    response = SteeringResponse(steering=steering)
    assert response.model_dump(mode="json")["steering"]["instruction"] == "Keep going."


@pytest.mark.parametrize(
    "row",
    [
        _event(payload=None),
        _event(payload="not-an-object"),
        _event(payload=[]),
        _event(payload={}),
        _event(payload={"instruction": "   "}),
        _event(payload={"instruction": "x" * 4001}),
        _event(payload={"instruction": _ASTRAL * 4001}),
        _event(payload={"instruction": None}),
        _event(payload={"instruction": 1}),
        _event(payload={"instructions": "Keep going."}),
        _event(created_at=datetime(2026, 9, 23, 6, 30, 0)),
        _event(created_at="2026-09-23T06:30:00Z"),
        _without("payload"),
        _without("id"),
        _without("run_id"),
        _without("channel_id"),
        _without("bot_id"),
        _without("created_at"),
    ],
)
def test_refuses_a_row_it_cannot_project(row):
    with pytest.raises((ValidationError, KeyError, ValueError)):
        project_steering(row)


# ---------------------------------------------------------------------------
# CancelRunResponse: a Run, including the nulls that are contract
# ---------------------------------------------------------------------------

def test_cancellation_keeps_a_null_token_count_and_omits_absent_optionals():
    """``modelUsage`` nulls mean "a count was unavailable": they survive ``exclude_none``."""
    response = CancelRunResponse(run=task_models.project_run(_run_row()))
    body = response.model_dump(mode="json", exclude_none=True)
    assert body["run"]["modelUsage"] == {
        "provider": "openai", "model": "gpt-4o-mini", "steps": 1,
        "inputTokens": 10, "outputTokens": None,
    }
    assert body["run"]["status"] == "running"
    assert "parentRunId" not in body["run"]
    assert "errorCode" not in body["run"]
