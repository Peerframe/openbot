"""Real TCP/HTTP/WebSocket synthetic Host tests, with no real Worker or Provider effects."""
import asyncio
from contextlib import asynccontextmanager
import json
import socket
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
import httpx
import pytest
import uvicorn
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from openbot_server.control_errors import ControlError
from openbot_server.worker_host_identity import PostgresWorkerHostIdentity
from openbot_server.worker_host_protocol import MAX_PAYLOAD_BYTES, PROTOCOL_VERSION, parse_frame
from openbot_server.worker_host_registry import WorkerHostRegistry, now, worker_host_uvicorn_options
from openbot_server.worker_host_routes import register_worker_host_routes
from test_worker_host_identity import host_seed, worker_db  # noqa: F401


def hello(node="synthetic-host", credential="obn_" + "x" * 43, **changes):
    return {"type": "node.hello", "protocolVersion": PROTOCOL_VERSION, "nodeId": node, "credential": credential,
            "name": "Synthetic Host", "platform": "linux", "capabilities": ["shell"], "maxConcurrentRuns": 1, "sentAt": now(), **changes}


def message(kind, node, **fields):
    return {"type": kind, "protocolVersion": PROTOCOL_VERSION, "nodeId": node, **fields}


def offer():
    return {"runId": str(uuid4()), "channelId": str(uuid4()), "botId": str(uuid4()), "title": "Synthetic offer",
            "instruction": "No Provider execution", "executionProfile": "docker-linux", "requiredCapabilities": ["shell"],
            "requiredCapabilityManifest": [{"id": "shell.execute", "version": 1}]}


async def receive(ws):
    return json.loads(await asyncio.wait_for(ws.recv(), 3))


async def send(ws, value):
    await ws.send(json.dumps(value))


class FixedIdentity:
    def __init__(self, *, accepted=True, delay=0, error=None):
        self.accepted, self.delay, self.error = accepted, delay, error

    async def authenticate(self, *arguments):
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error:
            raise self.error
        return self.accepted


@asynccontextmanager
async def live_server(identity=None, *, options=None, transport=None, callbacks=None):
    identity = identity or FixedIdentity()
    events = []
    registry = WorkerHostRegistry(identity, **(options or {}), **(callbacks or {
        "on_available": lambda node: events.append(("available", node)),
        "on_updated": lambda node: events.append(("updated", node)),
        "on_unavailable": lambda node: events.append(("unavailable", node)),
        "on_run_message": lambda node, value: events.append(("run", node, value)),
    }))
    app = FastAPI()
    @app.exception_handler(ControlError)
    async def failure(request, error):
        return JSONResponse({"error": error.code}, status_code=error.status)
    @app.exception_handler(HTTPException)
    async def http_failure(request, error):
        return JSONResponse({"error": error.detail}, status_code=error.status_code, headers=error.headers)
    register_worker_host_routes(app, identity, registry, secure_cookies=False, allowed_origins=("http://127.0.0.1",))
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error", access_log=False,
                            lifespan="off", **{**worker_host_uvicorn_options(), **(transport or {})})
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        async with asyncio.timeout(3):
            while not server.started:
                if task.done():
                    await task
                await asyncio.sleep(.01)
        yield registry, f"ws://127.0.0.1:{port}/ws/nodes", f"http://127.0.0.1:{port}", events
    finally:
        await registry.close()
        server.should_exit = True
        try:
            await asyncio.wait_for(task, 5)
        finally:
            listener.close()


def client(url):
    return connect(url, proxy=None, compression=None, max_size=MAX_PAYLOAD_BYTES, open_timeout=3, close_timeout=1)


