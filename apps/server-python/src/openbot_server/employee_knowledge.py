"""Owner-only PostgreSQL Employee knowledge and complete profile projection.

Translated from OpenBot's MIT TypeScript store. Employee learning is inspired by Hermes Agent.
All mutation, provenance and content-free audit rows commit under the shared Owner session lock.
Skills and proposals remain candidates until explicit Owner review; they never grant authority.
"""
from datetime import datetime
from functools import wraps
import json
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb
from pydantic import BaseModel

from .authority import OwnerTransactions
from .control_errors import ControlError
from .database import StoreUnavailable
from .employee_knowledge_inputs import (
    MEMORY_FIELDS, KnowledgeProposalInput, memory_policy, parse_memory_create,
    parse_memory_delete, parse_memory_update, parse_proposal_review, parse_skill_create,
    parse_skill_document, parse_skill_import, parse_skill_state,
)
from .identity_inputs import _ECMASCRIPT_WHITESPACE
from .models import iso_timestamp, project_bot
from .task_models import project_run

_MAX_BYTES = 4 * 1024 * 1024


def _guard(function):
    @wraps(function)
    async def run(*args, **kwargs):
        try:
            return await function(*args, **kwargs)
        except (psycopg.Error, TimeoutError, KeyError, UnicodeError):
            raise StoreUnavailable("employee_knowledge_storage_unavailable") from None
    return run


def _input(value):
    return value.model_dump(exclude_none=True) if isinstance(value, BaseModel) else value


def _iso(value):
    return iso_timestamp(datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else value)


def _timestamps(row):
    return {key: datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) and key in ("created_at", "updated_at") else value for key, value in row.items()}


def _strings(value):
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def _evidence(value):
    if not isinstance(value, list):
        return []
    return [{"kind": item["kind"], "id": item["id"], **({"label": item["label"]} if isinstance(item.get("label"), str) else {})}
            for item in value if isinstance(item, dict) and item.get("kind") in ("run", "artifact", "approval", "manual", "import") and isinstance(item.get("id"), str)]


def _merge_evidence(old, new):
    merged = {}
    for item in [*_evidence(old), *new]:
        key = (item["kind"], item["id"])
        merged.pop(key, None)
        merged[key] = item
    return list(merged.values())[-64:]


def _evolution(row):
    return {"id": row["id"], "botId": row["bot_id"], "type": row["type"], "title": row["title"],
            "summary": row["summary"], "source": row["source"],
            **({"sourceId": row["source_id"]} if row.get("source_id") is not None else {}),
            "evidence": _evidence(row["evidence"]), "createdAt": _iso(row["created_at"])}


def _skill(skill, assignment, dependencies):
    result = {"id": skill["id"], "slug": skill["slug"], "name": skill["name"], "description": skill["description"],
              "version": skill["version"], "source": assignment["source"], "state": assignment["state"],
              "confidence": assignment["confidence"], "requiredCapabilities": _strings(skill["required_capabilities"]),
              "dependencyIds": dependencies, "evidence": _evidence(assignment["evidence"]),
              "acquiredAt": _iso(assignment["acquired_at"]), "updatedAt": _iso(assignment["updated_at"])}
    if skill.get("skill_markdown") and skill.get("content_sha256"):
        result.update(skillMarkdown=skill["skill_markdown"], contentSha256=skill["content_sha256"],
                      modelUseEnabled=assignment["state"] == "verified" and assignment.get("reviewed_content_sha256") == skill["content_sha256"])
    return result


def _memory(row):
    return {"id": row["id"], "botId": row["bot_id"], "kind": row["kind"], "title": row["title"], "content": row["content"],
            "sensitivity": row["sensitivity"], "portability": row["portability"],
            "provenance": row["provenance"] if isinstance(row["provenance"], dict) else {},
            "modelUseEnabled": row["model_use_enabled"], "revision": row["revision"],
            "createdAt": _iso(row["created_at"]), "updatedAt": _iso(row["updated_at"])}


def _memory_event(row):
    return {"id": row["id"], "botId": row["bot_id"], "memoryId": row["memory_id"], "action": row["action"],
            "revision": row["revision"], "changedFields": [field for field in _strings(row["changed_fields"]) if field in MEMORY_FIELDS],
            "actor": "owner", "createdAt": _iso(row["created_at"])}


