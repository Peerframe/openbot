"""Interval contracts and real PostgreSQL schedule/authority transactions."""
import asyncio
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
from urllib.parse import urlparse
from uuid import uuid4

import psycopg
import pytest
from pydantic import ValidationError

from openbot_server.authority import AuthenticationRequired
from openbot_server.automation_store import PostgresAutomations, next_interval_occurrence, parse_automation
from openbot_server.control_errors import ControlError


@pytest.fixture(scope="module")
def synthetic_db():
    path = os.environ.get("OPENBOT_CONTROL_TEST_FIXTURE")
    if not path:
        pytest.skip("Requires the owned OPENBOT_CONTROL_TEST_FIXTURE PostgreSQL database")
    data = json.loads(Path(path).read_text())
    target = urlparse(data["dsn"])
    assert target.hostname == "127.0.0.1" and target.path.startswith("/openbot_control_test_")
    return data


@pytest.fixture
def seed(synthetic_db):
    identities = [str(uuid4()) for _ in range(3)]
    bot, peer, channel = identities
    with psycopg.connect(synthetic_db["dsn"]) as db:
        db.execute("INSERT INTO bots(id,name,role,computer_profile) VALUES (%s,%s,'Assistant','none'),(%s,%s,'Reviewer','none')", (bot,"Scheduled "+bot,peer,"Peer "+peer))
        db.execute("INSERT INTO channels(id,name,description) VALUES (%s,'Schedule fixture','Group description')", (channel,))
        db.execute("INSERT INTO channel_bots(channel_id,bot_id) VALUES (%s,%s),(%s,%s)", (channel,bot,channel,peer))
    yield {**synthetic_db, "bot": bot, "peer": peer, "channel": channel}
    with psycopg.connect(synthetic_db["dsn"]) as db:
        db.execute("DELETE FROM automations WHERE channel_id=%s", (channel,))
        db.execute("DELETE FROM run_events WHERE channel_id=%s", (channel,))
        db.execute("DELETE FROM runs WHERE channel_id=%s", (channel,))
        db.execute("DELETE FROM messages WHERE channel_id=%s", (channel,))
        db.execute("DELETE FROM channel_bots WHERE channel_id=%s", (channel,))
        db.execute("DELETE FROM channels WHERE id=%s", (channel,))
        db.execute("DELETE FROM bots WHERE id=ANY(%s)", ([bot, peer],))


def command(seed, **overrides):
    return {"name": "Daily check", "channelId": seed["channel"], "botId": seed["bot"], "prompt": "Review evidence",
            "intervalMinutes": 60, "firstRunAt": (datetime.now(timezone.utc)+timedelta(hours=1)).isoformat().replace("+00:00", "Z"), **overrides}


def make_due(seed, identity):
    with psycopg.connect(seed["dsn"]) as db:
        db.execute("UPDATE automations SET next_run_at=now()-interval '2 days' WHERE id=%s", (identity,))


def test_interval_jumps_over_downtime_and_preserves_future_occurrences():
    first = datetime(2026, 1, 1, tzinfo=timezone.utc)
    assert next_interval_occurrence(first, 60, first) == first + timedelta(hours=1)
    assert next_interval_occurrence(first, 60, first+timedelta(days=90,minutes=59)) == first+timedelta(days=90,hours=1)
    assert next_interval_occurrence(first, 60, first-timedelta(days=1)) == first
    for interval in (True, 14, 10081, 1.5):
        with pytest.raises(ValueError):
            next_interval_occurrence(first, interval, first)


