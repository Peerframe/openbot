"""Prepare one disposable Ubuntu CI packet from reviewed native algorithms and public inputs.

Never installs a daemon/runtime into the host. Image transport hashes and fresh fixture identities
are rebound only in root-private copies; reviewed image content and native enforcement stay pinned.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tarfile
from urllib.request import urlopen

REPOSITORY=Path(__file__).resolve().parents[2]
HERE=REPOSITORY/'experiments/work-journey'
LINUX=REPOSITORY/'experiments/linux-execution'
BROWSER=REPOSITORY/'experiments/browser-execution'
BASE=Path('/opt/obp4')
PACKET=BASE/'composition-20260926-a1'
DOCKER_ARCHIVE=('https://download.docker.com/linux/static/stable/x86_64/docker-29.8.1.tgz','d8db66739d2e28d4933786d73e918d9be643a67fbd835db1bf740d650a259e70',86055881)
GVISOR_ARCHIVE=('https://github.com/google/gvisor/releases/download/release-20260914.0/gvisor-x86_64.tar.bz2','94a1b9716797efcb0b348fc3283ddaa1ee5c7898b61eeccb08ee9ac7dc903c15',166025232)
NSS_ARCHIVE=('https://archive.ubuntu.com/ubuntu/pool/main/n/nss/libnss3-tools_3.98-1build1_amd64.deb','d8d6093edcf2206edeee40eaddd90a54bacc84cde4d8cc9c4fb50bd7aa12cf0d',615188)
PYTHON_IMAGE='python:3.12.13-slim-bookworm'
PYTHON_MANIFEST='sha256:6e13e65c55e33adf203d77ee371cf8bf5d81bd4902ef07565721f46bf44917af'
PYTHON_CONFIG='sha256:64d91f7b885eed272bba87909446b12ff408d4aaa5f1a0e9ca787bbea1a020b9'
CHROMIUM_IMAGE='mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e'
CHROMIUM_CONFIG='sha256:fee853fafa59550d162cef52bca02d907694b44ebf6ef9fb075bcc0c65d8dedb'
SQUID_TAG='openbot-squid77-debian-fixture:20260926'


def require(value,code):
    if not value:raise ValueError(code)


def digest(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
    return h.hexdigest()


def record(path,value):
    with path.open('x') as f:json.dump(value,f,indent=2);f.write('\n')
    path.chmod(0o600)


def copy(source,target):
    target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    require(not target.exists() and not target.is_symlink(),'packet_target_exists')
    shutil.copyfile(source,target);target.chmod(0o600)


def replace_exact(text,old,new):
    require(text.count(old)==1,'reviewed_source_shape_changed')
    return text.replace(old,new,1)


def download(target,pin):
    url,expected,maximum=pin
    with urlopen(url,timeout=120) as response,target.open('xb') as output:
        count=0
        while data:=response.read(1024*1024):
            count+=len(data);require(count<=maximum,'download_size_changed');output.write(data)
    target.chmod(0o600)
    require(count==maximum and digest(target)==expected,'download_pin_changed')


def pinned_members(archive,expected,prefix):
    seen=set()
    with tarfile.open(archive) as t:
        for member in t:
            if prefix and not member.name.startswith(prefix):continue
            name=member.name.removeprefix(prefix)
            pin=expected.get(name)
            if pin is None:continue
            require(name not in seen and member.isfile() and 0<member.size<=120*1024**2,'binary_archive_type_changed')
            data=t.extractfile(member).read(member.size+1)
            require(len(data)==member.size and hashlib.sha256(data).hexdigest()==pin,'binary_pin_changed')
            seen.add(name);yield name,data


def run(argv,timeout=600):
    return subprocess.check_output([str(v) for v in argv],timeout=timeout,env={
        'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8','HOME':'/root','DOCKER_BUILDKIT':'1'})


def oci_identity(path,expected=None,manifest=None):
    with tarfile.open(path) as archive:
        def blob(name,descriptor=None):
            member=archive.getmember(name)
            require(member.isfile() and 0<member.size<=256*1024,'oci_metadata_type_changed')
            raw=archive.extractfile(member).read(member.size+1)
            require(len(raw)==member.size,'oci_metadata_size_changed')
            if descriptor:
                require(descriptor['digest']=='sha256:'+hashlib.sha256(raw).hexdigest()
                    and descriptor['size']==member.size,'oci_metadata_pin_changed')
            return json.loads(raw)
        index=blob('index.json');require(len(index['manifests'])==1,'oci_single_image_required')
        descriptor=index['manifests'][0]
        if manifest:require(descriptor['digest']==manifest,'reviewed_image_manifest_changed')
        image=blob('blobs/sha256/'+descriptor['digest'].removeprefix('sha256:'),descriptor)
        configuration=image['config']
        if expected:require(configuration['digest']==expected,'reviewed_image_content_changed')
        config=blob('blobs/sha256/'+configuration['digest'].removeprefix('sha256:'),configuration)
        require(config['architecture']=='amd64' and config['os']=='linux','image_platform_changed')
        return dict(manifest=descriptor['digest'],config=configuration['digest'],diffIds=config['rootfs']['diff_ids'])


def export_image(image,path,expected=None,manifest=None,*,daemon=False):
    immutable=image+'@'+manifest if manifest else image
    source='docker-daemon:'+image if daemon else 'docker://'+immutable
    # The legacy Docker save format drops registry digests. OCI copying preserves the original
    # manifest that the native no-pull preflight independently requires after offline load.
    flags=['--dest-oci-accept-uncompressed-layers'] if daemon else ['--preserve-digests']
    run(['/usr/bin/skopeo','--override-os','linux','--override-arch','amd64','copy',
        '--src-no-creds','--src-tls-verify=true',*flags,source,'oci-archive:'+str(path)])
    path.chmod(0o600)
    return dict(image=image,**oci_identity(path,expected,manifest),archiveSha256=digest(path),archiveBytes=path.stat().st_size)


def files(root):
    result=[]
    for p in sorted(root.rglob('*')):
        if p.is_symlink():require(p.resolve().is_relative_to(root),'external_packet_symlink');continue
        if p.is_file():result.append(dict(path=str(p.relative_to(root)),bytes=p.stat().st_size,sha256=digest(p)))
    return result


def worker_site(worker):
    # Resolving venv/bin/python loses the venv prefix and selects the system interpreter.
    worker=worker.absolute()
    require(worker.parent.name=='bin' and (worker.parent.parent/'pyvenv.cfg').is_file(),'explicit_worker_venv_required')
    matches=list(worker.parent.parent.glob('lib/python3.12/site-packages'))
    require(len(matches)==1 and matches[0].is_dir(),'worker_closure_missing')
    return matches[0]


def prepare(worker,upstream,bun,node,bundle,output):
    require(sys.platform=='linux' and os.geteuid()==0 and os.uname().machine=='x86_64'
        and os.environ.get('GITHUB_ACTIONS')=='true','disposable_linux_ci_only')
    require('VERSION_ID="24.04"' in Path('/etc/os-release').read_text(),'ubuntu_24_04_required')
    require(not BASE.exists() and not BASE.is_symlink() and not output.exists(),'fresh_ci_packet_required')
    os.umask(0o077);BASE.mkdir(mode=0o700)
    for path in ('bin','bin/gvisor-bin','downloads','units','case','case/source','case/python','deps','command','command/docker-config'):
        (BASE/path).mkdir(mode=0o700)
    PACKET.mkdir(mode=0o700)
    sys.path[:0]=[str(LINUX),str(HERE),str(REPOSITORY/'apps/server-python/src')]
    from protected_native import REVIEWED_BINARY_HASHES,SOURCES
    from product_browser_upstream import verify,LOOPBACK,ORIGINAL
    verify(upstream)
    browser_pins={'deadline_probe.py':'ef19d46fd24bc5512ae880bcc895da8639f0d895e22347edf832d0a1a7950bb4','sandbox.py':'5859262340afb15ca7ac3153a586dbc96339fc71576fa4cd1a01151423fa7465','output_capacity.py':'1d25ff9f64ff1110d555c1431a0d1cfcf023c6338cd949b38fb88a79ed794ab6'}
    for name,expected in browser_pins.items():require(digest(LINUX/name)==expected,'reviewed_browser_helper_changed')
    require(digest(BROWSER/'seccomp_profile.json')=='d00ad84f5a67031fe2bb64de8d77a5ad9c06adb82935ebdb3c18b5f7ba60a5d0','reviewed_seccomp_changed')
    require(run([bun,'--version']).strip()==b'1.3.14','reviewed_bun_version_changed')
    require(run(['/usr/bin/dpkg-query','-W','-f=${Version}','skopeo']).strip()==b'1.13.3+ds1-2ubuntu0.24.04.3','reviewed_skopeo_package_changed')
    for filename,pin in (('docker.tgz',DOCKER_ARCHIVE),('gvisor.tar.bz2',GVISOR_ARCHIVE),('nss.deb',NSS_ARCHIVE)):
        download(BASE/'downloads'/filename,pin)
    extra={'containerd-shim-runc-v2':'60a23e7d1d8f60b2f7ae8046cd656066c9dea065c3e0da3ce61cf2fdf173afd3','docker-init':'5ccb076690ac3d060511c63d02194bd5cefaba8dbf225fd60b26283eb1055e4b'}
    for archive,prefix in ((BASE/'downloads/docker.tgz','docker/'),(BASE/'downloads/gvisor.tar.bz2','')):
        for name,data in pinned_members(archive,{**REVIEWED_BINARY_HASHES,**extra},prefix):
            target=BASE/'bin'/name;target.write_bytes(data);target.chmod(0o755)
    for name,expected in {**REVIEWED_BINARY_HASHES,**extra}.items():require(digest(BASE/'bin'/name)==expected,'binary_missing')
    python=export_image(PYTHON_IMAGE,BASE/'downloads/python-amd64.tar',PYTHON_CONFIG,PYTHON_MANIFEST)
    chromium=export_image(CHROMIUM_IMAGE,BASE/'downloads/playwright-1.62.1-linux-amd64.tar',CHROMIUM_CONFIG)
    run(['/usr/bin/docker','build','--platform','linux/amd64','--tag',SQUID_TAG,'--file',BROWSER/'egress-fixture.Dockerfile',BROWSER],timeout=600)
    # The same Dockerfile, base digests, signed snapshot and exact packages bind this rebuilt image.
    squid_pin=export_image(SQUID_TAG,PACKET/'squid-image.tar',daemon=True)
    for name in (*SOURCES,'protected_host.py','product_host_fixture.py'):
        copy(HERE/name if name=='product_host_fixture.py' else LINUX/name,BASE/'case/source'/name)
    source=BASE/'case/source/deadline_probe.py'
    source.write_text(replace_exact(source.read_text(),'ARCHIVE_SHA = "b6a087a833e6d00409197b8ba06071a1890df84eb52b770b757f092b7d2e8788"','ARCHIVE_SHA = '+json.dumps(python['archiveSha256'])))
    shutil.copytree(REPOSITORY/'apps/server-python/src/openbot_server',BASE/'case/python/openbot_server',ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
    site=worker_site(worker)
    shutil.copytree(site,BASE/'deps',dirs_exist_ok=True,ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
    for p in [BASE/'deps',BASE/'case/python',*(BASE/'deps').rglob('*'),*(BASE/'case/python').rglob('*')]:
        if not p.is_symlink():p.chmod(0o755 if p.is_dir() else 0o644)
    paths=[str(BASE/'case/source'),str(BASE/'case/python'),str(BASE/'deps'),str(PACKET)]
    for name in ('run_probe.py','network_probe.py'):copy(BROWSER/'native-network'/name,PACKET/name)
    require(not Path('/opt/oc25').exists() and not Path('/opt/oc25p').exists() and not Path('/opt/oc25n').exists() and not Path('/run/oc25').exists(),'command_paths_occupied')
    Path('/opt/oc25').mkdir(mode=0o700);Path('/opt/oc25n').mkdir(mode=0o755);Path('/run/oc25').mkdir(mode=0o750)
    Path('/opt/oc25n').chmod(0o755);Path('/run/oc25').chmod(0o750);os.chown('/run/oc25',0,62425)
    require(run([node,'--version']).strip()==b'v22.22.2','reviewed_node_version_changed')
    copy(node,Path('/opt/oc25n/node'));Path('/opt/oc25n/node').chmod(0o755)
    copy(bundle,BASE/'command/product-command-node.cjs')
    copy(HERE/'product_command_native_host.py',BASE/'command/product_host_fixture.py')
    config=dict(base='/opt/oc25',binaries=str(BASE/'bin'),archive=str(BASE/'downloads/python-amd64.tar'),
        archiveSha256=python['archiveSha256'],image='python@'+PYTHON_MANIFEST,imageTag=PYTHON_IMAGE,sources=str(BASE/'case/source'),
        sourceHashes={name:digest(BASE/'case/source'/name) for name in SOURCES},binaryHashes=REVIEWED_BINARY_HASHES,
        python='/usr/bin/python3.12',pythonPath=paths,secretsDirectory=str(BASE/'command/secrets'))
    record(BASE/'case/config.json',dict(state=str(BASE/'command/state'),socket='/run/oc25/command.sock',nodeUid=62425,nodeGid=62425,
        native=config,route={},policy={},controlIssuer='product-control',enforcementIssuer='product-enforcer',privateKey='',controlPins=[]))
    record(BASE/'MANIFEST.json',{'relay/node':digest('/opt/oc25n/node')})
    copy(HERE/'p4_native_browser.py',BASE/'browser_launcher.py')
    # Native browser gets the original interface listener inside its isolated network only.
    shutil.copytree(upstream,PACKET/'api',ignore=shutil.ignore_patterns('__pycache__','.git'))
    index=PACKET/'api/src/index.ts';require(index.read_bytes().count(LOOPBACK)==1,'upstream_listener_shape_changed');index.write_bytes(index.read_bytes().replace(LOOPBACK,ORIGINAL,1))
    for p in [PACKET/'api',*(PACKET/'api').rglob('*')]:
        if not p.is_symlink():p.chmod(0o755 if p.is_dir() else 0o644)
    copy(bun,PACKET/'bun');(PACKET/'bun').chmod(0o755)
    for p in (BROWSER/'composition').iterdir():
        if p.suffix in ('.py','.mjs','.nft'):copy(p,PACKET/p.name)
    copy(BROWSER/'egress_policy.py',PACKET/'egress_policy.py')
    copy(BROWSER/'browser_a1.py',PACKET/'browser_a1.py');copy(BROWSER/'seccomp_profile.json',PACKET/'seccomp_profile.json')
    reviewed=PACKET/'reviewed';reviewed.mkdir(mode=0o700)
    for name in ('deadline_probe.py','sandbox.py','output_capacity.py'):
        copy(LINUX/name,reviewed/name)
    deadline=reviewed/'deadline_probe.py'
    deadline.write_text(replace_exact(deadline.read_text(),'BASE = Path("/opt/openbot-qualification-20260925-c8b2")','BASE = Path("/opt/obp4")'))
    browser=PACKET/'browser_a1.py'
    text=browser.read_text()
    text=replace_exact(text,'ARCHIVE_SHA = "3f40f8c47fb570b8236014eda17d49d5020a5d9bc01a4a49606471cc82288f89"','ARCHIVE_SHA = '+json.dumps(chromium['archiveSha256']))
    text=replace_exact(text,'ARCHIVE_BYTES = 949432320','ARCHIVE_BYTES = '+str(chromium['archiveBytes']))
    text=replace_exact(text,'ef19d46fd24bc5512ae880bcc895da8639f0d895e22347edf832d0a1a7950bb4',digest(deadline));browser.write_text(text)
    identity='deadline-a1-p4'+secrets.token_hex(3)
    program=PACKET/'run.py';text=program.read_text()
    for old,new in (('deadline-a1-comp5',identity),('7d636842c8633beeaf30c512b6b022693cf1120b563c842dfc4bbc6d9441632e',squid_pin['archiveSha256']),('sha256:5b3968c26dd7b5cd7fdb69ecf90a85c277848993d613ee0fd01efa475892c671',squid_pin['config']),('sha256:fad04b80804e8de9228ddf78229712edb21ef86eb218c4d77de8dad1f1a74b8f',squid_pin['manifest']),('a8f9ebd1770ddc8e55dab7a68d4ec1ec1eebf374bb97cc65cf2c3cb373fc6791',digest(bun))):text=replace_exact(text,old,new)
    program.write_text(text)
    companion=PACKET/'companion.py';companion.write_text(replace_exact(companion.read_text(),'/opt/openbot-qualification-20260925-c8b2/units','/opt/obp4/units'))
    copy(BROWSER/'native-network/run_probe.py',PACKET/'snapshot.py')
    snapshot=PACKET/'snapshot.py';snapshot.write_text(replace_exact(snapshot.read_text(),'/opt/openbot-qualification-20260925-c8b2/bin/docker',str(BASE/'bin/docker')))
    # Generate only a disposable CA and NSS database; no host/personal trust is read or installed.
    run([worker,'-B',PACKET/'prepare_tls.py','--output',PACKET/'tls'])
    nss=BASE/'nss-tools';run(['/usr/bin/dpkg-deb','--extract',BASE/'downloads/nss.deb',nss])
    (PACKET/'nssdb').mkdir(mode=0o755)
    certutil=nss/'usr/bin/certutil'
    run([certutil,'-N','-d','sql:'+str(PACKET/'nssdb'),'--empty-password'])
    run([certutil,'-A','-d','sql:'+str(PACKET/'nssdb'),'-n','OpenBot disposable fixture CA','-t','C,,','-i',PACKET/'tls/ca.pem'])
    (PACKET/'nssdb').chmod(0o755)
    for p in (PACKET/'nssdb').iterdir():p.chmod(0o644)
    for name in ('socket_probe.mjs','tunnel_probe.mjs','browser-entry.mjs'):(PACKET/name).chmod(0o644)
    record(PACKET/'FILES.json',files(PACKET))
    command_files=[]
    for root in (BASE/'case/source',BASE/'case/python'):
        for p in root.rglob('*'):
            if p.is_file() and not p.is_symlink():command_files.append(dict(path=str(p),sha256=digest(p)))
    for p in (BASE/'command/product_host_fixture.py',BASE/'case/config.json',BASE/'command/product-command-node.cjs',Path('/opt/oc25n/node'),BASE/'MANIFEST.json'):
        command_files.append(dict(path=str(p),sha256=digest(p)))
    plan=dict(version=1,fixtureEnvironment='disposable-github-linux',pythonPath=paths,commandFiles=command_files,
        nativeRoot=str(BASE/'units'/identity),browserProgram=str(program),packet=str(PACKET),
        reviewedBinaries=REVIEWED_BINARY_HASHES,python=python,chromium=chromium,squid=squid_pin,bunSha256=digest(bun),
        packagingAdaptations=['fresh native root','offline export hash bound to reviewed image config/layers','root-private source copies','Bun 1.3.14 from existing CI','original browser listener only inside private network','new synthetic TLS CA/NSS database'])
    record(BASE/'PLAN.json',plan)
    record(output,{'version':1,'program':str(BASE/'command/product_host_fixture.py')})
    print(json.dumps(dict(nativePacketReady=True,fixtureEnvironment=plan['fixtureEnvironment'],rootFresh=True,imageContentPinned=True,binariesPinned=True)))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for flag in ('worker','upstream','bun','node','node-bundle','output'):parser.add_argument('--'+flag,type=Path,required=True)
    args=parser.parse_args()
    prepare(args.worker.absolute(),args.upstream.resolve(),args.bun.resolve(),args.node.resolve(),args.node_bundle.resolve(),args.output.resolve())