def test_real_http_enrollment_socket_assignment_approval_cancel_and_revoke(host_seed):
    async def run():
        identity = PostgresWorkerHostIdentity(host_seed["dsn"])
        async with live_server(identity) as (registry, url, base, events):
            async with httpx.AsyncClient(base_url=base, trust_env=False, timeout=5) as http:
                assert (await http.get("/api/v1/nodes")).status_code == 401
                http.cookies.set("openbot_session", host_seed["token"])
                assert (await http.post("/api/v1/nodes/enrollment-tokens", json={"nodeId": host_seed["node"]})).status_code == 403
                headers = {"Origin": "http://127.0.0.1"}
                issued = await http.post("/api/v1/nodes/enrollment-tokens", json={"nodeId": host_seed["node"]}, headers=headers)
                assert issued.status_code == 201
                enrolled = await http.post("/api/v1/nodes/enroll", json={"nodeId": host_seed["node"], "token": issued.json()["token"]})
                assert enrolled.status_code == 201
                assert registry.list() == []
                async with client(url) as ws:
                    await send(ws, hello(host_seed["node"], enrolled.json()["credential"]))
                    assert (await receive(ws))["accepted"] is True
                    listed = (await http.get("/api/v1/nodes")).json()["nodes"]
                    assert [node["id"] for node in listed] == [host_seed["node"]]
                    assert "credential" not in json.dumps(listed)
                    identities = (await http.get("/api/v1/node-identities")).json()["identities"]
                    assert next(item for item in identities if item["nodeId"] == host_seed["node"])["connected"] is True
                    data = offer()
                    pending = asyncio.create_task(registry.offer_run(host_seed["node"], data))
                    frame = await receive(ws)
                    assert frame["type"] == "run.offer"
                    assert (await registry.offer_run(host_seed["node"], offer()))["status"] == "unavailable"
                    await send(ws, message("run.accept", host_seed["node"], runId=data["runId"], offerId=frame["offerId"], acceptedAt=now()))
                    assert (await receive(ws))["accepted"] is True
                    assert await pending == {"status": "accepted"}
                    assert registry.list()[0]["activeRunIds"] == []
                    assert not await registry.start_run(host_seed["node"], data["runId"])
                    await send(ws, message("node.heartbeat", host_seed["node"], activeRunIds=[data["runId"]], sentAt=now()))
                    assert (await receive(ws))["accepted"] is True
                    assert registry.list()[0]["activeRunIds"] == []
                    await send(ws, message("run.start_request", host_seed["node"], runId=data["runId"], requestedAt=now()))
                    assert (await receive(ws))["accepted"] is False
                    assert await registry.confirm_run(host_seed["node"], data["runId"])
                    assert (await receive(ws))["type"] == "run.assigned"
                    await send(ws, message("run.start_request", host_seed["node"], runId=data["runId"], requestedAt=now()))
                    assert (await receive(ws))["accepted"] is True
                    assert events[-1][0] == "run" and events[-1][2]["type"] == "run.start_request"
                    assert await registry.start_run(host_seed["node"], data["runId"])
                    assert (await receive(ws))["type"] == "run.start"
                    request_id = str(uuid4())
                    await send(ws, message("approval.request", host_seed["node"], runId=data["runId"], requestId=request_id,
                        action="shell.execute", target="synthetic", summary="Synthetic request", risk="write", requestedAt=now()))
                    assert (await receive(ws))["accepted"] is True
                    assert await registry.resolve_approval(host_seed["node"], run_id=data["runId"], request_id=request_id, decision="rejected")
                    assert (await receive(ws))["decision"] == "rejected"
                    await registry.cancel_run(host_seed["node"], data["runId"], "Owner cancelled.")
                    assert (await receive(ws))["type"] == "run.cancel"
                    assert registry.list()[0]["activeRunIds"] == []
                    assert (await http.post(f'/api/v1/nodes/{host_seed["node"]}/revoke', headers=headers)).status_code == 204
                    with pytest.raises(ConnectionClosed):
                        await ws.recv()
                    assert ws.close_code == 1008 and registry.list() == []
                    identities = (await http.get("/api/v1/node-identities")).json()["identities"]
                    assert next(item for item in identities if item["nodeId"] == host_seed["node"])["status"] == "revoked"
                async with client(url) as ws:
                    await send(ws, hello(host_seed["node"], enrolled.json()["credential"]))
                    assert (await receive(ws))["accepted"] is False
    asyncio.run(run())


