// Keep one verified TLS tunnel open while the native admission chain is revoked.
import net from 'node:net';
import tls from 'node:tls';
import { readFile, writeFile } from 'node:fs/promises';
const resultPath='/tmp/tunnel-result.json';
let connection;
const timer=setTimeout(()=>{connection?.destroy();process.exit(124);},25000);
function response(socket,request,timeout=5000) {
  return new Promise((resolve,reject)=>{
    let text='';
    const done=(error)=>{clearTimeout(deadline);socket.off('data',data);socket.off('error',done);socket.off('close',closed);error?reject(error):resolve(text);};
    const closed=()=>done(Error('closed'));
    const data=chunk=>{text+=chunk.toString();if(text.length>65536)return done(Error('oversize'));const i=text.indexOf('\r\n\r\n');if(i<0)return;const size=Number(text.slice(0,i).match(/content-length: (\d+)/i)?.[1]??0);if(text.length>=i+4+size)done();};
    const deadline=setTimeout(()=>done(Error('timeout')),timeout);
    socket.on('data',data);socket.once('error',done);socket.once('close',closed);socket.write(request);
  });
}
try {
  const socket=net.connect({host:'10.77.11.2',port:3128});connection=socket;
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
  const connect=await response(socket,'CONNECT example.com:18443 HTTP/1.1\r\nHost: example.com:18443\r\n\r\n');
  if(!connect.startsWith('HTTP/1.1 200'))throw Error('CONNECT failed');
  connection=tls.connect({socket,servername:'example.com',ca:await readFile('/fixture-trust/ca.pem'),rejectUnauthorized:true});
  await new Promise((resolve,reject)=>{connection.once('secureConnect',resolve);connection.once('error',reject);});
  const request='GET /tunnel HTTP/1.1\r\nHost: example.com:18443\r\nConnection: keep-alive\r\n\r\n';
  const before=await response(connection,request);
  if(!before.startsWith('HTTP/1.1 200')||!before.endsWith('owned-tunnel'))throw Error('baseline not reached');
  await writeFile('/tmp/tunnel-ready.json',JSON.stringify({verifiedTLS:true,baseline:true}));
  for(;;){try{await readFile('/tmp/tunnel-revoked');break;}catch(e){if(e.code!=='ENOENT')throw e;await new Promise(r=>setTimeout(r,50));}}
  let refused=false;
  try{await response(connection,request);}catch(error){if(!['timeout','closed'].includes(error.message))throw error;refused=true;}
  if(!refused)throw Error('existing tunnel survived revocation');
  await writeFile(resultPath,JSON.stringify({accepted:true,verifiedTLS:true,sameSocket:true,revoked:true}));
}catch(error){await writeFile(resultPath,JSON.stringify({accepted:false,error:error.message}));process.exitCode=2;}
finally{connection?.destroy();clearTimeout(timer);}
