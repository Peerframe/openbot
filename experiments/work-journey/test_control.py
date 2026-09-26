"""Reference adapter regressions with mocked trusted ports; no Temporal or PostgreSQL service."""
from contextlib import asynccontextmanager
import hashlib
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, call, patch

import control
from openbot_server.work_completion import complete


TASK_ID = 'task-reference'
RUN_ID = 'run-reference'
ACTION_ID = 'action-reference'
INTENT = {'kind': 'write', 'row': 7, 'value': 'fixed'}
CSV = b'row,value\n7,fixed\n'
SUMMARY = 'Row 7 verified'
RESULT = {'id': TASK_ID, 'status': 'completed', 'artifacts': [{'id': 'artifact-reference'}]}


def action(status):
    return {'id': ACTION_ID, 'task_id': TASK_ID, 'run_id': RUN_ID,
            'intent': dict(INTENT), 'intent_digest': control.canonical(INTENT)[1], 'status': status}


def receipt():
    return {'actionId': ACTION_ID, 'taskId': TASK_ID, 'intent': dict(INTENT),
            'actualTokens': 2, 'result': 'applied'}


class ReceiptTests(unittest.TestCase):
    def test_receipt_binds_canonical_intent_not_python_numeric_equality(self):
        row, record = action('admitted'), receipt()
        expected = {'source': 'owned-effect-lookup', 'reference': ACTION_ID,
                    'sha256': control.canonical(record)[1]}
        self.assertEqual(control.verify(row, record), expected)
        record['intent']['row'] = 7.0
        self.assertEqual(record['intent'], row['intent'])
        self.assertNotEqual(control.canonical(record['intent'])[1], row['intent_digest'])
        with self.assertRaisesRegex(control.ReceiptMismatch, 'immutable intent mismatch'):
            control.verify(row, record)


class RepairStartTests(unittest.IsolatedAsyncioTestCase):
    async def test_historical_repair_requires_the_accepted_original_start(self):
        attempt='a'*32
        reference='temporal:default:'+control.reference(RUN_ID)
        row={'state':'acknowledged','submission_reference':reference,
             'engine_reference':reference,'submission_attempt_id':attempt,
             'engine_first_run_id':'engine-first-run'}
        cursor=SimpleNamespace(fetchone=AsyncMock(return_value=row))
        db=SimpleNamespace(execute=AsyncMock(return_value=cursor))

        @asynccontextmanager
        async def transaction(*,trusted):
            self.assertTrue(trusted)
            yield db

        service=SimpleNamespace(_transaction=transaction,_task=AsyncMock())
        with patch.object(control,'store',return_value=service):
            self.assertEqual(await control.accepted_start_for_repair(TASK_ID,RUN_ID),
                ({'taskId':TASK_ID,'runId':RUN_ID,'attemptId':attempt},'engine-first-run'))
            service._task.assert_awaited_with(db,TASK_ID,read=True)
            for changed in ({'submission_attempt_id':None},
                            {'submission_attempt_id':'b'*32,'state':'pending'},
                            {'engine_reference':'temporal:default:other'},
                            {'engine_first_run_id':None}):
                cursor.fetchone.return_value={**row,**changed}
                with self.assertRaisesRegex(control.ReceiptMismatch,'not accepted'):
                    await control.accepted_start_for_repair(TASK_ID,RUN_ID)


