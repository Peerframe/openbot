"""Insert-only channel command snapshots; no route discovery or permission fallback."""
from typing import Literal
from copy import deepcopy

from psycopg.types.json import Jsonb

from .model_connections_inputs import ModelSelection
from .work_command_contract import Strict, Identity, Digest, CommandRoute, Command, parse, bounded_value
from .work_values import WorkConflict, canonical


class CommandProfile(Strict):
    kind: Literal['work_command_profile']
    version: Literal[1]
    taskId: Identity
    botId: Identity
    sourceRunId: Identity
    executionProfile: Literal['docker-linux']
    modelSelection: ModelSelection
    route: CommandRoute
    credentialDigest: Digest
    policyId: Identity
    policyDigest: Digest


async def command_source(db, task):
    """Called only after store._task acquired the existing channel/source/ancestor locks."""
    mapping = await (await db.execute('SELECT * FROM work_sources WHERE task_id=%s FOR SHARE', (task['id'],))).fetchone()
    if not mapping or await (await db.execute('SELECT 1 FROM work_task_profiles WHERE task_id=%s', (task['id'],))).fetchone():
        raise WorkConflict('command_source_required')
    origin = await (await db.execute('SELECT bot_id,channel_id,source_message_id,execution_profile,model_selection,node_id,'
        'left(instruction,32769) AS instruction FROM runs WHERE id=%s FOR SHARE', (mapping['legacy_run_id'],))).fetchone()
    message = await (await db.execute('SELECT channel_id FROM messages WHERE id=%s FOR SHARE', (mapping['source_message_id'],))).fetchone()
    if (not origin or not message or origin['bot_id'] != task['bot_id'] or origin['node_id'] is not None
            or origin['channel_id'] != mapping['channel_id'] or message['channel_id'] != mapping['channel_id']
            or origin['source_message_id'] != mapping['source_message_id'] or origin['instruction'] != task['objective']
            or origin['execution_profile'] != 'docker-linux' or origin['model_selection'] is not None):
        raise WorkConflict('command_source_changed')
    member = await (await db.execute('SELECT 1 FROM channel_bots WHERE channel_id=%s AND bot_id=%s FOR SHARE',
        (mapping['channel_id'],task['bot_id']))).fetchone()
    bot = await (await db.execute('SELECT computer_profile FROM bots WHERE id=%s FOR SHARE', (task['bot_id'],))).fetchone()
    if not member or not bot or bot['computer_profile'] != 'docker-linux':
        raise WorkConflict('command_scope_changed')
    return mapping, origin


class CommandProfiles:
    def __init__(self, connections, *, policies):
        # Policies are trusted Server composition, never a model/Node supplied allowlist.
        if type(policies) is not dict or not 1 <= len(policies) <= 32:
            raise ValueError('command_policy_required')
        self.connections = connections
        self.policies = {}
        for identity, policy in policies.items():
            if type(identity) is not str or not 1 <= len(identity) <= 128 or set(policy) != {'image','limits'}:
                raise ValueError('command_policy_required')
            bounded_value(policy)
            self.policies[identity] = (canonical(policy)[1], deepcopy(policy))

    async def capture_in_transaction(self, db, task, *, route, credential_digest, policy_id):
        """New source=True creation branch only, under Server-selected route/identity guard."""
        mapping, origin = await command_source(db, task)
        if policy_id not in self.policies: raise WorkConflict('command_policy_changed')
        bot = await (await db.execute("SELECT configuration->'model' AS selection FROM bots WHERE id=%s FOR SHARE", (task['bot_id'],))).fetchone()
        value = parse(CommandProfile, dict(kind='work_command_profile',version=1,taskId=task['id'],botId=task['bot_id'],
            sourceRunId=mapping['legacy_run_id'],executionProfile='docker-linux',modelSelection=bot['selection'],
            route=route,credentialDigest=credential_digest,policyId=policy_id,policyDigest=self.policies[policy_id][0]))
        await self._current(db, value)
        digest = canonical(value.model_dump())[1]
        await db.execute('INSERT INTO work_command_profiles(task_id,source_run_id,bot_id,model_selection,profile,profile_digest) '
            'VALUES(%s,%s,%s,%s,%s,%s)', (task['id'],mapping['legacy_run_id'],task['bot_id'],Jsonb(value.modelSelection.model_dump()),
            Jsonb(value.model_dump()),digest))
        return digest

    async def _current(self, db, profile):
        policy = self.policies.get(profile.policyId)
        if policy is None or policy[0] != profile.policyDigest: raise WorkConflict('command_policy_changed')
        await self.connections.resolve_in_transaction(db, profile.modelSelection.model_dump())
        node = await (await db.execute('SELECT credential_digest,revoked_at FROM node_credentials WHERE node_id=%s FOR SHARE',
            (profile.route.nodeId,))).fetchone()
        if not node or node['revoked_at'] is not None or node['credential_digest'] != profile.credentialDigest:
            raise WorkConflict('command_identity_changed')

    async def resolve_in_transaction(self, db, task):
        mapping, origin = await command_source(db, task)
        row = await (await db.execute('SELECT * FROM work_command_profiles WHERE task_id=%s FOR SHARE', (task['id'],))).fetchone()
        if not row: raise WorkConflict('command_profile_required')
        profile = parse(CommandProfile, row['profile'])
        if (profile.taskId != task['id'] or profile.botId != task['bot_id'] or profile.sourceRunId != mapping['legacy_run_id']
                or row['source_run_id'] != profile.sourceRunId or row['bot_id'] != profile.botId
                or row['model_selection'] != profile.modelSelection.model_dump() or canonical(row['profile'])[1] != row['profile_digest']):
            raise WorkConflict('command_profile_changed')
        await self._current(db, profile)
        return profile, row['profile_digest']

    def check_command(self, profile, command):
        command = parse(Command, command)
        _, policy = self.policies[profile.policyId]
        if command.image != policy['image'] or command.limits.model_dump() != policy['limits']:
            raise WorkConflict('command_policy_changed')
        return command