def test_automation_input_preserves_strict_utc_integer_and_utf16_contract():
    value = command({"channel": "channel", "bot": "bot"}, name="\ufeff Name \u3000", intervalMinutes=60.0)
    assert parse_automation(value).name == "Name"
    assert parse_automation(value).intervalMinutes == 60
    for changes in ({"extra": 1}, {"name": "🧪"*41}, {"prompt": " "}, {"intervalMinutes": True},
                    {"intervalMinutes": 10**1000}, {"intervalMinutes": float("nan")},
                    {"firstRunAt": "2026-02-30T00:00:00Z"}, {"firstRunAt": "2026-01-01T00:00Z"},
                    {"firstRunAt": "2026-01-01T00:00:00+00:00"}, {"channelId": None}):
        with pytest.raises(ValidationError):
            parse_automation({**value, **changes})


def test_parallel_claim_is_single_atomic_submission_and_carries_provenance(seed):
    async def check():
        store = PostgresAutomations(seed["dsn"])
        created = await store.create(seed["token"], command(seed))
        make_due(seed, created["id"])
        batches = await asyncio.gather(*(PostgresAutomations(seed["dsn"]).submit_due() for _ in range(4)))
        results = [row for batch in batches for row in batch]
        assert len(results) == 1
        result = results[0]
        assert result["message"]["authorType"] == "system"
        assert result["message"]["runId"] == result["run"]["id"]
        assert result["run"]["sourceMessageId"] == result["message"]["id"]
        assert result["run"]["botId"] == seed["bot"] and result["run"]["status"] == "queued"
        assert "runs" not in result
        saved = next(row for row in await store.list(seed["token"]) if row["id"] == created["id"])
        assert saved["lastOutcome"] == "submitted" and saved["lastRunId"] == result["run"]["id"]
        assert datetime.fromisoformat(saved["nextRunAt"]) > datetime.now(timezone.utc)
        return created, result
    created, result = asyncio.run(check())
    with psycopg.connect(seed["dsn"]) as db:
        events = dict(db.execute("SELECT type,payload FROM run_events WHERE channel_id=%s", (seed["channel"],)).fetchall())
        assert set(events) == {"AUTOMATION_CREATED", "MESSAGE_CREATED", "RUN_CREATED", "AUTOMATION_OCCURRENCE"}
        assert all(payload["automationId"] == created["id"] for payload in events.values())
        assert events["MESSAGE_CREATED"]["authorType"] == "system"
        assert events["RUN_CREATED"]["sourceMessageId"] == result["message"]["id"]


@pytest.mark.parametrize("status", ["queued", "assigned", "running", "waiting_approval", "blocked"])
def test_active_previous_run_suppresses_overlap(seed, status):
    async def check():
        store = PostgresAutomations(seed["dsn"])
        schedule = await store.create(seed["token"], command(seed))
        make_due(seed, schedule["id"])
        first = (await store.submit_due())[0]
        with psycopg.connect(seed["dsn"]) as db:
            db.execute("UPDATE runs SET status=%s WHERE id=%s", (status, first["run"]["id"]))
        make_due(seed, schedule["id"])
        assert await store.submit_due() == []
        saved = next(row for row in await store.list(seed["token"]) if row["id"] == schedule["id"])
        assert saved["lastOutcome"] == "skipped_active" and saved["enabled"]
        with psycopg.connect(seed["dsn"]) as db:
            assert db.execute("SELECT count(*) FROM messages WHERE channel_id=%s", (seed["channel"],)).fetchone() == (1,)
    asyncio.run(check())


def test_pause_resume_target_loss_and_delete_do_not_cancel_existing_run(seed):
    async def check():
        store = PostgresAutomations(seed["dsn"])
        schedule = await store.create(seed["token"], command(seed))
        await store.set_enabled(seed["token"], schedule["id"], False)
        make_due(seed, schedule["id"])
        assert await store.submit_due() == []
        resumed = await store.set_enabled(seed["token"], schedule["id"], True)
        assert resumed["enabled"]
        assert datetime.fromisoformat(resumed["nextRunAt"]) > datetime.now(timezone.utc)
        make_due(seed, schedule["id"])
        result = (await store.submit_due())[0]
        await store.delete(seed["token"], schedule["id"])
        with psycopg.connect(seed["dsn"]) as db:
            assert db.execute("SELECT status FROM runs WHERE id=%s", (result["run"]["id"],)).fetchone() == ("queued",)
        lost = await store.create(seed["token"], command(seed))
        with psycopg.connect(seed["dsn"]) as db:
            db.execute("DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s", (seed["channel"],seed["bot"]))
        make_due(seed, lost["id"])
        assert await store.submit_due() == []
        saved = next(row for row in await store.list(seed["token"]) if row["id"] == lost["id"])
        assert not saved["enabled"] and saved["lastOutcome"] == "target_unavailable"
        with pytest.raises(ControlError) as error:
            await store.set_enabled(seed["token"], lost["id"], True)
        assert error.value.code == "automation_bot_not_member"
    asyncio.run(check())


