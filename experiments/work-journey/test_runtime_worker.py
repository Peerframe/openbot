"""Reference Worker binding regressions; public Task/PG/engine evidence belongs to probe.py."""
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from pydantic_ai.messages import ModelRequest, UserPromptPart
from pydantic_ai.models import ModelRequestParameters

import workflow_worker as worker
from openbot_agent_runtime.errors import RuntimeFailure


class RuntimeWorkerBindingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.deps = worker.WorkDeps('task-owned', 'run-owned')
        self.accepted = SimpleNamespace(task_id=self.deps.task_id, run_id=self.deps.run_id)
        self.bound = self.enterContext(patch.object(worker, 'bind_current_activity',
                                                   new=AsyncMock(return_value=self.accepted)))
        self.enterContext(patch.object(worker.control, 'settings', return_value={'queue': 'owned-queue'}))
        self.enterContext(patch.object(worker.control, 'store', return_value=object()))
        self.perform = self.enterContext(patch.object(worker.control, 'perform',
                                                     new=AsyncMock(return_value='plan')))

    async def test_wrong_run_deps_never_load_a_model_or_tool_port(self):
        for factory in (worker.model_factory, worker.toolset_factory):
            with self.subTest(factory=factory.__name__):
                with self.assertRaisesRegex(worker.control.WorkConflict, 'runtime_deps_scope_mismatch'):
                    await factory(worker.WorkDeps('task-owned', 'another-run'))
        self.perform.assert_not_awaited()

    async def test_closed_engine_binding_refuses_both_factories(self):
        self.bound.side_effect = worker.control.WorkConflict('admission_closed')
        for factory in (worker.model_factory, worker.toolset_factory):
            with self.subTest(factory=factory.__name__):
                with self.assertRaisesRegex(worker.control.WorkConflict, 'admission_closed'):
                    await factory(self.deps)
        self.perform.assert_not_awaited()

    async def test_revocation_after_loading_stops_before_a_model_effect(self):
        model = await worker.model_factory(self.deps)
        self.bound.side_effect = worker.control.WorkConflict('admission_closed')
        with self.assertRaises(RuntimeFailure):
            await model.request([ModelRequest(parts=[UserPromptPart('Synthetic objective')])],
                                None, ModelRequestParameters())
        self.perform.assert_not_awaited()

    async def test_revocation_after_model_effect_blocks_its_result(self):
        model = await worker.model_factory(self.deps)
        async def revoke_after_effect(*_args):
            self.bound.side_effect = worker.control.WorkConflict('admission_closed')
            return 'plan'
        self.perform.side_effect = revoke_after_effect
        with self.assertRaises(RuntimeFailure):
            await model.request([ModelRequest(parts=[UserPromptPart('Synthetic objective')])],
                                None, ModelRequestParameters())
        self.perform.assert_awaited_once_with('model:plan', {'kind': 'model', 'stage': 'plan'})

    async def test_deferred_write_is_not_exposed_as_an_inline_runtime_tool(self):
        tools = await worker.toolset_factory(self.deps)
        declarations = await tools.get_tools(None)
        self.assertEqual(set(declarations), {'read_row'})
        model = await worker.model_factory(self.deps)
        self.assertEqual({item.name for item in model._offered_tools(ModelRequestParameters(
            function_tools=[declarations['read_row'].tool_def]))}, {'read_row'})
        self.perform.assert_not_awaited()


class RuntimeStartupTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.identity = {'taskId': 'task-owned', 'runId': 'run-owned', 'attemptId': 'a' * 32}
        self.original = self.enterContext(patch.object(worker.control, 'bind_identity', new=AsyncMock()))
        self.context = SimpleNamespace(task_id='task-owned', run_id='run-owned')
        self.load = self.enterContext(patch.object(worker, 'load_current_activity_task',
                                                  new=AsyncMock(return_value=self.context)))
        self.enterContext(patch.object(worker.control, 'settings', return_value={'queue': 'owned-queue'}))
        self.store = object()
        self.enterContext(patch.object(worker.control, 'store', return_value=self.store))

    async def test_startup_retains_original_check_and_none_history_result(self):
        self.assertIsNone(await worker.bind_identity(self.identity))
        self.original.assert_awaited_once_with(self.identity)
        self.load.assert_awaited_once_with(self.store, worker._ENGINE,
            expected_namespace='default', expected_queue='owned-queue', expected_workflow_type='WorkJourney')

    async def test_wrong_initial_attempt_never_loads_task_context(self):
        self.original.side_effect = worker.control.ReceiptMismatch('Wrong immutable attempt')
        with self.assertRaises(worker.control.ReceiptMismatch):
            await worker.bind_identity(self.identity)
        self.load.assert_not_awaited()

    async def test_pending_is_exposed_to_engine_without_in_activity_retry(self):
        from openbot_server.work_temporal_start import WorkStartPending
        self.load.side_effect = WorkStartPending()
        with self.assertRaises(WorkStartPending):
            await worker.bind_identity(self.identity)
        self.load.assert_awaited_once()

    async def test_loaded_context_cannot_be_substituted_for_another_run(self):
        self.load.return_value = SimpleNamespace(task_id='task-owned', run_id='other-run')
        with self.assertRaisesRegex(worker.control.WorkConflict, 'runtime_deps_scope_mismatch'):
            await worker.bind_identity(self.identity)


if __name__ == '__main__':
    unittest.main()
