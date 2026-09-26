"""Immutable channel provenance for the existing Work authority and Temporal admission.

This adapter never dispatches or retries. The source Run remains a compatibility identity;
work_tasks/actions are the only execution facts for a mapped source.
"""
from uuid import uuid4

from psycopg.types.json import Jsonb

from .work_corrections import CorrectionStore
from .work_values import WorkConflict, tokens


async def lock_source(db, task_id):
    source = await (await db.execute('SELECT channel_id,legacy_run_id FROM work_sources WHERE task_id=%s',
                                    (task_id,))).fetchone()
    if source:
        # Publication inserts a message referencing this channel. Take its FK-compatible lock
        # before Task, so membership revocation cannot hold channel and wait for our Task.
        await db.execute('SELECT id FROM channels WHERE id=%s FOR KEY SHARE', (source['channel_id'],))
        await db.execute('SELECT id FROM runs WHERE id=%s FOR KEY SHARE', (source['legacy_run_id'],))


class WorkSourceAdmission:
    def __init__(self, store, *, token_limit, command_route=None, command_policy_id=None):
        self.store = store
        self.token_limit = tokens(token_limit)
        self.command_route = None
        self.command_policy_id = None
        if command_route is not None or command_policy_id is not None:
            from .work_command_contract import CommandRoute, parse
            from .work_command_profiles import CommandProfiles
            if (type(store.command_profiles) is not CommandProfiles
                    or type(command_policy_id) is not str
                    or command_policy_id not in store.command_profiles.policies):
                raise WorkConflict('command_source_composition_required')
            self.command_route = parse(CommandRoute, command_route).model_dump()
            self.command_policy_id = command_policy_id

    async def admit(self, db, run):
        isolated = run.executionProfile == 'docker-linux'
        browser = isolated and self.store.browser_profiles is not None and run.botId in self.store.browser_profiles.routes
        command = isolated and not browser and self.command_route is not None
        if run.executionProfile not in ('none', 'model') and not (command or browser):
            raise WorkConflict('isolated_execution_unqualified')
        task = await self.store.create_in_transaction(db, bot_id=run.botId,
            objective=run.instruction, token_limit=self.token_limit,
            request_key='source:'+run.id, source=True)
        existing = await (await db.execute('SELECT legacy_run_id FROM work_sources WHERE task_id=%s',
                                           (task['id'],))).fetchone()
        if existing:
            if existing['legacy_run_id'] != run.id:
                raise WorkConflict('source_content_changed')
            if command:
                await self.store.command_profiles.resolve_in_transaction(db, await self.store._task(db, task['id']))
            if browser:
                await self.store.browser_profiles.resolve_in_transaction(db, await self.store._task(db, task['id']))
            return task
        await db.execute('INSERT INTO work_sources(task_id,legacy_run_id,channel_id,source_message_id) '
            'VALUES (%s,%s,%s,%s)', (task['id'], run.id, run.channelId, run.sourceMessageId))
        if command:
            # Source capture freezes current persisted identity, not a live socket or a Node claim.
            identity = await (await db.execute('SELECT credential_digest,revoked_at FROM node_credentials '
                'WHERE node_id=%s FOR SHARE', (self.command_route['nodeId'],))).fetchone()
            if not identity or identity['revoked_at'] is not None:
                raise WorkConflict('command_identity_changed')
            from .work_command_contract import CommandContractError
            try:
                await self.store.command_profiles.capture_in_transaction(db, await self.store._task(db, task['id']),
                    route=self.command_route, credential_digest=identity['credential_digest'], policy_id=self.command_policy_id)
            except CommandContractError:
                raise WorkConflict('command_profile_invalid') from None
        elif browser:
            await self.store.browser_profiles.capture_in_transaction(db, await self.store._task(db, task['id']))
        # The selected product Worker implements the correction protocol before its first model
        # request. Enabling now preserves Owner steering while the initial handoff is still queued.
        await db.execute('UPDATE work_runs SET corrections_enabled=true WHERE task_id=%s', (task['id'],))
        await self.store._event(db, task['id'], 'source.admitted', {'sourceRunId':run.id})
        return task

    async def cancel(self, db, legacy_ids):
        for identity in sorted(set(legacy_ids)):
            source = await (await db.execute('SELECT task_id FROM work_sources WHERE legacy_run_id=%s',
                                            (identity,))).fetchone()
            if not source:
                continue
            # The caller already holds channel/source locks, and does not acquire those locks
            # after Task. Cancellation retains unknown admitted effects for reconciliation.
            task = await self.store._task(db, source['task_id'])
            from .work_collaboration import cascade
            await cascade(db, self.store, task['id'], reason='cancel')

    async def steer(self, db, legacy_id, *, instruction, command_id):
        source = await (await db.execute('SELECT s.task_id,r.id AS run_id FROM work_sources s '
            'JOIN work_runs r ON r.task_id=s.task_id WHERE s.legacy_run_id=%s '
            'ORDER BY r.ordinal DESC LIMIT 1', (legacy_id,))).fetchone()
        if not source:
            return
        await self.store._task(db, source['task_id'])
        sequence = await (await db.execute('SELECT count(*) AS n FROM work_corrections WHERE run_id=%s',
                                           (source['run_id'],))).fetchone()
        await CorrectionStore(self.store).request_in_transaction(db, source['task_id'],
            run_id=source['run_id'], instruction=instruction, request_key='source:'+command_id,
            expected_sequence=sequence['n'], source=True)


async def publish_source_message(db, task_id, summary):
    source = await (await db.execute('SELECT s.*,t.bot_id FROM work_sources s '
        'JOIN work_tasks t ON t.id=s.task_id WHERE s.task_id=%s', (task_id,))).fetchone()
    if source is None:
        return
    identity = 'work-result:'+task_id
    await db.execute("INSERT INTO messages(id,channel_id,author_type,author_id,run_id,reply_to_message_id,content) "
        "VALUES (%s,%s,'bot',%s,%s,%s,%s)", (identity, source['channel_id'], source['bot_id'],
         source['legacy_run_id'], source['source_message_id'], summary))
    await db.execute("INSERT INTO run_events(id,run_id,channel_id,bot_id,type,payload) "
        "VALUES (%s,%s,%s,%s,'RUN_COMPLETED',%s)", (str(uuid4()), source['legacy_run_id'],
         source['channel_id'], source['bot_id'], Jsonb({'taskId':task_id,'messageId':identity})))
