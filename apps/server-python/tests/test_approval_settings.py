"""C4 negative gates written before implementation (ADR-0049)."""
import pytest
from pydantic import ValidationError
from uuid import uuid4
from openbot_server.approval_settings import ApprovalSettingsInput, required_for

BOT=str(uuid4()); CHANNEL=str(uuid4())
def settings(**extra):
    return dict(expectedRevision=1,productRead='required',publicWeb='required',exceptions=[],**extra)
def exception(category='product_read',kind='channel',value=CHANNEL):
    return dict(botId=BOT,category=category,target=dict(kind=kind,value=value))

@pytest.mark.parametrize('category',['delete','install','permission_change','command','browser','plugin','unknown'])
def test_protected_and_unknown_categories_never_have_exceptions(category):
    with pytest.raises(ValidationError):
        ApprovalSettingsInput.model_validate({**settings(),'exceptions':[exception(category)]})

@pytest.mark.parametrize('kind,value',[('channel','*'),('channel','prefix-*'),('file','/tmp/a'),('page','https://example.com/*'),('page','https://' + 'user:secret' + '@example.com/'),('page','https://example.com/?key=secret'),('page','http://example.com/'),('page','https://localhost/'),('page','https://127.0.0.1/')])
def test_unknown_wildcard_private_credential_and_non_exact_targets_refused(kind,value):
    with pytest.raises(ValidationError):
        ApprovalSettingsInput.model_validate({**settings(),'exceptions':[exception('public_web' if kind=='page' else 'product_read',kind,value)]})

def test_mismatch_duplicate_unknown_fields_and_invalid_bot_refused():
    for item in (exception('public_web'),{**exception(),'botId':'*'},{**exception(),'allowDelete':True}):
        with pytest.raises(ValidationError): ApprovalSettingsInput.model_validate({**settings(),'exceptions':[item]})
    with pytest.raises(ValidationError): ApprovalSettingsInput.model_validate({**settings(),'exceptions':[exception(),exception()]})

def test_adapter_mandatory_approval_cannot_be_removed_by_matching_exception():
    value=ApprovalSettingsInput.model_validate({**settings(),'exceptions':[exception()]}).model_dump()
    intent=dict(kind='deferred_tool',tool='read_channel_context',arguments={},effect=dict(kind='work_reads',version=1,operation='read_channel_context',source=dict(channelId=CHANNEL),attachment=None))
    assert required_for(intent,True,value,BOT) is True
    assert required_for(intent,False,value,BOT) is False
    assert required_for(intent,False,value,str(uuid4())) is True

from contextlib import contextmanager
import asyncio
import psycopg
from psycopg.types.json import Jsonb
from openbot_server.approval_settings import OwnerApprovalSettings, assert_current
from openbot_server.control_errors import ControlError
from openbot_server.work_store import PostgresWorkStore
from openbot_server.work_values import WorkConflict
from test_product_control import product,client

@contextmanager
def restored(fixture):
    with psycopg.connect(fixture['dsn']) as db:
        row=db.execute("SELECT revision,configuration FROM owner_approval_settings WHERE owner_id='owner'").fetchone()
    try:yield
    finally:
        with psycopg.connect(fixture['dsn']) as db:
            db.execute("INSERT INTO owner_approval_settings(owner_id,revision,configuration) VALUES('owner',%s,%s) ON CONFLICT(owner_id) DO UPDATE SET revision=EXCLUDED.revision,configuration=EXCLUDED.configuration",(row[0],Jsonb(row[1])))


