"""The coexistence bridge only invalidates; a broken listener cannot serve stale readiness."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import psycopg
import pytest

from openbot_server.app import create_app
from openbot_server.database import StoreUnavailable
from openbot_server.ts_product_events import ProductInvalidations
from openbot_server.ts_product_ownership import owns


def test_product_ownership_requires_private_product_composition():
    for group in ('identity', 'unknown'):
        with pytest.raises(ValueError, match='private product'):
            create_app(AsyncMock(), owner_name='Owner', ts_product_group=group)
    assert owns('PATCH', '/api/v1/bots/fixture/profile')
    assert not owns('DELETE', '/api/v1/bots/fixture')
    assert not owns('POST', '/api/v1/bots/quick')
    assert not owns('PATCH', '/api/v1/bots/fixture/profile/extra')


def test_invalidation_listener_filters_payload_and_fails_closed(monkeypatch):
    async def scenario():
        connection = AsyncMock()
        async def notifications():
            yield SimpleNamespace(channel='unrelated', payload='')
            yield SimpleNamespace(channel='openbot_product_changed', payload='untrusted')
            yield SimpleNamespace(channel='openbot_product_changed', payload='')
            raise psycopg.OperationalError('synthetic disconnected listener')
        connection.notifies = notifications
        monkeypatch.setattr(psycopg.AsyncConnection, 'connect', AsyncMock(return_value=connection))
        bridge = ProductInvalidations('unused fixture DSN')
        await bridge.start()
        await bridge.task
        assert bridge.count == 1
        with pytest.raises(StoreUnavailable):
            bridge.revision()
        await bridge.close()
        connection.close.assert_awaited_once()
    asyncio.run(scenario())
