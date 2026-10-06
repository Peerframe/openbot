"""Owner selects an enabled official OpenAI connection; credentials stay in model connections."""
from uuid import uuid4

from psycopg.types.json import Jsonb

from .authority import OwnerTransactions
from .browser_protocol import Strict
from .control_errors import ControlError
from .model_connections_inputs import ConnectionId
from .owner_preferences import Revision


class TranscriptionInput(Strict):
    expectedRevision: Revision
    connectionId: ConnectionId | None


def project(row):
    return dict(revision=row['revision'], connectionId=row['transcription_connection_id'])


class TranscriptionSettings:
    def __init__(self, dsn, connections):
        self.transactions = OwnerTransactions(dsn, application_name='openbot-transcription-settings')
        self.connections = connections

    async def _row(self, db, *, update=False):
        row = await (await db.execute("SELECT revision,transcription_connection_id FROM owner_preferences "
            "WHERE owner_id='owner' " + ('FOR UPDATE' if update else 'FOR SHARE'))).fetchone()
        if row is None: raise ControlError(503, 'owner_preferences_unavailable')
        return row

    async def get(self, token):
        async with self.transactions.transaction(token) as db:
            return project(await self._row(db))

    async def resolve_in_transaction(self, db):
        row = await self._row(db)
        if row['transcription_connection_id'] is None:
            raise ControlError(415, 'enabled_openai_transcription_required')
        return await self._resolve(db, row['transcription_connection_id'])

    async def _resolve(self, db, identity):
        if self.connections is None: raise ControlError(503, 'model_selection_unavailable')
        selected = await self.connections.resolve_in_transaction(db, dict(connectionId=identity, modelId='whisper-1'))
        if (selected is None or selected.preset_id != 'openai' or selected.source != 'saved'
                or selected.base_url != 'https://api.openai.com/v1'):
            raise ControlError(415, 'enabled_openai_transcription_required')
        return selected

    async def update(self, token, value):
        async with self.transactions.transaction(token) as db:
            command = TranscriptionInput.model_validate(value)
            previous = await self._row(db, update=True)
            if command.expectedRevision != previous['revision']:
                raise ControlError(409, 'owner_preferences_revision_conflict')
            if command.connectionId is not None: await self._resolve(db, command.connectionId)
            if command.connectionId == previous['transcription_connection_id']: return project(previous)
            if previous['revision'] == 2147483647: raise ControlError(409, 'owner_preferences_revision_exhausted')
            row = await (await db.execute("UPDATE owner_preferences SET transcription_connection_id=%s,"
                "revision=revision+1,updated_at=clock_timestamp() WHERE owner_id='owner' RETURNING *",
                (command.connectionId,))).fetchone()
            await db.execute("INSERT INTO run_events(id,type,payload) VALUES(%s,'SETTINGS_OWNER_UPDATED',%s)",
                (str(uuid4()), Jsonb(dict(actor='owner',changed=['transcriptionConnection'],revision=row['revision']))))
            return project(row)
