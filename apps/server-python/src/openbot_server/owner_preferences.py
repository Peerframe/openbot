"""Server-owned display timezone and new Employee model defaults; no credential or inference effects."""
from typing import Annotated
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import re

from psycopg.types.json import Jsonb
from pydantic import AfterValidator, Field, ValidationError

from .authority import OwnerTransactions
from .browser_protocol import Strict
from .control_errors import ControlError
from .model_connections_inputs import ModelSelection
from .models import iso_timestamp
from .profile_details import _mathematical_integer
from pydantic import BeforeValidator


def timezone_key(value):
    if not re.fullmatch(r'[A-Za-z_]+(?:/[A-Za-z0-9_+.-]+)*',value) or any(part in ('.','..') for part in value.split('/')):
        raise ValueError('Invalid timezone key.')
    try: ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError): raise ValueError('Unknown IANA timezone.') from None
    return value


Timezone = Annotated[str, Field(min_length=1,max_length=64), AfterValidator(timezone_key)]
Revision = Annotated[int, Field(ge=1,le=2147483647), BeforeValidator(_mathematical_integer)]


class PreferencesInput(Strict):
    expectedRevision: Revision
    timezone: Timezone
    defaultModel: ModelSelection | None


def project_preferences(row):
    value = PreferencesInput.model_validate(dict(expectedRevision=row['revision'],timezone=row['timezone'],defaultModel=row['default_model']))
    return dict(revision=value.expectedRevision,timezone=value.timezone,defaultModel=None if value.defaultModel is None else value.defaultModel.model_dump(),updatedAt=iso_timestamp(row['updated_at']))


async def current_preferences(db, *, update=False):
    row=await (await db.execute("SELECT * FROM owner_preferences WHERE owner_id='owner' "+('FOR UPDATE' if update else 'FOR SHARE'))).fetchone()
    if row is None: raise ControlError(503,'owner_preferences_unavailable')
    try: return project_preferences(row)
    except (ValidationError, ValueError, TypeError, KeyError): raise ControlError(503,'owner_preferences_unavailable') from None


class OwnerPreferences:
    def __init__(self,dsn,*,model_connections=None):
        self.transactions=OwnerTransactions(dsn,application_name='openbot-owner-preferences')
        self.connections=model_connections

    async def get(self,token):
        async with self.transactions.transaction(token) as db:
            return await current_preferences(db)

    async def update(self,token,value):
        # Token-first even for malformed bodies; the route additionally checks exact Origin.
        async with self.transactions.transaction(token) as db:
            command=PreferencesInput.model_validate(value)
            previous=await current_preferences(db,update=True)
            if command.expectedRevision!=previous['revision']: raise ControlError(409,'owner_preferences_revision_conflict')
            selection=None if command.defaultModel is None else command.defaultModel.model_dump()
            if selection is not None:
                if self.connections is None: raise ControlError(503,'model_selection_unavailable')
                await self.connections.resolve_in_transaction(db,selection)
            if (command.timezone,selection)==(previous['timezone'],previous['defaultModel']): return previous
            if previous['revision']==2147483647: raise ControlError(409,'owner_preferences_revision_exhausted')
            row=await (await db.execute("UPDATE owner_preferences SET timezone=%s,default_model=%s,revision=revision+1,updated_at=clock_timestamp() WHERE owner_id='owner' RETURNING *",
                (command.timezone,None if selection is None else Jsonb(selection)))).fetchone()
            # Values are public preferences, but audit only the field names and revision.
            changed=(["timezone"] if command.timezone!=previous['timezone'] else [])+(["defaultModel"] if selection!=previous['defaultModel'] else [])
            await db.execute("INSERT INTO run_events(id,type,payload) VALUES(%s,'SETTINGS_OWNER_UPDATED',%s)",
                (str(uuid4()),Jsonb(dict(actor='owner',changed=changed,revision=row['revision']))))
            return project_preferences(row)
