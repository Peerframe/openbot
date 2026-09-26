"""Owned native namespace canaries/relays; fixed qualification, never a public Host service."""
from __future__ import annotations
import argparse, http.server, json, os, selectors, signal, socket, socketserver, ssl, subprocess, threading, time
from pathlib import Path

ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'}
PAGE = '''<!doctype html><meta charset="utf-8"><title>Owned browser task fixture</title><style>body{font:24px system-ui;margin:40px;background:#eef7f1}input{position:absolute;left:40px;top:140px;width:520px;height:45px;font:24px system-ui}button{position:absolute;left:40px;top:220px;height:50px}#result{position:absolute;top:300px}</style><h1>OpenBot browser task</h1><form><input aria-label="Fixture text"><button>Save synthetic entry</button></form><p id="result">Waiting for input</p><script>const f=document.querySelector('input');f.value=localStorage.getItem('entry')||'';function report(){fetch('/event',{method:'POST',body:JSON.stringify({text:f.value,submitted:Number(document.body.dataset.count||0),stored:localStorage.getItem('entry')||'',persistentCookie:document.cookie.includes('fixture_expiry=retained'),sessionCookie:document.cookie.includes('fixture_session=temporary'),indexedDB:window.persistedValue||''})})}f.oninput=report;document.querySelector('form').onsubmit=e=>{e.preventDefault();document.body.dataset.count=Number(document.body.dataset.count||0)+1;localStorage.setItem('entry',f.value);document.querySelector('#result').textContent='Saved: '+f.value;report()};const opening=indexedDB.open('profile-fixture',1);opening.onupgradeneeded=()=>opening.result.createObjectStore('entries');opening.onsuccess=()=>{const db=opening.result;const read=db.transaction('entries').objectStore('entries').get('saved');read.onsuccess=()=>{window.persistedValue=read.result||'';report()};document.querySelector('form').addEventListener('submit',()=>{document.cookie='fixture_expiry=retained;Max-Age=86400;SameSite=Strict;Path=/';document.cookie='fixture_session=temporary;SameSite=Strict;Path=/';const tx=db.transaction('entries','readwrite');tx.objectStore('entries').put('synthetic-indexed-value','saved');tx.oncomplete=()=>{window.persistedValue='synthetic-indexed-value';report()}})};</script>'''
STATE = {'text': '', 'submitted': 0, 'stored': ''}
HITS = 0


def require(value, message):
    if not value: raise RuntimeError(message)


def isolated(root):
    require(os.geteuid() == 0 and root.parent == Path('/opt/openbot-qualification-20260925-c8b2/units'), 'owned root required')
    require(root.resolve() == root and root.stat().st_uid == 0 and root.stat().st_mode & 0o077 == 0, 'private directory required')
    require(Path('/proc/self/cgroup').read_text().strip() == '0::/system.slice/openbot-qualification-' + root.name + '.service/supervisor', 'original cgroup required')
    require(os.stat('/proc/self/ns/net').st_ino != os.stat('/proc/1/ns/net').st_ino, 'host namespace forbidden')


def command(*argv):
    return subprocess.check_output(argv, env=ENV, timeout=8)


class Target(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *args): pass
    def do_GET(self):
        global HITS
        if self.path == '/state': body=json.dumps(STATE).encode();kind='application/json'
        elif self.path == '/hits': body=json.dumps({'requests': HITS}).encode();kind='application/json'
        elif self.path == '/tunnel': HITS+=1;body=b'owned-tunnel';kind='text/plain'
        else: HITS+=1;body=PAGE.encode();kind='text/html; charset=utf-8'
        self.send_response(200);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    def do_POST(self):
        if self.path != '/event': self.send_error(404);return
        length=int(self.headers.get('Content-Length','0'));require(0 < length <= 4096,'bounded synthetic event required')
        event=json.loads(self.rfile.read(length));require(set(event) <= {'text','submitted','stored','persistentCookie','sessionCookie','indexedDB'},'unexpected event')
        STATE.update(event);self.send_response(200);self.send_header('Content-Length','2');self.end_headers();self.wfile.write(b'ok')


class IPv6HTTP(http.server.ThreadingHTTPServer):
    address_family=socket.AF_INET6
    daemon_threads=True


class Relay(socketserver.BaseRequestHandler):
    def handle(self):
        # Root-private AF_UNIX entry only. Fixed targets; no client-selected host/port.
        remote=socket.create_connection(self.server.target,timeout=3)
        try:
            self.request.setblocking(False);remote.setblocking(False)
            with selectors.DefaultSelector() as selector:
                selector.register(self.request,selectors.EVENT_READ,remote)
                selector.register(remote,selectors.EVENT_READ,self.request)
                end=time.monotonic()+90
                while time.monotonic()<end:
                    for key,_ in selector.select(1):
                        data=key.fileobj.recv(65536)
                        if not data:return
                        key.data.settimeout(3);key.data.sendall(data);key.data.setblocking(False)
        finally:remote.close()


