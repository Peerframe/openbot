"""Coexistence-only invalidation bridge; no facts, credentials, or execution authority.

PostgreSQL emits NOTIFY only on commit. Python remains the single SSE owner until its
projection cohort moves; this listener is removed with that owner. A lost listener makes
streams fail closed rather than silently claiming that their state is current.
"""
import asyncio
import psycopg
from .database import StoreUnavailable


class ProductInvalidations:
    def __init__(self, dsn):
        self.dsn = dsn
        self.connection = self.task = None
        self.count = 0
        self.failed = False

    async def start(self):
        self.connection = await psycopg.AsyncConnection.connect(self.dsn, autocommit=True,
            connect_timeout=3, application_name='openbot-ts-product-events',
            options='-c statement_timeout=3000 -c search_path=public,pg_catalog')
        try:
            await self.connection.execute('LISTEN openbot_product_changed')
        except BaseException:
            await self.connection.close()
            raise
        self.task = asyncio.create_task(self._listen())

    async def _listen(self):
        try:
            async for event in self.connection.notifies():
                if event.channel == 'openbot_product_changed' and event.payload == '':
                    self.count += 1
        except psycopg.Error:
            self.failed = True

    def revision(self):
        if self.failed:
            raise StoreUnavailable('product_invalidation_unavailable')
        return self.count

    async def close(self):
        if self.task is not None:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        if self.connection is not None:
            await self.connection.close()
