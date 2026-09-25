"""Portable bytes/DSSE parity and real PostgreSQL import authority tests."""
import asyncio
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
from urllib.parse import urlparse
from uuid import uuid4

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
import psycopg
import pytest
from pydantic import ValidationError

from openbot_server.authority import AuthenticationRequired
from openbot_server.control_errors import ControlError
from openbot_server.database import StoreUnavailable
from openbot_server.employee_knowledge import PostgresEmployeeKnowledge
from openbot_server.employee_knowledge_inputs import parse_skill_document
from openbot_server.employee_portability import PostgresEmployeePortability
from openbot_server.employee_portability_format import (
    build_template, checksum_valid, digest, inspect_template, key_id, pae, portable_file_stem,
    prepare_export, serialize_package, sign_envelope, verify_envelope,
)
from openbot_server.employee_portability_inputs import EmployeePackage
from openbot_server.employee_portability_publisher import EmployeePublisher

STAMP = "2026-09-24T00:00:00.000Z"


def profile(name="Portable Employee", content=False):
    markdown = "---\nname: report-evidence\ndescription: Check public facts\nlicense: MIT\n---\nCite the supplied evidence.\n"
    parsed = parse_skill_document(markdown)
    skill = {"id": str(uuid4()), "slug": "report-evidence", "name": "Evidence Report", "description": "Check public facts", "version": "1.0.0",
             "source": "manual", "state": "verified", "confidence": 80, "requiredCapabilities": [], "dependencyIds": [],
             "evidence": [{"kind": "manual", "id": "private-evidence"}], "acquiredAt": STAMP, "updatedAt": STAMP}
    if content:
        skill.update(skillMarkdown=markdown, contentSha256=parsed["sha256"], modelUseEnabled=True)
    return {"employee": {"id": str(uuid4()), "name": name, "role": "Evidence assistant", "computerProfile": "none", "status": "idle", "createdAt": STAMP},
        "details": {"description": "A source-backed assistant 中文 🧪", "revision": 1, "updatedAt": STAMP},
        "skills": [skill], "memories": [{"content": "private-memory"}], "evolution": [{}], "memoryEvents": [],
        "records": {"runs": [{}], "approvals": [{}], "artifacts": [{}], "decisions": [{}]}, "configuration": {"executionProfile": "none"}}


def document(content=False):
    source = profile("Portable " + uuid4().hex, content)
    source["skills"][0]["slug"] = "skill-" + uuid4().hex
    if content:
        source["skills"][0]["skillMarkdown"] = source["skills"][0]["skillMarkdown"].replace("report-evidence", source["skills"][0]["slug"])
        source["skills"][0]["contentSha256"] = parse_skill_document(source["skills"][0]["skillMarkdown"])["sha256"]
    return build_template(source, include_skill_content=content)["document"]


def publisher():
    private = Ed25519PrivateKey.generate()
    identity = key_id(private.public_key())
    return EmployeePublisher(identity, private, [{"keyid": identity, "publicKey": private.public_key()}])


def test_template_excludes_identity_authority_memory_history_and_unverified_skills():
    source = profile(content=True)
    source["skills"].append({**source["skills"][0], "id": str(uuid4()), "slug": "pending", "state": "candidate"})
    result = prepare_export(source)
    encoded = result["body"]
    assert len(result["document"]["payload"]["skills"]) == 1
    assert "private-evidence" not in encoded and "private-memory" not in encoded and source["employee"]["id"] not in encoded
    assert "content" not in result["document"]["payload"]["skills"][0]
    assert checksum_valid(result["document"])
    assert result["preview"]["downloadReviewToken"] == hashlib.sha256(encoded.encode()).hexdigest()
    assert result["preview"]["includedMemoryCount"] == 0
    assert result["preview"]["exclusions"][-1]["count"] == 5


@pytest.mark.parametrize("name,expected", [("CON", "con-employee"), ("LPT9", "lpt9-employee"), ("AUX", "aux-employee"),
    ("../../Report.EXE", "report-exe"), ("中文", "employee"), ("Évidence", "e-vidence")])
def test_advisory_filename_safety(name, expected):
    assert portable_file_stem(name) == expected


