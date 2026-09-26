"""Owned continuation/failure fixture at the real product entry; no external provider traffic."""
import asyncio
import json
import os
from pathlib import Path
import runpy
import sys

ROOT=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(ROOT/'apps/server-python/src'),str(ROOT/'apps/agent-runtime-python/src')]
import httpx2
from openbot_server import work_product_runtime as runtime
from openbot_server.work_product_collaboration import WorkCollaborationAdapter
from openbot_server.work_product_collaboration import _CreationResponse
from openbot_server.work_failure import FailureActivities
from openbot_server.work_values import WorkConflict

SUMMARY='Both colleague results were read: child A confirmed 42 and child B confirmed 84.'


def main():
    config=json.loads(Path(os.environ['OPENBOT_PRODUCT_PROBE_CONFIG']).read_text())
    directory=Path(config['directory']);stats=directory/'provider-count.json'
    def count(key):
        values=json.loads(stats.read_text()) if stats.exists() else {}
        values[key]=values.get(key,0)+1;stats.write_text(json.dumps(values))
        if values[key]>1:raise AssertionError('An original model operation was resent: '+key)
    def message(value):
        return [dict(id='answer',type='message',role='assistant',status='completed',
            content=[dict(type='output_text',text=value,annotations=[])])]
    async def response(request):
        body=json.loads(request.content);serialized=json.dumps(body,ensure_ascii=False)
        users=[item for item in body.get('input',[]) if item.get('role')=='user']
        initial=json.dumps(users[0] if users else {},ensure_ascii=False)
        who='a' if 'Current Owner task:\\nCHILD-A-ONLY' in initial else 'b' if 'Current Owner task:\\nCHILD-B-ONLY' in initial else 'parent'
        if 'You independently review source-grounded answers' in serialized:
            who='a' if 'Child A confirmed 42.' in serialized and 'OWNER-PARENT' not in serialized else 'b' if 'Child B confirmed 84.' in serialized and 'OWNER-PARENT' not in serialized else 'parent'
            count(who+':review')
            output=message(json.dumps(dict(accepted=True,reason='Synthetic committed evidence matches.')))
        elif config['case']=='failure':
            count('failed-model');return httpx2.Response(400,json={'error':{'message':'Synthetic request refusal'}})
        elif who in ('a','b'):
            count(who+':answer')
            if who=='a':await asyncio.sleep(12)
            output=message('Child A confirmed 42.' if who=='a' else 'Child B confirmed 84.')
        else:
            results=[item for item in body.get('input',[]) if item.get('type')=='function_call_output']
            if not any(item.get('call_id')=='start-a' for item in results):
                count('parent:start')
                output=[dict(id='start-a',type='function_call',call_id='start-a',name='start_task',
                    arguments=json.dumps(dict(botId=config['child_a'],task='CHILD-A-ONLY Confirm the supplied value 42.')),status='completed')]
            elif not any(item.get('call_id')=='delegate-b' for item in results):
                count('parent:delegate')
                output=[dict(id='delegate-b',type='function_call',call_id='delegate-b',name='delegate_task',
                    arguments=json.dumps(dict(botId=config['child_b'],task='CHILD-B-ONLY Confirm the supplied value 84.')),status='completed')]
            elif 'Your draft has not been published.' not in serialized:
                count('parent:draft');output=message('Provisional answer: child B confirmed 84.')
            else:
                assert 'Child A confirmed 42.' in serialized and 'Child B confirmed 84.' in serialized
                count('parent:final');output=message(SUMMARY)
        return httpx2.Response(200,json=dict(id='synthetic-response',object='response',created_at=1,
            model=body['model'],status='completed',output=output,
            usage=dict(input_tokens=50,output_tokens=50,total_tokens=100)))
    original_model=runtime.ProductWorkModel
    runtime.ProductWorkModel=lambda *args,**kwargs:original_model(*args,**kwargs,
        transport_factory=lambda:httpx2.MockTransport(response))
    if config.get('pause_creation'):
        original=WorkCollaborationAdapter.invoke
        async def invoke(self,context,action_id,intent):
            result=await original(self,context,action_id,intent)
            if intent['tool']=='start_task':
                (directory/'creation-committed').write_text(json.dumps(dict(actionId=action_id,runId=result['runId'])))
                await asyncio.Event().wait()
            return result
        WorkCollaborationAdapter.invoke=invoke
    if config['case']=='expiry':
        original_invoke=WorkCollaborationAdapter.invoke
        async def unknown_creation(self,context,action_id,intent):
            result=await original_invoke(self,context,action_id,intent)
            if intent['tool']=='start_task':
                (directory/'creation-committed').write_text(json.dumps(dict(actionId=action_id,runId=result['runId'])))
                raise WorkConflict('synthetic_creation_ack_unavailable')
            return result
        async def unavailable_receipt(self,action_id):return None
        WorkCollaborationAdapter.invoke=unknown_creation
        _CreationResponse.lookup=unavailable_receipt
    if config.get('pause_failure'):
        original_close=FailureActivities._close
        async def close(self,*args,**kwargs):
            result=await original_close(self,*args,**kwargs)
            if result[0]['disposition']=='failed':
                (directory/'failure-committed').write_text(json.dumps(result[0]))
                await asyncio.Event().wait()
            return result
        FailureActivities._close=close
    if config.get('startup_failure'):
        async def load_prompt(self,context):raise WorkConflict('synthetic_startup_refusal')
        runtime.ProductWorkRuntime.load_prompt=load_prompt
    runpy.run_path(str(ROOT/'apps/server-python/scripts/serve.py'),run_name='__main__')


if __name__=='__main__':main()
