"""Insert-only browser capture snapshots; deployment-routed, no command or browser effects."""
from typing import Annotated, Literal

from psycopg.types.json import Jsonb
from pydantic import Field, TypeAdapter

from .browser_protocol import Id, Strict
from .model_connections_inputs import ModelSelection
from .worker_host_protocol import NodeId
from .work_values import WorkConflict, canonical


class BrowserProfile(Strict):
    kind: Literal['work_browser_profile']
    version: Literal[1]
    taskId: Id
    botId: Id
    sourceRunId: Id
    executionProfile: Literal['docker-linux']
    modelSelection: ModelSelection
    nodeId: NodeId
    credentialDigest: Annotated[str, Field(pattern=r'^[0-9a-f]{64}$')]
    maxCaptures: Literal[4]


_BROWSER_PROFILE = TypeAdapter(BrowserProfile)
_IDENTITY = TypeAdapter(Id)
_NODE = TypeAdapter(NodeId)


def _profile(value):
    """Strict Pydantic validation only; any failure is a fail-closed WorkConflict."""
    try:
        return _BROWSER_PROFILE.validate_python(value)
    except ValueError:
        raise WorkConflict('browser_profile_invalid') from None


async def browser_source(db, task):
    """Same channel/run/message/membership/Bot invariants as command_source without command authority."""
    mapping = await (await db.execute('SELECT * FROM work_sources WHERE task_id=%s FOR SHARE', (task['id'],))).fetchone()
    if (not mapping
            or await (await db.execute('SELECT 1 FROM work_task_profiles WHERE task_id=%s', (task['id'],))).fetchone()
            or await (await db.execute('SELECT 1 FROM work_command_profiles WHERE task_id=%s', (task['id'],))).fetchone()):
        raise WorkConflict('browser_source_required')
    origin = await (await db.execute('SELECT bot_id,channel_id,source_message_id,execution_profile,model_selection,node_id,'
        'left(instruction,32769) AS instruction FROM runs WHERE id=%s FOR SHARE', (mapping['legacy_run_id'],))).fetchone()
    message = await (await db.execute('SELECT channel_id FROM messages WHERE id=%s FOR SHARE', (mapping['source_message_id'],))).fetchone()
    if (not origin or not message or origin['bot_id'] != task['bot_id'] or origin['node_id'] is not None
            or origin['channel_id'] != mapping['channel_id'] or message['channel_id'] != mapping['channel_id']
            or origin['source_message_id'] != mapping['source_message_id'] or origin['instruction'] != task['objective']
            or origin['execution_profile'] != 'docker-linux' or origin['model_selection'] is not None):
        raise WorkConflict('browser_source_changed')
    member = await (await db.execute('SELECT 1 FROM channel_bots WHERE channel_id=%s AND bot_id=%s FOR SHARE',
        (mapping['channel_id'],task['bot_id']))).fetchone()
    bot = await (await db.execute('SELECT computer_profile FROM bots WHERE id=%s FOR SHARE', (task['bot_id'],))).fetchone()
    if not member or not bot or bot['computer_profile'] != 'docker-linux':
        raise WorkConflict('browser_scope_changed')
    return mapping, origin


class BrowserProfiles:
    def __init__(self, connections, *, routes, human_control=False):
        # Routes are trusted deployment composition, never a model/Node supplied allowlist.
        if type(human_control) is not bool:
            raise ValueError('browser_human_control_invalid')
        self.human_control = human_control
        if type(routes) is not dict or not 1 <= len(routes) <= 32:
            raise ValueError('browser_route_required')
        self.connections = connections
        self.routes = {}
        for identity, node_id in routes.items():
            if type(identity) is not str:
                raise ValueError('browser_route_required')
            try:
                key = _IDENTITY.validate_python(identity)
                value = _NODE.validate_python(node_id)
            except ValueError:
                raise ValueError('browser_route_required')
            if key in self.routes:
                raise ValueError('browser_route_duplicate')
            self.routes[key] = value

    def _route_for(self, identity):
        return self.routes.get(identity)

    async def _current(self, db, profile):
        route = self._route_for(profile.botId)
        if route is None or route != profile.nodeId:
            raise WorkConflict('browser_route_changed')
        await self.connections.resolve_in_transaction(db, profile.modelSelection.model_dump())
        node = await (await db.execute('SELECT credential_digest,revoked_at FROM node_credentials WHERE node_id=%s FOR SHARE',
            (profile.nodeId,))).fetchone()
        if not node or node['revoked_at'] is not None or node['credential_digest'] != profile.credentialDigest:
            raise WorkConflict('browser_identity_changed')
        event = await (await db.execute("SELECT node_id,payload FROM run_events WHERE bot_id=%s AND type='BROWSER_HOST_BOUND' "
            'ORDER BY created_at DESC,id DESC LIMIT 1 FOR SHARE', (profile.botId,))).fetchone()
        if (not event or event['node_id'] != profile.nodeId
                or event['payload'] != {'credentialDigest': profile.credentialDigest}):
            raise WorkConflict('browser_identity_changed')

    async def capture_in_transaction(self, db, task):
        """New source=True creation branch only, under the deployment-selected route guard."""
        mapping, origin = await browser_source(db, task)
        node_id = self._route_for(task['bot_id'])
        if node_id is None:
            raise WorkConflict('browser_route_changed')
        bot = await (await db.execute("SELECT configuration->'model' AS selection FROM bots WHERE id=%s FOR SHARE",
            (task['bot_id'],))).fetchone()
        node = await (await db.execute('SELECT credential_digest FROM node_credentials WHERE node_id=%s FOR SHARE',
            (node_id,))).fetchone()
        if not bot or not node:
            raise WorkConflict('browser_identity_changed')
        value = _profile(dict(kind='work_browser_profile',version=1,taskId=task['id'],botId=task['bot_id'],
            sourceRunId=mapping['legacy_run_id'],executionProfile='docker-linux',modelSelection=bot['selection'],
            nodeId=node_id,credentialDigest=node['credential_digest'],maxCaptures=4))
        await self._current(db, value)
        digest = canonical(value.model_dump())[1]
        await db.execute('INSERT INTO work_browser_profiles(task_id,source_run_id,bot_id,model_selection,profile,profile_digest) '
            'VALUES(%s,%s,%s,%s,%s,%s)', (task['id'],mapping['legacy_run_id'],task['bot_id'],Jsonb(value.modelSelection.model_dump()),
            Jsonb(value.model_dump()),digest))
        return digest

    async def resolve_in_transaction(self, db, task):
        """Read-only verification of an existing immutable profile; no update, backfill, retry or effect."""
        mapping, origin = await browser_source(db, task)
        row = await (await db.execute('SELECT * FROM work_browser_profiles WHERE task_id=%s FOR SHARE', (task['id'],))).fetchone()
        if not row: raise WorkConflict('browser_profile_required')
        profile = _profile(row['profile'])
        if (profile.taskId != task['id'] or profile.botId != task['bot_id'] or profile.sourceRunId != mapping['legacy_run_id']
                or row['source_run_id'] != profile.sourceRunId or row['bot_id'] != profile.botId
                or row['model_selection'] != profile.modelSelection.model_dump() or canonical(row['profile'])[1] != row['profile_digest']):
            raise WorkConflict('browser_profile_changed')
        await self._current(db, profile)
        return profile, row['profile_digest']
