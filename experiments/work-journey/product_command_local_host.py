"""Local integration only: real Host/Unix framing and an explicitly synthetic Native."""
import hashlib
import json
import os
from pathlib import Path
import socket
import sys
import threading
import time
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(ROOT/'experiments/linux-execution'),str(ROOT/'apps/server-python/src')]
from protected_host import Configuration,Host,UnixService
from protected_io import Refused
from openbot_server.work_command_crypto import VerificationPin
from openbot_server.work_command_v2_crypto import CommandV2Signer,CommandV2Verifier
from product_command_fixture import CSV,ARGUMENTS


class LocalHost:
    def __init__(self,directory,route,timing,control_public,enforcer_private):
        self.directory=directory;self.socket=directory/'command.sock'
        self.started=None;self.boot=str(uuid4());self.calls=[];self.error=None
        (directory/'state').mkdir(mode=0o700)
        signer=CommandV2Signer(issuer='product-enforcer',kid=route['enforcementKeyId'],role='enforcement',private_pem=enforcer_private)
        verifier=CommandV2Verifier([VerificationPin('product-control','product-control-key','control',control_public)])
        config=Configuration(directory/'state',self.socket,os.getuid(),os.getgid(),route,timing,
            'product-control','product-enforcer',{},signer,verifier)
        self.host=Host(config,self,clock=self.clock)
        self.listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        self.listener.bind(str(self.socket));self.listener.listen(1);self.listener.settimeout(150)
        self.connection=None
        self.thread=threading.Thread(target=self._serve,daemon=True);self.thread.start()
    def clock(self):
        stamp=time.monotonic_ns()//1000
        return stamp,stamp,self.boot
    def _serve(self):
        try:
            self.connection,_=self.listener.accept()
            with self.connection:
                # Native and peer identity are explicit fixtures on macOS. Linux qualification
                # must use the unchanged SO_PEERCRED check and protected socket installation.
                UnixService(self.host,peer=lambda _:os.getuid()).connection(self.connection)
        except (EOFError,OSError,Refused) as error:
            self.error=type(error).__name__
        finally:self.host.close()
    def reserve(self,binding,authorization,instance):
        assert not self.calls,'This fixture permits one original command only'
        self.calls.append('reserve');root=self.directory/'native';root.mkdir(mode=0o700)
        (root/'input').mkdir();(root/'output').mkdir()
        return dict(root=str(root),input=str(root/'input'),output=str(root/'output'),binding=binding,instance=instance)
    def prepare(self,record,authorization,start):
        self.calls.append('prepare');self.started=self.clock()[0]
    def check_alive(self,record):
        assert self.started is not None and self.clock()[0]-self.started<50000000
    def readiness(self,record,authorization):
        self.check_alive(record);self.calls.append('readiness');stamp=self.clock()[0]
        unit='openbot-command-'+record['binding']['preparationId'].replace('-','')+'.service'
        return dict(bootId=self.boot,enforcerInstanceId=record['instance'],unitName=unit,invocationId='1'*32,
            cgroupPath='/system.slice/'+unit,cgroupInode=25,activeMonotonicUs=self.started,runtimeMaxUs=50000000,
            observedMonotonicUs=stamp,observedBoottimeUs=stamp,runtimeIdentityDigest='e'*64,
            runtimeShapeDigest='f'*64,timingPolicyDigest=self.host.book.policy.policyDigest,startAttempts=0)
    def execute(self,record,operation,launch):
        assert self.calls.count('execute')==0
        assert operation['command']['argv']==ARGUMENTS['argv']
        assert (Path(record['input'])/'input-01').read_bytes()==CSV
        self.calls.append('execute')
    def lookup(self,record,operation,*,include_output):
        self.check_alive(record);assert self.calls.count('execute')==1;self.calls.append('lookup')
        output=operation['command']['output'];data=CSV if include_output else None
        return dict(phase='exited',containerId='d'*64,startAttempts=1,exitCode=0,sequence=1,runtimeShapeDigest='f'*64,
            outputs=[dict(name=output['name'],mediaType=output['mediaType'],sizeBytes=len(CSV),
                          sha256=hashlib.sha256(CSV).hexdigest())] if include_output else [],truncated=False),data
    def stop(self,record):self.calls.append('stop')
    def close(self):
        if self.connection:
            try:self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:pass
        self.listener.close();self.thread.join(5)
        assert not self.thread.is_alive(),'Fixture Host thread remained active'
        if self.socket.exists():self.socket.unlink()
