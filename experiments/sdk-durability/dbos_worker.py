"""Official DBOSDurability recovery probe; native history is trusted fixture data only."""
import asyncio
import json
from pathlib import Path
from dbos import DBOS, SetWorkflowID, WorkflowSerializationFormat
from pydantic_ai.durable_exec.dbos import DBOSDurability
from pydantic_ai.usage import UsageLimits
from strategy import settings,build_agent,read_row,mark_waiting,apply_external,resume

cfg=settings()
read=read_row if cfg['inline'] else DBOS.step(name='probe.read',retries_allowed=False)(read_row)
agent=build_agent(DBOSDurability(model_step_config={'retries_allowed':False},parallel_execution_mode='sequential'),read)
waiting=DBOS.step(name='probe.waiting',retries_allowed=False)(mark_waiting)
apply=DBOS.step(name='probe.apply',retries_allowed=False)(apply_external)


@DBOS.workflow(name='sdk-work',serialization_type=WorkflowSerializationFormat.PORTABLE if cfg.get('portable') else WorkflowSerializationFormat.NATIVE)
async def work():
    first=await agent.run('Correct row 7',usage_limits=UsageLimits(request_limit=4))
    await asyncio.to_thread(waiting)
    approval=await DBOS.recv_async('approval',timeout_seconds=60)
    if approval!={'approved':True}:return {'outcome':'denied','requests':first.usage.requests}
    return await resume(agent,first,await asyncio.to_thread(apply))


if __name__=='__main__':
    DBOS(config={'name':'openbot-sdk-probe','system_database_url':cfg['dbos_url'],
        'application_version':'sdk-probe-v1','executor_id':'sdk-probe-local',
        'enable_otlp':False,'console_log_level':'ERROR','sys_db_pool_size':5})
    DBOS.launch();Path(cfg['directory'],'ready').touch()
    try:
        if cfg['start']:
            with SetWorkflowID(cfg['case']):handle=DBOS.start_workflow(work)
        else:handle=DBOS.retrieve_workflow(cfg['case'])
        Path(cfg['directory'],'result.json').write_text(json.dumps(handle.get_result()))
    finally:DBOS.destroy()
