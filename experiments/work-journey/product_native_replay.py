"""Offline SDK replay of recorded synthetic native Task histories; no activities or network."""
import argparse
import asyncio
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import sys

async def replay(repo,directory):
    sys.path[:0]=[str(repo/'apps/server-python/src'),str(repo/'apps/agent-runtime-python/src')]
    from temporalio.client import WorkflowHistory
    from temporalio.worker import Replayer
    from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
    from openbot_server.work_worker import OpenBotWork
    evidence=json.loads((directory/'evidence.json').read_text())
    histories=[]
    for name,metadata in evidence['histories'].items():
        data=(directory/name).read_bytes()
        if hashlib.sha256(data).hexdigest()!=metadata['exportSha256']:
            raise ValueError('Recorded history hash changed')
        histories.append(WorkflowHistory.from_json(metadata['workflowId'],data.decode()))
    with ThreadPoolExecutor(max_workers=2) as executor:
        replayer=Replayer(workflows=[OpenBotWork],plugins=[PydanticAIPlugin()],workflow_task_executor=executor)
        for history in histories:await replayer.replay_workflow(history)
    return dict(historyReplayCount=len(histories),activitiesRegistered=0,networkClients=0)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo',type=Path,default=Path(__file__).resolve().parents[2])
    parser.add_argument('--evidence',type=Path,default=Path(__file__).with_name('native-capabilities'))
    args=parser.parse_args()
    print(json.dumps(asyncio.run(replay(args.repo.resolve(),args.evidence.resolve()))))