class UnixRelay(socketserver.ThreadingUnixStreamServer):
    daemon_threads=True


def companion(root):
    isolated(root)
    require(json.loads(command('/usr/sbin/ip','-json','route','show')) == [], 'unexpected route')
    require(b'table ' not in command('/usr/sbin/nft','list','ruleset'), 'existing private rules')
    command('/usr/bin/mount','-t','tmpfs','-o','size=256m,nodev,nosuid,noexec,uid=1001,gid=1001,mode=700','tmpfs',str(root/'profiles'))
    Path('/proc/sys/net/ipv4/ip_forward').write_text('1')
    Path('/proc/sys/net/ipv6/conf/all/forwarding').write_text('1')
    children=[]
    try:
        for role,gateway4,address4,gateway6,address6 in (
            ('public','93.184.216.33/29','93.184.216.34/29','2606:4700:4700:ffee::1/64','2606:4700:4700:ffee::2/64'),
            ('private','10.77.12.1/30','10.77.12.2/30','fd77:12::1/64','fd77:12::2/64')):
            anchor=subprocess.Popen(['/usr/bin/unshare','--net','/usr/bin/sleep','595'],env=ENV);children.append(anchor)
            end=time.monotonic()+3
            while os.stat(f'/proc/{anchor.pid}/ns/net').st_ino==os.stat('/proc/self/ns/net').st_ino:
                require(anchor.poll() is None and time.monotonic()<end,'namespace readiness');time.sleep(.02)
            def child(*argv):return command('/usr/bin/nsenter','--target',str(anchor.pid),'--net',*argv)
            interface='ob_'+role;peer='peer_'+role
            command('/usr/sbin/ip','link','add',interface,'type','veth','peer','name',peer)
            command('/usr/sbin/ip','link','set',peer,'netns',str(anchor.pid))
            for address in (gateway4,gateway6):command('/usr/sbin/ip','addr','add',address,'dev',interface,*(['nodad'] if ':' in address else []))
            command('/usr/sbin/ip','link','set',interface,'up')
            child('/usr/sbin/ip','link','set','lo','up');child('/usr/sbin/ip','link','set',peer,'name','eth0')
            for address in (address4,address6):child('/usr/sbin/ip','addr','add',address,'dev','eth0',*(['nodad'] if ':' in address else []))
            child('/usr/sbin/ip','link','set','eth0','up')
            child('/usr/sbin/ip','route','add','default','via',gateway4.split('/')[0])
            child('/usr/sbin/ip','-6','route','add','default','via',gateway6.split('/')[0])
            if role=='private':
                child('/usr/sbin/ip','addr','add','169.254.169.254/32','dev','lo')
                command('/usr/sbin/ip','route','add','169.254.169.254/32','via','10.77.12.2')
            service=subprocess.Popen(['/usr/bin/nsenter','--target',str(anchor.pid),'--net','/usr/bin/python3','-B',__file__,'target','--root',str(root)],env=ENV);children.append(service)
        command('/usr/sbin/ip','addr','add','93.184.216.35/32','dev','lo')
        host_canary=IPv6HTTP(('::',18080),Target)
        threading.Thread(target=host_canary.serve_forever,daemon=True).start()
        (root/'companion-ready.json').write_text(json.dumps({'ready':True,'netns':os.stat('/proc/self/ns/net').st_ino}))
        relays=[]
        for name,target in (('control',('10.77.10.2',4100)),('target',('93.184.216.34',18080))):
            server=UnixRelay(str(root/(name+'.sock')),Relay);server.target=target;relays.append(server)
            threading.Thread(target=server.serve_forever,daemon=True).start()
        while all(child.poll() is None for child in children):time.sleep(.2)
        raise RuntimeError('owned canary exited')
    finally:
        for child in children:
            if child.poll() is None:child.kill()
        for child in children:child.wait(timeout=3)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('operation',choices=('companion','target'));parser.add_argument('--root',type=Path,required=True);args=parser.parse_args()
    isolated(args.root)
    if args.operation=='target':
        for port,prefix in ((18443,''),(18444,'unknown-')):
            server=IPv6HTTP(('::',port),Target)
            context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.minimum_version=ssl.TLSVersion.TLSv1_2
            packet=Path(__file__).resolve().parent
            context.load_cert_chain(packet/('tls/'+prefix+'cert.pem'),packet/('tls/'+prefix+'key.pem'))
            server.socket=context.wrap_socket(server.socket,server_side=True)
            threading.Thread(target=server.serve_forever,daemon=True).start()
        IPv6HTTP(('::',18080),Target).serve_forever()
    else:companion(args.root)

if __name__=='__main__':main()
