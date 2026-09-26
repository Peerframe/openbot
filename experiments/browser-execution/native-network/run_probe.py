"""Single-use launcher for the fixed private-namespace kernel fixture."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

from network_probe import ENV, ROOT, UNIT, require

DOCKER = '/opt/openbot-qualification-20260925-c8b2/bin/docker'


def read(argv, timeout=10):
    return subprocess.check_output(argv, env=ENV, timeout=timeout, stderr=subprocess.PIPE)


def snapshot():
    args = [DOCKER, '--config', str(ROOT / 'docker-config'), '--host', 'unix:///var/run/docker.sock']
    identities = sorted(read(args + ['ps', '--no-trunc', '--format', '{{.ID}}']).decode().split())
    require(all(re.fullmatch(r'[a-f0-9]{64}', identity) for identity in identities), 'invalid production container identity')
    containers = []
    for identity in identities:
        # Inspect only explicitly selected status fields, never env/config/credentials.
        shape = '{"id":{{json .Id}},"startedAt":{{json .State.StartedAt}},"status":{{json .State.Status}},"restarts":{{json .RestartCount}}}'
        containers.append(json.loads(read(args + ['inspect', '--format', shape, identity])))
    firewall = {}
    for binary in ('iptables-save', 'ip6tables-save', 'iptables-legacy-save', 'ip6tables-legacy-save'):
        text = read(['/usr/sbin/' + binary]).decode()
        text = '\n'.join(line for line in text.splitlines() if not line.startswith('#'))
        text = re.sub(r'\[\d+:\d+\]', '[0:0]', text)
        firewall[binary] = hashlib.sha256(text.encode()).hexdigest()
    nft = json.loads(read(['/usr/sbin/nft', '--json', 'list', 'ruleset']))
    def strip(value):
        if isinstance(value, dict):
            return {key: strip(item) for key, item in value.items() if key not in ('packets', 'bytes', 'metainfo')}
        if isinstance(value, list):
            return [strip(item) for item in value]
        return value
    firewall['nft'] = hashlib.sha256(json.dumps(strip(nft), sort_keys=True).encode()).hexdigest()
    sysctl = {name: Path('/proc/sys/net/' + name).read_text() for name in
              ('ipv4/ip_forward', 'ipv6/conf/all/forwarding')}
    return {'containers': containers, 'firewall': firewall, 'sysctl': sysctl}


def main():
    global DOCKER
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--docker', choices=(DOCKER, '/usr/bin/docker'), default=DOCKER,
                        help='Snapshot-only CLI: reviewed qualification host or disposable CI runner')
    DOCKER = parser.parse_args().docker
    require(os.geteuid() == 0 and ROOT.resolve() == ROOT and ROOT.is_dir(), 'exact root-owned fixture required')
    require(ROOT.stat().st_uid == 0 and ROOT.stat().st_mode & 0o077 == 0, 'private fixture directory required')
    require(os.stat('/proc/self/ns/net').st_ino == os.stat('/proc/1/ns/net').st_ino, 'launcher must observe the original host')
    require(not (ROOT / 'STARTED').exists(), 'single-use fixture is consumed')
    require(read(['/usr/bin/systemctl', 'show', UNIT, '--property=LoadState', '--value']).strip() == b'not-found', 'unit already exists')
    (ROOT / 'docker-config').mkdir(mode=0o700)
    before = snapshot()
    with (ROOT / 'STARTED').open('x') as stream:
        stream.write('single-use kernel routing qualification\n')
    properties = {'PrivateNetwork': 'yes', 'PrivateMounts': 'yes', 'RuntimeMaxSec': '150',
                  'RuntimeRandomizedExtraSec': '0', 'TimeoutStopSec': '1', 'KillMode': 'control-group',
                  'KillSignal': 'SIGKILL', 'FinalKillSignal': 'SIGKILL', 'SendSIGKILL': 'yes',
                  'Restart': 'no', 'MemoryMax': '256M', 'MemorySwapMax': '0', 'CPUQuota': '100%', 'TasksMax': '160'}
    argv = ['/usr/bin/systemd-run', '--unit=' + UNIT, '--service-type=exec', '--wait', '--pipe',
            *['--property=' + key + '=' + value for key, value in properties.items()],
            '/usr/bin/python3', '-B', str(ROOT / 'network_probe.py'), 'run']
    try:
        with (ROOT / 'RUN.log').open('x') as log:
            completed = subprocess.run(argv, env=ENV, stdout=log, stderr=subprocess.STDOUT, timeout=165)
    finally:
        # Only the new unique unit is stopped; the original native deadline is never renewed.
        subprocess.run(['/usr/bin/systemctl', 'stop', UNIT], env=ENV, capture_output=True, timeout=10)
    state = read(['/usr/bin/systemctl', 'show', UNIT, '--property=ActiveState,MainPID']).decode()
    require('ActiveState=active' not in state and 'MainPID=0' in state, 'owned native unit is still active')
    group = Path('/sys/fs/cgroup/system.slice') / UNIT
    require(not group.exists() or all(not p.read_text().strip() for p in group.rglob('cgroup.procs')),
            'owned cgroup still has processes')
    after = snapshot()
    require(before == after, 'production container/firewall/sysctl state changed')
    result = json.loads((ROOT / 'RESULT.json').read_text()) if (ROOT / 'RESULT.json').exists() else {'accepted': False}
    result.update(nativeUnitClosed=True, productionUnchanged=True, existingContainerCount=len(before['containers']),
                  launcherExit=completed.returncode)
    result['sourceSha256'] = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                             for name in ('network_probe.py', 'run_probe.py', 'fixture.nft')}
    result['accepted'] = result.get('accepted') is True and completed.returncode == 0
    (ROOT / 'FINAL_RESULT.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
    require(result['accepted'], 'native kernel test failed; inspect owned RUN.log')


if __name__ == '__main__':
    main()
