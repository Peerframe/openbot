"""Contract and real PostgreSQL checks for the retained Employee knowledge behavior."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb
import pytest
from pydantic import ValidationError

from openbot_server.authority import AuthenticationRequired
from openbot_server.control_errors import ControlError
from openbot_server.database import StoreUnavailable
from openbot_server.employee_knowledge import PostgresEmployeeKnowledge, _merge_evidence
from openbot_server.employee_knowledge_inputs import (
    parse_memory_create, parse_memory_delete, parse_memory_update, parse_proposal_review,
    parse_skill_create, parse_skill_document, parse_skill_state, sensitive_text,
)

DOCUMENT = "---\nname: evidence-report\ndescription: Prepare a source-backed report\nlicense: MIT\nmetadata:\n  author: Owner\nallowed-tools: read_public_page write_report\n---\nRead sources and identify uncertainty.\n"
MEMORY = {"kind": "semantic", "title": "Checked fact", "content": "Synthetic content", "sensitivity": "internal", "portability": "never"}


def test_skill_parser_preserves_source_and_binds_digest():
    parsed = parse_skill_document(DOCUMENT)
    assert parsed["markdown"] == DOCUMENT
    assert parsed["sha256"] == hashlib.sha256(DOCUMENT.encode()).hexdigest()
    assert parsed["metadata"] == {"author": "Owner"}
    assert parse_skill_document(DOCUMENT.replace("\n", "\r\n")) == parsed
    assert parse_skill_document(DOCUMENT + "Change.")["sha256"] != parsed["sha256"]


@pytest.mark.parametrize("header", [
    "name: &anchor evidence-report\ndescription: *anchor",
    "name: evidence-report\nname: duplicate\ndescription: Test",
    "name: !!str evidence-report\ndescription: Test",
    "name: evidence-report\ndescription: Test\nunknown: value",
    "name: evidence-report\ndescription: Test\nmetadata:\n  number: 12",
    "name: Bad--Name\ndescription: Test", "%YAML 1.2\nname: evidence-report\ndescription: Test",
    "name: evidence-report\ndescription: [not, text]",
    "name: evidence-report\ndescription: Test\nallowed-tools: [Bash]",
])
def test_skill_parser_rejects_ambiguous_yaml(header):
    with pytest.raises(ControlError, match="invalid_skill_document"):
        parse_skill_document(f"---\n{header}\n---\nBody")


@pytest.mark.parametrize("source", [DOCUMENT + "界" * 4096, DOCUMENT + '"' * 8000,
    DOCUMENT.replace("Prepare", "x" * 4096), DOCUMENT.replace("name:", "\x01name:"),
    "---\nname: test\ndescription: Test\n---\n "])
def test_skill_parser_refuses_transfer_and_control_overflow(source):
    with pytest.raises(ControlError):
        parse_skill_document(source)


@pytest.mark.parametrize("value", ["-----BEGIN PRIVATE KEY-----", "ghp_" + "a" * 24,
    "sk-proj-" + "x" * 24, "api_key = not-a-real-secret", "Bearer abcdefghijklmn",
    "password\u00a0=\u00a0synthetic-secret"])
def test_credentials_refused_for_memories_and_skill_files(value):
    assert sensitive_text(value)
    with pytest.raises(ControlError, match="memory_sensitive_content"):
        parse_memory_create({**MEMORY, "content": value})
    with pytest.raises(ControlError):
        parse_skill_document(DOCUMENT + value)


def test_input_omission_review_and_memory_policy():
    assert parse_memory_create(MEMORY).modelUseEnabled is None
    assert parse_memory_create({**MEMORY, "title": "\ufeff  中文  ", "modelUseEnabled": False}).title == "中文"
    for invalid in ({**MEMORY, "modelUseEnabled": None}, {**MEMORY, "extra": 1}):
        with pytest.raises(ValidationError):
            parse_memory_create(invalid)
    with pytest.raises(ControlError):
        parse_memory_create({**MEMORY, "modelUseEnabled": True, "sensitivity": "confidential"})
    with pytest.raises(ControlError):
        parse_memory_create({**MEMORY, "kind": "secret-reference", "sensitivity": "internal"})
    assert parse_memory_create({**MEMORY, "kind": "secret-reference", "sensitivity": "restricted", "content": "vault://item/reference"})
    with pytest.raises(ValidationError):
        parse_memory_update({"expectedRevision": 1})
    for value in (1, False, "true"):
        with pytest.raises(ValidationError):
            parse_memory_delete({"expectedRevision": 1, "ownerReviewed": value})
    assert parse_memory_delete({"expectedRevision": 1.0, "ownerReviewed": True}).expectedRevision == 1
    with pytest.raises(ValidationError):
        parse_proposal_review({"decision": "reject", "ownerReviewed": True, "content": "hidden"})
    with pytest.raises(ValidationError):
        parse_skill_state({"state": "suspended", "reason": "Review", "ownerReviewed": True, "confidence": 50})


def test_evidence_latest_reference_wins_and_bound_is_64():
    existing = [{"kind": "manual", "id": str(index)} for index in range(70)]
    merged = _merge_evidence(existing, [{"kind": "manual", "id": "6", "label": "Reviewed"}])
    assert len(merged) == 64 and merged[-1] == {"kind": "manual", "id": "6", "label": "Reviewed"}
    assert merged[0]["id"] == "7"


def test_skill_creation_defaults_deduplicate_and_validate_before_transform():
    value = {"slug": "review", "name": "Review", "description": "Review text", "version": "1.2.3", "source": "manual", "reason": "Add"}
    assert parse_skill_create(value).requiredCapabilities == []
    assert parse_skill_create({**value, "requiredCapabilities": ["shell", "browser", "shell"]}).requiredCapabilities == ["browser", "shell"]
    with pytest.raises(ValidationError):
        parse_skill_create({**value, "requiredCapabilities": ["shell"] * 65})


@pytest.fixture(scope="module")
def knowledge_fixture():
    source = os.environ.get("OPENBOT_CONTROL_TEST_FIXTURE")
    if not source:
        pytest.skip("Requires the owned synthetic PostgreSQL fixture")
    value = json.loads(Path(source).read_text())
    parsed = urlparse(value["dsn"])
    assert parsed.hostname == "127.0.0.1" and parsed.path.startswith("/openbot_control_test_")
    return value


def employee(fixture):
    bot_id = str(uuid4())
    with psycopg.connect(fixture["dsn"]) as connection:
        connection.execute("INSERT INTO bots(id,name,role) VALUES (%s,%s,'Knowledge test')", (bot_id, "Knowledge " + bot_id))
    return bot_id


def invoke(fixture, method, *args):
    return asyncio.run(getattr(PostgresEmployeeKnowledge(fixture["dsn"]), method)(fixture["token"], *args))


def proposal(fixture, bot_id):
    run_id, proposal_id = str(uuid4()), str(uuid4())
    with psycopg.connect(fixture["dsn"]) as connection:
        connection.execute("INSERT INTO runs(id,bot_id,channel_id,instruction,title,status) VALUES (%s,%s,%s,'Synthesize','Synthetic task','completed')", (run_id, bot_id, fixture["channelId"]))
        connection.execute("INSERT INTO knowledge_proposals(id,bot_id,source_run_id,kind,title,content) VALUES (%s,%s,%s,'semantic','Candidate fact','Candidate content')", (proposal_id, bot_id, run_id))
    return proposal_id, run_id


def test_memory_cas_policy_audit_and_delete(knowledge_fixture):
    f = knowledge_fixture
    bot = employee(f)
    created = invoke(f, "create_memory", bot, {**MEMORY, "modelUseEnabled": True})
    memory = created["memory"]
    assert memory["modelUseEnabled"] is True and memory["provenance"] == {"source": "owner", "actor": "owner"}
    assert created["event"]["changedFields"][-1] == "modelUseEnabled"
    with pytest.raises(ControlError, match="memory_model_use_forbidden"):
        invoke(f, "update_memory", bot, memory["id"], {"expectedRevision": 1, "sensitivity": "confidential"})
    updated = invoke(f, "update_memory", bot, memory["id"], {"expectedRevision": 1, "sensitivity": "confidential", "modelUseEnabled": False})
    assert updated["memory"]["revision"] == 2
    assert updated["event"]["changedFields"] == ["sensitivity", "modelUseEnabled"]
    with pytest.raises(ControlError, match="memory_revision_conflict"):
        invoke(f, "delete_memory", bot, memory["id"], {"expectedRevision": 1, "ownerReviewed": True})
    deleted = invoke(f, "delete_memory", bot, memory["id"], {"expectedRevision": 2, "ownerReviewed": True})
    assert deleted["event"]["revision"] == 3 and deleted["event"]["changedFields"] == []
    with psycopg.connect(f["dsn"]) as connection:
        assert connection.execute("SELECT count(*) FROM employee_memories WHERE id=%s", (memory["id"],)).fetchone()[0] == 0
        rows = connection.execute("SELECT changed_fields FROM employee_memory_events WHERE memory_id=%s", (memory["id"],)).fetchall()
        assert len(rows) == 3 and "Synthetic content" not in json.dumps(rows)


def test_competing_memory_edits_have_single_revision_winner(knowledge_fixture):
    f = knowledge_fixture
    bot = employee(f)
    memory = invoke(f, "create_memory", bot, MEMORY)["memory"]
    async def edits():
        store = PostgresEmployeeKnowledge(f["dsn"])
        return await asyncio.gather(*(store.update_memory(f["token"], bot, memory["id"], {"expectedRevision": 1, "title": title}) for title in ("First", "Second")), return_exceptions=True)
    results = asyncio.run(edits())
    assert sum(isinstance(result, ControlError) and result.status == 409 for result in results) == 1
    assert sum(isinstance(result, dict) and result["memory"]["revision"] == 2 for result in results) == 1
    with psycopg.connect(f["dsn"]) as connection:
        assert connection.execute("SELECT count(*) FROM employee_memory_events WHERE memory_id=%s", (memory["id"],)).fetchone()[0] == 2


def test_memory_audit_failure_rolls_back_write(knowledge_fixture):
    f = knowledge_fixture
    bot = employee(f)
    with psycopg.connect(f["dsn"]) as connection:
        connection.execute("CREATE FUNCTION knowledge_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic private error'; END $$")
        connection.execute("CREATE TRIGGER knowledge_test_reject BEFORE INSERT ON employee_memory_events FOR EACH ROW EXECUTE FUNCTION knowledge_test_reject()")
    try:
        with pytest.raises(StoreUnavailable, match="employee_knowledge_storage_unavailable"):
            invoke(f, "create_memory", bot, MEMORY)
        with psycopg.connect(f["dsn"]) as connection:
            assert connection.execute("SELECT count(*) FROM employee_memories WHERE bot_id=%s", (bot,)).fetchone()[0] == 0
    finally:
        with psycopg.connect(f["dsn"]) as connection:
            connection.execute("DROP TRIGGER knowledge_test_reject ON employee_memory_events")
            connection.execute("DROP FUNCTION knowledge_test_reject()")


def test_skill_digest_review_revocation_and_definition_conflict(knowledge_fixture):
    f = knowledge_fixture
    bot = employee(f)
    slug = "skill-" + uuid4().hex
    document = DOCUMENT.replace("evidence-report", slug)
    result = invoke(f, "import_skill", bot, {"markdown": document, "version": "1.0.0", "reason": "Import synthetic instructions"})
    skill = result["skill"]
    assert skill["state"] == "candidate" and skill["modelUseEnabled"] is False
    with pytest.raises(ControlError, match="skill_digest_review_required"):
        invoke(f, "set_skill_state", bot, skill["id"], {"state": "verified", "confidence": 80, "reason": "Reviewed", "ownerReviewed": True})
    verified = invoke(f, "set_skill_state", bot, skill["id"], {"state": "verified", "confidence": 80, "reason": "Reviewed", "ownerReviewed": True, "reviewedContentSha256": skill["contentSha256"]})
    assert verified["skill"]["modelUseEnabled"] is True
    for state in ("suspended", "revoked"):
        result = invoke(f, "set_skill_state", bot, skill["id"], {"state": state, "reason": "Stop", "ownerReviewed": True})
        assert result["skill"]["modelUseEnabled"] is False and result["skill"]["confidence"] == 80
    with pytest.raises(ControlError, match="skill_state_conflict"):
        invoke(f, "set_skill_state", bot, skill["id"], {"state": "verified", "confidence": 80, "reason": "Again", "ownerReviewed": True, "reviewedContentSha256": skill["contentSha256"]})
    with pytest.raises(ControlError, match="skill_definition_conflict"):
        invoke(f, "import_skill", employee(f), {"markdown": document + "Changed.", "version": "1.0.0", "reason": "Conflict"})
    with psycopg.connect(f["dsn"]) as connection:
        assert connection.execute("SELECT revision,reviewed_content_sha256 FROM employee_skills WHERE bot_id=%s AND skill_id=%s", (bot, skill["id"])).fetchone() == (4, None)
        assert connection.execute("SELECT count(*) FROM employee_evolution_events WHERE bot_id=%s", (bot,)).fetchone()[0] == 4


def test_skill_dependency_requires_assigned_verified_source(knowledge_fixture):
    f = knowledge_fixture
    bot = employee(f)
    value = {"slug": "dependency-" + uuid4().hex, "name": "Dependency", "description": "Metadata-only skill", "version": "1.0.0", "source": "learned", "reason": "Candidate"}
    dependency = invoke(f, "create_skill", bot, value)["skill"]
    child = {**value, "slug": "child-" + uuid4().hex, "dependencySkillIds": [dependency["id"]]}
    with pytest.raises(ControlError, match="skill_dependencies_not_verified"):
        invoke(f, "create_skill", bot, child)
    invoke(f, "set_skill_state", bot, dependency["id"], {"state": "verified", "confidence": 60, "reason": "Reviewed", "ownerReviewed": True})
    added = invoke(f, "create_skill", bot, child)["skill"]
    assert added["dependencyIds"] == [dependency["id"]] and added["state"] == "candidate" and "modelUseEnabled" not in added
    invoke(f, "set_skill_state", bot, dependency["id"], {"state": "suspended", "reason": "Pause", "ownerReviewed": True})
    with pytest.raises(ControlError, match="skill_dependencies_not_verified"):
        invoke(f, "set_skill_state", bot, added["id"], {"state": "verified", "confidence": 60, "reason": "Reviewed", "ownerReviewed": True})


def test_proposals_are_candidates_review_uses_owner_text_and_clears_draft(knowledge_fixture):
    f = knowledge_fixture
    bot = employee(f)
    proposal_id, run_id = proposal(f, bot)
    assert invoke(f, "proposals", bot)[0]["content"] == "Candidate content"
    assert invoke(f, "profile", bot)["memories"] == []
    result = invoke(f, "review_proposal", bot, proposal_id, {"decision": "accept", "ownerReviewed": True, "title": "Edited fact", "content": "Owner corrected content", "modelUseEnabled": False})
    with psycopg.connect(f["dsn"]) as connection:
        assert connection.execute("SELECT status,title,content FROM knowledge_proposals WHERE id=%s", (proposal_id,)).fetchone() == ("accepted", "", "")
        row = connection.execute("SELECT title,content,model_use_enabled,portability,provenance FROM employee_memories WHERE id=%s", (result["memoryId"],)).fetchone()
        assert row[:4] == ("Edited fact", "Owner corrected content", False, "never")
        assert row[4] == {"source": "reviewed-agent-proposal", "actor": "owner", "proposalId": proposal_id, "sourceRunId": run_id}
        audit = connection.execute("SELECT payload FROM run_events WHERE run_id=%s AND type='KNOWLEDGE_PROPOSAL_REVIEWED'", (run_id,)).fetchone()[0]
        assert "content" not in audit and audit["memoryId"] == result["memoryId"]
    assert invoke(f, "proposals", bot) == []
    with pytest.raises(ControlError, match="knowledge_proposal_already_reviewed"):
        invoke(f, "review_proposal", bot, proposal_id, {"decision": "reject", "ownerReviewed": True})
    other, _ = proposal(f, bot)
    rejected = invoke(f, "review_proposal", bot, other, {"decision": "reject", "ownerReviewed": True})
    assert rejected["memoryId"] is None


def test_proposal_reject_and_accept_race_has_one_decision(knowledge_fixture):
    f = knowledge_fixture
    bot = employee(f)
    proposal_id, _ = proposal(f, bot)
    async def review():
        store = PostgresEmployeeKnowledge(f["dsn"])
        return await asyncio.gather(store.review_proposal(f["token"], bot, proposal_id, {"decision": "reject", "ownerReviewed": True}), store.review_proposal(f["token"], bot, proposal_id, {"decision": "accept", "ownerReviewed": True, "title": "Accepted", "content": "Reviewed", "modelUseEnabled": True}), return_exceptions=True)
    results = asyncio.run(review())
    assert sum(isinstance(result, ControlError) and result.status == 409 for result in results) == 1
    with psycopg.connect(f["dsn"]) as connection:
        assert connection.execute("SELECT count(*) FROM run_events WHERE payload->>'proposalId'=%s", (proposal_id,)).fetchone()[0] == 1


def test_profile_includes_all_retained_records_without_storage_internals(knowledge_fixture):
    f = knowledge_fixture
    bot = employee(f)
    proposal_id, run = proposal(f, bot)
    invoke(f, "create_memory", bot, MEMORY)
    skill = invoke(f, "create_skill", bot, {"slug": "profile-" + uuid4().hex, "name": "Projection", "description": "Profile skill", "version": "1.0.0", "source": "manual", "reason": "Add"})["skill"]
    node, approval, artifact, progress = [str(uuid4()) for _ in range(4)]
    with psycopg.connect(f["dsn"]) as connection:
        connection.execute("INSERT INTO nodes(id,name,platform) VALUES (%s,'Synthetic node','linux')", (node,))
        connection.execute("INSERT INTO approvals(id,run_id,node_id,action,target,summary,risk,target_fingerprint,expires_at) VALUES (%s,%s,%s,'Write','Synthetic target','Owner approval','write',%s,clock_timestamp()+interval '1 hour')", (approval, run, node, "a" * 64))
        connection.execute("INSERT INTO artifacts(id,run_id,name,media_type,storage_key,sha256,metadata) VALUES (%s,%s,'report.txt','text/plain',%s,%s,%s)", (artifact, run, "private-storage-" + artifact, "b" * 64, Jsonb({"sizeBytes": 99, "private": "not-public"})))
        connection.execute("INSERT INTO run_events(id,run_id,bot_id,channel_id,type,payload) VALUES (%s,%s,%s,%s,'RUN_PROGRESS',%s)", (progress, run, bot, f["channelId"], Jsonb({"stage": "completed", "message": "Evidence checked", "private": "never-publish"})))
    result = invoke(f, "profile", bot)
    assert result["employee"]["id"] == bot and result["details"]["revision"] == 1
    assert result["skills"][0]["id"] == skill["id"] and result["evolution"][0]["type"] == "skill_discovered"
    assert len(result["memories"]) == 1 and len(result["memoryEvents"]) == 1
    assert result["records"]["runs"][0]["id"] == run
    assert result["records"]["approvals"][0]["id"] == approval
    assert result["records"]["artifacts"][0]["sizeBytes"] == 99
    assert result["records"]["decisions"][0]["summary"] == "Evidence checked"
    assert result["statistics"] == {"totalRuns": 1, "completedRuns": 1, "failedRuns": 0, "verifiedSkills": 0}
    assert result["configuration"]["portabilityFormat"] == "openbot.employee/v1"
    encoded = json.dumps(result)
    assert "private-storage" not in encoded and "never-publish" not in encoded and "not-public" not in encoded


def test_profile_bounds_transfer_and_run_window(knowledge_fixture):
    f = knowledge_fixture
    bot = employee(f)
    with psycopg.connect(f["dsn"]) as connection:
        for number in range(55):
            connection.execute("INSERT INTO runs(id,bot_id,channel_id,instruction,title,status) VALUES (%s,%s,%s,'Synthetic task',%s,'completed')", (str(uuid4()), bot, f["channelId"], str(number)))
    assert invoke(f, "profile", bot)["statistics"]["totalRuns"] == 50
    try:
        with psycopg.connect(f["dsn"]) as connection:
            connection.execute("UPDATE runs SET instruction=repeat('x',4194305) WHERE id=(SELECT id FROM runs WHERE bot_id=%s ORDER BY created_at DESC,id DESC LIMIT 1)", (bot,))
        with pytest.raises(StoreUnavailable, match="employee_knowledge_projection_limit"):
            invoke(f, "profile", bot)
    finally:
        with psycopg.connect(f["dsn"]) as connection:
            connection.execute("UPDATE runs SET instruction='Synthetic task' WHERE bot_id=%s", (bot,))


@pytest.mark.parametrize("state", ["revoked", "expired"])
def test_owner_session_revocation_and_expiry_guard_reads_and_writes(knowledge_fixture, state):
    f = knowledge_fixture
    bot = employee(f)
    token = uuid4().hex + uuid4().hex[:11]
    with psycopg.connect(f["dsn"]) as connection:
        connection.execute("INSERT INTO auth_sessions(id,token_digest,expires_at,revoked_at) VALUES (%s,%s,clock_timestamp()+interval '1 hour',NULL)", (str(uuid4()), hashlib.sha256(token.encode()).hexdigest()))
        if state == "revoked":
            connection.execute("UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE token_digest=%s", (hashlib.sha256(token.encode()).hexdigest(),))
        else:
            connection.execute("UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_digest=%s", (hashlib.sha256(token.encode()).hexdigest(),))
    store = PostgresEmployeeKnowledge(f["dsn"])
    with pytest.raises(AuthenticationRequired):
        asyncio.run(store.profile(token, bot))
    with pytest.raises(AuthenticationRequired):
        asyncio.run(store.create_memory(token, bot, MEMORY))


def test_skill_evolution_failure_rolls_back_definition_and_assignment(knowledge_fixture):
    f = knowledge_fixture
    bot = employee(f)
    slug = "rollback-" + uuid4().hex
    with psycopg.connect(f["dsn"]) as connection:
        connection.execute("CREATE FUNCTION knowledge_test_evolution_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic private error'; END $$")
        connection.execute("CREATE TRIGGER knowledge_test_evolution_reject BEFORE INSERT ON employee_evolution_events FOR EACH ROW EXECUTE FUNCTION knowledge_test_evolution_reject()")
    try:
        with pytest.raises(StoreUnavailable):
            invoke(f, "create_skill", bot, {"slug": slug, "name": "Rollback", "description": "Synthetic", "version": "1.0.0", "source": "manual", "reason": "Add"})
        with psycopg.connect(f["dsn"]) as connection:
            assert connection.execute("SELECT count(*) FROM skills WHERE slug=%s", (slug,)).fetchone()[0] == 0
            assert connection.execute("SELECT count(*) FROM employee_skills WHERE bot_id=%s", (bot,)).fetchone()[0] == 0
    finally:
        with psycopg.connect(f["dsn"]) as connection:
            connection.execute("DROP TRIGGER knowledge_test_evolution_reject ON employee_evolution_events")
            connection.execute("DROP FUNCTION knowledge_test_evolution_reject()")


def test_proposal_audit_failure_preserves_pending_text_and_creates_no_memory(knowledge_fixture):
    f = knowledge_fixture
    bot = employee(f)
    proposal_id, _ = proposal(f, bot)
    with psycopg.connect(f["dsn"]) as connection:
        connection.execute("CREATE FUNCTION knowledge_test_review_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='KNOWLEDGE_PROPOSAL_REVIEWED' THEN RAISE EXCEPTION 'synthetic private error'; END IF; RETURN NEW; END $$")
        connection.execute("CREATE TRIGGER knowledge_test_review_reject BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION knowledge_test_review_reject()")
    try:
        with pytest.raises(StoreUnavailable):
            invoke(f, "review_proposal", bot, proposal_id, {"decision": "accept", "ownerReviewed": True, "title": "Owner fact", "content": "Reviewed content", "modelUseEnabled": True})
        with psycopg.connect(f["dsn"]) as connection:
            assert connection.execute("SELECT status,content FROM knowledge_proposals WHERE id=%s", (proposal_id,)).fetchone() == ("pending", "Candidate content")
            assert connection.execute("SELECT count(*) FROM employee_memories WHERE bot_id=%s", (bot,)).fetchone()[0] == 0
            assert connection.execute("SELECT count(*) FROM employee_memory_events WHERE bot_id=%s", (bot,)).fetchone()[0] == 0
    finally:
        with psycopg.connect(f["dsn"]) as connection:
            connection.execute("DROP TRIGGER knowledge_test_review_reject ON run_events")
            connection.execute("DROP FUNCTION knowledge_test_review_reject()")


def test_session_expiring_during_audit_rolls_back_memory_at_commit(knowledge_fixture):
    f = knowledge_fixture
    bot = employee(f)
    token = uuid4().hex + uuid4().hex[:11]
    with psycopg.connect(f["dsn"]) as connection:
        connection.execute("CREATE FUNCTION knowledge_test_slow_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.6); RETURN NEW; END $$")
        connection.execute("CREATE TRIGGER knowledge_test_slow_audit BEFORE INSERT ON employee_memory_events FOR EACH ROW EXECUTE FUNCTION knowledge_test_slow_audit()")
        connection.execute("INSERT INTO auth_sessions(id,token_digest,expires_at) VALUES (%s,%s,clock_timestamp()+interval '0.4 second')", (str(uuid4()), hashlib.sha256(token.encode()).hexdigest()))
    try:
        with pytest.raises(AuthenticationRequired):
            asyncio.run(PostgresEmployeeKnowledge(f["dsn"]).create_memory(token, bot, MEMORY))
        with psycopg.connect(f["dsn"]) as connection:
            assert connection.execute("SELECT count(*) FROM employee_memories WHERE bot_id=%s", (bot,)).fetchone()[0] == 0
            assert connection.execute("SELECT count(*) FROM employee_memory_events WHERE bot_id=%s", (bot,)).fetchone()[0] == 0
    finally:
        with psycopg.connect(f["dsn"]) as connection:
            connection.execute("DROP TRIGGER knowledge_test_slow_audit ON employee_memory_events")
            connection.execute("DROP FUNCTION knowledge_test_slow_audit()")