def _approval(row, bot_id):
    result = {"id": row["id"], "runId": row["run_id"], "channelId": row["channel_id"], "botId": bot_id,
              "nodeId": row["node_id"], "action": row["action"], "target": row["target"], "summary": row["summary"],
              "risk": row["risk"], "targetFingerprint": row["target_fingerprint"],
              "beforeState": row["before_state"] if isinstance(row["before_state"], dict) else {},
              "status": row["status"], "expiresAt": _iso(row["expires_at"]), "createdAt": _iso(row["created_at"])}
    if row["decided_by"] is not None:
        result["decidedBy"] = row["decided_by"]
    if row["decided_at"] is not None:
        result["decidedAt"] = _iso(row["decided_at"])
    return result


def _artifact(row):
    metadata = row["metadata"] if isinstance(row["metadata"], dict) else {}
    size = metadata.get("sizeBytes")
    return {"id": row["id"], "runId": row["run_id"], "name": row["name"], "mediaType": row["media_type"],
            "sha256": row["sha256"], "sizeBytes": size if type(size) in (float, int) else 0, "createdAt": _iso(row["created_at"])}


def _decisions(rows):
    output = []
    for row in rows:
        payload = row["payload"] if isinstance(row["payload"], dict) else {}
        if row["run_id"] is None or row["channel_id"] is None or not isinstance(payload.get("stage"), str) or not isinstance(payload.get("message"), str):
            continue
        output.append({"id": row["id"], "runId": row["run_id"], "channelId": row["channel_id"],
                       **({"nodeId": row["node_id"]} if row.get("node_id") is not None else {}),
                       "stage": payload["stage"], "message": payload["message"], "summary": payload["message"],
                       "createdAt": _iso(row["created_at"])})
    return output


async def _rows(connection, query, parameters=(), *, limit=_MAX_BYTES):
    # Queries are local constants. Measure bounded result rows inside PostgreSQL before transfer;
    # a corrupt oversized stored field cannot allocate an unbounded client JSON/text value.
    cursor = await connection.execute(
        "WITH selected AS MATERIALIZED (" + query + "), documents AS MATERIALIZED "
        "(SELECT to_jsonb(selected) AS body FROM selected), sized AS "
        "(SELECT body, sum(octet_length(body::text)::bigint) OVER () AS total FROM documents) "
        "SELECT total>%s AS oversized, CASE WHEN total<=%s THEN body ELSE NULL END AS body FROM sized",
        (*parameters, limit, limit))
    rows = await cursor.fetchall()
    if any(row["oversized"] for row in rows):
        raise StoreUnavailable("employee_knowledge_projection_limit")
    return [row["body"] for row in rows]


async def _one(connection, query, parameters=(), *, missing="employee_not_found"):
    rows = await _rows(connection, query, parameters)
    if not rows:
        raise ControlError(404, missing)
    return rows[0]


async def _now(connection):
    return (await (await connection.execute("SELECT date_trunc('milliseconds', clock_timestamp()) AS now")).fetchone())["now"]


async def _write_evolution(connection, bot_id, kind, title, reason, source, source_id, evidence, now):
    cursor = await connection.execute(
        "INSERT INTO employee_evolution_events(id,bot_id,type,title,summary,source,source_id,evidence,created_at) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *",
        (str(uuid4()), bot_id, kind, title, reason, source, source_id, Jsonb(evidence), now))
    return _evolution(await cursor.fetchone())


async def _write_memory_event(connection, bot_id, memory_id, action, revision, fields, now):
    cursor = await connection.execute(
        "INSERT INTO employee_memory_events(id,bot_id,memory_id,action,revision,changed_fields,actor,created_at) "
        "VALUES (%s,%s,%s,%s,%s,%s,'owner',%s) RETURNING *",
        (str(uuid4()), bot_id, memory_id, action, revision, Jsonb(fields), now))
    return _memory_event(await cursor.fetchone())


async def _insert_memory(connection, bot_id, value, provenance, now):
    cursor = await connection.execute(
        "INSERT INTO employee_memories(id,bot_id,kind,title,content,sensitivity,portability,model_use_enabled,provenance,revision,created_at,updated_at) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,1,%s,%s) RETURNING *",
        (str(uuid4()), bot_id, value["kind"], value["title"], value["content"], value["sensitivity"],
         value["portability"], value.get("modelUseEnabled", False), Jsonb(provenance), now, now))
    return _memory(await cursor.fetchone())