def test_attachment_lock_is_real_and_missing_or_deleted_references_disable_schedule(seed, tmp_path):
    from openbot_server.owner_files import OwnerFiles
    (tmp_path / "files").mkdir(mode=0o700)
    files = OwnerFiles(tmp_path / "files")
    item = files.persist(seed["channel"], "evidence.txt", b"Evidence")
    prompt = f"Read [OpenBot attachment: {item['id']}]"
    async def check():
        with pytest.raises(ControlError) as error:
            await PostgresAutomations(seed["dsn"]).create(seed["token"], command(seed,prompt=prompt))
        assert error.value.code == "attachment_references_unavailable"
        store = PostgresAutomations(seed["dsn"], files=files)
        schedule = await store.create(seed["token"], command(seed,prompt=prompt))
        async with files.lock():
            pending = asyncio.create_task(store.set_enabled(seed["token"], schedule["id"], True))
            await asyncio.sleep(0.03)
            assert not pending.done()
            files.set_deleted(seed["channel"], item["id"], True)
        with pytest.raises(ControlError):
            await pending
        make_due(seed, schedule["id"])
        assert await store.submit_due() == []
        saved = next(row for row in await store.list(seed["token"]) if row["id"] == schedule["id"])
        assert saved["lastOutcome"] == "attachment_unavailable" and not saved["enabled"]
    asyncio.run(check())


def test_due_failure_rolls_back_run_message_claim_and_audits(seed):
    store = PostgresAutomations(seed["dsn"])
    created = asyncio.run(store.create(seed["token"], command(seed)))
    make_due(seed,created["id"])
    with psycopg.connect(seed["dsn"]) as db:
        db.execute("ALTER TABLE automations ADD CONSTRAINT schedule_test_rollback CHECK(last_outcome IS DISTINCT FROM 'submitted')")
    try:
        with pytest.raises(ControlError) as error:
            asyncio.run(store.submit_due())
        assert error.value.status == 503
        with psycopg.connect(seed["dsn"]) as db:
            assert db.execute("SELECT count(*) FROM messages WHERE channel_id=%s", (seed["channel"],)).fetchone() == (0,)
            assert db.execute("SELECT count(*) FROM runs WHERE channel_id=%s", (seed["channel"],)).fetchone() == (0,)
            assert db.execute("SELECT last_outcome FROM automations WHERE id=%s", (created["id"],)).fetchone() == (None,)
            assert db.execute("SELECT count(*) FROM run_events WHERE channel_id=%s", (seed["channel"],)).fetchone() == (1,)
    finally:
        with psycopg.connect(seed["dsn"]) as db:
            db.execute("ALTER TABLE automations DROP CONSTRAINT schedule_test_rollback")


