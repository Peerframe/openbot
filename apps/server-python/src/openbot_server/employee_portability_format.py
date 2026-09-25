"""OpenBot's retained canonical package/DSSE format, with no imported authority.

Ed25519 is supplied by the already-pinned cryptography 50.0.1, never a local primitive.
The openbot-json-v1 profile contains only strict-schema string keys and scalar strings; its
sorted object encoding is deliberately the existing protocol, not a new JCS implementation.
"""
import base64
from datetime import datetime, timezone
import hashlib
import json
import re
import unicodedata
from uuid import uuid4

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from pydantic import ValidationError

from .control_errors import ControlError
from .employee_knowledge_inputs import _SENSITIVE, parse_skill_document
from .employee_portability_inputs import DsseEnvelope, EmployeePackage, PortablePayload
from .identity_inputs import _ECMASCRIPT_WHITESPACE
from .models import iso_timestamp

PAYLOAD_TYPES = {"openbot.employee/v1": "application/vnd.openbot.employee.v1+json", "openbot.employee/v2": "application/vnd.openbot.employee.v2+json"}
LICENSES = {"MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0"}


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def serialize_package(value):
    return json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"


def digest(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def checksum_valid(document):
    return digest(document["payload"]) == document["integrity"]["digest"]


def _scan(text, location):
    messages = (
        ("private-key-content", "A private-key marker was found. Remove it before continuing."),
        ("credential-like-content", "A credential-like token was found. Remove it before continuing."),
        ("credential-like-content", "A credential-like token was found. Remove it before continuing."),
        ("credential-like-content", "A credential-like assignment was found. Remove it before continuing."),
        ("credential-like-content", "A bearer token was found. Remove it before continuing."),
    )
    output = [{"code": code, "location": location, "message": message} for pattern, (code, message) in zip(_SENSITIVE, messages) if pattern.search(text)]
    if re.search(r"(?:/Users/|/home/|[A-Za-z]:\\Users\\)", text):
        output.append({"code": "local-path-content", "location": location, "message": "A user-specific local path was found. Replace it with a portable path."})
    return output


def scan_portable(payload):
    fields = [("employee." + field, payload["employee"][field]) for field in ("name", "role", "description") if field in payload["employee"]]
    for index, skill in enumerate(payload["skills"]):
        if skill.get("content"):
            fields.append((f"skills[{index}].content.markdown", skill["content"]["markdown"]))
        fields.extend((f"skills[{index}].{field}", skill[field]) for field in ("slug", "name", "description", "version"))
        for field in ("requiredCapabilities", "dependencySlugs"):
            fields.extend((f"skills[{index}].{field}[{number}]", value) for number, value in enumerate(skill[field]))
    return [finding for location, value in fields for finding in _scan(value, location)]


def skill_content_problem(skill):
    if not skill.get("content"):
        return None
    try:
        content = skill["content"]
        parsed = parse_skill_document(content["markdown"])
        if (parsed["markdown"] != content["markdown"] or parsed["sha256"] != content["sha256"] or parsed["name"] != skill["slug"]
                or parsed["description"] != skill["description"] or parsed.get("license") != content["license"]):
            return "Skill instruction content, metadata or checksum does not match."
        if content["license"] not in LICENSES:
            return "Sharing instructions requires a supported redistribution license in SKILL.md; preserve its author and license notices."
        if skill["requiredCapabilities"] or skill["dependencySlugs"]:
            return "Native instruction files currently require no external capabilities or skill dependencies."
        if re.search(r"(?:^|[\s([`])(?:scripts|references|assets)/", parsed["markdown"], re.MULTILINE):
            return "This skill references files outside SKILL.md. Share a self-contained instruction file; bundled assets are not supported yet."
    except (ControlError, KeyError, ValueError):
        return "The included SKILL.md is invalid or contains sensitive content."
    return None


def _portable_content(skill, findings):
    if not skill.get("skillMarkdown"):
        return None
    try:
        parsed = parse_skill_document(skill["skillMarkdown"])
        content = {"markdown": parsed["markdown"], "sha256": parsed["sha256"], "license": parsed.get("license", "")}
        problem = skill_content_problem({**skill, "dependencySlugs": skill["dependencyIds"], "content": content})
        if problem or not skill.get("modelUseEnabled") or skill.get("contentSha256") != parsed["sha256"]:
            raise ValueError(problem or "The instruction digest has not been reviewed for this Bot.")
        return content
    except (ControlError, ValueError) as exc:
        findings.append({"code": "invalid-skill-content", "location": f"skills.{skill['slug']}.content",
                         "message": str(exc) if isinstance(exc, ValueError) else "Invalid SKILL.md: use bounded YAML metadata and a nonempty Markdown body."})
        return None


def portable_file_stem(name):
    stem = re.sub(r"[^a-z0-9]+", "-", unicodedata.normalize("NFKD", name).lower()).strip("-")[:48].rstrip("-")
    if not stem:
        return "employee"
    return stem + "-employee" if re.fullmatch(r"(?:con|prn|aux|nul|com[0-9]|lpt[0-9])", stem) else stem


def build_template(profile, *, include_skill_content=False, package_id=None, generated_at=None, publisher_key_id=None):
    skills = sorted((skill for skill in profile["skills"] if skill["state"] == "verified"), key=lambda skill: skill["slug"])
    exported = {skill["id"]: skill["slug"] for skill in skills}
    capabilities = sorted({capability for skill in skills for capability in skill["requiredCapabilities"]})
    findings, portable = [], []
    for skill in skills:
        item = {field: skill[field] for field in ("slug", "name", "description", "version")}
        item["requiredCapabilities"] = sorted(set(skill["requiredCapabilities"]))
        if include_skill_content:
            content = _portable_content(skill, findings)
            if content:
                item["content"] = content
        item["dependencySlugs"] = sorted(exported[identity] for identity in skill["dependencyIds"] if identity in exported)
        portable.append(item)
    payload = PortablePayload.model_validate({
        "format": "openbot.employee/v2" if include_skill_content else "openbot.employee/v1", "kind": "template",
        "packageId": package_id or str(uuid4()), "generatedAt": generated_at or iso_timestamp(datetime.now(timezone.utc)),
        "employee": {"name": profile["employee"]["name"], "role": profile["employee"]["role"], "description": profile["details"]["description"],
                     **({"appearance": profile["employee"]["appearance"]} if profile["employee"].get("appearance") else {})},
        "configuration": {"recommendedExecutionProfile": profile["configuration"]["executionProfile"]},
        "skills": portable, "requestedCapabilities": capabilities,
        "portability": {"identity": "new-on-import", "authority": "none", "memories": "none", "importedSkillState": "disabled-pending-review"},
        "signature": {"status": "unsigned"},
    }).model_dump(exclude_none=True)
    for index, skill in enumerate(skills):
        if any(dependency not in exported for dependency in skill["dependencyIds"]):
            findings.append({"code": "excluded-skill-dependency", "location": f"skills[{index}].dependencySlugs",
                             "message": f'Verified skill "{skill["slug"]}" depends on a skill that is not verified for export.'})
    findings.extend(scan_portable(payload))
    checksum = digest(payload)
    document = {"payload": payload, "integrity": {"algorithm": "sha256", "canonicalization": "openbot-json-v1", "digest": checksum}}
    if len(serialize_package(document).encode()) > 1048576:
        findings.append({"code": "package-too-large", "location": "skills", "message": "The selected Bot exceeds the 1 MiB portable content limit. Reduce included instructions or share metadata only."})
    history = len(profile["evolution"]) + sum(len(profile["records"][kind]) for kind in ("runs", "approvals", "artifacts", "decisions"))
    preview = {"format": payload["format"], "kind": "template", "packageId": payload["packageId"],
               "fileName": portable_file_stem(profile["employee"]["name"]) + ".openbot-employee" + (".dsse" if publisher_key_id is not None else "") + ".json",
               "generatedAt": payload["generatedAt"], "employee": payload["employee"], "skills": payload["skills"],
               "employeeName": payload["employee"]["name"], "verifiedSkillCount": len(skills), "requestedCapabilities": capabilities,
               "includedMemoryCount": 0, "exclusions": [
                   {"category": "identity", "count": 1, "reason": "The source employee id and ownership are never included in a template."},
                   {"category": "authority", "count": 1, "reason": "Host bindings, approvals, credentials, sessions, and capability grants are absent."},
                   {"category": "memory", "count": len(profile["memories"]), "reason": "The v1 default template exports no memory records."},
                   {"category": "work-history", "count": history, "reason": "Runs, decisions, artifacts, approvals, and evolution history stay on the source Server."}],
               "findings": findings, "blocked": bool(findings), "checksum": checksum,
               "signatureStatus": "dsse" if publisher_key_id is not None else "unsigned",
               **({"publisherKeyId": publisher_key_id} if publisher_key_id is not None else {}), "identityOnImport": "new", "hostAuthority": "none"}
    return {"document": document, "preview": preview}


def pae(payload_type, payload):
    media = payload_type.encode()
    return b"DSSEv1 " + str(len(media)).encode() + b" " + media + b" " + str(len(payload)).encode() + b" " + payload


def decode_base64(value):
    unpadded = value.rstrip("=").replace("-", "+").replace("_", "/")
    if len(unpadded) % 4 == 1:
        raise ValueError("Invalid DSSE base64 length.")
    decoded = base64.b64decode(unpadded + "=" * ((-len(unpadded)) % 4), validate=True)
    if base64.b64encode(decoded).decode().rstrip("=") != unpadded:
        raise ValueError("Invalid DSSE base64 encoding.")
    return decoded


def key_id(public_key):
    if not isinstance(public_key, Ed25519PublicKey):
        raise ValueError("Employee publisher public key must use Ed25519.")
    return "ed25519:" + hashlib.sha256(public_key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)).hexdigest()


