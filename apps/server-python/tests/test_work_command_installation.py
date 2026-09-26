"""Real file/key/schema/JOSE checks; startup SQL is explicitly a fake unit boundary."""
import asyncio
from contextlib import asynccontextmanager
from copy import deepcopy
import json
import os
import shutil
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.ed448 import Ed448PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PrivateFormat, PublicFormat, NoEncryption
import pytest

from openbot_server.model_connections import ModelConnectionsService
from openbot_server.model_connections_cipher import ModelCredentialCipher
from openbot_server.owner_files import OwnerFiles
from openbot_server.work_command_installation import CommandInstallation
from openbot_server.work_command_v2_crypto import CommandV2Signer, HostExchangeBook
from openbot_server.work_command_v2_contract import token_digest, staging
from openbot_server.work_values import InvalidWork, WorkConflict
from openbot_server.worker_host_registry import WorkerHostRegistry
from test_work_command_v2 import Clock


def private(path,data):
    path.write_bytes(data);path.chmod(0o600);return path


@pytest.fixture
def f(tmp_path):
    tmp_path=tmp_path.resolve();tmp_path.chmod(0o700)
    control,enforcement=Ed25519PrivateKey.generate(),Ed25519PrivateKey.generate()
    pem=lambda key:key.private_bytes(Encoding.PEM,PrivateFormat.PKCS8,NoEncryption())
    control_path=private(tmp_path/'control.pem',pem(control))
    public_path=private(tmp_path/'enforcement.pem',enforcement.public_key().public_bytes(Encoding.PEM,PublicFormat.SubjectPublicKeyInfo))
    import test_work_command_store
    command=json.loads((Path(test_work_command_store.__file__).parent/'fixtures/work_command_vectors.json').read_text())['intent']['command']
    value=dict(version=1,route=dict(nodeId='node',providerId='linux-command',enforcementKeyId='enforcer-1',ledgerId=str(uuid4())),
        policy=dict(id='offline-command',image=command['image'],limits=command['limits']),
        timing=dict(prepareBudgetMs=30000,challengeBudgetMs=5000,runtimeMaxMs=50000,stopAllowanceMs=5000,
            clockRateErrorPpm=1000,clockQuantizationMs=100,policyDigest='e'*64),
        control=dict(issuer='control',keyId='control-1',privateKeyPath=str(control_path)),
        enforcement=dict(issuer='enforcement',keyId='enforcer-1',publicKeyPath=str(public_path)))
    path=private(tmp_path/'command.json',json.dumps(value).encode())
    files_path=tmp_path/'files';files_path.mkdir(mode=0o700)
    value_fixture=SimpleNamespace(path=path,value=value,control=control,enforcement=enforcement,pem=pem,command=command,
        control_path=control_path,public_path=public_path,files=OwnerFiles(files_path),
        connections=ModelConnectionsService('unused-test-dsn',ModelCredentialCipher(bytes(range(32)))))
    try:yield value_fixture
    finally:shutil.rmtree(tmp_path)


def configured(f):return CommandInstallation.from_file(f.path,f.connections)


def rewrite(f,change):
    value=deepcopy(f.value);change(value);private(f.path,json.dumps(value).encode())


class Database:
    def __init__(self):self.statements=[]
    async def execute(self,sql,args=None):self.statements.append((sql,args));return self
    async def fetchone(self):return {'n':1800000000000}


class Store:
    """No PG/socket: invoke the real start implementation against recorded fake SQL only."""
    def __init__(self,profiles):
        self.command_profiles=profiles;self.db=Database();self.transactions=0
        self.entered=asyncio.Event();self.release=None;self.fail=False
    @asynccontextmanager
    async def _transaction(self,*,trusted):
        assert trusted is True;self.transactions+=1;self.entered.set()
        if self.release:await self.release.wait()
        yield self.db
        if self.fail:raise RuntimeError('synthetic startup commit failure')


SCOPE=dict(expected_namespace='default',expected_queue='command',expected_workflow_type='work')


def attached(f):
    installation=configured(f)
    registry=WorkerHostRegistry(object(),command_channel=installation.channel_configuration)
    installation.attach(registry.commands)
    return installation,registry,Store(installation.profiles)


