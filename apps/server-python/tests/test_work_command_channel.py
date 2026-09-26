"""Real SQL/crypto/Host protocol/registry budgets; synthetic SDK, socket and Native only."""
import asyncio
import base64
from contextlib import asynccontextmanager
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import sys
from unittest.mock import patch
from uuid import uuid4

import pytest
from psycopg.types.json import Jsonb

from test_work_command_store import fixture, setup, sdk, row
from test_work_command_actions import envelope
from openbot_server.work_command_channel import CommandInbox, CommandChannelDriver
from openbot_server.work_command_contract import bounded_value, CommandContractError
from openbot_server.work_command_crypto import _parts
from openbot_server.work_command_frames import parse_command_frame
from openbot_server.work_command_store import sha
from openbot_server.work_values import canonical, WorkConflict
from openbot_server.worker_host_commands import WorkerCommandChannel, CommandChannelError

# Import the production Host and its maintained explicit fake Native/clock. No Linux verb runs.
import test_work_command_store as _store_test
_REPO=Path(_store_test.__file__).resolve().parents[3]
sys.path.insert(0,str(_REPO/'experiments/linux-execution'))
from protected_host import Host, Configuration
from protected_host_test import Clock, FakeNative
from protected_io import Refused


class Native(FakeNative):
    def readiness(self,record,authorization):
        proof=super().readiness(record,authorization)
        proof['runtimeMaxUs']=authorization['timing']['runtimeMaxMs']*1000
        return proof


class Peer: pass


class Wire:
    """Synthetic WebSocket and identity-lock owner; real WorkerCommandChannel holds budgets."""
    def __init__(self,f,inbox,host):
        self._closed=False;self.host=host;self.inbox=inbox;self.before=None;self.mutate=None
        self.sent=[];self.received=[];self.lock=asyncio.Lock();self.peak=0
        self.peer=Peer();p=self.peer;p.node={'id':f.node};p.connection_id=f.transport.live.connection_id
        p.credential_digest=f.transport.live.credential_digest;p.socket=self;p.send_lock=asyncio.Lock()
        self._nodes={f.node:p};self.commands=WorkerCommandChannel(self,inbox.configuration)
        self.commands.activate(p);self.handle=self.commands.connection(f.node)
    def _current(self,p): return not self._closed and self._nodes.get(p.node['id']) is p
    @asynccontextmanager
    async def identity_guard(self,node):
        async with self.lock:
            if not self._current(self.peer) or node!=self.peer.node['id']:raise CommandChannelError()
            yield
    def _detach(self,p,reason):
        if self._nodes.get(p.node['id']) is p:self._nodes.pop(p.node['id'])
        self.commands.detach(p);self.host.close()
    async def _close(self,p,code,reason): self._detach(p,reason)
    def disconnect(self): self._detach(self.peer,'synthetic disconnect')
    async def send_text(self,raw):
        frame=parse_command_frame(json.loads(raw),server=True)
        self.sent.append(deepcopy(frame))
        if self.before: await self.before(frame)
        for value in self.host.handle(frame):
            if self.mutate:value=self.mutate(deepcopy(value))
            value=parse_command_frame(value,server=False)
            self.received.append(deepcopy(value))
            self.commands.receive(self.peer,value,len(bounded_value(value,maximum=32768)))
            self.peak=max(self.peak,len(self.handle.items))


@asynccontextmanager
async def connected(fixture,*,approved=True,wrapped=True,data=b'x,y\n'):
    f=await setup(fixture)
    f.command['output']['maxBytes']=1048576
    if wrapped:
        f.intent=envelope(f.intent)
        f.action=await f.store.propose(f.tid,f.rid,fence=f.fence,action_key='channel-'+uuid4().hex,
            intent=f.intent,reserved_tokens=0,correction_context=f.context.correction_token)
    if approved:
        await f.store.decide(f.token,f.action,intent_digest=canonical(f.intent)[1],approved=True)
    f.clock=Clock();state=f.filebase/'host-state';state.mkdir(mode=0o700)
    nativebase=f.filebase/'fake-native';nativebase.mkdir(mode=0o700)
    f.native=Native(nativebase,f.clock);f.native.data=data
    cfg=Configuration(state,f.filebase/'unused.sock',os.getuid(),os.getgid(),f.route,
        f.adapter.timing_policy.model_dump(),'control','enforcement',{},f.enforcer,f.verifier)
    f.host_protocol=Host(cfg,f.native,clock=f.clock)
    f.inbox=CommandInbox();f.wire=Wire(f,f.inbox,f.host_protocol)
    f.inbox.attach(f.wire.commands);f.adapter.transport=f.wire.commands
    f.driver=CommandChannelDriver(f.adapter,f.inbox)
    try:
        yield f
    finally:
        f.wire.disconnect();await f.wire.commands.drain()
        assert not f.inbox.sessions and not f.wire.handle.items


