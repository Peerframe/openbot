"""Scripted SDK strategy and owned effect fixture, never a production provider or authority."""
import asyncio
import json
import os
from pathlib import Path
import time
from urllib.request import Request, urlopen

import psycopg
from pydantic_ai import Agent, DeferredToolRequests, DeferredToolResults
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models import Model
from pydantic_ai.toolsets.external import ExternalToolset
from pydantic_ai.tools import ToolDefinition
from pydantic_ai.usage import RequestUsage, UsageLimits


def settings():
    return json.loads(Path(os.environ['OPENBOT_SDK_PROBE_CONFIG']).read_text())


def event(name):
    cfg=settings()
    body=json.dumps({'case':cfg['case'],'action':name,'epoch':1}).encode()
    with urlopen(Request(cfg['effect_url'],body,{'Content-Type':'application/json'}),timeout=3) as r:
        assert r.status==200 and r.read(64)==b'ok'


async def barrier(name):
    cfg=settings()
    if cfg['barrier']!=name:return
    root=Path(cfg['directory']);(root/'reached').write_text(name)
    deadline=time.monotonic()+40
    while not (root/'release').exists():
        if time.monotonic()>deadline:raise TimeoutError('Parent fault barrier expired')
        await asyncio.sleep(.025)


class ScriptedModel(Model):
    @property
    def model_name(self):return 'owned-scripted-model'
    @property
    def system(self):return 'openbot-probe'

    async def request(self,messages,model_settings,model_request_parameters):
        returns={p.tool_name:p.content for m in messages for p in m.parts if isinstance(p,ToolReturnPart)}
        stage='first' if 'read_row' not in returns else 'final' if 'external_write' in returns else 'next'
        await asyncio.to_thread(event,'model-'+stage)
        if stage=='next':await barrier('after-read')
        if stage=='first':parts=[ToolCallPart('read_row',{},tool_call_id='read-1')]
        elif stage=='next':parts=[ToolCallPart('external_write',{'row':7,'value':'fixed'},tool_call_id='write-1')]
        else:
            assert returns['external_write']=='applied'
            parts=[TextPart('Row 7 verified')]
        return ModelResponse(parts,usage=RequestUsage(input_tokens=2,output_tokens=1),model_name=self.model_name)


async def read_row():
    """Read the synthetic row once if the selected engine checkpoints this function."""
    await asyncio.to_thread(event,'read')
    return 'row 7: old'


def build_agent(capability,read=read_row):
    return Agent(ScriptedModel(),name='openbot-sdk-probe',output_type=[str,DeferredToolRequests],
        tools=[read],toolsets=[ExternalToolset([ToolDefinition(name='external_write',
            parameters_json_schema={'type':'object','properties':{'row':{'type':'integer'},'value':{'type':'string'}},
                                    'required':['row','value'],'additionalProperties':False})])],
        capabilities=[capability],retries=0)


def mark_waiting():
    Path(settings()['directory'],'waiting').write_text('waiting')


def apply_external():
    # This intentionally small read-then-send fixture has no concurrent revocation or uncertain
    # effect handling. The real control store owns those; this measures SDK/engine composition.
    cfg=settings()
    with psycopg.connect(cfg['dsn']) as db:
        allowed=db.execute('SELECT allowed FROM probe_authority WHERE case_id=%s',(cfg['case'],)).fetchone()[0]
    if not allowed:return 'revoked'
    event('write')
    return 'applied'


async def resume(agent,first,outcome):
    if outcome!='applied':return {'outcome':outcome,'requests':first.usage.requests}
    assert isinstance(first.output,DeferredToolRequests)
    calls=first.output.calls
    assert len(calls)==1 and calls[0].tool_name=='external_write' and calls[0].args_as_dict()=={'row':7,'value':'fixed'}
    final=await agent.run(message_history=first.all_messages(),usage=first.usage,
        deferred_tool_results=DeferredToolResults(calls={calls[0].tool_call_id:outcome}),
        usage_limits=UsageLimits(request_limit=4))
    assert final.run_id!=first.run_id
    return {'outcome':final.output,'requests':final.usage.requests,'separateSdkRuns':True}
