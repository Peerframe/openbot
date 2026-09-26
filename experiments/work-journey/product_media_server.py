"""Actual serve entry; the sole replacement is a strict synthetic provider transport."""
import argparse
import json
import os
from pathlib import Path
import runpy
import sys

from product_media_fixture import REPORT,SUMMARY,assert_wire


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--repo',type=Path,required=True)
    args=parser.parse_args();repo=args.repo.resolve()
    sys.path[:0]=[str(repo/'apps/server-python/src'),str(repo/'apps/agent-runtime-python/src')]
    import httpx2
    from openbot_server import work_product_runtime as runtime
    config=json.loads(Path(os.environ['OPENBOT_MEDIA_PROBE_CONFIG']).read_text())
    events=Path(config['directory'])/'provider-observations.jsonl'
    def response(request):
        body,review,record=assert_wire(request)
        with events.open('a') as stream:stream.write(json.dumps(record,ensure_ascii=False)+'\n')
        if review:
            answer=json.dumps(dict(accepted=True,reason='Synthetic wire and report evidence match.'))
            output=[dict(id='media-review',type='message',role='assistant',status='completed',
                         content=[dict(type='output_text',text=answer,annotations=[])])]
        elif not any(item.get('type')=='function_call_output' and item.get('call_id')=='media-report' for item in body['input']):
            assert any(tool.get('name')=='write_report' for tool in body['tools'])
            output=[dict(id='media-report',type='function_call',call_id='media-report',name='write_report',
                arguments=json.dumps(dict(name='media-report.md',markdown=REPORT)),status='completed')]
        else:
            output=[dict(id='media-answer',type='message',role='assistant',status='completed',
                         content=[dict(type='output_text',text=SUMMARY,annotations=[])])]
        return httpx2.Response(200,json=dict(id='synthetic-media-response',object='response',created_at=1,
            model=body['model'],status='completed',output=output,
            usage=dict(input_tokens=50,output_tokens=50,total_tokens=100)))
    original=runtime.ProductWorkModel
    def model(*args,**kwargs):return original(*args,**kwargs,transport_factory=lambda:httpx2.MockTransport(response))
    runtime.ProductWorkModel=model
    runpy.run_path(str(repo/'apps/server-python/scripts/serve.py'),run_name='__main__')


if __name__=='__main__':main()