async def execute(f,**kwargs):
    with sdk(f):
        return await f.driver.execute(f.context,f.action,fence=f.fence,connection=f.wire.handle,
            command=f.command,attachments=[dict(path='input.csv',attachmentId=f.attachment['id'])],
            blobs=kwargs.get('blobs',{'input.csv':b'x,y\n'}))


async def events(f):
    async with f.store._transaction(trusted=True) as db:
        return await (await db.execute("SELECT * FROM work_events WHERE task_id=%s AND kind='command.permit_issued' "
            "AND payload->>'actionId'=%s ORDER BY revision",(f.tid,f.action))).fetchall()


def test_real_sql_host_crypto_and_coalesced_stream_use_original_wrapper(fixture):
    async def check():
        data=('Synthetic 中文\n'*4000).encode()
        async with connected(fixture,data=data) as f:
            assert await execute(f)=={'status':'dispatched'}
            permit=next(x['payload']['permit'] for x in f.wire.sent if x['type']=='work.command.consume_result')
            original=await f.adapter.original(f.action)
            assert original['permitDigest']==sha(permit)==(await events(f))[0]['payload']['permitDigest']
            assert original['operation']['intentDigest']==canonical(f.intent)[1]!=canonical(f.intent['effect'])[1]
            assert (await row(f))['state']=='consumed' and f.native.calls.count('execute')==1
            outcome=await f.driver.lookup(f.wire.handle,f.action,include_output=True)
            assert outcome['output']==data and outcome['receipt']['permitDigest']==sha(permit)
            assert outcome['receipt']['observation']['outputs'][0]['sha256']==hashlib.sha256(data).hexdigest()
            pairs=[('work.command.input_ack','work.command.ready'),('work.command.lookup_result','work.command.output_chunk')]
            for first,last in pairs:
                i=next(i for i,x in enumerate(f.wire.received) if x['type']==first)
                a,b=f.wire.received[i:i+2]
                assert b['type']==last and a['requestId']==b['requestId']
            offsets=[x['payload']['nextOffset'] for x in f.wire.sent if x['type']=='work.command.output_ack']
            assert offsets==list(range(16384,len(data),16384))+[len(data)]
            assert f.wire.peak==4 and not f.wire.handle.items
            with pytest.raises(WorkConflict,match='command_approval_required'):await execute(f)
            assert f.native.calls.count('execute')==1 and len(await events(f))==1
            challenge=next(x for x in f.wire.received if x['type']=='work.command.consume')
            token=challenge['payload']['token']
            repeated=await f.adapter.consume(f.wire.handle,f.action,token,request_id=challenge['requestId'],nonce=_parts(token)[1]['nonce'])
            assert repeated=={'status':'lookup_required'} and len(await events(f))==1
    asyncio.run(check())


@pytest.mark.parametrize('blobs',[{}, {'other':b'x,y\n'}, {'input.csv':bytearray(b'x,y\n')},
    {'input.csv':b'x,z\n'}, {'input.csv':b'x,y\n!'}])
def test_bad_blobs_refused_before_preparation_or_io(fixture,blobs):
    async def check():
        async with connected(fixture) as f:
            with pytest.raises(WorkConflict,match='command_input_manifest_changed'):await execute(f,blobs=blobs)
            assert not f.wire.sent and not f.native.calls and await row(f) is None
    asyncio.run(check())


def test_pending_owner_approval_never_prepares_or_dispatches(fixture):
    async def check():
        async with connected(fixture,approved=False) as f:
            with pytest.raises(WorkConflict):await execute(f)
            assert not f.wire.sent and not f.native.calls and not await events(f)
    asyncio.run(check())


