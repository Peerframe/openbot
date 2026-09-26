"""Trusted reference ports around the real control store; no general model/provider support."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request,urlopen

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'apps/server-python/src'))
from openbot_server.work_store import PostgresWorkStore
from openbot_server.work_files import LocalWorkFiles
from openbot_server.work_handoff import valid_attempt_id
from openbot_server.work_effects import VerifiedOutcome,recover_action
from openbot_server.work_temporal_effect import ActionPlan,ToolRequest,execute_activity_action
from openbot_server.work_values import canonical,InvalidWork,WorkConflict


class ReceiptMismatch(Exception):pass
class UnresolvedEffect(Exception):pass


def settings():return json.loads(Path(os.environ['OPENBOT_WORK_JOURNEY_CONFIG']).read_text())


def store():
    cfg=settings()
    return PostgresWorkStore(cfg['dsn'],files=LocalWorkFiles(cfg['artifact_root']))


def reference(run_id):return 'openbot-work-v1-'+run_id


def repair_reference(command_id):return 'openbot-repair-v1-'+command_id


def bound_ids():
    from temporalio import activity
    cfg=settings();info=activity.info()
    if info.workflow_id!=reference(cfg['run_id']) or info.workflow_type!='WorkJourney':
        raise WorkConflict('wrong_workflow_scope')
    return cfg['task_id'],cfg['run_id']


def bound_repair(identity):
    from temporalio import activity
    cfg=settings();info=activity.info()
    if (type(identity) is not dict or set(identity)!={'taskId','runId','actionId','commandId'}
            or any(type(identity[key]) is not str or not 1<=len(identity[key])<=128 for key in identity)
            or (identity['taskId'],identity['runId'])!=(cfg['task_id'],cfg['run_id'])
            or info.workflow_id!=repair_reference(identity['commandId'])
            or info.workflow_type!='ClosedRepair'):
        raise WorkConflict('wrong_repair_scope')
    return dict(task_id=identity['taskId'],run_id=identity['runId'],action_id=identity['actionId'])



async def reserved_start_attempt(task_id,run_id):
    """Read the immutable reservation, not an authority grant, before reference effects."""
    s=store()
    async with s._transaction(trusted=True) as db:
        task=await s._task(db,task_id,read=True)
        s._active(task)
        row=await (await db.execute(
            'SELECT a.submission_reference,a.submission_attempt_id FROM work_runs r '
            'JOIN work_admissions a ON a.run_id=r.id WHERE r.task_id=%s AND r.id=%s',
            (task_id,run_id))).fetchone()
        if row is None or row['submission_reference']!='temporal:default:'+reference(run_id):
            return None
        return row['submission_attempt_id']


async def accepted_start_for_repair(task_id,run_id):
    """Read the exact acknowledged original start after closure, without granting authority."""
    s=store()
    async with s._transaction(trusted=True) as db:
        await s._task(db,task_id,read=True)
        row=await (await db.execute(
            'SELECT a.state,a.submission_reference,a.engine_reference,'
            'a.submission_attempt_id,a.engine_first_run_id FROM work_runs r '
            'JOIN work_admissions a ON a.run_id=r.id WHERE r.task_id=%s AND r.id=%s',
            (task_id,run_id))).fetchone()
    expected='temporal:default:'+reference(run_id)
    if (row is None or row['state']!='acknowledged'
            or row['submission_reference']!=expected or row['engine_reference']!=expected
            or not valid_attempt_id(row['submission_attempt_id'])
            or type(row['engine_first_run_id']) is not str
            or not row['engine_first_run_id']):
        raise ReceiptMismatch('Original engine start is not accepted for repair')
    return ({'taskId':task_id,'runId':run_id,'attemptId':row['submission_attempt_id']},
            row['engine_first_run_id'])


async def bind_identity(identity):
    # Dispatch and consumption are separate trust boundaries: a colliding accepted workflow
    # must not use this worker's control configuration before its start input is checked.
    task_id,run_id=bound_ids()
    if (type(identity) is not dict or set(identity)!={'taskId','runId','attemptId'}
            or identity['taskId']!=task_id or identity['runId']!=run_id
            or not valid_attempt_id(identity['attemptId'])
            or identity['attemptId']!=await reserved_start_attempt(task_id,run_id)):
        raise ReceiptMismatch('Workflow start identity does not match this configured worker')


async def inspect():
    task_id,_=bound_ids();s=store()
    async with s._transaction(trusted=True) as db:
        await s._task(db,task_id,read=True)
        return await s._view(db,task_id)


async def existing(key):
    task_id,run_id=bound_ids();s=store()
    async with s._transaction(trusted=True) as db:
        await s._task(db,task_id,read=True)
        c=await db.execute('SELECT * FROM work_actions WHERE task_id=%s AND run_id=%s AND action_key=%s',(task_id,run_id,key))
        return await c.fetchone()


async def claim():
    from temporalio import activity
    info=activity.info();task_id,run_id=bound_ids()
    identity=hashlib.sha256(f'{info.workflow_run_id}:{info.activity_id}:{info.attempt}'.encode()).hexdigest()
    return await store().claim(task_id,run_id,identity,expires_seconds=60)


def policy(intent):
    if intent=={'kind':'read'}:return 0,False
    if intent=={'kind':'write','row':7,'value':'fixed'}:return 2,True
    if intent in ({'kind':'model','stage':v} for v in ('plan','decide','final')):return 3,False
    raise ReceiptMismatch('Unsupported reference operation')


async def propose(key,intent):
    task_id,run_id=bound_ids();cost,approval=policy(intent)
    fence=await claim()
    identity=await store().propose(task_id,run_id,fence=fence,action_key=key,intent=intent,
        reserved_tokens=cost,requires_approval=approval)
    return identity,fence


def http(path,body=None,*,raw=False):
    data=None if body is None else json.dumps(body,separators=(',',':')).encode()
    req=Request(settings()['effect_url']+path,data,{'Content-Type':'application/json'})
    with urlopen(req,timeout=3) as response:
        result=response.read(32769)
        if len(result)>32768:raise ReceiptMismatch('Oversize receipt')
        if raw:return result
        try:return json.loads(result)
        except (ValueError, UnicodeError, RecursionError):
            raise ReceiptMismatch('Receipt is not valid JSON') from None


def verify(row,record):
    expected={'actionId':row['id'],'taskId':row['task_id'],'intent':row['intent']}
    if type(record) is not dict or set(record)!={'actionId','taskId','intent','result','actualTokens'}:
        raise ReceiptMismatch('Receipt shape mismatch')
    if (any(record[k]!=v for k,v in expected.items()) or
            canonical(record['intent'])[1]!=row['intent_digest']):
        raise ReceiptMismatch('Receipt scope or immutable intent mismatch')
    cost,_=policy(row['intent'])
    if type(record['actualTokens']) is not int or record['actualTokens']!=cost:
        raise ReceiptMismatch('Reference cost mismatch')
    kind=row['intent']['kind']
    output='applied' if kind=='write' else 'row 7: old' if kind=='read' else {'plan':'plan','decide':'decide','final':'Row 7 verified'}[row['intent']['stage']]
    if record['result']!=output:raise ReceiptMismatch('Result does not match the owned reference task')
    _,digest=canonical(record)
    return {'source':'owned-effect-lookup','reference':row['id'],'sha256':digest}


async def fault_barrier(name):
    cfg=settings()
    if cfg.get('barrier')!=name:return
    root=Path(cfg['directory']);(root/name).touch()
    deadline=time.monotonic()+40
    while not (root/'release').exists():
        if time.monotonic()>deadline:raise TimeoutError('Parent fault barrier expired')
        await asyncio.sleep(.025)


async def perform(key,intent):
    task_id,_=bound_ids();s=store();row=await existing(key)
    policy(intent)
    if row is not None and row['intent_digest']!=canonical(intent)[1]:raise ReceiptMismatch('Changed logical operation')
    if row is None or row['status']=='proposed':
        identity,fence=await propose(key,intent)
        admitted=await s.admit(identity,fence=fence)
        row=await existing(key)
        if admitted:
            try:
                record=await asyncio.to_thread(http,'/operations',{'actionId':identity,'taskId':task_id,'intent':intent})
            except ReceiptMismatch:
                await s.uncertain(identity)
                raise
            except (OSError,ValueError):
                await s.uncertain(identity)
                await fault_barrier('unknown')
                raise UnresolvedEffect('Query the committed receipt on retry') from None
            if intent['kind']=='write':await fault_barrier('after-effect-response')
            try:evidence=verify(row,record)
            except ReceiptMismatch:
                await s.uncertain(identity)
                raise
            await s.resolve(identity,applied=True,actual_tokens=record['actualTokens'],evidence=evidence)
            return record['result']
    # This path grants nothing. Even after cancellation, it can verify an already-admitted effect.
    if row['status']=='admitted':
        try:await s.uncertain(row['id'])
        except WorkConflict as error:
            if str(error)!='action_not_admitted':raise
            row=await existing(key)
            if row is None or row['status']!='applied':raise
    if row['status'] not in ('admitted','unknown','applied'):raise UnresolvedEffect('No verified result')
    try:record=await asyncio.to_thread(http,'/operations/'+row['id'])
    except HTTPError as error:
        if error.code==404:raise UnresolvedEffect('Receipt absent; do not replay') from None
        raise
    evidence=verify(row,record)
    await s.resolve(row['id'],applied=True,actual_tokens=record['actualTokens'],evidence=evidence)
    return record['result']


# The reviewed reference write. The logical Action key, intent, reservation and approval are
# control facts already created by ``prepare_write``; the request below carries the model's
# transport call ID, which is never the key, fence or authority.
WRITE_KEY='tool:write'
WRITE_INTENT={'kind':'write','row':7,'value':'fixed'}
WRITE_REQUEST={'call_id':'reference-write','tool':'write_row','arguments':{'row':7,'value':'fixed'}}
EXPECTED_NAMESPACE='default'
EXPECTED_WORKFLOW_TYPE='WorkJourney'


class WritePolicy:
    """Trusted policy: map only the reviewed write request to its exact pre-authorized plan.

    The model's call ID never reaches this method, so it can never become the Action key, fence
    or authority. The store's ``propose``/``admit`` transactions still decide admission and the
    Owner approval gate.
    """
    async def plan(self,request:ToolRequest):
        cost,approval=policy(WRITE_INTENT)
        if (request.tool!='write_row'
                or canonical(request.arguments)[1]!=canonical(WRITE_REQUEST['arguments'])[1]
                or (cost,approval)!=(2,True)):
            raise ReceiptMismatch('Unreviewed write request')
        return ActionPlan(action_key=WRITE_KEY,intent=dict(WRITE_INTENT),reserved_tokens=cost,
            requires_approval=approval,expires_seconds=300)


class WriteAdapter:
    """Trusted reference adapter for the disposable fake connector, with probe fault barriers.

    ``apply`` is reached only after the product seam's ``admit`` reports a new admission. The
    POST response is never treated as proof: the seam still performs the authoritative lookup.
    A lost POST response marks the Action unknown and stops at the reference ``unknown`` barrier
    before any lookup, while a committed POST stops at ``after-effect-response`` so the existing
    engine-timeout path stays observable.
    """
    async def apply(self,action_id,intent):
        task_id,_=bound_ids()
        try:
            await asyncio.to_thread(http,'/operations',
                {'actionId':action_id,'taskId':task_id,'intent':intent})
        except ReceiptMismatch:
            await store().uncertain(action_id)
            raise
        except (OSError,ValueError):
            await store().uncertain(action_id)
            await fault_barrier('unknown')
            raise UnresolvedEffect('Query the committed receipt on retry') from None
        await fault_barrier('after-effect-response')
    async def lookup(self,action_id):
        try:
            return await asyncio.to_thread(http,'/operations/'+action_id)
        except HTTPError as error:
            if error.code==404:return None
            raise


class WriteVerifier:
    """Trusted verifier: bind the external receipt to this exact Action, Task/Run and intent."""
    async def verify(self,*,action_id,task_id,run_id,intent_digest,intent,lookup):
        try:
            if canonical(intent)[1]!=canonical(WRITE_INTENT)[1]:
                return None
            evidence=verify({'id':action_id,'task_id':task_id,'intent':intent,
                             'intent_digest':intent_digest},lookup)
        except (ReceiptMismatch,InvalidWork,KeyError,TypeError):
            return None
        return VerifiedOutcome(action_id=action_id,task_id=task_id,run_id=run_id,
            intent_digest=intent_digest,applied=True,actual_tokens=lookup['actualTokens'],
            evidence=evidence)


async def execute_activity_write(client):
    """Run the reviewed write through the product Activity->Action seam for this activity.

    Trusted composition only. The connected client and the trusted namespace/queue/type settings
    are supplied here; ``execute_activity_action`` reads the one current SDK ``activity.info()``
    snapshot itself, so no engine identity is accepted from the workflow or model.
    """
    cfg=settings()
    try:
        return await execute_activity_action(store(),client,expected_namespace=EXPECTED_NAMESPACE,
            expected_queue=cfg['queue'],expected_workflow_type=EXPECTED_WORKFLOW_TYPE,
            request={'call_id':WRITE_REQUEST['call_id'],'tool':WRITE_REQUEST['tool'],
                     'arguments':dict(WRITE_REQUEST['arguments'])},
            policy=WritePolicy(),adapter=WriteAdapter(),verifier=WriteVerifier())
    except WorkConflict as error:
        if str(error)!='admission_closed':
            raise
        # Closing the Task forbids a fresh activity claim. A previously admitted Action still
        # needs its historical receipt recorded, but that is a separate lookup-only operation.
        # The fixed reference Worker gets its Task/Run from trusted local configuration; the
        # product Worker must use an independently scoped repair command instead.
        task_id,run_id=bound_ids()
        row=await existing(WRITE_KEY)
        if (row is None or row['intent_digest']!=canonical(WRITE_INTENT)[1]
                or row['status'] not in ('admitted','unknown','applied','not_applied')):
            raise
        return await recover_action(store(),task_id=task_id,run_id=run_id,
            action_id=row['id'],adapter=WriteAdapter(),verifier=WriteVerifier())


async def prepare_write(call):
    if call!={'name':'write_row','args':{'row':7,'value':'fixed'}}:raise ReceiptMismatch('Unreviewed tool proposal')
    row=await existing('tool:write')
    if row is not None:
        if row['intent_digest']!=canonical({'kind':'write','row':7,'value':'fixed'})[1]:raise ReceiptMismatch('Changed write intent')
        return row['id']
    identity,_=await propose('tool:write',{'kind':'write','row':7,'value':'fixed'})
    return identity


async def decision(action_id):
    snap=await inspect()
    if not snap['authorityActive'] or snap['cancelRequested']:return 'stopped'
    row=next((a for a in snap['actions'] if a['id']==action_id),None)
    if row is None:raise ReceiptMismatch('Unknown action')
    return row['decision']


async def publish(summary):
    task_id,run_id=bound_ids()
    data=await asyncio.to_thread(http,'/rows/'+task_id,raw=True)
    if data!=b'row,value\n7,fixed\n' or summary!='Row 7 verified':raise ReceiptMismatch('CSV result verification failed')
    snap=await inspect()
    # An acknowledgement retry must validate the identical completion without acquiring a new
    # execution grant on an already closed Task. complete() validates its immutable digest.
    fence=None if snap['status']=='completed' else await claim()
    snap=await inspect()
    try:
        result=await store().complete(task_id,run_id,fence=fence,expected_revision=snap['revision'],summary=summary,
        artifacts=[{'key':'verified-csv','name':'corrected.csv','mediaType':'text/csv','data':data}],
        verification={'source':'independent-csv-readback','reference':task_id,'sha256':hashlib.sha256(data).hexdigest()})
    except WorkConflict as error:
        if str(error)=='task_revision_changed':
            raise UnresolvedEffect('Retry publication against the latest Task revision') from None
        raise
    await fault_barrier('after-publication')
    return {'taskId':result['id'],'status':result['status'],'artifactId':result['artifacts'][0]['id']}


async def repair_state():
    """An exhausted fixed write becomes uncertain; this does not grant a new admission."""
    task_id, run_id = bound_ids()
    s = store()
    expected = {'kind':'write', 'row':7, 'value':'fixed'}
    row = await existing('tool:write')
    if row is None or row['intent_digest'] != canonical(expected)[1]:
        raise ReceiptMismatch('No matching existing write to reconcile')
    if row['status'] == 'admitted':
        # Do not hold a Task SHARE lock while the trusted writer takes the exclusive lock.
        # Concurrent verified resolution must never be overwritten by uncertainty.
        try:await s.uncertain(row['id'])
        except WorkConflict as error:
            if str(error) != 'action_not_admitted':raise
    async with s._transaction(trusted=True) as db:
        await s._task(db, task_id, read=True)
        cursor = await db.execute("SELECT id,status,intent_digest FROM work_actions WHERE task_id=%s AND run_id=%s "
                                  "AND action_key='tool:write'", (task_id, run_id))
        row = await cursor.fetchone()
        if row is None or row['intent_digest'] != canonical(expected)[1]:
            raise ReceiptMismatch('No matching existing write to reconcile')
        cursor = await db.execute('SELECT id FROM work_reconciliation_commands WHERE action_id=%s '
                                  'AND finished_at IS NULL ORDER BY sequence LIMIT 1', (row['id'],))
        command = await cursor.fetchone()
        return {'actionId': row['id'], 'status': row['status'],
                'commandId': command['id'] if command else None}


async def reconcile_write(command_id):
    """A repair cycle may only GET a historical receipt. It cannot propose, admit or POST."""
    from openbot_server.work_reconciliation import ReconciliationStore
    task_id, run_id = bound_ids()
    row = await existing('tool:write')
    if row is None:
        raise ReceiptMismatch('No write receipt scope')
    repairs = ReconciliationStore(store())
    scope = dict(task_id=task_id, run_id=run_id, action_id=row['id'])
    command = await repairs.read(command_id, **scope)
    return await reconcile_existing(command_id, command, row, repairs, scope)


async def reconcile_closed(identity):
    """An ended workflow may only verify the original receipt through a separate engine run."""
    from openbot_server.work_reconciliation import ReconciliationStore
    scope=bound_repair(identity)
    command_id=identity['commandId']
    repairs=ReconciliationStore(store())
    command=await repairs.read(command_id, **scope)
    s=store()
    async with s._transaction(trusted=True) as db:
        _,row=await s._action(db,scope['action_id'])
    expected={'kind':'write','row':7,'value':'fixed'}
    if row['action_key']!='tool:write' or row['intent_digest']!=canonical(expected)[1]:
        raise ReceiptMismatch('No matching existing write to reconcile')
    return await reconcile_existing(command_id, command, row, repairs, scope)


async def reconcile_existing(command_id, command, row, repairs, scope):
    """Shared lookup-only settlement; neither caller can create an external operation."""
    if command['outcome'] == 'unresolved':
        raise WorkConflict('reconciliation_cycle_finished')
    if row['status'] in ('applied', 'not_applied'):
        await repairs.finish(command_id, **scope, outcome='resolved')
        return row['status']
    if row['status'] != 'unknown':
        raise WorkConflict('reconciliation_unavailable')
    try:
        record = await asyncio.to_thread(http, '/operations/' + row['id'])
    except HTTPError as error:
        if error.code == 404:
            raise UnresolvedEffect('Receipt absent; do not replay') from None
        raise
    evidence = verify(row, record)
    await store().resolve(row['id'], applied=True, actual_tokens=record['actualTokens'], evidence=evidence)
    await fault_barrier('after-repair-resolution')
    await repairs.finish(command_id, **scope, outcome='resolved')
    return record['result']


async def finish_failed_repair(command_id):
    from openbot_server.work_reconciliation import ReconciliationStore
    task_id, run_id = bound_ids()
    row = await existing('tool:write')
    if row is None:
        raise ReceiptMismatch('No write receipt scope')
    scope = dict(task_id=task_id, run_id=run_id, action_id=row['id'])
    await finish_unresolved(command_id, scope, row)


async def finish_closed_repair(identity):
    scope=bound_repair(identity)
    s=store()
    async with s._transaction(trusted=True) as db:
        _,row=await s._action(db,scope['action_id'])
    await finish_unresolved(identity['commandId'],scope,row)


async def finish_unresolved(command_id, scope, row):
    from openbot_server.work_reconciliation import ReconciliationStore
    repairs = ReconciliationStore(store())
    outcome = 'resolved' if row['status'] in ('applied', 'not_applied') else 'unresolved'
    try:
        await repairs.finish(command_id, **scope, outcome=outcome)
    except WorkConflict as error:
        if str(error) not in ('reconciliation_outcome_unverified', 'reconciliation_outcome_changed'):
            raise
        current = await repairs.read(command_id, **scope)
        if current['outcome'] is not None:
            # Another trusted observer already closed this immutable cycle.
            return
        s=store()
        async with s._transaction(trusted=True) as db:
            _,row=await s._action(db,scope['action_id'])
        if row['status'] not in ('applied', 'not_applied'):
            raise
        await repairs.finish(command_id, **scope, outcome='resolved')
