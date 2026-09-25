"""Real-PG control disclosure/Owner stop, using the owned command fixture and synthetic Host."""
import asyncio
from dataclasses import replace
from uuid import uuid4
import pytest

from test_work_command_store import fixture, setup, approve, admit, consume, row, preparation_row
from openbot_server.authority import AuthenticationRequired
from openbot_server.work_claims import claim
from openbot_server.work_command_contract import CommandContractError
from openbot_server.work_values import WorkConflict


async def control(f, operation='lookup', **kwargs):
    binding=(await preparation_row(f))['binding']
    pending=f.host.begin_control(binding,request_id=str(uuid4()),operation=operation)
    challenge=pending.challenge(f.enforcer,audience='control')
    args=dict(request_id=pending.request_id,nonce=pending.nonce)
    if operation=='lookup':
        result=await f.adapter.authorize_lookup(f.transport.connection,f.action,challenge,include_output=kwargs.pop('include_output',True),**args,**kwargs)
    else:
        result=await f.adapter.authorize_owner_stop(kwargs.pop('owner_token',f.token),f.transport.connection,f.action,challenge,**args,**kwargs)
    pending.accept_control(result['token'],f.verifier,issuer='control',audience='enforcement')
    return pending


async def running(fixture):
    f=await setup(fixture);await approve(f);issued=await admit(f);await consume(f,issued['ticket']);return f


def test_lookup_binds_original_and_disclosure_window_without_changing_dispatch(fixture):
    async def check():
        f=await running(fixture);before=await row(f)
        pending=await control(f);value=pending.check_control(require_output=True)
        assert value.dispatch.dispatchId==str(before['dispatch_id'])
        assert value.dispatch.hardDeadlineMs==before['hard_deadline_ms']
        assert 0<value.expiresAtMs-value.issuedAtMs<=30000
        assert await row(f)==before
        f.host_time[0]+=31000000;f.host_time[1]+=31000000
        with pytest.raises(CommandContractError):pending.check_control(require_output=True)
    asyncio.run(check())


@pytest.mark.parametrize('changed',['cancel','membership','node','connection','reclaim','file','generation','model','clock'])
def test_lookup_rechecks_current_authority(fixture,changed):
    async def check():
        f=await running(fixture);before=await row(f)
        if changed=='cancel':await f.store.cancel(f.token,f.tid)
        elif changed=='model':await f.connections.update(f.token,f.model['id'],dict(expectedRevision=1,enabled=False))
        elif changed=='reclaim':await claim(f.store,f.tid,f.rid,'another-activity')
        elif changed=='connection':f.transport.live=replace(f.transport.live,connection_id=str(uuid4()))
        elif changed=='clock':f.adapter.prepare_clock.broken=True
        elif changed=='file':
            async with f.files.lock():
                # Exact fixture attachment only; a same-length mutation must also revoke disclosure.
                content=next(p for p in f.filebase.rglob('*') if p.is_file() and p.read_bytes()==b'x,y\n')
                content.write_bytes(b'x,z\n')
        else:
            async with f.store._transaction(trusted=True) as db:
                if changed=='membership':await db.execute('DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s',(f.channel,f.bot))
                elif changed=='node':await db.execute('UPDATE node_credentials SET revoked_at=clock_timestamp() WHERE node_id=%s',(f.node,))
                else:await db.execute('UPDATE work_tasks SET authority_generation=authority_generation+1 WHERE id=%s',(f.tid,))
        from openbot_server.control_errors import ControlError
        with pytest.raises((WorkConflict,ControlError)):await control(f)
        assert await row(f)==before
    asyncio.run(check())


def test_unconsumed_lookup_cannot_disclose_output(fixture):
    async def check():
        f=await setup(fixture);await approve(f);await admit(f)
        with pytest.raises(WorkConflict):await control(f)
        pending=await control(f,include_output=False)
        assert pending.check_control().includeOutput is False
        with pytest.raises(CommandContractError):pending.check_control(require_output=True)
    asyncio.run(check())


def test_owner_stop_survives_cancel_and_membership_removal_without_output(fixture):
    async def check():
        f=await running(fixture);before=await row(f)
        await f.store.cancel(f.token,f.tid)
        async with f.store._transaction(trusted=True) as db:await db.execute('DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s',(f.channel,f.bot))
        pending=await control(f,'stop');value=pending.check_control()
        assert value.operation=='stop' and value.expiresAtMs-value.issuedAtMs==5000
        with pytest.raises(CommandContractError):pending.check_control(require_output=True)
        assert await row(f)==before
    asyncio.run(check())


@pytest.mark.parametrize('owner_token',[None,'synthetic-invalid-owner'])
def test_stop_requires_current_owner(fixture,owner_token):
    async def check():
        f=await running(fixture);before=await row(f)
        with pytest.raises(AuthenticationRequired):await control(f,'stop',owner_token=owner_token)
        assert await row(f)==before
    asyncio.run(check())


@pytest.mark.parametrize('operation',['lookup','stop'])
def test_wrong_challenge_operation_or_request_refuses(fixture,operation):
    async def check():
        f=await running(fixture);binding=(await preparation_row(f))['binding']
        p=f.host.begin_control(binding,request_id=str(uuid4()),operation=operation)
        challenge=p.challenge(f.enforcer,audience='control')
        method=f.adapter.authorize_lookup if operation=='stop' else f.adapter.authorize_owner_stop
        args=(f.transport.connection,f.action,challenge) if operation=='stop' else (f.token,f.transport.connection,f.action,challenge)
        extra={'include_output':False} if operation=='stop' else {}
        with pytest.raises(WorkConflict,match='operation_changed'):
            await method(*args,request_id=p.request_id,nonce=p.nonce,**extra)
        with pytest.raises(CommandContractError):
            await method(*args,request_id=str(uuid4()),nonce=p.nonce,**extra)
    asyncio.run(check())
