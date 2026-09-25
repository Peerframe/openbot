"""Real PostgreSQL Work transactions; explicit synthetic SDK, protected readiness and socket seams."""
import asyncio
from contextlib import asynccontextmanager, contextmanager
from copy import deepcopy
from dataclasses import replace
import json
import hashlib
import os
from pathlib import Path
import secrets
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PrivateFormat, PublicFormat, NoEncryption
import psycopg
from psycopg.types.json import Jsonb
import pytest

from openbot_server.owner_files import OwnerFiles
from openbot_server.work_command_inputs import CommandInputScope
from openbot_server.model_connections import ModelConnectionsService
from openbot_server.model_connections_cipher import ModelCredentialCipher
from openbot_server.work_claims import claim
from openbot_server.work_command_contract import CommandContractError
from openbot_server.work_command_crypto import VerificationPin
from openbot_server.work_command_v2_crypto import CommandV2Signer as TokenSigner, CommandV2Verifier as TokenVerifier, HostExchangeBook
from openbot_server.work_command_preparation import ServerPrepareClock
from openbot_server.work_command_profiles import CommandProfiles
from openbot_server.work_command_store import CommandDispatches, LiveCommandConnection, now_ms, sha
from openbot_server.work_corrections import CorrectionStore
from openbot_server.work_engine_binding import EngineActivityFacts
from openbot_server.work_handoff import HandoffStore
from openbot_server.work_store import PostgresWorkStore
from openbot_server.work_temporal_activity import derive_claim_id
from openbot_server.work_temporal_start import WorkRuntimeContext
from openbot_server.work_values import WorkConflict

SCOPE=dict(expected_namespace='synthetic',expected_queue='command-test',expected_workflow_type='command-test')

@pytest.fixture
def fixture():
    from urllib.parse import urlparse
    path=os.environ.get('OPENBOT_COMMAND_TEST_FIXTURE')
    if not path: pytest.skip('Owned command fixture required')
    data=json.loads(Path(path).read_text())
    assert data['fixtureKind']=='work-command-authority'
    data['_created_connections']=[]
    assert urlparse(data['dsn']).hostname=='127.0.0.1' and urlparse(data['dsn']).path.startswith('/openbot_control_test_')
    yield data
    with psycopg.connect(data['dsn']) as db:
        db.execute('DELETE FROM model_connections WHERE id=ANY(%s)',(data['_created_connections'],))


class Transport:
    """Synthetic one current connection; the product registry seam remains unregistered."""
    def __init__(self,live): self.live=live;self.connection=object();self.lock=asyncio.Lock();self.online=True
    @asynccontextmanager
    async def guard(self,connection):
        async with self.lock:
            if not self.online or connection is not self.connection: raise WorkConflict('command_connection_changed')
            yield self.live


def key(issuer,kid,role):
    value=Ed25519PrivateKey.generate()
    signer=TokenSigner(issuer=issuer,kid=kid,role=role,
        private_pem=value.private_bytes(Encoding.PEM,PrivateFormat.PKCS8,NoEncryption()))
    return signer,VerificationPin(issuer,kid,role,value.public_key().public_bytes(Encoding.PEM,PublicFormat.SubjectPublicKeyInfo))


