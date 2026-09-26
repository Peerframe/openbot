"""Single-use native browser/proxy composition. No production daemon, routes or credentials."""
from __future__ import annotations
import argparse, hashlib, http.client, json, os, shutil, socket, stat, subprocess, sys, time
from dataclasses import asdict
import uuid
from pathlib import Path
HERE=Path(__file__).resolve().parent
sys.path[:0]=[str(HERE/'reviewed'),str(HERE),str(HERE.parent),str(HERE.parent.parent/'linux-execution')]
import deadline_probe as native
import browser_a1 as browser
from egress_policy import compile_egress_policy
SNAPSHOT_DIRECTORY=HERE if (HERE/'snapshot.py').is_file() else HERE.parent/'native-network'
sys.path.insert(0,str(SNAPSHOT_DIRECTORY))
if (HERE/'snapshot.py').is_file():
    import snapshot as snapshot_module
else:
    import run_probe as snapshot_module
BASE=native.BASE
ROOT=BASE/'units/deadline-a1-comp5'
PACKET=BASE/'composition-20260926-a1'
UNIT=native.unit_name(ROOT)
WALL=600
TOKEN='synthetic-linux-composition-fixture-only'
SQUID_ARCHIVE_SHA='7d636842c8633beeaf30c512b6b022693cf1120b563c842dfc4bbc6d9441632e'
SQUID_CONFIG='sha256:5b3968c26dd7b5cd7fdb69ecf90a85c277848993d613ee0fd01efa475892c671'
SQUID_MANIFEST='sha256:fad04b80804e8de9228ddf78229712edb21ef86eb218c4d77de8dad1f1a74b8f'
require=native.require


def receipt(name,value):native.durable(ROOT/name,value)


def original():
    value=native.show(UNIT)
    armed=native.read_json(ROOT/'native.json')
    require(value.get('InvocationID')==armed['invocation'] and value.get('ActiveState')=='active','original native lifetime closed')
    require(time.monotonic()<armed['deadline']-10,'native lifetime exhausted')
    pid=int(value['MainPID'])
    require(pid==armed['pid'] and os.stat(f'/proc/{pid}/ns/net').st_ino==armed['netns'],'original namespace changed')
    require(os.stat(f'/proc/{pid}/ns/net').st_ino!=os.stat('/proc/1/ns/net').st_ino,'host namespace forbidden')
    return value


def inside(*argv):
    pid=original()['MainPID']
    return native.command(['/usr/bin/nsenter','--target',str(pid),'--net','--mount',*argv])


def docker(*argv,timeout=15):
    original()
    cli=native.docker(ROOT)
    result=cli.commander.run(argv,timeout=timeout)
    receipt('commands/'+uuid.uuid4().hex+'.json',{'arguments':argv,'result':asdict(result)})
    require(result.ok,'private Docker command failed: '+str(argv[:2]))
    return result.stdout.strip()


def loaded_browser_image(cli):
    image=cli.image_inspect(browser.MANIFEST)
    if image is None:image=cli.image_inspect(browser.CONFIG)
    require(image is not None,'reviewed offline Chromium not found')
    browser.validate_image(image)
    return image


def inspect(identity):return json.loads(docker('inspect',identity))[0]


def relay(name,path,body=None):
    original()
    connection=http.client.HTTPConnection('owned-fixture',timeout=30)
    connection.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);connection.sock.settimeout(30)
    connection.sock.connect(str(ROOT/(name+'.sock')))
    try:
        headers={'Authorization':'Bearer '+TOKEN,'x-openbot-bot-id':'qualification-check'}
        if body is not None:headers['Content-Type']='application/json'
        connection.request('GET' if body is None else 'POST',path,None if body is None else json.dumps(body),headers)
        response=connection.getresponse();raw=response.read(1024*1024+1)
        require(len(raw)<=1024*1024,'bounded response exceeded')
        return response.status,json.loads(raw)
    finally:connection.close()


