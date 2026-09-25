"""Real released-library checks with synthetic keys; no Provider activation or execution claim."""
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import subprocess
from uuid import UUID

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PrivateFormat, PublicFormat, NoEncryption
from joserfc import jws
from joserfc.jwk import OKPKey
import rfc8785

from openbot_server.work_command_contract import (
    CommandContractError, CommandIntent, DispatchOperation, CommandBinding, DeadlineAnchors,
    FINGERPRINT_PREFIX, TOKEN_TYPES, bounded_value, strict_json, parse, derive_operation,
    operation_fingerprint, check_intent, freeze_deadline, validate_claims)
from openbot_server.work_command_crypto import TokenSigner, TokenVerifier, VerificationPin

NOW = 1_800_000_000_000
DIGEST = "a" * 64
UUID1 = str(UUID(int=1))
UUID2 = str(UUID(int=2))
UUID3 = str(UUID(int=3))
UUID4 = str(UUID(int=4))
NONCE = "A" * 43


def intent():
    entries = [{"path": "input.csv", "size": 4, "sha256": hashlib.sha256(b"a,b\n").hexdigest()}]
    return {"kind": "work_command", "version": 1, "profileDigest": DIGEST, "command": {
        "image": "python@sha256:" + "b" * 64, "argv": ["/usr/bin/python3", "-c", "print('测试😀')"],
        "inputManifest": entries, "inputDigest": "sha256:" + hashlib.sha256(rfc8785.dumps(entries)).hexdigest(),
        "output": {"name": "result.csv", "mediaType": "text/csv", "maxBytes": 1024},
        "limits": {"nanoCPUs": 500_000_000, "memoryMiB": 128, "pids": 64, "nofile": 128,
                   "tmpMiB": 16, "wallSeconds": 60, "outputMiB": 16, "capturedOutputKiB": 64},
        "network": "none", "rootfs": "readonly", "user": "10001:10001", "environment": []}}


def operation():
    return derive_operation(intent(), task_id="task-1", run_id="run-1", action_id="action-1",
        generation=1, original_epoch=2, route={"nodeId": "node-1", "providerId": "command-provider",
            "enforcementKeyId": "enforcement-key", "ledgerId": UUID1}).model_dump()


def binding():
    op = operation()
    return {"taskId": "task-1", "runId": "run-1", "actionId": "action-1", "dispatchId": UUID2,
            "connectionId": UUID3, "originalEpoch": 2, "authorityGeneration": 1, "profileDigest": DIGEST,
            "intentDigest": op["intentDigest"], "operationFingerprint": operation_fingerprint(op),
            **op["route"], "hardDeadlineMs": NOW + 60000}


def claims(purpose="work_command_dispatch", *, now=NOW):
    value = dict(binding(), iss="control" if purpose in ("work_command_dispatch", "work_command_permit") else "enforcer",
                 aud="enforcer" if purpose in ("work_command_dispatch", "work_command_permit") else "control",
                 jti=UUID4, iat=now // 1000, nbf=now // 1000, exp=now // 1000 + 30, purpose=purpose)
    if purpose == "work_command_dispatch":
        value["anchors"] = freeze_deadline(admitted_at_ms=NOW, root_deadline_ms=NOW + 120000,
            native_deadline_ms=NOW + 90000, wall_seconds=60).model_dump()
    else:
        value.update(requestId=UUID4, nonce=NONCE)
        if purpose == "work_command_consume":
            value["ticketDigest"] = DIGEST
        elif purpose == "work_command_permit":
            value.update(requestDigest=DIGEST, consumedAtMs=now,
                         launchDeadlineMs=min(now + 5000, value["hardDeadlineMs"]), exp=now // 1000 + 5)
        else:
            value.update(permitDigest=DIGEST, observation={"phase": "exited", "containerId": "c" * 64,
                "startAttempts": 1, "exitCode": 0, "sequence": 2, "runtimeShapeDigest": "d" * 64,
                "outputs": [{"name": "result.csv", "mediaType": "text/csv", "sizeBytes": 4, "sha256": DIGEST}],
                "truncated": False})
    return value


@pytest.fixture
def keys():
    key = Ed25519PrivateKey.generate()
    return (key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()),
            key.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo))


def signer(keys, purpose):
    role = "control" if purpose in ("work_command_dispatch", "work_command_permit") else "enforcement"
    issuer = "control" if role == "control" else "enforcer"
    return TokenSigner(issuer=issuer, kid="key-1" if role == "control" else "enforcement-key",
                       role=role, private_pem=keys[0])