async def setup(fixture):
    f=SimpleNamespace(**fixture)
    f.bot,f.channel,f.message,f.source,f.node=[str(uuid4()) for _ in range(5)]
    f.filebase=Path(os.environ['OPENBOT_COMMAND_TEST_FIXTURE']).parent/f.bot
    f.filebase.mkdir(mode=0o700);f.files=OwnerFiles(f.filebase)
    async with f.files.lock():f.attachment=f.files.persist(f.channel,'input.csv',b'x,y\n')
    f.objective='Synthetic command\n[OpenBot attachment: '+f.attachment['id']+']'
    f.store=PostgresWorkStore(f.dsn)
    f.connections=ModelConnectionsService(f.dsn,ModelCredentialCipher(bytes(range(32))))
    f.model=await f.connections.create(f.token,dict(name='Synthetic '+uuid4().hex,presetId='openai',
        baseUrl='https://api.openai.com/v1',apiKey='synthetic-never-network'))
    f._created_connections.append(f.model['id'])
    f.selection=dict(connectionId=f.model['id'],modelId='synthetic-model')
    f.credential=secrets.token_hex(32)
    f.command=json.loads(Path(os.environ.get('OPENBOT_COMMAND_VECTOR_FILE',Path(__file__).parent/'fixtures/work_command_vectors.json')).read_text())['intent']['command']
    f.command['inputManifest']=[dict(path='input.csv',size=4,sha256=f.attachment['sha256'])]
    f.command['inputDigest']='sha256:'+hashlib.sha256(json.dumps(f.command['inputManifest'],sort_keys=True,separators=(',',':')).encode()).hexdigest()
    f.policy=dict(image=f.command['image'],limits=deepcopy(f.command['limits']))
    f.profiles=CommandProfiles(f.connections,policies={'offline-command':f.policy})
    f.route=dict(nodeId=f.node,providerId='linux-command',enforcementKeyId='enforcer-1',ledgerId=str(uuid4()))
    async with f.store._control.transaction() as db:
        await db.execute("INSERT INTO bots(id,name,role,computer_profile,configuration) VALUES(%s,%s,'assistant','docker-linux',%s)",
            (f.bot,'Synthetic '+f.bot,Jsonb({'model':f.selection})))
        await db.execute("INSERT INTO channels(id,name) VALUES(%s,%s)",(f.channel,'Synthetic '+f.channel))
        await db.execute('INSERT INTO channel_bots(channel_id,bot_id) VALUES(%s,%s)',(f.channel,f.bot))
        await db.execute("INSERT INTO messages(id,channel_id,author_type,content) VALUES(%s,%s,'human',%s)",(f.message,f.channel,f.objective))
        await db.execute("INSERT INTO runs(id,channel_id,bot_id,title,source_message_id,instruction,execution_profile,model_selection) "
            "VALUES(%s,%s,%s,'Synthetic',%s,%s,'docker-linux',NULL)",(f.source,f.channel,f.bot,f.message,f.objective))
        await db.execute('INSERT INTO node_credentials(node_id,credential_digest,enrolled_at) VALUES(%s,%s,clock_timestamp())',(f.node,f.credential))
        f.task=await f.store.create_in_transaction(db,bot_id=f.bot,objective=f.objective,token_limit=1000,request_key=uuid4().hex,source=True)
        f.tid=f.task['id'];f.rid=f.task['runs'][0]['id']
        await db.execute('INSERT INTO work_sources VALUES(%s,%s,%s,%s)',(f.tid,f.source,f.channel,f.message))
        await db.execute('UPDATE work_runs SET corrections_enabled=true WHERE id=%s',(f.rid,))
        task=await f.store._task(db,f.tid)
        f.digest=await f.profiles.capture_in_transaction(db,task,route=f.route,credential_digest=f.credential,policy_id='offline-command')
    f.handoff=HandoffStore(f.store)
    ref='temporal:synthetic:openbot-work-v1-'+f.rid
    reservation=await f.handoff.reserve_submission(f.tid,f.rid,ref)
    await f.handoff.acknowledge(f.tid,f.rid,ref,reservation.attempt_id,'synthetic-engine')
    f.facts=EngineActivityFacts(namespace='synthetic',queue='command-test',start_queue='command-test',workflow_id='openbot-work-v1-'+f.rid,
        workflow_type='command-test',engine_run_id='synthetic-engine',first_run_id='synthetic-engine',
        start_input=dict(taskId=f.tid,runId=f.rid,attemptId=reservation.attempt_id))
    f.activity='synthetic-command-activity'
    f.fence=await claim(f.store,f.tid,f.rid,derive_claim_id('synthetic',f.facts.workflow_id,f.facts.engine_run_id,f.activity))
    correction=await CorrectionStore(f.store).freeze(f.tid,f.rid,'initial')
    f.context=WorkRuntimeContext(f.tid,f.rid,f.bot,f.objective,1000,correction['id'])
    f.intent=dict(kind='work_command',version=1,profileDigest=f.digest,command=f.command)
    f.action=await f.store.propose(f.tid,f.rid,fence=f.fence,action_key='command-1',intent=f.intent,reserved_tokens=0,
        correction_context=f.context.correction_token)
    f.transport=Transport(LiveCommandConnection(f.node,str(uuid4()),f.credential))
    f.signer,cpin=key('control','control-1','control');f.enforcer,epin=key('enforcement','enforcer-1','enforcement')
    f.verifier=TokenVerifier([cpin,epin])
    f.adapter=CommandDispatches(f.store,f.profiles,object(),SCOPE,f.transport,f.signer,f.verifier,
        control_issuer='control',enforcement_issuer='enforcement',input_scope=CommandInputScope(f.files),
        timing_policy=dict(prepareBudgetMs=10000,challengeBudgetMs=5000,runtimeMaxMs=40000,stopAllowanceMs=5000,
            clockRateErrorPpm=1000,clockQuantizationMs=100,policyDigest='e'*64),prepare_clock=ServerPrepareClock())
    await f.adapter.start()
    f.preparation_id=str(uuid4())
    return f


@contextmanager
def sdk(f):
    async def inspect(*args,**kwargs):return f.facts
    with patch('openbot_server.work_temporal_activity.activity_info',lambda:SimpleNamespace(activity_id=f.activity)), \
        patch('openbot_server.work_temporal_activity.inspect_activity_start',inspect):yield


async def approve(f):
    await f.store.decide(f.token,f.action,intent_digest=__import__('openbot_server.work_values',fromlist=['canonical']).canonical(f.intent)[1],approved=True)
    await prepare(f)


async def prepare(f):
    with sdk(f):
        reserved=await f.adapter.reserve(f.context,f.action,fence=f.fence,connection=f.transport.connection,
            command=f.command,attachments=[dict(path='input.csv',attachmentId=f.attachment['id'])])
    assert reserved['status']=='reserved'
    f.preparation_id=reserved['binding']['preparationId']
    f.host_time=[100000000,100000000,str(uuid4())]
    f.host=HostExchangeBook(policy=f.adapter.timing_policy.model_dump(),clock=lambda:tuple(f.host_time))
    f.pending=f.host.begin_prepare(reserved['binding'])
    f.prepare_challenge=f.pending.challenge(f.enforcer,audience='control')
    authorized=await f.adapter.authorize_preparation(f.transport.connection,f.action,f.prepare_challenge)
    assert authorized['status']=='authorized'
    f.pending.accept_authorization(authorized['authorization'],f.verifier,issuer='control',audience='enforcement')
    f.host_time[0]+=100000;f.host_time[1]+=100000
    proof=dict(bootId=f.host_time[2],enforcerInstanceId=f.host.instance_id,
        unitName='openbot-command-'+f.preparation_id.replace('-','')+'.service',invocationId='d'*32,
        cgroupPath='/system.slice/openbot-command-'+f.preparation_id.replace('-','')+'.service',cgroupInode=55,
        activeMonotonicUs=100001000,runtimeMaxUs=40000000,observedMonotonicUs=f.host_time[0],observedBoottimeUs=f.host_time[1],
        runtimeIdentityDigest='f'*64,runtimeShapeDigest='1'*64,timingPolicyDigest='e'*64,startAttempts=0)
    f.ready_token=f.pending.ready(proof,f.enforcer,audience='control')
    f.ready=await f.adapter.accept_ready(f.transport.connection,f.action,f.ready_token)
    assert f.ready['status']=='ready'


