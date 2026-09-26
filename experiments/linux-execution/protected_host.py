"""Protected command-only Unix host. Models and Node never select host paths or executables."""
import argparse
import base64
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import socket
import stat
import time
from uuid import uuid4

from openbot_server.work_command_contract import parse, Command, DispatchOperation, operation_fingerprint, bounded_value
from openbot_server.work_command_crypto import VerificationPin, _parts
from openbot_server.work_command_v2_contract import (PreparationBinding, BindingV2, TimingPolicy, token_digest,
    preparation_binding, execution_binding)
from openbot_server.work_command_v2_crypto import CommandV2Signer, CommandV2Verifier, HostExchangeBook
from openbot_server.work_command_frames import parse_command_frame, PROTOCOL_VERSION
from protected_io import Refused, require, directory, read_bytes, read_record, exclusive, fsync_dir, receive, send, peer_uid


def native_clock():
    require(hasattr(time,'CLOCK_BOOTTIME'),'unsupported_clock')
    return time.monotonic_ns()//1000,time.clock_gettime_ns(time.CLOCK_BOOTTIME)//1000,Path('/proc/sys/kernel/random/boot_id').read_text().strip()

@dataclass(frozen=True)
class Configuration:
    state: Path
    socket_path: Path
    node_uid: int
    node_gid: int
    route: dict
    policy: dict
    control_issuer: str
    enforcement_issuer: str
    native: dict
    signer: object
    verifier: object

    @classmethod
    def load(cls,path):
        path=Path(path);directory(path.parent)
        value=read_record(path)
        require(set(value)=={'state','socket','nodeUid','nodeGid','route','policy','controlIssuer','enforcementIssuer','native','privateKey','controlPins'},'invalid_config')
        require(type(value['nodeUid']) is int and value['nodeUid']>0 and type(value['nodeGid']) is int and value['nodeGid']>0,'unsafe_peer')
        require(os.geteuid()==0,'linux_root_required')
        state=directory(value['state']);sock=Path(value['socket']);directory(sock.parent,private=False)
        s=sock.parent.stat();require(s.st_gid==value['nodeGid'] and stat.S_IMODE(s.st_mode)==0o750,'unsafe_socket_directory')
        require(sock.name=='command.sock' and len(os.fsencode(sock))<=107,'unsafe_socket_path')
        require(not sock.exists() and not sock.is_symlink(),'socket_exists')
        key_path=Path(value['privateKey']);directory(key_path.parent)
        require(str(key_path.parent)==value['native']['secretsDirectory'] and not state.is_relative_to(key_path.parent),'unsafe_secret_scope')
        key=read_bytes(key_path,16384)
        from openbot_server.work_command_contract import CommandRoute
        route=parse(CommandRoute,value['route']).model_dump();policy=parse(TimingPolicy,value['policy']).model_dump()
        require(policy['runtimeMaxMs']<=50000 and policy['stopAllowanceMs']==5000,'unqualified_timing')
        pins=[]
        for pin in value['controlPins']:
            require(set(pin)=={'kid','path'},'invalid_pin');file=Path(pin['path']);directory(file.parent)
            pins.append(VerificationPin(value['controlIssuer'],pin['kid'],'control',read_bytes(file,16384)))
        require(1<=len(pins)<=8,'invalid_pin')
        signer=CommandV2Signer(issuer=value['enforcementIssuer'],kid=route['enforcementKeyId'],role='enforcement',private_pem=key)
        return cls(state,sock,value['nodeUid'],value['nodeGid'],route,policy,value['controlIssuer'],value['enforcementIssuer'],value['native'],signer,CommandV2Verifier(pins))


