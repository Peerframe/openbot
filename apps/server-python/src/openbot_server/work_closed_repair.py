"""Bounded command-scoped receipt lookup. No model, claim, apply or publication entry exists."""
import asyncio
from copy import deepcopy
from dataclasses import dataclass
from datetime import timedelta

from temporalio import activity, workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from .work_effects import recover_action
    from .work_reconciliation import ReconciliationStore
    from .work_repair_binding import TYPE, PREFIX, bind_repair_activity, identity, scope
    from .work_values import InvalidWork, WorkConflict
    from .work_deferred import call

CONFIG = dict(start_to_close_timeout=timedelta(seconds=40),
              schedule_to_close_timeout=timedelta(seconds=100),
              retry_policy=RetryPolicy(maximum_attempts=2,
                  non_retryable_error_types=['InvalidWork', 'WorkConflict']))


@dataclass(frozen=True)
class LookupServices:
    lookup: object
    verifier: object


class _ReadOnlyAdapter:
    def __init__(self, callback):
        self.lookup = callback


async def finish_current(store, value):
    """Preserve a finished cycle even if a later cycle changed the Action's outcome."""
    commands = ReconciliationStore(store)
    command = await commands.read(value['commandId'], **scope(value))
    if command['outcome'] is not None:
        return command['outcome']
    async with store._transaction(trusted=True) as db:
        _, row = await store._action(db, value['actionId'])
    if row['status'] not in ('unknown', 'applied', 'not_applied'):
        raise WorkConflict('reconciliation_unavailable')
    outcome = 'unresolved' if row['status'] == 'unknown' else 'resolved'
    try:
        finished = await commands.finish(value['commandId'], **scope(value), outcome=outcome)
        return finished['outcome']
    except WorkConflict as error:
        if str(error) not in ('reconciliation_outcome_changed', 'reconciliation_outcome_unverified'):
            raise
        # Settlement and command finish share the Task lock; a winning resolver is authoritative.
        finished = await commands.read(value['commandId'], **scope(value))
        if finished['outcome'] is None:
            raise
        return finished['outcome']


class ClosedRepairActivities:
    def __init__(self, store, client, *, namespace, queue, workflow_type, load_lookup):
        if not callable(load_lookup):
            raise InvalidWork('lookup_callback_required')
        self.store, self.client, self.load_lookup = store, client, load_lookup
        self.settings = dict(namespace=namespace, queue=queue, workflow_type=workflow_type)

    @activity.defn(name='openbot.closed_repair.v1')
    async def reconcile(self, value: dict) -> dict:
        value = identity(value)
        context, row = await bind_repair_activity(self.store, self.client, value, **self.settings)
        commands = ReconciliationStore(self.store)
        command = await commands.read(value['commandId'], **scope(value))
        if command['outcome'] is not None:
            return dict(commandId=value['commandId'], outcome=command['outcome'])
        # An earlier delivery to the original Workflow remains a valid historical receipt.
        if command['delivery_reference'] is None:
            await commands.acknowledge(value['commandId'], PREFIX + value['commandId'])
        if row['status'] == 'unknown':
            try:
                async with asyncio.timeout(25):
                    services = await call(self.load_lookup, context, deepcopy(row['intent']))
                    if (type(services) is not LookupServices or not callable(services.lookup)
                            or not callable(getattr(services.verifier, 'verify', None))):
                        raise InvalidWork('invalid_lookup_services')
                    await recover_action(self.store, **scope(value),
                        adapter=_ReadOnlyAdapter(services.lookup), verifier=services.verifier)
            except TimeoutError:
                pass  # No observation, no refund: the existing unknown reservation survives.
        outcome = await finish_current(self.store, value)
        return dict(commandId=value['commandId'], outcome=outcome)

    @activity.defn(name='openbot.closed_repair_finish.v1')
    async def finish(self, value: dict) -> dict:
        value = identity(value)
        await bind_repair_activity(self.store, self.client, value, **self.settings)
        return dict(commandId=value['commandId'], outcome=await finish_current(self.store, value))


@workflow.defn(name=TYPE)
class ClosedRepair:
    @workflow.run
    async def run(self, value: dict) -> dict:
        from temporalio.exceptions import ActivityError
        try:
            return await workflow.execute_activity('openbot.closed_repair.v1', value, **CONFIG)
        except ActivityError:
            # This second activity also performs exact binding. Failure cannot authorize lookup.
            return await workflow.execute_activity('openbot.closed_repair_finish.v1', value,
                **(CONFIG | dict(schedule_to_close_timeout=timedelta(seconds=55))))
