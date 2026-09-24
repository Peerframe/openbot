"""Focused unit tests for the Worker-only runtime port factory.

The tests replace the SDK binding seam and the read-only context loader with mocks and never
start a Temporal service or a database. They pin the factory's safety ordering: the typed routing
deps are checked before anything is loaded, the accepted context is matched before services are
assembled, a stale binding after the awaited context loader leaves the service callbacks unused,
a revocation during a model or tool await refuses that result, cancellation is never swallowed,
every Activity gets a fresh guard/catalog/port, and the final descriptor trees are detached from
the caller's nested schemas.
"""
import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

_ROOT = Path(__file__).resolve().parents[2]
# Prepend the two existing source trees; the tests perform no environment read and install nothing.
for _relative in ('apps/server-python/src', 'apps/agent-runtime-python/src'):
    _source = str(_ROOT / _relative)
    if _source not in sys.path:
        sys.path.insert(0, _source)

from pydantic_ai.messages import (  # noqa: E402
    ModelRequest,
    ModelResponse,
    TextPart,
    UserPromptPart,
)
from pydantic_ai.models import ModelRequestParameters  # noqa: E402

from openbot_agent_runtime.contracts import RuntimeLimits, ToolDescriptor  # noqa: E402
from openbot_agent_runtime.errors import FailureReason, RuntimeFailure  # noqa: E402

from openbot_server import work_runtime_ports as ports  # noqa: E402
from openbot_server.work_runtime_ports import (  # noqa: E402
    WorkRuntimeDeps,
    WorkRuntimePortFactory,
    WorkRuntimeServices,
)
from openbot_server.work_values import WorkConflict  # noqa: E402

NAMESPACE = 'openbot-namespace'
QUEUE = 'openbot-work'
WORKFLOW_TYPE = 'WorkJourney'
TASK_ID = 'task-1'
RUN_ID = 'run-1'

READ = ToolDescriptor(
    name='read_row',
    description='Read the permitted row.',
    input_schema={'type': 'object', 'properties': {'row': {'type': 'integer'}},
                  'required': ['row'], 'additionalProperties': False},
)
WRITE = ToolDescriptor(
    name='write_row',
    description='Propose the reviewed correction.',
    input_schema={'type': 'object',
                  'properties': {'row': {'type': 'integer'}, 'value': {'type': 'string'}},
                  'required': ['row', 'value'], 'additionalProperties': False},
)


def context(task_id=TASK_ID, run_id=RUN_ID):
    """The detached product context the existing read-only loader returns."""
    return SimpleNamespace(task_id=task_id, run_id=run_id)


def accepted(task_id=TASK_ID, run_id=RUN_ID):
    """The correlation record the existing binding gate returns."""
    return SimpleNamespace(task_id=task_id, run_id=run_id)


async def model_step(request):
    return ModelResponse(parts=[TextPart('done')], model_name='openbot-port')


async def tool_call(request):
    return {'ok': True}


def services(*, model_tools=(READ,), inline_tools=(READ,), step=model_step, call=tool_call):
    return WorkRuntimeServices(model_step=step, tool_call=call, model_tools=model_tools,
                               inline_tools=inline_tools)


