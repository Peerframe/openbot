"""Prepared Markdown in immutable tool observations; publication remains a separate transaction."""
import hashlib
import asyncio
from copy import deepcopy
from .execution_values import _report_name

from .work_deferred import DeferredPlan, EffectServices
from .work_product_binding import ProductWorkBinding
from .work_tool_results import ToolResponseAdapter, ToolResponseVerifier
from .work_values import InvalidWork, WorkConflict, canonical


def report(value):
    if type(value) is not dict or set(value) != {'name','markdown'}:
        raise InvalidWork('invalid_report')
    name, markdown = value['name'], value['markdown']
    try:
        if type(name) is not str: raise ValueError()
        _report_name(name)
    except ValueError:
        raise InvalidWork('invalid_report') from None
    if type(markdown) is not str or '\0' in markdown:
        raise InvalidWork('invalid_report')
    try:
        data = markdown.encode('utf-8')
        if not 1 <= len(markdown.encode('utf-16-le'))//2 <= 24000 or len(data) > 24*1024:
            raise ValueError()
    except (UnicodeError,ValueError):
        raise InvalidWork('report_limit') from None
    return dict(name=name,mediaType='text/markdown',text=markdown,sha256=hashlib.sha256(data).hexdigest())


class ProductWorkArtifacts:
    def __init__(self, store, client, scope, results):
        self.store, self.results = store, results
        self.binding = ProductWorkBinding(store,client,scope)

    async def prepare(self, context, request):
        if request.tool != 'write_report': raise InvalidWork('unknown_product_tool')
        prepared = report(request.arguments)
        async with self.store._transaction(trusted=True) as db:
            await self.binding.check(db,context,require_fence=False)
            await self._capacity(db,context,prepared['name'])
        if canonical(request.arguments,max_bytes=65536)[1] != request.digest:
            raise InvalidWork('report_proposal_changed')
        blob = await asyncio.to_thread(self.store.files.put,prepared['text'].encode('utf-8'))
        async with self.store._transaction(trusted=True) as db:
            await self.binding.check(db,context,require_fence=False)
            await self._capacity(db,context,prepared['name'])
        return DeferredPlan(dict(kind='work_report',version=2,sha256=prepared['sha256']),0,False,
            prepared_arguments=dict(name=prepared['name'],markdownBlob=blob))

    def _validate(self, intent):
        if (type(intent) is not dict or set(intent) not in ({'kind','tool','arguments','effect'},
                {'kind','tool','arguments','effect','proposalSha256'})
                or intent['kind'] != 'deferred_tool' or intent['tool'] != 'write_report'):
            raise WorkConflict('report_intent_changed')
        args=intent['arguments']
        version=1
        if 'proposalSha256' in intent:
            version=2
            if (type(args) is not dict or set(args)!={'name','markdownBlob'}
                    or type(args['markdownBlob']) is not dict
                    or set(args['markdownBlob'])!={'sha256','sizeBytes'}
                    or type(args['markdownBlob']['sizeBytes']) is not int
                    or not 1<=args['markdownBlob']['sizeBytes']<=24*1024):
                raise WorkConflict('report_intent_changed')
            blob=args['markdownBlob']
            try:
                data=self.store.files.read(blob['sha256'],blob['sizeBytes'])
                args=dict(name=args['name'],markdown=data.decode('utf-8'))
            except UnicodeError:
                raise WorkConflict('report_intent_changed') from None
            if canonical(args,max_bytes=65536)[1]!=intent['proposalSha256']:
                raise WorkConflict('report_intent_changed')
        prepared = report(args)
        if intent['effect'] != dict(kind='work_report',version=version,sha256=prepared['sha256']):
            raise WorkConflict('report_intent_changed')
        return prepared

    async def _capacity(self, db, context, name, action_id=None):
        # Include admitted/unknown reservations: receipt loss cannot free a report slot.
        rows = await (await db.execute("SELECT id,intent FROM work_actions WHERE task_id=%s "
            "AND authority_generation=(SELECT authority_generation FROM work_tasks WHERE id=%s) "
            "AND intent->>'tool'='write_report' AND status<>'superseded' AND (%s::text IS NULL OR id<>%s) "
            'ORDER BY id LIMIT 3',(context.task_id,context.task_id,action_id,action_id))).fetchall()
        if len(rows) >= 2 or any(row['intent']['arguments']['name']==name for row in rows):
            raise WorkConflict('report_limit')

    async def load(self, context, intent):
        self._validate(intent)
        async def invoke(action_id, original):
            prepared = self._validate(original)
            async with self.store._transaction(trusted=True) as db:
                await self.store._task(db,context.task_id)
                await self.binding.check(db,context,action_id=action_id,intent=original)
                await self._capacity(db,context,prepared['name'],action_id)
            return dict(schema='openbot.work-report/v1',artifact=prepared,
                        payload=dict(name=prepared['name'],status='prepared',publishedOnTaskCompletion=True))
        return EffectServices(ToolResponseAdapter(self.results,invoke,task_id=context.task_id,
            run_id=context.run_id,intent_digest=canonical(intent)[1]),ToolResponseVerifier(self.results))

    async def load_result(self, context, row):
        self._validate(row['intent'])
        await self.binding.claim(context)
        async with self.store._transaction(trusted=True) as db:
            await self.binding.check(db,context)
        observed = await self.results.load(row['id'],task_id=context.task_id,run_id=context.run_id,
                                          intent_digest=row['intent_digest'])
        value = self._observation(row,observed)
        async with self.store._transaction(trusted=True) as db:
            await self.binding.check(db,context)
        return deepcopy(value['payload'])

    def _observation(self, row, observed):
        prepared = self._validate(row['intent'])
        expected = dict(schema='openbot.work-report/v1',artifact=prepared,
                        payload=dict(name=prepared['name'],status='prepared',publishedOnTaskCompletion=True))
        if observed is None or observed.value != expected or row['status'] != 'applied':
            raise WorkConflict('report_observation_invalid')
        return expected

    async def artifacts(self, context):
        async with self.store._transaction(trusted=True) as db:
            await self.binding.check(db,context)
            rows = await (await db.execute("SELECT * FROM work_actions WHERE task_id=%s AND run_id=%s "
                "AND authority_generation=(SELECT authority_generation FROM work_tasks WHERE id=%s) "
                "AND intent->>'tool'='write_report' AND status='applied' ORDER BY created_at,id LIMIT 3",
                (context.task_id,context.run_id,context.task_id))).fetchall()
        if len(rows)>2: raise WorkConflict('report_limit')
        result=[]
        for row in rows:
            observed=await self.results.load(row['id'],task_id=context.task_id,run_id=context.run_id,
                                            intent_digest=row['intent_digest'])
            value=self._observation(row,observed)['artifact']
            result.append(dict(key=row['id'],name=value['name'],mediaType=value['mediaType'],
                               data=value['text'].encode('utf-8')))
        async with self.store._transaction(trusted=True) as db:
            await self.binding.check(db,context)
        return tuple(result)
