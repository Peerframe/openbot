"""Fetch and verify the reviewed public source; no personal settings or authentication."""
import argparse
import hashlib
import json
from pathlib import Path
from time import sleep
from urllib.error import HTTPError
from urllib.request import urlopen

HERE=Path(__file__).resolve().parent
MANIFEST=json.loads((HERE/'product-browser-upstream.json').read_text())
ORIGINAL=b'  port: PORT,'
LOOPBACK=b'  hostname: "127.0.0.1",\n  port: PORT,'


def verify(root):
    for entry in MANIFEST['files']:
        content=(root/entry['path']).read_bytes()
        if entry['path']=='src/index.ts':
            if content.count(LOOPBACK)!=1:raise ValueError('Expected loopback-only upstream patch')
            content=content.replace(LOOPBACK,ORIGINAL,1)
        if len(content)!=entry['bytes'] or hashlib.sha256(content).hexdigest()!=entry['sha256']:
            raise ValueError('Pinned browser fixture source mismatch: '+entry['path'])
    for name in ('package.json','package-lock.json'):
        if (root/name).read_bytes()!=(HERE/('browser-fixture-'+name)).read_bytes():
            raise ValueError('Browser fixture dependencies changed')


def prepare(root):
    root.mkdir(mode=0o700)
    for entry in MANIFEST['files']:
        relative=entry['path'] if entry['path']=='LICENSE' else 'agent-computer/'+entry['path']
        url='https://raw.githubusercontent.com/'+MANIFEST['repository']+'/'+MANIFEST['commit']+'/'+relative
        for attempt in range(3):
            try:
                with urlopen(url,timeout=30) as response:content=response.read(entry['bytes']+1)
            except HTTPError as error:
                if not 500 <= error.code < 600 or attempt == 2:raise
                if error.fp is not None:error.close()
            except OSError:
                if attempt == 2:raise
            else:
                break
            sleep(attempt+1)
        # Integrity failures must never trigger another download.
        if len(content)!=entry['bytes'] or hashlib.sha256(content).hexdigest()!=entry['sha256']:
            raise ValueError('Public upstream hash mismatch: '+entry['path'])
        if entry['path']=='src/index.ts':
            if content.count(ORIGINAL)!=1:raise ValueError('Unexpected listener shape')
            content=content.replace(ORIGINAL,LOOPBACK,1)
        target=root/entry['path'];target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes(content)
    for name in ('package.json','package-lock.json'):
        (root/name).write_bytes((HERE/('browser-fixture-'+name)).read_bytes())
    verify(root)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory',type=Path)
    parser.add_argument('--verify',action='store_true')
    args=parser.parse_args()
    (verify if args.verify else prepare)(args.directory.resolve())