def daemon():
    native.check_root(ROOT)
    subprocess.Popen(['/usr/bin/python3','-B',str(PACKET/'companion.py'),'companion','--root',str(ROOT)],env=native.ENV)
    native.wait_until(lambda:(ROOT/'companion-ready.json').exists(),time.monotonic()+8,'owned companion')
    native.daemon_main(ROOT)


def common(name,network,address,memory):
    return ['create','--pull=never','--name',name,'--runtime','runsc','--restart','no','--network',network,
            '--ip',address,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges=true',
            '--ipc','private','--init','--memory',memory,'--memory-swap',memory,'--cpus','1.5',
            '--pids-limit','1536','--ulimit','nproc=256:256','--ulimit','nofile=4096:4096',
            '--log-driver','local','--log-opt','max-size=1m','--log-opt','max-file=1','--log-opt','compress=false']


def browser_create(index):
    require(index in (1,2),'two declared browser instances only')
    argv=common('composition-browser-'+str(index),'composition-client','10.77.10.2','1536m')
    argv+=['--ip6','fd77:10::2','--user','1001:1001','--shm-size','256m',
           '--security-opt','seccomp='+str(PACKET/'seccomp_profile.json'),
           '--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=256m,uid=1001,gid=1001,mode=700',
           '--mount','type=bind,src='+str(PACKET/'api')+',dst=/service,readonly',
           '--mount','type=bind,src='+str(PACKET/'bun')+',dst=/usr/local/bin/bun,readonly',
           '--mount','type=bind,src='+str(PACKET/'socket_probe.mjs')+',dst=/socket_probe.mjs,readonly',
           '--mount','type=bind,src='+str(PACKET/'tunnel_probe.mjs')+',dst=/tunnel_probe.mjs,readonly',
           '--mount','type=bind,src='+str(ROOT/'profiles')+',dst=/profiles',
           '--mount','type=bind,src='+str(PACKET/'nssdb')+',dst=/fixture-trust,readonly',
           '--mount','type=bind,src='+str(PACKET/'browser-entry.mjs')+',dst=/browser-entry.mjs,readonly',
           '--workdir','/service','--env','HOME=/tmp','--env','LANG=C.UTF-8','--env','PORT=4100',
           '--env','COMPUTER_TOKEN='+TOKEN,'--env','COMPUTER_SANDBOX=on','--env','COMPUTER_MAX_BROWSERS=2',
           '--env','PROFILES_DIR=/profiles','--env','WORKSPACE_DIR=/tmp/workspace',
           '--env','EGRESS_PROXY_DEFAULT=http://10.77.11.2:3128','--env','NAVIGATION_TIMEOUT_MS=15000',
           '--env','ACTION_TIMEOUT_MS=5000','--env','PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
           '--entrypoint','/usr/local/bin/bun',native.read_json(ROOT/'browser-image.json')['Id'],'/browser-entry.mjs']
    receipt('browser-'+str(index)+'-create-reserved.json',{'index':index})
    identity=docker(*argv);require(len(identity)==64 and all(c in '0123456789abcdef' for c in identity),'container identity')
    value=inspect(identity);host=value['HostConfig']
    require(host['Runtime']=='runsc' and not host['Privileged'] and host['ReadonlyRootfs'] and host['CapDrop']==['ALL'] and not host['PortBindings'],'container isolation differs')
    require(value['Config']['User']=='1001:1001' and host['Memory']==1536*1024**2 and host['MemorySwap']==host['Memory'],'resource boundary differs')
    require(set(value['NetworkSettings']['Networks'])=={'composition-client'},'unexpected network attachment')
    mounts=value['Mounts'];binds=[m for m in mounts if m['Type']=='bind']
    require(len(binds)==7 and {m['Destination'] for m in binds}=={'/service','/usr/local/bin/bun','/socket_probe.mjs','/tunnel_probe.mjs','/profiles','/fixture-trust','/browser-entry.mjs'} and [m['Destination'] for m in binds if m['RW']]==['/profiles'],'private input/profile mounts differ')
    require(set(host['Tmpfs'])=={'/tmp'},'temporary mount differs')
    seccomp=[v for v in host['SecurityOpt'] if v.startswith('seccomp=')]
    require(len(seccomp)==1 and json.loads(seccomp[0][8:])==json.loads((PACKET/'seccomp_profile.json').read_text()),'OCI seccomp changed')
    receipt('browser-'+str(index)+'-created.json',value)
    receipt('browser-'+str(index)+'-start-reserved.json',{'id':identity})
    docker('start',identity,timeout=15)
    def ready():
        try:return relay('control','/health')[0]==200
        except (OSError,ValueError,http.client.HTTPException):return False
    native.wait_until(ready,time.monotonic()+25,'actual Bun browser service')
    group=Path('/sys/fs/cgroup/system.slice')/UNIT
    members=native.cgroup_members(group)
    args=browser.runtime_arguments(group,members)
    browser.validate_runtime_arguments({'processes':[v for v in args['processes'] if v['argv'][-1:]==[identity]],'errors':args['errors']},identity)
    receipt('browser-'+str(index)+'-runtime.json',{'members':members,'arguments':args})
    return identity