def sign_envelope(document, keyid, private_key):
    document = EmployeePackage.model_validate(document).model_dump(exclude_none=True)
    if not checksum_valid(document) or document["payload"]["signature"]["status"] != "unsigned" or scan_portable(document["payload"]):
        raise ControlError(422, "employee_package_signing_refused")
    if not isinstance(private_key, Ed25519PrivateKey):
        raise ValueError("Employee publisher requires an Ed25519 private key.")
    payload = PortablePayload.model_validate({**document["payload"], "signature": {"status": "dsse", "algorithm": "ed25519", "keyid": keyid}}).model_dump(exclude_none=True)
    signed = {"payload": payload, "integrity": {"algorithm": "sha256", "canonicalization": "openbot-json-v1", "digest": digest(payload)}}
    raw = serialize_package(signed).encode()
    media = PAYLOAD_TYPES[payload["format"]]
    return DsseEnvelope.model_validate({"payload": base64.b64encode(raw).decode(), "payloadType": media,
        "signatures": [{"keyid": payload["signature"]["keyid"], "sig": base64.b64encode(private_key.sign(pae(media, raw))).decode()}]}).model_dump(exclude_none=True)


def _rejected(code, message):
    return {"status": "rejected", "code": code, "message": message}


def verify_envelope(value, trusted_keys):
    try:
        envelope = DsseEnvelope.model_validate(value)
    except ValidationError:
        return _rejected("invalid-envelope", "The DSSE envelope is malformed or exceeds the supported bounds.")
    try:
        raw = decode_base64(envelope.payload)
    except ValueError:
        return _rejected("invalid-envelope", "The DSSE envelope payload is not valid base64.")
    trusted = {}
    try:
        if len(trusted_keys) > 256:
            raise ValueError()
        for entry in trusted_keys:
            identity = entry["keyid"].strip(_ECMASCRIPT_WHITESPACE)
            if not 1 <= len(identity) <= 256 or identity in trusted:
                raise ValueError()
            key = entry["publicKey"]
            if isinstance(key, str):
                key = key.encode()
            if isinstance(key, bytes):
                key = serialization.load_pem_public_key(key)
            if not isinstance(key, Ed25519PublicKey):
                raise ValueError()
            trusted[identity] = key
    except (ValueError, TypeError, KeyError):
        return _rejected("invalid-trust-store", "The trusted key configuration is invalid.")
    message = pae(envelope.payloadType, raw)
    verified = set()
    for signature in envelope.signatures:
        try:
            signature_bytes = decode_base64(signature.sig)
        except ValueError:
            continue
        for identity, key in trusted.items():
            try:
                key.verify(signature_bytes, message)
                verified.add(identity)
            except (InvalidSignature, ValueError):
                pass
    if not verified:
        return _rejected("no-trusted-signature", "No signature was produced by a configured trusted public key.")
    if envelope.payloadType not in PAYLOAD_TYPES.values():
        return _rejected("unsupported-payload-type", "Unsupported DSSE payload type.")
    try:
        # TextDecoder(fatal=true) accepts a UTF-8 BOM and removes it before JSON.parse.
        decoded = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeError, ValueError):
        return _rejected("invalid-payload", "The verified payload is not valid UTF-8 JSON.")
    try:
        document = EmployeePackage.model_validate(decoded).model_dump(exclude_none=True)
    except ValidationError:
        return _rejected("invalid-payload", "The verified payload is not a supported OpenBot employee package.")
    if envelope.payloadType != PAYLOAD_TYPES[document["payload"]["format"]]:
        return _rejected("unsupported-payload-type", "Package version does not match the signed payload type.")
    if not checksum_valid(document):
        return _rejected("checksum-mismatch", "The signed employee package checksum does not match its payload.")
    metadata = document["payload"]["signature"]
    if metadata["status"] != "dsse" or metadata["keyid"] not in verified:
        return _rejected("signature-metadata-mismatch", "The authenticated package metadata does not identify a signature that verified.")
    return {"status": "verified", "trustedKeyId": metadata["keyid"], "document": document}


