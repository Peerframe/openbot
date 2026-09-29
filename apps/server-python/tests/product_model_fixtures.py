"""Shared synthetic SDK replies and engine bindings for product-model acceptance.

These fixtures still submit through the real store; the patched Activity inspection is not
real Temporal execution evidence. Per-suite stores, media adapters and expectations stay local.
"""
from contextlib import contextmanager
import json
from types import SimpleNamespace
from unittest.mock import patch

import psycopg
from psycopg.types.json import Jsonb
from openbot_server.task_inputs import CreateMessageInput
from openbot_server.task_store import PostgresTaskStore
from openbot_server.work_corrections import CorrectionStore
from openbot_server.work_engine_binding import EngineActivityFacts
from openbot_server.work_handoff import HandoffStore
from openbot_server.work_temporal_start import WorkRuntimeContext

async def bound(f,profile='none',connection=None,*,scope):
    with psycopg.connect(f.dsn) as db:
        db.execute('UPDATE bots SET computer_profile=%s,configuration=%s WHERE id=%s',(profile,Jsonb({'model':{'connectionId':connection['id'],'modelId':'queued-model'}} if connection else {}),f.bot))
    result=await PostgresTaskStore(f.dsn,model_connections=f.connections,work_sources=f.sources).submit(f.token,f.channel,
        CreateMessageInput(content='Synthetic model task',botId=f.bot))
    async with f.store._transaction(trusted=True) as db:
        row=await (await db.execute('SELECT task_id FROM work_sources WHERE legacy_run_id=%s',(result.run.id,))).fetchone()
    task=await f.store.snapshot(f.token,row['task_id'])
    rid=task['runs'][0]['id']
    correction=await CorrectionStore(f.store).freeze(task['id'],rid,'initial')
    context=WorkRuntimeContext(task['id'],rid,f.bot,task['objective'],task['usage']['tokenLimit'],correction['id'])
    accepted=SimpleNamespace(task_id=task['id'],run_id=rid,namespace='default',workflow_id='openbot-work-v1-'+rid,
        engine_run_id='synthetic-engine',first_run_id='synthetic-engine')
    handoff=HandoffStore(f.store);reference='temporal:default:'+accepted.workflow_id
    reservation=await handoff.reserve_submission(task['id'],rid,reference)
    await handoff.acknowledge(task['id'],rid,reference,reservation.attempt_id,'synthetic-engine')
    facts=EngineActivityFacts(namespace='default',queue=scope['expected_queue'],start_queue=scope['expected_queue'],
        workflow_id=accepted.workflow_id,workflow_type=scope['expected_workflow_type'],engine_run_id='synthetic-engine',
        first_run_id='synthetic-engine',start_input=dict(taskId=task['id'],runId=rid,attemptId=reservation.attempt_id))
    return SimpleNamespace(context=context,accepted=accepted,facts=facts,source=result.run,activity='model-1')

@contextmanager
def binding(b):
    async def inspect(*args,**kwargs): return b.facts
    with patch('openbot_server.work_temporal_activity.activity_info',lambda:SimpleNamespace(activity_id=b.activity)), \
            patch('openbot_server.work_temporal_activity.inspect_activity_start',inspect):
        yield

def response(req):
    body=json.loads(req.content);model=body['model']
    if req.url.path.endswith('/responses'):
        return {'id':'response-fixture','object':'response','created_at':1,'model':model,'status':'completed',
            'output':[{'id':'message-fixture','type':'message','role':'assistant','status':'completed',
                'content':[{'type':'output_text','text':'Checked answer','annotations':[]}]}],
            'usage':{'input_tokens':10,'output_tokens':4,'total_tokens':14}}
    return {'id':'chat-fixture','object':'chat.completion','created':1,'model':model,
        'choices':[{'index':0,'finish_reason':'stop','message':{'role':'assistant','content':'Checked answer'}}],
        'usage':{'prompt_tokens':10,'completion_tokens':4,'total_tokens':14}}
