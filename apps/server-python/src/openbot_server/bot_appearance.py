"""Strict, revision-guarded cosmetic edits; they grant no authority or evolution."""
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb

from .database import StoreUnavailable
from .models import Bot, BotAppearance, PublicModel, project_bot
from .profile_details import ExpectedRevision, ProfileConflict, ProfileNotFound


class AppearanceInput(PublicModel):
    expectedRevision: ExpectedRevision
    appearance: BotAppearance


class AppearanceResult(PublicModel):
    bot: Bot
    revision: int


async def update_appearance(transactions, token, bot_id, value: AppearanceInput):
    try:
        async with transactions.transaction(token) as db:
            current = await (await db.execute(
                "SELECT * FROM bots WHERE id=%s AND deleted_at IS NULL FOR UPDATE", (bot_id,))).fetchone()
            if current is None:
                raise ProfileNotFound()
            if current['profile_revision'] != value.expectedRevision:
                raise ProfileConflict()
            appearance = value.appearance.model_dump(mode='json')
            before = (current['configuration'] or {}).get('appearance')
            if before == appearance:
                return AppearanceResult(bot=project_bot(current), revision=current['profile_revision'])
            row = await (await db.execute(
                "UPDATE bots SET configuration=jsonb_set(configuration,'{appearance}',%s), "
                "profile_revision=profile_revision+1,updated_at=date_trunc('milliseconds',statement_timestamp()) "
                "WHERE id=%s AND profile_revision=%s AND deleted_at IS NULL RETURNING *",
                (Jsonb(appearance), bot_id, value.expectedRevision))).fetchone()
            if row is None:
                raise ProfileConflict()
            await db.execute(
                "INSERT INTO run_events(id,bot_id,type,payload,created_at) "
                "VALUES (%s,%s,'EMPLOYEE_APPEARANCE_UPDATED',%s,%s)",
                (str(uuid4()), bot_id, Jsonb(dict(actor='owner', **{'from': before, 'to': appearance},
                                                 revision=row['profile_revision'])), row['updated_at']))
            return AppearanceResult(bot=project_bot(row), revision=row['profile_revision'])
    except (psycopg.Error, TimeoutError, ValueError, KeyError, TypeError):
        raise StoreUnavailable('appearance_storage_unavailable') from None