def verify(keys, token, value, *, now=NOW, **kwargs):
    purpose = value["purpose"]
    role = "control" if purpose in ("work_command_dispatch", "work_command_permit") else "enforcement"
    verifier = TokenVerifier([VerificationPin(value["iss"],
        "key-1" if role == "control" else "enforcement-key", role, keys[1])])
    request = None if purpose == "work_command_dispatch" else {"requestId": value["requestId"], "nonce": value["nonce"]}
    args = dict(purpose=purpose, issuer=value["iss"], audience=value["aud"], expected_binding=binding(),
                now_ms=now, expected_request=request)
    args.update(kwargs)
    return verifier.verify(token, **args)


@pytest.mark.parametrize("value", [
    b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":Infinity}', b'{"x":1.0}', b'{"x":-0.0}',
    b'{"x":9007199254740992}', b'{"x":"\\ud800"}', b'{"x":"\\u0000"}', b'{"x":1}\x00',
    b"\xef\xbb\xbf{}", b"\xff", b"[] " * 8192, b"[" * 2000 + b"]" * 2000,
])
def test_strict_json_rejects_ambiguous_or_unbounded_values(value):
    with pytest.raises(CommandContractError, match="invalid_command_contract"):
        strict_json(value)


@pytest.mark.parametrize("field,value", [
    ("nanoCPUs", 0), ("nanoCPUs", 1_000_000_001), ("nanoCPUs", 0.5),
    ("nanoCPUs", True), ("memoryMiB", 513), ("pids", 513), ("nofile", 257),
    ("tmpMiB", 33), ("wallSeconds", 61), ("outputMiB", 65), ("capturedOutputKiB", 1025),
])
def test_resource_widening_and_float_cpus_are_rejected(field, value):
    data = intent()
    data["command"]["limits"][field] = value
    with pytest.raises(CommandContractError):
        parse(CommandIntent, data)


@pytest.mark.parametrize("mutation", [
    lambda x: x.update(version=True),
    lambda x: x.update(unknown="x"),
    lambda x: x["command"].update(network="bridge"),
    lambda x: x["command"].update(environment=["TOKEN=value"]),
    lambda x: x["command"].update(user="0:0"),
    lambda x: x["command"].update(rootfs="rw"),
    lambda x: x["command"].update(image="python:latest"),
    lambda x: x["command"].update(argv=[""]),
    lambda x: x["command"].update(argv=["x"] * 65),
    lambda x: x["command"].update(argv=["\udfff"]),
    lambda x: x["command"]["output"].update(name="../escape"),
    lambda x: x["command"]["output"].update(mediaType="application/octet-stream"),
    lambda x: x["command"]["output"].update(maxBytes=1048577),
    lambda x: x["command"]["inputManifest"][0].update(path="../escape"),
    lambda x: x["command"]["inputManifest"][0].update(size=5),
    lambda x: x["command"].update(inputManifest=x["command"]["inputManifest"] * 2),
    lambda x: x["command"].update(inputDigest="sha256:" + "0" * 64),
])
def test_command_shape_cannot_expand_scope(mutation):
    data = intent(); mutation(data)
    with pytest.raises(CommandContractError):
        parse(CommandIntent, data)


def test_exact_operation_binds_action_route_epoch_and_source_intent():
    original = operation()
    assert check_intent(original, intent()).model_dump() == original
    assert operation_fingerprint(dict(reversed(list(original.items())))) == operation_fingerprint(original)
    for key, value in (("actionId", "action-2"), ("originalEpoch", 3), ("authorityGeneration", 2)):
        changed = dict(original, **{key: value})
        assert operation_fingerprint(changed) != operation_fingerprint(original)
    changed = deepcopy(original); changed["route"]["nodeId"] = "node-2"
    assert operation_fingerprint(changed) != operation_fingerprint(original)
    changed = deepcopy(original); changed["command"]["argv"][-1] = "print('changed')"
    with pytest.raises(CommandContractError):
        check_intent(changed, intent())


def test_returned_values_do_not_mutate_caller_owned_proposal():
    data = intent(); result = parse(CommandIntent, data)
    data["command"]["argv"][0] = "changed"
    assert result.command.argv[0] == "/usr/bin/python3"


@pytest.mark.parametrize("root,native,wall,expected", [
    (20000, 90000, 60, 20000), (90000, 12000, 60, 12000), (90000, 90000, 7, 7000)])