def test_content_review_license_checksum_and_bundle_guards():
    source = profile(content=True)
    assert build_template(source, include_skill_content=True)["preview"]["blocked"] is False
    for mutation in ("digest", "review", "license", "bundle"):
        changed = deepcopy(source)
        skill = changed["skills"][0]
        if mutation == "digest":
            skill["contentSha256"] = "0" * 64
        elif mutation == "review":
            skill["modelUseEnabled"] = False
        else:
            skill["skillMarkdown"] = skill["skillMarkdown"].replace("license: MIT", "license: Proprietary") if mutation == "license" else skill["skillMarkdown"] + "Read references/local.md.\n"
            skill["contentSha256"] = parse_skill_document(skill["skillMarkdown"])["sha256"]
        result = build_template(changed, include_skill_content=True)
        assert result["preview"]["blocked"] and result["preview"]["findings"][0]["code"] == "invalid-skill-content"


def test_scan_and_dependency_closure_block_before_signer():
    source = profile()
    source["details"]["description"] = "Read /Users/private/file"
    source["skills"][0]["dependencyIds"] = [str(uuid4())]
    signer = publisher()
    signer.sign = lambda _: pytest.fail("blocked export invoked signer")
    result = prepare_export(source, publisher=signer)
    assert {finding["code"] for finding in result["preview"]["findings"]} == {"excluded-skill-dependency", "local-path-content"}
    assert result["preview"]["blocked"]


def test_quarantine_checks_all_content_integrity_capability_and_host_requirements():
    doc = document()
    payload = doc["payload"]
    skill = payload["skills"][0]
    payload["skills"].append(deepcopy(skill))
    skill["dependencySlugs"] = ["missing"]
    skill["requiredCapabilities"] = ["cua"]
    payload["employee"]["description"] = "password: synthetic-secret"
    payload["configuration"]["recommendedExecutionProfile"] = "macos-cua"
    preview = inspect_template(doc, [])
    assert preview["quarantine"]["active"] and not preview["quarantine"]["canActivate"]
    assert {issue["code"] for issue in preview["issues"]} == {"duplicate-skill", "missing-skill-dependency", "capability-set-mismatch", "checksum-mismatch", "sensitive-content", "missing-capability", "no-compatible-host"}


def test_connected_host_projection_uses_complete_profile_requirements():
    doc = document()
    doc["payload"]["configuration"]["recommendedExecutionProfile"] = "macos-cua"
    doc["integrity"]["digest"] = digest(doc["payload"])
    node = {"id": "host", "name": "Connected", "platform": "macos", "architecture": "arm64", "deviceClass": "desktop", "capabilities": ["cua", "screenshot"], "capabilityManifest": []}
    preview = inspect_template(doc, [node])
    assert not preview["blocked"] and preview["compatibility"]["compatibleHosts"][0]["id"] == "host"
    assert inspect_template(doc, [{**node, "platform": "linux"}])["blocked"]


def test_dsse_hints_never_grant_trust_and_authenticated_metadata_must_match():
    signer = publisher()
    doc = document(True)
    envelope = signer.sign(doc)
    envelope["signatures"][0]["keyid"] = "wrong-hint"
    assert signer.verify(envelope)["status"] == "verified"
    assert verify_envelope(envelope, []) ["code"] == "no-trusted-signature"
    assert verify_envelope(envelope, [{"keyid": "duplicate", "publicKey": signer._private_key.public_key()}] * 2)["code"] == "invalid-trust-store"
    envelope["payload"] = envelope["payload"][:-4] + "AAAA"
    assert signer.verify(envelope)["code"] == "no-trusted-signature"


def test_dsse_exact_type_checksum_and_metadata_fail_independently():
    import base64
    signer = publisher()
    signed = signer.verify(signer.sign(document()))["document"]
    for failure in ("checksum", "metadata", "media"):
        changed = deepcopy(signed)
        media = "application/vnd.openbot.employee.v1+json"
        if failure == "checksum":
            changed["payload"]["employee"]["role"] = "Changed role"
        elif failure == "metadata":
            changed["payload"]["signature"]["keyid"] = "other"
            changed["integrity"]["digest"] = digest(changed["payload"])
        else:
            media = "application/incorrect"
        raw = serialize_package(changed).encode()
        envelope = {"payload": base64.b64encode(raw).decode(), "payloadType": media,
                    "signatures": [{"sig": base64.b64encode(signer._private_key.sign(pae(media, raw))).decode()}]}
        assert signer.verify(envelope)["code"] == {"checksum": "checksum-mismatch", "metadata": "signature-metadata-mismatch", "media": "unsupported-payload-type"}[failure]


