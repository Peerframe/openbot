"""Primary recipient preference only; no approval, plugin, computer or delegation authority."""
from typing import Annotated
from uuid import uuid4

from psycopg.types.json import Jsonb
from pydantic import Field

from .authority import OwnerTransactions
from .browser_protocol import Strict
from .control_errors import ControlError
from .owner_preferences import Revision


class PrimaryBotInput(Strict):
    botId: Annotated[str, Field(min_length=1, max_length=128)] | None
    expectedRevision: Revision


def project(row):
    return dict(primaryBotId=row['primary_bot_id'], revision=row['revision'])


async def current_workspace_settings(db, *, update=False):
    # All participating writers/readers take this lock before Bot/channel row locks.
    row = await (await db.execute("SELECT primary_bot_id,revision FROM workspace_settings "
        "WHERE workspace_id='workspace' " + ('FOR UPDATE' if update else 'FOR SHARE'))).fetchone()
    if row is None: raise ControlError(503, 'workspace_settings_unavailable')
    return row


async def publish_primary_bot(db, previous, bot_id, *, reason):
    if previous['primary_bot_id'] == bot_id: return project(previous)
    if previous['revision'] == 2147483647: raise ControlError(409, 'workspace_revision_exhausted')
    row = await (await db.execute("UPDATE workspace_settings SET primary_bot_id=%s,revision=revision+1 "
        "WHERE workspace_id='workspace' RETURNING primary_bot_id,revision", (bot_id,))).fetchone()
    await db.execute("INSERT INTO run_events(id,type,payload) VALUES(%s,'SETTINGS_PRIMARY_BOT_UPDATED',%s)",
        (str(uuid4()), Jsonb(dict(actor='owner',previousBotId=previous['primary_bot_id'],
            primaryBotId=bot_id,revision=row['revision'],reason=reason))))
    return project(row)


async def default_primary_bot(db, previous, bot_id, *, reason):
    if previous['primary_bot_id'] is None:
        await publish_primary_bot(db, previous, bot_id, reason=reason)


class WorkspaceSettings:
    def __init__(self, dsn):
        self.transactions = OwnerTransactions(dsn, application_name='openbot-workspace-settings')

    async def update(self, token, value):
        async with self.transactions.transaction(token) as db:
            command = PrimaryBotInput.model_validate(value)
            previous = await current_workspace_settings(db, update=True)
            if command.expectedRevision != previous['revision']:
                raise ControlError(409, 'workspace_revision_conflict')
            if command.botId is not None:
                bot = await (await db.execute('SELECT id FROM bots WHERE id=%s AND deleted_at IS NULL FOR SHARE',
                    (command.botId,))).fetchone()
                if bot is None: raise ControlError(404, 'bot_not_found')
            return await publish_primary_bot(db, previous, command.botId, reason='selected')