def test_deadline_is_minimum_of_original_anchors(root, native, wall, expected):
    data = freeze_deadline(admitted_at_ms=NOW, root_deadline_ms=NOW + root,
                           native_deadline_ms=NOW + native, wall_seconds=wall)
    assert data.hardDeadlineMs == NOW + expected
    changed = data.model_dump(); changed["hardDeadlineMs"] += 1
    with pytest.raises(CommandContractError):
        parse(DeadlineAnchors, changed)


@pytest.mark.parametrize("purpose", list(TOKEN_TYPES))
def test_real_joserfc_roundtrip_has_strict_type_and_role(keys, purpose):
    value = claims(purpose)
    token = signer(keys, purpose).sign(value, purpose=purpose, now_ms=NOW)
    assert verify(keys, token, value).model_dump() == value


@pytest.mark.parametrize("purpose", list(TOKEN_TYPES))
def test_real_jose_python_cross_language_sign_and_verify(keys, purpose):
    value = claims(purpose)
    token = signer(keys, purpose).sign(value, purpose=purpose, now_ms=NOW)
    kid = "key-1" if purpose in ("work_command_dispatch", "work_command_permit") else "enforcement-key"
    result = subprocess.run([os.getenv("OPENBOT_COMMAND_NODE", "node"),
        str(Path(__file__).with_name("command_node_vectors.mjs"))], check=True, capture_output=True,
        input=json.dumps({"mode": "interop", "privatePem": keys[0].decode(), "publicPem": keys[1].decode(),
            "token": token, "claims": value, "nowMs": NOW,
            "header": {"alg": "Ed25519", "typ": TOKEN_TYPES[purpose], "kid": kid}}),
        text=True, timeout=10)
    result = json.loads(result.stdout)
    assert result["payload"] == value
    assert result["header"] == {"alg": "Ed25519", "typ": TOKEN_TYPES[purpose], "kid": kid}
    assert verify(keys, result["token"], value).model_dump() == value


@pytest.mark.parametrize("change", [
    {"alg": "EdDSA"}, {"alg": "none"}, {"alg": "HS256"}, {"kid": "unknown"},
    {"jku": "https://example.invalid/keys"}, {"jwk": {}}, {"x5u": "https://example.invalid"},
    {"x5c": []}, {"crit": ["x"]}, {"b64": False}, {"typ": "JWT"},
])
def test_header_substitution_is_rejected_before_dynamic_key_use(keys, change):
    value = claims()
    token = signer(keys, value["purpose"]).sign(value, purpose=value["purpose"], now_ms=NOW)
    import base64
    header = {"alg": "Ed25519", "typ": TOKEN_TYPES[value["purpose"]], "kid": "key-1", **change}
    first = base64.urlsafe_b64encode(json.dumps(header).encode()).decode().rstrip("=")
    forged = first + "." + ".".join(token.split(".")[1:])
    with pytest.raises(CommandContractError, match="invalid_command_token"):
        verify(keys, forged, value)


@pytest.mark.parametrize("raw", [
    b'{"iss":"control","iss":"other"}', b'{"exp":true}', b'{"exp":NaN}', b'{"extra":"\\udfff"}'])
def test_even_valid_signatures_do_not_admit_ambiguous_json(keys, raw):
    token = jws.serialize_compact({"alg": "Ed25519", "typ": TOKEN_TYPES["work_command_dispatch"], "kid": "key-1"},
        raw, OKPKey.import_key(keys[0]), algorithms=["Ed25519"])
    with pytest.raises(CommandContractError):
        verify(keys, token, claims())


@pytest.mark.parametrize("mutation", [
    lambda x: x.update(iat=x["iat"] + 1, nbf=x["nbf"] + 1, exp=x["exp"] + 1),
    lambda x: x.update(exp=x["iat"] + 31),
    lambda x: x.update(exp=True),
    lambda x: x.update(aud=["enforcer"]),
    lambda x: x.update(originalEpoch=3),
    lambda x: x.update(connectionId=UUID4),
    lambda x: x.update(unknown="value"),
])
def test_signed_but_invalid_or_wrong_bound_claims_are_refused(keys, mutation):
    original = claims(); value = deepcopy(original); mutation(value)
    token = jws.serialize_compact({"alg": "Ed25519", "typ": TOKEN_TYPES["work_command_dispatch"], "kid": "key-1"},
        json.dumps(value).encode(), OKPKey.import_key(keys[0]), algorithms=["Ed25519"])
    with pytest.raises(CommandContractError):
        verify(keys, token, original)