def test_absent_configuration_has_no_environment_fallback_or_activation(f,monkeypatch):
    monkeypatch.setenv('OPENBOT_CONTROL_COMMAND_CONFIG_PATH',str(f.path))
    assert CommandInstallation.from_file(None,None) is None
    assert WorkerHostRegistry(object()).commands is None
    item=configured(f)
    assert item._inbox.transport is None and not item._start_claimed
    assert item.profiles.connections is f.connections
    assert set(item.profiles.policies)=={'offline-command'}
    original=item.source_options;original['command_route']['nodeId']='changed'
    assert item.source_options['command_route']['nodeId']=='node'
    assert 'PRIVATE KEY' not in repr(item)+repr(item.profiles)+repr(item.channel_configuration)
    assert str(f.control_path) not in repr(item)


@pytest.mark.parametrize('authority,engine',[('product',None),('work','/unread/engine.json')])
def test_actual_entry_rejects_command_configuration_without_required_composition(authority,engine):
    import subprocess
    import sys
    entry=Path(__file__).resolve().parents[1]/'scripts/serve.py'
    env={'PATH':os.environ.get('PATH',''),'PYTHONDONTWRITEBYTECODE':'1',
         'OPENBOT_CONTROL_DATABASE_URL':'postgresql://unused.invalid/never-connect',
         'OPENBOT_CONTROL_OWNER_PASSWORD':'synthetic-entry-password',
         'OPENBOT_CONTROL_AUTHORITY':authority,'OPENBOT_CONTROL_COMMAND_CONFIG_PATH':'/unread/command.json'}
    if engine is not None:env['OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH']=engine
    result=subprocess.run([sys.executable,'-B',str(entry)],env=env,capture_output=True,text=True,timeout=15)
    assert result.returncode!=0
    assert result.stderr.strip()=='Command configuration requires product mode and an explicit Work engine configuration.'
    assert not result.stdout


@pytest.mark.parametrize('mutation',[
    lambda x:x.update(version=True), lambda x:x.update(version=2), lambda x:x.update(extra=True),
    lambda x:x.update(policies=[x.pop('policy')]), lambda x:x['route'].update(enforcementKeyId='other'),
    lambda x:x['control'].update(issuer='enforcement'), lambda x:x['control'].update(role='enforcement'),
    lambda x:x['enforcement'].update(privateKeyPath='must-not-accept'),
    lambda x:x['policy'].update(image='python:latest'), lambda x:x['policy']['limits'].update(memoryMiB=513),
    lambda x:x['policy']['limits'].update(nanoCPUs=True), lambda x:x['policy']['limits'].update(wallSeconds=1),
    lambda x:x['timing'].update(prepareBudgetMs=30001), lambda x:x['timing'].update(clockQuantizationMs=0),
    lambda x:x['timing'].update(runtimeMaxMs=60000), lambda x:x['timing'].update(extra=True),
])
def test_exact_schema_and_frozen_policy_validation(f,mutation):
    rewrite(f,mutation)
    with pytest.raises(InvalidWork,match='^command_installation_invalid$'):configured(f)


@pytest.mark.parametrize('runtime,accepted',[(50000,True),(50001,False)])
def test_native_runtime_limit_at_configuration_load(f,runtime,accepted):
    rewrite(f,lambda x:x['timing'].update(runtimeMaxMs=runtime))
    if accepted:assert configured(f)._timing.runtimeMaxMs==runtime
    else:
        with pytest.raises(InvalidWork,match='^command_installation_invalid$'):configured(f)


@pytest.mark.parametrize('allowance,accepted',[(4999,False),(5000,True),(5001,False)])
def test_native_stop_allowance_at_configuration_load(f,allowance,accepted):
    rewrite(f,lambda x:x['timing'].update(stopAllowanceMs=allowance))
    if accepted:assert configured(f)._timing.stopAllowanceMs==allowance
    else:
        with pytest.raises(InvalidWork,match='^command_installation_invalid$'):configured(f)