@pytest.mark.parametrize("behavior", ["invalid", "duplicate", "foreign-node", "replay", "unknown-field", "pre-auth", "bad-json"])
def test_real_socket_protocol_rejections(behavior):
    async def run():
        async with live_server(FixedIdentity(accepted=behavior != "invalid")) as (registry, url, base, events):
            async with client(url) as ws:
                if behavior == "pre-auth":
                    await send(ws, message("node.heartbeat", "synthetic-host", activeRunIds=[], sentAt=now()))
                elif behavior == "bad-json":
                    await ws.send('{"type":NaN}')
                    assert not (await receive(ws))["accepted"]
                else:
                    await send(ws, hello(**({"untrusted": True} if behavior == "unknown-field" else {})))
                    ack = await receive(ws)
                    if behavior in ("invalid", "unknown-field"):
                        assert not ack["accepted"]
                    else:
                        assert ack["accepted"]
                        if behavior == "duplicate":
                            await send(ws, hello())
                        elif behavior == "foreign-node":
                            await send(ws, message("node.heartbeat", "foreign", activeRunIds=[], sentAt=now()))
                        else:
                            data = offer()
                            task = asyncio.create_task(registry.offer_run("synthetic-host", data))
                            offered = await receive(ws)
                            accept = message("run.accept", "synthetic-host", runId=data["runId"], offerId=offered["offerId"], acceptedAt=now())
                            await send(ws, accept)
                            assert (await receive(ws))["accepted"]
                            assert (await task)["status"] == "accepted"
                            await send(ws, accept)
                        if behavior != "foreign-node":
                            assert not (await receive(ws))["accepted"]
                with pytest.raises(ConnectionClosed):
                    await asyncio.wait_for(ws.recv(), 3)
                assert ws.close_code == 1008
            assert registry.list() == []
    asyncio.run(run())


def test_real_disconnect_replacement_timeout_cancellation_shutdown_settle_pending():
    async def run():
        async with live_server(options={"offer_timeout": .08}) as (registry, url, base, events):
            async with client(url) as first:
                await send(first, hello())
                await receive(first)
                pending = asyncio.create_task(registry.offer_run("synthetic-host", offer()))
                await receive(first)
                async with client(url) as second:
                    await send(second, hello())
                    await receive(second)
                    assert (await pending)["status"] == "unavailable"
                    assert len(registry.list()) == 1 and registry.list()[0]["activeRunIds"] == []
                    assert not any(event[0] == "unavailable" for event in events)
                    timeout = asyncio.create_task(registry.offer_run("synthetic-host", offer()))
                    await receive(second)
                    assert await timeout == {"status": "timeout"}
                    cancelled = asyncio.create_task(registry.offer_run("synthetic-host", offer()))
                    await receive(second)
                    cancelled.cancel()
                    with pytest.raises(asyncio.CancelledError):
                        await cancelled
                    assert registry._pending == {}
                    disconnected = asyncio.create_task(registry.offer_run("synthetic-host", offer()))
                    await receive(second)
                    await second.close()
                    assert (await disconnected)["status"] == "unavailable"
            async with client(url) as third:
                await send(third, hello())
                await receive(third)
                pending = asyncio.create_task(registry.offer_run("synthetic-host", offer()))
                await receive(third)
                await registry.close()
                assert (await pending)["status"] == "unavailable"
                assert registry.list() == [] and registry._pending == {}
    asyncio.run(run())


def test_real_duplicate_hello_during_auth_never_emits_available():
    async def run():
        async with live_server(FixedIdentity(delay=.3)) as (registry, url, base, events):
            async with client(url) as ws:
                await send(ws, hello())
                await send(ws, hello())
                assert (await receive(ws))["accepted"] is False
                with pytest.raises(ConnectionClosed):
                    await ws.recv()
                assert not events and registry.list() == []
    asyncio.run(run())


def test_real_auth_unavailable_and_enrollment_deadline():
    async def run():
        async with live_server(FixedIdentity(error=RuntimeError("synthetic DB error"))) as (registry, url, base, events):
            async with client(url) as ws:
                await send(ws, hello())
                assert (await receive(ws))["accepted"] is False
                with pytest.raises(ConnectionClosed):
                    await ws.recv()
                assert ws.close_code == 1011 and not events
        async with live_server(options={"enrollment_timeout": .05}) as (registry, url, base, events):
            async with client(url) as ws:
                with pytest.raises(ConnectionClosed):
                    await asyncio.wait_for(ws.recv(), 2)
                assert ws.close_code == 1008 and registry.list() == []
    asyncio.run(run())