@pytest.fixture(scope="module")
def node_oracle(tmp_path_factory):
    root = Path(os.environ.get("OPENBOT_TS_SOURCE_ROOT", Path(__file__).resolve().parents[3]))
    if not (root / "node_modules/esbuild").exists() or not shutil.which("node"):
        pytest.skip("Cross-language checks require repository npm dependencies and Node")
    output = tmp_path_factory.mktemp("portability-oracle") / "employee-package.cjs"
    build = """const esbuild=require('esbuild'); esbuild.buildSync({entryPoints:[process.argv[1]+'/tests/oracles/legacy-server/src/employee-package.ts'],bundle:true,platform:'node',format:'cjs',outfile:process.argv[2],alias:{'@openbot/protocol':process.argv[1]+'/packages/protocol/src/index.ts','@openbot/domain':process.argv[1]+'/packages/domain/src/index.ts'},logLevel:'silent'});"""
    subprocess.run(["node", "-e", build, str(root), str(output)], cwd=root, check=True, capture_output=True)
    runner = """const fs=require('node:fs');const crypto=require('node:crypto');const api=require(process.argv[1]);const x=JSON.parse(fs.readFileSync(0,'utf8'));let r;if(x.action==='build'){r=api.prepareEmployeeTemplateExport(x.profile,x.options);}else if(x.action==='sign'){r=api.signEmployeeTemplateEnvelope(x.document,{keyid:x.keyid,privateKey:x.privateKey});}else if(x.action==='verify'){r=api.verifyEmployeeTemplateEnvelope(x.envelope,x.trusted);}else{throw Error('bad action')}process.stdout.write(JSON.stringify(r));"""
    def call(value):
        result = subprocess.run(["node", "-e", runner, str(output)], input=json.dumps(value, ensure_ascii=False), text=True, capture_output=True, check=True, cwd=root)
        return json.loads(result.stdout)
    return call


@pytest.mark.parametrize("content", [False, True])
def test_node_python_exact_package_bytes_and_checksums(node_oracle, content):
    source = profile("Évidence 中文 🧪", content)
    identity = str(uuid4())
    actual = prepare_export(source, include_skill_content=content, package_id=identity, generated_at=STAMP)
    expected = node_oracle({"action": "build", "profile": source, "options": {"includeSkillContent": content, "packageId": identity, "generatedAt": STAMP}})
    assert actual == expected


def test_node_python_dsse_signatures_and_mutual_verification(node_oracle):
    signer = publisher()
    private = signer._private_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    public = signer._private_key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    for content in (False, True):
        doc = document(content)
        py_envelope = signer.sign(doc)
        ts_envelope = node_oracle({"action": "sign", "document": doc, "keyid": signer.active_key_id, "privateKey": private})
        assert py_envelope == ts_envelope
        assert signer.verify(ts_envelope)["status"] == "verified"
        assert node_oracle({"action": "verify", "envelope": py_envelope, "trusted": [{"keyid": signer.active_key_id, "publicKey": public}]})["document"] == signer.verify(py_envelope)["document"]


def write_keyring(directory, signer, *, status="active"):
    directory.mkdir(mode=0o700)
    keys = directory / "keys"
    keys.mkdir(mode=0o700)
    password = directory / "password"
    password.write_bytes(b"synthetic-publisher-password\n")
    password.chmod(0o600)
    pem = signer._private_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.BestAvailableEncryption(b"synthetic-publisher-password"))
    private_path = keys / (signer.active_key_id.split(":")[1] + ".key.pem")
    private_path.write_bytes(pem)
    private_path.chmod(0o600)
    manifest = {"version": 1, "activeKeyId": signer.active_key_id, "keys": [{"keyid": signer.active_key_id, "algorithm": "ed25519", "status": status, "createdAt": STAMP,
        "publicKey": signer._private_key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()}]}
    path = directory / "trust.json"
    path.write_text(json.dumps(manifest))
    path.chmod(0o600)
    return password, path, private_path, manifest


