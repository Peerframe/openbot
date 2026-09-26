// Executes inside the actual isolated browser container before the product journey.
import assert from 'node:assert/strict';
import net from 'node:net';
const result={accepted:false,uid:process.getuid(),cases:[]};
assert.equal(result.uid,1001);
function tcp(host,port,payload='GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n') {
 return new Promise(resolve=>{const socket=net.connect({host,port});let text='';socket.setTimeout(700,()=>socket.destroy());socket.on('connect',()=>socket.write(payload));socket.on('data',data=>{text+=data;assert.ok(text.length<16384)});socket.on('error',()=>{});socket.on('close',()=>resolve(text));});
}
for(const [name,host,port] of [['direct-public','93.184.216.34',18080],['direct-public-v6','2606:4700:4700:ffee::2',18080],['private','10.77.12.2',18080],['private-v6','fd77:12::2',18080],['metadata','169.254.169.254',18080],['management','93.184.216.35',18080],['gateway','10.77.10.1',18080]]) {
 const response=await tcp(host,port);assert.equal(response,'',name);result.cases.push({name,denied:true});
}
for(const [name,url,status] of [['public','http://example.com:18080/',200],['public-v6','http://ipv6.example:18080/',200],['private-dns','http://private.example:18080/',403],['metadata-dns','http://metadata.example:18080/',403],['management-dns','http://control.example:18080/',403],['wrong-domain','http://other.example:18080/',403]]) {
 const response=await tcp('10.77.11.2',3128,`GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\nConnection: close\r\n\r\n`);assert.match(response,new RegExp(`^HTTP/1\\.[01] ${status} `),name);result.cases.push({name,status});
}
result.accepted=true;console.log(JSON.stringify(result));