@pytest.mark.parametrize("offset", [-1, 30000, 60000])
def test_no_clock_leeway_and_exact_expiry(keys, offset):
    value = claims(); token = signer(keys, value["purpose"]).sign(value, purpose=value["purpose"], now_ms=NOW)
    with pytest.raises(CommandContractError):
        verify(keys, token, value, now=NOW + offset)


def test_permit_cannot_extend_hard_deadline_or_five_second_window(keys):
    value = claims("work_command_permit")
    assert validate_claims(value, purpose=value["purpose"], now_ms=NOW).launchDeadlineMs == NOW + 5000
    for key in ("launchDeadlineMs", "exp"):
        changed = deepcopy(value); changed[key] += 1
        with pytest.raises(CommandContractError):
            signer(keys, value["purpose"]).sign(changed, purpose=value["purpose"], now_ms=NOW)


def test_historical_receipt_can_validate_but_cannot_be_used_as_dispatch(keys):
    value = claims("work_command_receipt", now=NOW + 120000)
    token = signer(keys, value["purpose"]).sign(value, purpose=value["purpose"], now_ms=NOW + 120000)
    result = verify(keys, token, value, now=NOW + 120000)
    assert result.hardDeadlineMs < NOW + 120000
    with pytest.raises(CommandContractError):
        verify(keys, token, value, purpose="work_command_dispatch", now=NOW + 120000)


def test_verifier_requires_exact_challenge_and_identity_role(keys):
    value = claims("work_command_consume")
    token = signer(keys, value["purpose"]).sign(value, purpose=value["purpose"], now_ms=NOW)
    for expected in (None, {}, {"requestId": UUID4, "nonce": "B" * 43}):
        with pytest.raises(CommandContractError):
            verify(keys, token, value, expected_request=expected)
    verifier = TokenVerifier([VerificationPin("enforcer", "enforcement-key", "control", keys[1])])
    with pytest.raises(CommandContractError):
        verifier.verify(token, purpose=value["purpose"], issuer="enforcer", audience="control",
                        expected_binding=binding(), now_ms=NOW,
                        expected_request={"requestId": UUID4, "nonce": NONCE})


def test_private_verification_key_and_empty_or_duplicate_pins_are_refused(keys):
    with pytest.raises(CommandContractError):
        VerificationPin("control", "key-1", "control", keys[0])
    with pytest.raises(CommandContractError):
        TokenVerifier([])
    pin = VerificationPin("control", "key-1", "control", keys[1])
    with pytest.raises(CommandContractError):
        TokenVerifier([pin, pin])


@pytest.mark.parametrize("mutation", [
    lambda t: t + "=", lambda t: " " + t, lambda t: t + ".x",
    lambda t: t.split(".")[0] + ".." + t.split(".")[2], lambda t: t[:20],
    lambda t: "x" * 8193,
])
def test_noncanonical_compact_forms_fail_with_finite_error(keys, mutation):
    value = claims(); token = signer(keys, value["purpose"]).sign(value, purpose=value["purpose"], now_ms=NOW)
    with pytest.raises(CommandContractError) as error:
        verify(keys, mutation(token), value)
    assert str(error.value) == "invalid_command_token"
    assert token not in repr(error.value)


def test_python_node_jcs_agree_on_real_operation_and_unicode_order():
    values = [operation(), {"\U0001f600": "unicode", "\ue000": 1, "z": 0, "a": [True, None, "测试"]}]
    for value in values:
        output = subprocess.run([os.getenv("OPENBOT_COMMAND_NODE", "node"),
            str(Path(__file__).with_name("command_node_vectors.mjs"))], input=json.dumps({"mode": "jcs", "operation": value}),
            check=True, capture_output=True, text=True, timeout=10)
        result = json.loads(output.stdout)
        assert result["canonical"].encode() == rfc8785.dumps(value)
        assert result["fingerprint"] == hashlib.sha256(FINGERPRINT_PREFIX + rfc8785.dumps(value)).hexdigest()


def test_control_and_enforcement_pins_cannot_share_a_private_identity(keys):
    with pytest.raises(CommandContractError):
        TokenVerifier([VerificationPin("control", "key-1", "control", keys[1]),
                       VerificationPin("enforcer", "enforcement-key", "enforcement", keys[1])])


