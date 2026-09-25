"""Bounded PostgreSQL knowledge reads for an already accepted Work Activity.

Reuses OpenBot's reviewed recent-record selection, skill parser and proposal validation.
S5 contributes typed receipts and fresh revalidation, not its synthetic CSV ranking/scope.
Employee learning remains inspired by Hermes Agent. See RESEARCH.md and RESULT.md.
"""
from contextlib import asynccontextmanager
from dataclasses import replace
from functools import wraps
import inspect
import re
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb

from .authority import PostgresTransactions
from .database import StoreUnavailable
from .control_errors import ControlError
from .employee_knowledge import _rows
from .employee_knowledge_inputs import parse_skill_document, sensitive_text
from .execution_values import bounded_text, validate_proposal
from .knowledge_runtime_values import (
    KnowledgeContext, KnowledgeReceipt, KnowledgeSelection, KnowledgeTarget,
    KnowledgeUnavailable, MemoryVersion, PreparedMemoryProposal, SkillVersion,
    byte_size, digest, query_digest,
)

_MEMORY_ELIGIBLE = "bot_id=%s AND model_use_enabled AND kind IN ('working','semantic','episodic','procedural') AND sensitivity IN ('public','internal')"
_SKILL_SELECT = """SELECT s.id,s.slug,s.description,s.version,s.source,s.metadata,s.required_capabilities,
 s.skill_markdown,s.content_sha256,e.revision,e.reviewed_content_sha256,e.evidence,e.source AS assignment_source
 FROM employee_skills e JOIN skills s ON s.id=e.skill_id WHERE e.bot_id=%s AND e.state='verified'
 AND s.content_sha256 IS NOT NULL AND e.reviewed_content_sha256=s.content_sha256
 AND s.required_capabilities='[]'::jsonb
 AND NOT EXISTS(SELECT 1 FROM skill_dependencies d WHERE d.skill_id=s.id)"""


def _guard(function):
    @wraps(function)
    async def guarded(*args, **kwargs):
        try:
            return await function(*args, **kwargs)
        except (psycopg.Error, TimeoutError, UnicodeError):
            raise StoreUnavailable('knowledge_runtime_storage_unavailable') from None
    return guarded


def _memory_version(row):
    return MemoryVersion(row['id'], row['revision'], digest({key: row[key] for key in
        ('id','bot_id','kind','title','content','sensitivity','portability','provenance','model_use_enabled','revision')}))


def _skill_version(row):
    return SkillVersion(row['id'], row['revision'], row['content_sha256'],
                        row['reviewed_content_sha256'], digest(row))


def _skill_document(row):
    try:
        document = parse_skill_document(row['skill_markdown'])
    except (ControlError, TypeError, ValueError):
        raise KnowledgeUnavailable('skills_changed') from None
    if (document['sha256'] != row['content_sha256'] or document['name'] != row['slug']
            or document['description'] != row['description']):
        raise KnowledgeUnavailable('skills_changed')
    return document


def _descriptor(row):
    return dict(id=row['id'], name=row['slug'], description=row['description'],
                version=row['version'], revision=row['revision'], sha256=row['content_sha256'])


