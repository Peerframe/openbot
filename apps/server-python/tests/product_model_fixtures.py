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

def response(req, *, text="Checked answer"):
    body=json.loads(req.content);model=body['model']
    if req.url.path.endswith('/responses'):
        return {'id':'response-fixture','object':'response','created_at':1,'model':model,'status':'completed',
            'output':[{'id':'message-fixture','type':'message','role':'assistant','status':'completed',
                'content':[{'type':'output_text','text':text,'annotations':[]}]}],
            'usage':{'input_tokens':10,'output_tokens':4,'total_tokens':14}}
    return {'id':'chat-fixture','object':'chat.completion','created':1,'model':model,
        'choices':[{'index':0,'finish_reason':'stop','message':{'role':'assistant','content':text}}],
        'usage':{'prompt_tokens':10,'completion_tokens':4,'total_tokens':14}}


class DefaultModels:
    """Configure C7 through real Owner transactions; keep each test's preferences isolated."""
    def __init__(self, fixture):
        import psycopg
        self.f = fixture
        self.current = None
        self.value = None
        with psycopg.connect(fixture.dsn) as db:
            self.previous = db.execute("SELECT default_model,revision,updated_at FROM owner_preferences WHERE owner_id='owner'").fetchone()
            db.execute("UPDATE owner_preferences SET default_model=NULL WHERE owner_id='owner'")

    async def save(self, value):
        from openbot_server.model_presets import model_provider_base_url
        from openbot_server.owner_preferences import OwnerPreferences
        preset = 'kimi' if value['provider']=='moonshot' else value['provider']
        connections = self.f.connections
        if self.current is None or self.current['presetId'] != preset:
            self.current = await connections.create(self.f.token, dict(name='Synthetic default', presetId=preset,
                baseUrl=model_provider_base_url(value['provider']), apiKey=value['apiKey'], defaultModel=value['model']))
            self.f.ids.append(self.current['id'])
        self.current = await connections.update(self.f.token, self.current['id'],dict(expectedRevision=self.current['revision'],
            apiKey=value['apiKey'], enabled=value.get('agentEnabled',True)))
        preferences = OwnerPreferences(self.f.dsn, model_connections=connections)
        previous = await preferences.get(self.f.token)
        await preferences.update(self.f.token,dict(expectedRevision=previous['revision'],timezone=previous['timezone'],
            defaultModel=dict(connectionId=self.current['id'],modelId=value['model']) if value.get('agentEnabled',True) else None))
        self.value = dict(value, revision=self.current['revision'])
        return self.value

    async def active(self):
        return self.value

    def restore(self):
        import psycopg
        from psycopg.types.json import Jsonb
        with psycopg.connect(self.f.dsn) as db:
            db.execute("UPDATE owner_preferences SET default_model=%s,revision=%s,updated_at=%s WHERE owner_id='owner'",
                (None if self.previous[0] is None else Jsonb(self.previous[0]),self.previous[1],self.previous[2]))
