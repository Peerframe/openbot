"""One approved observation of the original browser; replay never captures a new screen."""
import asyncio
import base64
from contextlib import asynccontextmanager
from copy import deepcopy
from dataclasses import replace
from datetime import timedelta
from typing import Annotated, Literal

from pydantic import Field
from openbot_agent_runtime.contracts import ToolDescriptor

from .browser_gate import BrowserPauseGate
from .browser_protocol import Id, Strict, Timestamp, validate_frame
from .models import iso_timestamp
from .worker_host_registry import WorkerHostRegistry
from .work_browser_profiles import BrowserProfiles
from .work_collaboration import root_deadline
from .work_deferred import DeferredPlan, EffectServices
from .work_product_binding import ProductWorkBinding
from .work_tool_results import ToolResponseAdapter, ToolResponseVerifier
from .work_values import InvalidWork, WorkConflict, canonical

SCHEMA = 'openbot.work-browser-capture/v1'
_ATTEMPT = 'tool.browser_capture_started'
CAPTURE_TOOL = ToolDescriptor('capture_browser',
    'Request Owner approval to capture the current screen of this task\'s original browser. '
    'No navigation, clicks or typing. At most four captures per task. Only file metadata is '
    'returned, not visual content: never claim to have read or interpreted the page. The PNG '
    'becomes downloadable after independent result review and task completion.',
    dict(type='object', properties={}, additionalProperties=False))


class _Effect(Strict):
    kind: Literal['work_browser_capture']
    version: Literal[1]
    profileSha256: Annotated[str, Field(pattern=r'^[0-9a-f]{64}$')]
    connectionId: Id
    controlRevision: Id | None


class _Image(Strict):
    sha256: Annotated[str, Field(pattern=r'^[0-9a-f]{64}$')]
    sizeBytes: Annotated[int, Field(ge=24, le=5*1024*1024)]
    width: Annotated[int, Field(ge=1, le=8192)]
    height: Annotated[int, Field(ge=1, le=8192)]
    capturedAt: Timestamp


def capture_intent(intent):
    try:
        if (type(intent) is not dict or set(intent) != {'kind','tool','arguments','effect'}
                or intent['kind'] != 'deferred_tool' or intent['tool'] != 'capture_browser'
                or type(intent['arguments']) is not dict or intent['arguments']):
            raise ValueError()
        return _Effect.model_validate(intent['effect'])
    except (ValueError, TypeError):
        raise WorkConflict('browser_capture_intent_changed') from None


def _payload(action_id, image):
    return dict(status='captured', output=dict(name='browser-'+action_id+'.png', mediaType='image/png', **image),
        untrusted=True, visualContentProvided=False, publishedOnTaskCompletion=True)


def capture_observation(files, row, value):
    """Verify the exact private PNG without claiming that header checks decode its visual content."""
    capture_intent(row['intent'])
    try:
        if (row['requires_approval'] is not True or row['decision'] != 'approved'
                or type(value) is not dict or set(value) != {'schema','image','payload'}
                or value['schema'] != SCHEMA):
            raise ValueError()
        image = _Image.model_validate(value['image']).model_dump()
        if value['payload'] != _payload(row['id'], image): raise ValueError()
        data = files.read(image['sha256'], image['sizeBytes'])
        if (data[:8] != b'\x89PNG\r\n\x1a\n' or int.from_bytes(data[16:20],'big') != image['width']
                or int.from_bytes(data[20:24],'big') != image['height']):
            raise ValueError()
        return deepcopy(value['payload']), data
    except (ValueError, TypeError, KeyError):
        raise WorkConflict('browser_capture_observation_changed') from None