class FactoryTestCase(unittest.IsolatedAsyncioTestCase):
    def make_factory(self, *, loader=None, context_value=None, accepted_value=None,
                     limits=RuntimeLimits(), deadline_seconds=30, bind=None):
        loaded_context = context() if context_value is None else context_value
        self.loaded = self.enterContext(patch.object(
            ports, 'load_current_activity_task', new=AsyncMock(return_value=loaded_context)))
        bound_value = accepted() if accepted_value is None else accepted_value
        self.bound = self.enterContext(patch.object(
            ports, 'bind_current_activity',
            new=bind if bind is not None else AsyncMock(return_value=bound_value)))
        self.loader = loader if loader is not None else AsyncMock(return_value=services())
        return WorkRuntimePortFactory(
            object(), object(), expected_namespace=NAMESPACE, expected_queue=QUEUE,
            expected_workflow_type=WORKFLOW_TYPE, load_services=self.loader, limits=limits,
            deadline_seconds=deadline_seconds)

    async def test_wrong_typed_deps_are_refused_before_any_loader(self):
        factory = self.make_factory()
        for method in (factory.model_factory, factory.toolset_factory):
            with self.subTest(method=method.__name__):
                with self.assertRaises(RuntimeFailure) as raised:
                    await method(object())
                self.assertEqual(raised.exception.reason, FailureReason.INVALID_REQUEST)
        self.loaded.assert_not_awaited()
        self.loader.assert_not_awaited()

    async def test_non_string_deps_ids_are_refused_before_any_loader(self):
        factory = self.make_factory()
        with self.assertRaises(RuntimeFailure) as raised:
            await factory.model_factory(WorkRuntimeDeps(1, RUN_ID))
        self.assertEqual(raised.exception.reason, FailureReason.INVALID_REQUEST)
        self.loaded.assert_not_awaited()

    async def test_empty_or_unbounded_ids_refused_before_loading(self):
        factory = self.make_factory()
        for value in ('', ' ', 'x' * 129):
            with self.subTest(value=value), self.assertRaises(RuntimeFailure):
                await factory.model_factory(WorkRuntimeDeps(value, RUN_ID))
        self.loaded.assert_not_awaited()

    async def test_binding_deadline_stops_before_service_or_port(self):
        for slow_call in (1, 2):
            clock = [0.0]
            factory = self.make_factory(deadline_seconds=1)
            calls = 0
            async def binding(*args, **kwargs):
                nonlocal calls
                calls += 1
                if calls == slow_call:
                    clock[0] = 2.0
                return accepted()
            self.bound.side_effect = binding
            original = ports.RunGuard
            with patch.object(ports, 'RunGuard', side_effect=lambda **kwargs: original(**kwargs, clock=lambda: clock[0])):
                with self.assertRaises(RuntimeFailure) as raised:
                    await factory.model_factory(WorkRuntimeDeps(TASK_ID, RUN_ID))
            self.assertEqual(raised.exception.reason, FailureReason.DEADLINE_EXCEEDED)
            if slow_call == 1:
                self.loader.assert_not_awaited()

    async def test_wrong_task_or_run_is_refused_before_services(self):
        factory = self.make_factory()
        for wrong in (WorkRuntimeDeps('other-task', RUN_ID),
                      WorkRuntimeDeps(TASK_ID, 'other-run')):
            with self.subTest(wrong=wrong):
                with self.assertRaisesRegex(WorkConflict, 'runtime_deps_scope_mismatch'):
                    await factory.model_factory(wrong)
        self.loader.assert_not_awaited()

    async def test_stale_binding_during_context_loader_leaves_callbacks_unused(self):
        factory = self.make_factory()

        async def load_and_revoke(*_args, **_kwargs):
            self.bound.side_effect = WorkConflict('admission_closed')
            return context()

        self.loaded.side_effect = load_and_revoke
        with self.assertRaisesRegex(WorkConflict, 'admission_closed'):
            await factory.model_factory(WorkRuntimeDeps(TASK_ID, RUN_ID))
        self.loaded.assert_awaited_once()
        self.loader.assert_not_awaited()

    async def test_recheck_before_and_after_services(self):
        factory = self.make_factory()
        await factory.model_factory(WorkRuntimeDeps(TASK_ID, RUN_ID))
        # Both awaited loader boundaries are checked before returning a port.
        self.assertEqual(self.bound.await_count, 2)
        self.loaded.assert_awaited_once()
        self.loader.assert_awaited_once()

    async def test_revocation_during_service_loader_returns_no_port(self):
        for factory_method in ('model_factory', 'toolset_factory'):
            with self.subTest(factory_method=factory_method):
                factory = self.make_factory()
                callback = AsyncMock()

                async def revoked_loader(_context):
                    self.bound.side_effect = WorkConflict('admission_closed')
                    return services(step=callback, call=callback)

                factory._load_services = revoked_loader
                with self.assertRaisesRegex(WorkConflict, 'admission_closed'):
                    await getattr(factory, factory_method)(WorkRuntimeDeps(TASK_ID, RUN_ID))
                callback.assert_not_awaited()

    async def test_revocation_during_model_await_refuses_its_result(self):
        factory = self.make_factory()
        seen = []

        async def revoking_step(request):
            seen.append(request)
            self.bound.side_effect = WorkConflict('admission_closed')
            return ModelResponse(parts=[TextPart('untrusted')], model_name='openbot-port')

        self.loader.return_value = services(step=revoking_step)
        model = await factory.model_factory(WorkRuntimeDeps(TASK_ID, RUN_ID))
        self.bound.reset_mock()
        with self.assertRaises(RuntimeFailure) as raised:
            await model.request([ModelRequest(parts=[UserPromptPart('Do the work')])], None,
                                ModelRequestParameters())
        self.assertEqual(raised.exception.reason, FailureReason.AUTHORITY_REVOKED)
        self.assertEqual(len(seen), 1)
        # Two authority checks bracket the model await, then the post-await check refuses.
        self.assertEqual(self.bound.await_count, 3)

    async def test_revocation_during_tool_await_refuses_its_result(self):
        factory = self.make_factory()

        async def revoking_call(request):
            self.bound.side_effect = WorkConflict('admission_closed')
            return {'ok': True}

        self.loader.return_value = services(call=revoking_call)
        toolset = await factory.toolset_factory(WorkRuntimeDeps(TASK_ID, RUN_ID))
        self.bound.reset_mock()
        declarations = await toolset.get_tools(None)
        with self.assertRaises(RuntimeFailure) as raised:
            await toolset.call_tool('read_row', {'row': 1}, SimpleNamespace(tool_call_id='call-1'),
                                    declarations['read_row'])
        self.assertEqual(raised.exception.reason, FailureReason.AUTHORITY_REVOKED)
        self.assertEqual(self.bound.await_count, 2)

    async def test_model_port_cancellation_is_not_swallowed(self):
        factory = self.make_factory()

        async def cancelling_step(request):
            raise asyncio.CancelledError()

        self.loader.return_value = services(step=cancelling_step)
        model = await factory.model_factory(WorkRuntimeDeps(TASK_ID, RUN_ID))
        with self.assertRaises(asyncio.CancelledError):
            await model.request([ModelRequest(parts=[UserPromptPart('Do the work')])], None,
                                ModelRequestParameters())

    async def test_authority_cancellation_is_not_swallowed(self):
        factory = self.make_factory()
        self.loader.return_value = services()
        model = await factory.model_factory(WorkRuntimeDeps(TASK_ID, RUN_ID))
        self.bound.side_effect = asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await model.request([ModelRequest(parts=[UserPromptPart('Do the work')])], None,
                                ModelRequestParameters())

    async def test_each_context_gets_fresh_guard_catalog_and_port(self):
        factory = self.make_factory()
        self.loaded.side_effect = [context('task-1', 'run-1'), context('task-2', 'run-2')]
        self.bound.side_effect = [accepted('task-1', 'run-1')] * 2 + [accepted('task-2', 'run-2')] * 2
        first = await factory.model_factory(WorkRuntimeDeps('task-1', 'run-1'))
        second = await factory.model_factory(WorkRuntimeDeps('task-2', 'run-2'))
        self.assertIsNot(first, second)
        self.assertIsNot(first._guard, second._guard)
        self.assertIsNot(first._catalog, second._catalog)
        self.assertEqual(self.loaded.await_count, 2)
        self.assertEqual(self.loader.await_count, 2)

    async def test_model_catalog_offers_every_tool_and_executing_catalog_only_inline(self):
        factory = self.make_factory()
        self.loader.return_value = services(model_tools=(READ, WRITE), inline_tools=(READ,))
        model = await factory.model_factory(WorkRuntimeDeps(TASK_ID, RUN_ID))
        toolset = await factory.toolset_factory(WorkRuntimeDeps(TASK_ID, RUN_ID))
        self.assertEqual(model._catalog.names, frozenset({'read_row', 'write_row'}))
        self.assertEqual(toolset._catalog.names, frozenset({'read_row'}))
        with self.assertRaises(RuntimeFailure) as raised:
            toolset._catalog.descriptor('write_row')
        self.assertEqual(raised.exception.reason, FailureReason.UNKNOWN_TOOL)

    async def test_nested_schema_mutation_does_not_reach_returned_ports(self):
        declared = {'type': 'object', 'properties': {'row': {'type': 'integer'}},
                    'required': ['row'], 'additionalProperties': False}
        shared = ToolDescriptor(name='read_row', description='Read the permitted row.',
                                input_schema=declared)
        factory = self.make_factory()
        self.loader.return_value = services(model_tools=(shared,), inline_tools=(shared,))
        model = await factory.model_factory(WorkRuntimeDeps(TASK_ID, RUN_ID))
        toolset = await factory.toolset_factory(WorkRuntimeDeps(TASK_ID, RUN_ID))

        declared['properties']['row']['type'] = 'string'
        declared['properties']['extra'] = {'type': 'boolean'}

        for port in (model, toolset):
            stored = port._catalog.descriptor('read_row').input_schema
            self.assertEqual(stored['properties']['row'], {'type': 'integer'})
            self.assertNotIn('extra', stored['properties'])
        definition = model._catalog.sdk_definitions()['read_row']
        self.assertEqual(definition.parameters_json_schema['properties']['row'],
                         {'type': 'integer'})
        self.assertEqual(toolset._catalog.validate_arguments('read_row', {'row': 1}), {'row': 1})
        with self.assertRaises(RuntimeFailure) as raised:
            toolset._catalog.validate_arguments('read_row', {'row': '1'})
        self.assertEqual(raised.exception.reason, FailureReason.INVALID_ARGUMENTS)

    async def test_synchronous_service_loader_is_supported(self):
        factory = self.make_factory(loader=lambda _context: services())
        model = await factory.model_factory(WorkRuntimeDeps(TASK_ID, RUN_ID))
        self.assertIsInstance(model, ports.PortModel)

    async def test_non_services_return_is_refused(self):
        factory = self.make_factory()
        self.loader.return_value = object()
        for method in (factory.model_factory, factory.toolset_factory):
            with self.subTest(method=method.__name__):
                with self.assertRaises(RuntimeFailure) as raised:
                    await method(WorkRuntimeDeps(TASK_ID, RUN_ID))
                self.assertEqual(raised.exception.reason, FailureReason.INVALID_REQUEST)

    async def test_non_callable_callbacks_are_refused(self):
        factory = self.make_factory()
        self.loader.return_value = WorkRuntimeServices(
            model_step=None, tool_call=tool_call, model_tools=(READ,), inline_tools=(READ,))
        with self.assertRaises(RuntimeFailure) as raised:
            await factory.model_factory(WorkRuntimeDeps(TASK_ID, RUN_ID))
        self.assertEqual(raised.exception.reason, FailureReason.MODEL_PORT_UNAVAILABLE)

        self.loader.return_value = WorkRuntimeServices(
            model_step=model_step, tool_call=None, model_tools=(READ,), inline_tools=(READ,))
        with self.assertRaises(RuntimeFailure) as raised:
            await factory.toolset_factory(WorkRuntimeDeps(TASK_ID, RUN_ID))
        self.assertEqual(raised.exception.reason, FailureReason.TOOL_PORT_UNAVAILABLE)

    async def test_inline_schema_mismatch_is_refused(self):
        factory = self.make_factory()
        altered = ToolDescriptor(
            name='read_row', description='Read the permitted row.',
            input_schema={'type': 'object', 'properties': {'row': {'type': 'string'}}})
        self.loader.return_value = services(model_tools=(READ,), inline_tools=(altered,))
        with self.assertRaises(RuntimeFailure) as raised:
            await factory.model_factory(WorkRuntimeDeps(TASK_ID, RUN_ID))
        self.assertEqual(raised.exception.reason, FailureReason.CATALOG_INVALID)

    async def test_inline_tool_absent_from_model_catalog_is_refused(self):
        factory = self.make_factory()
        self.loader.return_value = services(model_tools=(READ,), inline_tools=(WRITE,))
        with self.assertRaises(RuntimeFailure) as raised:
            await factory.toolset_factory(WorkRuntimeDeps(TASK_ID, RUN_ID))
        self.assertEqual(raised.exception.reason, FailureReason.CATALOG_INVALID)

    async def test_context_loader_that_outlives_the_deadline_is_refused(self):
        factory = self.make_factory(deadline_seconds=0.05)

        async def slow_load(*_args, **_kwargs):
            await asyncio.sleep(0.1)
            return context()

        self.loaded.side_effect = slow_load
        with self.assertRaises(RuntimeFailure) as raised:
            await factory.model_factory(WorkRuntimeDeps(TASK_ID, RUN_ID))
        self.assertEqual(raised.exception.reason, FailureReason.DEADLINE_EXCEEDED)
        self.loader.assert_not_awaited()

    async def test_service_loader_that_outlives_the_deadline_is_refused(self):
        factory = self.make_factory(deadline_seconds=0.05)

        async def slow_services(_context):
            await asyncio.sleep(0.1)
            return services()

        self.loader.side_effect = slow_services
        with self.assertRaises(RuntimeFailure) as raised:
            await factory.toolset_factory(WorkRuntimeDeps(TASK_ID, RUN_ID))
        self.assertEqual(raised.exception.reason, FailureReason.DEADLINE_EXCEEDED)


