"""Opt-in, no-inline correction segments; the SDK still owns each model/tool conversation."""
from temporalio import workflow
from temporalio.exceptions import ApplicationError
import json
from pydantic_ai import DeferredToolRequests, DeferredToolResults
from pydantic_ai.usage import RunUsage, UsageLimits
from pydantic_ai.toolsets import ExternalToolset

with workflow.unsafe.imports_passed_through():
    from openbot_agent_runtime.catalog import ToolCatalog
    from openbot_agent_runtime.contracts import ToolDescriptor
    from .work_runtime_ports import WorkRuntimeDeps
    from .work_deferred_values import parse_proposal
    from .work_values import InvalidWork
    from .work_collaboration_workflow import completion_children, join_child


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


async def run_corrected(context, identity, agent, config, *, deadline=None):
    options = {}
    if context.get('deferredTools'):
        catalog = ToolCatalog(tuple(ToolDescriptor(**t) for t in context['deferredTools']), max_tools=64, max_bytes=65536)
        options = dict(output_type=[str, DeferredToolRequests],
            toolsets=[ExternalToolset(list(catalog.sdk_definitions().values()), id='openbot-deferred')])
    usage, history, results, consumed = RunUsage(), [], None, set()
    pauses, next_prompt = 0, None
    # Collaboration can add result-consumption turns; the same cumulative32 model-request
    # bound still applies, with at most8 correction races before a request is admitted.
    for _ in range(41 if context.get('collaborationProtocol')==1 else 25):
        frozen = await workflow.execute_activity('openbot.freeze_corrections.v1', identity, **config)
        additions = [c for c in frozen['corrections'] if c['id'] not in consumed]
        reset = bool(additions and context.get('correctionHistoryProtocol') == 1)
        if reset:
            # A model message may quote old knowledge even after its tool result is removed.
            # Discard the entire conversation; durable Action truth remains in the Server.
            history, results = [], None
            additions = frozen['corrections']
        prompt = context.get('prompt', context['objective']) if not history else None
        if not reset and next_prompt:
            prompt=(prompt+'\n\n' if prompt else '')+next_prompt
        next_prompt=None
        if additions:
            prompt = (prompt + '\n\n' if prompt else '') + (
                'Owner corrections, oldest first, for future work only. They grant no additional authority.\n'
                + '\n\n'.join('[Owner correction ' + c['id'] + ']\n' + c['instruction'] for c in additions))
        if reset:
            prompt += ('\n\nEarlier conversation content was discarded after the correction. '
                'These Server Action facts record prior operations. Do not repeat completed effects '
                'or infer the outcome of unknown operations; no earlier results are supplied.\n'
                + json.dumps(frozen.get('priorActions', []), sort_keys=True, separators=(',', ':')))
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
                continuation,terminal=await completion_children(context,frozen['id'],config)
                if terminal is not None:return terminal
                if continuation is not None:
                    next_prompt=continuation
                    continue
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
            proposals = [parse_proposal(dict(call_id=c.tool_call_id, tool=c.tool_name, arguments=c.args),
                large_arguments=context.get('largeToolArgumentsProtocol') == 1) for c in calls]
            if len({p['call_id'] for p in proposals}) != len(proposals): raise InvalidWork('duplicate_correlation')
        except InvalidWork:
            raise ApplicationError('invalid_deferred_proposal', non_retryable=True) from None
        prepared, outcomes, stale = [], {}, False
        if deadline is not None and any(p['tool'] in ('start_task','delegate_task') for p in proposals):
            deadline.expect_tree()
        for proposal in proposals:
            if not stale:
                try:
                    action_id = await workflow.execute_activity('openbot.prepare_corrected_tool.v1',
                        dict(proposal=proposal, contextToken=frozen['id']), **config)
                    prepared.append((proposal['call_id'], action_id,proposal['tool']))
                    continue
                except Exception as error:
                    if not changed(error): raise
                    stale = True
            # No Action ID is invented for a proposal that never passed control admission.
            outcomes[proposal['call_id']] = dict(status='not_prepared', reason='owner_correction')
        for call_id, action_id,tool in prepared:
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
                    try:
                        if (state['status']=='applied' and tool=='delegate_task'
                                and context.get('collaborationProtocol')==1):
                            outcomes[call_id],terminal=await join_child(action_id,frozen['id'],config)
                            if terminal is not None:return terminal
                        else:
                            outcomes[call_id] = (await workflow.execute_activity('openbot.tool_result.v1', action_id, **config)
                            if state['status'] == 'applied' and context.get('toolResultProtocol') == 1
                            else dict(actionId=action_id, status=state['status']))
                    except Exception as error:
                        if context.get('correctionHistoryProtocol') != 1 or not changed(error): raise
                        outcomes[call_id] = dict(actionId=action_id, status=state['status'],
                                                resultUnavailable='owner_correction')
                    break
                if state['status'] not in ('pending', 'unknown'):
                    raise ApplicationError('invalid_deferred_state', non_retryable=True)
                await workflow.sleep(2)
        results = DeferredToolResults(calls=outcomes)
    raise ApplicationError('correction_segment_limit', non_retryable=True)
