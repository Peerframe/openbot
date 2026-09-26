"""Actual product entry with synthetic model HTTP and a controlled SDK Worker restart."""
import asyncio,json,os,runpy,sys
from contextlib import asynccontextmanager
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(ROOT/'apps/server-python/src'),str(ROOT/'apps/agent-runtime-python/src')]
import httpx2
from openbot_server import work_product_runtime as runtime
from openbot_server import work_product_service as service
config=json.loads(Path(os.environ['OPENBOT_BROWSER_PROBE_CONFIG']).read_text())
directory=Path(config['directory']);stats=directory/'provider-counts.json'
TEXT='浏览器任务 你好 🌏'
SUMMARY='The page displayed Saved: '+TEXT+'. The observed page result and report are attached.'
REPORT='# Browser page result\n\nThe observed page displayed **Saved: '+TEXT+'**.\n'

def count(key):
 value=json.loads(stats.read_text()) if stats.exists() else {};value[key]=value.get(key,0)+1
 stats.write_text(json.dumps(value));assert value[key]==1,'Original model step repeated'

def provider(request):
 body=json.loads(request.content);serialized=json.dumps(body,ensure_ascii=False)
 assert request.url.path.endswith('/chat/completions') and body['model']=='synthetic-browser-model'
 messages=body['messages'];outputs={x['tool_call_id']:x['content'] for x in messages if x['role']=='tool'}
 name=None
 def observed(key):
  envelope=json.loads(outputs[key]);assert envelope['status']=='applied'
  payload=envelope['result'];assert payload['untrusted'] and payload['externalEffectVerified'] is False
  return payload
 if 'You independently review source-grounded answers' in serialized:
  proof=[json.loads(x['content']) for x in messages if x['role']=='user' and isinstance(x.get('content'),str) and x['content'].startswith('{')][0]
  assert proof['finalAnswer']==SUMMARY and any(x['text']==REPORT for x in proof['artifacts'])
  assert any('Saved: '+TEXT in x['payload'].get('page',{}).get('text','') for x in proof['tools'])
  count('review');content=json.dumps(dict(accepted=True,reason='Synthetic page text and complete report agree; no external transaction claimed.'))
 elif 'page-navigate' not in outputs:
  cfg=json.loads(Path(os.environ['OPENBOT_BROWSER_PROBE_CONFIG']).read_text());count('navigate');name='navigate_browser';call='page-navigate';arguments=dict(url=cfg['target']+'/')
 elif 'page-type' not in outputs:
  value=observed('page-navigate');ref=next(e['ref'] for e in value['page']['elements'] if e['role']=='textbox')
  count('type');name='type_browser';call='page-type';arguments=dict(observationId=value['observationId'],ref=ref,text=TEXT)
 elif 'page-click' not in outputs:
  value=observed('page-type');ref=next(e['ref'] for e in value['page']['elements'] if e['role']=='button' and e['name']=='Save synthetic entry')
  count('click');name='click_browser';call='page-click';arguments=dict(observationId=value['observationId'],ref=ref)
 elif 'page-read' not in outputs:
  assert 'Saved: '+TEXT in observed('page-click')['page']['text']
  count('read');name='read_browser';call='page-read';arguments={}
 elif 'page-report' not in outputs:
  assert 'Saved: '+TEXT in observed('page-read')['page']['text']
  count('report');name='write_report';call='page-report';arguments=dict(name='browser-report.md',markdown=REPORT)
 else:count('final');content=SUMMARY
 message=dict(role='assistant',content=content if name is None else None)
 if name:message['tool_calls']=[dict(id=call,type='function',function=dict(name=name,arguments=json.dumps(arguments))) ]
 return httpx2.Response(200,json=dict(id='synthetic-browser-response',object='chat.completion',created=1,model=body['model'],choices=[dict(index=0,finish_reason='tool_calls' if name else 'stop',message=message)],usage=dict(prompt_tokens=50,completion_tokens=50,total_tokens=100)))

original=runtime.ProductWorkModel
runtime.ProductWorkModel=lambda *a,**kw:original(*a,**kw,transport_factory=lambda:httpx2.MockTransport(provider))
original_worker=service.product_worker
@asynccontextmanager
async def restartable_worker(*args,**kwargs):
 current=original_worker(*args,**kwargs);await current.__aenter__();active=True
 async def monitor():
  nonlocal current,active
  while not (directory/'pause-worker').exists():await asyncio.sleep(.1)
  await current.__aexit__(None,None,None);active=False;(directory/'worker-stopped').touch()
  while not (directory/'resume-worker').exists():await asyncio.sleep(.1)
  current=original_worker(*args,**kwargs);await current.__aenter__();active=True;(directory/'worker-resumed').touch()
 task=asyncio.create_task(monitor())
 try:yield
 finally:
  task.cancel();await asyncio.gather(task,return_exceptions=True)
  if active:await current.__aexit__(None,None,None)
service.product_worker=restartable_worker
runpy.run_path(str(ROOT/'apps/server-python/scripts/serve.py'),run_name='__main__')
