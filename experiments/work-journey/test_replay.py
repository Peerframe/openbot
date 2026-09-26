"""Replay adapter guards and error classification; real histories belong to the probe."""
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from pydantic_ai.durable_exec.temporal import PydanticAIPlugin, PydanticAIPayloadConverter
from temporalio import workflow
from temporalio.api.common.v1 import ActivityType, WorkflowType
from temporalio.api.history.v1 import (
    ActivityTaskScheduledEventAttributes, HistoryEvent,
    WorkflowExecutionStartedEventAttributes,
)
from temporalio.client import WorkflowHistory
from temporalio.worker import Replayer
from temporalio.worker.workflow_sandbox import SandboxedWorkflowRunner

import replay
from workflow_worker import WorkJourney


def synthetic_history():
    """Only adapter preconditions; this is deliberately not a replayable history."""
    return WorkflowHistory('workflow-reference', [
        HistoryEvent(workflow_execution_started_event_attributes=WorkflowExecutionStartedEventAttributes(
            workflow_type=WorkflowType(name='WorkJourney'), original_execution_run_id='run-reference')),
        HistoryEvent(activity_task_scheduled_event_attributes=ActivityTaskScheduledEventAttributes(
            activity_type=ActivityType(name='bind_identity'))),
    ])


class PluginConfigurationTests(unittest.TestCase):
    def test_official_plugin_configures_replayer_without_activity_registration(self):
        with ThreadPoolExecutor(max_workers=2) as executor:
            replayer = Replayer(workflows=[WorkJourney], plugins=[PydanticAIPlugin()],
                                workflow_task_executor=executor)
            config = replayer.config(active_config=True)
            self.assertEqual(config['workflows'], [WorkJourney])
            self.assertIs(config['data_converter'].payload_converter_class, PydanticAIPayloadConverter)
            self.assertIsInstance(config['workflow_runner'], SandboxedWorkflowRunner)
            self.assertIn('pydantic_ai', config['workflow_runner'].restrictions.passthrough_modules)
            self.assertNotIn('activities', config)


class ReplayAcceptanceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.history = synthetic_history()
        self.current = AsyncMock()
        self.incompatible = AsyncMock(side_effect=workflow.NondeterminismError('command mismatch'))
        replacement = patch.object(replay, 'Replayer', side_effect=[
            SimpleNamespace(replay_workflow=self.current),
            SimpleNamespace(replay_workflow=self.incompatible),
        ])
        self.replayer = replacement.start()
        self.addCleanup(replacement.stop)

    async def test_both_definitions_receive_same_history_and_plugin(self):
        result = await replay.verify_history_replay(self.history)
        self.current.assert_awaited_once_with(self.history)
        self.incompatible.assert_awaited_once_with(self.history)
        configurations = [call.kwargs for call in self.replayer.call_args_list]
        self.assertEqual(configurations[0]['workflows'], [WorkJourney])
        self.assertEqual(configurations[1]['workflows'], [replay._IncompatibleWorkJourney])
        self.assertIs(configurations[0]['workflow_task_executor'], configurations[1]['workflow_task_executor'])
        for config in configurations:
            self.assertEqual(len(config['plugins']), 1)
            self.assertIsInstance(config['plugins'][0], PydanticAIPlugin)
        self.assertEqual(result, {'workflowId': 'workflow-reference', 'runId': 'run-reference',
                                 'eventCount': 2, 'currentReplay': 'passed',
                                 'incompatibleReplay': 'rejected',
                                 'incompatibleFailure': 'NondeterminismError'})

    async def test_current_code_failure_propagates_before_negative_case(self):
        failure = workflow.NondeterminismError('current workflow changed')
        self.current.side_effect = failure
        with self.assertRaises(workflow.NondeterminismError) as raised:
            await replay.verify_history_replay(self.history)
        self.assertIs(raised.exception, failure)
        self.incompatible.assert_not_awaited()
        self.assertEqual(self.replayer.call_count, 1)

    async def test_negative_replay_success_is_failure(self):
        self.incompatible.side_effect = None
        with self.assertRaisesRegex(AssertionError, 'incompatible first workflow command'):
            await replay.verify_history_replay(self.history)

    async def test_arbitrary_negative_error_is_not_detection(self):
        failure = RuntimeError('payload decoding failed')
        self.incompatible.side_effect = failure
        with self.assertRaises(RuntimeError) as raised:
            await replay.verify_history_replay(self.history)
        self.assertIs(raised.exception, failure)

    async def test_rejects_wrong_input_or_empty_history(self):
        with self.assertRaises(TypeError):
            await replay.verify_history_replay({'events': []})
        with self.assertRaises(ValueError):
            await replay.verify_history_replay(WorkflowHistory('empty', []))
        self.replayer.assert_not_called()

    async def test_rejects_wrong_workflow_type(self):
        self.history.events[0].workflow_execution_started_event_attributes.workflow_type.name = 'OtherWorkflow'
        with self.assertRaisesRegex(ValueError, 'Expected WorkJourney'):
            await replay.verify_history_replay(self.history)
        self.replayer.assert_not_called()

    async def test_rejects_history_before_initial_command(self):
        early = WorkflowHistory('early', self.history.events[:1])
        with self.assertRaisesRegex(ValueError, 'initial bind_identity'):
            await replay.verify_history_replay(early)
        self.replayer.assert_not_called()


if __name__ == '__main__':
    unittest.main()
