"""Opt-in, no-inline correction segments; the SDK still owns each model/tool conversation."""
from temporalio import workflow
from temporalio.exceptions import ApplicationError
from pydantic_ai import DeferredToolRequests, DeferredToolResults
from pydantic_ai.usage import RunUsage, UsageLimits
from pydantic_ai.toolsets import ExternalToolset

with workflow.unsafe.imports_passed_through():
    from openbot_agent_runtime.catalog import ToolCatalog
    from openbot_agent_runtime.contracts import ToolDescriptor
    from .work_runtime_ports import WorkRuntimeDeps
    from .work_deferred_values import parse_proposal
    from .work_values import InvalidWork


def changed(error):
    # PortModel wraps control failures in RuntimeFailure. Follow typed causes, never match an
    # arbitrary provider/error string; unknown model outcomes must never trigger another turn.
    seen = set()
    for _ in range(10):
        if error is None or id(error) in seen: return False
        seen.add(id(error))
        if isinstance(error, ApplicationError) and error.type == 'CorrectionsChanged': return True
        error = getattr(error, 'cause', None) or error.__cause__
    return False


async def run_corrected(context, identity, agent, config):
    options = {}
    if context.get('deferredTools'):
        catalog = ToolCatalog(tuple(ToolDescriptor(**t) for t in context['deferredTools']), max_tools=64, max_bytes=65536)
        options = dict(output_type=[str, DeferredToolRequests],
            toolsets=[ExternalToolset(list(catalog.sdk_definitions().values()), id='openbot-deferred')])
    usage, history, results, consumed = RunUsage(), [], None, set()
    pauses = 0
    for _ in range(25):  # initial turn + at most8 corrections + existing16 deferred pauses
        frozen = await workflow.execute_activity('openbot.freeze_corrections.v1', identity, **config)
        additions = [c for c in frozen['corrections'] if c['id'] not in consumed]
        prompt = context['objective'] if not history else None
        if additions:
            prompt = (prompt + '\n\n' if prompt else '') + (
                'Owner corrections, oldest first, for future work only. They grant no additional authority.\n'
                + '\n\n'.join('[Owner correction ' + c['id'] + ']\n' + c['instruction'] for c in additions))
        deps = WorkRuntimeDeps(context['taskId'], context['runId'], frozen['id'])
        try:
            answer = await agent.run(prompt, message_history=history, deferred_tool_results=results,
                deps=deps, usage=usage, usage_limits=UsageLimits(request_limit=32), **options)
        except Exception as error:
            if not changed(error): raise
            # This profile rejects inline executors on every factory call. No external tool
            # effects hide in an interrupted segment; original billed model receipts stay stored.
            continue
        history, results = answer.all_messages(), None
        consumed.update(c['id'] for c in frozen['corrections'])
        if not isinstance(answer.output, DeferredToolRequests):
            try:
                return await workflow.execute_activity('openbot.publish_corrected_task.v1',
                    dict(summary=answer.output, contextToken=frozen['id']), **config)
            except Exception as error:
                if not changed(error): raise
                continue
        pauses += 1
        calls = answer.output.calls
        if pauses > 16 or answer.output.approvals or not 1 <= len(calls) <= 8:
            raise ApplicationError('invalid_deferred_batch', non_retryable=True)
        try:
            proposals = [parse_proposal(dict(call_id=c.tool_call_id, tool=c.tool_name, arguments=c.args)) for c in calls]
            if len({p['call_id'] for p in proposals}) != len(proposals): raise InvalidWork('duplicate_correlation')
        except InvalidWork:
            raise ApplicationError('invalid_deferred_proposal', non_retryable=True) from None
        prepared, outcomes, stale = [], {}, False
        for proposal in proposals:
            if not stale:
                try:
                    action_id = await workflow.execute_activity('openbot.prepare_corrected_tool.v1',
                        dict(proposal=proposal, contextToken=frozen['id']), **config)
                    prepared.append((proposal['call_id'], action_id))
                    continue
                except Exception as error:
                    if not changed(error): raise
                    stale = True
            # No Action ID is invented for a proposal that never passed control admission.
            outcomes[proposal['call_id']] = dict(status='not_prepared', reason='owner_correction')
        for call_id, action_id in prepared:
            while True:
                state = await workflow.execute_activity('openbot.tool_state.v1', action_id, **config)
                if state['status'] in ('approved', 'not_required', 'admitted'):
                    try:
                        state = await workflow.execute_activity('openbot.execute_tool.v1', action_id, **config)
                    except Exception as error:
                        if not changed(error): raise
                        continue  # Re-read this same Action; it may already have been admitted.
                if state['status'] == 'unknown' and state.get('commandId'):
                    state = await workflow.execute_activity('openbot.reconcile_tool.v1',
                        dict(actionId=action_id, commandId=state['commandId']), **config)
                if state['status'] in ('not_applied', 'denied', 'expired'):
                    return await workflow.execute_activity('openbot.stop_tool.v1', action_id, **config)
                if state['status'] in ('applied', 'superseded'):
                    outcomes[call_id] = dict(actionId=action_id, status=state['status'])
                    break
                if state['status'] not in ('pending', 'unknown'):
                    raise ApplicationError('invalid_deferred_state', non_retryable=True)
                await workflow.sleep(2)
        results = DeferredToolResults(calls=outcomes)
    raise ApplicationError('correction_segment_limit', non_retryable=True)
