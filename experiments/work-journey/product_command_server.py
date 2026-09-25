"""Actual Server entry; only the model HTTP transport is synthetic."""
import json
import os
from pathlib import Path
import runpy
import sys
from product_command_fixture import CSV,SUMMARY,REPORT,ARGUMENTS

ROOT=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(ROOT/'apps/server-python/src'),str(ROOT/'apps/agent-runtime-python/src')]
import httpx2
from openbot_server import work_product_runtime as runtime


def main():
    config=json.loads(Path(os.environ['OPENBOT_COMMAND_PROBE_CONFIG']).read_text())
    directory=Path(config['directory']);stats=directory/'provider-count.json'
    def count(key):
        value=json.loads(stats.read_text()) if stats.exists() else {}
        value[key]=value.get(key,0)+1
        stats.write_text(json.dumps(value))
        assert value[key]==1,'An original synthetic model step was repeated'
    def provider(request):
        body=json.loads(request.content);serialized=json.dumps(body,ensure_ascii=False)
        assert request.url.path.endswith('/chat/completions')
        assert body['model']=='synthetic-command-model'
        messages=body['messages']
        outputs={x['tool_call_id']:x['content'] for x in messages if x['role']=='tool'}
        name=None
        if 'You independently review source-grounded answers' in serialized:
            proof=[json.loads(x['content']) for x in messages
                if x['role']=='user' and isinstance(x.get('content'),str) and x['content'].startswith('{')]
            assert len(proof)==1 and proof[0]['finalAnswer']==SUMMARY
            assert any(a['name']=='result.csv' and a['text']==CSV.decode() for a in proof[0]['artifacts'])
            assert any(a['text']==REPORT for a in proof[0]['artifacts'])
            assert any(t['payload'].get('exitCode')==0 for t in proof[0]['tools'])
            (directory/'review.json').write_text(json.dumps(proof[0]))
            count('review');content=json.dumps(dict(accepted=True,reason='Synthetic review: complete input, command output and report agree.'))
        elif 'command-copy' not in outputs:
            assert '/input/input-01' in serialized
            count('command');name='run_command';call='command-copy';arguments=ARGUMENTS
        elif 'command-report' not in outputs:
            assert 'alpha' in outputs['command-copy'] and '25' not in CSV.decode()
            count('report');name='write_report';call='command-report';arguments=dict(name='command-report.md',markdown=REPORT)
        else:
            count('final');content=SUMMARY
        message=dict(role='assistant',content=content if name is None else None)
        if name is not None:
            message['tool_calls']=[dict(id=call,type='function',function=dict(name=name,arguments=json.dumps(arguments)))]
        return httpx2.Response(200,json=dict(id='synthetic-command-response',object='chat.completion',created=1,
            model=body['model'],choices=[dict(index=0,finish_reason='tool_calls' if name else 'stop',message=message)],
            usage=dict(prompt_tokens=50,completion_tokens=50,total_tokens=100)))
    original=runtime.ProductWorkModel
    runtime.ProductWorkModel=lambda *a,**kw:original(*a,**kw,transport_factory=lambda:httpx2.MockTransport(provider))
    runpy.run_path(str(ROOT/'apps/server-python/scripts/serve.py'),run_name='__main__')


if __name__=='__main__':main()
