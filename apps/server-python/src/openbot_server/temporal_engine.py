"""Temporal transport for the control-owned, one-Run handoff decision.

The SDK is an optional deployment dependency until the production worker is wired.
This adapter never decides authorization or retries an unknown start. A later
delivery must inspect the original workflow through ``dispatch_one``.
"""

from datetime import timedelta

from .work_dispatcher import EngineAlreadyStarted, StartEvent


class TemporalEnginePort:
    """Bind the actual client namespace and decode immutable start-history facts."""

    def __init__(self, client):
        self.client = client
        self.namespace = client.namespace

    async def start_workflow(self, workflow_id, workflow_type, queue, start_input, execution_timeout):
        from temporalio.common import WorkflowIDReusePolicy
        from temporalio.exceptions import WorkflowAlreadyStartedError

        try:
            await self.client.start_workflow(
                workflow_type, start_input, id=workflow_id, task_queue=queue,
                execution_timeout=timedelta(seconds=execution_timeout),
                id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
            )
        except WorkflowAlreadyStartedError as error:
            # A duplicate identifier is not proof that this Run owns the history.
            raise EngineAlreadyStarted() from error

    async def inspect_start(self, workflow_id):
        from temporalio.service import RPCError, RPCStatusCode

        handle = self.client.get_workflow_handle(workflow_id)
        try:
            async for event in handle.fetch_history_events(page_size=1):
                break
            else:
                return None
        except RPCError as error:
            # Only an absent history means unconfirmed. A decoder failure, even one
            # with the same status code, is not evidence about engine retention.
            if error.status == RPCStatusCode.NOT_FOUND:
                return None
            raise
        if not event.HasField('workflow_execution_started_event_attributes'):
            return None
        start = event.workflow_execution_started_event_attributes
        if start.workflow_id != workflow_id or not start.first_execution_run_id:
            raise ValueError('Invalid engine start identity')
        decoded = await self.client.data_converter.decode(start.input.payloads, [dict])
        if len(decoded) != 1 or type(decoded[0]) is not dict:
            raise ValueError('Invalid engine start input')
        return StartEvent(start.workflow_type.name, start.task_queue.name, decoded[0],
                          start.first_execution_run_id)
