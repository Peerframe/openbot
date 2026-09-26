"""Stable model-operation identity and codec counterexamples, without network or database."""
import dataclasses
from pathlib import Path
import sys
import unittest
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
for source in ('apps/server-python/src', 'apps/agent-runtime-python/src'):
    sys.path.insert(0, str(ROOT / source))
from pydantic_ai.messages import ModelRequest, ModelResponse, UserPromptPart, TextPart
from pydantic_ai.usage import RequestUsage
from openbot_agent_runtime.contracts import ModelStepRequest, ToolDescriptor
from openbot_server.work_model_activity import operation_key, model_request
from openbot_server.work_model_receipts import encode_response, decode_response
from openbot_server.work_values import InvalidWork, WorkConflict


def accepted(**changes):
    values = dict(task_id='task', run_id='run', namespace='default', workflow_id='workflow',
                  engine_run_id='engine', first_run_id='engine')
    return SimpleNamespace(**(values | changes))


def request(text='question', tools=(), step=1):
    return ModelStepRequest(step=step, messages=[ModelRequest(parts=[UserPromptPart(text)],
        timestamp=__import__('datetime').datetime(2026, 9, 24, tzinfo=__import__('datetime').timezone.utc))], tools=tools)


def plan(value, **changes):
    return model_request(value, **(dict(provider_id='openai-responses', model_id='gpt-4o-mini',
                                      max_output_tokens=4) | changes))


class ModelOperationTests(unittest.TestCase):
    def test_retry_identity_is_stable_and_activity_task_namespace_are_distinct(self):
        key = operation_key(accepted(), '5')
        self.assertEqual(key, operation_key(accepted(), '5'))
        for context, activity in [(accepted(), '6'), (accepted(run_id='other'), '5'),
                                  (accepted(task_id='other'), '5'), (accepted(namespace='other'), '5')]:
            self.assertNotEqual(key, operation_key(context, activity))

    def test_new_engine_history_requires_explicit_continuation_identity(self):
        with self.assertRaisesRegex(WorkConflict, 'continuation_identity_required'):
            operation_key(accepted(engine_run_id='second'), '5')

    def test_runtime_step_does_not_change_the_same_request_intent(self):
        original = request()
        self.assertEqual(plan(original)[1], plan(dataclasses.replace(original, step=99))[1])

    def test_changed_request_model_or_output_limit_changes_intent(self):
        baseline = plan(request())[1]
        self.assertNotEqual(baseline, plan(request('another question'))[1])
        self.assertNotEqual(baseline, plan(request(), model_id='another-model')[1])
        self.assertNotEqual(baseline, plan(request(), max_output_tokens=8)[1])

    def test_request_and_schema_are_detached(self):
        tool = ToolDescriptor('read', 'Read', {'type': 'object', 'properties': {'x': {'type': 'string'}}})
        original = request(tools=(tool,))
        detached, intent = plan(original)
        original.messages[0].parts[0].content = 'changed'
        tool.input_schema['properties']['x']['type'] = 'integer'
        self.assertEqual(detached.messages[0].parts[0].content, 'question')
        self.assertEqual(detached.tools[0].input_schema['properties']['x']['type'], 'string')
        self.assertNotEqual(intent, plan(original)[1])

    def test_codec_roundtrip_and_usage_binding(self):
        response = ModelResponse([TextPart('saved')], usage=RequestUsage(input_tokens=2, output_tokens=1))
        data, usage = encode_response(response)
        self.assertEqual(decode_response(data, usage), response)
        for bad, amount in [(data, usage + 1), (b'[]', 0), (b'{}', 0)]:
            with self.assertRaises(WorkConflict):
                decode_response(bad, amount)

    def test_invalid_and_unbounded_input_refused(self):
        for value in [request('x' * (256 * 1024)), object()]:
            with self.assertRaises(InvalidWork):
                plan(value)
        with self.assertRaises(InvalidWork):
            encode_response(ModelResponse([TextPart('x')], usage=RequestUsage(input_tokens=-1)))