def test_encrypted_publisher_keyring_roundtrip_and_protection(tmp_path):
    signer = publisher()
    password, manifest, private, _ = write_keyring(tmp_path / "publisher", signer)
    loaded = EmployeePublisher.load(manifest.parent, password)
    assert loaded.active_key_id == signer.active_key_id
    assert loaded.verify(loaded.sign(document()))["status"] == "verified"
    for path in (password, manifest, private):
        path.chmod(0o644)
        with pytest.raises(ValueError, match="could not be loaded"):
            EmployeePublisher.load(manifest.parent, password)
        path.chmod(0o600)
    password.write_text("wrong-synthetic-password")
    with pytest.raises(ValueError):
        EmployeePublisher.load(manifest.parent, password)


def test_keyring_revoked_key_is_not_trusted_and_symlinks_are_refused(tmp_path):
    signer, old = publisher(), publisher()
    password, path, private, manifest = write_keyring(tmp_path / "publisher", signer)
    manifest["keys"].append({"keyid": old.active_key_id, "algorithm": "ed25519", "status": "revoked", "createdAt": STAMP, "revokedAt": STAMP,
        "publicKey": old._private_key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()})
    path.write_text(json.dumps(manifest))
    loaded = EmployeePublisher.load(path.parent, password)
    assert loaded.verify(old.sign(document()))["code"] == "no-trusted-signature"
    moved = password.with_suffix(".original")
    password.rename(moved)
    password.symlink_to(moved)
    with pytest.raises(ValueError):
        EmployeePublisher.load(path.parent, password)


@pytest.fixture(scope="module")
def db_fixture():
    path = os.environ.get("OPENBOT_CONTROL_TEST_FIXTURE")
    if not path:
        pytest.skip("Requires the owned synthetic PostgreSQL fixture")
    value = json.loads(Path(path).read_text())
    parsed = urlparse(value["dsn"])
    assert parsed.hostname == "127.0.0.1" and parsed.path.startswith("/openbot_control_test_")
    return value


def service(f, signer=None, nodes=None):
    return PostgresEmployeePortability(f["dsn"], publisher=signer, list_nodes=lambda: [] if nodes is None else nodes)


def request(doc, *, package=None, name=None):
    result = {"package": package or doc, "expectedPackageId": doc["payload"]["packageId"], "expectedDigest": digest(doc), "ownerReviewed": True,
              "allowUnsigned": True, "idempotencyKey": str(uuid4())}
    if name:
        result["employeeName"] = name
    return result


def test_real_unsigned_preview_and_activation_replay_quarantine(db_fixture):
    f = db_fixture
    store = service(f)
    doc = document(True)
    preview = asyncio.run(store.import_preview(f["token"], doc))
    assert not preview["blocked"] and preview["quarantine"]["active"]
    with psycopg.connect(f["dsn"]) as connection:
        assert connection.execute("SELECT count(*) FROM employee_import_receipts WHERE package_id=%s", (preview["packageId"],)).fetchone()[0] == 0
    value = request(doc)
    created = asyncio.run(store.activate(f["token"], value))
    replay = asyncio.run(store.activate(f["token"], value))
    assert not created["replayed"] and replay["replayed"] and replay["receipt"] == created["receipt"]
    profile_value = asyncio.run(PostgresEmployeeKnowledge(f["dsn"]).profile(f["token"], created["employee"]["id"]))
    assert profile_value["skills"][0]["state"] == "candidate" and profile_value["skills"][0]["source"] == "imported"
    assert profile_value["skills"][0]["modelUseEnabled"] is False
    assert profile_value["memories"] == [] and profile_value["evolution"][0]["source"] == "import"
    assert created["receipt"]["importedSkillCount"] == 1 and created["receipt"]["signatureStatus"] == "unsigned"
    with psycopg.connect(f["dsn"]) as connection:
        assert connection.execute("SELECT count(*) FROM run_events WHERE bot_id=%s AND type='BOT_IMPORTED'", (created["employee"]["id"],)).fetchone()[0] == 1


