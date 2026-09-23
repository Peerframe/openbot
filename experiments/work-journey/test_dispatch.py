"""Offline handoff regressions: an uncertain prior send is never a new start grant."""
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import dispatch


TASK_ID = 'task-reference'
RUN_ID = 'run-reference'
WORKFLOW_ID = 'openbot-work-v1-' + RUN_ID
REFERENCE = 'temporal:default:' + WORKFLOW_ID
IDENTITY = {'taskId': TASK_ID, 'runId': RUN_ID}
SETTINGS = {'task_id': TASK_ID, 'run_id': RUN_ID, 'temporal_address': 'unused',
            'queue': 'work-reference', 'directory': '/private/tmp'}


class DispatchTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.handoff = SimpleNamespace(
            pending=AsyncMock(return_value=[]),
            unconfirmed_for=AsyncMock(return_value=None),
            reserve_submission=AsyncMock(),
            acknowledge=AsyncMock(),
        )
        self.client = Mock()
        self.client.start_workflow = AsyncMock()
        self.patchers = [
            patch.object(dispatch.control, 'settings', return_value=SETTINGS),
            patch.object(dispatch.control, 'store', return_value=object()),
            patch.object(dispatch.control, 'reference', return_value=WORKFLOW_ID),
            patch.object(dispatch.control, 'fault_barrier', new=AsyncMock()),
            patch.object(dispatch, 'HandoffStore', return_value=self.handoff),
            patch.object(dispatch, 'connect_engine', new=AsyncMock(return_value=self.client)),
        ]
        for patcher in self.patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

    async def test_unconfirmed_missing_history_never_starts_a_replacement(self):
        self.handoff.unconfirmed_for.return_value = {**IDENTITY, 'engineReference': REFERENCE}

        async def missing_history(*, page_size):
            raise RuntimeError('history unavailable')
            yield  # Make the failing history fetch an async iterator.

        self.client.get_workflow_handle.return_value.fetch_history_events = missing_history
        with self.assertRaisesRegex(RuntimeError, 'history unavailable'):
            await dispatch.main()
        self.client.get_workflow_handle.assert_called_once_with(WORKFLOW_ID)
        self.client.start_workflow.assert_not_awaited()
        self.handoff.reserve_submission.assert_not_awaited()
        self.handoff.acknowledge.assert_not_awaited()

    async def test_losing_the_reservation_race_never_starts_a_second_workflow(self):
        self.handoff.pending.return_value = [IDENTITY]
        self.handoff.reserve_submission.return_value = False
        await dispatch.main()
        self.handoff.reserve_submission.assert_awaited_once_with(TASK_ID, RUN_ID, REFERENCE)
        self.client.start_workflow.assert_not_awaited()
        self.handoff.acknowledge.assert_not_awaited()


if __name__ == '__main__':
    unittest.main()
