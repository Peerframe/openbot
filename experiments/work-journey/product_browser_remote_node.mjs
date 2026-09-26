// Local real Node + SSH-loopback browser; no Control/Node credentials are sent to the VPS.
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startProbeClient } from './product_browser_client.mjs';
let input='';for await (const chunk of process.stdin) input+=chunk;
const c=JSON.parse(input), remote=c.remote;
// The operator supplies the authorized test host; a checkout never selects a personal VPS.
if(typeof remote.sshTarget!=='string'||!/^root@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(remote.sshTarget))throw Error('Explicit root SSH fixture target required');
for(const field of ['computerUrl','stateUrl']) {
 const u=new URL(remote[field]);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.username||u.password||u.pathname!=='/') throw Error('Explicit loopback relay required');
}
if(remote.targetUrl!=='https://example.com:18443'||remote.token!=='synthetic-linux-composition-fixture-only') throw Error('Fixed synthetic target required');
const client=await startProbeClient({...c,computerUrl:remote.computerUrl.replace(/\/$/,''),token:remote.token,targetUrl:remote.targetUrl});
let timer,busy=false,stopped=false;
async function stop(){if(stopped)return;stopped=true;clearInterval(timer);await client.stop();}
process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
const execute=promisify(execFile);
timer=setInterval(async()=>{
 if(busy||stopped)return;busy=true;
 try {
  const path=c.directory+'/control-request.json';let request;
  try{request=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return;throw error;}
  if(!Number.isSafeInteger(request.id)||request.id<1||request.id>2)throw Error('Fixed replacement sequence required');
  await unlink(path);
  if(request.operation==='browser-restart'&&request.id===1) {
   const {stdout}=await execute('/usr/bin/ssh',['-F','none','-S','none','-T','-a','-x','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=15','-o','ForwardAgent=no','-o','ForwardX11=no',remote.sshTarget,'exec /usr/bin/python3 -B /opt/openbot-qualification-20260925-c8b2/composition-20260926-a1/run.py restart'],{timeout:60000,maxBuffer:16384});
   const result=JSON.parse(stdout);if(!result.oldContainerExited||result.oldExitCode!==0||!result.newContainer||!result.samePrivateProfile)throw Error('Native replacement not accepted');
   await writeFile(c.directory+'/browser-processes.json',JSON.stringify(result));
  } else if(request.operation!=='browser-readback'||request.id!==2)throw Error('Unexpected native control operation');
  await writeFile(c.directory+`/control-${request.id}.json`,JSON.stringify({done:true}));
 } catch(error){process.stderr.write(String(error)+'\n');await stop();process.exitCode=1;}
 finally{busy=false;}
},100);
process.stdout.write(JSON.stringify({targetUrl:remote.targetUrl})+'\n');