def test_real_reenrollment_disconnect_and_http_body_bounds(host_seed):
    async def run():
        identity = PostgresWorkerHostIdentity(host_seed["dsn"])
        async with live_server(identity) as (registry, url, base, events):
            async with httpx.AsyncClient(base_url=base, trust_env=False, timeout=5,
                    cookies={"openbot_session": host_seed["token"]}, headers={"Origin": "http://127.0.0.1"}) as http:
                issued = await http.post("/api/v1/nodes/enrollment-tokens", json={"nodeId": host_seed["node"]})
                enrolled = await http.post("/api/v1/nodes/enroll", json={"nodeId": host_seed["node"], "token": issued.json()["token"]})
                assert (await http.post("/api/v1/nodes/enroll", content=b"x" * 8193, headers={"Content-Type": "application/json"})).status_code == 413
                assert (await http.post("/api/v1/nodes/enroll", json={"nodeId": host_seed["node"], "token": issued.json()["token"], "extra": True})).status_code == 422
                assert (await http.post("/api/v1/nodes/enroll", json={"nodeId": host_seed["node"], "token": issued.json()["token"]})).status_code == 401
                async with client(url) as ws:
                    await send(ws, hello(host_seed["node"], enrolled.json()["credential"]))
                    await receive(ws)
                    pending = asyncio.create_task(registry.offer_run(host_seed["node"], offer()))
                    await receive(ws)
                    replacement = await http.post("/api/v1/nodes/enrollment-tokens", json={"nodeId": host_seed["node"]})
                    rotated = await http.post("/api/v1/nodes/enroll", json={"nodeId": host_seed["node"], "token": replacement.json()["token"]})
                    assert rotated.status_code == 201 and (await pending)["status"] == "unavailable"
                    with pytest.raises(ConnectionClosed):
                        await ws.recv()
                    assert registry.list() == []
                async with client(url) as ws:
                    await send(ws, hello(host_seed["node"], rotated.json()["credential"]))
                    assert (await receive(ws))["accepted"]
    asyncio.run(run())


def test_real_assigned_events_snapshot_settle_and_callback_failure():
    async def run():
        async with live_server() as (registry, url, base, events):
            async with client(url) as ws:
                await send(ws, hello())
                await receive(ws)
                run_id = str(uuid4())
                await registry.confirm_run("synthetic-host", run_id)
                await receive(ws)
                for value in (
                    message("run.progress", "synthetic-host", runId=run_id, stage="working", message="Progress", occurredAt=now()),
                    message("run.frame", "synthetic-host", runId=run_id, mediaType="image/png", base64="YWJjZGVmZ2hp", capturedAt=now()),
                    message("run.completed", "synthetic-host", runId=run_id, summary="Completed", artifacts=[{"name": "synthetic", "mediaType": "image/png", "base64": "YWJjZGVmZ2hp"}], completedAt=now()),
                    message("run.failed", "synthetic-host", runId=run_id, error="Synthetic failure", failedAt=now()),
                ):
                    await send(ws, value)
                    assert (await receive(ws))["accepted"]
                    assert events[-1][0] == "run" and events[-1][2]["type"] == value["type"]
                snapshot = registry.list()[0]
                snapshot["activeRunIds"].clear()
                assert registry.list()[0]["activeRunIds"] == [run_id]
                await send(ws, message("node.heartbeat", "synthetic-host", activeRunIds=[], sentAt=now()))
                await receive(ws)
                assert registry.list()[0]["activeRunIds"] == [run_id]
                assert await registry.settle_run("synthetic-host", run_id, "completed")
                assert (await receive(ws))["type"] == "run.settled"
                assert registry.list()[0]["activeRunIds"] == []
        def fail(node):
            raise RuntimeError("Synthetic Runtime notification failure")
        async with live_server(callbacks={"on_available": fail}) as (registry, url, base, events):
            async with client(url) as ws:
                await send(ws, hello())
                await receive(ws)
                with pytest.raises(ConnectionClosed):
                    await ws.recv()
                assert ws.close_code == 1011 and registry.list() == []
    asyncio.run(run())