def test_enforcement_signature_must_use_frozen_enforcement_key_id(keys):
    value = claims("work_command_consume")
    token = jws.serialize_compact({"alg": "Ed25519", "typ": TOKEN_TYPES[value["purpose"]], "kid": "other-enforcer"},
        json.dumps(value).encode(), OKPKey.import_key(keys[0]), algorithms=["Ed25519"])
    verifier = TokenVerifier([VerificationPin("enforcer", "other-enforcer", "enforcement", keys[1])])
    with pytest.raises(CommandContractError):
        verifier.verify(token, purpose=value["purpose"], issuer="enforcer", audience="control",
            expected_binding=binding(), now_ms=NOW, expected_request={"requestId": UUID4, "nonce": NONCE})


@pytest.mark.parametrize("phase,start,container,shape", [
    ("prepared", 1, None, None), ("prepared", 0, DIGEST, None),
    ("running", 0, DIGEST, DIGEST), ("running", 1, None, DIGEST),
    ("running", 1, DIGEST, None)])
def test_receipt_observation_does_not_fake_a_coherent_runtime(keys, phase, start, container, shape):
    value = claims("work_command_receipt")
    value["observation"].update(phase=phase, startAttempts=start, containerId=container,
                               runtimeShapeDigest=shape, exitCode=None, outputs=[])
    with pytest.raises(CommandContractError):
        signer(keys, value["purpose"]).sign(value, purpose=value["purpose"], now_ms=NOW)


def test_millisecond_admission_and_consumption_are_not_rounded_backwards(keys):
    value = claims("work_command_dispatch")
    value["anchors"]["admittedAtMs"] += 1
    value["anchors"]["hardDeadlineMs"] += 1
    value["hardDeadlineMs"] += 1
    with pytest.raises(CommandContractError):
        signer(keys, value["purpose"]).sign(value, purpose=value["purpose"], now_ms=NOW)
    value = claims("work_command_permit")
    value["consumedAtMs"] += 1; value["launchDeadlineMs"] += 1
    with pytest.raises(CommandContractError):
        signer(keys, value["purpose"]).sign(value, purpose=value["purpose"], now_ms=NOW)


def test_frozen_public_vectors_are_verified_with_both_libraries():
    vectors = json.loads((Path(__file__).parent / "fixtures/work_command_vectors.json").read_text())
    assert vectors["prefixUtf8Hex"] == FINGERPRINT_PREFIX.hex()
    for vector in vectors["positive"]:
        assert bounded_value(vector["operation"]).decode() == vector["canonical"]
        assert operation_fingerprint(vector["operation"]) == vector["fingerprint"]
        if os.getenv("OPENBOT_COMMAND_JCS_MODULE") and os.getenv("OPENBOT_COMMAND_JOSE_MODULE"):
            process = subprocess.run([os.getenv("OPENBOT_COMMAND_NODE", "node"),
                str(Path(__file__).with_name("command_node_vectors.mjs"))],
                input=json.dumps({"mode": "jcs", "operation": vector["operation"]}),
                check=True, capture_output=True, text=True, timeout=10)
            assert json.loads(process.stdout) == {
                "canonical": vector["canonical"], "fingerprint": vector["fingerprint"]}


def test_cryptographically_valid_wrong_key_is_rejected(keys):
    other = Ed25519PrivateKey.generate()
    value = claims()
    wrong_signer = TokenSigner(issuer="control", kid="key-1", role="control",
        private_pem=other.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()))
    token = wrong_signer.sign(value, purpose=value["purpose"], now_ms=NOW)
    with pytest.raises(CommandContractError):
        verify(keys, token, value)


def test_whole_command_bound_is_enforced_after_valid_individual_arguments():
    data = intent(); data["command"]["argv"] = ["x" * 4096] * 64
    with pytest.raises(CommandContractError):
        parse(CommandIntent, data)


def test_receipt_parser_never_accepts_worker_success_or_implicit_applied():
    value = claims("work_command_receipt")
    value["observation"]["phase"] = "applied"
    with pytest.raises(CommandContractError):
        validate_claims(value, purpose=value["purpose"], now_ms=NOW)


@pytest.mark.parametrize("action", ["a" * 65, "nested:path", "../escape"])
def test_action_identity_also_fits_existing_host_deduplication_key(action):
    value = operation(); value["actionId"] = action
    with pytest.raises(CommandContractError):
        parse(DispatchOperation, value)