async def preparation_row(f):
    async with f.store._transaction(trusted=True) as db:
        return await (await db.execute('SELECT * FROM work_command_preparations WHERE action_id=%s',(f.action,))).fetchone()


async def admit(f):
    with sdk(f):return await f.adapter.admit(f.context,f.action,fence=f.fence,connection=f.transport.connection,preparation_id=f.preparation_id)


async def challenge(f,ticket):
    original=await f.adapter.original(f.action)
    async with f.store._transaction(trusted=True) as db: now=await now_ms(db)
    request_id=str(uuid4());nonce=secrets.token_urlsafe(32)
    claims=dict(**original['binding'],iss='enforcement',aud='control',jti=str(uuid4()),iat=now//1000,nbf=now//1000,exp=now//1000+30,
        purpose='work_command_consume',requestId=request_id,nonce=nonce,ticketDigest=sha(ticket))
    token=f.enforcer.sign(claims,purpose='work_command_consume',now_ms=now)
    return token,dict(request_id=request_id,nonce=nonce)


async def consume(f,ticket):
    token,args=await challenge(f,ticket)
    return await f.adapter.consume(f.transport.connection,f.action,token,**args)


async def row(f):
    async with f.store._transaction(trusted=True) as db:
        return await (await db.execute('SELECT * FROM work_command_dispatches WHERE action_id=%s',(f.action,))).fetchone()


def test_admission_single_consume_and_original_lookup(fixture):
    async def check():
        f=await setup(fixture)
        with pytest.raises(WorkConflict,match='action_not_authorized'):await admit(f)
        assert await row(f) is None
        await approve(f);issued=await admit(f)
        assert issued['status']=='issued' and await admit(f)=={'status':'lookup_required'}
        result=await consume(f,issued['ticket']);assert result['status']=='consumed'
        assert await consume(f,issued['ticket'])=={'status':'lookup_required'}
        original=await f.adapter.original(f.action)
        assert original['binding']['originalEpoch']==f.fence.epoch and 'ticket' not in original and 'permit' not in original
        assert original['permitClaims']['launchDeadlineMs']-original['permitClaims']['consumedAtMs']<=5000
        assert (await f.store.snapshot(f.token,f.tid))['actions'][0]['status']=='admitted'
    asyncio.run(check())


@pytest.mark.parametrize('phase',['admit','consume'])
@pytest.mark.parametrize('mutation',['membership','bot','source','node','model','policy','correction','reclaim','offline','connection'])
def test_live_authority_changes_refuse(fixture,phase,mutation):
    async def check():
        f=await setup(fixture);await approve(f)
        issued=await admit(f) if phase=='consume' else None
        if mutation=='membership':
            async with f.store._transaction(trusted=True) as db:await db.execute('DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s',(f.channel,f.bot))
        elif mutation=='bot':
            async with f.store._transaction(trusted=True) as db:await db.execute("UPDATE bots SET computer_profile='none' WHERE id=%s",(f.bot,))
        elif mutation=='source':
            async with f.store._transaction(trusted=True) as db:await db.execute("UPDATE runs SET instruction='Changed' WHERE id=%s",(f.source,))
        elif mutation=='node':
            async with f.store._transaction(trusted=True) as db:await db.execute('UPDATE node_credentials SET revoked_at=clock_timestamp() WHERE node_id=%s',(f.node,))
        elif mutation=='model':await f.connections.update(f.token,f.model['id'],dict(expectedRevision=1,enabled=False))
        elif mutation=='policy':f.profiles.policies.clear()
        elif mutation=='correction':await CorrectionStore(f.store).request(f.token,f.tid,run_id=f.rid,instruction='Changed',request_key='correction',expected_sequence=0)
        elif mutation=='reclaim':await claim(f.store,f.tid,f.rid,'another-activity')
        elif mutation=='offline':f.transport.online=False
        elif mutation=='connection':f.transport.live=replace(f.transport.live,credential_digest='a'*64)
        from openbot_server.control_errors import ControlError
        with pytest.raises((WorkConflict,ControlError)):
            await consume(f,issued['ticket']) if phase=='consume' else await admit(f)
        record=await row(f)
        assert record is None if phase=='admit' else record['state']=='issued'
    asyncio.run(check())


