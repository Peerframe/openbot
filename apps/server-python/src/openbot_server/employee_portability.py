"""Owner-authorized portability service over the retained Employee package and receipt schema."""
from functools import wraps
import hashlib
import inspect
import json
import re
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ValidationError

from .authority import OwnerTransactions
from .control_errors import ControlError
from .database import StoreUnavailable
from .employee_knowledge import PostgresEmployeeKnowledge, _rows, _now, _iso, _strings, _timestamps
from .employee_portability_format import digest, inspect_template, prepare_export, skill_content_problem
from .employee_portability_inputs import ActivateInput, DsseEnvelope, EmployeePackage, ExportDownloadInput
from .models import project_bot


def _storage_guard(function):
    @wraps(function)
    async def guarded(*args, **kwargs):
        try:
            return await function(*args, **kwargs)
        except (psycopg.Error, TimeoutError, KeyError, UnicodeError):
            raise StoreUnavailable("employee_portability_storage_unavailable") from None
    return guarded


def _bounded_json(value, maximum):
    try:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
    except (TypeError, ValueError, UnicodeError, RecursionError):
        raise ControlError(422, "invalid_employee_package") from None
    if len(encoded) > maximum:
        raise ControlError(413, "employee_package_too_large")


def _parse_package(value, publisher):
    _bounded_json(value, 2 * 1024 * 1024)
    try:
        document = EmployeePackage.model_validate(value).model_dump(exclude_none=True)
        if document["payload"]["signature"]["status"] == "unsigned":
            return document, None
    except ValidationError:
        pass
    try:
        DsseEnvelope.model_validate(value)
    except ValidationError:
        raise ControlError(422, "invalid_employee_package") from None
    if publisher is None:
        raise ControlError(422, "employee_publisher_trust_required")
    result = publisher.verify(value)
    if result["status"] != "verified":
        raise ControlError(422, "employee_package_signature_" + result["code"])
    return result["document"], result["trustedKeyId"]


def _receipt(row):
    return {"id": row["id"], "packageId": row["package_id"], "packageDigest": row["package_digest"],
            "employeeId": row["employee_id"], "signatureStatus": row["signature_status"],
            **({"publisherKeyId": row["publisher_key_id"]} if row["publisher_key_id"] is not None else {}),
            "reviewedBy": "owner", "reviewedAt": _iso(row["reviewed_at"]),
            "importedSkillCount": row["imported_skill_count"], "createdAt": _iso(row["created_at"])}


