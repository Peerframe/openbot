"""Synthetic provider injection at the actual ProductWorkRuntime/serve entry; no new runtime."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import runpy
import sys
from product_native_fixture import REPORT,SUMMARY,CHILD,DRAFT


def main(repo):
    sys.path[:0]=[str(repo/'apps/server-python/src'),str(repo/'apps/agent-runtime-python/src')]
    import httpx2
    from openbot_server import work_product_runtime as runtime
    from openbot_server.work_store import PostgresWorkStore
    config=json.loads(Path(os.environ['OPENBOT_NATIVE_PROBE_CONFIG']).read_text())
    directory=Path(config['directory']);stats=directory/'provider-count.json'
    def count(key):
        value=json.loads(stats.read_text()) if stats.exists() else {}
        value[key]=value.get(key,0)+1;stats.write_text(json.dumps(value))
        if value[key]!=1 or config.get('forbid_provider'):raise AssertionError('Original provider operation resent: '+key)
    def message(value):
        return [dict(id='answer',type='message',role='assistant',status='completed',content=[dict(type='output_text',text=value,annotations=[])])]
    def tool(call_id,name,args):
        return [dict(id=call_id,type='function_call',call_id=call_id,name=name,arguments=json.dumps(args),status='completed')]
    def provider(request):
        body=json.loads(request.content);serialized=json.dumps(body,ensure_ascii=False)
        assert '"native_source"' not in serialized and '"execution_epoch"' not in serialized and '"fingerprint"' not in serialized
        reviewer='You independently review source-grounded answers' in serialized
        child=('NATIVE-CHILD' in serialized and 'NATIVE-ROOT' not in serialized)
        who='child' if child else 'root'
        outputs={x['call_id']:x.get('output','') for x in body.get('input',[]) if x.get('type')=='function_call_output'}
        if reviewer:
            assert 'value' in serialized and '42' in serialized and 'evidence.csv' in serialized
            texts=[]
            for item in body.get('input',[]):
                if item.get('role')!='user':continue
                content=item.get('content')
                if isinstance(content,str):texts.append(content)
                else:texts.extend(part['text'] for part in content if part.get('type')=='input_text')
            reviewed=[json.loads(value) for value in texts if value.startswith('{')]
            assert len(reviewed)==1
            proof=reviewed[0]
            (directory/(who+'-review.json')).write_text(json.dumps(proof,indent=2))
            assert proof['finalAnswer']==(CHILD if child else SUMMARY)
            if not child:
                assert any(a['text']==REPORT for a in proof['artifacts'])
                assert any(CHILD in json.dumps(t['payload']) for t in proof['tools'])
            count(who+':review');output=message(json.dumps(dict(accepted=True,reason='Synthetic review: supplied source, observation and report agree.')))
        elif child:
            if 'child-read' not in outputs:
                count('child:read');output=tool('child-read','read_attachment',dict(attachmentId=config['attachment']))
            else:
                assert '42' in outputs['child-read'];count('child:final');output=message(CHILD)
        elif 'root-read' not in outputs:
            count('root:read');output=tool('root-read','read_attachment',dict(attachmentId=config['attachment']))
        elif 'root-memory' not in outputs:
            assert '42' in outputs['root-read'];count('root:memory');output=tool('root-memory','read_employee_memory',{})
        elif 'root-delegate' not in outputs:
            assert 'source attribution' in outputs['root-memory'];count('root:delegate')
            output=tool('root-delegate','delegate_task',dict(botId=config['child'],task='NATIVE-CHILD Read the authorized attachment and confirm its supplied value. [OpenBot attachment: '+config['attachment']+']'))
        elif 'root-proposal' not in outputs:
            assert CHILD in outputs['root-delegate'];count('root:proposal');output=tool('root-proposal','propose_memory',DRAFT)
        elif 'root-report' not in outputs:
            assert 'prepared' in outputs['root-proposal'];count('root:report');output=tool('root-report','write_report',dict(name='native-report.md',markdown=REPORT))
        else:
            count('root:final');output=message(SUMMARY)
        return httpx2.Response(200,json=dict(id='synthetic-native-response',object='response',created_at=1,model=body['model'],status='completed',output=output,usage=dict(input_tokens=50,output_tokens=50,total_tokens=100)))
    original=runtime.ProductWorkModel
    runtime.ProductWorkModel=lambda *a,**kw:original(*a,**kw,transport_factory=lambda:httpx2.MockTransport(provider))
    if config.get('pause_completion'):
        complete=PostgresWorkStore.complete
        async def pause(self,*a,**kw):
            result=await complete(self,*a,**kw)
            if result['botId']==config.get('root'):
                (directory/'published').write_text(json.dumps(dict(taskId=result['id'])))
                await asyncio.Event().wait()
            return result
        PostgresWorkStore.complete=pause
    runpy.run_path(str(repo/'apps/server-python/scripts/serve.py'),run_name='__main__')

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo',type=Path,required=True)
    main(parser.parse_args().repo.resolve())