@pytest.mark.parametrize('stage',['prepare_open','input_chunk','consume_result','output_ack'])
def test_disconnect_never_replays_and_releases_original_pending(fixture,stage):
    async def check():
        async with connected(fixture,data=b'x'*30000) as f:
            if stage=='output_ack':await execute(f)
            async def before(frame):
                if frame['type']=='work.command.'+stage:
                    f.wire.disconnect();raise OSError('synthetic lost socket ACK')
            f.wire.before=before
            with pytest.raises((CommandChannelError,WorkConflict)):
                await f.driver.lookup(f.wire.handle,f.action,include_output=True) if stage=='output_ack' else await execute(f)
            assert not f.inbox.sessions and not f.wire.handle.items
            assert f.native.calls.count('execute')==(1 if stage=='output_ack' else 0)
            record=await row(f)
            if stage in ('consume_result','output_ack'):
                assert record['state']=='consumed' and len(await events(f))==1
                assert (await f.adapter.original(f.action))['permitDigest']
            else:assert record is None
    asyncio.run(check())


@pytest.mark.parametrize('kind',['offset','bytes','request','signature','signed_hash','signed_name','signed_permit'])
def test_output_or_receipt_tamper_is_never_returned(fixture,kind):
    async def check():
        async with connected(fixture,data=b'x'*30000) as f:
            await execute(f)
            def mutate(frame):
                if frame['type']=='work.command.output_chunk':
                    if kind=='offset':frame['payload']['offset']+=1
                    if kind=='bytes':frame['payload']['data']=base64.b64encode(b'z'*len(base64.b64decode(frame['payload']['data']))).decode()
                    if kind=='request':frame['requestId']=str(uuid4())
                if frame['type']=='work.command.lookup_result':
                    token=frame['payload']['token']
                    if kind=='signature':
                        a,b,c=token.split('.');frame['payload']['token']=a+'.'+b+'.'+('A' if c[0]!='A' else 'B')+c[1:]
                    elif kind.startswith('signed_'):
                        claims=_parts(token)[1]
                        if kind=='signed_hash':claims['observation']['outputs'][0]['sha256']='0'*64
                        if kind=='signed_name':claims['observation']['outputs'][0]['name']='different.txt'
                        if kind=='signed_permit':claims['permitDigest']='0'*64
                        frame['payload']['token']=f.enforcer.sign(claims,purpose='work_command_receipt',now_ms=claims['iat']*1000)
                return frame
            f.wire.mutate=mutate
            with pytest.raises((WorkConflict,CommandContractError,CommandChannelError)):
                await f.driver.lookup(f.wire.handle,f.action,include_output=True)
            assert f.native.calls.count('execute')==1 and len(await events(f))==1 and not f.inbox.sessions
    asyncio.run(check())


@pytest.mark.parametrize('mutation',['missing','duplicate','malformed','other_dispatch','other_preparation','extra','digest'])
def test_original_permit_event_missing_or_tampered_fails_closed(fixture,mutation):
    async def check():
        async with connected(fixture) as f:
            await execute(f);before=(await events(f))[0]
            async with f.store._transaction(trusted=True) as db:
                if mutation=='missing':await db.execute('DELETE FROM work_events WHERE task_id=%s AND revision=%s',(f.tid,before['revision']))
                elif mutation=='duplicate':await f.store._event(db,f.tid,'command.permit_issued',before['payload'])
                else:
                    payload=deepcopy(before['payload'])
                    if mutation=='malformed':payload['permitDigest']='not-a-digest'
                    elif mutation=='other_dispatch':payload['dispatchId']=str(uuid4())
                    elif mutation=='other_preparation':payload['preparationId']=str(uuid4())
                    elif mutation=='extra':payload['extra']=True
                    else:payload['permitDigest']='0'*64
                    await db.execute('UPDATE work_events SET payload=%s WHERE task_id=%s AND revision=%s',(Jsonb(payload),f.tid,before['revision']))
            with pytest.raises(WorkConflict):await f.driver.lookup(f.wire.handle,f.action,include_output=True)
            assert f.native.calls.count('execute')==1
    asyncio.run(check())