def test_public_http_owner_origin_exact_targets_revision_and_corrupt_storage(fixture,tmp_path):
    with restored(fixture),client(fixture,product(fixture,tmp_path)) as api:
        path='/api/v1/settings/approvals';original=api.get(path).json()
        body=dict(expectedRevision=original['revision'],productRead='required',publicWeb='inherit',exceptions=[])
        assert api.put(path,json=body).status_code==403
        headers={'Origin':'http://testserver'}
        bad={**body,'exceptions':[dict(botId=fixture['botId'],category='delete',target=dict(kind='channel',value=fixture['channelId']))]}
        assert api.put(path,json=bad,headers=headers).status_code==422
        missing={**body,'exceptions':[dict(botId=str(uuid4()),category='product_read',target=dict(kind='channel',value=fixture['channelId']))]}
        assert api.put(path,json=missing,headers=headers).status_code==404
        saved=api.put(path,json=body,headers=headers);assert saved.status_code==200,saved.text
        revision=saved.json()['revision'];assert revision==original['revision']+1
        assert api.put(path,json=body,headers=headers).status_code==409
        assert api.put(path,json={**body,'expectedRevision':revision},headers=headers).json()['revision']==revision
        assert api.put(path,content=b' '*16385,headers={**headers,'Content-Type':'application/json'}).status_code==413
        with psycopg.connect(fixture['dsn']) as db:
            payload=db.execute("SELECT payload FROM run_events WHERE type='SETTINGS_APPROVAL_UPDATED' AND payload->>'revision'=%s ORDER BY created_at DESC LIMIT 1",(str(revision),)).fetchone()[0]
            assert payload==dict(revision=revision,productRead='required',publicWeb='inherit',exceptionCount=0)
            db.execute("UPDATE owner_approval_settings SET configuration=jsonb_set(configuration,'{exceptions}',%s) WHERE owner_id='owner'",(Jsonb([dict(botId=fixture['botId'],category='delete',target=dict(kind='channel',value=fixture['channelId']))]),))
        assert api.get(path).status_code==503
        assert api.put(path,json={**body,'expectedRevision':revision},headers=headers).status_code==503
        api.cookies.clear();assert api.get(path).status_code==401
        assert api.put(path,json=body,headers=headers).status_code==401


def test_concurrent_settings_writes_and_audit_failure_are_atomic(fixture,tmp_path):
    async def check():
        service=OwnerApprovalSettings(fixture['dsn'],product(fixture,tmp_path).files)
        original=await service.snapshot(fixture['token'])
        body=dict(expectedRevision=original['revision'],productRead='required',publicWeb='inherit',exceptions=[])
        result=await asyncio.gather(service.save(fixture['token'],body),service.save(fixture['token'],{**body,'publicWeb':'required'}),return_exceptions=True)
        assert sum(isinstance(v,dict) for v in result)==1
        assert sum(isinstance(v,ControlError) and v.code=='approval_policy_revision_changed' for v in result)==1
        before=await service.snapshot(fixture['token'])
        with psycopg.connect(fixture['dsn']) as db:
            db.execute("CREATE FUNCTION c4_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='SETTINGS_APPROVAL_UPDATED' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$")
            db.execute('CREATE TRIGGER c4_reject_audit BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION c4_reject_audit()')
        try:
            with pytest.raises(psycopg.Error):await service.save(fixture['token'],dict(expectedRevision=before['revision'],productRead='inherit',publicWeb='inherit',exceptions=[]))
            assert await service.snapshot(fixture['token'])==before
        finally:
            with psycopg.connect(fixture['dsn']) as db:
                db.execute('DROP TRIGGER c4_reject_audit ON run_events');db.execute('DROP FUNCTION c4_reject_audit()')
    with restored(fixture):asyncio.run(check())


def read_intent(channel):
    return dict(kind='deferred_tool',tool='read_channel_context',arguments={},effect=dict(kind='work_reads',version=1,operation='read_channel_context',source=dict(channelId=channel),attachment=None))