class PostgresEmployeePortability:
    def __init__(self, dsn, *, publisher=None, list_nodes=None, knowledge=None):
        self._transactions = OwnerTransactions(dsn, application_name="openbot-control-portability")
        self._knowledge = knowledge or PostgresEmployeeKnowledge(dsn)
        self._publisher = publisher
        self._list_nodes = list_nodes

    async def verify_schema(self):
        await self._transactions.verify_schema()

    async def _nodes(self):
        if self._list_nodes is None:
            raise StoreUnavailable("portability_node_inventory_unavailable")
        value = self._list_nodes()
        if inspect.isawaitable(value):
            value = await value
        if not isinstance(value, list) or len(value) > 4096:
            raise StoreUnavailable("portability_node_inventory_unavailable")
        nodes = [item.model_dump(mode="json", exclude_none=True) if isinstance(item, BaseModel) else item for item in value]
        _bounded_json(nodes, 4 * 1024 * 1024)
        return nodes

    async def _prepare(self, token, bot_id, **options):
        profile = await self._knowledge.profile(token, bot_id)
        async with self._transactions.transaction(token):
            # Fresh authority covers access to the configured signer as well as profile disclosure.
            return prepare_export(profile, publisher=self._publisher, **options)

    @_storage_guard
    async def export_preview(self, token, bot_id, include_skill_content=False):
        if type(include_skill_content) is not bool:
            raise ControlError(422, "invalid_employee_export_selection")
        return (await self._prepare(token, bot_id, include_skill_content=include_skill_content))["preview"]

    @_storage_guard
    async def export(self, token, bot_id, *, package_id, generated_at, if_match, include_skill_content=False):
        if if_match is None:
            raise ControlError(428, "employee_export_review_required")
        if not isinstance(if_match, str) or not re.fullmatch(r'"[a-f0-9]{64}"', if_match):
            raise ControlError(422, "invalid_employee_export_review_tag")
        if type(include_skill_content) is not bool:
            raise ControlError(422, "invalid_employee_export_selection")
        identity = ExportDownloadInput.model_validate({"packageId": package_id, "generatedAt": generated_at})
        result = await self._prepare(token, bot_id, package_id=identity.packageId, generated_at=identity.generatedAt, include_skill_content=include_skill_content)
        if result["preview"]["blocked"]:
            raise ControlError(422, "employee_export_blocked")
        if result["preview"]["downloadReviewToken"] != if_match[1:-1]:
            raise ControlError(412, "employee_export_changed")
        return {"body": result["body"], "fileName": result["preview"]["fileName"], "etag": if_match,
                "mediaType": "application/vnd.openbot.employee.dsse+json; charset=utf-8" if self._publisher else "application/vnd.openbot.employee+json; charset=utf-8"}

    @_storage_guard
    async def import_preview(self, token, package):
        async with self._transactions.transaction(token):
            document, trusted = _parse_package(package, self._publisher)
            return inspect_template(document, await self._nodes(), trusted_key_id=trusted)

    @_storage_guard
    async def activate(self, token, value):
        if isinstance(value, BaseModel):
            value = value.model_dump(exclude_none=True)
        _bounded_json(value, 2 * 1024 * 1024 + 65536)
        value = ActivateInput.model_validate(value)
        try:
            async with self._transactions.transaction(token) as connection:
                document, trusted = _parse_package(value.package, self._publisher)
                preview = inspect_template(document, await self._nodes(), trusted_key_id=trusted)
                if preview["packageId"] != value.expectedPackageId or preview["integrity"]["digest"] != value.expectedDigest:
                    raise ControlError(409, "employee_import_preview_changed")
                if preview["blocked"] or not preview["quarantine"]["canActivate"]:
                    raise ControlError(422, "employee_import_blocked")
                if trusted is None and not value.allowUnsigned:
                    raise ControlError(422, "employee_import_unsigned_acceptance_required")
                return await self._activate(connection, document, preview["integrity"]["digest"], trusted, value)
        except psycopg.errors.UniqueViolation:
            raise ControlError(409, "employee_import_conflict") from None
        except (psycopg.Error, TimeoutError, KeyError, UnicodeError):
            raise StoreUnavailable("employee_portability_storage_unavailable") from None

    async def _activate(self, connection, document, package_digest, trusted, value):
        payload = document["payload"]
        for skill in payload["skills"]:
            if skill_content_problem(skill):
                raise ControlError(422, "employee_import_invalid_skill_content")
        name = value.employeeName or payload["employee"]["name"]
        fingerprint = hashlib.sha256(json.dumps({"packageId": payload["packageId"], "packageDigest": package_digest,
            "employeeName": name, "signatureStatus": "dsse" if trusted is not None else "unsigned", "publisherKeyId": trusted},
            ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        for key in sorted(("employee-import:idempotency:" + value.idempotencyKey, "employee-import:package:" + payload["packageId"])):
            await connection.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (key,))
        prior = await _rows(connection, "SELECT to_jsonb(r) AS receipt,to_jsonb(b) AS employee FROM employee_import_receipts r JOIN bots b ON b.id=r.employee_id WHERE r.idempotency_key=%s LIMIT 1", (value.idempotencyKey,))
        if prior:
            if prior[0]["receipt"]["request_fingerprint"] != fingerprint:
                raise ControlError(409, "employee_import_idempotency_conflict")
            return {"employee": project_bot(_timestamps(prior[0]["employee"])).model_dump(mode="json", exclude_none=True), "receipt": _receipt(prior[0]["receipt"]), "replayed": True}
        existing = await _rows(connection, "SELECT id FROM employee_import_receipts WHERE package_id=%s LIMIT 1", (payload["packageId"],))
        if existing:
            raise ControlError(409, "employee_package_already_activated")
        now = await _now(connection)
        bot_id = str(uuid4())
        cursor = await connection.execute(
            "INSERT INTO bots(id,name,role,description,profile_revision,status,computer_profile,configuration,created_at,updated_at) "
            "VALUES (%s,%s,%s,%s,1,'idle',%s,%s,%s,%s) RETURNING *",
            (bot_id, name, payload["employee"]["role"], payload["employee"].get("description", ""), payload["configuration"]["recommendedExecutionProfile"],
             Jsonb({"appearance": payload["employee"]["appearance"]} if "appearance" in payload["employee"] else {}), now, now))
        bot = await cursor.fetchone()
        by_slug, inserted = {}, set()
        # Sort shared immutable definitions to avoid deadlocks across independently imported graphs.
        for portable in sorted(payload["skills"], key=lambda item: (item["slug"], item["version"])):
            content = portable.get("content", {})
            cursor = await connection.execute(
                "INSERT INTO skills(id,slug,name,description,version,source,required_capabilities,metadata,skill_markdown,content_sha256,created_at,updated_at) "
                "VALUES (%s,%s,%s,%s,%s,'imported',%s,%s,%s,%s,%s,%s) ON CONFLICT(slug,version) DO NOTHING RETURNING *",
                (str(uuid4()), portable["slug"], portable["name"], portable["description"], portable["version"], Jsonb(portable["requiredCapabilities"]),
                 Jsonb({"format": "agentskills.io"}), content.get("markdown"), content.get("sha256"), now, now))
            skill = await cursor.fetchone()
            if skill is None:
                rows = await _rows(connection, "SELECT * FROM skills WHERE slug=%s AND version=%s FOR SHARE", (portable["slug"], portable["version"]))
                if not rows:
                    raise ControlError(409, "employee_import_skill_definition_changed")
                skill = rows[0]
            else:
                inserted.add(skill["id"])
            if (skill["skill_markdown"] != content.get("markdown") or skill["content_sha256"] != content.get("sha256")
                    or skill["name"] != portable["name"] or skill["description"] != portable["description"]
                    or set(_strings(skill["required_capabilities"])) != set(portable["requiredCapabilities"])):
                raise ControlError(409, "employee_import_skill_definition_conflict")
            by_slug[portable["slug"]] = skill
        for portable in payload["skills"]:
            skill = by_slug[portable["slug"]]
            dependencies = [by_slug[slug]["id"] for slug in portable["dependencySlugs"]]
            if skill["id"] in inserted:
                for dependency in dependencies:
                    await connection.execute("INSERT INTO skill_dependencies(skill_id,depends_on_skill_id) VALUES (%s,%s)", (skill["id"], dependency))
            else:
                rows = await _rows(connection, "SELECT depends_on_skill_id FROM skill_dependencies WHERE skill_id=%s LIMIT 65", (skill["id"],))
                if {row["depends_on_skill_id"] for row in rows} != set(dependencies):
                    raise ControlError(409, "employee_import_skill_dependencies_conflict")
            await connection.execute("INSERT INTO employee_skills(bot_id,skill_id,state,source,confidence,evidence,acquired_at,updated_at) VALUES (%s,%s,'candidate','imported',0,%s,%s,%s)",
                (bot_id, skill["id"], Jsonb([{"kind": "import", "id": payload["packageId"], "label": "Reviewed Employee package"}]), now, now))
        await connection.execute("INSERT INTO employee_evolution_events(id,bot_id,type,title,summary,source,source_id,evidence,created_at) VALUES (%s,%s,'imported','Employee imported',%s,'import',%s,%s,%s)",
            (str(uuid4()), bot_id, name + " was activated from an Owner-reviewed portable package.", payload["packageId"], Jsonb([{"kind": "import", "id": payload["packageId"], "label": package_digest}]), now))
        await connection.execute("INSERT INTO run_events(id,bot_id,type,payload,created_at) VALUES (%s,%s,'BOT_IMPORTED',%s,%s)",
            (str(uuid4()), bot_id, Jsonb({"packageId": payload["packageId"], "packageDigest": package_digest, "importedSkillCount": len(payload["skills"])}), now))
        cursor = await connection.execute(
            "INSERT INTO employee_import_receipts(id,package_id,package_digest,employee_id,idempotency_key,request_fingerprint,signature_status,publisher_key_id,reviewed_by,reviewed_at,imported_skill_count,created_at) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'owner',%s,%s,%s) RETURNING *",
            (str(uuid4()), payload["packageId"], package_digest, bot_id, value.idempotencyKey, fingerprint,
             "dsse" if trusted is not None else "unsigned", trusted, now, len(payload["skills"]), now))
        return {"employee": project_bot(bot).model_dump(mode="json", exclude_none=True), "receipt": _receipt(await cursor.fetchone()), "replayed": False}
