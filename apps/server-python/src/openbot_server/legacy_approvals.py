"""Retained Worker approval records stay single-use and Owner-authorized during migration."""
from uuid import uuid4
from psycopg.types.json import Jsonb
from .authority import OwnerTransactions
from .control_errors import ControlError
from .task_models import project_run
from .workspace import approval, public


class PostgresLegacyApprovals:
    def __init__(self,dsn): self.transactions=OwnerTransactions(dsn)

    async def decide(self,token,identity,value):
        if type(value) is not dict or value.get('decision') not in ('approve','reject'):
            raise ControlError(422,'invalid_approval_decision')
        async with self.transactions.transaction(token) as db:
            row=await (await db.execute('SELECT run_id FROM approvals WHERE id=%s',(identity,))).fetchone()
            if row is None: raise ControlError(404,'approval_not_found')
            run=await (await db.execute('SELECT * FROM runs WHERE id=%s FOR UPDATE',(row['run_id'],))).fetchone()
            current=await (await db.execute('SELECT *,expires_at<=clock_timestamp() AS expired FROM approvals WHERE id=%s FOR UPDATE',(identity,))).fetchone()
            if current['status']!='pending' or run['status']!='waiting_approval':
                raise ControlError(409,'approval_already_resolved')
            status='expired' if current['expired'] else 'approved' if value['decision']=='approve' else 'rejected'
            current=await (await db.execute("UPDATE approvals SET status=%s,decided_by='owner',decided_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=%s RETURNING *",(status,identity))).fetchone()
            run=await (await db.execute("UPDATE runs SET status=%s,updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=%s RETURNING *",('running' if status=='approved' else 'blocked',run['id']))).fetchone()
            await db.execute('INSERT INTO run_events(id,run_id,channel_id,bot_id,node_id,type,payload) VALUES(%s,%s,%s,%s,%s,%s,%s)',
                (str(uuid4()),run['id'],run['channel_id'],run['bot_id'],current['node_id'],'APPROVAL_'+status.upper(),
                 Jsonb(dict(approvalId=identity,action=current['action'],targetFingerprint=current['target_fingerprint'],decidedBy='owner'))))
            current.update(channel_id=run['channel_id'],bot_id=run['bot_id'])
            return dict(approval=approval(current),run=public(project_run(run)))
