"""Owned fixture services around the product Worker; no Workflow or Agent duplication."""
import asyncio
import hashlib
from pathlib import Path

from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
import control
import multitask_worker as reference
from engine_client import connect
from openbot_server.work_worker import product_worker, VerifiedTaskResult, TYPE


async def main():
    cfg = control.settings()
    store = control.store()
    client = await connect(cfg['temporal_address'], cfg.get('engine_tls'), plugins=[PydanticAIPlugin()])
    reference._STORE, reference._CLIENT = store, client
    reference._SCOPE = dict(expected_namespace='default', expected_queue=cfg['queue'], expected_workflow_type=TYPE)
    directory = Path(cfg['directory'])
    fail_callbacks = cfg.get('fail_callbacks', False)

    def load_services(context):
        if fail_callbacks:
            raise AssertionError('Recovery invoked model/tool service assembly')
        return reference.load_services(context)

    async def verify(context, summary):
        if fail_callbacks:
            raise AssertionError('Completed result recovery reran verifier')
        # This verifier only proves the explicit synthetic observation task, never arbitrary work.
        if summary != context.objective + ': verified':
            return None
        data = (summary + '\n').encode()
        async with store._transaction(trusted=True) as db:
            actions = await (await db.execute('SELECT status,intent FROM work_actions WHERE run_id=%s',
                                              (context.run_id,))).fetchall()
        if len(actions) != 3 or any(a['status'] != 'applied' for a in actions):
            return None
        if [a['intent'] for a in actions].count({'kind': 'read'}) != 1:
            return None
        return VerifiedTaskResult(({'key': 'observation', 'name': 'observation.txt',
            'mediaType': 'text/plain', 'data': data},),
            {'source': 'synthetic-observation-check', 'reference': context.task_id,
             'sha256': hashlib.sha256(data).hexdigest()})

    original = store.complete
    async def completed_then_pause(*args, **kwargs):
        result = await original(*args, **kwargs)
        if cfg.get('pause_publication'):
            (directory / ('published-' + result['id'])).touch()
            async with asyncio.timeout(65):
                while not (directory / 'release-publication').exists():
                    await asyncio.sleep(.05)
        return result
    store.complete = completed_then_pause
    async with product_worker(client, store, namespace='default', queue=cfg['queue'],
                               load_services=load_services, verify_result=verify):
        (directory / 'ready').touch()
        await asyncio.Event().wait()


if __name__ == '__main__':
    asyncio.run(main())
