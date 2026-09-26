"""Fixed synthetic Linux routing qualification; not a browser Host or production installer."""
import json
import os
from pathlib import Path
import socket
import socketserver
import subprocess
import sys
import threading
import time

ROOT = Path('/opt/openbot-qualification-20260925-c8b2/network-20260926-a2')
UNIT = 'openbot-browser-network-20260926-a2.service'
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'}
ROLES = {
    'client': ('10.77.10.1/30', '10.77.10.2/30', 'fd77:10::1/64', 'fd77:10::2/64'),
    'proxy': ('10.77.11.1/30', '10.77.11.2/30', 'fd77:11::1/64', 'fd77:11::2/64'),
    'public': ('93.184.216.33/29', '93.184.216.34/29', '2606:4700:4700:ffee::1/64', '2606:4700:4700:ffee::2/64'),
    'private': ('10.77.12.1/30', '10.77.12.2/30', 'fd77:12::1/64', 'fd77:12::2/64'),
}
HOSTS = {address.split('/')[0] for values in ROLES.values() for address in values}
HOSTS.update(('169.254.169.254', '93.184.216.35'))
PORTS = (3128, 3129, 18080, 18443, 53, 443)
COUNTS = {'tcp': 0, 'udp': 0}
PERSISTENT = {}
SERVERS = []


def require(value, reason):
    if not value:
        raise RuntimeError(reason)


def command(argv, **kwargs):
    return subprocess.check_output(argv, timeout=8, env=ENV, **kwargs)


def isolated():
    require(os.geteuid() == 0, 'root fixture required')
    require(ROOT.resolve() == ROOT and ROOT.is_dir() and ROOT.stat().st_uid == 0
            and ROOT.stat().st_mode & 0o077 == 0, 'private owned fixture directory required')
    require(Path('/proc/self/cgroup').read_text().strip() == '0::/system.slice/' + UNIT,
            'outside original native unit')
    require(os.stat('/proc/self/ns/net').st_ino != os.stat('/proc/1/ns/net').st_ino,
            'host network namespace refused')


