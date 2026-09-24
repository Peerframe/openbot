"""Control context activities; actual SDK binding precedes every Task/Run correlation."""
import hashlib
from temporalio import activity
from .work_corrections import CorrectionStore
from .work_temporal_activity import _bind_activity_identity
from .work_values import InvalidWork, WorkConflict, canonical, text


class CorrectionActivities:
    def __init__(self, host):
        self.host = host
        self.store = CorrectionStore(host.store)

    @activity.defn(name='openbot.freeze_corrections.v1')
    async def freeze(self, identity: dict) -> dict:
        accepted, activity_id = await _bind_activity_identity(self.host.store, self.host.client, **self.host.scope)
        if (accepted.task_id, accepted.run_id) != (identity.get('taskId'), identity.get('runId')):
            raise WorkConflict('runtime_deps_scope_mismatch')
        data, _ = canonical([accepted.engine_run_id, activity_id])
        key = 'context-v1-' + hashlib.sha256(data).hexdigest()
        return await self.store.freeze(accepted.task_id, accepted.run_id, key)

    @activity.defn(name='openbot.prepare_corrected_tool.v1')
    async def prepare(self, value: dict) -> str:
        if type(value) is not dict or set(value) != {'proposal', 'contextToken'}:
            raise InvalidWork('invalid_corrected_proposal')
        if self.host.deferred is None: raise WorkConflict('deferred_tools_unconfigured')
        return await self.host.deferred.prepare_request(value['proposal'], text(value['contextToken'], 128))

    @activity.defn(name='openbot.publish_corrected_task.v1')
    async def publish(self, value: dict) -> dict:
        if type(value) is not dict or set(value) != {'summary', 'contextToken'}:
            raise InvalidWork('invalid_corrected_result')
        return await self.host.publish_result(text(value['summary'], 16384), text(value['contextToken'], 128))