def test_real_proposal_admission_revocation_minimum_and_pending_relaxation(fixture,tmp_path):
    async def check():
        policy=OwnerApprovalSettings(fixture['dsn'],product(fixture,tmp_path).files);store=PostgresWorkStore(fixture['dsn'])
        task=await store.create(fixture['token'],bot_id=fixture['botId'],objective='Policy gate fixture',token_limit=100,request_key=str(uuid4()))
        run=task['runs'][0]['id'];fence=await store.claim(task['id'],run,'policy-fixture');intent=read_intent(fixture['channelId'])
        async def propose(key,minimum=False):return await store.propose(task['id'],run,fence=fence,action_key=key,intent=intent,reserved_tokens=0,requires_approval=minimum)
        async def row(identity):
            async with store._transaction(trusted=True) as db:return (await store._action(db,identity))[1]
        async def save(exceptions=[],mode='required'):
            current=await policy.snapshot(fixture['token'])
            return await policy.save(fixture['token'],dict(expectedRevision=current['revision'],productRead=mode,publicWeb='inherit',exceptions=exceptions))
        extra=dict(botId=fixture['botId'],category='product_read',target=dict(kind='channel',value=fixture['channelId']))
        await save([extra]);automatic=await propose('excepted');assert (await row(automatic))['decision']=='not_required'
        await save();assert await propose('excepted')==automatic
        with pytest.raises(WorkConflict,match='approval_policy_changed'):await store.admit(automatic,fence=fence)
        pending=await propose('pending');assert (await row(pending))['decision']=='pending'
        await save(mode='inherit');assert (await row(pending))['decision']=='pending'
        with pytest.raises(WorkConflict):await store.admit(pending,fence=fence)
        await store.decide(fixture['token'],pending,intent_digest=(await row(pending))['intent_digest'],approved=True)
        assert await store.admit(pending,fence=fence)
        await save([extra]);mandatory=await propose('mandatory',True);assert (await row(mandatory))['decision']=='pending'
        automatic2=await propose('excepted2');assert await store.admit(automatic2,fence=fence)
        await save()
        async with store._transaction(trusted=True) as db:
            t,a=await store._action(db,automatic2)
            with pytest.raises(WorkConflict,match='approval_policy_changed'):await assert_current(db,t,a)
        with psycopg.connect(fixture['dsn']) as db:
            with pytest.raises(psycopg.errors.CheckViolation):
                with db.transaction():db.execute("UPDATE work_actions SET requires_approval=false WHERE id=%s",(mandatory,))
            db.execute("DELETE FROM owner_approval_settings WHERE owner_id='owner'")
        with pytest.raises(WorkConflict,match='approval_policy_unavailable'):await propose('missing')
        async with store._transaction(trusted=True) as db:
            t,a=await store._action(db,pending)
            assert a['decision']=='approved'
            with pytest.raises(WorkConflict,match='approval_policy_unavailable'):await assert_current(db,t,a)
    with restored(fixture):asyncio.run(check())


def test_actual_zod_python_settings_target_agreement():
    import json,subprocess
    from pathlib import Path
    root=Path(__file__).resolve().parents[3]
    targets=['https://example.com/','https://example.com/path','https://example.com/%20',
        'https://example.com','https://example.com/?','https://example.com/#','https://EXAMPLE.com/',
        'https://example.com/a/../b','https://example.com/%2e/','https://127.0.0.1/',
        'https://1.2.3/','https://0x08080808/','https://example.test/','https://example.com:443/',
        'https://' + 'user:pw' + '@example.com/','https://example.com/?secret=a','https://example.com/*',
        'https://example.com/中文','https://example.com/\x7f','https://[2606:4700:4700::1111]/']
    bodies=[{**settings(),'exceptions':[exception('public_web','page',value)]} for value in targets]
    expected=[]
    for body in bodies:
        try:ApprovalSettingsInput.model_validate(body)
        except ValidationError:expected.append(False)
        else:expected.append(True)
    assert expected[:3]==[True,True,True]
    js="import {approvalSettingsInputSchema as schema} from './packages/protocol/dist/approval-settings.js';let input='';for await(const chunk of process.stdin)input+=chunk;process.stdout.write(JSON.stringify(JSON.parse(input).map(body=>schema.safeParse(body).success)));"
    result=subprocess.run(['node','--input-type=module','-e',js],cwd=root,input=json.dumps(bodies),text=True,capture_output=True,check=True,timeout=10)
    assert json.loads(result.stdout)==expected