class PostgresKnowledgeRuntime:
    """Composition injects async ``binding_gate(db, context) -> True`` on every operation.

    The gate must revalidate the accepted Temporal Activity's current attempt/correction binding
    using the supplied transaction. Constructing KnowledgeContext is not authorization. Missing,
    false or non-async gates fail closed. No provider, filesystem or HTTP access exists here.
    """

    def __init__(self, dsn, *, binding_gate=None):
        self._transactions = PostgresTransactions(dsn, application_name='openbot-work-knowledge')
        self._binding_gate = binding_gate

    @asynccontextmanager
    async def _transaction(self):
        async with self._transactions.transaction() as db:
            yield db

    async def _binding(self, db, context):
        if type(context) is not KnowledgeContext or not callable(self._binding_gate):
            raise KnowledgeUnavailable('knowledge_binding_required')
        if context.channel_id is None:
            from .work_native_knowledge import binding
            return await binding(db,context,self._binding_gate)
        # work_sources is immutable. Match publication/cancellation's channel -> source -> Work
        # order; locking this mapping first would deadlock membership removal/publication.
        source = await (await db.execute('SELECT legacy_run_id,channel_id,source_message_id '
            'FROM work_sources WHERE task_id=%s', (context.task_id,))).fetchone()
        if not source or source['channel_id'] != context.channel_id:
            raise KnowledgeUnavailable('knowledge_binding_changed')
        channel = await (await db.execute('SELECT id FROM channels WHERE id=%s FOR KEY SHARE',
                                         (context.channel_id,))).fetchone()
        origin = await (await db.execute('SELECT bot_id,channel_id,source_message_id FROM runs '
            'WHERE id=%s FOR KEY SHARE', (source['legacy_run_id'],))).fetchone()
        task = await (await db.execute('SELECT bot_id,owner_id,status,authority_active,cancel_requested,'
            'authority_generation FROM work_tasks WHERE id=%s FOR SHARE', (context.task_id,))).fetchone()
        run = await (await db.execute('SELECT task_id,status,execution_epoch FROM work_runs '
            'WHERE id=%s FOR SHARE', (context.run_id,))).fetchone()
        member = await (await db.execute('SELECT 1 FROM channel_bots WHERE channel_id=%s AND bot_id=%s '
            'FOR SHARE', (context.channel_id, context.bot_id))).fetchone()
        message = await (await db.execute('SELECT channel_id FROM messages WHERE id=%s FOR KEY SHARE',
                                         (source['source_message_id'],))).fetchone()
        if (not channel or not origin or not task or not run or not member or not message
                or origin['bot_id'] != context.bot_id or origin['channel_id'] != context.channel_id
                or origin['source_message_id'] != source['source_message_id']
                or message['channel_id'] != context.channel_id or task['owner_id'] != 'owner'
                or task['bot_id'] != context.bot_id or run['task_id'] != context.task_id
                or task['status'] != 'open' or not task['authority_active'] or task['cancel_requested']
                or run['status'] != 'running' or run['execution_epoch'] < 1):
            raise KnowledgeUnavailable('knowledge_binding_changed')
        result = self._binding_gate(db, context)
        if not inspect.isawaitable(result):
            raise KnowledgeUnavailable('knowledge_binding_required')
        if await result is not True:
            raise KnowledgeUnavailable('knowledge_binding_changed')
        return KnowledgeTarget(context, source['legacy_run_id'], source['source_message_id'],
                               task['authority_generation'], run['execution_epoch'])

    async def _provenance(self, db, row):
        provenance = row['provenance']
        if not isinstance(provenance, dict):
            return False
        # Owner-created/imported knowledge retains its explicit Owner opt-in. Only the existing
        # reviewed-agent-proposal provenance claims a proposal/source relationship to verify.
        if provenance.get('source') == 'reviewed-work-proposal':
            from .work_native_knowledge import reviewed_provenance
            return await reviewed_provenance(db,row)
        if provenance.get('source') != 'reviewed-agent-proposal':
            return True
        source_id, proposal_id = provenance.get('sourceRunId'), provenance.get('proposalId')
        if not isinstance(source_id, str) or not isinstance(proposal_id, str):
            return False
        source = await (await db.execute('SELECT id,status FROM runs WHERE id=%s AND bot_id=%s '
            'FOR SHARE', (source_id, row['bot_id']))).fetchone()
        if not source:
            return False
        # Source Run deletion cascades proposals: lock its row first, then its terminal proposal.
        proposal = await (await db.execute("SELECT id FROM knowledge_proposals WHERE id=%s AND bot_id=%s "
            "AND source_run_id=%s AND memory_id=%s AND status='accepted' FOR SHARE",
            (proposal_id,row['bot_id'],source_id,row['id']))).fetchone()
        if not proposal:
            return False
        mapped = await (await db.execute('SELECT t.status FROM work_sources s JOIN work_tasks t '
            'ON t.id=s.task_id WHERE s.legacy_run_id=%s FOR SHARE OF t', (source_id,))).fetchone()
        return (mapped['status'] if mapped else source['status']) == 'completed'

    async def _memory_rows(self, db, bot_id, identities=None):
        if identities is None:
            suffix, parameters = ' ORDER BY updated_at DESC,id DESC LIMIT 9 FOR SHARE', (bot_id,)
        else:
            suffix, parameters = ' AND id=ANY(%s) ORDER BY id LIMIT 9 FOR SHARE', (bot_id, identities)
        rows = await _rows(db, 'SELECT * FROM employee_memories WHERE '+_MEMORY_ELIGIBLE+suffix, parameters)
        valid = []
        selected = rows[:8] if identities is None else rows
        for row in selected:
            if not sensitive_text(row['title']+'\n'+row['content']) and await self._provenance(db, row):
                valid.append(row)
        return valid, len(valid) != len(selected), len(rows) > 8

    async def _skill_rows(self, db, bot_id, identities=None):
        suffix = (' ORDER BY e.updated_at DESC,s.id DESC LIMIT 9 FOR SHARE OF e,s' if identities is None
                  else ' AND s.id=ANY(%s) ORDER BY s.id LIMIT 9 FOR SHARE OF e,s')
        rows = await _rows(db, _SKILL_SELECT+suffix, (bot_id,) if identities is None else (bot_id,identities))
        for row in rows:
            _skill_document(row)
        return rows

    async def _audit(self, db, target, kind, payload):
        if target.context.channel_id is None:
            from .work_native_knowledge import audit
            return await audit(db,target,kind,payload)
        await db.execute("INSERT INTO run_events(id,run_id,channel_id,bot_id,type,payload) "
            "VALUES (%s,%s,%s,%s,%s,%s)", (str(uuid4()),target.source_run_id,
            target.context.channel_id,target.context.bot_id,kind,Jsonb(dict(payload,
            executor='work-agent',taskId=target.context.task_id,workRunId=target.context.run_id))))

    @_guard
    async def candidates(self, context, query=''):
        """Current recent skill metadata for the model prompt; no markdown is loaded into it.

        query is bound to the receipt, never interpreted as a semantic relevance score.
        """
        query_sha = query_digest(query)
        async with self._transaction() as db:
            target = await self._binding(db, context)
            rows = await self._skill_rows(db, context.bot_id)
            items, versions, truncated = [], [], len(rows) > 8
            for row in rows[:8]:
                item = _descriptor(row)
                if byte_size([*items, item]) > 4096:
                    truncated = True
                    break
                items.append(item); versions.append(_skill_version(row))
            return KnowledgeSelection({'skills': items, 'truncated': truncated},
                KnowledgeReceipt(target, 'catalog', query_sha, skills=tuple(versions),schema=('openbot.work-knowledge/v2' if context.channel_id is None else 'openbot.work-knowledge/v1')))

    @_guard
    async def read_employee_memory(self, context):
        async with self._transaction() as db:
            target = await self._binding(db, context)
            rows, excluded, truncated = await self._memory_rows(db, context.bot_id)
            items, versions = [], []
            truncated = truncated or excluded
            for row in rows[:8]:
                item = dict(id=row['id'], revision=row['revision'], kind=row['kind'],
                    title=bounded_text(row['title'],640), content=bounded_text(row['content'],2000),
                    truncated=len(row['content'].encode()) > 2000)
                source_id = row['provenance'].get('sourceRunId')
                if isinstance(source_id,str) and len(source_id.encode("utf-16-le"))//2 <= 64:
                    item['sourceRunId'] = source_id
                if row['provenance'].get('source')=='reviewed-work-proposal':
                    item['source']=dict(kind='task',taskId=row['provenance']['sourceTaskId'],runId=row['provenance']['sourceWorkRunId'])
                if byte_size([*items,item]) > 10*1024:
                    truncated = True
                    break
                items.append(item); versions.append(_memory_version(row))
            await self._audit(db,target,'KNOWLEDGE_READ',dict(memories=[dict(id=v.id,revision=v.revision) for v in versions],truncated=truncated))
            return KnowledgeSelection({'memories':items,'truncated':truncated},
                KnowledgeReceipt(target,'memory',query_digest(''),memories=tuple(versions),schema=('openbot.work-knowledge/v2' if context.channel_id is None else 'openbot.work-knowledge/v1')))

    @_guard
    async def read_skill(self, context, catalog, skill_id):
        if type(catalog) is not KnowledgeReceipt or catalog.purpose != 'catalog':
            raise KnowledgeUnavailable('skill_catalog_required')
        self._validate_receipts((catalog,))
        references = [ref for ref in catalog.skills if ref.id == skill_id]
        if len(references) != 1:
            raise KnowledgeUnavailable('skill_not_selected')
        receipt = replace(catalog,purpose='skill',skills=tuple(references))
        async with self._transaction() as db:
            await self.revalidate_in_transaction(db,context,(receipt,))
            row = (await self._skill_rows(db,context.bot_id,[skill_id]))[0]
            await self._audit(db,receipt.target,'SKILL_READ',dict(id=row['id'],revision=row['revision'],sha256=row['content_sha256']))
            return KnowledgeSelection({**_descriptor(row),'markdown':_skill_document(row)['markdown']},receipt)

    @staticmethod
    def _validate_receipts(receipts):
        if type(receipts) not in (list,tuple) or len(receipts) > 32:
            raise KnowledgeUnavailable('invalid_knowledge_receipt')
        memories, skills, catalogs = {}, {}, {}
        for value in receipts:
            if (type(value) is not KnowledgeReceipt or type(value.target) is not KnowledgeTarget
                    or type(value.target.context) is not KnowledgeContext
                    or value.schema != ('openbot.work-knowledge/v2' if value.target.context.channel_id is None else 'openbot.work-knowledge/v1')
                    or (value.target.context.channel_id is None and (value.target.source_run_id is not None or value.target.source_message_id is not None))
                    or type(value.target) is not KnowledgeTarget or value.purpose not in ('catalog','memory','skill')
                    or type(value.query_sha256) is not str or re.fullmatch('[a-f0-9]{64}',value.query_sha256) is None
                    or type(value.memories) is not tuple or type(value.skills) is not tuple
                    or len(value.memories) > 8 or len(value.skills) > (8 if value.purpose == 'catalog' else 1)
                    or (value.memories and value.purpose != 'memory')
                    or (value.skills and value.purpose == 'memory')):
                raise KnowledgeUnavailable('invalid_knowledge_receipt')
            for references, kind, accumulated in ((value.memories,MemoryVersion,memories),
                    (value.skills,SkillVersion,catalogs if value.purpose=='catalog' else skills)):
                if any(type(ref) is not kind or type(ref.id) is not str or not 1<=len(ref.id)<=128
                       or type(ref.revision) is not int or ref.revision<1
                       or type(ref.fingerprint) is not str or re.fullmatch('[a-f0-9]{64}',ref.fingerprint) is None
                       for ref in references):
                    raise KnowledgeUnavailable('invalid_knowledge_receipt')
                if len({ref.id for ref in references}) != len(references):
                    raise KnowledgeUnavailable('invalid_knowledge_receipt')
                for ref in references:
                    if ref.id in accumulated and accumulated[ref.id] != ref:
                        raise KnowledgeUnavailable('knowledge_changed')
                    accumulated[ref.id] = ref
        if len(memories)>8 or len(skills)>2 or len(catalogs)>8:
            raise KnowledgeUnavailable('knowledge_read_limit')
        for identity, ref in skills.items():
            if identity in catalogs and catalogs[identity] != ref:
                raise KnowledgeUnavailable('knowledge_changed')
        return memories, {**catalogs,**skills}

    @_guard
    async def revalidate(self, context, receipts):
        async with self._transaction() as db:
            await self.revalidate_in_transaction(db,context,receipts)

    @_guard
    async def revalidate_in_transaction(self, db, context, receipts):
        """Hold current authorization and consumed record locks through the caller's commit.

        Invoke at model transmission admission and again before Work publication, before changing
        the Task/Run terminal state. A standalone revalidate() cannot authorize a later side effect.
        """
        memory_refs, skill_refs = self._validate_receipts(receipts)
        target = await self._binding(db,context)
        if any(receipt.target != target for receipt in receipts):
            raise KnowledgeUnavailable('knowledge_binding_changed')
        if memory_refs:
            rows, _, _ = await self._memory_rows(db,context.bot_id,sorted(memory_refs))
            if {row['id']:_memory_version(row) for row in rows} != memory_refs:
                raise KnowledgeUnavailable('memory_changed')
        if skill_refs:
            # A catalog (8) and two separately consumed skills can refer to ten distinct records.
            # Load sorted, bounded batches to retain deterministic row-lock order and exact checks.
            rows = []
            for identity in sorted(skill_refs):
                rows.extend(await self._skill_rows(db,context.bot_id,[identity]))
            if {row['id']:_skill_version(row) for row in rows} != skill_refs:
                raise KnowledgeUnavailable('skills_changed')

    @staticmethod
    async def _carry_target(db, original, current):
        if (type(original) is not KnowledgeTarget or type(original.execution_epoch) is not int
                or not 1 <= original.execution_epoch <= current.execution_epoch
                or replace(original,execution_epoch=current.execution_epoch) != current):
            raise KnowledgeUnavailable('knowledge_binding_changed')
        if not await (await db.execute('SELECT 1 FROM work_claims WHERE run_id=%s AND epoch=%s',
                                       (current.context.run_id,original.execution_epoch))).fetchone():
            raise KnowledgeUnavailable('knowledge_binding_changed')

    @_guard
    async def carry_in_transaction(self, db, context, receipts):
        """Explicitly transfer checked content to this freshly accepted Activity, never a grant."""
        self._validate_receipts(receipts)
        current = await self._binding(db,context)
        for item in receipts:
            await self._carry_target(db,item.target,current)
        carried = tuple(replace(item,target=current) for item in receipts)
        await self.revalidate_in_transaction(db,context,carried)
        return carried

    @_guard
    async def carry_proposal_for_completion_in_transaction(self, db, context, proposal):
        if type(proposal) is not PreparedMemoryProposal:
            raise KnowledgeUnavailable('invalid_knowledge_proposal')
        current = await self._binding(db,context)
        await self._carry_target(db,proposal.target,current)
        return await self.proposal_for_completion_in_transaction(db,context,replace(proposal,target=current))

    @_guard
    async def propose_memory(self, context, value):
        value = validate_proposal(value)
        async with self._transaction() as db:
            target = await self._binding(db,context)
            return PreparedMemoryProposal(target,**value,fingerprint=digest(value))

    @_guard
    async def proposal_for_completion_in_transaction(self, db, context, proposal):
        """Return a fresh candidate for root's successful-completion callback, never activate it.

        Root owns pending insertion in its publication transaction, including the Bot capacity
        lock BEFORE knowledge record locks, unique source Run and 50 pending limit. Only call this
        while Work is active; root inserts after its verified terminal update in the same commit.
        No write, terminal transition or successful-completion claim is performed by this adapter.
        """
        if type(proposal) is not PreparedMemoryProposal:
            raise KnowledgeUnavailable('invalid_knowledge_proposal')
        value = validate_proposal({key:getattr(proposal,key) for key in ('kind','title','content')})
        if digest(value) != proposal.fingerprint or proposal.target != await self._binding(db,context):
            raise KnowledgeUnavailable('knowledge_proposal_changed')
        if context.channel_id is None:
            return dict(value,botId=context.bot_id,source=dict(kind='task',taskId=context.task_id,runId=context.run_id))
        return dict(value,botId=context.bot_id,sourceRunId=proposal.target.source_run_id)