class PostgresEmployeeKnowledge:
    def __init__(self, dsn: str):
        self._transactions = OwnerTransactions(dsn, application_name="openbot-control-knowledge")

    async def verify_schema(self):
        await self._transactions.verify_schema()

    @_guard
    async def profile(self, token, bot_id):
        async with self._transactions.transaction(token) as connection:
            bot = await _one(connection, "SELECT * FROM bots WHERE id=%s", (bot_id,))
            evolution = await _rows(connection, "SELECT * FROM employee_evolution_events WHERE bot_id=%s ORDER BY created_at DESC,id DESC LIMIT 100", (bot_id,))
            skills = await _rows(connection, "SELECT to_jsonb(s) AS skill,to_jsonb(e) AS assignment FROM employee_skills e JOIN skills s ON s.id=e.skill_id WHERE e.bot_id=%s ORDER BY e.updated_at DESC,s.id DESC LIMIT 100", (bot_id,))
            # At most 100 selected assignments with 64 dependencies each; no omitted assignment
            # contributes to the profile. A malformed oversized legacy dependency graph fails closed.
            dependencies = await _rows(connection, "SELECT skill_id,depends_on_skill_id FROM skill_dependencies WHERE skill_id=ANY(%s) ORDER BY skill_id,depends_on_skill_id LIMIT 6401", ([item["skill"]["id"] for item in skills],))
            if len(dependencies) > 6400:
                raise StoreUnavailable("employee_knowledge_projection_limit")
            dependency_map = {}
            for row in dependencies:
                dependency_map.setdefault(row["skill_id"], []).append(row["depends_on_skill_id"])
            memories = await _rows(connection, "SELECT * FROM employee_memories WHERE bot_id=%s ORDER BY updated_at DESC,id DESC LIMIT 100", (bot_id,))
            events = await _rows(connection, "SELECT * FROM employee_memory_events WHERE bot_id=%s ORDER BY created_at DESC,id DESC LIMIT 200", (bot_id,))
            runs = await _rows(connection, "SELECT * FROM runs_work_projection WHERE bot_id=%s ORDER BY created_at DESC,id DESC LIMIT 50", (bot_id,))
            approvals = await _rows(connection, "SELECT a.*,r.channel_id FROM approvals a JOIN runs r ON r.id=a.run_id WHERE r.bot_id=%s ORDER BY a.created_at DESC,a.id DESC LIMIT 100", (bot_id,))
            artifacts = await _rows(connection, "SELECT a.* FROM artifacts a JOIN runs r ON r.id=a.run_id WHERE r.bot_id=%s ORDER BY a.created_at DESC,a.id DESC LIMIT 100", (bot_id,))
            progress = await _rows(connection, "SELECT * FROM run_events WHERE bot_id=%s AND type='RUN_PROGRESS' ORDER BY created_at DESC,id DESC LIMIT 200", (bot_id,))
            projected_skills = [_skill(item["skill"], item["assignment"], dependency_map.get(item["skill"]["id"], [])) for item in skills]
            projected_runs = [project_run(_timestamps(row)).model_dump(mode="json", exclude_none=True) for row in runs]
            result = {"employee": project_bot(_timestamps(bot)).model_dump(mode="json", exclude_none=True),
                      "details": {"description": bot["description"], "revision": bot["profile_revision"], "updatedAt": _iso(bot["updated_at"])},
                      "evolution": [_evolution(row) for row in evolution], "skills": projected_skills,
                      "memories": [_memory(row) for row in memories], "memoryEvents": [_memory_event(row) for row in events],
                      "records": {"runs": projected_runs, "approvals": [_approval(row, bot_id) for row in approvals],
                                  "artifacts": [_artifact(row) for row in artifacts], "decisions": _decisions(progress)},
                      "statistics": {"totalRuns": len(projected_runs), "completedRuns": sum(row["status"] == "completed" for row in projected_runs),
                                     "failedRuns": sum(row["status"] == "failed" for row in projected_runs),
                                     "verifiedSkills": sum(row["state"] == "verified" for row in projected_skills)},
                      "configuration": {"executionProfile": bot["computer_profile"], "portabilityFormat": "openbot.employee/v1"}}
            if result["employee"].get("model") is not None:
                result["configuration"]["model"] = result["employee"]["model"]
            if len(json.dumps(result, ensure_ascii=False).encode()) > _MAX_BYTES:
                raise StoreUnavailable("employee_knowledge_projection_limit")
            return result

    @_guard
    async def create_skill(self, token, bot_id, value):
        value = parse_skill_create(_input(value)).model_dump(exclude_none=True)
        document = parse_skill_document(value["skillMarkdown"]) if "skillMarkdown" in value else None
        if document and (document["name"] != value["slug"] or document["description"] != value["description"] or value["requiredCapabilities"] or value["dependencySkillIds"]):
            raise ControlError(422, "skill_content_metadata_mismatch")
        async with self._transactions.transaction(token) as connection:
            await _one(connection, "SELECT id FROM bots WHERE id=%s FOR UPDATE", (bot_id,))
            dependencies = value["dependencySkillIds"]
            if dependencies:
                assigned = await _rows(connection, "SELECT skill_id,state FROM employee_skills WHERE bot_id=%s AND skill_id=ANY(%s) ORDER BY skill_id FOR SHARE", (bot_id, dependencies))
                if len(assigned) != len(dependencies) or any(item["state"] != "verified" for item in assigned):
                    raise ControlError(422, "skill_dependencies_not_verified")
            now = await _now(connection)
            cursor = await connection.execute(
                "INSERT INTO skills(id,slug,name,description,version,source,required_capabilities,metadata,skill_markdown,content_sha256,created_at,updated_at) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(slug,version) DO NOTHING RETURNING *",
                (str(uuid4()), value["slug"], value["name"], value["description"], value["version"], value["source"],
                 Jsonb(value["requiredCapabilities"]), Jsonb({"format": "agentskills.io"}),
                 document["markdown"] if document else None, document["sha256"] if document else None, now, now))
            skill = await cursor.fetchone()
            if skill is not None:
                for dependency in dependencies:
                    await connection.execute("INSERT INTO skill_dependencies(skill_id,depends_on_skill_id) VALUES (%s,%s)", (skill["id"], dependency))
            else:
                skill = await _one(connection, "SELECT * FROM skills WHERE slug=%s AND version=%s FOR SHARE", (value["slug"], value["version"]), missing="skill_not_found")
                existing = await _rows(connection, "SELECT depends_on_skill_id FROM skill_dependencies WHERE skill_id=%s LIMIT 65", (skill["id"],))
                if (skill["skill_markdown"] != (document["markdown"] if document else None)
                        or any(skill[key] != value[key] for key in ("name", "description", "source"))
                        or set(_strings(skill["required_capabilities"])) != set(value["requiredCapabilities"])
                        or {row["depends_on_skill_id"] for row in existing} != set(dependencies)):
                    raise ControlError(409, "skill_definition_conflict")
            cursor = await connection.execute(
                "INSERT INTO employee_skills(bot_id,skill_id,state,source,confidence,evidence,acquired_at,updated_at) "
                "VALUES (%s,%s,'candidate',%s,0,%s,%s,%s) ON CONFLICT(bot_id,skill_id) DO NOTHING RETURNING *",
                (bot_id, skill["id"], value["source"], Jsonb(value["evidence"]), now, now))
            assignment = await cursor.fetchone()
            if assignment is None:
                raise ControlError(409, "skill_already_assigned")
            evolution = await _write_evolution(connection, bot_id, "skill_discovered", "Candidate skill added", value["reason"],
                                               "import" if value["source"] == "imported" else "manual", skill["id"], value["evidence"], now)
            return {"skill": _skill(skill, assignment, dependencies), "evolution": evolution}

    async def import_skill(self, token, bot_id, value):
        value = parse_skill_import(_input(value))
        document = parse_skill_document(value.markdown)
        return await self.create_skill(token, bot_id, {"slug": document["name"], "name": document["name"],
            "description": document["description"], "version": value.version, "source": "manual",
            "reason": value.reason, "skillMarkdown": document["markdown"]})

    @_guard
    async def set_skill_state(self, token, bot_id, skill_id, value):
        value = parse_skill_state(_input(value)).model_dump(exclude_none=True)
        async with self._transactions.transaction(token) as connection:
            await _one(connection, "SELECT id FROM bots WHERE id=%s FOR UPDATE", (bot_id,))
            record = await _one(connection, "SELECT to_jsonb(s) AS skill,to_jsonb(e) AS assignment FROM employee_skills e JOIN skills s ON s.id=e.skill_id WHERE e.bot_id=%s AND e.skill_id=%s FOR UPDATE OF e FOR SHARE OF s", (bot_id, skill_id), missing="employee_skill_not_found")
            skill, current = record["skill"], record["assignment"]
            state = value["state"]
            if state == "verified" and skill["content_sha256"] and value.get("reviewedContentSha256") != skill["content_sha256"]:
                raise ControlError(409, "skill_digest_review_required")
            allowed = {"candidate": ("verified", "suspended", "revoked"), "verified": ("suspended", "revoked"), "suspended": ("verified", "revoked"), "revoked": ()}
            if state not in allowed.get(current["state"], ()):
                raise ControlError(409, "skill_state_conflict")
            dependencies = await _rows(connection, "SELECT depends_on_skill_id FROM skill_dependencies WHERE skill_id=%s ORDER BY depends_on_skill_id LIMIT 65", (skill_id,))
            if len(dependencies) > 64:
                raise StoreUnavailable("employee_knowledge_projection_limit")
            ids = [row["depends_on_skill_id"] for row in dependencies]
            if state == "verified" and ids:
                assigned = await _rows(connection, "SELECT skill_id,state FROM employee_skills WHERE bot_id=%s AND skill_id=ANY(%s) ORDER BY skill_id FOR SHARE", (bot_id, ids))
                if len(assigned) != len(ids) or any(item["state"] != "verified" for item in assigned):
                    raise ControlError(422, "skill_dependencies_not_verified")
            now = await _now(connection)
            cursor = await connection.execute(
                "UPDATE employee_skills SET state=%s,revision=revision+1,reviewed_content_sha256=%s,confidence=%s,evidence=%s,updated_at=%s "
                "WHERE bot_id=%s AND skill_id=%s AND revision=%s RETURNING *",
                (state, skill["content_sha256"] if state == "verified" else None,
                 value["confidence"] if state == "verified" else current["confidence"], Jsonb(_merge_evidence(current["evidence"], value["evidence"])), now, bot_id, skill_id, current["revision"]))
            assignment = await cursor.fetchone()
            if assignment is None:
                raise ControlError(409, "skill_state_conflict")
            evolution = await _write_evolution(connection, bot_id, f"skill_{state}", f"Skill {state}", value["reason"], "manual", skill_id, value["evidence"], now)
            return {"skill": _skill(skill, assignment, ids), "evolution": evolution}

    @_guard
    async def create_memory(self, token, bot_id, value):
        value = parse_memory_create(_input(value)).model_dump(exclude_none=True)
        async with self._transactions.transaction(token) as connection:
            await _one(connection, "SELECT id FROM bots WHERE id=%s FOR SHARE", (bot_id,))
            now = await _now(connection)
            memory = await _insert_memory(connection, bot_id, value, {"source": "owner", "actor": "owner"}, now)
            event = await _write_memory_event(connection, bot_id, memory["id"], "created", 1,
                                             [key for key in MEMORY_FIELDS if key in value], now)
            return {"memory": memory, "event": event}

    @_guard
    async def update_memory(self, token, bot_id, memory_id, value):
        value = parse_memory_update(_input(value)).model_dump(exclude_none=True)
        async with self._transactions.transaction(token) as connection:
            current = _memory(await _one(connection, "SELECT * FROM employee_memories WHERE bot_id=%s AND id=%s FOR UPDATE", (bot_id, memory_id), missing="employee_memory_not_found"))
            if current["revision"] != value["expectedRevision"]:
                raise ControlError(409, "memory_revision_conflict")
            merged = {key: value.get(key, current[key]) for key in MEMORY_FIELDS}
            for field in ("title", "content"):
                merged[field] = merged[field].strip(_ECMASCRIPT_WHITESPACE)
            # Validate merged policy: an omitted modelUseEnabled cannot bypass sensitivity changes.
            memory_policy(merged)
            fields = [key for key in MEMORY_FIELDS if current[key] != merged[key]]
            if not fields:
                raise ControlError(422, "memory_unchanged")
            now = await _now(connection)
            cursor = await connection.execute(
                "UPDATE employee_memories SET kind=%s,title=%s,content=%s,sensitivity=%s,portability=%s,model_use_enabled=%s,revision=revision+1,updated_at=%s "
                "WHERE bot_id=%s AND id=%s AND revision=%s RETURNING *",
                (*[merged[key] for key in MEMORY_FIELDS], now, bot_id, memory_id, value["expectedRevision"]))
            row = await cursor.fetchone()
            if row is None:
                raise ControlError(409, "memory_revision_conflict")
            memory = _memory(row)
            event = await _write_memory_event(connection, bot_id, memory_id, "updated", memory["revision"], fields, now)
            return {"memory": memory, "event": event}

    @_guard
    async def delete_memory(self, token, bot_id, memory_id, value):
        value = parse_memory_delete(_input(value))
        async with self._transactions.transaction(token) as connection:
            current = await _one(connection, "SELECT revision FROM employee_memories WHERE bot_id=%s AND id=%s FOR UPDATE", (bot_id, memory_id), missing="employee_memory_not_found")
            if current["revision"] != value.expectedRevision:
                raise ControlError(409, "memory_revision_conflict")
            cursor = await connection.execute("DELETE FROM employee_memories WHERE bot_id=%s AND id=%s AND revision=%s RETURNING id", (bot_id, memory_id, value.expectedRevision))
            if await cursor.fetchone() is None:
                raise ControlError(409, "memory_revision_conflict")
            event = await _write_memory_event(connection, bot_id, memory_id, "deleted", current["revision"] + 1, [], await _now(connection))
            return {"memoryId": memory_id, "event": event}

    @_guard
    async def proposals(self, token, bot_id):
        async with self._transactions.transaction(token) as connection:
            await _one(connection, "SELECT id FROM bots WHERE id=%s", (bot_id,))
            rows = await _rows(connection, "SELECT * FROM knowledge_proposals WHERE bot_id=%s AND status='pending' ORDER BY created_at ASC,id ASC LIMIT 50", (bot_id,))
            return [{**KnowledgeProposalInput.model_validate({key: row[key] for key in ("kind", "title", "content")}).model_dump(),
                     "id": row["id"], "botId": row["bot_id"], **(await _proposal_source(connection,row)), "createdAt": _iso(row["created_at"])} for row in rows]

    @_guard
    async def review_proposal(self, token, bot_id, proposal_id, value):
        value = parse_proposal_review(_input(value)).model_dump(exclude_none=True)
        async with self._transactions.transaction(token) as connection:
            native = await _one(connection, "SELECT source_kind,source_work_run_id FROM knowledge_proposals WHERE bot_id=%s AND id=%s", (bot_id,proposal_id), missing="knowledge_proposal_not_found")
            if native['source_kind']=='task':
                from .work_native_knowledge import review_proposal
                return await review_proposal(connection,bot_id,proposal_id,value)
            proposal = await _one(connection, "SELECT * FROM knowledge_proposals WHERE bot_id=%s AND id=%s FOR UPDATE", (bot_id, proposal_id), missing="knowledge_proposal_not_found")
            if proposal["status"] != "pending":
                raise ControlError(409, "knowledge_proposal_already_reviewed")
            source = await _one(connection, "SELECT channel_id FROM runs WHERE id=%s AND bot_id=%s", (proposal["source_run_id"], bot_id), missing="source_task_not_found")
            now = await _now(connection)
            memory_id = None
            if value["decision"] == "accept":
                draft = KnowledgeProposalInput.model_validate({"kind": proposal["kind"], "title": value["title"], "content": value["content"]}).model_dump()
                draft.update(sensitivity="internal", portability="never", modelUseEnabled=value["modelUseEnabled"])
                memory = await _insert_memory(connection, bot_id, draft,
                    {"source": "reviewed-agent-proposal", "actor": "owner", "proposalId": proposal_id, "sourceRunId": proposal["source_run_id"]}, now)
                memory_id = memory["id"]
                await _write_memory_event(connection, bot_id, memory_id, "created", 1, list(MEMORY_FIELDS), now)
            await connection.execute("UPDATE knowledge_proposals SET status=%s,title='',content='',memory_id=%s,reviewed_at=%s WHERE id=%s", ("accepted" if value["decision"] == "accept" else "rejected", memory_id, now, proposal_id))
            await connection.execute("INSERT INTO run_events(id,run_id,bot_id,channel_id,type,payload,created_at) VALUES (%s,%s,%s,%s,'KNOWLEDGE_PROPOSAL_REVIEWED',%s,%s)",
                (str(uuid4()), proposal["source_run_id"], bot_id, source["channel_id"], Jsonb({"actor": "owner", "proposalId": proposal_id, "decision": value["decision"], "memoryId": memory_id}), now))
            return {"proposalId": proposal_id, "decision": value["decision"], "memoryId": memory_id}


async def _proposal_source(db,row):
    if row['source_kind']=='channel': return dict(sourceRunId=row['source_run_id'])
    run=await (await db.execute('SELECT task_id FROM work_runs WHERE id=%s',(row['source_work_run_id'],))).fetchone()
    if run is None: raise StoreUnavailable('knowledge_proposal_source_missing')
    return dict(source=dict(kind='task',taskId=run['task_id'],runId=row['source_work_run_id']))
