"""Work-domain transactions. This module neither schedules nor executes external actions."""
import asyncio
import hashlib
import json
import inspect
from copy import deepcopy
from contextlib import asynccontextmanager, nullcontext
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb

from .authority import OwnerTransactions, PostgresTransactions
from .database import StoreUnavailable
from .work_claims import check_fence
from .models import iso_timestamp
from .work_values import InvalidWork, WorkConflict, WorkNotFound, canonical, receipt, text, tokens


class PostgresWorkStore:
    def __init__(self, dsn, *, files=None, task_profiles=None, command_profiles=None):
        if task_profiles is not None and not callable(getattr(task_profiles,'capture_in_transaction',None)):
            raise InvalidWork('invalid_task_profile_composition')
        self.files = files
        self.task_profiles = task_profiles
        if command_profiles is not None:
            from .work_command_profiles import CommandProfiles
            if type(command_profiles) is not CommandProfiles:
                raise InvalidWork('invalid_command_profile_composition')
        self.command_profiles = command_profiles
        self._owner = OwnerTransactions(dsn, application_name='openbot-work-owner')
        self._control = PostgresTransactions(dsn, application_name='openbot-work-control')

    async def verify_schema(self):
        await self._owner.verify_schema()
        if self.files is not None:
            await asyncio.to_thread(self.files.verify)

    @asynccontextmanager
    async def _transaction(self, token=None, *, trusted=False):
        transaction = self._control.transaction() if trusted else self._owner.transaction(token)
        try:
            async with transaction as connection:
                yield connection
        except psycopg.Error:
            raise StoreUnavailable('work_storage_unavailable') from None

    @staticmethod
    async def _task(connection, task_id, *, read=False):
        text(task_id, 128)
        from .work_collaboration import lock_task
        return await lock_task(connection, task_id, read=read)

    @classmethod
    async def _action(cls, connection, action_id):
        text(action_id, 128)
        cursor = await connection.execute('SELECT task_id FROM work_actions WHERE id=%s', (action_id,))
        row = await cursor.fetchone()
        if row is None:
            raise WorkNotFound()
        task = await cls._task(connection, row['task_id'])
        cursor = await connection.execute('SELECT *,expires_at>clock_timestamp() AS unexpired '
                                          'FROM work_actions WHERE id=%s FOR UPDATE', (action_id,))
        return task, await cursor.fetchone()

    @staticmethod
    def _active(task):
        from .work_collaboration import assert_active
        if not task['authority_active'] or task['cancel_requested'] or task['status'] not in ('queued', 'open'):
            raise WorkConflict('admission_closed')
        assert_active(task)

    @staticmethod
    async def _event(connection, task_id, kind, payload):
        canonical(payload)
        cursor = await connection.execute('UPDATE work_tasks SET revision=revision+1 WHERE id=%s RETURNING revision',
                                          (task_id,))
        revision = (await cursor.fetchone())['revision']
        await connection.execute('INSERT INTO work_events(task_id,revision,kind,payload) VALUES (%s,%s,%s,%s)',
                                 (task_id, revision, kind, Jsonb(payload)))

    @staticmethod
    async def _usage(connection, task_id):
        cursor = await connection.execute("SELECT coalesce(sum(reserved_tokens) FILTER (WHERE status IN ('admitted','unknown')),0) AS reserved,"
            "coalesce(sum(actual_tokens),0) AS spent FROM work_actions WHERE task_id=%s", (task_id,))
        row = await cursor.fetchone()
        return {'reservedTokens': int(row['reserved']), 'spentTokens': int(row['spent'])}

    @classmethod
    async def _view(cls, connection, task_id):
        # Every writer owns this Task row. Caller holds its UPDATE or SHARE lock across reads.
        cursor = await connection.execute('SELECT * FROM work_tasks WHERE id=%s', (task_id,))
        task = await cursor.fetchone()
        cursor = await connection.execute('SELECT id,status,ordinal FROM work_runs WHERE task_id=%s ORDER BY ordinal', (task_id,))
        runs = await cursor.fetchall()
        from .work_reconciliation import projection
        cursor = await connection.execute('SELECT DISTINCT ON(c.action_id) c.* FROM work_reconciliation_commands c '
            'JOIN work_actions a ON a.id=c.action_id WHERE a.task_id=%s ORDER BY c.action_id,c.sequence DESC', (task_id,))
        repairs = {c['action_id']: projection(c) for c in await cursor.fetchall()}
        cursor = await connection.execute('SELECT * FROM work_actions WHERE task_id=%s ORDER BY created_at,id', (task_id,))
        actions = [dict(id=a['id'], runId=a['run_id'], intent=a['intent'], intentDigest=a['intent_digest'],
                        decision=a['decision'], status=a['status'], expiresAt=iso_timestamp(a['expires_at']),
                        reservedTokens=a['reserved_tokens'], actualTokens=a['actual_tokens'], evidence=a['evidence'], reconciliation=repairs.get(a['id']))
                   for a in await cursor.fetchall()]
        cursor = await connection.execute('SELECT revision,kind,payload FROM work_events WHERE task_id=%s '
                                          'ORDER BY revision DESC LIMIT 100', (task_id,))
        events = list(reversed(await cursor.fetchall()))
        cursor = await connection.execute('SELECT id,run_id,name,media_type,sha256,size_bytes FROM work_artifacts WHERE task_id=%s ORDER BY id', (task_id,))
        artifacts = [dict(id=a['id'],runId=a['run_id'],name=a['name'],mediaType=a['media_type'],
                          sha256=a['sha256'],sizeBytes=a['size_bytes'],downloadUrl='/api/v1/artifacts/'+a['id']) for a in await cursor.fetchall()]
        usage = await cls._usage(connection, task_id)
        uncertain = any(a['status'] == 'unknown' or task['cancel_requested'] and a['status'] == 'admitted' for a in actions)
        attention = ('reconciliation' if uncertain else 'budget' if usage['spentTokens'] > task['token_limit'] else
                     'approval' if any(a['status'] == 'proposed' and a['decision'] == 'pending' for a in actions)
                     and task['authority_active'] else None)
        return dict(id=task['id'], botId=task['bot_id'], objective=task['objective'], status=task['status'],
                    revision=task['revision'], authorityActive=task['authority_active'],
                    cancelRequested=task['cancel_requested'], attention=attention,
                    resultSummary=task['result_summary'],artifacts=artifacts,
                    usage={'tokenLimit': task['token_limit'], **usage}, runs=runs, actions=actions, events=events, eventsTruncated=bool(events and events[0]['revision'] > 1))

    async def create(self, token, *, bot_id, objective, token_limit, request_key, scope=None):
        from .work_native_scope import scope_input
        scope=scope_input(scope)
        if scope is not None and self.task_profiles is None:raise WorkConflict('native_task_profile_required')
        async with self.task_profiles.scope_lock(scope) if scope is not None else nullcontext():
            async with self._transaction(token) as connection:
                return await self.create_in_transaction(connection, bot_id=bot_id, objective=objective,
                    token_limit=token_limit, request_key=request_key, scope=scope)

    async def create_in_transaction(self, connection, *, bot_id, objective, token_limit, request_key, source=False, scope=None):
        """Trusted source admission shares the caller's authority transaction and commit."""
        text(bot_id, 128); text(objective, 32768 if source else 16384); text(request_key, 128); tokens(token_limit)
        payload = {'botId': bot_id, 'objective': objective, 'tokenLimit': token_limit}
        if scope is not None:
            from .work_native_scope import scope_input
            scope=scope_input(scope)
            if source or self.task_profiles is None:raise InvalidWork('native_task_scope_required')
            payload['scope']=scope
        if source or scope is not None:
            # Closed bounded shape: retain the same digest encoding without the unrelated
            # generic Action JSON cap narrowing the legacy 8,000 UTF-16 character input.
            digest = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True,
                separators=(',', ':')).encode('utf-8')).hexdigest()
        else:
            _, digest = canonical(payload)
        # Unique-key insertion below serializes same-key concurrent submissions. No workflow
        # can exist without its Task/Run/handoff record committing in this transaction.
        cursor = await connection.execute('SELECT id FROM bots WHERE id=%s FOR SHARE', (bot_id,))
        if await cursor.fetchone() is None:
            raise WorkNotFound()
        task_id, run_id = str(uuid4()), str(uuid4())
        cursor = await connection.execute('INSERT INTO work_tasks(id,owner_id,bot_id,request_key,request_digest,objective,token_limit) '
            "VALUES (%s,'owner',%s,%s,%s,%s,%s) ON CONFLICT(request_key) DO NOTHING RETURNING id",
            (task_id, bot_id, request_key, digest, objective, token_limit))
        if await cursor.fetchone() is None:
            cursor = await connection.execute('SELECT id,request_digest FROM work_tasks WHERE request_key=%s', (request_key,))
            existing = await cursor.fetchone()
            if existing['request_digest'] != digest:
                raise WorkConflict('idempotency_content_changed')
            await self._task(connection, existing['id'], read=True)
            return await self._view(connection, existing['id'])
        product_native = self.task_profiles is not None and not source
        if product_native:
            # The unique-key winner owns this one snapshot. Idempotent replays never
            # reread today's Bot selection or backfill historical execution authority.
            await self.task_profiles.capture_in_transaction(connection,task_id,bot_id,
                **({'scope':scope} if scope is not None else {}))
        await connection.execute('INSERT INTO work_runs(id,task_id,ordinal,corrections_enabled) VALUES (%s,%s,1,%s)',
                                 (run_id, task_id, product_native))
        await connection.execute('INSERT INTO work_admissions(run_id) VALUES (%s)', (run_id,))
        await connection.execute("INSERT INTO work_events(task_id,revision,kind,payload) VALUES (%s,1,'task.created',%s)",
                                 (task_id, Jsonb({'runId': run_id})))
        return await self._view(connection, task_id)

    async def native_scope(self, token, task_id):
        from .work_native_scope import public_scope, read_scope
        async with self._transaction(token) as db:
            task=await self._task(db,task_id,read=True)
            return public_scope(await read_scope(db,task_id,task['bot_id']))

    async def snapshot(self, token, task_id):
        async with self._transaction(token) as connection:
            await self._task(connection, task_id, read=True)
            return await self._view(connection, task_id)

    async def propose(self, task_id, run_id, *, fence, action_key, intent, reserved_tokens,
                      requires_approval=True, expires_seconds=300, correction_context=None):
        """Trusted policy composition only. No Runtime/client can select approval requirements."""
        text(run_id, 128); text(action_key, 128); tokens(reserved_tokens)
        if type(intent) is not dict or type(requires_approval) is not bool or type(expires_seconds) is not int or not 1 <= expires_seconds <= 3600:
            raise InvalidWork('invalid_action')
        _, digest = canonical(intent)
        from .work_corrections import check_context
        async with self._transaction(trusted=True) as connection:
            task = await self._task(connection, task_id)
            cursor = await connection.execute('SELECT * FROM work_runs WHERE task_id=%s AND id=%s FOR UPDATE', (task_id, run_id))
            run = await cursor.fetchone()
            if run is None:
                raise WorkNotFound()
            cursor = await connection.execute('SELECT * FROM work_actions WHERE run_id=%s AND action_key=%s', (run_id, action_key))
            existing = await cursor.fetchone()
            if existing is not None:
                if (existing['intent_digest'], existing['reserved_tokens'], existing['requires_approval']) != (digest, reserved_tokens, requires_approval):
                    raise WorkConflict('action_content_changed')
                if existing['correction_context_id'] != correction_context:
                    raise WorkConflict('action_context_changed')
                # A correction never rewrites an already admitted operation's identity/outcome.
                # This historical read is not a fresh admission, and cannot refresh its generation.
                if correction_context is not None and existing['status'] in ('admitted', 'unknown', 'applied', 'not_applied'):
                    await check_context(connection, task, run_id, correction_context, current=False)
                    return existing['id']
            self._active(task)
            if run['status'] != 'running':
                raise WorkConflict('run_closed')
            await check_fence(connection,run_id,fence)
            await check_context(connection, task, run_id, correction_context)
            if existing is not None:
                return existing['id']
            cursor = await connection.execute('SELECT count(*) AS n FROM work_actions WHERE task_id=%s', (task_id,))
            if (await cursor.fetchone())['n'] >= 256:
                raise WorkConflict('action_limit')
            action_id = str(uuid4())
            await connection.execute('INSERT INTO work_actions(id,task_id,run_id,action_key,intent,intent_digest,authority_generation,'
                'requires_approval,decision,expires_at,reserved_tokens,correction_context_id) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,clock_timestamp()+%s*interval \'1 second\',%s,%s)',
                (action_id, task_id, run_id, action_key, Jsonb(intent), digest, task['authority_generation'], requires_approval,
                 'pending' if requires_approval else 'not_required', expires_seconds, reserved_tokens, correction_context))
            await connection.execute("UPDATE work_tasks SET status='open' WHERE id=%s", (task_id,))
            await connection.execute("UPDATE work_runs SET status='running' WHERE id=%s", (run_id,))
            await self._event(connection, task_id, 'action.proposed', {'actionId': action_id, 'intentDigest': digest})
            await check_fence(connection,run_id,fence)
            return action_id

    async def decide(self, token, action_id, *, intent_digest, approved):
        if type(approved) is not bool:
            raise InvalidWork('invalid_decision')
        text(intent_digest, 64)
        async with self._transaction(token) as connection:
            task, action = await self._action(connection, action_id)
            self._active(task)
            if action['intent_digest'] != intent_digest or action['authority_generation'] != task['authority_generation'] or not action['unexpired']:
                raise WorkConflict('approval_stale')
            decision = 'approved' if approved else 'denied'
            if not action['requires_approval'] or action['status'] != 'proposed':
                raise WorkConflict('decision_unavailable')
            if action['decision'] == decision:
                return await self._view(connection, task['id'])
            if action['decision'] != 'pending':
                raise WorkConflict('decision_already_recorded')
            await connection.execute('UPDATE work_actions SET decision=%s WHERE id=%s', (decision, action_id))
            await self._event(connection, task['id'], 'action.decided', {'actionId': action_id, 'decision': decision, 'intentDigest': intent_digest})
            return await self._view(connection, task['id'])

    async def admit(self, action_id, *, fence, admission_check=None):
        """True is one new admission; False requires inspecting/reconciling the existing outcome."""
        from .work_corrections import check_context
        async with self._transaction(trusted=True) as connection:
            task, action = await self._action(connection, action_id)
            self._active(task)
            await check_fence(connection,action['run_id'],fence)
            if action['status'] in ('proposed', 'superseded'):
                await check_context(connection, task, action['run_id'], action['correction_context_id'])
            if action['status'] != 'proposed':
                return False
            if not action['unexpired'] or action['authority_generation'] != task['authority_generation'] or action['decision'] not in ('approved', 'not_required'):
                raise WorkConflict('action_not_authorized')
            usage = await self._usage(connection, task['id'])
            if usage['reservedTokens'] + usage['spentTokens'] + action['reserved_tokens'] > task['token_limit']:
                raise WorkConflict('token_budget_exhausted')
            if admission_check is not None:
                if not callable(admission_check):
                    raise InvalidWork('invalid_admission_check')
                checked = admission_check(connection, deepcopy(task), deepcopy(action))
                if not inspect.isawaitable(checked) or await checked is not True:
                    raise WorkConflict('product_admission_refused')
            await connection.execute("UPDATE work_actions SET status='admitted' WHERE id=%s", (action_id,))
            await self._event(connection, task['id'], 'action.admitted', {'actionId': action_id, 'reservedTokens': action['reserved_tokens']})
            await check_fence(connection,action['run_id'],fence)
            return True

    async def uncertain(self, action_id):
        async with self._transaction(trusted=True) as connection:
            task, action = await self._action(connection, action_id)
            if action['status'] == 'unknown':
                return
            if action['status'] != 'admitted':
                raise WorkConflict('action_not_admitted')
            await connection.execute("UPDATE work_actions SET status='unknown' WHERE id=%s", (action_id,))
            await self._event(connection, task['id'], 'action.unknown', {'actionId': action_id})

    async def resolve(self, action_id, *, applied, actual_tokens, evidence):
        """Only the trusted resolver calls this after independent receipt/lookup verification.

        Resolution is permitted after cancellation/revocation; recording truth grants no new
        execution. Untrusted Worker/Runtime reports must not be passed directly to this method.
        """
        if type(applied) is not bool:
            raise InvalidWork('invalid_outcome')
        tokens(actual_tokens); receipt(evidence)
        outcome = 'applied' if applied else 'not_applied'
        async with self._transaction(trusted=True) as connection:
            task, action = await self._action(connection, action_id)
            if action['status'] in ('applied', 'not_applied'):
                if (action['status'], action['actual_tokens'], action['evidence']) != (outcome, actual_tokens, evidence):
                    raise WorkConflict('outcome_already_recorded')
                return await self._view(connection, task['id'])
            if action['status'] not in ('admitted', 'unknown'):
                raise WorkConflict('action_not_admitted')
            await connection.execute('UPDATE work_actions SET status=%s,actual_tokens=%s,evidence=%s WHERE id=%s',
                                     (outcome, actual_tokens, Jsonb(evidence), action_id))
            await self._event(connection, task['id'], 'action.resolved', {'actionId': action_id, 'outcome': outcome,
                                                                        'actualTokens': actual_tokens, 'evidence': evidence})
            # Automatic lookup can settle before the workflow consumes an Owner command.
            # Close that obligation atomically with the verified outcome; no new authority.
            cursor = await connection.execute("UPDATE work_reconciliation_commands SET outcome='resolved',"
                'finished_at=clock_timestamp() WHERE action_id=%s AND finished_at IS NULL RETURNING id',
                (action_id,))
            for command in await cursor.fetchall():
                await self._event(connection, task['id'], 'reconciliation.finished',
                    {'commandId': command['id'], 'actionId': action_id, 'outcome': 'resolved'})
            await self._finish_cancel(connection, task)
            return await self._view(connection, task['id'])

    @staticmethod
    async def _finish_cancel(connection, task):
        if not task['cancel_requested']:
            return
        cursor = await connection.execute("SELECT 1 FROM work_actions WHERE task_id=%s AND status IN ('admitted','unknown') LIMIT 1", (task['id'],))
        if await cursor.fetchone() is None:
            await connection.execute("UPDATE work_tasks SET status='cancelled' WHERE id=%s", (task['id'],))
            await connection.execute("UPDATE work_runs SET status='cancelled' WHERE task_id=%s AND status IN ('queued','running')", (task['id'],))

    async def cancel(self, token, task_id):
        async with self._transaction(token) as connection:
            task = await self._task(connection, task_id)
            if task['cancel_requested']:
                return await self._view(connection, task_id)
            if task['status'] not in ('queued', 'open'):
                raise WorkConflict('task_closed')
            from .work_collaboration import cascade
            await cascade(connection, self, task_id, reason='cancel')
            return await self._view(connection, task_id)

    async def revoke(self, token, task_id):
        async with self._transaction(token) as connection:
            task = await self._task(connection, task_id)
            from .work_collaboration import cascade
            await cascade(connection, self, task_id, reason='revoke')
            return await self._view(connection, task_id)

    async def claim(self, task_id, run_id, claim_id, *, expires_seconds=60):
        from .work_claims import claim
        return await claim(self,task_id,run_id,claim_id,expires_seconds=expires_seconds)

    async def complete(self, task_id, run_id, **values):
        from .work_completion import complete
        return await complete(self,task_id,run_id,**values)

    async def download(self, token, artifact_id):
        text(artifact_id,128)
        async with self._transaction(token) as connection:
            cursor = await connection.execute('SELECT * FROM work_artifacts WHERE id=%s', (artifact_id,))
            artifact = await cursor.fetchone()
            if artifact is None:
                raise WorkNotFound()
            await self._task(connection,artifact['task_id'],read=True)
            if self.files is None:
                raise StoreUnavailable('work_files_unconfigured')
            data = await asyncio.to_thread(self.files.read,artifact['sha256'],artifact['size_bytes'])
            return artifact, data

    async def request_reconciliation(self, token, action_id, **values):
        from .work_reconciliation import ReconciliationStore
        return await ReconciliationStore(self).request(token, action_id, **values)
