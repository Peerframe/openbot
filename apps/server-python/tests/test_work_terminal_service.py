"""The existing finite pass owns scan order only, never execution or idempotency."""
import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
pytest.importorskip('temporalio', reason='optional Worker SDK profile')

from openbot_server import work_product_service as module
from openbot_server.work_terminal import TerminalBatch, TerminalCursor


def service():
    return module.ProductWorkService(SimpleNamespace(files=object()),'/unused-private-config',compose=lambda:None)


def test_existing_pass_orders_terminal_before_repair_and_keeps_non_authoritative_cursor():
    async def check():
        value=service();calls=[];cursor=TerminalCursor(datetime.now(timezone.utc),'task',1,'run')
        async def dispatch(*_,**kwargs):calls.append('dispatch');return []
        async def terminal(*_,**kwargs):
            calls.append(('terminal',kwargs['after']))
            return TerminalBatch((dict(status='closed'),dict(status='unconfirmed')),cursor)
        async def repair(*_,**kwargs):calls.append('repair');return []
        config=dict(namespace='default',queue='fixture',limit=2,item_timeout_seconds=1,execution_timeout_seconds=10)
        with patch.object(module,'dispatch_batch',dispatch),patch.object(module,'terminal_batch',terminal),patch.object(module,'repair_batch',repair):
            await value._pass(SimpleNamespace(namespace='default'),config,repair=True)
            assert calls==['dispatch',('terminal',None),'repair']
            assert value.status['lastPass']['terminalClosures']==value.status['lastPass']['terminalUnconfirmed']==1
            calls.clear();await value._pass(SimpleNamespace(namespace='default'),config,repair=False)
            assert calls==['dispatch',('terminal',cursor)]
        assert service()._terminal_cursor is None
    asyncio.run(check())


def test_observation_failure_is_bounded_and_does_not_skip_existing_owner_repair():
    async def check():
        value=service();repair=AsyncMock(return_value=[])
        config=dict(namespace='default',queue='fixture',limit=2,item_timeout_seconds=1,execution_timeout_seconds=10)
        with patch.object(module,'dispatch_batch',AsyncMock(return_value=[])), \
                patch.object(module,'terminal_batch',AsyncMock(side_effect=RuntimeError('private endpoint'))), \
                patch.object(module,'repair_batch',repair):
            await value._pass(SimpleNamespace(namespace='default'),config,repair=True)
        assert repair.await_count==1 and value.status['lastPass']['errors']==1
        assert value._terminal_cursor is None and 'private' not in str(value.status)
    asyncio.run(check())