class ProductWorkBrowser:
    def __init__(self, store, client, scope, results, registry, gate):
        if (type(store.browser_profiles) is not BrowserProfiles or results.store is not store
                or type(registry) is not WorkerHostRegistry or type(gate) is not BrowserPauseGate
                or store.files is None or results.files is not store.files):
            raise InvalidWork('product_browser_composition_required')
        self.store, self.results, self.registry, self.gate = store, results, registry, gate
        self.profiles = store.browser_profiles
        self.binding = ProductWorkBinding(store, client, scope)

    async def _profile(self, db, context, *, require_fence=True, action_id=None, intent=None):
        await self.binding.check(db, context, require_fence=require_fence, action_id=action_id, intent=intent)
        task = await self.store._task(db, context.task_id, read=True)
        return await self.profiles.resolve_in_transaction(db, task)

    def _connection(self, profile, effect=None):
        connection = self.registry.browser_binding(profile.nodeId)
        if (connection.credential_digest != profile.credentialDigest
                or effect is not None and connection.connection_id != effect.connectionId):
            raise WorkConflict('browser_capture_connection_changed')
        return connection

    async def prepare(self, context, request):
        if (request.tool != 'capture_browser' or type(request.arguments) is not dict or request.arguments
                or canonical(request.arguments)[1] != request.digest):
            raise InvalidWork('browser_capture_arguments_required')
        async with self.gate.agent(context.bot_id) as revision:
            async with self.store._transaction(trusted=True) as db:
                profile, digest = await self._profile(db, context, require_fence=False)
                used = await (await db.execute('SELECT 1 FROM work_events WHERE task_id=%s AND kind=%s LIMIT 4',
                    (context.task_id, _ATTEMPT))).fetchall()
                if len(used) >= profile.maxCaptures: raise WorkConflict('browser_capture_limit')
                connection = self._connection(profile)
        return DeferredPlan(dict(kind='work_browser_capture', version=1, profileSha256=digest,
            connectionId=connection.connection_id, controlRevision=revision), 0, True, expires_seconds=300)

    async def _admitted(self, db, context, action_id, intent, *, started):
        # Canonical source/Task UPDATE lock precedes all child rows and the durable attempt count.
        _, row = await self.store._action(db, action_id)
        effect = capture_intent(intent)
        profile, digest = await self._profile(db, context, action_id=action_id, intent=intent)
        if (digest != effect.profileSha256 or row['requires_approval'] is not True
                or row['decision'] != 'approved' or not row['unexpired']):
            raise WorkConflict('browser_capture_not_authorized')
        connection = self._connection(profile, effect)
        events = await (await db.execute('SELECT payload FROM work_events WHERE task_id=%s AND kind=%s '
            'ORDER BY revision LIMIT 5', (context.task_id, _ATTEMPT))).fetchall()
        expected = dict(actionId=action_id, intentSha256=row['intent_digest'])
        own = [r['payload'] for r in events if r['payload'].get('actionId') == action_id]
        if started:
            if own != [expected] or len(events) > profile.maxCaptures:
                raise WorkConflict('browser_capture_attempt_changed')
        elif own or len(events) >= profile.maxCaptures:
            raise WorkConflict('browser_capture_limit')
        clock = await (await db.execute('SELECT clock_timestamp() AS now,c.expires_at FROM work_claims c '
            'JOIN work_runs r ON r.id=c.run_id AND r.execution_epoch=c.epoch WHERE r.id=%s',
            (context.run_id,))).fetchone()
        if not clock: raise WorkConflict('execution_claim_required')
        deadline = min(clock['now']+timedelta(seconds=25), clock['expires_at'], row['expires_at'],
            await root_deadline(db, context.task_id, context.run_id))
        if deadline <= clock['now']: raise WorkConflict('browser_capture_expired')
        if not started: await self.store._event(db, context.task_id, _ATTEMPT, expected)
        return connection, deadline

    async def load(self, context, intent):
        effect = capture_intent(intent)
        original = deepcopy(intent)
        scope = dict(task_id=context.task_id, run_id=context.run_id, intent_digest=canonical(original)[1])
        async def invoke(action_id, sent):
            if sent != original: raise WorkConflict('browser_capture_intent_changed')
            async with self.gate.agent(context.bot_id, expected_revision=effect.controlRevision):
                async with self.store._transaction(trusted=True) as db:
                    connection, deadline = await self._admitted(db, context, action_id, original, started=False)
                @asynccontextmanager
                async def dispatch(frame):
                    async with self.store._transaction(trusted=True) as db:
                        current, fresh = await self._admitted(db, context, action_id, original, started=True)
                        if current != connection: raise WorkConflict('browser_capture_connection_changed')
                        frame['expiresAt'] = iso_timestamp(min(deadline, fresh))
                        yield
                value = dict(type='browser.command', protocolVersion='0.9.0', nodeId=connection.node_id,
                    requestId=action_id, sessionId=context.task_id, botId=context.bot_id,
                    expiresAt=iso_timestamp(deadline), action=dict(kind='observe'))
                result = await self.registry.browser_command(value, binding=connection, dispatch_guard=dispatch)
                if result.get('ok') is not True: raise WorkConflict('browser_capture_unavailable')
                frame = validate_frame(result.get('frame'))
                blob = await asyncio.to_thread(self.store.files.put, base64.b64decode(frame['base64'], validate=True))
                image = dict(**blob, width=frame['width'], height=frame['height'], capturedAt=frame['capturedAt'])
                observation = dict(schema=SCHEMA, image=image, payload=_payload(action_id, image))
                async with self.store._transaction(trusted=True) as db:
                    await self._admitted(db, context, action_id, original, started=True)
                # Preserve the received observation while still holding the human gate. The
                # generic adapter's subsequent identical save is idempotent. Lost acknowledgements
                # recover this receipt only; no lookup path talks to the browser.
                await self.results.save(action_id, **scope, value=observation)
                return observation
        return EffectServices(ToolResponseAdapter(self.results, invoke, **scope), ToolResponseVerifier(self.results))

    async def _evidence(self, db, context, row):
        effect = capture_intent(row['intent'])
        _, digest = await self._profile(db, context)
        if digest != effect.profileSha256: raise WorkConflict('browser_capture_profile_changed')
        events = await (await db.execute('SELECT payload FROM work_events WHERE task_id=%s AND kind=%s '
            "AND payload->>'actionId'=%s ORDER BY revision LIMIT 2", (context.task_id,_ATTEMPT,row['id']))).fetchall()
        if [r['payload'] for r in events] != [dict(actionId=row['id'], intentSha256=row['intent_digest'])]:
            raise WorkConflict('browser_capture_attempt_changed')
        observed = await self.results.load_in_transaction(db, row['id'], task_id=context.task_id,
            run_id=context.run_id, intent_digest=row['intent_digest'])
        if observed is None: raise WorkConflict('browser_capture_observation_missing')
        # A later reconnect or human interaction does not rewrite an already received screenshot.
        # Current Task/source/identity grants still gate access to the historical bytes.
        return capture_observation(self.store.files, row, observed.value)

    async def load_result(self, context, row):
        await self.binding.claim(context)
        async with self.store._transaction(trusted=True) as db:
            payload, _ = await self._evidence(db, context, row)
            return payload

    async def _rows(self, db, context):
        return await (await db.execute("SELECT * FROM work_actions WHERE task_id=%s AND run_id=%s "
            "AND authority_generation=(SELECT authority_generation FROM work_tasks WHERE id=%s) "
            "AND intent->>'tool'='capture_browser' AND status='applied' ORDER BY created_at,id LIMIT 5",
            (context.task_id,context.run_id,context.task_id))).fetchall()

    async def revalidate_in_transaction(self, db, context):
        rows = await self._rows(db, context)
        if len(rows) > 4: raise WorkConflict('browser_capture_limit')
        for row in rows:
            await self._evidence(db, replace(context, correction_token=row['correction_context_id']), row)
        return True

    async def artifacts(self, context):
        values = []
        async with self.store._transaction(trusted=True) as db:
            await self.binding.check(db, context)
            rows = await self._rows(db, context)
            if len(rows) > 4: raise WorkConflict('browser_capture_limit')
            for row in rows:
                payload, data = await self._evidence(db, replace(context, correction_token=row['correction_context_id']), row)
                values.append(dict(key=row['id'], name=payload['output']['name'], mediaType='image/png', data=data))
        return tuple(values)
