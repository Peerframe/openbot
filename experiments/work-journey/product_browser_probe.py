"""Real Control/Node/Chromium/Temporal journey; synthetic model, never personal browser state."""
import argparse,asyncio,json,os,secrets,signal,sys,time,subprocess
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
ROOT=Path(__file__).resolve().parents[2]
PACKET=Path(__file__).resolve().parent
sys.path[:0]=[str(ROOT/'experiments/work-journey'),str(ROOT/'apps/server-python/src'),str(ROOT/'apps/agent-runtime-python/src')]
import psycopg
import httpx
from active_restore_probe import ControlDatabase,private
from postgres_server import PostgresServer
from product_http_fixture import API,Process,CLEAN_ENV
from temporalio.worker import Replayer
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from openbot_server.work_worker import OpenBotWork

def emit(**v):print(json.dumps(v),flush=True)
async def run(directory,upstream,browsers):
 os.umask(0o077)
 from product_browser_upstream import verify
 verify(upstream)
 if directory.exists():raise ValueError("Use a new owned output directory")
 directory.mkdir(mode=0o700)
 for name in ('artifacts','objects','provider','node'):(directory/name).mkdir(mode=0o700)
 db=ControlDatabase(directory,'browser-product','postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0')
 engine=api=node=log=None;node_id='browser-product-'+secrets.token_hex(5)
 try:
  await asyncio.to_thread(db.start);await asyncio.to_thread(db.migrate,ROOT)
  with psycopg.connect(db.dsn) as conn:canonical_migrations=conn.execute('SELECT count(*) FROM drizzle.__drizzle_migrations').fetchone()[0]
  engine=PostgresServer(directory,mtls=True);engine.release_overlay=ROOT/'experiments/work-journey/terminal-recovery/resources.yaml'
  await asyncio.to_thread(engine.start);client=await engine.connect();emit(stage='engine-ready')
  ec=directory/'engine.json';private(ec,dict(temporal_address=engine.address,namespace='default',queue='browser-'+secrets.token_hex(6),tls=engine.client_settings,interval_seconds=1,execution_timeout_seconds=600))
  pc=directory/'provider.json';private(pc,dict(directory=str(directory/'provider')))
  api=API(directory,db.dsn,directory/'artifacts')
  api.env.update(OPENBOT_CONTROL_AUTHORITY='product',OPENBOT_CONTROL_WORK_TOKEN_LIMIT='1000000',OPENBOT_CONTROL_OBJECT_ROOT=str(directory/'objects'),OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH=str(ec),OPENBOT_BROWSER_PROBE_CONFIG=str(pc))
  def start():api.child=Process([sys.executable,'-u','-B',str(PACKET/'product_browser_server.py')],api.directory,api.env)
  async def until(f,seconds=60):
   deadline=time.monotonic()+seconds
   while time.monotonic()<deadline:
    api.child.alive()
    try:value=await asyncio.to_thread(f)
    except OSError:value=None
    if value:return value
    await asyncio.sleep(.15)
   raise AssertionError('Browser product checkpoint timed out')
  start();await until(lambda:api.call('/health').get('ok'))
  await asyncio.to_thread(api.call,'/api/v1/auth/login',dict(password=api.password))
  connection=(await asyncio.to_thread(api.call,'/api/v1/model-connections',dict(name='Synthetic browser model',presetId='openai',baseUrl='https://api.openai.com/v1',apiKey='synthetic-browser-key'),expected=201))['connection']
  bot=(await asyncio.to_thread(api.call,'/api/v1/bots',dict(name='Browser product fixture',role='Synthetic page reader',computerProfile='docker-linux',model=dict(connectionId=connection['id'],modelId='synthetic-browser-model')),expected=201))['bot']
  channel=(await asyncio.to_thread(api.call,'/api/v1/channels',dict(name='Browser qualification',botIds=[bot['id']]),expected=201))['channel']
  issued=await asyncio.to_thread(api.call,'/api/v1/nodes/enrollment-tokens',dict(nodeId=node_id),expected=201)
  credential=(await asyncio.to_thread(api.call,'/api/v1/nodes/enroll',dict(nodeId=node_id,token=issued.pop('token')),expected=201))['credential']
  log=(directory/'node.log').open('w')
  node=await asyncio.create_subprocess_exec('node','--import','tsx',str(PACKET/'product_browser_node.mjs'),cwd=ROOT,env={**CLEAN_ENV,'PLAYWRIGHT_BROWSERS_PATH':str(browsers)},stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=log)
  node.stdin.write(json.dumps(dict(nodeId=node_id,botId=bot['id'],serverUrl=api.url.replace('http:','ws:')+'/ws/nodes',credential=credential,directory=str(directory/'node'),upstream=str(upstream))).encode());await node.stdin.drain();node.stdin.close()
  async with asyncio.timeout(20):target=json.loads(await node.stdout.readline())['targetUrl']
  cfg=dict(version=1,humanControl=True,routes={bot['id']:node_id},pageOrigins={bot['id']:[target]})
  bc=directory/'browser.json';private(bc,cfg);private(pc,dict(directory=str(directory/'provider'),target=target))
  api.env['OPENBOT_CONTROL_BROWSER_CONFIG_PATH']=str(bc)
  api.close();start();await until(lambda:api.call('/health').get('ok'))
  await asyncio.to_thread(api.call,'/api/v1/auth/login',dict(password=api.password))
  await until(lambda:any(x['id']==node_id for x in api.call('/api/v1/nodes')['nodes']))
  view=await asyncio.to_thread(api.call,f"/api/v1/bots/{bot['id']}/browser",{},expected=201)
  emit(stage='browser-route-ready',actualNode=True)
  source=await asyncio.to_thread(api.call,f"/api/v1/channels/{channel['id']}/messages",dict(botId=bot['id'],content='Open the configured synthetic page, fill Fixture text with 浏览器任务 你好 🌏, click Save synthetic entry once, read the resulting page, and write a report of what it displayed. Do not claim an external transaction.'),expected=201)
  with psycopg.connect(db.dsn) as conn:tid,rid=conn.execute('SELECT s.task_id,r.id FROM work_sources s JOIN work_runs r ON r.task_id=s.task_id WHERE s.legacy_run_id=%s',(source['run']['id'],)).fetchone()
  private(directory/'identity.json',dict(taskId=tid,runId=rid))
  for name in ('navigate_browser','type_browser','click_browser','read_browser'):
   def pending():
    snapshot=api.snapshot(tid);private(directory/'snapshot.json',snapshot)
    assert snapshot['status'] not in ('failed','cancelled'),snapshot['status']
    return next((a for a in snapshot['actions'] if a['intent'].get('tool')==name and a['status']=='proposed'),None)
   action=await until(pending)
   assert action['decision']=='pending'
   if name=='click_browser':
    (directory/'provider/pause-worker').touch();await until(lambda:(directory/'provider/worker-stopped').exists(),30)
    async with httpx.AsyncClient(trust_env=False) as http:state=(await http.get(target+'/state')).json()
    assert state['submitted']==0 and state['text']=='浏览器任务 你好 🌏',state
    emit(stage='worker-stopped-with-original-click-pending')
   await asyncio.to_thread(api.call,f"/api/v1/actions/{action['id']}/decision",dict(intentDigest=action['intentDigest'],approved=True))
   if name=='click_browser':
    await asyncio.sleep(.4)
    async with httpx.AsyncClient(trust_env=False) as http:state=(await http.get(target+'/state')).json()
    assert state['submitted']==0
    (directory/'provider/resume-worker').touch();await until(lambda:(directory/'provider/worker-resumed').exists(),30)
   emit(stage='approved',tool=name)
  def completed():
   snapshot=api.snapshot(tid);private(directory/'snapshot.json',snapshot)
   assert snapshot['status'] not in ('failed','cancelled'),snapshot['status']
   return snapshot if snapshot['status']=='completed' else None
  snapshot=await until(completed)
  counts=json.loads((directory/'node/browser-counts.json').read_text());assert counts==dict(navigate=1,type=1,click=1,read=1),counts
  model_counts=json.loads((directory/'provider/provider-counts.json').read_text());assert all(x==1 for x in model_counts.values()) and len(model_counts)==7,model_counts
  assert len(snapshot['artifacts'])==1
  report=await asyncio.to_thread(api.call,snapshot['artifacts'][0]['downloadUrl'],raw=True);assert 'Saved: 浏览器任务 你好 🌏' in report.decode()
  async with httpx.AsyncClient(trust_env=False) as http:state=(await http.get(target+'/state')).json()
  assert state['submitted']==1 and state['stored']=='浏览器任务 你好 🌏'
  handle=client.get_workflow_handle('openbot-work-v1-'+rid);assert (await asyncio.wait_for(handle.result(),20))['status']=='completed'
  history=await handle.fetch_history();(directory/'history.json').write_text(history.to_json())
  with ThreadPoolExecutor(max_workers=2) as executor:await Replayer(workflows=[OpenBotWork],plugins=[PydanticAIPlugin()],workflow_task_executor=executor).replay_workflow(history)
  assert json.loads((directory/'node/browser-counts.json').read_text())==counts and json.loads((directory/'provider/provider-counts.json').read_text())==model_counts
  record=dict(accepted=True,scope='trusted synthetic page on local Chromium',actualProductEntry=True,actualNode=True,actualChromium=True,actualPostgres=True,mutualTLS=True,canonicalMigrations=canonical_migrations,actualWorkApprovals=4,modelHTTP='synthetic',browserCalls=counts,modelCalls=model_counts,approvedWhileWorkerStopped=True,sameNodeConnectionRetained=True,originalClickOnlyOnce=True,actualTargetIndependentState=True,reportDownloaded=True,offlineReplay=True,publicEgressQualified=False,isolatedLinuxBrowserProduct=False)
  private(directory/'RESULT.json',record);emit(**record)
 finally:
  if node and node.returncode is None:
   node.terminate()
   try:await asyncio.wait_for(node.wait(),12)
   except TimeoutError:node.kill();await node.wait()
  if log:log.close()
  if api:api.close()
  if engine:await asyncio.to_thread(engine.close)
  await asyncio.to_thread(db.close)
  if (directory/'RESULT.json').exists():
   record=json.loads((directory/'RESULT.json').read_text());record['ownedFixturesClosed']=True;private(directory/'RESULT.json',record)
  emit(stage='owned-fixtures-closed')
if __name__=='__main__':
 parser=argparse.ArgumentParser(description='Actual local browser product with synthetic model and owned target; no public browsing.')
 parser.add_argument('--output',type=Path,required=True)
 parser.add_argument('--upstream',type=Path,required=True)
 parser.add_argument('--browsers',type=Path,required=True)
 args=parser.parse_args()
 asyncio.run(run(args.output.resolve(),args.upstream.resolve(),args.browsers.resolve()))
