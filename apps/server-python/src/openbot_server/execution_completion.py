"""Atomic publication with retained artifacts, reviewed references and Owner corrections."""
from dataclasses import dataclass
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb

from .database import StoreUnavailable
from .execution_scope import active_chain
from .execution_values import KnowledgeReference, SkillReference, validate_artifacts, validate_proposal
from .identity_inputs import _ECMASCRIPT_WHITESPACE
from .message_models import Message, project_messages
from .run_command_store import RunCommandConflict, read_steering
from .run_query import read_run_records
from .runtime_ports import RuntimeDenied
from .task_models import Run


class PendingSteering(Exception):
    """A committed Owner correction was not applied; publication must remain provisional."""


@dataclass(frozen=True)
class CompletedRun:
    run: Run
    message: Message
    artifacts: tuple


def reference(model, value):
    return model.model_validate(value.model_dump() if isinstance(value, model) else value)


async def complete(transactions, run, text, *, artifacts=(), proposal=None, references=(),
                   skill_references=(), applied_steering_ids=()):
    from .execution_store import audit, timestamp
    try:
        if type(text) is not str or not text.strip(_ECMASCRIPT_WHITESPACE) or '\0' in text or len(text.encode('utf-16-le'))//2>8000:
            raise ValueError()
        text.encode('utf-8')
        if len(references)>8 or len(skill_references)>2 or len(applied_steering_ids)>8:
            raise RuntimeDenied('task_limit')
        records = validate_artifacts(run.id,artifacts)
        draft = None if proposal is None else validate_proposal(proposal)
        memories = [reference(KnowledgeReference,item) for item in references]
        skills = [reference(SkillReference,item) for item in skill_references]
        if len({ref.id for ref in skills}) != len(skills):
            raise RuntimeDenied('task_limit')
        if any(type(value) is not str or not 1<=len(value)<=128 for value in applied_steering_ids):
            raise ValueError()
    except (ValueError,TypeError,KeyError,AttributeError):
        raise RuntimeDenied('invalid_target') from None
    try:
        async with transactions.transaction() as connection:
            await connection.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,731))',(run.channelId,))
            await active_chain(connection,run,target_update=True)
            cursor = await connection.execute("SELECT id FROM runs WHERE channel_id=%s AND status IN ('running','queued') "
                "AND (root_run_id=%s OR parent_run_id=%s) LIMIT 1",(run.channelId,run.id,run.id))
            if await cursor.fetchone():
                raise RunCommandConflict('Delegated tasks must finish before their parent completes.')
            instructions = await read_steering(connection,{'id':run.id,'channel_id':run.channelId,'bot_id':run.botId})
            if any(item.id not in applied_steering_ids for item in instructions):
                raise PendingSteering()
            if skills:
                cursor = await connection.execute(
                    "SELECT s.id,es.revision,s.content_sha256 AS sha256 FROM employee_skills es JOIN skills s ON s.id=es.skill_id "
                    "WHERE es.bot_id=%s AND s.id=ANY(%s) AND es.state='verified' AND s.content_sha256 IS NOT NULL "
                    "AND es.reviewed_content_sha256=s.content_sha256 AND s.required_capabilities='[]'::jsonb "
                    "AND NOT EXISTS (SELECT 1 FROM skill_dependencies WHERE skill_id=s.id) ORDER BY s.id COLLATE \"C\" FOR SHARE OF es,s",
                    (run.botId,[ref.id for ref in skills]))
                found = await cursor.fetchall()
                if any(not any(row['id']==ref.id and row['revision']==ref.revision and row['sha256']==ref.sha256 for row in found) for ref in skills):
                    raise RuntimeDenied('skills_changed')
            if memories:
                cursor = await connection.execute("SELECT id,revision FROM employee_memories WHERE bot_id=%s AND id=ANY(%s) "
                    "AND model_use_enabled=true AND sensitivity IN ('public','internal') "
                    "AND kind IN ('working','semantic','episodic','procedural') ORDER BY id COLLATE \"C\" FOR SHARE",
                    (run.botId,[ref.id for ref in memories]))
                found = await cursor.fetchall()
                if any(not any(row['id']==ref.id and row['revision']==ref.revision for row in found) for ref in memories):
                    raise RuntimeDenied('memory_changed')
            if instructions:
                await audit(connection,run,'RUN_STEERING_APPLIED',{'instructionIds':[item.id for item in instructions],'executor':'native-agent'})
            cursor = await connection.execute("UPDATE runs SET status='completed',result_summary=%s,"
                "updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=%s RETURNING updated_at",(text,run.id))
            now = (await cursor.fetchone())['updated_at']
            cursor = await connection.execute("INSERT INTO messages(id,channel_id,author_type,author_id,reply_to_message_id,run_id,content,created_at) "
                "SELECT %s,channel_id,'bot',bot_id,source_message_id,id,%s,%s FROM runs WHERE id=%s RETURNING *",
                (str(uuid4()),text,now,run.id))
            message = project_messages([await cursor.fetchone()])[0]
            if draft is not None:
                # Serialize pending proposals across channels for this Bot. Optional saturation
                # does not undo a completed task or activate unreviewed memory.
                await connection.execute('SELECT id FROM bots WHERE id=%s FOR UPDATE',(run.botId,))
                cursor = await connection.execute("SELECT id FROM knowledge_proposals WHERE bot_id=%s AND status='pending' LIMIT 50",(run.botId,))
                if len(await cursor.fetchall())>=50:
                    await audit(connection,run,'KNOWLEDGE_PROPOSAL_SKIPPED',{'executor':'native-agent','reason':'pending_limit'})
                else:
                    identity = str(uuid4())
                    await connection.execute('INSERT INTO knowledge_proposals(id,bot_id,source_run_id,kind,title,content,created_at) '
                        'VALUES (%s,%s,%s,%s,%s,%s,%s)',(identity,run.botId,run.id,draft['kind'],draft['title'],draft['content'],now))
                    await audit(connection,run,'KNOWLEDGE_PROPOSED',{'executor':'native-agent','proposalId':identity})
            for record in records:
                value = record.artifact
                await connection.execute('INSERT INTO artifacts(id,run_id,name,media_type,storage_key,sha256,metadata,created_at) '
                    'VALUES (%s,%s,%s,%s,%s,%s,%s,%s)',(value.id,run.id,value.name,value.mediaType,record.storageKey,value.sha256,
                        Jsonb({**record.metadata,'sizeBytes':value.sizeBytes}),timestamp(value.createdAt)))
            await audit(connection,run,'MESSAGE_CREATED',{'messageId':message.id})
            await audit(connection,run,'RUN_COMPLETED',{'executor':'native-agent','summary':text,'artifactIds':[r.artifact.id for r in records]})
            projected = (await read_run_records(connection,[run.id]))[run.id]
            return CompletedRun(projected,message,tuple(record.artifact for record in records))
    except (psycopg.Error,ValueError,TypeError,KeyError):
        raise StoreUnavailable('execution_storage_unavailable') from None