def test_parallel_admission_and_consume_have_one_winner(fixture):
    async def check():
        f=await setup(fixture);await approve(f)
        with sdk(f):
            results=await asyncio.gather(*(f.adapter.admit(f.context,f.action,fence=f.fence,connection=f.transport.connection,preparation_id=f.preparation_id) for _ in range(4)))
        assert [r['status'] for r in results].count('issued')==1
        issued=next(r for r in results if r['status']=='issued')
        # Independent transport locks simulate concurrent requests to the DB boundary itself.
        @asynccontextmanager
        async def unlocked(_=None):yield f.transport.live
        f.transport.guard=unlocked
        f.adapter.input_scope.lock=unlocked
        token,args=await challenge(f,issued['ticket'])
        results=await asyncio.gather(*(f.adapter.consume(f.transport.connection,f.action,token,**args) for _ in range(4)))
        assert [r['status'] for r in results].count('consumed')==1
        assert [r['status'] for r in results].count('lookup_required')==3
    asyncio.run(check())


@pytest.mark.parametrize('close',['cancel','revoke','unknown'])
def test_original_survives_closure_without_new_execution(fixture,close):
    async def check():
        f=await setup(fixture);await approve(f);issued=await admit(f)
        original=(await f.adapter.original(f.action))['binding']
        if close=='unknown':await f.store.uncertain(f.action)
        else:await getattr(f.store,close)(f.token,f.tid)
        if close=='unknown':assert await consume(f,issued['ticket'])=={'status':'lookup_required'}
        else:
            with pytest.raises(WorkConflict):await consume(f,issued['ticket'])
        assert (await f.adapter.original(f.action))['binding']==original
        snapshot=await f.store.snapshot(f.token,f.tid)
        assert snapshot['actions'][0]['status']==('unknown' if close=='unknown' else 'admitted')
    asyncio.run(check())


@pytest.mark.parametrize('after_consume',[False,True])
def test_close_only_unconsumed(fixture,after_consume):
    async def check():
        f=await setup(fixture);await approve(f);issued=await admit(f)
        if after_consume:await consume(f,issued['ticket'])
        before=await row(f)
        async with f.store._transaction(trusted=True) as db:
            task=await f.store._task(db,f.tid)
            await f.adapter.close_unconsumed_in_transaction(db,task,'cancel')
        after=await row(f)
        assert after['state']==('consumed' if after_consume else 'closed')
        if after_consume:assert after==before
        assert await consume(f,issued['ticket'])=={'status':'lookup_required'}
    asyncio.run(check())


@pytest.mark.parametrize('stage',['dispatch_insert','consume_update'])
def test_sql_failure_rolls_back_authority_atomically(fixture,stage):
    async def check():
        f=await setup(fixture);await approve(f)
        issued=await admit(f) if stage=='consume_update' else None
        name='reject_'+uuid4().hex
        with psycopg.connect(f.dsn) as db:
            db.execute(f"CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic rollback'; END $$")
            db.execute(f"CREATE TRIGGER {name} BEFORE {'INSERT' if stage=='dispatch_insert' else 'UPDATE'} ON work_command_dispatches "
                f"FOR EACH ROW WHEN (NEW.action_id='{f.action}') EXECUTE FUNCTION {name}()")
        from openbot_server.database import StoreUnavailable
        try:
            with pytest.raises(StoreUnavailable):await consume(f,issued['ticket']) if issued else await admit(f)
            record=await row(f);snapshot=await f.store.snapshot(f.token,f.tid)
            assert record is None if not issued else record['state']=='issued'
            assert snapshot['actions'][0]['status']==('proposed' if not issued else 'admitted')
        finally:
            with psycopg.connect(f.dsn) as db:db.execute(f'DROP TRIGGER {name} ON work_command_dispatches');db.execute(f'DROP FUNCTION {name}()')
    asyncio.run(check())