def test_creation_limit_is_serialized_and_auth_is_required_for_all_owner_methods(seed):
    with psycopg.connect(seed["dsn"]) as db:
        existing = db.execute("SELECT count(*) FROM automations").fetchone()[0]
        for _ in range(49-existing):
            db.execute("INSERT INTO automations(id,name,channel_id,bot_id,prompt,interval_minutes,next_run_at) VALUES (%s,'Cap',%s,%s,'Review',60,now()+interval '1 hour')",
                       (str(uuid4()),seed["channel"],seed["bot"]))
    async def check():
        store = PostgresAutomations(seed["dsn"])
        result = await asyncio.gather(*(store.create(seed["token"],command(seed)) for _ in range(2)),return_exceptions=True)
        assert sum(isinstance(row,dict) for row in result) == 1
        assert next(row for row in result if isinstance(row,ControlError)).code == "automation_count_limit"
        for operation in (store.list(None),store.create(None,command(seed)),store.set_enabled(None,"missing",False),store.delete(None,"missing")):
            with pytest.raises(AuthenticationRequired):
                await operation
    asyncio.run(check())


def test_owner_expiry_at_commit_rolls_back_new_schedule(seed):
    token = secrets.token_urlsafe(32)
    digest = hashlib.sha256(token.encode()).hexdigest()
    with psycopg.connect(seed["dsn"]) as db:
        db.execute("INSERT INTO auth_sessions(id,token_digest,expires_at) VALUES (%s,%s,clock_timestamp()+interval '250 milliseconds')", (str(uuid4()),digest))
        db.execute("CREATE FUNCTION schedule_test_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='AUTOMATION_CREATED' THEN PERFORM pg_sleep(0.4); END IF; RETURN NEW; END $$")
        db.execute("CREATE TRIGGER schedule_test_delay BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION schedule_test_delay()")
    try:
        with pytest.raises(AuthenticationRequired):
            asyncio.run(PostgresAutomations(seed["dsn"]).create(token,command(seed)))
        with psycopg.connect(seed["dsn"]) as db:
            assert db.execute("SELECT count(*) FROM automations WHERE channel_id=%s", (seed["channel"],)).fetchone() == (0,)
            assert db.execute("SELECT count(*) FROM run_events WHERE channel_id=%s", (seed["channel"],)).fetchone() == (0,)
    finally:
        with psycopg.connect(seed["dsn"]) as db:
            db.execute("DROP TRIGGER schedule_test_delay ON run_events")
            db.execute("DROP FUNCTION schedule_test_delay()")
            db.execute("DELETE FROM auth_sessions WHERE token_digest=%s", (digest,))


def test_due_batch_is_ten_and_completed_run_allows_next_occurrence(seed):
    async def check():
        store = PostgresAutomations(seed["dsn"])
        schedules = [await store.create(seed["token"],command(seed)) for _ in range(12)]
        for schedule in schedules:
            make_due(seed,schedule["id"])
        first = await store.submit_due()
        second = await store.submit_due()
        assert len(first) == 10 and len(second) == 2
        results = first+second
        assert len({row["message"]["createdAt"] for row in results}) == 12
        with psycopg.connect(seed["dsn"]) as db:
            db.execute("UPDATE runs SET status='completed' WHERE channel_id=%s", (seed["channel"],))
        make_due(seed,schedules[0]["id"])
        again = await store.submit_due()
        assert len(again) == 1 and again[0]["run"]["id"] not in {row["run"]["id"] for row in results}
    asyncio.run(check())


def test_first_occurrence_and_membership_bounds_leave_no_schedule(seed):
    async def check():
        store = PostgresAutomations(seed["dsn"])
        for delta in (timedelta(days=-1),timedelta(days=367)):
            first = (datetime.now(timezone.utc)+delta).isoformat().replace("+00:00","Z")
            with pytest.raises(ControlError) as error:
                await store.create(seed["token"],command(seed,firstRunAt=first))
            assert error.value.code == "automation_first_run_out_of_range"
        with pytest.raises(ControlError) as error:
            await store.create(seed["token"],command(seed,botId=str(uuid4())))
        assert error.value.code == "automation_bot_not_member"
        with psycopg.connect(seed["dsn"]) as db:
            assert db.execute("SELECT count(*) FROM automations WHERE channel_id=%s", (seed["channel"],)).fetchone() == (0,)
    asyncio.run(check())