def restart():
    original();require((ROOT/'ready.json').is_file(),'original readiness required')
    require(not (ROOT/'restart-reserved.json').exists(),'single replacement consumed')
    before=native.read_json(ROOT/'ready.json')['browserId'];receipt('restart-reserved.json',{'old':before})
    docker('stop','--time','12',before,timeout=15)
    old=inspect(before)
    require(old['State']['Running'] is False and old['State']['ExitCode']==0 and not old['State']['OOMKilled'],'original browser did not close gracefully')
    # Removing the stopped endpoint frees the exact private address; no old process can coexist.
    docker('rm',before)
    after=browser_create(2);require(after!=before,'container identity reused')
    result={'oldContainerExited':True,'oldExitCode':0,'newContainer':True,'samePrivateProfile':True}
    receipt('replacement.json',result);print(json.dumps(result),flush=True)


def snapshot():
    # Reuse the accepted native snapshot-only observer, with this owned configuration directory.
    snapshot_module.ROOT=ROOT
    return snapshot_module.snapshot()


def close_failed_original(armed):
    value=native.show(UNIT)
    require(value.get('InvocationID')==armed['invocation'] and value.get('NRestarts')=='0','cleanup identity changed')
    group=Path('/sys/fs/cgroup')/armed['group'].lstrip('/')
    require(not group.exists() or group.stat().st_ino==armed['inode'],'cleanup cgroup changed')
    receipt('failed-unit-before-stop.json',value)
    native.command(['/usr/bin/systemctl','stop',UNIT],timeout=12)
    def empty():
        require(not group.exists() or group.stat().st_ino==armed['inode'],'failed cgroup replaced')
        return not group.exists() or not native.cgroup_members(group)
    native.wait_until(empty,time.monotonic()+8,'failed original cgroup exit')
    receipt('failed-unit-closed.json',{'originalUnitStopped':True,'cgroupEmpty':True,'nativeTimeoutClaimed':False})