def test_real_review_digest_unsigned_and_strict_review_guards(db_fixture):
    f = db_fixture
    store = service(f)
    doc = document()
    value = request(doc)
    for changed, code in (({"expectedDigest": "0" * 64}, "employee_import_preview_changed"), ({"allowUnsigned": False}, "employee_import_unsigned_acceptance_required")):
        with pytest.raises(ControlError, match=code):
            asyncio.run(store.activate(f["token"], {**value, **changed}))
    with pytest.raises(ValidationError):
        asyncio.run(store.activate(f["token"], {**value, "ownerReviewed": 1}))
    doc["payload"]["requestedCapabilities"] = ["unavailable"]
    doc["integrity"]["digest"] = digest(doc["payload"])
    with pytest.raises(ControlError, match="employee_import_blocked"):
        asyncio.run(store.activate(f["token"], request(doc)))


def test_real_idempotency_and_package_lock_concurrency(db_fixture):
    f = db_fixture
    store = service(f)
    doc = document()
    value = request(doc)
    async def activate_same():
        return await asyncio.gather(store.activate(f["token"], value), store.activate(f["token"], value))
    results = asyncio.run(activate_same())
    assert sorted(result["replayed"] for result in results) == [False, True]
    assert results[0]["employee"]["id"] == results[1]["employee"]["id"]
    with pytest.raises(ControlError, match="employee_import_idempotency_conflict"):
        asyncio.run(store.activate(f["token"], {**value, "employeeName": "different"}))
    with pytest.raises(ControlError, match="employee_package_already_activated"):
        asyncio.run(store.activate(f["token"], {**value, "idempotencyKey": str(uuid4())}))


def test_real_signed_activation_records_trusted_publisher_and_refuses_raw_signed_doc(db_fixture):
    f = db_fixture
    signer = publisher()
    store = service(f, signer)
    envelope = signer.sign(document(True))
    signed = signer.verify(envelope)["document"]
    assert asyncio.run(store.import_preview(f["token"], envelope))["signature"] == {"status": "dsse", "trusted": True, "keyid": signer.active_key_id}
    value = request(signed, package=envelope)
    value["allowUnsigned"] = False
    result = asyncio.run(store.activate(f["token"], value))
    assert result["receipt"]["publisherKeyId"] == signer.active_key_id
    with pytest.raises(ControlError, match="invalid_employee_package"):
        asyncio.run(store.import_preview(f["token"], signed))
    with pytest.raises(ControlError, match="employee_publisher_trust_required"):
        asyncio.run(service(f).import_preview(f["token"], envelope))


def test_real_import_preserves_dependencies_and_assignment_provenance(db_fixture):
    f = db_fixture
    store = service(f)
    doc = document()
    first = doc["payload"]["skills"][0]
    dependent = {**deepcopy(first), "slug": "dependent-" + uuid4().hex, "dependencySlugs": [first["slug"]]}
    doc["payload"]["skills"].append(dependent)
    doc["integrity"]["digest"] = digest(doc["payload"])
    first_result = asyncio.run(store.activate(f["token"], request(doc)))
    second = deepcopy(doc)
    second["payload"]["packageId"] = str(uuid4())
    second["integrity"]["digest"] = digest(second["payload"])
    result = asyncio.run(store.activate(f["token"], request(second, name="Reused " + uuid4().hex)))
    assert result["receipt"]["importedSkillCount"] == 2
    with psycopg.connect(f["dsn"]) as connection:
        assert connection.execute("SELECT count(*) FROM skills WHERE slug=ANY(%s)", ([first["slug"], dependent["slug"]],)).fetchone()[0] == 2
        rows = connection.execute("SELECT source,state,reviewed_content_sha256 FROM employee_skills WHERE bot_id=%s", (result["employee"]["id"],)).fetchall()
        assert rows == [("imported", "candidate", None)] * 2


