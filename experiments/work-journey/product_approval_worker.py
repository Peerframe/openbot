"""Synthetic services for actual product deferred approval; no Workflow implementation here."""
import asyncio
import hashlib
from pathlib import Path
from temporalio import activity
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.usage import RequestUsage
import control
import multitask_worker as reference
from engine_client import connect
from openbot_agent_runtime.contracts import ToolDescriptor
from openbot_server.work_worker import product_worker, VerifiedTaskResult, TYPE
from openbot_server.work_runtime_ports import WorkRuntimeServices
from openbot_server.work_deferred import DeferredPlan, EffectServices, DeferredActivities
from openbot_server.work_effects import VerifiedOutcome
from openbot_server.work_values import canonical
from openbot_server.work_closed_repair import LookupServices, ClosedRepairActivities

WRITE=ToolDescriptor('write_row','Propose a reviewed CSV correction',{'type':'object',
    'properties':{'row':{'type':'integer'},'value':{'type':'string'}},'required':['row','value'],
    'additionalProperties':False})
ARGUMENTS={'row':7,'value':'fixed'}
INTENT={'kind':'write',**ARGUMENTS}


async def main():
    cfg=control.settings();store=control.store()
    client=await connect(cfg['temporal_address'],cfg.get('engine_tls'),plugins=[PydanticAIPlugin()])
    reference._STORE,reference._CLIENT=store,client
    reference._SCOPE=dict(expected_namespace='default',expected_queue=cfg['queue'],expected_workflow_type=TYPE)

    def load_services(context):
        async def model(request):
            returns=[p.content for m in request.messages for p in m.parts if isinstance(p,ToolReturnPart)]
            stage='final' if returns else 'plan'
            await reference.perform(context,stage)
            if returns:
                if len(returns)!=1 or returns[0].get('status')!='applied':
                    raise control.ReceiptMismatch('No verified approved effect')
                parts=[TextPart('Row 7 verified')]
            else:parts=[ToolCallPart('write_row',ARGUMENTS,tool_call_id='same-model-correlation')]
            return ModelResponse(parts,usage=RequestUsage(input_tokens=2,output_tokens=1),model_name='openbot-port')
        async def no_inline(_request):raise AssertionError('Deferred tool reached inline executor')
        return WorkRuntimeServices(model,no_inline,(WRITE,),())

    async def plan(context,request):
        if cfg.get('fail_planner'):raise AssertionError('Approved operation was replanned')
        if request.tool!='write_row' or request.arguments!=ARGUMENTS:raise control.ReceiptMismatch('Unreviewed proposal')
        return DeferredPlan(INTENT,2,True,300)

    def load_effect(context,intent):
        if intent!=dict(kind='deferred_tool',tool='write_row',arguments=ARGUMENTS,effect=INTENT):
            raise control.ReceiptMismatch('Original effect changed')
        class Adapter:
            async def apply(self,action_id,stored):
                if stored!=intent:raise control.ReceiptMismatch('Changed apply payload')
                await asyncio.to_thread(control.http,'/operations',dict(actionId=action_id,
                    taskId=context.task_id,intent=stored['effect']))
            async def lookup(self,action_id):return await asyncio.to_thread(control.http,'/operations/'+action_id)
        class Verifier:
            async def verify(self,*,action_id,task_id,run_id,intent_digest,intent,lookup):
                if task_id!=context.task_id or run_id!=context.run_id:return None
                evidence=control.verify(dict(id=action_id,task_id=task_id,intent=intent['effect'],
                    intent_digest=canonical(intent['effect'])[1]),lookup)
                return VerifiedOutcome(action_id,task_id,run_id,intent_digest,True,2,evidence)
        return EffectServices(Adapter(),Verifier())

    async def verify_result(context,summary):
        if summary!='Row 7 verified':return None
        data=await asyncio.to_thread(control.http,'/rows/'+context.task_id,raw=True)
        if data!=b'row,value\n7,fixed\n':return None
        async with store._transaction(trusted=True) as db:
            actions=await (await db.execute('SELECT status,intent FROM work_actions WHERE run_id=%s',(context.run_id,))).fetchall()
        if len(actions)!=3 or any(a['status']!='applied' for a in actions):return None
        return VerifiedTaskResult((dict(key='csv',name='corrected.csv',mediaType='text/csv',data=data),),
            dict(source='independent-csv-readback',reference=context.task_id,sha256=hashlib.sha256(data).hexdigest()))

    def load_lookup(context,intent):
        Path(cfg['directory'],'lookup-invoked-'+context.task_id).touch()
        if cfg.get('fail_lookup'):raise AssertionError('Finished command loaded lookup services')
        services=load_effect(context,intent)
        return LookupServices(services.adapter.lookup,services.verifier)

    original_reconcile=ClosedRepairActivities.reconcile
    @activity.defn(name='openbot.closed_repair.v1')
    async def reconcile_then_pause(self,value: dict) -> dict:
        result=await original_reconcile(self,value)
        if cfg.get('pause_repair') and result['outcome']=='resolved':
            Path(cfg['directory'],'reconciled-'+value['taskId']).touch()
            async with asyncio.timeout(35):
                while True:await asyncio.sleep(.1)
        return result
    ClosedRepairActivities.reconcile=reconcile_then_pause

    original_propose=store.propose
    async def prepare_then_pause(task_id,*args,**kwargs):
        result=await original_propose(task_id,*args,**kwargs)
        if cfg.get('pause_prepare') and kwargs['intent'].get('kind')=='deferred_tool':
            Path(cfg['directory'],'prepared-'+task_id).touch()
            async with asyncio.timeout(65):
                while True:await asyncio.sleep(.1)
        return result
    store.propose=prepare_then_pause

    original_stop=DeferredActivities.stop
    @activity.defn(name='openbot.stop_tool.v1')
    async def stop_then_pause(self,action_id: str) -> dict:
        result=await original_stop(self,action_id)
        if cfg.get('pause_stop'):
            Path(cfg['directory'],'stopped-'+result['taskId']).touch()
            async with asyncio.timeout(65):
                while True:await asyncio.sleep(.1)
        return result
    DeferredActivities.stop=stop_then_pause

    async with product_worker(client,store,namespace='default',queue=cfg['queue'],load_services=load_services,
            verify_result=verify_result,plan_effect=plan,load_effect=load_effect,
            load_lookup=load_lookup if cfg.get('enable_repair') else None):
        Path(cfg['directory'],'ready').touch()
        await asyncio.Event().wait()


if __name__=='__main__':asyncio.run(main())