@pytest.mark.parametrize('raw',[b'{"version":1,"version":1}',b'{"version":NaN}',b'[]',b'null',b'\xff',
    b'{"number":1e0}',b'{"number":9007199254740992}',b' '*16385,b''])
def test_bounded_duplicate_and_numeric_json_refusal(f,raw):
    private(f.path,raw)
    with pytest.raises(InvalidWork,match='^command_installation_invalid$'):configured(f)


@pytest.mark.parametrize('target',['config','private','public'])
@pytest.mark.parametrize('fault',['missing','symlink','directory','fifo','writable','size','owner'])
def test_owned_regular_bounded_file_boundary(f,target,fault):
    selected={'config':f.path,'private':f.control_path,'public':f.public_path}[target]
    if fault=='missing':selected.unlink()
    elif fault=='symlink':
        sibling=selected.with_suffix('.original');selected.rename(sibling);selected.symlink_to(sibling)
    elif fault=='directory':selected.unlink();selected.mkdir()
    elif fault=='fifo':selected.unlink();os.mkfifo(selected,0o600)
    elif fault=='writable':selected.chmod(0o666)
    elif fault=='size':private(selected,b'x'*(16385 if target=='config' else 4097))
    if fault=='owner':
        import openbot_server.work_engine_client as reader
        uid=os.geteuid()
        with patch.object(reader.os,'geteuid',lambda:uid+1),pytest.raises(InvalidWork,match='^command_installation_invalid$'):configured(f)
    else:
        with pytest.raises(InvalidWork,match='^command_installation_invalid$'):configured(f)


@pytest.mark.parametrize('target',['config','private'])
def test_private_config_and_signing_key_cannot_be_world_readable(f,target):
    (f.path if target=='config' else f.control_path).chmod(0o644)
    with pytest.raises(InvalidWork,match='^command_installation_invalid$'):configured(f)


def test_public_pin_may_be_readable_but_path_aliases_are_refused(f):
    f.public_path.chmod(0o644);assert configured(f)
    alias=f.path.parent/'alias';alias.symlink_to(f.path.parent,target_is_directory=True)
    with pytest.raises(InvalidWork):CommandInstallation.from_file(alias/f.path.name,f.connections)
    rewrite(f,lambda x:x['control'].update(privateKeyPath='control.pem'))
    with pytest.raises(InvalidWork):configured(f)
    with pytest.raises(InvalidWork):CommandInstallation.from_file('command.json',f.connections)


@pytest.mark.parametrize('fault',['public_as_private','private_as_public','wrong_curve','same_role_key','malformed','inline_key'])
def test_real_keys_are_ed25519_separate_and_finite_error(f,fault,caplog):
    if fault=='public_as_private':private(f.control_path,f.control.public_key().public_bytes(Encoding.PEM,PublicFormat.SubjectPublicKeyInfo))
    elif fault=='private_as_public':private(f.public_path,f.pem(f.enforcement))
    elif fault=='wrong_curve':private(f.control_path,f.pem(Ed448PrivateKey.generate()))
    elif fault=='same_role_key':private(f.public_path,f.control.public_key().public_bytes(Encoding.PEM,PublicFormat.SubjectPublicKeyInfo))
    elif fault=='malformed':private(f.control_path,b'PRIVATE synthetic invalid material')
    else:rewrite(f,lambda x:x['control'].update(privateKeyPath=f.pem(f.control).decode()))
    with pytest.raises(InvalidWork) as error:configured(f)
    assert str(error.value)=='command_installation_invalid' and not error.value.__cause__
    assert not caplog.records


