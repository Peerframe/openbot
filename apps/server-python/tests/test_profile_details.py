"""Focused regression tests for the optimistic Owner profile-edit adapter.

The adapter is exercised against a fake authority context and a recording connection, so these cases
prove the input contract, the compare-and-set decision, the exact audit contents and the returned
projection. They deliberately claim nothing about real row locks, real commits or real rollback: two
simultaneous requests, audit rollback and status mapping are Root's database and HTTP acceptance. No
loopback server or database is used; the authority check is observed without opening a connection.
"""
import asyncio
import json
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from uuid import UUID
from unittest.mock import AsyncMock

import psycopg
import pytest
from pydantic import ValidationError

from openbot_server import profile_details
from openbot_server.authority import AuthenticationRequired
from openbot_server.database import StoreUnavailable

BOT_ID = "1f8b0f1e-5e3d-4f8a-9c2b-7d6e5f4a3b2c"
TOKEN = "t" * 43
# Dummy configuration only; offline tests replace the connection before any possible I/O.
DSN = "postgresql://owner@127.0.0.1:1/openbot_control"
UPDATED_AT = datetime(2026, 1, 2, 3, 4, 5, 123456, tzinfo=timezone.utc)
CREATED_AT = datetime(2026, 1, 1, 0, 0, 0, 999999, tzinfo=timezone.utc)
MAX_SAFE_INTEGER = 2**53 - 1
EVOLUTION_SQL = "INSERT INTO employee_evolution_events"
EVENT_SQL = "INSERT INTO run_events"


class FakeCursor:
    def __init__(self, rows):
        self._rows = list(rows)

    async def fetchone(self):
        return self._rows.pop(0) if self._rows else None


class FakeConnection:
    """Records every statement and replays one queued result set per execution.

    Each positional argument is one result set; a bare row mapping is accepted for readability.
    """

    def __init__(self, *results):
        self.statements = []
        self._results = [rows if isinstance(rows, list) else [rows] for rows in results]

    async def execute(self, sql, params=None):
        self.statements.append((sql, params))
        return FakeCursor(self._results.pop(0))


class FakeTransactions:
    def __init__(self, connection):
        self.connection = connection
        self.tokens = []

    @asynccontextmanager
    async def transaction(self, token):
        self.tokens.append(token)
        yield self.connection

    async def verify_schema(self):
        pass


def bot_row(**overrides):
    row = {"id": BOT_ID, "name": "巡检机器人", "role": "旧角色", "description": "旧描述",
           "status": "idle", "computer_profile": "docker-linux", "configuration": {},
           "created_at": CREATED_AT, "updated_at": CREATED_AT, "profile_revision": 4}
    row.update(overrides)
    return row


def evolution_row(**overrides):
    row = {"id": "8a1f0d2c-3b4e-4f5a-9c6d-7e8f9a0b1c2d", "bot_id": BOT_ID,
           "type": "role_changed", "title": "Employee role updated",
           "summary": "Owner updated: role.", "source": "manual", "source_id": None,
           "evidence": [], "created_at": UPDATED_AT}
    row.update(overrides)
    return row


def rows_for(current, updated=None, evolution=None):
    """The result sets the adapter consumes: SELECT, UPDATE, evolution, run event."""
    return FakeConnection([current], [updated] if updated is not None else [],
                          [evolution] if evolution is not None else [], [])


def update(connection, value, bot_id=BOT_ID):
    store = profile_details.PostgresProfileStore(DSN)
    store._transactions = FakeTransactions(connection)
    return asyncio.run(store.update(TOKEN, bot_id, profile_details.parse_profile_details(value)))


def edit(role="新角色", description="旧描述", expectedRevision=4):
    return {"role": role, "description": description, "expectedRevision": expectedRevision}


def params_of(connection, prefix):
    matches = [params for sql, params in connection.statements if sql.startswith(prefix)]
    assert len(matches) == 1, [sql for sql, _ in connection.statements]
    return matches[0]


def writes(connection):
    """Every statement that could change stored state; the refused paths must have none."""
    return [sql for sql, _ in connection.statements if not sql.lstrip().upper().startswith("SELECT")]


# ---------------------------------------------------------------------------
# Input contract
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value",
    [
        {"role": "a", "description": "b", "expectedRevision": 1, "name": "extra"},
        {"role": "a", "description": "b", "expectedRevision": 1, "evidence": []},
        {"role": "a", "expectedRevision": 1},
        {"description": "b", "expectedRevision": 1},
        {"role": "a", "description": "b"},
        {"role": None, "description": "b", "expectedRevision": 1},
        {"role": "a", "description": None, "expectedRevision": 1},
        {"role": "a", "description": "b", "expectedRevision": None},
        {"role": 5, "description": "b", "expectedRevision": 1},
        ["a", "b", 1],
    ],
)
def test_input_is_strict_and_free_of_implicit_values(value):
    """Unknown keys, missing keys, explicit null and wrong types are refused, as Zod refuses them."""
    with pytest.raises(ValidationError):
        profile_details.parse_profile_details(value)


