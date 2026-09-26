"""Owned Worker lifetime, finite admission and fail-closed private configuration."""
import asyncio
from contextlib import asynccontextmanager
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
pytest.importorskip('temporalio', reason='optional Worker SDK profile')
from openbot_server import work_product_service as module
from openbot_server.work_values import InvalidWork, WorkConflict
from openbot_server.work_terminal import TerminalBatch


def config(tmp_path):
    tls={}
    for name in ('ca','certificate','key'):
        path=tmp_path/(name+'.pem');path.write_bytes(b'synthetic local preflight');path.chmod(0o600)
        tls[name]=str(path)
    tls['server_name']='temporal.openbot.internal'
    value=dict(temporal_address='127.0.0.1:7233',namespace='fixture',queue='fixture',tls=tls)
    path=tmp_path/'engine.json';path.write_text(json.dumps(value));path.chmod(0o600)
    return path,value


@pytest.mark.parametrize('fault',['unknown','database','plaintext','permission','limit','interval','shared_key'])
def test_operator_file_refuses_unsafe_or_ambient_options(tmp_path,fault):
    path,value=config(tmp_path)
    if fault=='unknown':value['import']='module:callback'
    if fault=='database':value['database_url']='private-database'
    if fault=='plaintext':value['temporal_address']='http://localhost:7233'
    if fault=='permission':path.chmod(0o644)
    if fault=='limit':value['limit']=65
    if fault=='interval':value['interval_seconds']=False
    if fault=='shared_key':__import__('pathlib').Path(value['tls']['key']).chmod(0o644)
    path.write_text(json.dumps(value))
    with pytest.raises((ValueError,InvalidWork)):
        module.configuration(path)


def store():
    return SimpleNamespace(files=object(),verify_schema=AsyncMock())


def test_start_close_owns_one_worker_and_cancels_only_inflight_admission(tmp_path):
    async def check():
        path,_=config(tmp_path);owned=store();entered=[];began=asyncio.Event()
        @asynccontextmanager
        async def worker(*args,**kwargs):
            entered.append('start')
            try: yield
            finally: entered.append('drained')
        async def dispatch(*args,**kwargs):
            began.set()
            await asyncio.Event().wait()
        compose=AsyncMock(return_value=dict(load_services=lambda:None,verify_result=lambda:None))
        client=SimpleNamespace(namespace='fixture')
        with patch.object(module,'connect',AsyncMock(return_value=client)) as connect, \
                patch.object(module,'product_worker',worker),patch.object(module,'dispatch_batch',dispatch):
            service=module.ProductWorkService(owned,path,compose=compose)
            await service.start();await asyncio.wait_for(began.wait(),2)
            assert service.status==dict(state='running',lastPass=None)
            with pytest.raises(WorkConflict): await service.start()
            await asyncio.wait_for(service.close(),2)
        assert entered==['start','drained'] and service.status['state']=='stopped'
        assert connect.await_count==1 and compose.await_count==1
        assert compose.await_args.args[1]['expected_workflow_type']=='OpenBotWorkV1'
        assert len(connect.await_args.kwargs['plugins'])==1
    asyncio.run(check())


def test_start_failure_is_secret_safe_and_does_not_restart(tmp_path):
    async def check():
        path,_=config(tmp_path);compose=AsyncMock()
        with patch.object(module,'connect',AsyncMock(side_effect=RuntimeError('private credential'))) as connect:
            service=module.ProductWorkService(store(),path,compose=compose)
            with pytest.raises(WorkConflict,match='product_service_start_failed') as error:
                await service.start()
            assert 'private' not in str(error.value)
            await service.close()
            assert service.status==dict(state='failed',lastPass=None)
            assert connect.await_count==1
            compose.assert_not_awaited()
    asyncio.run(check())


def test_finite_pass_preserves_unconfirmed_and_explicit_repair_policy(tmp_path):
    async def check():
        path,_=config(tmp_path);settings=module.configuration(path)
        schedules=SimpleNamespace(submit_due=AsyncMock(side_effect=RuntimeError('private-body')))
        service=module.ProductWorkService(store(),path,compose=lambda:None,automations=schedules)
        client=SimpleNamespace(namespace='fixture')
        dispatch=AsyncMock(return_value=[dict(status='acknowledged'),dict(status='unconfirmed')])
        repair=AsyncMock(return_value=[dict(status='waiting_original')])
        with patch.object(module,'dispatch_batch',dispatch),patch.object(module,'repair_batch',repair), \
                patch.object(module,'terminal_batch',AsyncMock(return_value=TerminalBatch((),None))):
            await service._pass(client,settings,repair=True)
            assert service.status['lastPass']==dict(scheduled=0,deliveries=2,unconfirmed=1,repairs=1,
                terminalClosures=0,terminalUnconfirmed=0,errors=1)
            await service._pass(client,settings,repair=False)
        assert repair.await_count==1 and dispatch.await_count==2
        assert dispatch.await_args.kwargs['limit']==16
    asyncio.run(check())


def test_worker_failure_is_observable_without_an_automatic_restart(tmp_path):
    async def check():
        path,_=config(tmp_path);passes=0;failed=asyncio.Event()
        @asynccontextmanager
        async def worker(*args,**kwargs):
            yield
        async def fatal(*args,**kwargs):
            nonlocal passes
            passes+=1;failed.set();raise RuntimeError('private engine details')
        with patch.object(module,'connect',AsyncMock(return_value=SimpleNamespace(namespace='fixture'))), \
                patch.object(module,'product_worker',worker),patch.object(module.ProductWorkService,'_pass',fatal):
            service=module.ProductWorkService(store(),path,compose=lambda *_:dict(load_services=lambda:None,verify_result=lambda:None))
            await service.start();await failed.wait();await service._task
            assert service.status['state']=='failed' and passes==1
            await service.close()
    asyncio.run(check())
