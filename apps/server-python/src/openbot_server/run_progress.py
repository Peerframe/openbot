"""Read persisted public progress checkpoints; never expose provider text or reasoning."""
import re

from .control_errors import ControlError
from .models import iso_timestamp
from .execution_values import FAILURE_MESSAGES
from .workspace import WorkspaceTransactions

# These descriptions are control-authored. RUN_PROGRESS.message is untrusted and is never read.
STAGES = {
    'context': ('context', 'Read employee context.'),
    'planning': ('planning', 'Choose the next action.'),
    'observation': ('observation', 'Check the action result.'),
    'navigate': ('navigate', 'Open a page.'),
    'screenshot': ('screenshot', 'Capture the current screen.'),
    'model': ('planning', 'Choose the next action.'),
    'tool': ('action', 'Execute an authorized action.'),
}
TERMINAL = ('completed', 'failed', 'cancelled')


def selected_steps(value):
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(r'[1-9][0-9]{0,6}(?:,[1-9][0-9]{0,6}){0,11}', value):
        raise ControlError(422, 'invalid_progress_steps')
    result = [int(item) for item in value.split(',')]
    if len(set(result)) != len(result):
        raise ControlError(422, 'invalid_progress_steps')
    return sorted(result)


def summary(run, facts):
    count = facts['total_steps']
    stage, description = STAGES.get(facts.get('stage'), (None, None))
    if run['status'] == 'waiting_approval':
        stage, description = 'approval', 'Wait for Owner approval.'
    elif run['status'] in TERMINAL:
        stage, description = None, None
    return dict(runId=run['id'], status=run['status'], totalSteps=count,
        currentStepNumber=count or None, stageName=stage, description=description,
        startedAt=iso_timestamp(facts['started_at']) if facts['started_at'] else None,
        endedAt=iso_timestamp(facts['ended_at']) if facts['ended_at'] else None,
        # An event records a checkpoint, not a completed action or an advertised future plan.
        plannedTotalSteps=None, completedSteps=facts.get('completed_steps'),
        failureReasonCode=run.get('error_code') if run['status'] == 'failed' and
            run.get('error_code') in {*FAILURE_MESSAGES, 'task_failed'} else None)


# Product Work uses its existing actions as steps; historical Runs use progress checkpoints.
# No tool arguments, model requests, evidence bodies or provider text enter this relation.
STEP_RELATION = """WITH sources AS (
    SELECT r.id,s.task_id FROM runs r LEFT JOIN work_sources s ON s.legacy_run_id=r.id WHERE r.id=ANY(%s)
), facts AS (
    SELECT s.id AS run_id,a.id,a.created_at,left(a.intent->>'kind',256) AS stage,a.status,
        timing.started_at,timing.ended_at
    FROM sources s JOIN work_actions a ON a.task_id=s.task_id
    LEFT JOIN LATERAL (
        SELECT min(e.created_at) FILTER (WHERE e.kind='action.admitted') AS started_at,
            max(e.created_at) FILTER (WHERE e.kind='action.resolved') AS ended_at
        FROM work_events e WHERE e.task_id=a.task_id AND e.payload->>'actionId'=a.id
            AND e.kind IN ('action.admitted','action.resolved')
    ) timing ON true
    UNION ALL
    SELECT s.id,e.id,e.created_at,left(e.payload->>'stage',256),NULL::text,e.created_at,NULL::timestamptz
    FROM sources s JOIN run_events e ON e.run_id=s.id AND e.type='RUN_PROGRESS' WHERE s.task_id IS NULL
), numbered AS (
    SELECT facts.*,row_number() OVER (PARTITION BY run_id ORDER BY created_at,id COLLATE "C") AS number,
        count(*) OVER (PARTITION BY run_id) AS total FROM facts
) """


async def summaries(db, runs):
    if not runs:
        return {}
    identities = [r['id'] for r in runs]
    rows = await (await db.execute(STEP_RELATION + """SELECT s.id,
        count(n.id) AS total_steps,
        CASE WHEN s.task_id IS NULL THEN NULL ELSE count(n.id) FILTER (WHERE n.status='applied') END AS completed_steps,
        (array_agg(n.stage ORDER BY n.number DESC) FILTER (WHERE n.id IS NOT NULL))[1] AS stage,
        CASE WHEN s.task_id IS NULL THEN
            (SELECT min(created_at) FROM run_events WHERE run_id=s.id AND type='RUN_STARTED')
        ELSE (SELECT min(created_at) FROM work_events WHERE task_id=s.task_id AND kind='run.claimed') END AS started_at,
        CASE WHEN s.task_id IS NULL THEN
            (SELECT max(created_at) FROM run_events WHERE run_id=s.id AND type IN ('RUN_COMPLETED','RUN_FAILED','RUN_CANCELLED'))
        ELSE (SELECT max(created_at) FROM work_events WHERE task_id=s.task_id AND kind IN ('task.completed','task.failed','task.cancelled')) END AS ended_at
        FROM sources s LEFT JOIN numbered n ON n.run_id=s.id GROUP BY s.id,s.task_id""", (identities,))).fetchall()
    facts = {r['id']: r for r in rows}
    return {r['id']: summary(r, facts[r['id']]) for r in runs}


class PostgresRunProgress:
    def __init__(self, dsn):
        self.transactions = WorkspaceTransactions(dsn)

    async def read(self, token, run_id, indices=None):
        async with self.transactions.transaction(token) as db:
            run = await (await db.execute("SELECT r.id,r.status,r.error_code FROM runs_work_projection r "
                "JOIN channels c ON c.id=r.channel_id WHERE r.id=%s AND c.deleted_at IS NULL", (run_id,))).fetchone()
            if run is None:
                raise ControlError(404, 'run_not_found')
            value = (await summaries(db, [run]))[run_id]
            # Number before selection: omitted middle checkpoints retain their actual ordinals.
            rows = await (await db.execute(STEP_RELATION + "SELECT * FROM numbered WHERE "
                "(%s::bigint[] IS NOT NULL AND number=ANY(%s::bigint[])) OR "
                "(%s::bigint[] IS NULL AND (total<=12 OR number<=3 OR number>total-6)) ORDER BY number",
                ([run_id], indices, indices, indices))).fetchall()
            value['steps'] = [dict(id=r['id'], stepNumber=r['number'],
                stageName=STAGES.get(r['stage'], (None, None))[0],
                description=STAGES.get(r['stage'], (None, None))[1],
                startedAt=iso_timestamp(r['started_at']) if r['started_at'] else None,
                endedAt=iso_timestamp(r['ended_at']) if r['ended_at'] else None) for r in rows]
            return value