def test_expected_revision_accepts_mathematical_integers_only():
    """Zod has one number type, so the token ``1.0`` is the integer 1 rather than a rejected float."""
    for token in (1.0, 3.0, 2e0, float(MAX_SAFE_INTEGER)):
        parsed = profile_details.parse_profile_details(
            {"role": "r", "description": "d", "expectedRevision": token})
        assert parsed.expectedRevision == int(token)
        assert type(parsed.expectedRevision) is int
    refused = [True, False, "1", "1.0", 1.5, 0, -1, MAX_SAFE_INTEGER + 1, float("nan"),
               float("inf"), float("-inf"), 1e400, None, [], {}]
    for revision in refused:
        try:
            profile_details.parse_profile_details(
                {"role": "r", "description": "d", "expectedRevision": revision})
        except ValidationError:
            continue
        pytest.fail(f"expectedRevision={revision!r} was accepted")


def test_text_is_trimmed_by_the_shared_helper_and_the_published_schema_says_so():
    parsed = profile_details.parse_profile_details(
        {"role": "  主管  ", "description": "  负责巡检  ", "expectedRevision": 1})
    assert (parsed.role, parsed.description) == ("主管", "负责巡检")
    # A description may trim to empty; a role may not.
    assert profile_details.parse_profile_details(
        {"role": "r", "description": "\u00a0", "expectedRevision": 1}).description == ""
    for value in ({"role": "   ", "description": "d"}, {"role": "\ufeff", "description": "d"},
                  {"role": "a" * 161, "description": "d"},
                  {"role": "r", "description": "b" * 2001}):
        with pytest.raises(ValidationError):
            profile_details.parse_profile_details({**value, "expectedRevision": 1})
    accepted = profile_details.parse_profile_details(
        {"role": "a" * 160, "description": "b" * 2000, "expectedRevision": 1})
    assert (len(accepted.role), len(accepted.description)) == (160, 2000)
    # 160 astral characters are 160 code points, not the 320 UTF-16 units a JS length would report.
    astral = profile_details.parse_profile_details(
        {"role": "\U0001f600" * 160, "description": "d", "expectedRevision": 1}).role
    assert astral == "\U0001f600" * 160 and len(astral) == 160

    # The route publishes this schema, and it describes normalized text and a bounded integer.
    properties = profile_details.ProfileDetailsInput.model_json_schema()["properties"]
    assert properties["role"]["minLength"] == 1 and properties["role"]["maxLength"] == 160
    assert "minLength" not in properties["description"]
    assert properties["description"]["maxLength"] == 2000
    assert properties["expectedRevision"]["type"] == "integer"
    assert properties["expectedRevision"]["minimum"] == 1
    assert properties["expectedRevision"]["maximum"] == MAX_SAFE_INTEGER


# ---------------------------------------------------------------------------
# Transaction decision
# ---------------------------------------------------------------------------


def test_missing_bot_stale_revision_and_unchanged_input_all_write_nothing():
    missing = rows_for(None)
    with pytest.raises(profile_details.ProfileNotFound):
        update(missing, edit())
    stale = rows_for(bot_row(profile_revision=9))
    with pytest.raises(profile_details.ProfileConflict):
        update(stale, edit())
    unchanged = rows_for(bot_row())
    with pytest.raises(profile_details.ProfileUnchanged):
        update(unchanged, edit(role="旧角色", description="旧描述"))
    # Trimming happens before the comparison, so a padded restatement is still no change at all.
    padded = rows_for(bot_row())
    with pytest.raises(profile_details.ProfileUnchanged):
        update(padded, edit(role="  旧角色  ", description="旧描述"))
    for connection in (missing, stale, unchanged, padded):
        assert writes(connection) == []
    # The revision predicate is also the last line of defence: a lost UPDATE row is a conflict.
    lost = rows_for(bot_row(), updated=None)
    with pytest.raises(profile_details.ProfileConflict):
        update(lost, edit())
    assert writes(lost) == ["UPDATE bots SET role=%s, description=%s, profile_revision="
                            "profile_revision+1, updated_at=date_trunc('milliseconds', "
                            "statement_timestamp()) WHERE id=%s AND profile_revision=%s RETURNING *"]


def test_the_update_is_conditional_on_the_bot_id_and_the_expected_revision():
    connection = rows_for(bot_row(), updated=bot_row(role="新角色", profile_revision=5),
                          evolution=evolution_row())
    update(connection, edit())
    assert params_of(connection, "UPDATE bots") == ("新角色", "旧描述", BOT_ID, 4)