def prepare_export(profile, *, publisher=None, **options):
    built = build_template(profile, publisher_key_id=publisher.active_key_id if publisher else None, **options)
    document = built["document"]
    exported = document
    if publisher and not built["preview"]["blocked"]:
        exported = publisher.sign(document)
        result = publisher.verify(exported)
        if result["status"] != "verified" or result["trustedKeyId"] != publisher.active_key_id:
            raise ControlError(503, "employee_publisher_self_verification_failed")
        verified = result["document"]
        if verified["payload"]["signature"].get("keyid") != publisher.active_key_id or {k: v for k, v in verified["payload"].items() if k != "signature"} != {k: v for k, v in document["payload"].items() if k != "signature"}:
            raise ControlError(503, "employee_publisher_payload_mismatch")
        document = verified
    body = serialize_package(exported)
    return {"document": document, "body": body, "preview": {**built["preview"], "checksum": document["integrity"]["digest"],
            "downloadReviewToken": hashlib.sha256(body.encode()).hexdigest()}}


def inspect_template(document, nodes, *, trusted_key_id=None):
    payload = document["payload"]
    signature = payload["signature"]
    if (signature["status"] == "dsse" and trusted_key_id != signature["keyid"]) or (signature["status"] == "unsigned" and trusted_key_id is not None):
        raise ControlError(422, "employee_package_signature_unverified")
    issues = []
    def issue(code, message, locations):
        issues.append({"code": code, "message": message, "locations": locations})
    for skill in payload["skills"]:
        problem = skill_content_problem(skill)
        if problem:
            issue("invalid-skill-content", problem, [f"skills.{skill['slug']}.content"])
    slugs = [skill["slug"] for skill in payload["skills"]]
    duplicates = sorted({slug for slug in slugs if slugs.count(slug) > 1})
    if duplicates:
        issue("duplicate-skill", "The package contains duplicate skill slugs.", duplicates)
    missing = sorted({f"{skill['slug']} -> {dependency}" for skill in payload["skills"] for dependency in skill["dependencySlugs"] if dependency not in slugs})
    if missing:
        issue("missing-skill-dependency", "One or more skill dependencies are absent from the package.", missing)
    skill_caps = {capability for skill in payload["skills"] for capability in skill["requiredCapabilities"]}
    declared = set(payload["requestedCapabilities"])
    if skill_caps != declared:
        issue("capability-set-mismatch", "The declared capability set does not match the included skills.", sorted(skill_caps | declared))
    if not checksum_valid(document):
        issue("checksum-mismatch", "The package checksum does not match its payload.", ["integrity.digest"])
    sensitive = scan_portable(payload)
    if sensitive:
        issue("sensitive-content", "The package contains credential-like text or a machine-local path.", [finding["location"] for finding in sensitive])
    profile = payload["configuration"]["recommendedExecutionProfile"]
    platform, profile_caps = {"none": (None, []), "docker-linux": (None, ["browser", "screenshot"]),
        "macos-cua": ("macos", ["cua", "screenshot"]), "lume-vm": ("macos", ["lume", "screenshot"]), "coder": (None, ["coder"])}[profile]
    requirements = skill_caps | declared | set(profile_caps)
    host_required = profile != "none" or bool(requirements)
    available, compatible = set(), []
    for node in nodes:
        caps = set(node["capabilities"]) | {capability["id"] for capability in node["capabilityManifest"]}
        available.update(caps)
        if host_required and (platform is None or node["platform"] == platform) and requirements <= caps:
            compatible.append({key: node[key] for key in ("id", "name", "platform", "architecture", "deviceClass")})
    missing = sorted(requirements - available)
    compatible.sort(key=lambda node: node["id"])
    if missing:
        issue("missing-capability", "No connected Worker Host currently advertises one or more required capabilities.", missing)
    if host_required and not compatible:
        issue("no-compatible-host", "No connected Worker Host satisfies the complete package requirement set.", [profile])
    return {"format": payload["format"], "packageId": payload["packageId"], "generatedAt": payload["generatedAt"],
            "employee": payload["employee"], "recommendedExecutionProfile": profile, "skills": payload["skills"],
            "requestedCapabilities": sorted(declared), "integrity": {"algorithm": "sha256", "valid": checksum_valid(document), "digest": digest(document)},
            "signature": {"status": "dsse", "trusted": True, "keyid": signature["keyid"]} if signature["status"] == "dsse" else {"status": "unsigned", "trusted": False},
            "compatibility": {"hostRequired": host_required, "compatibleHosts": compatible, "missingCapabilities": missing},
            "quarantine": {"active": True, "createsNewIdentity": True, "importedSkillState": "disabled-pending-review", "hostAuthority": "none", "memoryCount": 0, "canActivate": not issues},
            "issues": issues, "blocked": bool(issues)}