class ControlTests(unittest.IsolatedAsyncioTestCase):
    def patch_port(self, name, **kwargs):
        replacement = patch.object(control, name, **kwargs)
        result = replacement.start()
        self.addCleanup(replacement.stop)
        return result

    def setUp(self):
        self.fence = object()
        self.service = SimpleNamespace(
            admit=AsyncMock(return_value=True), uncertain=AsyncMock(), resolve=AsyncMock(),
            complete=AsyncMock(return_value=RESULT))
        self.patch_port('store', return_value=self.service)
        self.patch_port('bound_ids', return_value=(TASK_ID, RUN_ID))
        self.claim = self.patch_port('claim', new=AsyncMock(return_value=self.fence))
        self.propose = self.patch_port('propose', new=AsyncMock(return_value=(ACTION_ID, self.fence)))
        self.existing = self.patch_port('existing', new=AsyncMock())
        self.inspect = self.patch_port('inspect', new=AsyncMock())
        self.barrier = self.patch_port('fault_barrier', new=AsyncMock())

    async def test_workflow_start_identity_is_checked_before_any_product_action(self):
        attempt='a'*32
        expected=self.patch_port('reserved_start_attempt',new=AsyncMock(return_value=attempt))
        await control.bind_identity({'taskId': TASK_ID, 'runId': RUN_ID, 'attemptId': attempt})
        for identity in ({'taskId': 'other', 'runId': RUN_ID},
                         {'taskId': TASK_ID, 'runId': 'other'},
                         {'taskId': TASK_ID, 'runId': RUN_ID, 'extra': True}, None):
            with self.subTest(identity=identity):
                with self.assertRaisesRegex(control.ReceiptMismatch, 'Workflow start identity'):
                    await control.bind_identity(identity)
        expected.return_value='b'*32
        with self.assertRaisesRegex(control.ReceiptMismatch,'Workflow start identity'):
            await control.bind_identity({'taskId': TASK_ID, 'runId': RUN_ID, 'attemptId': attempt})
        self.claim.assert_not_awaited()
        self.propose.assert_not_awaited()
        self.service.admit.assert_not_awaited()
        self.service.complete.assert_not_awaited()

    async def test_revision_conflict_retries_publication_with_a_fresh_revision(self):
        self.patch_port('http', return_value=CSV)
        self.inspect.side_effect = [
            {'status': 'open', 'revision': 10}, {'status': 'open', 'revision': 11},
            {'status': 'open', 'revision': 11}, {'status': 'open', 'revision': 12},
        ]
        self.service.complete.side_effect = [control.WorkConflict('task_revision_changed'), RESULT]
        with self.assertRaisesRegex(control.UnresolvedEffect, 'latest Task revision'):
            await control.publish(SUMMARY)
        self.barrier.assert_not_awaited()
        self.assertEqual(await control.publish(SUMMARY),
                         {'taskId': TASK_ID, 'status': 'completed', 'artifactId': 'artifact-reference'})
        attempts = self.service.complete.await_args_list
        self.assertEqual([attempt.kwargs['expected_revision'] for attempt in attempts], [11, 12])
        self.assertEqual([attempt.args for attempt in attempts], [(TASK_ID, RUN_ID)] * 2)
        self.assertEqual(attempts[0].kwargs['artifacts'], attempts[1].kwargs['artifacts'])
        self.assertEqual(self.claim.await_count, 2)
        self.barrier.assert_awaited_once_with('after-publication')

    async def test_publication_authority_conflict_is_not_converted_to_retry(self):
        self.patch_port('http', return_value=CSV)
        self.inspect.return_value = {'status': 'open', 'revision': 11}
        denied = control.WorkConflict('admission_closed')
        self.service.complete.side_effect = denied
        with self.assertRaises(control.WorkConflict) as raised:
            await control.publish(SUMMARY)
        self.assertIs(raised.exception, denied)
        self.service.complete.assert_awaited_once()
        self.barrier.assert_not_awaited()

    async def test_concurrent_resolution_reloads_applied_and_only_queries_receipt(self):
        record = receipt()
        http = self.patch_port('http', return_value=record)
        self.existing.side_effect = [action('admitted'), action('applied')]
        self.service.uncertain.side_effect = control.WorkConflict('action_not_admitted')
        self.assertEqual(await control.perform('tool:write', dict(INTENT)), 'applied')
        self.assertEqual(self.existing.await_args_list, [call('tool:write'), call('tool:write')])
        http.assert_called_once_with('/operations/' + ACTION_ID)
        self.service.resolve.assert_awaited_once_with(
            ACTION_ID, applied=True, actual_tokens=2,
            evidence={'source': 'owned-effect-lookup', 'reference': ACTION_ID,
                      'sha256': control.canonical(record)[1]})
        self.claim.assert_not_awaited()
        self.propose.assert_not_awaited()
        self.service.admit.assert_not_awaited()

    async def test_resolution_race_does_not_accept_missing_or_unresolved_action(self):
        http = self.patch_port('http')
        for current in (None, action('unknown'), action('not_applied')):
            with self.subTest(current=None if current is None else current['status']):
                conflict = control.WorkConflict('action_not_admitted')
                self.service.uncertain.side_effect = conflict
                self.existing.side_effect = [action('admitted'), current]
                with self.assertRaises(control.WorkConflict) as raised:
                    await control.perform('tool:write', dict(INTENT))
                self.assertIs(raised.exception, conflict)
        http.assert_not_called()
        self.service.resolve.assert_not_awaited()
        self.service.admit.assert_not_awaited()

    async def test_oversize_post_receipt_records_unknown_without_resolving(self):
        self.existing.side_effect = [None, action('admitted')]
        self.patch_port('settings', return_value={'effect_url': 'http://127.0.0.1:1'})
        response = Mock()
        response.read.return_value = b'x' * 32769
        context = Mock()
        context.__enter__ = Mock(return_value=response)
        context.__exit__ = Mock(return_value=False)
        opened = self.patch_port('urlopen', return_value=context)
        with self.assertRaisesRegex(control.ReceiptMismatch, 'Oversize receipt'):
            await control.perform('tool:write', dict(INTENT))
        self.assertEqual(opened.call_args.args[0].get_method(), 'POST')
        response.read.assert_called_once_with(32769)
        self.service.admit.assert_awaited_once_with(ACTION_ID, fence=self.fence)
        self.service.uncertain.assert_awaited_once_with(ACTION_ID)
        self.service.resolve.assert_not_awaited()

    async def test_cancelled_prepare_replays_saved_proposal_without_new_authority(self):
        self.existing.return_value = action('proposed')
        self.inspect.return_value = {'status': 'cancelled', 'authorityActive': False,
                                     'cancelRequested': True, 'actions': []}
        self.claim.side_effect = control.WorkConflict('admission_closed')
        self.propose.side_effect = control.WorkConflict('admission_closed')
        request = {'name': 'write_row', 'args': {'row': 7, 'value': 'fixed'}}
        self.assertEqual(await control.prepare_write(request), ACTION_ID)
        self.assertEqual(await control.prepare_write(request), ACTION_ID)
        self.assertEqual(await control.decision(ACTION_ID), 'stopped')
        self.claim.assert_not_awaited()
        self.propose.assert_not_awaited()
        self.service.admit.assert_not_awaited()
        self.service.resolve.assert_not_awaited()

    async def test_failed_lookup_finishing_after_concurrent_resolution_keeps_verified_outcome(self):
        self.existing.return_value = action('unknown')
        repairs = SimpleNamespace(finish=AsyncMock(side_effect=control.WorkConflict('reconciliation_outcome_changed')),
                                  read=AsyncMock(return_value={'outcome':'resolved'}))
        with patch('openbot_server.work_reconciliation.ReconciliationStore', return_value=repairs):
            await control.finish_failed_repair('command')
        repairs.read.assert_awaited_once_with('command',task_id=TASK_ID,run_id=RUN_ID,action_id=ACTION_ID)
        self.service.resolve.assert_not_awaited()
        self.service.admit.assert_not_awaited()

    async def test_invalid_json_lookup_is_a_receipt_failure_without_mutating_facts(self):
        self.existing.return_value = action('unknown')
        self.patch_port('settings', return_value={'effect_url':'http://127.0.0.1:1'})
        response = Mock()
        opened = Mock()
        opened.__enter__ = Mock(return_value=response)
        opened.__exit__ = Mock(return_value=False)
        self.patch_port('urlopen', return_value=opened)
        for payload in (b'{broken-json', b'['*15000+b'0'+b']'*15000):
            response.read.return_value = payload
            with self.assertRaisesRegex(control.ReceiptMismatch,'not valid JSON'):
                await control.perform('tool:write',dict(INTENT))
        self.service.uncertain.assert_not_awaited()
        self.service.resolve.assert_not_awaited()
        self.service.admit.assert_not_awaited()

    def use_completed_store(self, *, changed_digest=False):
        descriptor = {'key': 'verified-csv', 'name': 'corrected.csv', 'mediaType': 'text/csv',
                      'sha256': hashlib.sha256(CSV).hexdigest(), 'sizeBytes': len(CSV)}
        verification = {'source': 'independent-csv-readback', 'reference': TASK_ID,
                        'sha256': descriptor['sha256']}
        digest = control.canonical({'taskId': TASK_ID, 'runId': RUN_ID, 'summary': SUMMARY,
                                    'artifacts': [descriptor], 'verification': verification})[1]
        task = {'id': TASK_ID, 'status': 'completed',
                'completion_digest': '0' * 64 if changed_digest else digest}
        # Historical publication still loads its original Run's correction policy.
        async def query(sql, params):
            self.assertEqual(sql, 'SELECT * FROM work_runs WHERE task_id=%s AND id=%s')
            self.assertEqual(params, (TASK_ID, RUN_ID))
            return SimpleNamespace(fetchone=AsyncMock(return_value={'corrections_enabled': False}))
        connection = SimpleNamespace(execute=AsyncMock(side_effect=query))

        @asynccontextmanager
        async def transaction(*, trusted):
            self.assertTrue(trusted)
            yield connection

        async def validate_completion(*args, **kwargs):
            return await complete(self.service, *args, **kwargs)

        # Exercise the existing digest check while replacing only its persistence/file ports.
        self.service._transaction = transaction
        self.service._task = AsyncMock(return_value=task)
        self.service._view = AsyncMock(return_value=RESULT)
        self.service.files = SimpleNamespace(read=Mock(return_value=CSV), put=Mock())
        self.service.complete = AsyncMock(side_effect=validate_completion)
        self.inspect.return_value = {'status': 'completed', 'revision': 14, 'authorityActive': False}
        self.claim.side_effect = control.WorkConflict('admission_closed')
        self.patch_port('http', return_value=CSV)

    async def test_completed_publication_revalidates_same_digest_without_new_claim(self):
        self.use_completed_store()
        self.assertEqual(await control.publish(SUMMARY),
                         {'taskId': TASK_ID, 'status': 'completed', 'artifactId': 'artifact-reference'})
        self.claim.assert_not_awaited()
        self.service.complete.assert_awaited_once()
        completion = self.service.complete.await_args
        self.assertEqual(completion.args, (TASK_ID, RUN_ID))
        self.assertIsNone(completion.kwargs['fence'])
        self.assertEqual(completion.kwargs['expected_revision'], 14)
        self.assertEqual(completion.kwargs['artifacts'][0]['data'], CSV)
        self.service.files.read.assert_called_once_with(hashlib.sha256(CSV).hexdigest(), len(CSV))
        self.service.files.put.assert_not_called()
        self.barrier.assert_awaited_once_with('after-publication')

    async def test_completed_publication_still_rejects_a_different_stored_digest(self):
        self.use_completed_store(changed_digest=True)
        with self.assertRaisesRegex(control.WorkConflict, 'completion_content_changed'):
            await control.publish(SUMMARY)
        self.claim.assert_not_awaited()
        self.service.complete.assert_awaited_once()
        self.service._view.assert_not_awaited()
        self.service.files.read.assert_not_called()
        self.service.files.put.assert_not_called()
        self.barrier.assert_not_awaited()