def test_role_only_edit_writes_the_role_audit_rows():
    # ``updated_at`` is deliberately distinct from the row's previous value: both audit rows must
    # carry the timestamp the UPDATE produced, not whatever the Bot already had.
    connection = rows_for(bot_row(),
                          updated=bot_row(role="新角色", profile_revision=5, updated_at=UPDATED_AT),
                          evolution=evolution_row())
    result = update(connection, edit())
    assert result.employee.role == "新角色"
    assert result.details.revision == 5 and result.details.description == "旧描述"
    assert result.evolution.summary == "Owner updated: role."
    evolution = params_of(connection, EVOLUTION_SQL)
    event = params_of(connection, EVENT_SQL)
    assert (evolution[1], evolution[2]) == (BOT_ID, "role_changed")
    assert evolution[3] == "Employee role updated"
    assert evolution[4] == "Owner updated: role."
    assert isinstance(UUID(evolution[0]), UUID) and UUID(evolution[0]) != UUID(event[0])
    assert event[1] == BOT_ID and event[2].obj == {"changedFields": ["role"], "revision": 5}
    # One timestamp for the profile and both audit rows, exactly as TS reuses ``now``.
    assert evolution[-1] == UPDATED_AT and event[-1] == UPDATED_AT
    assert result.evolution.createdAt == result.details.updatedAt == "2026-01-02T03:04:05.123Z"


def test_description_only_edit_writes_the_configuration_audit_rows():
    connection = rows_for(bot_row(), updated=bot_row(description="新描述", profile_revision=5),
                          evolution=evolution_row(type="configuration_changed",
                                                  title="Profile updated",
                                                  summary="Owner updated: description."))
    result = update(connection, edit(role="旧角色", description="新描述"))
    assert result.evolution.type == "configuration_changed"
    assert result.evolution.title == "Profile updated"
    assert result.evolution.summary == "Owner updated: description."
    assert params_of(connection, EVENT_SQL)[2].obj == {"changedFields": ["description"],
                                                       "revision": 5}


def test_both_fields_change_and_changed_fields_keep_the_source_order():
    connection = rows_for(bot_row(),
                          updated=bot_row(role="新角色", description="新描述", profile_revision=5),
                          evolution=evolution_row(summary="Owner updated: role, description."))
    result = update(connection, edit(description="新描述"))
    assert result.evolution.summary == "Owner updated: role, description."
    assert params_of(connection, EVENT_SQL)[2].obj == {"changedFields": ["role", "description"],
                                                       "revision": 5}


# ---------------------------------------------------------------------------
# Result shape and failure mapping
# ---------------------------------------------------------------------------


def test_the_result_is_the_public_envelope_and_leaks_no_private_configuration():
    connection = rows_for(bot_row(),
                          updated=bot_row(role="新角色", profile_revision=5,
                                          configuration={"apiKey": "sk-secret"}),
                          evolution=evolution_row())
    payload = update(connection, edit()).model_dump(mode="json", exclude_none=True)
    assert set(payload) == {"employee", "details", "evolution"}
    assert set(payload["employee"]) == {"id", "name", "role", "status", "computerProfile",
                                        "createdAt"}
    assert set(payload["details"]) == {"description", "revision", "updatedAt"}
    assert set(payload["evolution"]) == {"id", "botId", "type", "title", "summary", "source",
                                         "evidence", "createdAt"}
    assert payload["evolution"]["evidence"] == []
    assert "sourceId" not in payload["evolution"]
    assert "sk-secret" not in json.dumps(payload)


class FailingConnection(FakeConnection):
    async def execute(self, sql, params=None):
        raise psycopg.OperationalError("connection lost")


def test_projection_driver_and_missing_row_failures_share_one_fixed_storage_category():
    for label, results in [
        ("corrupt bot row", [bot_row(profile_revision=4), bot_row(status="robot"),
                             evolution_row(), []]),
        ("corrupt revision", [bot_row(profile_revision=4), bot_row(profile_revision="five"),
                              evolution_row(), []]),
        ("foreign evolution type", [bot_row(profile_revision=4), bot_row(profile_revision=5),
                                    evolution_row(type="created"), []]),
        ("non-empty evidence", [bot_row(profile_revision=4), bot_row(profile_revision=5),
                                evolution_row(evidence=[{"ref": "x"}]), []]),
        ("no evolution row", [bot_row(profile_revision=4), bot_row(profile_revision=5), []]),
    ]:
        with pytest.raises(StoreUnavailable) as failure:
            update(FakeConnection(*results), edit())
        assert str(failure.value) == "profile_storage_unavailable", label
    with pytest.raises(StoreUnavailable) as failure:
        update(FailingConnection(), edit())
    assert str(failure.value) == "profile_storage_unavailable"


def test_owner_authority_is_the_shared_context_and_is_never_a_storage_error():
    """A malformed session is refused by the shared Owner transaction before any connection."""
    store = profile_details.PostgresProfileStore(DSN)
    value = profile_details.parse_profile_details(edit())
    store._transactions._connect = AsyncMock(side_effect=AssertionError("No offline database access"))
    with pytest.raises(AuthenticationRequired):
        asyncio.run(store.update("short", BOT_ID, value))
    with pytest.raises(AuthenticationRequired):
        asyncio.run(store.update(None, BOT_ID, value))
    store._transactions._connect.assert_not_called()