@pytest.mark.parametrize('mutation',['first_run','attempt','queue','activity','context','input_digest','expired_native'])
def test_invalid_original_binding_refuses_admission(fixture,mutation):
    async def check():
        f=await setup(fixture);await approve(f)
        if mutation=='first_run':f.facts=replace(f.facts,first_run_id='wrong')
        elif mutation=='attempt':f.facts=replace(f.facts,start_input={**f.facts.start_input,'attemptId':'a'*32})
        elif mutation=='queue':f.facts=replace(f.facts,queue='wrong')
        elif mutation=='activity':f.activity='wrong'
        elif mutation=='context':f.context=replace(f.context,objective='wrong')
        elif mutation=='input_digest':
            async with f.store._transaction(trusted=True) as db:await db.execute("UPDATE work_command_preparations SET input_scope=jsonb_set(input_scope,'{inputDigest}','\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"') WHERE action_id=%s",(f.action,))
        elif mutation=='expired_native':
            async with f.store._transaction(trusted=True) as db:await db.execute('UPDATE work_command_preparations SET native_deadline_ms=native_deadline_ms-1000 WHERE action_id=%s',(f.action,))
        with pytest.raises((WorkConflict,CommandContractError)):await admit(f)
        assert await row(f) is None
    asyncio.run(check())


def test_no_sdk_context_and_no_readiness_fail_closed(fixture):
    async def check():
        f=await setup(fixture);await approve(f)
        with pytest.raises(RuntimeError):await f.adapter.admit(f.context,f.action,fence=f.fence,connection=f.transport.connection,preparation_id=f.preparation_id)
        with pytest.raises(WorkConflict):await f.adapter.admit(f.context,f.action,fence=f.fence,connection=f.transport.connection,preparation_id={})
        assert await row(f) is None
    asyncio.run(check())


def test_new_bot_selection_does_not_change_snapshot(fixture):
    async def check():
        f=await setup(fixture);await approve(f)
        async with f.store._transaction(trusted=True) as db:
            await db.execute('UPDATE bots SET configuration=%s WHERE id=%s',(Jsonb({'model':{'connectionId':'wrong','modelId':'wrong'}}),f.bot))
        issued=await admit(f);assert (await consume(f,issued['ticket']))['status']=='consumed'
    asyncio.run(check())


def test_ticket_replacement_is_refused(fixture):
    async def check():
        f=await setup(fixture);await approve(f);await admit(f)
        with pytest.raises(WorkConflict,match='command_ticket_changed'):await consume(f,'wrong')
        assert (await row(f))['state']=='issued'
    asyncio.run(check())


@pytest.mark.parametrize('winner',['cancel','consume'])
def test_cancel_and_consume_linearize_on_existing_task_lock(fixture,winner):
    async def check():
        f=await setup(fixture);await approve(f);issued=await admit(f)
        token,args=await challenge(f,issued['ticket'])
        locked=asyncio.Event();release=asyncio.Event()
        if winner=='consume':
            previous=f.profiles.resolve_in_transaction
            async def pause(db,task):
                value=await previous(db,task);locked.set();await release.wait();return value
            f.profiles.resolve_in_transaction=pause
            first=asyncio.create_task(f.adapter.consume(f.transport.connection,f.action,token,**args))
            await locked.wait()
            second=asyncio.create_task(f.store.cancel(f.token,f.tid))
        else:
            previous=f.store._task
            async def pause(db,tid,**kwargs):
                value=await previous(db,tid,**kwargs)
                if not locked.is_set():locked.set();await release.wait()
                return value
            f.store._task=pause
            first=asyncio.create_task(f.store.cancel(f.token,f.tid))
            await locked.wait()
            second=asyncio.create_task(f.adapter.consume(f.transport.connection,f.action,token,**args))
        await asyncio.sleep(.03)
        assert not second.done()
        release.set();result=await first
        if winner=='consume':
            assert result['status']=='consumed';await second
            assert (await row(f))['state']=='consumed'
        else:
            with pytest.raises(WorkConflict):await second
            assert (await row(f))['state']=='issued'
        snapshot=await f.store.snapshot(f.token,f.tid)
        assert snapshot['cancelRequested'] and snapshot['actions'][0]['status']=='admitted'
    asyncio.run(check())


def test_current_sdk_environment_uses_exact_original_history(fixture):
    from temporalio.testing import ActivityEnvironment
    async def check():
        f=await setup(fixture);await approve(f);handles=[]
        class Converter:
            async def decode(self,payloads,types):
                assert payloads==['synthetic'] and types==[dict];return [f.facts.start_input]
        class History:
            async def fetch_history_events(self,*,page_size):
                assert page_size==1
                yield SimpleNamespace(HasField=lambda field:field=='workflow_execution_started_event_attributes',
                    workflow_execution_started_event_attributes=SimpleNamespace(
                        workflow_type=SimpleNamespace(name='command-test'),task_queue=SimpleNamespace(name='command-test'),
                        input=SimpleNamespace(payloads=['synthetic']),workflow_id=f.facts.workflow_id,
                        first_execution_run_id='synthetic-engine'))
        class Client:
            namespace='synthetic';data_converter=Converter()
            def get_workflow_handle(self,workflow_id,run_id=None):handles.append((workflow_id,run_id));return History()
        f.adapter.client=Client()
        environment=ActivityEnvironment()
        environment.info=replace(environment.info,activity_id=f.activity,namespace='synthetic',task_queue='command-test',
            workflow_id=f.facts.workflow_id,workflow_type='command-test',workflow_run_id='synthetic-engine')
        issued=await environment.run(f.adapter.admit,f.context,f.action,fence=f.fence,connection=f.transport.connection,preparation_id=f.preparation_id)
        assert issued['status']=='issued' and handles==[(f.facts.workflow_id,'synthetic-engine')]
        assert (await consume(f,issued['ticket']))['status']=='consumed'
        environment.info=replace(environment.info,task_queue='wrong')
        with pytest.raises(WorkConflict):await environment.run(f.adapter.admit,f.context,f.action,fence=f.fence,connection=f.transport.connection,preparation_id=f.preparation_id)
    asyncio.run(check())


@pytest.mark.parametrize('mutation',['claim','proof','intent','operation','anchors','route'])
def test_corrupt_original_row_never_consumes(fixture,mutation):
    async def check():
        f=await setup(fixture);await approve(f);issued=await admit(f)
        token,args=await challenge(f,issued['ticket'])
        async with f.store._transaction(trusted=True) as db:
            if mutation=='claim':await db.execute("UPDATE work_command_dispatches SET original_claim_id='wrong' WHERE action_id=%s",(f.action,))
            elif mutation=='proof':await db.execute("UPDATE work_command_dispatches SET engine_proof=jsonb_set(engine_proof,'{facts,first_run_id}','\"wrong\"') WHERE action_id=%s",(f.action,))
            elif mutation=='intent':await db.execute("UPDATE work_command_dispatches SET intent_digest=%s WHERE action_id=%s",('a'*64,f.action))
            elif mutation=='operation':await db.execute("UPDATE work_command_dispatches SET operation=jsonb_set(operation,'{command,argv}','[\"changed\"]') WHERE action_id=%s",(f.action,))
            elif mutation=='anchors':await db.execute('UPDATE work_command_dispatches SET root_deadline_ms=root_deadline_ms+1000 WHERE action_id=%s',(f.action,))
            elif mutation=='route':await db.execute("UPDATE work_command_dispatches SET dispatch_claims=jsonb_set(dispatch_claims,'{providerId}','\"wrong\"') WHERE action_id=%s",(f.action,))
        with pytest.raises((WorkConflict,CommandContractError)):
            await f.adapter.consume(f.transport.connection,f.action,token,**args)
        assert (await row(f))['state']=='issued'
    asyncio.run(check())


@pytest.mark.parametrize('mutation',['missing','invalid','singleton','native','source_message','identity'])
def test_profile_capture_has_no_fallback(fixture,mutation):
    async def check():
        f=await setup(fixture)
        async with f.store._transaction(trusted=True) as db:
            task=await f.store._task(db,f.tid)
            await db.execute('DELETE FROM work_command_profiles WHERE task_id=%s',(f.tid,))
            if mutation in ('missing','invalid','singleton'):
                value={} if mutation=='missing' else {'model':{'connectionId':'wrong','modelId':'x'}} if mutation=='invalid' else {'model':None}
                await db.execute('UPDATE bots SET configuration=%s WHERE id=%s',(Jsonb(value),f.bot))
            elif mutation=='native':await db.execute('DELETE FROM work_sources WHERE task_id=%s',(f.tid,))
            elif mutation=='source_message':await db.execute('UPDATE runs SET source_message_id=NULL WHERE id=%s',(f.source,))
            elif mutation=='identity':await db.execute('UPDATE node_credentials SET credential_digest=%s WHERE node_id=%s',('b'*64,f.node))
            from openbot_server.control_errors import ControlError
            with pytest.raises((WorkConflict,CommandContractError,ControlError)):
                await f.profiles.capture_in_transaction(db,task,route=f.route,credential_digest=f.credential,policy_id='offline-command')
            assert await (await db.execute('SELECT 1 FROM work_command_profiles WHERE task_id=%s',(f.tid,))).fetchone() is None
    asyncio.run(check())


def test_recovery_cannot_move_fixed_deadline_or_dispatch(fixture):
    async def check():
        f=await setup(fixture);await approve(f)
        before_prepare=await preparation_row(f)
        duplicate=await f.adapter.accept_ready(f.transport.connection,f.action,f.ready_token)
        assert duplicate==f.ready and await preparation_row(f)==before_prepare
        issued=await admit(f);before=await row(f)
        await claim(f.store,f.tid,f.rid,'recovery')
        assert (await f.adapter.original(f.action))['binding']['originalEpoch']==1
        with pytest.raises(WorkConflict):await consume(f,issued['ticket'])
        with sdk(f),pytest.raises(WorkConflict):await f.adapter.reserve(f.context,f.action,fence=f.fence,connection=f.transport.connection,
            command=f.command,attachments=[dict(path='input.csv',attachmentId=f.attachment['id'])])
        assert await row(f)==before and await preparation_row(f)==before_prepare
    asyncio.run(check())


def test_consumed_result_is_only_lookup_even_after_cancel(fixture):
    async def check():
        f=await setup(fixture);await approve(f);issued=await admit(f)
        await consume(f,issued['ticket']);before=await row(f)
        await f.store.cancel(f.token,f.tid)
        assert await consume(f,issued['ticket'])=={'status':'lookup_required'}
        assert await row(f)==before
    asyncio.run(check())


@pytest.mark.parametrize('phase',['admit','consume'])
@pytest.mark.parametrize('mutation',['bytes','delete','metadata','reference','manifest','task','run','generation','seal'])
def test_input_scope_is_mandatory_original_and_revalidated(fixture,phase,mutation):
    async def check():
        f=await setup(fixture);await approve(f)
        issued=await admit(f) if phase=='consume' else None
        if mutation=='bytes':
            async with f.files.lock():f.files._write(f.attachment['id']+'.bin',b'evil')
        elif mutation=='delete':
            async with f.files.lock():f.files.set_deleted(f.channel,f.attachment['id'],True)
        elif mutation=='metadata':
            async with f.files.lock():
                value=f.files.metadata(f.channel,f.attachment['id']);value['name']='renamed.csv'
                f.files._write(f.attachment['id']+'.json',json.dumps(value).encode())
        elif mutation=='reference':
            async with f.files.lock():
                value=f.files.metadata(f.channel,f.attachment['id']);value['channelId']=str(uuid4())
                f.files._write(f.attachment['id']+'.json',json.dumps(value).encode())
        else:
            receipt=(await preparation_row(f))['input_scope']
            if mutation=='manifest':receipt['items'][0]['sha256']='a'*64
            elif mutation=='task':receipt['taskId']=str(uuid4())
            elif mutation=='run':receipt['runId']=str(uuid4())
            elif mutation=='generation':receipt['generation']+=1
            elif mutation=='seal':receipt['kind']='untrusted'
            if phase=='admit':
                async with f.store._transaction(trusted=True) as db:
                    await db.execute('UPDATE work_command_preparations SET input_scope=%s WHERE action_id=%s',(Jsonb(receipt),f.action))
            else:
                async with f.store._transaction(trusted=True) as db:
                    await db.execute('UPDATE work_command_dispatches SET input_scope=%s WHERE action_id=%s',(Jsonb(receipt),f.action))
        from openbot_server.control_errors import ControlError
        with pytest.raises((WorkConflict,ControlError)):
            await consume(f,issued['ticket']) if issued else await admit(f)
        record=await row(f)
        assert record is None if phase=='admit' else record['state']=='issued'
    asyncio.run(check())


def test_foreign_or_unreferenced_attachment_cannot_prepare(fixture):
    async def check():
        f=await setup(fixture)
        await f.store.decide(f.token,f.action,intent_digest=__import__('openbot_server.work_values',fromlist=['canonical']).canonical(f.intent)[1],approved=True)
        async with f.files.lock():other=f.files.persist(f.channel,'input.csv',b'x,y\n')
        with sdk(f),pytest.raises(WorkConflict,match='command_input_scope_changed'):
            await f.adapter.reserve(f.context,f.action,fence=f.fence,connection=f.transport.connection,command=f.command,
                attachments=[dict(path='input.csv',attachmentId=other['id'])])
    asyncio.run(check())


@pytest.mark.parametrize('field,value',[('action_id','wrong'),('original_epoch',2),('operation_fingerprint','a'*64)])
def test_preparation_never_crosses_original_operation(fixture,field,value):
    async def check():
        f=await setup(fixture);await approve(f)
        key={'action_id':'actionId','original_epoch':'originalEpoch','operation_fingerprint':'operationFingerprint'}[field]
        if key=='actionId': f.preparation_id=str(uuid4())
        else:
            async with f.store._transaction(trusted=True) as db:
                await db.execute('UPDATE work_command_preparations SET binding=jsonb_set(binding,%s,%s) WHERE action_id=%s',([key],Jsonb(value),f.action))
        with pytest.raises(WorkConflict):await admit(f)
        assert await row(f) is None
    asyncio.run(check())


def test_command_never_accepts_implicit_approval(fixture):
    async def check():
        f=await setup(fixture)
        async with f.store._transaction(trusted=True) as db:
            await db.execute("UPDATE work_actions SET requires_approval=false,decision='not_required' WHERE id=%s",(f.action,))
        with pytest.raises(WorkConflict,match='command_approval_required'):await admit(f)
        assert await row(f) is None
    asyncio.run(check())


@pytest.mark.parametrize('anchor',['action','claim'])
def test_dispatch_ticket_cannot_outlive_original_permission(fixture,anchor):
    async def check():
        f=await setup(fixture);await approve(f)
        async with f.store._transaction(trusted=True) as db:
            if anchor=='action':await db.execute("UPDATE work_actions SET expires_at=clock_timestamp()+interval '10 seconds' WHERE id=%s",(f.action,))
            else:await db.execute("UPDATE work_claims SET expires_at=clock_timestamp()+interval '10 seconds' WHERE run_id=%s",(f.rid,))
        await admit(f);record=await row(f)
        assert record['expires_at_ms']<=record['issued_at_ms']+10000
    asyncio.run(check())


async def stage(f,*,authorize=True):
    await f.store.decide(f.token,f.action,intent_digest=__import__('openbot_server.work_values',fromlist=['canonical']).canonical(f.intent)[1],approved=True)
    with sdk(f):reserved=await f.adapter.reserve(f.context,f.action,fence=f.fence,connection=f.transport.connection,
        command=f.command,attachments=[dict(path='input.csv',attachmentId=f.attachment['id'])])
    f.preparation_id=reserved['binding']['preparationId'];f.host_time=[100000000,100000000,str(uuid4())]
    f.host=HostExchangeBook(policy=f.adapter.timing_policy.model_dump(),clock=lambda:tuple(f.host_time))
    f.pending=f.host.begin_prepare(reserved['binding']);f.prepare_challenge=f.pending.challenge(f.enforcer,audience='control')
    if not authorize:return
    answer=await f.adapter.authorize_preparation(f.transport.connection,f.action,f.prepare_challenge)
    f.pending.accept_authorization(answer['authorization'],f.verifier,issuer='control',audience='enforcement')
    f.host_time[0]+=100000;f.host_time[1]+=100000
    f.proof=dict(bootId=f.host_time[2],enforcerInstanceId=f.host.instance_id,
        unitName='openbot-command-'+f.preparation_id.replace('-','')+'.service',invocationId='d'*32,
        cgroupPath='/system.slice/openbot-command-'+f.preparation_id.replace('-','')+'.service',cgroupInode=55,
        activeMonotonicUs=100001000,runtimeMaxUs=40000000,observedMonotonicUs=f.host_time[0],observedBoottimeUs=f.host_time[1],
        runtimeIdentityDigest='f'*64,runtimeShapeDigest='1'*64,timingPolicyDigest='e'*64,startAttempts=0)
    f.ready_token=f.pending.ready(f.proof,f.enforcer,audience='control')


def test_preparation_is_approved_and_reserved_once(fixture):
    async def check():
        f=await setup(fixture)
        with sdk(f),pytest.raises(WorkConflict,match='command_approval_required'):
            await f.adapter.reserve(f.context,f.action,fence=f.fence,connection=f.transport.connection,command=f.command,
                attachments=[dict(path='input.csv',attachmentId=f.attachment['id'])])
        assert await preparation_row(f) is None
        await f.store.decide(f.token,f.action,intent_digest=__import__('openbot_server.work_values',fromlist=['canonical']).canonical(f.intent)[1],approved=True)
        with sdk(f):results=await asyncio.gather(*(f.adapter.reserve(f.context,f.action,fence=f.fence,connection=f.transport.connection,
            command=f.command,attachments=[dict(path='input.csv',attachmentId=f.attachment['id'])]) for _ in range(4)))
        assert [r['status'] for r in results].count('reserved')==1
        assert [r['status'] for r in results].count('lookup_required')==3
        assert (await preparation_row(f))['binding']['originalEpoch']==1
    asyncio.run(check())


def test_parallel_authorize_and_ready_preserve_first_deadline(fixture):
    async def check():
        f=await setup(fixture);await stage(f,authorize=False)
        results=await asyncio.gather(*(f.adapter.authorize_preparation(f.transport.connection,f.action,f.prepare_challenge) for _ in range(4)))
        assert [r['status'] for r in results].count('authorized')==1
        assert [r['status'] for r in results].count('lookup_required')==3
        assert (await preparation_row(f))['state']=='authorized' and await row(f) is None
    asyncio.run(check())


@pytest.mark.parametrize('mutation',['nonce','boot','instance','input','runtime','policy','unit','cgroup','attempts','active_before','active_after'])
def test_enforcement_signature_does_not_replace_readiness_bounds(fixture,mutation):
    async def check():
        f=await setup(fixture);await stage(f)
        from openbot_server.work_command_crypto import _parts,_registry
        from joserfc import jws
        value=_parts(f.ready_token)[1]
        if mutation=='nonce':value['nonce']=secrets.token_urlsafe(32)
        if mutation in ('boot','instance'):value['proof']['bootId' if mutation=='boot' else 'enforcerInstanceId']=str(uuid4())
        if mutation=='input':value['inputDigest']='sha256:'+'a'*64
        if mutation=='runtime':value['proof']['runtimeMaxUs']+=1
        if mutation=='policy':value['proof']['timingPolicyDigest']='a'*64
        if mutation=='unit':value['proof']['unitName']='openbot-command-'+'f'*32+'.service'
        if mutation=='cgroup':value['proof']['cgroupPath']='/system.slice/../'+value['proof']['unitName']
        if mutation=='attempts':value['proof']['startAttempts']=1
        if mutation=='active_before':value['proof']['activeMonotonicUs']=99999999
        if mutation=='active_after':
            value['proof']['activeMonotonicUs']=106000000;value['proof']['observedMonotonicUs']=106000001;value['proof']['observedBoottimeUs']=106000001
        # Intentionally sign malformed claims through the released primitive, proving that an
        # authentic producer signature alone never bypasses Control's strict schema/binding.
        token=jws.serialize_compact(_parts(f.ready_token)[0],json.dumps(value,separators=(',',':')).encode(),f.enforcer._key,registry=_registry())
        with pytest.raises((WorkConflict,CommandContractError)):
            await f.adapter.accept_ready(f.transport.connection,f.action,token)
        assert (await preparation_row(f))['state']=='authorized' and await row(f) is None
    asyncio.run(check())


@pytest.mark.parametrize('phase',['authorize','ready'])
@pytest.mark.parametrize('mutation',['clock','restart','input','membership'])
def test_pending_preparation_never_survives_changed_boundary(fixture,phase,mutation):
    async def check():
        f=await setup(fixture);await stage(f,authorize=phase=='ready')
        if mutation=='clock':
            wall,mono=f.adapter.prepare_clock.sample();f.adapter.prepare_clock.sample=lambda:(wall+3000,mono)
        elif mutation=='restart':
            f.adapter=CommandDispatches(f.store,f.profiles,object(),SCOPE,f.transport,f.signer,f.verifier,
                control_issuer='control',enforcement_issuer='enforcement',input_scope=CommandInputScope(f.files),
                timing_policy=f.adapter.timing_policy.model_dump(),prepare_clock=ServerPrepareClock())
            await f.adapter.start()
        elif mutation=='input':
            async with f.files.lock():f.files._write(f.attachment['id']+'.bin',b'evil')
        elif mutation=='membership':
            async with f.store._transaction(trusted=True) as db:await db.execute('DELETE FROM channel_bots WHERE channel_id=%s AND bot_id=%s',(f.channel,f.bot))
        async def action():
            return await f.adapter.authorize_preparation(f.transport.connection,f.action,f.prepare_challenge) if phase=='authorize' else await f.adapter.accept_ready(f.transport.connection,f.action,f.ready_token)
        if mutation in ('clock','restart'):
            result=await action();assert result['status'] in ('denied','lookup_required')
            assert (await preparation_row(f))['state']=='closed'
        else:
            from openbot_server.control_errors import ControlError
            with pytest.raises((WorkConflict,ControlError)):await action()
        assert await row(f) is None
    asyncio.run(check())


def test_admit_has_no_integer_or_dto_readiness_entry(fixture):
    async def check():
        f=await setup(fixture);await stage(f,authorize=False)
        with sdk(f),pytest.raises(WorkConflict):await f.adapter.admit(f.context,f.action,fence=f.fence,
            connection=f.transport.connection,preparation_id=f.preparation_id)
        with pytest.raises(TypeError):await f.adapter.admit(f.context,f.action,fence=f.fence,prepared={})
        assert not hasattr(f.adapter,'prepare')
        assert await row(f) is None
    asyncio.run(check())
