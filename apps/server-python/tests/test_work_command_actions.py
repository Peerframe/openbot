"""Whole deferred Action binding; SQL tests retain explicit synthetic SDK/Host seams."""
import asyncio
from copy import deepcopy
import json
from pathlib import Path
from uuid import uuid4

import pytest

from openbot_server.work_command_actions import action_command, derive_action_operation
from openbot_server.work_command_contract import derive_operation
from openbot_server.work_values import canonical, WorkConflict
from test_work_command_store import fixture, setup, approve, admit, consume, row


def envelope(intent):
    return dict(kind='deferred_tool', tool='run_command', effect=deepcopy(intent),
                arguments={k: deepcopy(intent['command'][k]) for k in ('argv', 'output')})


def sample():
    return json.loads((Path(__file__).parent/'fixtures/work_command_vectors.json').read_text())['intent']


def test_bare_contract_retained_but_envelope_binds_its_complete_digest():
    intent=sample()
    identity=dict(task_id='task',run_id='run',action_id='action',generation=1,original_epoch=1,
        route=dict(nodeId='node',providerId='provider',enforcementKeyId='key',ledgerId=str(uuid4())))
    assert derive_action_operation(intent,**identity)==derive_operation(intent,**identity)
    wrapped=envelope(intent)
    actual=derive_action_operation(wrapped,**identity)
    assert actual.command.model_dump()==intent['command']
    assert actual.intentDigest==canonical(wrapped)[1]!=canonical(intent)[1]
    assert action_command(wrapped).model_dump()==intent


@pytest.mark.parametrize('mutation',['tool','kind','extra','arguments','argv','output','effect'])
def test_deferred_wrapper_cannot_diverge_from_approved_command(mutation):
    value=envelope(sample())
    if mutation=='tool':value['tool']='call_plugin'
    elif mutation=='kind':value['kind']='work_command'
    elif mutation=='extra':value['approved']=True
    elif mutation=='arguments':value['arguments']['extra']=True
    elif mutation=='argv':value['arguments']['argv']=['other']
    elif mutation=='output':value['arguments']['output']['maxBytes']-=1
    else:value['effect']['command']['argv']=['other']
    with pytest.raises((ValueError,WorkConflict)):action_command(value)


def test_deferred_command_uses_original_sql_preparation_admission_and_single_consumption(fixture):
    async def run():
        f=await setup(fixture)
        f.intent=envelope(f.intent)
        f.action=await f.store.propose(f.tid,f.rid,fence=f.fence,
            action_key='tool-activity-v1-'+uuid4().hex,intent=f.intent,reserved_tokens=0,
            correction_context=f.context.correction_token)
        await approve(f)
        issued=await admit(f)
        assert issued['status']=='issued'
        assert issued['operation']['intentDigest']==canonical(f.intent)[1]
        assert issued['operation']['intentDigest']!=canonical(f.intent['effect'])[1]
        assert (await consume(f,issued['ticket']))['status']=='consumed'
        assert (await consume(f,issued['ticket']))['status']=='lookup_required'
        original=await f.adapter.original(f.action)
        assert original['operation']==issued['operation']
        assert (await row(f))['state']=='consumed'
    asyncio.run(run())
