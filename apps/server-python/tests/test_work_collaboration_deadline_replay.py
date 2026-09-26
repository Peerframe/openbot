"""Opt-in actual SDK Replayer over retained synthetic histories, without an engine connection.

OPENBOT_COLLABORATION_REPLAY_HISTORIES is an os.pathsep-separated list of JSON paths.
Use original histories recorded before the deadline patch; no live identities/credentials.
"""
import asyncio
import os
from pathlib import Path

import pytest
from temporalio.client import WorkflowHistory
from temporalio.worker import Replayer
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from openbot_server.work_worker import OpenBotWork

PATHS=[Path(x) for x in os.environ.get('OPENBOT_COLLABORATION_REPLAY_HISTORIES','').split(os.pathsep) if x]

@pytest.mark.skipif(not PATHS,reason='Supply retained synthetic history files for real SDK Replay')
@pytest.mark.parametrize('path',PATHS)
def test_retained_history_replays_without_new_deadline_commands(path):
    async def check():
        replayer=Replayer(workflows=[OpenBotWork],plugins=[PydanticAIPlugin()])
        result=await replayer.replay_workflow(WorkflowHistory.from_json('retained-deadline-compatibility',path.read_text()))
        assert result.replay_failure is None
    asyncio.run(check())