def test_consume_event_failure_rolls_back_permit_and_never_delivers(fixture):
    async def check():
        async with connected(fixture) as f:
            real=f.store._event
            async def fail(db,task,kind,payload):
                if kind=='command.permit_issued':raise RuntimeError('synthetic event storage failure')
                return await real(db,task,kind,payload)
            with patch.object(f.store,'_event',fail),pytest.raises(RuntimeError):await execute(f)
            assert (await row(f))['state']=='issued' and not await events(f)
            assert not any(x['type']=='work.command.consume_result' for x in f.wire.sent)
            assert 'execute' not in f.native.calls
    asyncio.run(check())


def test_cancelled_lookup_returns_no_partial_bytes_and_clears_pending(fixture):
    async def check():
        async with connected(fixture,data=b'x'*30000) as f:
            await execute(f);entered=asyncio.Event()
            async def wait(frame):
                if frame['type']=='work.command.output_ack':
                    entered.set();await asyncio.Event().wait()
            f.wire.before=wait
            lookup=asyncio.create_task(f.driver.lookup(f.wire.handle,f.action,include_output=True))
            await asyncio.wait_for(entered.wait(),2);lookup.cancel()
            with pytest.raises(asyncio.CancelledError):await lookup
            assert not f.inbox.sessions and not f.wire.handle.items and f.native.calls.count('execute')==1
    asyncio.run(check())


def test_lost_consume_sql_ack_is_lookup_only_without_second_permit(fixture):
    async def check():
        async with connected(fixture) as f:
            real=f.adapter.consume
            async def lost(*args,**kwargs):
                await real(*args,**kwargs)
                raise RuntimeError('synthetic SQL commit ACK lost')
            with patch.object(f.adapter,'consume',lost),pytest.raises(RuntimeError):await execute(f)
            assert (await row(f))['state']=='consumed' and len(await events(f))==1
            assert 'execute' not in f.native.calls
            assert not any(x['type']=='work.command.consume_result' for x in f.wire.sent)
            with pytest.raises(WorkConflict,match='command_approval_required'):await execute(f)
            assert len(await events(f))==1 and f.native.calls.count('prepare')==1
    asyncio.run(check())


def test_lookup_without_output_does_not_transfer_bytes(fixture):
    async def check():
        async with connected(fixture) as f:
            await execute(f)
            outcome=await f.driver.lookup(f.wire.handle,f.action,include_output=False)
            assert outcome['output']==b'' and outcome['receipt']['observation']['outputs']==[]
            assert not any(x['type']=='work.command.output_chunk' for x in f.wire.received)
    asyncio.run(check())


def test_receipt_expiry_after_last_chunk_rejects_whole_observation(fixture):
    async def check():
        async with connected(fixture,data=b'x'*30000) as f:
            await execute(f)
            import openbot_server.work_command_channel as module
            real=module.now_ms
            async def late(db):return await real(db)+60000
            async def before(frame):
                if frame['type']=='work.command.output_ack' and frame['payload']['nextOffset']==30000:
                    patcher.start()
            patcher=patch.object(module,'now_ms',late);f.wire.before=before
            try:
                with pytest.raises(CommandContractError):await f.driver.lookup(f.wire.handle,f.action,include_output=True)
            finally:patcher.stop()
            assert f.native.calls.count('execute')==1
    asyncio.run(check())


def test_current_authority_is_checked_before_lookup_disclosure(fixture):
    async def check():
        async with connected(fixture) as f:
            await execute(f);await f.store.cancel(f.token,f.tid)
            with pytest.raises(WorkConflict):await f.driver.lookup(f.wire.handle,f.action,include_output=True)
            assert 'lookup' not in f.native.calls and f.native.calls.count('execute')==1
    asyncio.run(check())


def test_inbox_disconnect_wakes_waiter_and_does_not_reuse_old_session(fixture):
    async def check():
        async with connected(fixture) as f:
            # Drop only the initial synthetic response, preserving send success. No external wait.
            entered=asyncio.Event()
            original=f.host_protocol.handle
            def silent(frame):
                result=original(frame)
                if frame['type']=='work.command.prepare_open':entered.set();return []
                return result
            with patch.object(f.host_protocol,'handle',silent):
                task=asyncio.create_task(execute(f));await asyncio.wait_for(entered.wait(),2)
                f.wire.disconnect()
                with pytest.raises(WorkConflict,match='command_exchange_closed'):await task
            assert not f.inbox.sessions and not f.wire.handle.items and not f.native.calls
    asyncio.run(check())
