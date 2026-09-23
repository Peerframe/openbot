"""Optimistic profile edits and exact audit atomicity in the owned database."""
import asyncio
import hashlib
import json
import os
from uuid import uuid4

from fastapi.testclient import TestClient
import psycopg
import pytest

from openbot_server.app import create_app
from openbot_server.authority import AuthenticationRequired
from openbot_server.database import PostgresReadStore, StoreUnavailable
from openbot_server.identity_inputs import parse_bot_create
from openbot_server.identity_store import PostgresIdentityStore
from openbot_server.profile_details import PostgresProfileStore, ProfileConflict, parse_profile_details
from test_auth_postgres import authentication


def new_bot(fixture, name):
    return asyncio.run(PostgresIdentityStore(fixture["dsn"]).create_bot(fixture["token"], parse_bot_create({"name": name, "role": "original"})))


def test_profile_edit_commits_exact_data_and_audit_for_typescript_readback(fixture):
    bot = new_bot(fixture, "Python profile readback")
    value = parse_profile_details({"role": " 核查 ", "description": " 复核文件 🧪 ", "expectedRevision": 1})
    result = asyncio.run(PostgresProfileStore(fixture["dsn"]).update(fixture["token"], bot.id, value))
    payload = result.model_dump(mode="json", exclude_none=True)
    assert result.employee.role == "核查" and result.details.description == "复核文件 🧪" and result.details.revision == 2
    assert result.evolution.summary == "Owner updated: role, description."
    assert result.evolution.createdAt == result.details.updatedAt
    with psycopg.connect(fixture["dsn"]) as connection:
        assert connection.execute("SELECT role,description,profile_revision FROM bots WHERE id=%s", (bot.id,)).fetchone() == ("核查", "复核文件 🧪", 2)
        assert connection.execute("SELECT type,title,source,evidence FROM employee_evolution_events WHERE id=%s", (result.evolution.id,)).fetchone() == ("role_changed", "Employee role updated", "manual", [])
        assert connection.execute("SELECT payload FROM run_events WHERE bot_id=%s AND type='EMPLOYEE_PROFILE_UPDATED'", (bot.id,)).fetchall() == [({"changedFields": ["role", "description"], "revision": 2},)]
    with os.fdopen(os.open(fixture["profileResult"], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
        json.dump(payload, output)


def test_competing_profile_edits_have_one_winner_and_one_conflict(fixture):
    bot = new_bot(fixture, "Python conflicting profile")
    async def check():
        store = PostgresProfileStore(fixture["dsn"])
        return await asyncio.gather(*(store.update(fixture["token"], bot.id, parse_profile_details(
            {"role": "original", "description": label, "expectedRevision": 1})) for label in ("first", "second")), return_exceptions=True)
    results = asyncio.run(check())
    assert sum(isinstance(value, ProfileConflict) for value in results) == 1
    winner = next(value for value in results if not isinstance(value, Exception))
    assert winner.details.revision == 2 and winner.evolution.type == "configuration_changed"
    with psycopg.connect(fixture["dsn"]) as connection:
        assert connection.execute("SELECT description,profile_revision FROM bots WHERE id=%s", (bot.id,)).fetchone() == (winner.details.description, 2)
        assert connection.execute("SELECT count(*) FROM employee_evolution_events WHERE bot_id=%s", (bot.id,)).fetchone() == (2,)
        assert connection.execute("SELECT count(*) FROM run_events WHERE bot_id=%s AND type='EMPLOYEE_PROFILE_UPDATED'", (bot.id,)).fetchone() == (1,)


def test_profile_audit_failure_rolls_back_revision_and_evolution(fixture):
    bot = new_bot(fixture, "Python profile rollback")
    with psycopg.connect(fixture["dsn"]) as connection:
        connection.execute("CREATE FUNCTION control_test_reject_profile() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
                           "IF NEW.type='EMPLOYEE_PROFILE_UPDATED' THEN RAISE EXCEPTION 'private fixture failure'; END IF; RETURN NEW; END $$")
        connection.execute("CREATE TRIGGER control_test_reject_profile BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION control_test_reject_profile()")
    try:
        with pytest.raises(StoreUnavailable):
            asyncio.run(PostgresProfileStore(fixture["dsn"]).update(fixture["token"], bot.id,
                        parse_profile_details({"role": "changed", "description": "text", "expectedRevision": 1})))
        with psycopg.connect(fixture["dsn"]) as connection:
            assert connection.execute("SELECT role,description,profile_revision FROM bots WHERE id=%s", (bot.id,)).fetchone() == ("original", "", 1)
            assert connection.execute("SELECT count(*) FROM employee_evolution_events WHERE bot_id=%s", (bot.id,)).fetchone() == (1,)
    finally:
        with psycopg.connect(fixture["dsn"]) as connection:
            connection.execute("DROP TRIGGER control_test_reject_profile ON run_events")
            connection.execute("DROP FUNCTION control_test_reject_profile()")


@pytest.mark.parametrize("change", ["revoked_at=clock_timestamp()", "expires_at=clock_timestamp()-interval '1 second'"])
def test_profile_writer_rejects_revoked_and_expired_owner(fixture, change):
    issued = asyncio.run(authentication(fixture).login(fixture["ownerPassword"], "192.0.2.82"))
    with psycopg.connect(fixture["dsn"]) as connection:
        connection.execute("UPDATE auth_sessions SET " + change + " WHERE token_digest=%s", (hashlib.sha256(issued.token.encode()).hexdigest(),))
    with pytest.raises(AuthenticationRequired):
        asyncio.run(PostgresProfileStore(fixture["dsn"]).update(issued.token, str(uuid4()),
                    parse_profile_details({"role": "changed", "description": "", "expectedRevision": 1})))


def test_profile_asgi_preserves_missing_conflict_and_no_change_errors(fixture):
    bot = new_bot(fixture, "Python profile errors")
    app = create_app(PostgresReadStore(fixture["dsn"]), owner_name=fixture["ownerName"], secure_cookies=False,
                     profiles=PostgresProfileStore(fixture["dsn"]), allowed_origins=("http://control.test",))
    with TestClient(app, base_url="http://control.test") as client:
        client.headers["Origin"] = "http://control.test"
        client.cookies.set("openbot_session", fixture["token"])
        value = {"role": "original", "description": "", "expectedRevision": 1}
        assert client.patch(f"/api/v1/bots/{bot.id}/profile", json=value).status_code == 422
        assert client.patch(f"/api/v1/bots/{bot.id}/profile", json={**value, "expectedRevision": 2}).status_code == 409
        assert client.patch(f"/api/v1/bots/{uuid4()}/profile", json=value).status_code == 404