class ActivityWriteCompositionTests(unittest.IsolatedAsyncioTestCase):
    """The reference write activity uses the product Activity->Action seam unchanged."""

    def patch_port(self, name, **kwargs):
        replacement = patch.object(control, name, **kwargs)
        result = replacement.start()
        self.addCleanup(replacement.stop)
        return result

    def setUp(self):
        self.service = SimpleNamespace(uncertain=AsyncMock())
        self.patch_port('bound_ids', return_value=(TASK_ID, RUN_ID))
        self.patch_port('store', return_value=self.service)
        self.barrier = self.patch_port('fault_barrier', new=AsyncMock())

    async def test_composition_supplies_the_reviewed_plan_and_trusted_settings(self):
        captured = {}

        async def seam(*args, **changes):
            captured['args'] = args
            captured.update(changes)
            return SimpleNamespace(status='applied')

        self.patch_port('settings', return_value={'queue': 'work-' + RUN_ID})
        self.patch_port('execute_activity_action', new=seam)
        outcome = await control.execute_activity_write('engine-client')
        self.assertEqual(outcome.status, 'applied')
        self.assertEqual(captured['args'], (self.service, 'engine-client'))
        self.assertEqual(captured['expected_namespace'], 'default')
        self.assertEqual(captured['expected_queue'], 'work-' + RUN_ID)
        self.assertEqual(captured['expected_workflow_type'], 'WorkJourney')
        self.assertEqual(captured['request'],
                         {'call_id': 'reference-write', 'tool': 'write_row',
                          'arguments': {'row': 7, 'value': 'fixed'}})
        self.assertIsInstance(captured['policy'], control.WritePolicy)
        self.assertIsInstance(captured['adapter'], control.WriteAdapter)
        self.assertIsInstance(captured['verifier'], control.WriteVerifier)

    async def test_closed_task_only_recovers_an_existing_matching_action(self):
        self.patch_port('settings', return_value={'queue': 'work-' + RUN_ID})
        self.patch_port('execute_activity_action', new=AsyncMock(
            side_effect=control.WorkConflict('admission_closed')))
        row = {'id': ACTION_ID, 'intent_digest': control.canonical(INTENT)[1],
               'status': 'unknown'}
        self.patch_port('existing', new=AsyncMock(return_value=row))
        historical = SimpleNamespace(status='applied', invoked_apply=False)
        recover = self.patch_port('recover_action', new=AsyncMock(return_value=historical))
        self.assertIs(await control.execute_activity_write('engine-client'), historical)
        recover.assert_awaited_once()
        self.assertEqual(recover.await_args.kwargs['task_id'], TASK_ID)
        self.assertEqual(recover.await_args.kwargs['run_id'], RUN_ID)
        self.assertEqual(recover.await_args.kwargs['action_id'], ACTION_ID)
        self.assertIsInstance(recover.await_args.kwargs['adapter'], control.WriteAdapter)

    async def test_closed_task_never_recovers_a_missing_unadmitted_or_changed_action(self):
        self.patch_port('settings', return_value={'queue': 'work-' + RUN_ID})
        self.patch_port('execute_activity_action', new=AsyncMock(
            side_effect=control.WorkConflict('admission_closed')))
        existing = self.patch_port('existing', new=AsyncMock())
        recover = self.patch_port('recover_action', new=AsyncMock())
        for row in (None,
                    {'id': ACTION_ID, 'intent_digest': control.canonical(INTENT)[1],
                     'status': 'proposed'},
                    {'id': ACTION_ID, 'intent_digest': control.canonical({'kind':'write','row':8,'value':'fixed'})[1],
                     'status': 'unknown'}):
            existing.return_value = row
            with self.assertRaisesRegex(control.WorkConflict, 'admission_closed'):
                await control.execute_activity_write('engine-client')
        recover.assert_not_awaited()

    async def test_policy_returns_only_the_reviewed_exact_plan(self):
        plan = await control.WritePolicy().plan(control.ToolRequest(
            tool='write_row', arguments={'row': 7, 'value': 'fixed'}, digest='0' * 64))
        self.assertEqual(plan, control.ActionPlan(action_key='tool:write',
            intent={'kind': 'write', 'row': 7, 'value': 'fixed'}, reserved_tokens=2,
            requires_approval=True, expires_seconds=300))
        with self.assertRaises(control.ReceiptMismatch):
            await control.WritePolicy().plan(control.ToolRequest(
                tool='write_row', arguments={'row': 8, 'value': 'fixed'}, digest='0' * 64))
        with self.assertRaises(control.ReceiptMismatch):
            await control.WritePolicy().plan(control.ToolRequest(
                tool='write_row', arguments={'row': 7.0, 'value': 'fixed'}, digest='0' * 64))

    async def test_verifier_binds_only_the_exact_receipt(self):
        record = {'actionId': ACTION_ID, 'taskId': TASK_ID, 'intent': dict(INTENT),
                  'result': 'applied', 'actualTokens': 2}
        digest = control.canonical(INTENT)[1]
        outcome = await control.WriteVerifier().verify(action_id=ACTION_ID, task_id=TASK_ID,
            run_id=RUN_ID, intent_digest=digest, intent=dict(INTENT), lookup=record)
        self.assertIsInstance(outcome, control.VerifiedOutcome)
        self.assertEqual((outcome.action_id, outcome.applied, outcome.actual_tokens),
                         (ACTION_ID, True, 2))
        self.assertEqual(outcome.evidence['sha256'], control.canonical(record)[1])
        for changed in ({**record, 'result': 'other'}, {**record, 'actualTokens': 3},
                        {**record, 'taskId': 'other'},
                        {**record, 'intent': {**INTENT, 'row': 8}}):
            self.assertIsNone(await control.WriteVerifier().verify(action_id=ACTION_ID,
                task_id=TASK_ID, run_id=RUN_ID, intent_digest=digest, intent=dict(INTENT),
                lookup=changed))

    async def test_lost_post_response_marks_unknown_and_stops_before_lookup(self):
        self.patch_port('http', side_effect=OSError('lost response'))
        with self.assertRaises(control.UnresolvedEffect):
            await control.WriteAdapter().apply(ACTION_ID, dict(INTENT))
        self.service.uncertain.assert_awaited_once_with(ACTION_ID)
        self.barrier.assert_awaited_once_with('unknown')

    async def test_committed_post_response_stops_at_the_reference_barrier(self):
        http = self.patch_port('http', return_value=receipt())
        await control.WriteAdapter().apply(ACTION_ID, dict(INTENT))
        http.assert_called_once_with('/operations',
            {'actionId': ACTION_ID, 'taskId': TASK_ID, 'intent': dict(INTENT)})
        self.barrier.assert_awaited_once_with('after-effect-response')
        self.service.uncertain.assert_not_awaited()

    async def test_lookup_returns_none_only_for_a_missing_receipt(self):
        http = self.patch_port('http', side_effect=control.HTTPError(
            ACTION_ID, 404, 'absent', {}, None))
        self.assertIsNone(await control.WriteAdapter().lookup(ACTION_ID))
        http.side_effect = control.HTTPError(ACTION_ID, 503, 'unavailable', {}, None)
        with self.assertRaises(control.HTTPError):
            await control.WriteAdapter().lookup(ACTION_ID)


if __name__ == '__main__':
    unittest.main()