def run():
    os.umask(0o077)
    require(os.geteuid()==0 and os.uname().machine=='x86_64','native Linux amd64 root required')
    require(PACKET.resolve()==PACKET and PACKET.stat().st_uid==0 and PACKET.stat().st_mode & 0o077==0,'private packet required')
    manifest=json.loads((PACKET/'FILES.json').read_text())
    for entry in manifest:
        file=PACKET/entry['path'];require(file.is_file() and not file.is_symlink() and file.stat().st_size==entry['bytes'] and native.digest(file)==entry['sha256'],'packet file changed: '+entry['path'])
    for name,expected in browser.SOURCES.items():require(native.digest(PACKET/'reviewed'/name)==expected,'native helper changed')
    require(native.digest(browser.ARCHIVE)==browser.ARCHIVE_SHA and browser.ARCHIVE.stat().st_size==browser.ARCHIVE_BYTES,'Chromium archive changed')
    require(native.digest(PACKET/'squid-image.tar')==SQUID_ARCHIVE_SHA,'Squid archive changed')
    require(native.digest(PACKET/'bun')=='a8f9ebd1770ddc8e55dab7a68d4ec1ec1eebf374bb97cc65cf2c3cb373fc6791','Bun changed')
    require(native.digest(PACKET/'seccomp_profile.json')==browser.INPUTS['seccomp_profile.json'],'seccomp changed')
    require(native.show(UNIT).get('LoadState')=='not-found','unit exists')
    browser.validate_socket_path_bounds(browser.host_socket_path_bounds(ROOT))
    ROOT.mkdir(mode=0o700)
    for name in ('source','docker-config','config','profiles','commands'):(ROOT/name).mkdir(mode=0o700)
    for name in browser.SOURCES:shutil.copyfile(PACKET/'reviewed'/name,ROOT/'source'/name)
    receipt('ownership.json',{'root':str(ROOT),'unit':UNIT,'runtimeSeconds':WALL,'case':'browser-composition'})
    receipt('packet-manifest.json',manifest)
    before=snapshot();receipt('before.json',before)
    config,containerd=browser.configurations(ROOT);receipt('config/daemon.json',config);(ROOT/'config/containerd.toml').write_text(containerd)
    policy={'listen_address':'10.77.11.2','listen_port':3128,'client_address':'10.77.10.2','origins':[{'scheme':'http','host':h,'port':18080} for h in ('example.com','ipv6.example','private.example','metadata.example','control.example')]+[{'scheme':'https','host':host,'port':port} for host,port in (('example.com',18443),('wrong.example',18443),('example.com',18444))],'forbidden_networks':['93.184.216.35/32']}
    (ROOT/'config/squid.conf').write_text(compile_egress_policy(policy));(ROOT/'config/squid.conf').chmod(0o444)
    properties=dict(native.UNIT_PROPERTIES,RuntimeMaxSec=str(WALL),MemoryMax='3072M',TasksMax='2048')
    argv=['/usr/bin/systemd-run','--unit='+UNIT,'--service-type=exec',*['--property='+k+'='+v for k,v in properties.items()],'/usr/bin/python3','-B',str(PACKET/'run.py'),'daemon']
    result={'format':'openbot-linux-browser-composition','version':1,'accepted':False,'nativeDeadlineSeconds':WALL,'publicInternetQualified':False}
    armed=None
    try:
        receipt('start-reserved.json',{'properties':properties})
        native.command(argv)
        value=native.show(UNIT);receipt('unit.json',value)
        require(value.get('ActiveState')=='active' and value.get('PrivateNetwork')=='yes' and value.get('PrivateMounts')=='yes' and value.get('NRestarts')=='0','native properties differ')
        require(native.seconds(value['RuntimeMaxUSec'])==WALL and value['MemoryMax']==str(3072*1024**2),'native bounds differ')
        deadline=int(value['ActiveEnterTimestampMonotonic'])/1000000+WALL
        group=Path('/sys/fs/cgroup')/value['ControlGroup'].lstrip('/')
        armed={'unit':UNIT,'invocation':value['InvocationID'],'deadline':deadline,'group':value['ControlGroup'],'inode':group.stat().st_ino,'pid':int(value['MainPID']),'netns':os.stat('/proc/'+value['MainPID']+'/ns/net').st_ino}
        receipt('native.json',armed)
        def ready():
            try:return json.loads(docker('info','--format','{{json .}}',timeout=2))
            except RuntimeError:return None
        info=native.wait_until(ready,min(deadline-450,time.monotonic()+20),'private Docker')
        require(info['DockerRootDir']==str(ROOT/'docker-data') and info['Containerd']['Address']==str(ROOT/'containerd.sock') and info['ServerVersion']=='29.8.1' and str(info['CgroupVersion'])=='2','private daemon differs')
        browser.validate_runtime(info)
        for name,archive in (('chromium',browser.ARCHIVE),('squid',PACKET/'squid-image.tar')):
            receipt(name+'-load-reserved.json',{'path':str(archive)})
            docker('load','--input',str(archive),timeout=110)
        chromium=loaded_browser_image(native.docker(ROOT));receipt('browser-image.json',chromium)
        squid=json.loads(docker('image','inspect','openbot-squid77-debian-fixture:20260926'))[0]
        require(squid['Id'] in (SQUID_CONFIG,SQUID_MANIFEST) and squid['Architecture']=='amd64','Squid image differs')
        for role,subnet,gateway,v6,gw6 in (('client','10.77.10.0/30','10.77.10.1','fd77:10::/64','fd77:10::1'),('proxy','10.77.11.0/30','10.77.11.1','fd77:11::/64','fd77:11::1')):
            docker('network','create','--driver','bridge','--ipv6','--subnet',subnet,'--gateway',gateway,'--subnet',v6,'--gateway',gw6,'--opt','com.docker.network.bridge.name=ob_'+role,'--opt','com.docker.network.bridge.enable_ip_masquerade=false','composition-'+role)
        # Prove forbidden services exist before attributing failures to packet policy.
        reachability="import http.client,json; targets=['93.184.216.34','2606:4700:4700:ffee::2','10.77.12.2','fd77:12::2','169.254.169.254','93.184.216.35','10.77.10.1']; result=[]\nfor target in targets:\n c=http.client.HTTPConnection(target,18080,timeout=3);c.request('GET','/hits');r=c.getresponse();assert r.status==200;r.read(1024);c.close();result.append(target)\nprint(json.dumps(result))"
        receipt('canary-readiness.json',{'reachable':json.loads(inside('/usr/bin/python3','-B','-c',reachability))})
        inside('/usr/sbin/nft','--check','--file',str(PACKET/'fixture.nft'));inside('/usr/sbin/nft','--file',str(PACKET/'fixture.nft'))
        receipt('network.json',{'rules':inside('/usr/sbin/nft','--json','list','ruleset'),'routes':inside('/usr/sbin/ip','-json','route','show')})
        # All admitted addresses are owned canaries; no resolver or external route is provided.
        proxy=common('composition-proxy','composition-proxy','10.77.11.2','256m')+['--ip6','fd77:11::2','--user','13:13','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=32m,uid=13,gid=13,mode=700','--mount','type=bind,src='+str(ROOT/'config/squid.conf')+',dst=/squid.conf,readonly']
        for host,address in (('example.com','93.184.216.34'),('wrong.example','93.184.216.34'),('ipv6.example','2606:4700:4700:ffee::2'),('private.example','10.77.12.2'),('metadata.example','169.254.169.254'),('control.example','93.184.216.35')):proxy+=['--add-host',host+':'+address]
        proxy+=['--entrypoint','/usr/sbin/squid',squid['Id'],'-NYCd1','-f','/squid.conf']
        receipt('proxy-create-reserved.json',{'image':squid['Id']});proxy_id=docker(*proxy);receipt('proxy-start-reserved.json',{'id':proxy_id});docker('start',proxy_id)
        browser_id=browser_create(1)
        sockets=json.loads(docker('exec',browser_id,'/usr/bin/node','/socket_probe.mjs',timeout=25));require(sockets.get('accepted') is True,'actual container socket policy failed');receipt('socket-result.json',sockets)
        tls=[]
        for label,url,expected in (('trusted','https://example.com:18443/',200),('wrong-host','https://wrong.example:18443/',502),('unknown-ca','https://example.com:18444/',502)):
            status,response=relay('control','/navigate',{'url':url})
            receipt('tls-'+label+'.json',{'status':status,'response':response})
            require(status==expected,'Chromium TLS policy failed: '+label)
            if expected==502:require('ERR_CERT_' in json.dumps(response),'negative was not certificate refusal')
            tls.append({'case':label,'status':status})
        require(relay('control','/computers/stop',{})[0]==200,'component browser stop failed')
        receipt('tls-result.json',{'accepted':True,'cases':tls,'certificateErrorsIgnored':False})
        status,health=relay('control','/health');require(status==200,'browser health')
        receipt('ready.json',{'browserId':browser_id,'proxyId':proxy_id,'health':health,'nativeDeadline':deadline})
        print(json.dumps({'ready':True,'root':str(ROOT),'nativeRemainingSeconds':int(deadline-time.monotonic())}),flush=True)
        while not (ROOT/'finish.json').exists():
            original();time.sleep(.5)
        finish=native.read_json(ROOT/'finish.json');require(finish=={'productAccepted':True},'product fixture did not accept')
        active=json.loads(docker('inspect','composition-browser-2'))[0]['Id']
        docker('exec','--detach',active,'/usr/bin/node','/tunnel_probe.mjs')
        def guest_receipt(name):
            try:return json.loads(docker('exec',active,'/usr/bin/node','-e',"process.stdout.write(require('node:fs').readFileSync('/tmp/"+name+"','utf8'))",timeout=2))
            except RuntimeError:return None
        tunnel=native.wait_until(lambda:guest_receipt('tunnel-ready.json'),time.monotonic()+8,'verified open TLS tunnel')
        require(tunnel=={'verifiedTLS':True,'baseline':True},'tunnel baseline differs')
        hits=relay('target','/hits')[1]
        # Revocation removes both directions, including established flows; no outside established exception.
        inside('/usr/sbin/nft','flush','chain','inet','openbot_composition','admitted')
        docker('exec',active,'/usr/bin/node','-e',"require('node:fs').writeFileSync('/tmp/tunnel-revoked','closed')")
        revoked=native.wait_until(lambda:guest_receipt('tunnel-result.json'),time.monotonic()+8,'existing tunnel revocation')
        require(revoked.get('accepted') is True and relay('target','/hits')[1]==hits,'existing tunnel survived or target received another request')
        receipt('revoked.json',revoked)
        result.update(accepted=True,actualSquid=True,actualRunsc=True,actualProductJourney=True,kernelSocketCases=sockets['cases'])
    except BaseException as error:
        result.update(failureType=type(error).__name__,failure=str(error))
        receipt('failure.json',result);print(json.dumps(result),flush=True)
        try:
            for name in ('composition-proxy','composition-browser-1','composition-browser-2'):
                try:receipt(name+'-log.json',{'log':docker('logs',name,timeout=3)})
                except RuntimeError:pass
        except BaseException:pass
    finally:
        if armed:
            try:
                if result['accepted']:
                    browser.observe_expiry(ROOT,armed)
                    result['originalNativeExpiryVerified']=True
                else:
                    close_failed_original(armed)
                    result['failedOriginalUnitClosed']=True
                for name in ('docker-data','docker-exec','containerd-data','containerd-state'):
                    path=ROOT/name
                    if path.exists():require(not path.is_symlink(),'unsafe cleanup');shutil.rmtree(path)
                if result['accepted']:native.command(['/usr/bin/systemctl','reset-failed',UNIT])
                after=snapshot();receipt('after.json',after);require(before==after,'production state changed')
                result.update(productionUnchanged=True,existingContainerCount=len(before['containers']),ownedRuntimeRemoved=True)
            except BaseException as error:result['cleanupFailure']=str(error);result['accepted']=False
        else:result['accepted']=False;result['cleanupFailure']='native identity unconfirmed'
        receipt('result.json',result);print(json.dumps(result),flush=True)
    return 0 if result['accepted'] else 2

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('operation',choices=('run','daemon','restart','finish','abort'));args=parser.parse_args()
    if args.operation=='daemon':daemon()
    elif args.operation=='restart':restart()
    elif args.operation in ('finish','abort'):original();receipt('finish.json',{'productAccepted':args.operation=='finish'})
    else:raise SystemExit(run())
