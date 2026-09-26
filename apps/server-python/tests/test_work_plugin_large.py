"""Real FastMCP/PG regression for the retained schema/arguments vs Action capacity seam."""
from copy import deepcopy
from dataclasses import replace
from types import SimpleNamespace
from typing import Annotated
from unittest.mock import patch

from pydantic import Field
import pytest

from openbot_server.database import StoreUnavailable
from openbot_server.plugin_inputs import PluginError, bounded
from openbot_server.plugin_transport import MCPConnector
from openbot_server.work_files import LocalWorkFiles
from openbot_server.work_product_plugins import WorkPluginAdapter
from openbot_server.work_values import InvalidWork, WorkConflict, canonical
from openbot_server.work_tool_results import encode_result
from test_plugin_service import remote, anyio_backend
from test_work_product_plugins import harness, seed
from test_work_product_plugins import SCOPE


def large_tool(remote, *, full_description=False):
    remote['app'].remove_tool('write_note')
    @remote['app'].tool(description='界'*2000 if full_description else 'Write one note')
    def write_note(note: Annotated[str,Field(description='x'*10000)]) -> str:
        remote['effects'].append(note)
        return 'saved'


@pytest.mark.anyio
async def test_actual_full_declaration_bound_is_not_the_schema_only_bound(tmp_path,remote):
    large_tool(remote,full_description=True)
    async with MCPConnector([remote['endpoint']])(remote['endpoint']) as client:
        declaration=next(tool for tool in await client.tools() if tool['name']=='write_note')
    data,_=encode_result(declaration)
    assert 12*1024<len(data)<=24*1024
    assert len(bounded(declaration['inputSchema'],12*1024))<12*1024
    tmp_path=tmp_path.resolve();tmp_path.chmod(0o700)
    files=LocalWorkFiles(tmp_path);ref=files.put(data)
    store=object();adapter=WorkPluginAdapter(store,object(),SCOPE,object(),SimpleNamespace(store=store,files=files))
    intent=dict(kind='deferred_tool',tool='call_plugin',arguments={},effect=dict(kind='product_plugin',source={},
        selection=dict(pluginId='synthetic',revision='synthetic',manifestDigest='a'*64,tool='call_plugin',mode='confirm',declarationBlob=ref)))
    assert adapter._intent(intent)['selection']['declaration']==declaration
    for invalid in (True,0,24*1024+1):
        changed=deepcopy(intent);changed['effect']['selection']['declarationBlob']['sizeBytes']=invalid
        with pytest.raises(InvalidWork,match='invalid_plugin_declaration_blob'):adapter._intent(changed)


async def planned(seed,tmp_path,remote,*,full_description=False):
    large_tool(remote,full_description=full_description)
    h=await harness(seed,tmp_path,remote)
    # The existing helper's small initial call also proves old inline schema plans coexist.
    if not full_description:
        assert 'declaration' in (await h.row())['intent']['effect']['selection']
    h.env.info=replace(h.env.info,activity_id='prepare-large')
    proposal=deepcopy(h.proposal);proposal['arguments']['arguments']={'note':'n'*7000}
    identity=await h.env.run(h.activities.prepare_request,proposal,h.correction['id'])
    async with h.store._transaction(trusted=True) as db:
        row=(await h.store._action(db,identity))[1]
    return h,proposal,identity,row


async def approve_and_execute(h,seed,identity,row):
    await h.store.decide(seed['token'],identity,intent_digest=row['intent_digest'],approved=True)
    h.env.info=replace(h.env.info,activity_id='execute-large')
    return await h.env.run(h.activities.execute,identity)