class Inputs:
    """Flat immutable manifest receiver; no offset replay, sparse writes or path interpretation."""
    def __init__(self,path,manifest):
        self.path=path;self.manifest=manifest;self.offsets=[0]*len(manifest);self.done=[False]*len(manifest)
        self.fds=[];self.hashes=[]
        for entry in manifest:
            fd=os.open(path/entry['path'],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            self.fds.append(fd);self.hashes.append(hashlib.sha256())
            if entry['size']==0:self.finish(len(self.fds)-1)
        fsync_dir(path)
    def finish(self,i):
        require(self.hashes[i].hexdigest()==self.manifest[i]['sha256'],'input_digest_changed')
        os.fsync(self.fds[i]);os.fchmod(self.fds[i],0o444);os.close(self.fds[i]);self.fds[i]=None;self.done[i]=True;fsync_dir(self.path)
    def append(self,value):
        i=value['fileIndex'];require(0<=i<len(self.manifest) and not self.done[i],'input_slot_closed')
        data=base64.b64decode(value['data'],validate=True)
        require(value['offset']==self.offsets[i] and 0<len(data)<=16384 and self.offsets[i]+len(data)<=self.manifest[i]['size'],'input_offset_changed')
        fd=self.fds[i];s=os.fstat(fd);require(s.st_nlink==1 and s.st_size==self.offsets[i] and stat.S_ISREG(s.st_mode),'input_file_changed')
        require(os.write(fd,data)==len(data),'input_write_unknown');self.hashes[i].update(data);self.offsets[i]+=len(data)
        if self.offsets[i]==self.manifest[i]['size']:self.finish(i)
        return self.offsets[i]
    def complete(self):return all(self.done)
    def close(self):
        for fd in self.fds:
            if fd is not None:os.close(fd)
        self.fds=[None]*len(self.fds)


class Host:
    def __init__(self,config,native,*,clock=native_clock):
        self.config=config;self.native=native;self.clock=clock;self.book=HostExchangeBook(policy=config.policy,clock=clock)
        self.active={};self.controls={};self.output={};self.bound_connection=None;self.closed=False;self.sequence=0
        self.actions=config.state/'actions';self.actions.mkdir(mode=0o700,exist_ok=True)
        require(len(list(self.actions.iterdir()))<=64,'capacity_exhausted')
        self.instance_path=config.state/'instance.json'
        tmp=config.state/('instance-'+self.book.instance_id+'.tmp');exclusive(tmp,{'instanceId':self.book.instance_id})
        os.replace(tmp,self.instance_path);fsync_dir(config.state)
        self.native.instance_path=self.instance_path
    def frame(self,kind,binding,request,payload):
        return parse_command_frame(dict(type=kind,protocolVersion=PROTOCOL_VERSION,nodeId=binding['nodeId'],
            preparationId=binding['preparationId'],requestId=request,payload=payload),server=False)
    def route(self,binding):
        require(all(binding[k]==v for k,v in self.config.route.items()),'route_changed')
    def record_path(self,binding):return self.actions/hashlib.sha256(binding['actionId'].encode()).hexdigest()
    def original(self,binding):
        path=self.record_path(binding);record=read_record(path/'original.json',uid=os.geteuid())
        require(record['binding']==binding,'original_identity_changed');return path,record
    def correlation(self,frame,binding):
        self.route(binding);require((frame['nodeId'],frame['preparationId'])==(binding['nodeId'],binding['preparationId']),'outer_identity_changed')
    def _ready(self,state):
        if not state['inputs'].complete() or state.get('ready'):return []
        proof=self.native.readiness(state['native'],state['authorization'].model_dump())
        token=state['pending'].ready(proof,self.config.signer,audience=self.config.control_issuer)
        exclusive(state['path']/'ready.json',{'token':token,'proof':proof})
        state['ready']=True
        return [self.frame('work.command.ready',state['binding'],state['binding']['preparationId'],{'token':token})]
    def handle(self,value):
        require(not self.closed,'connection_closed');f=parse_command_frame(value,server=True);kind=f['type'];p=f['payload'];prep=f['preparationId']
        require(f['nodeId']==self.config.route['nodeId'],'route_changed')
        if kind=='work.command.prepare_open':
            binding=p;self.correlation(f,binding)
            if self.bound_connection is None:self.bound_connection=binding['connectionId']
            require(binding['connectionId']==self.bound_connection,'connection_changed')
            require(not self.record_path(binding).exists() and prep not in self.active and len(self.active)<64,'original_already_reserved')
            pending=self.book.begin_prepare(binding);self.active[prep]={'binding':binding,'pending':pending}
            return [self.frame('work.command.prepare_challenge',binding,f['requestId'],{'token':pending.challenge(self.config.signer,audience=self.config.control_issuer)})]
        if kind=='work.command.control_open':
            binding=p['binding'];self.correlation(f,binding);path,original=self.original(binding)
            require(f['requestId'] not in self.controls,'request_replayed')
            pending=self.book.begin_control(binding,request_id=f['requestId'],operation=p['operation'])
            self.controls[f['requestId']]={'pending':pending,'binding':binding,'path':path,'original':original}
            return [self.frame('work.command.control_challenge',binding,f['requestId'],{'token':pending.challenge(self.config.signer,audience=self.config.control_issuer)})]
        if kind in ('work.command.lookup','work.command.stop','work.command.output_ack'):
            control=self.controls.get(f['requestId']);require(control is not None,'no_pending_control');binding=control['binding'];self.correlation(f,binding)
            pending=control['pending']
            if kind=='work.command.output_ack':
                pending.check_control(require_output=True);output=self.output.get(f['requestId']);require(output is not None and p['nextOffset']==output['offset'],'output_offset_changed')
                return self._chunk(control)
            record=pending.accept_control(p['token'],self.config.verifier,issuer=self.config.control_issuer,audience=self.config.enforcement_issuer)
            require(record.value.operation==('lookup' if kind=='work.command.lookup' else 'stop'),'operation_changed')
            if kind=='work.command.stop':
                pending.check_control();exclusive(control['path']/('stop-'+f['requestId']+'.json'),{'digest':record.digest,'reason':record.value.reason})
                self.native.stop(control['original']['native']);self._finish_control(control);return []
            require(record.value.dispatch is not None,'no_dispatch')
            original_dispatch=read_record(control['path']/'dispatch.json',uid=os.geteuid())
            require(record.value.dispatch.model_dump()==original_dispatch['binding'],'original_dispatch_changed')
            pending.check_control();observation,data=self.native.lookup(control['original']['native'],original_dispatch['operation'],include_output=record.value.includeOutput)
            observations=control['path']/'observations';observations.mkdir(mode=0o700,exist_ok=True)
            entries=list(observations.iterdir());require(len(entries)<4096,'observation_capacity')
            sequence=max([int(e.stem) for e in entries] or [0])+1
            exclusive(observations/(str(sequence)+'.json'),{'requestId':f['requestId'],'challengeDigest':record.value.challengeDigest})
            observation['sequence']=sequence
            consumed=read_record(control['path']/'permit.json',uid=os.geteuid()) if (control['path']/'permit.json').exists() else None
            receipt=pending.receipt(observation,consumed['digest'] if consumed else None,self.config.signer,audience=self.config.control_issuer)
            result=[self.frame('work.command.lookup_result',binding,f['requestId'],{'token':receipt})]
            if data is not None:
                pending.check_control(require_output=True);require(type(data) is bytes and len(data)<=1048576,'output_bound');data.decode('utf-8','strict')
                require(len(observation['outputs'])==1 and observation['outputs'][0]['sizeBytes']==len(data) and observation['outputs'][0]['sha256']==hashlib.sha256(data).hexdigest(),'output_receipt_changed')
                self.output[f['requestId']]={'data':data,'offset':0};result+=self._chunk(control)
            else:self._finish_control(control)
            return result
        state=self.active.get(prep);require(state is not None,'no_pending_preparation');binding=state['binding'];self.correlation(f,binding)
        require(binding['connectionId']==self.bound_connection,'connection_changed')
        if kind=='work.command.prepare_authorize':
            pending=state['pending'];record=pending.accept_authorization(p['token'],self.config.verifier,issuer=self.config.control_issuer,audience=self.config.enforcement_issuer)
            require(record.value.timing.runtimeMaxMs<=50000 and record.value.timing.stopAllowanceMs==5000,'unqualified_timing')
            require(len(list(self.actions.iterdir()))<64,'capacity_exhausted')
            path=self.record_path(binding);path.mkdir(mode=0o700);fsync_dir(self.actions)
            # The protected reservation precedes unit submission; any later uncertainty stays consumed.
            native=self.native.reserve(binding,record.value.model_dump(),self.book.instance_id)
            exclusive(path/'original.json',{'binding':binding,'native':native,'authorizationDigest':record.digest})
            state.update(path=path,native=native,authorization=record.value)
            state['inputs']=Inputs(Path(native['input']),record.value.staging.inputManifest and [x.model_dump() for x in record.value.staging.inputManifest] or [])
            self.native.prepare(native,record.value.model_dump(),pending.start)
            return self._ready(state)
        if kind=='work.command.input_chunk':
            require(f['requestId']==binding['preparationId'] and 'inputs' in state and not state.get('ready'),'input_phase_changed')
            state['pending'].interval();self.native.check_alive(state['native'])
            offset=state['inputs'].append(p)
            return [self.frame('work.command.input_ack',binding,f['requestId'],dict(fileIndex=p['fileIndex'],nextOffset=offset))]+self._ready(state)
        if kind=='work.command.dispatch':
            require(state.get('ready') and 'consume' not in state,'dispatch_replayed')
            payload=_parts(p['ticket'])[1];expected={k:payload[k] for k in BindingV2.model_fields}
            record=self.config.verifier.verify_interval(p['ticket'],purpose='work_command_dispatch',issuer=self.config.control_issuer,
                audience=self.config.enforcement_issuer,expected_binding=expected,pending=state['pending'])
            require(f['requestId']==record.value.dispatchId,'outer_request_changed')
            operation=parse(DispatchOperation,p['operation']);require(operation_fingerprint(operation.model_dump())==binding['operationFingerprint'],'operation_changed')
            require(operation.command.model_dump()=={**state['authorization'].staging.model_dump(),'argv':operation.command.argv},'staging_changed')
            exclusive(state['path']/'dispatch.json',{'binding':execution_binding(record.value),'operation':operation.model_dump(),'digest':record.digest})
            state['operation']=operation.model_dump();consume=state['pending'].begin_consume();state['consume']=consume
            token=consume.consume_challenge(self.config.signer,audience=self.config.control_issuer)
            return [self.frame('work.command.consume',binding,consume.request_id,{'token':token})]
        if kind=='work.command.consume_result':
            consume=state.get('consume');require(consume is not None and f['requestId']==consume.request_id,'consume_request_changed')
            require(p['status']=='consumed','consume_refused')
            record=self.config.verifier.verify_interval(p['permit'],purpose='work_command_permit',issuer=self.config.control_issuer,audience=self.config.enforcement_issuer,
                expected_binding=consume.binding,pending=consume,expected_request=dict(requestId=consume.request_id,nonce=consume.nonce))
            interval=consume.interval();interval.check(record.value);now=self.clock()
            remaining=min(record.value.launchDeadlineMs,record.value.hardDeadlineMs)-interval.upper_ms
            local_expiry=now[1]+self.book.policy.lower(remaining)*1000;require(local_expiry>now[1],'permit_expired')
            launch={'bootId':now[2],'enforcerInstanceId':self.book.instance_id,'expiresBoottimeUs':local_expiry,'digest':record.digest}
            exclusive(state['path']/'permit.json',launch)
            # Native helper checks this original BOOTTIME/boot guard immediately before each verb too.
            self.native.execute(state['native'],state['operation'],launch)
            return []
        raise Refused('unsupported_frame')
    def _chunk(self,control):
        pending=control['pending'];pending.check_control(require_output=True);r=pending.request_id;output=self.output[r]
        if output['offset']==len(output['data']):
            del self.output[r];self._finish_control(control);return []
        offset=output['offset'];data=output['data'][offset:offset+16384];output['offset']+=len(data)
        return [self.frame('work.command.output_chunk',control['binding'],r,dict(fileIndex=0,offset=offset,data=base64.b64encode(data).decode()))]
    def _finish_control(self,control):
        self.book.finish_control(control['pending'])
        del self.controls[control['pending'].request_id]
    def close(self):
        self.closed=True;self.book.close();self.output.clear()
        for state in self.active.values():
            if 'inputs' in state:state['inputs'].close()


class UnixService:
    """Exactly one accepted relay connection; disconnect never replays or reopens live slots."""
    def __init__(self,host,*,peer=peer_uid):self.host=host;self.peer=peer
    def connection(self,connection):
        require(self.peer(connection)==self.host.config.node_uid,'peer_refused');connection.settimeout(60)
        try:
            while True:
                value=receive(connection)
                for response in self.host.handle(value):send(connection,response)
        finally:self.host.close()
    def serve(self):
        cfg=self.host.config;require(not cfg.socket_path.exists() and not cfg.socket_path.is_symlink(),'socket_exists')
        listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);bound=None
        try:
            listener.bind(str(cfg.socket_path));bound=cfg.socket_path.lstat();os.chown(cfg.socket_path,0,cfg.node_gid);os.chmod(cfg.socket_path,0o660);listener.listen(1)
            connection,_=listener.accept()
            with connection:self.connection(connection)
        finally:
            listener.close();self.host.close()
            if bound is not None and cfg.socket_path.is_socket():
                current=cfg.socket_path.lstat()
                if (current.st_dev,current.st_ino)==(bound.st_dev,bound.st_ino):cfg.socket_path.unlink()


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);args=parser.parse_args()
    cfg=Configuration.load(args.config)
    from protected_native import LinuxNative
    native=LinuxNative(cfg.native,route=cfg.route,policy=cfg.policy)
    UnixService(Host(cfg,native)).serve()

if __name__=='__main__':main()