class FactoryValidationTests(unittest.TestCase):
    def build(self, **overrides):
        kwargs = dict(expected_namespace=NAMESPACE, expected_queue=QUEUE,
                      expected_workflow_type=WORKFLOW_TYPE,
                      load_services=lambda _context: services())
        kwargs.update(overrides)
        return WorkRuntimePortFactory(object(), object(), **kwargs)

    def test_valid_defaults_construct(self):
        factory = self.build()
        self.assertEqual(factory._deadline_seconds, 30.0)
        self.assertEqual(factory._limits, RuntimeLimits())

    def test_invalid_limits_are_refused(self):
        for limits in (object(), RuntimeLimits(steps=0), RuntimeLimits(tool_calls=0),
                       RuntimeLimits(catalog_tools=0), RuntimeLimits(output_bytes=0),
                       RuntimeLimits(steps=True)):
            with self.subTest(limits=limits):
                with self.assertRaises(RuntimeFailure) as raised:
                    self.build(limits=limits)
                self.assertEqual(raised.exception.reason, FailureReason.INVALID_REQUEST)

    def test_invalid_deadlines_are_refused(self):
        for deadline in (0, -1, float('inf'), float('nan'), 'x', True):
            with self.subTest(deadline=deadline):
                with self.assertRaises(RuntimeFailure) as raised:
                    self.build(deadline_seconds=deadline)
                self.assertEqual(raised.exception.reason, FailureReason.INVALID_REQUEST)

    def test_non_callable_service_loader_is_refused(self):
        with self.assertRaises(RuntimeFailure) as raised:
            self.build(load_services=None)
        self.assertEqual(raised.exception.reason, FailureReason.INVALID_REQUEST)


if __name__ == '__main__':
    unittest.main()
