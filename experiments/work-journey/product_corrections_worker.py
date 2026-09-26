"""Owned synthetic ports and fault barriers around the actual correction-capable Worker."""
import asyncio
import hashlib
import secrets
import sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(ROOT/'apps/server-python/src'),str(ROOT/'apps/agent-runtime-python/src')]
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart, ToolReturnPart, ModelMessagesTypeAdapter
from pydantic_ai.usage import RequestUsage
import control
from engine_client import connect
from openbot_agent_runtime.contracts import ToolDescriptor
from openbot_server.work_worker import product_worker, VerifiedTaskResult, TYPE
from openbot_server.work_runtime_ports import WorkRuntimeServices
from openbot_server.work_corrections import CorrectionStore
from openbot_server.work_deferred import DeferredPlan, EffectServices
from openbot_server.work_effects import VerifiedOutcome
from openbot_server.work_model_activity import execute_model_activity
from openbot_server.work_model_receipts import ModelReceipts
from openbot_server.work_files import LocalWorkFiles
from openbot_server.work_values import canonical

TOOL = ToolDescriptor('operate', 'Review one fixture operation', {'type':'object',
    'properties':{'slot':{'type':'integer'}},'required':['slot'],'additionalProperties':False})

async def main():
    cfg=control.settings(); store=control.store(); directory=Path(cfg['directory'])
    client=await connect(cfg['temporal_address'],cfg.get('engine_tls'),plugins=[PydanticAIPlugin()])
    scope=dict(expected_namespace='default',expected_queue=cfg['queue'],expected_workflow_type=TYPE)
    corrections=CorrectionStore(store)
    async def pause(label, task_id, timeout=65):
        (directory/(label+'-'+task_id)).touch()
        async with asyncio.timeout(timeout):
            while not (directory/('release-'+label+'-'+task_id)).exists(): await asyncio.sleep(.05)

    class Receipts(ModelReceipts):
        async def save(self, action_id, **kwargs):
            result=await super().save(action_id,**kwargs)
            if cfg.get('pause_receipt') and any(isinstance(p,TextPart) and p.content=='receipt:c1'
                                               for p in kwargs['response'].parts):
                await pause('receipt',kwargs['task_id'])
            return result
    receipts=Receipts(store,LocalWorkFiles(cfg['model_receipt_root']))

    def load_services(context):
        if cfg.get('fail_callbacks') and context.objective=='receipt': raise AssertionError('Completed ACK invoked services')
        async def provider(request):
            frozen=await corrections.read(context.task_id,context.run_id,context.correction_token)
            # Unique measurement ID exposes duplicate model calls across Worker restarts.
            await asyncio.to_thread(control.http,'/operations',dict(actionId=secrets.token_hex(16),
                taskId=context.task_id,intent=dict(kind='model',stage='plan')))
            returns=[p for m in request.messages for p in m.parts if isinstance(p,ToolReturnPart)]
            if context.objective=='receipt':
                latest=frozen['corrections'][-1]['instruction'] if frozen['corrections'] else 'original'
                assert latest.encode() in ModelMessagesTypeAdapter.dump_json(request.messages)
                parts=[TextPart('receipt:'+latest)]
            elif not returns:
                parts=[ToolCallPart('operate',dict(slot=i),tool_call_id='slot-'+str(i)) for i in range(3)]
            else:
                expected=['superseded','superseded','not_prepared'] if context.objective=='prepare' else ['applied','applied','superseded']
                assert sorted((p.tool_call_id,p.content['status']) for p in returns)==list(zip(['slot-0','slot-1','slot-2'],expected))
                assert frozen['corrections'] and b'keep existing facts' in ModelMessagesTypeAdapter.dump_json(request.messages)
                parts=[TextPart(context.objective+' verified')]
            return ModelResponse(parts,usage=RequestUsage(input_tokens=2,output_tokens=1),model_name='correction-fixture')
        async def model(request):
            frozen=await corrections.read(context.task_id,context.run_id,context.correction_token)
            if context.objective=='receipt' and not frozen['corrections'] and cfg.get('pause_initial'):
                await pause('before-model',context.task_id)
            return await execute_model_activity(store,client,**scope,receipts=receipts,provider=provider,
                request=request,provider_id='synthetic',model_id='correction-fixture',max_output_tokens=4,
                reserved_tokens=6,correction_context=context.correction_token)
        async def no_inline(_): raise AssertionError('Inline effect in correction profile')
        return WorkRuntimeServices(model,no_inline,(TOOL,),())

    async def plan(context,request):
        assert request.tool=='operate' and request.arguments in [dict(slot=i) for i in range(3)]
        slot=request.arguments['slot']
        effect=dict(kind='read') if slot==0 else dict(kind='write',row=7,value='fixed')
        return DeferredPlan(effect,2,slot==2,300)

    def load_effect(context,intent):
        assert context.correction_token is not None and intent['kind']=='deferred_tool'
        class Adapter:
            async def apply(self,action_id,stored):
                assert stored==intent
                await asyncio.to_thread(control.http,'/operations',dict(actionId=action_id,
                    taskId=context.task_id,intent=stored['effect']))
            async def lookup(self,action_id):
                result=await asyncio.to_thread(control.http,'/operations/'+action_id)
                if intent['arguments']['slot']==1 and not cfg.get('allow_lookup'): return None
                return result
        class Verifier:
            async def verify(self,*,action_id,task_id,run_id,intent_digest,intent,lookup):
                if task_id!=context.task_id or run_id!=context.run_id or lookup is None:return None
                evidence=control.verify(dict(id=action_id,task_id=task_id,intent=intent['effect'],
                    intent_digest=canonical(intent['effect'])[1]),lookup)
                return VerifiedOutcome(action_id,task_id,run_id,intent_digest,True,2,evidence)
        return EffectServices(Adapter(),Verifier())

    original_propose=store.propose
    async def propose(task_id,*args,**kwargs):
        result=await original_propose(task_id,*args,**kwargs)
        if cfg.get('pause_prepare') and kwargs['intent'].get('kind')=='deferred_tool' and kwargs['intent']['arguments']['slot']==1:
            async with store._transaction(trusted=True) as db:
                task=await store._task(db,task_id,read=True)
            if task['objective']=='prepare':await pause('prepared',task_id)
        return result
    store.propose=propose

    async def verify(context,summary):
        if cfg.get('fail_callbacks') and context.objective=='receipt':raise AssertionError('Completed ACK invoked verifier')
        frozen=await corrections.read(context.task_id,context.run_id,context.correction_token)
        assert frozen['corrections']
        expected='receipt:'+frozen['corrections'][-1]['instruction'] if context.objective=='receipt' else context.objective+' verified'
        assert summary==expected
        if context.objective=='receipt' and summary=='receipt:c2' and cfg.get('pause_verify'):
            await pause('verify',context.task_id,25)
        data=(summary+'\n').encode()
        if context.objective=='execute':
            data=await asyncio.to_thread(control.http,'/rows/'+context.task_id,raw=True)
            assert data==b'row,value\n7,fixed\n'
        return VerifiedTaskResult((dict(key='result',name='result.txt',mediaType='text/plain',data=data),),
            dict(source='synthetic-correction-check',reference=context.task_id,sha256=hashlib.sha256(data).hexdigest()))

    original_complete=store.complete
    async def complete(*args,**kwargs):
        result=await original_complete(*args,**kwargs)
        if cfg.get('pause_publication') and kwargs['summary']=='receipt:c3':await pause('published',result['id'])
        return result
    store.complete=complete
    async with product_worker(client,store,namespace='default',queue=cfg['queue'],load_services=load_services,
        verify_result=verify,plan_effect=plan,load_effect=load_effect,enable_corrections=True):
        (directory/'ready').touch()
        await asyncio.Event().wait()

if __name__=='__main__':asyncio.run(main())
