"""Real socket binding refusals; synthetic identity, no Provider/browser execution."""
import asyncio
from contextlib import asynccontextmanager
from dataclasses import FrozenInstanceError, asdict, replace
from datetime import datetime, timedelta, timezone
import json
from uuid import uuid4

import pytest

from openbot_server.models import iso_timestamp
from test_browser_sessions import CAP
from test_worker_host_socket import client, hello, live_server, receive, send


def observation():
    return dict(type="browser.command", protocolVersion="0.9.0", nodeId="synthetic-host",
        botId=str(uuid4()), sessionId=str(uuid4()), requestId=str(uuid4()), action={"kind": "observe"},
        expiresAt=iso_timestamp(datetime.now(timezone.utc) + timedelta(seconds=5)))


@asynccontextmanager
async def synthetic_authority(_):
    yield


def test_connection_binding_is_private_immutable_and_required():
    async def run():
        async with live_server() as (registry, url, _, _):
            async with client(url) as ws:
                await send(ws, hello(capabilityManifest=[CAP]))
                assert (await receive(ws))["accepted"]
                binding = registry.browser_binding("synthetic-host")
                with pytest.raises(FrozenInstanceError):
                    binding.node_id = "replacement"
                assert binding.credential_digest not in json.dumps(registry.list())
                for changed in (asdict(binding), replace(binding, node_id="other"),
                                replace(binding, credential_digest="f" * 64),
                                replace(binding, connection_id=str(uuid4()))):
                    with pytest.raises(RuntimeError):
                        await registry.browser_command(observation(), binding=changed,
                                                       dispatch_guard=synthetic_authority)
                    assert not registry._browser_pending
                with pytest.raises(TypeError):
                    await registry.browser_command(observation(), dispatch_guard=synthetic_authority)
                with pytest.raises(TimeoutError):
                    async with asyncio.timeout(.05): await ws.recv()
    asyncio.run(run())


def test_reconnect_never_delivers_old_view_input_to_replacement_socket():
    async def run():
        async with live_server() as (registry, url, _, _):
            async with client(url) as first:
                await send(first, hello(capabilityManifest=[CAP]))
                assert (await receive(first))["accepted"]
                original = registry.browser_binding("synthetic-host")
                async with client(url) as second:
                    await send(second, hello(capabilityManifest=[CAP]))
                    assert (await receive(second))["accepted"]
                    current = registry.browser_binding("synthetic-host")
                    assert current.connection_id != original.connection_id
                    assert current.credential_digest == original.credential_digest
                    with pytest.raises(RuntimeError):
                        await registry.browser_command(observation(), binding=original,
                                                       dispatch_guard=synthetic_authority)
                    assert not registry._browser_pending
                    # Only a newly authorized view can send, through the unchanged wire protocol.
                    value = observation()
                    task = asyncio.create_task(registry.browser_command(value, binding=current,
                                                                        dispatch_guard=synthetic_authority))
                    received = await receive(second)
                    assert received == value
                    assert original.credential_digest not in json.dumps(received)
                    result = dict(type="browser.result", protocolVersion="0.9.0", nodeId=value["nodeId"],
                        sessionId=value["sessionId"], requestId=value["requestId"], ok=False, error="unavailable")
                    await send(second, result)
                    assert await task == result
                    assert not registry._browser_pending
    asyncio.run(run())
