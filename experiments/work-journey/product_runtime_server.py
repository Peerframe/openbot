"""Actual product serve entry with a synthetic SDK HTTP provider and owned crash barriers."""
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
from openbot_server.work_store import PostgresWorkStore
from openbot_server.work_model_receipts import ModelReceipts

REPORT='# Synthetic report\n\nThe supplied fixture value is 42.\n'+'Evidence retained.\n'*1050
SUMMARY='The supplied fixture value is 42. A Markdown report has been prepared from the stated evidence.'


def main():
    config=json.loads(Path(os.environ['OPENBOT_PRODUCT_PROBE_CONFIG']).read_text())
    directory=Path(config['directory'])
    stats=directory/'provider-count.json'
    def response(request):
        body=json.loads(request.content)
        serialized=json.dumps(body,ensure_ascii=False)
        count=json.loads(stats.read_text()) if stats.exists() else dict(calls=0)
        count['calls']+=1;stats.write_text(json.dumps(count))
        if config.get('forbid_provider'):
            raise AssertionError('Provider was called after the original receipt committed')
        if 'You independently review source-grounded answers' in serialized:
            value=json.dumps(dict(accepted=True,reason='Synthetic review: stated fact and complete report match.'))
            output=[dict(id='review',type='message',role='assistant',status='completed',
                         content=[dict(type='output_text',text=value,annotations=[])])]
        else:
            outputs=[i for i in body.get('input',[]) if i.get('type')=='function_call_output']
            if not outputs and any(t.get('name')=='read_channel_context' for t in body.get('tools',[])):
                output=[dict(id='read',type='function_call',call_id='fixture-read',name='read_channel_context',
                             arguments='{}',status='completed')]
            elif not any(i.get('call_id')=='fixture-report' for i in outputs):
                output=[dict(id='report',type='function_call',call_id='fixture-report',name='write_report',
                             arguments=json.dumps(dict(name='evidence.md',markdown=REPORT)),status='completed')]
            else:
                output=[dict(id='answer',type='message',role='assistant',status='completed',
                             content=[dict(type='output_text',text=SUMMARY,annotations=[])])]
        return httpx2.Response(200,json=dict(id='synthetic-response',object='response',created_at=1,
            model=body['model'],status='completed',output=output,
            usage=dict(input_tokens=50,output_tokens=50,total_tokens=100)))
    original_model=runtime.ProductWorkModel
    def model(*args,**kwargs):
        return original_model(*args,**kwargs,transport_factory=lambda:httpx2.MockTransport(response))
    runtime.ProductWorkModel=model
    if config.get('pause_completion'):
        original_complete=PostgresWorkStore.complete
        async def complete(self,*args,**kwargs):
            result=await original_complete(self,*args,**kwargs)
            (directory/'published').write_text(json.dumps(dict(taskId=result['id'])))
            await asyncio.Event().wait()
            return result
        PostgresWorkStore.complete=complete
    if config.get('pause_receipt'):
        original_save=ModelReceipts.save
        async def save(self,*args,**kwargs):
            result=await original_save(self,*args,**kwargs)
            if result['actual_tokens']==100 and not (directory/'receipt').exists():
                (directory/'receipt').write_text(json.dumps(dict(actionId=result['action_id'])))
                await asyncio.Event().wait()
            return result
        ModelReceipts.save=save
    runpy.run_path(str(ROOT/'apps/server-python/scripts/serve.py'),run_name='__main__')


if __name__=='__main__':main()