class TCP(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True
    address_family = socket.AF_INET6


class UDP(socketserver.ThreadingMixIn, socketserver.UDPServer):
    daemon_threads = True
    allow_reuse_address = True
    address_family = socket.AF_INET6


class EchoTCP(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(3)
        try:
            while self.request.recv(64):
                COUNTS['tcp'] += 1
                self.request.sendall(b'owned-canary')
        except OSError:
            pass


class EchoUDP(socketserver.BaseRequestHandler):
    def handle(self):
        data, sock = self.request
        if len(data) <= 64:
            COUNTS['udp'] += 1
            sock.sendto(b'owned-canary', self.client_address)


def exchange(value):
    operation = value['op']
    if operation == 'counts':
        return dict(COUNTS)
    if operation == 'hold':
        sock = socket.create_connection(('10.77.11.2', 3128), timeout=.5)
        PERSISTENT['original'] = sock
    elif operation == 'pulse':
        sock = PERSISTENT['original']
    else:
        require(operation in ('tcp', 'udp') and value['address'] in HOSTS and value['port'] in PORTS,
                'fixed fixture target required')
        family = socket.AF_INET6 if ':' in value['address'] else socket.AF_INET
        sock = socket.socket(family, socket.SOCK_DGRAM if operation == 'udp' else socket.SOCK_STREAM)
        sock.settimeout(.35)
    try:
        if operation in ('hold', 'pulse'):
            sock.settimeout(.35)
            sock.sendall(b'fixture-pulse')
            reply = sock.recv(64)
        elif operation == 'udp':
            sock.sendto(b'fixture-datagram', (value['address'], value['port']))
            reply = sock.recv(64)
        else:
            sock.connect((value['address'], value['port']))
            sock.sendall(b'fixture-request')
            reply = sock.recv(64)
        return {'ok': reply == b'owned-canary'}
    except OSError as error:
        return {'ok': False, 'error': type(error).__name__, 'errno': error.errno}
    finally:
        if operation not in ('hold', 'pulse'):
            sock.close()


class RPC(socketserver.StreamRequestHandler):
    def handle(self):
        self.request.settimeout(2)
        raw = self.rfile.readline(2049)
        require(len(raw) <= 2048 and raw.endswith(b'\n'), 'bounded fixture request required')
        answer = exchange(json.loads(raw))
        self.wfile.write(json.dumps(answer).encode() + b'\n')


def start_services(role):
    for port in PORTS:
        for cls, handler in ((TCP, EchoTCP), (UDP, EchoUDP)):
            server = cls(('::', port), handler)
            SERVERS.append(server)
            threading.Thread(target=server.serve_forever, daemon=True).start()
    rpc_server = socketserver.UnixStreamServer(str(ROOT / (role + '.sock')), RPC)
    SERVERS.append(rpc_server)
    threading.Thread(target=rpc_server.serve_forever, daemon=True).start()


def rpc(role, value):
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(2)
        sock.connect(str(ROOT / (role + '.sock')))
        sock.sendall(json.dumps(value).encode() + b'\n')
        with sock.makefile('rb') as stream:
            raw = stream.readline(2049)
        require(len(raw) <= 2048 and raw.endswith(b'\n'), 'bounded fixture response required')
        return json.loads(raw)


def wait(predicate, seconds=3):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.03)
    raise RuntimeError('fixture readiness timed out')


def run():
    isolated()
    output = ROOT / 'RESULT.json'
    require(not output.exists(), 'single-use fixture already has a result')
    native = command(['/usr/bin/systemctl', 'show', UNIT, '--property=PrivateNetwork,RuntimeMaxUSec,KillMode,Restart,MemoryMax,CPUQuotaPerSecUSec']).decode()
    for fragment in ('PrivateNetwork=yes', 'RuntimeMaxUSec=2min 30s', 'KillMode=control-group',
                     'Restart=no', 'MemoryMax=268435456', 'CPUQuotaPerSecUSec=1s'):
        require(fragment in native.splitlines(), 'native lifetime/resource configuration differs')
    require(json.loads(command(['/usr/sbin/ip', '-json', 'route', 'show'])) == [], 'unexpected outside route')
    require('table ' not in command(['/usr/sbin/nft', 'list', 'ruleset']).decode(), 'private namespace rules already exist')
    children = []
    result = {'format': 'openbot-native-kernel-egress', 'version': 1, 'accepted': False,
              'nativeDeadlineSeconds': 150, 'noExternalRoute': True, 'cases': [],
              'squidCompositionQualified': False, 'browserRunscQualified': False, 'productAuthorityQualified': False}
    original_ns = os.stat('/proc/self/ns/net').st_ino
    def ip(*args):
        isolated()
        require(os.stat('/proc/self/ns/net').st_ino == original_ns, 'original namespace changed')
        return command(['/usr/sbin/ip', *args])
    def in_ns(child, *args):
        require(child.poll() is None, 'original namespace anchor exited')
        return command(['/usr/bin/nsenter', '--target', str(child.pid), '--net', *args])
    try:
        Path('/proc/sys/net/ipv4/ip_forward').write_text('1')
        Path('/proc/sys/net/ipv6/conf/all/forwarding').write_text('1')
        ip('addr', 'add', '93.184.216.35/32', 'dev', 'lo')
        start_services('host')
        for role, (gateway4, address4, gateway6, address6) in ROLES.items():
            anchor = subprocess.Popen(['/usr/bin/unshare', '--net', '/usr/bin/sleep', '145'], env=ENV)
            children.append(anchor)
            wait(lambda: anchor.poll() is None and os.stat(f'/proc/{anchor.pid}/ns/net').st_ino != original_ns)
            host_if, peer = 'ob_' + role, 'peer_' + role
            ip('link', 'add', host_if, 'type', 'veth', 'peer', 'name', peer)
            ip('link', 'set', peer, 'netns', str(anchor.pid))
            for address in (gateway4, gateway6):
                ip('addr', 'add', address, 'dev', host_if, *(['nodad'] if ':' in address else []))
            ip('link', 'set', host_if, 'up')
            in_ns(anchor, '/usr/sbin/ip', 'link', 'set', 'lo', 'up')
            in_ns(anchor, '/usr/sbin/ip', 'link', 'set', peer, 'name', 'eth0')
            for address in (address4, address6):
                in_ns(anchor, '/usr/sbin/ip', 'addr', 'add', address, 'dev', 'eth0', *(['nodad'] if ':' in address else []))
            in_ns(anchor, '/usr/sbin/ip', 'link', 'set', 'eth0', 'up')
            in_ns(anchor, '/usr/sbin/ip', 'route', 'add', 'default', 'via', gateway4.split('/')[0])
            in_ns(anchor, '/usr/sbin/ip', '-6', 'route', 'add', 'default', 'via', gateway6.split('/')[0])
            if role == 'private':
                in_ns(anchor, '/usr/sbin/ip', 'addr', 'add', '169.254.169.254/32', 'dev', 'lo')
                ip('route', 'add', '169.254.169.254/32', 'via', '10.77.12.2')
            child = subprocess.Popen(['/usr/bin/nsenter', '--target', str(anchor.pid), '--net',
                                      '/usr/bin/python3', '-B', str(ROOT / 'network_probe.py'), 'service', role], env=ENV)
            children.append(child)
            wait(lambda: child.poll() is None and (ROOT / (role + '.sock')).exists())
        # Link-local IPv6 DAD also governs neighbor discovery; global nodad alone is insufficient.
        def ipv6_ready(raw):
            return all(not address.get('tentative') and not address.get('dadfailed')
                       and 'tentative' not in address.get('flags', [])
                       and 'dadfailed' not in address.get('flags', [])
                       for link in json.loads(raw) for address in link.get('addr_info', []))
        wait(lambda: ipv6_ready(ip('-6', '-json', 'addr', 'show')))
        for anchor in children[::2]:
            wait(lambda: ipv6_ready(in_ns(anchor, '/usr/sbin/ip', '-6', '-json', 'addr', 'show')))
        targets = [
            ('public-v4', 'public', '93.184.216.34', 18080, 'tcp'),
            ('public-v6', 'public', '2606:4700:4700:ffee::2', 18080, 'tcp'),
            ('private-v4', 'private', '10.77.12.2', 18080, 'tcp'),
            ('private-v6', 'private', 'fd77:12::2', 18080, 'tcp'),
            ('metadata', 'private', '169.254.169.254', 18080, 'tcp'),
            ('gateway', 'host', '10.77.10.1', 18080, 'tcp'),
            ('gateway-v6', 'host', 'fd77:10::1', 18080, 'tcp'),
            ('management', 'host', '93.184.216.35', 18080, 'tcp'),
            ('dns-tcp', 'public', '93.184.216.34', 53, 'tcp'),
            ('dns-udp', 'public', '93.184.216.34', 53, 'udp'),
            ('quic-udp', 'public', '93.184.216.34', 443, 'udp'),
            ('wrong-proxy-port', 'proxy', '10.77.11.2', 3129, 'tcp'),
        ]
        for source in ('client', 'proxy'):
            for name, target, address, port, protocol in targets:
                observed = rpc(source, {'op': protocol, 'address': address, 'port': port})
                require(observed['ok'], 'before-policy canary unreachable: ' + source + '/' + name + '/' + json.dumps(observed))
        result['allCanariesInitiallyReachable'] = True
        isolated()
        command(['/usr/sbin/nft', '--check', '--file', str(ROOT / 'fixture.nft')])
        command(['/usr/sbin/nft', '--file', str(ROOT / 'fixture.nft')])
        result['rulesInstalledInOriginalPrivateNamespace'] = os.stat('/proc/self/ns/net').st_ino == original_ns
        for source in ('client', 'proxy'):
            for name, target, address, port, protocol in targets:
                # A connection from proxy to its own local listener cannot cross the router.
                if source == 'proxy' and target == 'proxy':
                    continue
                before = rpc(target, {'op': 'counts'})[protocol]
                answer = rpc(source, {'op': protocol, 'address': address, 'port': port})['ok']
                allowed = source == 'proxy' and name in ('public-v4', 'public-v6')
                after = rpc(target, {'op': 'counts'})[protocol]
                require(answer == allowed and after - before == int(allowed), 'kernel policy mismatch: ' + source + '/' + name)
                result['cases'].append({'source': source, 'target': name, 'allowed': allowed, 'targetRequests': after - before})
        require(rpc('client', {'op': 'hold'})['ok'], 'allowed client-to-proxy connection failed')
        before = rpc('proxy', {'op': 'counts'})['tcp']
        isolated()
        command(['/usr/sbin/nft', 'flush', 'chain', 'inet', 'openbot_fixture', 'admitted'])
        require(not rpc('client', {'op': 'pulse'})['ok'], 'old connection survived packet revoke')
        require(rpc('proxy', {'op': 'counts'})['tcp'] == before, 'revoked connection still reached target')
        result['originalConnectionRevoked'] = True
        result['accepted'] = True
    except Exception as error:
        result['failure'] = {'type': type(error).__name__, 'message': str(error)[:512]}
    finally:
        for child in reversed(children):
            if child.poll() is None:
                child.kill()
            child.wait(timeout=3)
        result['ownedChildrenReaped'] = all(child.poll() is not None for child in children)
        output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result), flush=True)
    require(result['accepted'] and result['ownedChildrenReaped'], 'native kernel fixture failed')


if __name__ == '__main__':
    isolated()
    if sys.argv[1:] == ['run']:
        run()
    elif len(sys.argv) == 3 and sys.argv[1] == 'service' and sys.argv[2] in ROLES:
        start_services(sys.argv[2])
        threading.Event().wait(145)
    else:
        raise SystemExit('fixed run or service mode required')