def test_attached_service_keeps_real_control_and_enforcement_verification(f):
    async def check():
        item,registry,store=attached(f)
        driver=await item.driver(store,object(),SCOPE,f.files)
        service=driver.service
        assert service._started and store.transactions==1
        assert len(store.db.statements)==2 and 'UPDATE work_command_preparations' in store.db.statements[1][0]
        assert driver.inbox.transport is registry.commands and service.profiles is item.profiles
        ep=CommandV2Signer(issuer='enforcement',kid='enforcer-1',role='enforcement',private_pem=f.pem(f.enforcement))
        clock=Clock();book=HostExchangeBook(policy=f.value['timing'],clock=clock)
        binding=dict(taskId='task',runId='run',actionId='action',preparationId=str(uuid4()),connectionId=str(uuid4()),
            originalEpoch=1,authorityGeneration=1,profileDigest='a'*64,intentDigest='b'*64,operationFingerprint='c'*64,**f.value['route'])
        pending=book.begin_prepare(binding);challenge=pending.challenge(ep,audience='control')
        expect=dict(requestId=pending.request_id,nonce=pending.nonce)
        assert service.verifier.verify(challenge,purpose='work_command_prepare_challenge',issuer='enforcement',
            audience='control',expected_binding=binding,expected_request=expect).enforcementKeyId=='enforcer-1'
        grant=dict(**binding,version=2,purpose='work_command_prepare_authorize',iss='control',aud='enforcement',jti=str(uuid4()),
            **expect,challengeDigest=token_digest(challenge),issuedAtMs=1800000000000,rootDeadlineMs=1800000300000,
            timing=f.value['timing'],staging=staging(f.command).model_dump())
        token=service.signer.sign(grant,purpose='work_command_prepare_authorize')
        pending.accept_authorization(token,service.verifier,issuer='control',audience='enforcement')
        with pytest.raises(WorkConflict):await item.driver(store,object(),SCOPE,f.files)
        assert store.transactions==1
    asyncio.run(check())


def test_attach_only_exact_matching_registry_once(f):
    item=configured(f)
    with pytest.raises(WorkConflict):item.attach(None)
    other=WorkerHostRegistry(object(),command_channel=configured(f).channel_configuration)
    with pytest.raises(WorkConflict):item.attach(other.commands)
    registry=WorkerHostRegistry(object(),command_channel=item.channel_configuration)
    item.attach(registry.commands)
    with pytest.raises(WorkConflict):item.attach(registry.commands)


def test_driver_requires_attached_same_profile_composition(f):
    async def check():
        item=configured(f);store=Store(item.profiles)
        with pytest.raises(WorkConflict):await item.driver(store,object(),SCOPE,f.files)
        registry=WorkerHostRegistry(object(),command_channel=item.channel_configuration);item.attach(registry.commands)
        with pytest.raises(WorkConflict):await item.driver(Store(configured(f).profiles),object(),SCOPE,f.files)
        assert store.transactions==0
    asyncio.run(check())


@pytest.mark.parametrize('outcome',['success','failure','cancel'])
def test_start_claim_is_once_even_with_concurrent_failure_or_cancellation(f,outcome):
    async def check():
        item,registry,store=attached(f);store.release=asyncio.Event();store.fail=outcome=='failure'
        first=asyncio.create_task(item.driver(store,object(),SCOPE,f.files));await store.entered.wait()
        with pytest.raises(WorkConflict):await item.driver(store,object(),SCOPE,f.files)
        if outcome=='cancel':
            first.cancel()
            with pytest.raises(asyncio.CancelledError):await first
        else:
            store.release.set()
            if outcome=='failure':
                with pytest.raises(RuntimeError):await first
            else:await first
        with pytest.raises(WorkConflict):await item.driver(store,object(),SCOPE,f.files)
        with pytest.raises(WorkConflict):item.attach(registry.commands)
        assert store.transactions==1
    asyncio.run(check())


def test_default_off_import_does_not_require_worker_distribution():
    import subprocess
    import sys
    import openbot_server.work_command_installation as module
    source=str(Path(module.__file__).resolve().parents[1])
    script='''import importlib.abc,sys
class NoWorker(importlib.abc.MetaPathFinder):
    def find_spec(self,fullname,path=None,target=None):
        if fullname.split('.')[0] in {'openbot_agent_runtime','pydantic_ai','temporalio','jsonschema_rs'}:
            raise ImportError('Worker-only import while disabled')
sys.meta_path.insert(0,NoWorker())
sys.path.insert(0,SOURCE)
from openbot_server.work_command_installation import CommandInstallation
assert CommandInstallation.from_file(None,None) is None
'''.replace('SOURCE',repr(source))
    result=subprocess.run([sys.executable,'-B','-c',script],capture_output=True,timeout=10)
    assert result.returncode==0,result.stderr.decode()
