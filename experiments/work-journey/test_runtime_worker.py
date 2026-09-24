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


if __name__ == '__main__':
    unittest.main()