def test_real_disconnect_during_auth_cannot_publish_a_live_node():
    async def run():
        async with live_server(FixedIdentity(delay=.1)) as (registry, url, base, events):
            async with client(url) as ws:
                await send(ws, hello())
                await ws.close()
            await asyncio.sleep(.12)
            assert registry.list() == [] and not events
    asyncio.run(run())


def test_real_transport_rejects_oversized_fragmented_frame_before_app_dispatch():
    async def run():
        assert worker_host_uvicorn_options()["ws_max_size"] == 32 * 1024 * 1024
        async with live_server() as (registry, url, base, events):
            async with client(url) as ws:
                await send(ws, hello())
                await receive(ws)
                try:
                    await ws.send([b"x" * (1024 * 1024)] * 32 + [b"x"])
                    await asyncio.wait_for(ws.recv(), 4)
                except ConnectionClosed:
                    pass
                assert ws.close_code == 1009
                assert not any(event[0] == "run" for event in events)
    asyncio.run(run())


def test_real_transport_ping_timeout_drops_silent_peer():
    async def run():
        from websockets.client import ClientProtocol
        from websockets.frames import Frame, Opcode
        from websockets.http11 import Response
        from websockets.uri import parse_uri
        async with live_server(transport={"ws_ping_interval": .04, "ws_ping_timeout": .04}) as (registry, url, base, events):
            uri = parse_uri(url)
            reader, writer = await asyncio.open_connection(uri.host, uri.port)
            protocol = ClientProtocol(uri)
            protocol.send_request(protocol.connect())
            for block in protocol.data_to_send():
                writer.write(block)
            await writer.drain()
            seen_ping = False
            close_code = None
            try:
                async with asyncio.timeout(2):
                    while close_code is None:
                        protocol.receive_data(await reader.read(65536))
                        for event in protocol.events_received():
                            if isinstance(event, Response):
                                protocol.send_text(json.dumps(hello()).encode())
                                for block in protocol.data_to_send():
                                    writer.write(block)
                                await writer.drain()
                            if isinstance(event, Frame) and event.opcode == Opcode.PING:
                                seen_ping = True
                            if isinstance(event, Frame) and event.opcode == Opcode.CLOSE:
                                close_code = int.from_bytes(event.data[:2], "big")
                        # Deliberately discard generated PONGs: no hand-written WebSocket frames.
                        protocol.data_to_send()
                assert seen_ping and close_code == 1011
            finally:
                writer.close()
                await writer.wait_closed()
    asyncio.run(run())


def test_protocol_strict_nested_bounds_and_mathematical_integers():
    assert parse_frame(hello(maxConcurrentRuns=1.0))["maxConcurrentRuns"] == 1
    for changed in ({"maxConcurrentRuns": True}, {"maxConcurrentRuns": 1.5}, {"capabilities": ["shell", "shell"]},
                    {"credential": "obn_" + "x" * 43 + "\n"}, {"name": None}, {"sentAt": "2026-02-30T00:00:00Z"},
                    {"sentAt": "2026-01-01T00:00:00+00:00"}, {"capabilityManifest": [{"id": "shell.execute", "version": 1, "providerId": "shell", "extra": 1}]}):
        with pytest.raises((ValueError, TypeError)):
            parse_frame(hello(**changed))
    value = message("approval.request", "node", runId=str(uuid4()), requestId=str(uuid4()), action="write", target="x", summary="Review", risk="write", requestedAt=now())
    assert parse_frame(value)["expiresInSeconds"] == 300
    for evidence in ({"x": "😀" * 2049}, {"x": list(range(65))}, {"x": {"x": {"x": {"x": {"x": {"x": {}}}}}}}, {"x": float("nan")}):
        with pytest.raises(ValueError):
            parse_frame({**value, "beforeState": evidence})
    with pytest.raises(ValueError):
        parse_frame(message("run.frame", "node", runId=str(uuid4()), mediaType="image/png", base64="!" * 12, width=None, capturedAt=now()))