def test_real_import_audit_failure_rolls_back_identity_skill_and_receipt(db_fixture):
    f = db_fixture
    store = service(f)
    doc = document()
    with psycopg.connect(f["dsn"]) as connection:
        connection.execute("CREATE FUNCTION portability_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='BOT_IMPORTED' THEN RAISE EXCEPTION 'synthetic private error'; END IF; RETURN NEW; END $$")
        connection.execute("CREATE TRIGGER portability_test_reject BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION portability_test_reject()")
    try:
        with pytest.raises(StoreUnavailable):
            asyncio.run(store.activate(f["token"], request(doc)))
        with psycopg.connect(f["dsn"]) as connection:
            assert connection.execute("SELECT count(*) FROM bots WHERE name=%s", (doc["payload"]["employee"]["name"],)).fetchone()[0] == 0
            assert connection.execute("SELECT count(*) FROM skills WHERE slug=%s", (doc["payload"]["skills"][0]["slug"],)).fetchone()[0] == 0
            assert connection.execute("SELECT count(*) FROM employee_import_receipts WHERE package_id=%s", (doc["payload"]["packageId"],)).fetchone()[0] == 0
    finally:
        with psycopg.connect(f["dsn"]) as connection:
            connection.execute("DROP TRIGGER portability_test_reject ON run_events")
            connection.execute("DROP FUNCTION portability_test_reject()")


@pytest.mark.parametrize("signed", [False, True])
def test_real_export_review_exact_bytes_and_stale_profile(db_fixture, signed):
    f = db_fixture
    store = service(f, publisher() if signed else None)
    doc = document()
    imported = asyncio.run(store.activate(f["token"], request(doc)))
    bot_id = imported["employee"]["id"]
    preview = asyncio.run(store.export_preview(f["token"], bot_id))
    kwargs = {"package_id": preview["packageId"], "generated_at": preview["generatedAt"], "if_match": '"' + preview["downloadReviewToken"] + '"'}
    downloaded = asyncio.run(store.export(f["token"], bot_id, **kwargs))
    assert hashlib.sha256(downloaded["body"].encode()).hexdigest() == preview["downloadReviewToken"]
    assert downloaded["etag"] == kwargs["if_match"]
    with pytest.raises(ControlError, match="employee_export_review_required"):
        asyncio.run(store.export(f["token"], bot_id, **{**kwargs, "if_match": None}))
    with pytest.raises(ControlError, match="invalid_employee_export_review_tag"):
        asyncio.run(store.export(f["token"], bot_id, **{**kwargs, "if_match": "W/" + kwargs["if_match"]}))
    with psycopg.connect(f["dsn"]) as connection:
        connection.execute("UPDATE bots SET description='Changed reviewed biography' WHERE id=%s", (bot_id,))
    with pytest.raises(ControlError, match="employee_export_changed"):
        asyncio.run(store.export(f["token"], bot_id, **kwargs))


def test_real_owner_and_missing_connected_inventory_fail_closed(db_fixture):
    f = db_fixture
    doc = document()
    with pytest.raises(AuthenticationRequired):
        asyncio.run(service(f).import_preview("x" * 43, doc))
    with pytest.raises(AuthenticationRequired):
        asyncio.run(service(f).activate("x" * 43, request(doc)))
    with pytest.raises(StoreUnavailable, match="portability_node_inventory_unavailable"):
        asyncio.run(PostgresEmployeePortability(f["dsn"]).import_preview(f["token"], doc))


def test_valid_checksum_does_not_approve_changed_instruction_content():
    doc = document(True)
    doc["payload"]["skills"][0]["content"]["markdown"] += "Changed instructions.\n"
    doc["integrity"]["digest"] = digest(doc["payload"])
    preview = inspect_template(doc, [])
    assert preview["integrity"]["valid"] is True
    assert preview["issues"][0]["code"] == "invalid-skill-content" and preview["blocked"]


def test_signed_v1_cannot_smuggle_v2_instruction_content():
    doc = document(True)
    doc["payload"]["format"] = "openbot.employee/v1"
    doc["integrity"]["digest"] = digest(doc["payload"])
    with pytest.raises(ValidationError):
        EmployeePackage.model_validate(doc)


def test_foreign_openbot_fields_cannot_grant_authority():
    doc = document()
    doc["payload"]["employee"]["id"] = str(uuid4())
    with pytest.raises(ValidationError):
        EmployeePackage.model_validate(doc)
    doc = document()
    doc["payload"]["portability"]["authority"] = "owner"
    with pytest.raises(ValidationError):
        EmployeePackage.model_validate(doc)


