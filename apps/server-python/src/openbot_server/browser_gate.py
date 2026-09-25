"""Shared Human/Agent serialization. A durable pause survives view loss and process restart."""
import asyncio
from contextlib import asynccontextmanager

from .authority import PostgresTransactions
from .control_errors import ControlError


class BrowserPauseGate:
    def __init__(self, dsn):
        self._database = PostgresTransactions(dsn, application_name="openbot-browser-gate")
        self._active = 0

    @staticmethod
    async def state(db, bot_id):
        row = await (await db.execute(
            "SELECT payload FROM run_events WHERE bot_id=%s AND type='BROWSER_CONTROL_STATE' "
            "ORDER BY created_at DESC,id DESC LIMIT 1", (bot_id,))).fetchone()
        return row["payload"] if row else {"paused": False}

    @asynccontextmanager
    async def human(self, bot_id):
        # Session advisory locks survive the short Owner audit transactions, without holding
        # an idle PG transaction across Worker transport. Closing this dedicated connection unlocks.
        if self._active >= 16:
            raise ControlError(409, "browser_busy")
        self._active += 1
        try:
            async with asyncio.timeout(35):
                async with await self._database._connect() as db:
                    await db.set_autocommit(True)
                    row = await (await db.execute(
                        "SELECT pg_try_advisory_lock(%s,hashtext(%s)) AS held", (1326850642, bot_id))).fetchone()
                    if not row["held"]:
                        raise ControlError(409, "browser_busy")
                    yield db
        finally:
            self._active -= 1

    @asynccontextmanager
    async def agent(self, bot_id):
        """Hold around the COMPLETE browser effect, including result validation/uncertainty.

        This supplies serialization only. The caller still owns Action/Owner authorization.
        Never replace it with a cached paused check or release it before the effect settles.
        """
        async with self.human(bot_id) as db:
            if (await self.state(db, bot_id)).get("paused") is not False:
                raise ControlError(409, "browser_paused_for_human")
            yield