@pytest.mark.anyio
@pytest.mark.parametrize('full_description',[False,True])
async def test_real_large_declaration_approval_one_dispatch_and_no_replanning(seed,tmp_path,remote,full_description):
    h,proposal,identity,row=await planned(seed,tmp_path,remote,full_description=full_description)
    selection=row['intent']['effect']['selection']
    assert 'declarationBlob' in selection and 'declaration' not in selection
    ref=selection['declarationBlob']
    expanded=h.adapter._intent(row['intent'])['selection']
    data,_=encode_result(expanded['declaration'])
    assert len(data)==ref['sizeBytes'] and 10000<len(data)<=24*1024
    assert (len(data)>12*1024) is full_description
    assert len(canonical(row['intent'])[0])<16384
    assert len(bounded(expanded['declaration']['inputSchema'],12*1024))<12*1024
    catalog=await h.env.run(h.adapter.catalog,h.context)
    assert any(tool['toolName']=='write_note' for tool in catalog['tools'])
    with patch.object(h.activities,'plan_effect',side_effect=AssertionError('must recover original plan')):
        assert await h.env.run(h.activities.prepare_request,proposal,h.correction['id'])==identity
    h.env.info=replace(h.env.info,activity_id='execute-large')
    with pytest.raises(WorkConflict,match='not_authorized'): await h.env.run(h.activities.execute,identity)
    assert (await approve_and_execute(h,seed,identity,row))['status']=='applied'
    with patch.object(h.plugins,'connector',side_effect=AssertionError('historical recovery must not reconnect')):
        assert (await h.env.run(h.activities.execute,identity))['status']=='applied'
        value=await h.env.run(h.activities.result,identity)
    assert value['result']['result']['isError'] is False and remote['effects']==['n'*7000]
    async def validate():
        async with h.plugins.locked_work_validation() as checker:
            async with h.store._transaction(trusted=True) as db:
                return await h.adapter.revalidate_in_transaction(db,h.context,checker)
    assert await h.env.run(validate) is True
    events=(await h.store.snapshot(seed['token'],h.task['id']))['events']
    assert len([e for e in events if e['kind']=='tool.plugin_dispatch_started'])==1


@pytest.mark.anyio
@pytest.mark.parametrize('change',['bytes','sha','size','grant','disable','schema'])
async def test_large_blob_and_revocation_refuse_without_dispatch(seed,tmp_path,remote,change):
    h,proposal,identity,row=await planned(seed,tmp_path,remote)
    ref=row['intent']['effect']['selection']['declarationBlob']
    if change=='bytes':
        path=h.base/'blobs'/ref['sha256'];raw=path.read_bytes()
        path.write_bytes(b'x'+raw[1:])
        with patch.object(h.activities,'plan_effect',side_effect=AssertionError('corrupt blob must not cause replanning')):
            assert await h.env.run(h.activities.prepare_request,proposal,h.correction['id'])==identity
    elif change in ('sha','size'):
        forged=deepcopy(row['intent'])
        forged['effect']['selection']['declarationBlob'][{'sha':'sha256','size':'sizeBytes'}[change]]= 'b'*64 if change=='sha' else ref['sizeBytes']+1
        with pytest.raises((StoreUnavailable,InvalidWork,WorkConflict,OSError)):h.adapter._intent(forged)
        assert not remote['effects'];return
    elif change=='grant':
        await h.plugins.grant(seed['token'],h.plugin['id'],seed['botId'],dict(revision=h.plugin['revision'],tools=[]))
    elif change=='disable':
        await h.plugins.set_enabled(seed['token'],h.plugin['id'],dict(revision=h.plugin['revision'],enabled=False))
    else:
        @remote['app'].tool()
        def added_after_review() -> str:return 'changed'
    try:result=await approve_and_execute(h,seed,identity,row)
    except (StoreUnavailable,InvalidWork,WorkConflict,PluginError):pass
    else:assert result['status']=='unknown'
    assert not remote['effects']


@pytest.mark.anyio
async def test_large_original_receipt_survives_revocation_but_consumption_does_not(seed,tmp_path,remote):
    h,_,identity,row=await planned(seed,tmp_path,remote)
    assert (await approve_and_execute(h,seed,identity,row))['status']=='applied'
    await h.plugins.grant(seed['token'],h.plugin['id'],seed['botId'],dict(revision=h.plugin['revision'],tools=[]))
    with patch.object(h.plugins,'connector',side_effect=AssertionError('no second network request')):
        assert (await h.env.run(h.activities.execute,identity))['status']=='applied'
        with pytest.raises(PluginError):await h.env.run(h.activities.result,identity)
    assert len(remote['effects'])==1