def test_oversized_portable_content_blocks_before_signature():
    source = profile(content=True)
    source["skills"][0]["skillMarkdown"] += "x" * 11000
    source["skills"][0]["contentSha256"] = parse_skill_document(source["skills"][0]["skillMarkdown"])["sha256"]
    source["skills"] = [{**source["skills"][0], "id": str(uuid4())} for _ in range(100)]
    result = build_template(source, include_skill_content=True)
    assert result["preview"]["findings"][-1]["code"] == "package-too-large"
    assert result["preview"]["blocked"]


def test_node_encrypted_pkcs8_key_loads_in_python(tmp_path):
    if not shutil.which("node"):
        pytest.skip("Node required for encrypted key interoperability")
    source = """const c=require('node:crypto');const r=c.generateKeyPairSync('ed25519',{privateKeyEncoding:{type:'pkcs8',format:'pem',cipher:'aes-256-cbc',passphrase:'synthetic-publisher-password'},publicKeyEncoding:{type:'spki',format:'pem'}});process.stdout.write(JSON.stringify(r));"""
    result = subprocess.run(["node", "-e", source], capture_output=True, text=True, check=True)
    pair = json.loads(result.stdout)
    public = serialization.load_pem_public_key(pair["publicKey"].encode())
    identity = key_id(public)
    directory = tmp_path / "node-publisher"
    directory.mkdir(mode=0o700)
    (directory / "keys").mkdir(mode=0o700)
    password = directory / "password"
    password.write_text("synthetic-publisher-password\n")
    private = directory / "keys" / (identity.split(":")[1] + ".key.pem")
    private.write_text(pair["privateKey"])
    manifest = directory / "trust.json"
    manifest.write_text(json.dumps({"version": 1, "activeKeyId": identity, "keys": [{"keyid": identity, "algorithm": "ed25519", "status": "active", "createdAt": STAMP, "publicKey": pair["publicKey"]}]}))
    for path in (password, private, manifest):
        path.chmod(0o600)
    loaded = EmployeePublisher.load(directory, password)
    assert loaded.verify(loaded.sign(document()))["status"] == "verified"


def test_real_conflicting_skill_definition_rolls_back_imported_identity(db_fixture):
    f = db_fixture
    store = service(f)
    first = document()
    asyncio.run(store.activate(f["token"], request(first)))
    second = deepcopy(first)
    second["payload"]["packageId"] = str(uuid4())
    second["payload"]["skills"][0]["description"] = "Different definition"
    second["integrity"]["digest"] = digest(second["payload"])
    name = "Conflicting " + uuid4().hex
    with pytest.raises(ControlError, match="employee_import_skill_definition_conflict"):
        asyncio.run(store.activate(f["token"], request(second, name=name)))
    with psycopg.connect(f["dsn"]) as connection:
        assert connection.execute("SELECT count(*) FROM bots WHERE name=%s", (name,)).fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM employee_import_receipts WHERE package_id=%s", (second["payload"]["packageId"],)).fetchone()[0] == 0


def test_real_session_expiry_during_import_audit_prevents_commit(db_fixture):
    f = db_fixture
    doc = document()
    token = uuid4().hex + uuid4().hex[:11]
    with psycopg.connect(f["dsn"]) as connection:
        connection.execute("CREATE FUNCTION portability_test_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='BOT_IMPORTED' THEN PERFORM pg_sleep(0.6); END IF; RETURN NEW; END $$")
        connection.execute("CREATE TRIGGER portability_test_delay BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION portability_test_delay()")
        connection.execute("INSERT INTO auth_sessions(id,token_digest,expires_at) VALUES (%s,%s,clock_timestamp()+interval '0.4 second')", (str(uuid4()), hashlib.sha256(token.encode()).hexdigest()))
    try:
        with pytest.raises(AuthenticationRequired):
            asyncio.run(service(f).activate(token, request(doc)))
        with psycopg.connect(f["dsn"]) as connection:
            assert connection.execute("SELECT count(*) FROM bots WHERE name=%s", (doc["payload"]["employee"]["name"],)).fetchone()[0] == 0
            assert connection.execute("SELECT count(*) FROM employee_import_receipts WHERE package_id=%s", (doc["payload"]["packageId"],)).fetchone()[0] == 0
    finally:
        with psycopg.connect(f["dsn"]) as connection:
            connection.execute("DROP TRIGGER portability_test_delay ON run_events")
            connection.execute("DROP FUNCTION portability_test_delay()")
