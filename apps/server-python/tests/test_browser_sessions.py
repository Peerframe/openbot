"""Owned PG + real HTTP/WS synthetic Worker; no real browser, credentials or paid calls."""
import asyncio
import base64
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import secrets
import socket
import subprocess
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
import httpx
import psycopg
import pytest
import uvicorn
from websockets.asyncio.client import connect

from openbot_server.authority import AuthenticationRequired
from openbot_server.browser_gate import BrowserPauseGate
from openbot_server.browser_protocol import Action, BrowserCommand, BrowserResult
from openbot_server.browser_routes import register_browser_routes
from openbot_server.browser_sessions import BrowserSessionsService
from openbot_server.control_errors import ControlError
from openbot_server.database import StoreUnavailable
from openbot_server.worker_host_identity import PostgresWorkerHostIdentity, resolve_client_identity
from openbot_server.worker_host_registry import WorkerHostRegistry, now, worker_host_uvicorn_options
from openbot_server.worker_host_routes import register_worker_host_routes
from test_worker_host_identity import worker_db  # noqa: F401


PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n" + bytes(8) + (1).to_bytes(4, "big") * 2).decode()
FRAME = dict(base64=PNG, width=1, height=1, capturedAt="2026-09-25T00:00:00Z", url="https://synthetic.invalid/form")
CAP = dict(id="browser.session", version=1, providerId="docker", constraints={})
ORIGIN = "http://127.0.0.1"


@pytest.fixture
def seed(worker_db):
    value = {**worker_db, "botId": str(uuid4()), "token": secrets.token_urlsafe(32),
             "other": secrets.token_urlsafe(32), "node": "browser-" + str(uuid4())}
    with psycopg.connect(value["dsn"]) as db:
        db.execute("INSERT INTO bots(id,name,role,status,computer_profile) VALUES(%s,'Synthetic browser','Fixture','idle','docker-linux')", (value["botId"],))
        for key in ("token", "other"):
            db.execute("INSERT INTO auth_sessions(id,token_digest,expires_at) VALUES(%s,%s,clock_timestamp()+interval '1 hour')",
                       (str(uuid4()), hashlib.sha256(value[key].encode()).hexdigest()))
    yield value
    with psycopg.connect(value["dsn"]) as db:
        db.execute("DELETE FROM run_events WHERE bot_id=%s", (value["botId"],))
        db.execute("DELETE FROM bots WHERE id=%s", (value["botId"],))
        for table in ("node_identity_events", "node_enrollment_tokens", "node_credentials"):
            db.execute(f"DELETE FROM {table} WHERE node_id=%s", (value["node"],))
        db.execute("DELETE FROM nodes WHERE id=%s", (value["node"],))
        for key in ("token", "other"):
            db.execute("DELETE FROM auth_sessions WHERE token_digest=%s", (hashlib.sha256(value[key].encode()).hexdigest(),))


@asynccontextmanager
async def server(seed, *, configured=True, profiles=None):
    identity = PostgresWorkerHostIdentity(seed["dsn"])
    registry = WorkerHostRegistry(identity)
    service = BrowserSessionsService(seed["dsn"], registry, agent_gate_configured=configured, profiles=profiles)
    app = FastAPI()
    @app.exception_handler(HTTPException)
    async def http_error(request, error):
        return JSONResponse({"error": error.detail}, status_code=error.status_code)
    @app.exception_handler(ControlError)
    async def control_error(request, error):
        return JSONResponse({"error": error.code}, status_code=error.status)
    register_worker_host_routes(app, identity, registry, secure_cookies=False, allowed_origins=(ORIGIN,))
    register_browser_routes(app, service, secure_cookies=False, allowed_origins=(ORIGIN,))
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    runtime = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, access_log=False,
        log_level="critical", lifespan="off", **worker_host_uvicorn_options()))
    process = asyncio.create_task(runtime.serve(sockets=[listener]))
    try:
        async with asyncio.timeout(3):
            while not runtime.started:
                if process.done(): await process
                await asyncio.sleep(.01)
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=5,
                                    cookies={"openbot_session": seed["token"]}, headers={"Origin": ORIGIN}) as http:
            yield service, registry, http, f"ws://127.0.0.1:{port}/ws/nodes"
    finally:
        await service.stop()
        await registry.close()
        runtime.should_exit = True
        await asyncio.wait_for(process, 5)
        listener.close()


async def enroll_worker(seed, http):
    issued = await http.post("/api/v1/nodes/enrollment-tokens", json={"nodeId": seed["node"]})
    assert issued.status_code == 201
    enrolled = await http.post("/api/v1/nodes/enroll", json={"nodeId": seed["node"], "token": issued.json()["token"]})
    assert enrolled.status_code == 201
    return enrolled.json()["credential"]


@asynccontextmanager
async def worker(seed, http, url, *, capability=True, hook=None, credential=None, page_hook=None):
    credential = credential or await enroll_worker(seed, http)
    async with connect(url, proxy=None, compression=None, open_timeout=3, close_timeout=1) as ws:
        await ws.send(json.dumps(dict(type="node.hello", protocolVersion="0.9.0", nodeId=seed["node"],
            name="Synthetic Browser Host", platform="linux", capabilities=["browser"],
            capabilityManifest=([CAP]+([dict(id='browser.page',version=1,providerId='docker',constraints={})]
                if page_hook is not None else [])) if capability else [], maxConcurrentRuns=1, sentAt=now(),
            credential=credential)))
        assert json.loads(await ws.recv())["accepted"] is True
        calls = []
        async def reply():
            async for raw in ws:
                command = json.loads(raw)
                if command["type"] == "server.ack": continue
                assert BrowserCommand.model_validate(command)
                calls.append(command)
                frame = FRAME
                if hook is not None:
                    override = await hook(command)
                    if override is False: continue
                    if isinstance(override, dict): frame = override
                extra = await page_hook(command) if page_hook is not None and command['action']['kind']=='agent' else {}
                await ws.send(json.dumps(dict(type="browser.result", protocolVersion="0.9.0", nodeId=seed["node"],
                    sessionId=command["sessionId"], requestId=command["requestId"], ok=True, **({"frame":frame}|extra))))
        task = asyncio.create_task(reply())
        try:
            yield calls, ws
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


async def opened(http, seed):
    response = await http.post(f'/api/v1/bots/{seed["botId"]}/browser')
    assert response.status_code == 201, response.text
    return response.json()


async def command(http, view, kind, **fields):
    return await http.post(f'/api/v1/browser-sessions/{view["id"]}/commands', json={"kind": kind, **fields})


def events(seed):
    with psycopg.connect(seed["dsn"]) as db:
        return db.execute("SELECT type,payload FROM run_events WHERE bot_id=%s ORDER BY created_at,id", (seed["botId"],)).fetchall()


def test_real_enrollment_view_exclusive_control_input_release_and_restart_pause(seed):
    async def run():
        async with server(seed) as (service, registry, http, url):
            assert (await http.post(f'/api/v1/bots/{seed["botId"]}/browser', headers={"Origin": "https://wrong.invalid"})).status_code == 403
            async with worker(seed, http, url) as (calls, ws):
                first, second = await opened(http, seed), await opened(http, seed)
                assert first["control"] == "available"
                oversized = await http.post(f'/api/v1/browser-sessions/{first["id"]}/commands', json={"kind": "type", "text": "x" * 21000})
                assert oversized.status_code == 413
                overflow = await http.post(f'/api/v1/browser-sessions/{first["id"]}/commands',
                    content='{"kind":"scroll","deltaY":1e400}', headers={"Content-Type": "application/json"})
                assert overflow.status_code == 422
                assert (await command(http, first, "unknown")).status_code == 422
                assert (await command(http, first, "type", text="not admitted")).status_code == 409
                assert (await command(http, first, "observe")).json()["frame"] == FRAME
                assert (await command(http, first, "take")).json()["control"] == "mine"
                assert (await command(http, second, "take")).status_code == 409
                assert (await command(http, second, "observe")).json()["control"] == "other"
                assert (await command(http, first, "type", text="synthetic secret 你好🌏")).status_code == 200
                assert calls[-1]["action"]["text"] == "synthetic secret 你好🌏"
                with pytest.raises(ControlError):
                    async with BrowserPauseGate(seed["dsn"]).agent(seed["botId"]): pass
                assert (await http.delete(f'/api/v1/browser-sessions/{first["id"]}')).status_code == 204
                assert (await command(http, first, "observe")).status_code == 404
                assert (await command(http, second, "observe")).json()["control"] == "paused"
                assert (await command(http, second, "take")).status_code == 200
                assert (await command(http, second, "release")).json()["control"] == "available"
                async with BrowserPauseGate(seed["dsn"]).agent(seed["botId"]): pass
                assert not any("secret" in json.dumps(event) or PNG in json.dumps(event) for event in events(seed))
                assert any(kind == "BROWSER_COMMAND" and payload["phase"] == "intent" for kind, payload in events(seed))
                assert (await http.post(f'/api/v1/nodes/{seed["node"]}/revoke')).status_code == 204
                assert (await command(http, second, "observe")).status_code == 404
    asyncio.run(run())


@pytest.mark.parametrize("capability,configured", [(False, True), (True, False)])
def test_capability_and_execution_gate_are_explicit(seed, capability, configured):
    async def run():
        async with server(seed, configured=configured) as (_, _, http, url):
            async with worker(seed, http, url, capability=capability) as (calls, _):
                response = await http.post(f'/api/v1/bots/{seed["botId"]}/browser')
                if not capability: assert response.status_code == 503
                else:
                    assert (await command(http, response.json(), "take")).status_code == 503
                    assert (await command(http, response.json(), "observe")).status_code == 200
                assert not any(call["action"]["kind"] == "take" for call in calls)
    asyncio.run(run())


def test_owner_binding_profile_change_and_expired_view(seed):
    async def run():
        async with server(seed) as (service, _, http, url):
            async with worker(seed, http, url) as (calls, _):
                view = await opened(http, seed)
                http.cookies.set("openbot_session", seed["other"])
                assert (await command(http, view, "observe")).status_code == 404
                http.cookies.set("openbot_session", seed["token"])
                with psycopg.connect(seed["dsn"]) as db:
                    db.execute("UPDATE bots SET computer_profile='none' WHERE id=%s", (seed["botId"],))
                assert (await command(http, view, "take")).status_code == 403
                service._sessions[view["id"]].expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
                assert (await command(http, view, "observe")).status_code == 404
                assert calls == []
    asyncio.run(run())


def test_audit_failure_refuses_dispatch_and_rolls_back_take_state(seed):
    async def run():
        async with server(seed) as (service, _, http, url):
            async with worker(seed, http, url) as (calls, _):
                view = await opened(http, seed)
                async def fail(*args): raise StoreUnavailable("synthetic audit failure")
                service._event = fail
                assert (await command(http, view, "take")).status_code == 503
                assert calls == []
                async with service.gate.agent(seed["botId"]): pass
    asyncio.run(run())


def test_expiry_after_intent_is_rechecked_inside_socket_dispatch(seed):
    async def run():
        async with server(seed) as (service, registry, http, url):
            async with worker(seed, http, url) as (calls, _):
                view = await opened(http, seed)
                original = registry.browser_command
                async def expired(*args, **kwargs):
                    with psycopg.connect(seed["dsn"]) as db:
                        db.execute("UPDATE auth_sessions SET expires_at=clock_timestamp() WHERE token_digest=%s", (hashlib.sha256(seed["token"].encode()).hexdigest(),))
                    return await original(*args, **kwargs)
                registry.browser_command = expired
                assert (await command(http, view, "take")).status_code == 401
                assert calls == []
                with pytest.raises(ControlError):
                    async with service.gate.agent(seed["botId"]): pass
                assert any(payload.get("phase") == "uncertain" for _, payload in events(seed))
    asyncio.run(run())


def test_release_commit_failure_keeps_durable_pause_and_withholds_frame(seed):
    async def run():
        async with server(seed) as (service, _, http, url):
            async with worker(seed, http, url) as (calls, _):
                view = await opened(http, seed)
                assert (await command(http, view, "take")).status_code == 200
                original = service._event
                async def expire(db, session, request_id, action, phase):
                    await original(db, session, request_id, action, phase)
                    if action == "release" and phase == "completed":
                        await db.execute("UPDATE auth_sessions SET expires_at=clock_timestamp() WHERE token_digest=%s", (hashlib.sha256(seed["token"].encode()).hexdigest(),))
                service._event = expire
                response = await command(http, view, "release")
                assert response.status_code == 401 and "frame" not in response.json()
                assert [call["action"]["kind"] for call in calls].count("release") == 1
                with pytest.raises(ControlError):
                    async with service.gate.agent(seed["botId"]): pass
                assert not any(payload.get("action") == "release" and payload.get("phase") == "completed" for _, payload in events(seed))
    asyncio.run(run())


def test_serialization_disconnect_and_bad_frame_remain_uncertain(seed):
    async def run():
        reached, finish = asyncio.Event(), asyncio.Event()
        async def hook(value):
            if value["action"]["kind"] == "type":
                reached.set()
                await finish.wait()
                return {**FRAME, "width": 2}
        async with server(seed) as (service, _, http, url):
            async with worker(seed, http, url, hook=hook) as (calls, _):
                view = await opened(http, seed)
                assert (await command(http, view, "take")).status_code == 200
                pending = asyncio.create_task(command(http, view, "type", text="one input"))
                await asyncio.wait_for(reached.wait(), 3)
                assert (await command(http, view, "click", x=1, y=1)).status_code == 409
                with pytest.raises(ControlError):
                    async with BrowserPauseGate(seed["dsn"]).agent(seed["botId"]): pass
                finish.set()
                assert (await pending).status_code == 503
                assert len([call for call in calls if call["action"]["kind"] == "type"]) == 1
                assert (await command(http, view, "click", x=1, y=1)).status_code == 409
    asyncio.run(run())


@pytest.mark.parametrize("failure", ["disconnect", "foreign-session", "owner-revoked"])
def test_live_response_authority_identity_and_disconnect(seed, failure):
    async def run():
        reached = asyncio.Event()
        async def hook(value):
            if value["action"]["kind"] == "take":
                if failure == "owner-revoked":
                    async with await psycopg.AsyncConnection.connect(seed["dsn"]) as db:
                        await db.execute("UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE token_digest=%s",
                                   (hashlib.sha256(seed["token"].encode()).hexdigest(),))
                else:
                    reached.set()
                    return False
        async with server(seed) as (service, registry, http, url):
            async with worker(seed, http, url, hook=hook) as (calls, ws):
                view = await opened(http, seed)
                pending = asyncio.create_task(command(http, view, "take"))
                if failure != "owner-revoked":
                    await asyncio.wait_for(reached.wait(), 3)
                    if failure == "disconnect":
                        await registry.disconnect(seed["node"])
                    else:
                        value = calls[-1]
                        await ws.send(json.dumps(dict(type="browser.result", protocolVersion="0.9.0",
                            nodeId=seed["node"], requestId=value["requestId"], sessionId=str(uuid4()), ok=True, frame=FRAME)))
                response = await pending
                assert response.status_code == (401 if failure == "owner-revoked" else 503)
                assert "frame" not in response.json()
                with pytest.raises(ControlError):
                    async with BrowserPauseGate(seed["dsn"]).agent(seed["botId"]): pass
                assert any(payload.get("phase") == "uncertain" for _, payload in events(seed))
    asyncio.run(run())


def test_original_worker_binding_never_moves_to_another_account_state(seed):
    async def run():
        async with server(seed) as (service, registry, http, url):
            async with worker(seed, http, url):
                await opened(http, seed)
                original = registry.list()
                registry.list = lambda: [{**original[0], "id": "other-compatible-worker"}]
                response = await http.post(f'/api/v1/bots/{seed["botId"]}/browser')
                assert response.status_code == 503
                assert response.json()["error"] == "browser_original_host_unavailable"
    asyncio.run(run())


@pytest.mark.parametrize("change", ["rotate", "revoke"])
@pytest.mark.parametrize("phase", ["before-intent", "before-send", "after-release"])
def test_current_host_identity_is_required_at_every_effect_boundary(seed, change, phase):
    async def change_identity():
        # Another Server process does not share this registry's in-memory identity lock.
        identity = PostgresWorkerHostIdentity(seed["dsn"])
        if change == "revoke":
            await identity.revoke(seed["token"], seed["node"])
        else:
            issued = await identity.issue(seed["token"], {"nodeId": seed["node"]})
            await identity.enroll({"nodeId": seed["node"], "token": issued["token"]},
                resolve_client_identity("2001:db8::" + uuid4().hex[:4]))

    async def run():
        async def hook(value):
            if phase == "after-release" and value["action"]["kind"] == "release":
                await change_identity()
        async with server(seed) as (service, registry, http, url):
            async with worker(seed, http, url, hook=hook) as (calls, _):
                view = await opened(http, seed)
                assert (await command(http, view, "take")).status_code == 200
                original_binding = registry.browser_binding(seed["node"])
                if phase == "before-intent":
                    await change_identity()
                elif phase == "before-send":
                    send = registry.browser_command
                    async def changed(*args, **kwargs):
                        await change_identity()
                        return await send(*args, **kwargs)
                    registry.browser_command = changed
                response = await command(http, view, "release")
                assert response.status_code == 409, response.text
                assert response.json() == {"error": "browser_host_identity_changed"}
                # The stale socket remains live: the database check, not disconnect, refused it.
                assert registry.browser_binding(seed["node"]) == original_binding
                assert len([c for c in calls if c["action"]["kind"] == "release"]) == (phase == "after-release")
                assert not any(payload.get("action") == "release" and payload.get("phase") == "completed"
                               for _, payload in events(seed))
                with pytest.raises(ControlError):
                    async with service.gate.agent(seed["botId"]): pass
    asyncio.run(run())


def test_durable_profile_binding_survives_restart_and_refuses_reenrollment(seed):
    async def run():
        async with server(seed) as (_, _, http, url):
            credential = await enroll_worker(seed, http)
            async with worker(seed, http, url, credential=credential):
                old = await opened(http, seed)
                assert (await command(http, old, "take")).status_code == 200
                await http.delete(f'/api/v1/browser-sessions/{old["id"]}')
        async with server(seed) as (_, _, http, url):
            async with worker(seed, http, url, credential=credential) as (calls, _):
                assert (await command(http, old, "observe")).status_code == 404
                view = await opened(http, seed)
                assert view["control"] == "paused"
                assert (await command(http, view, "take")).status_code == 200
                assert (await command(http, view, "release")).json()["control"] == "available"
                assert len(calls) == 2
        async with server(seed) as (_, _, http, url):
            # A fresh enrollment with the same id does not prove ownership of the old profile.
            async with worker(seed, http, url) as (calls, _):
                response = await http.post(f'/api/v1/bots/{seed["botId"]}/browser')
                assert response.status_code == 409
                assert response.json() == {"error": "browser_host_identity_changed"}
                assert calls == []
        bindings = [payload for kind, payload in events(seed) if kind == "BROWSER_HOST_BOUND"]
        assert len(bindings) == 1
        assert credential not in json.dumps(events(seed))
        assert "credentialDigest" not in json.dumps(view)
    asyncio.run(run())


def test_legacy_browser_history_cannot_silently_bind_a_new_identity(seed):
    async def run():
        async with server(seed) as (_, _, http, url):
            async with worker(seed, http, url) as (calls, _):
                await opened(http, seed)
                with psycopg.connect(seed["dsn"]) as db:
                    db.execute("DELETE FROM run_events WHERE bot_id=%s AND type='BROWSER_HOST_BOUND'", (seed["botId"],))
                response = await http.post(f'/api/v1/bots/{seed["botId"]}/browser')
                assert response.status_code == 409
                assert response.json() == {"error": "browser_original_host_identity_unverified"}
                assert calls == []
                assert not any(kind == "BROWSER_HOST_BOUND" for kind, _ in events(seed))
    asyncio.run(run())


def test_failed_open_cannot_commit_a_profile_binding_or_view(seed):
    async def run():
        async with server(seed) as (service, _, http, url):
            async with worker(seed, http, url) as (calls, _):
                original = service._event
                async def fail(*_): raise StoreUnavailable("synthetic audit failure")
                service._event = fail
                response = await http.post(f'/api/v1/bots/{seed["botId"]}/browser')
                assert response.status_code == 503
                assert not service._sessions
                assert not service._opening
                assert not any(kind in ("BROWSER_HOST_BOUND", "BROWSER_OPENED") for kind, _ in events(seed))
                service._event = original
                await opened(http, seed)
                assert calls == []
    asyncio.run(run())


def test_two_bots_keep_independent_host_bindings_and_control_leases(seed):
    other = {**seed, "botId": str(uuid4())}
    with psycopg.connect(seed["dsn"]) as db:
        db.execute("INSERT INTO bots(id,name,role,status,computer_profile) VALUES(%s,'Other browser','Fixture','idle','docker-linux')",
                   (other["botId"],))
    async def run():
        async with server(seed) as (service, _, http, url):
            async with worker(seed, http, url) as (calls, _):
                first, second = await opened(http, seed), await opened(http, other)
                assert (await command(http, first, "take")).status_code == 200
                async with service.gate.agent(other["botId"]): pass
                assert (await command(http, second, "take")).status_code == 200
                assert (await command(http, second, "release")).status_code == 200
                with pytest.raises(ControlError):
                    async with service.gate.agent(seed["botId"]): pass
                assert (await command(http, first, "type", text="first bot only")).status_code == 200
                assert calls[-1]["botId"] == seed["botId"]
                assert len([event for event in events(seed) if event[0] == "BROWSER_HOST_BOUND"]) == 1
                assert len([event for event in events(other) if event[0] == "BROWSER_HOST_BOUND"]) == 1
    try:
        asyncio.run(run())
    finally:
        with psycopg.connect(seed["dsn"]) as db:
            db.execute("DELETE FROM run_events WHERE bot_id=%s", (other["botId"],))
            db.execute("DELETE FROM bots WHERE id=%s", (other["botId"],))


def test_browser_schemas_match_source_zod():
    root = Path(__file__).resolve().parents[3]
    actions = [{"kind": kind} for kind in ("observe", "take", "release")]
    actions += [dict(kind="navigate", url=value) for value in ("https://example.test", "bad", "file:///tmp/a", "javascript:void(0)")]
    actions += [dict(kind="click", x=value, y=1) for value in (True, -1, 1, 1.5, 8193)]
    actions += [dict(kind="scroll", deltaY=value) for value in (True, 1, 1.0, 1.5, 2001)]
    actions += [dict(kind="type", text=value) for value in ("", "secret", "😀" * 2048, "😀" * 2049)]
    actions += [dict(kind="key", key=value) for value in ("Enter", "ControlOrMeta+A", "execute")]
    actions += [{**value, "extra": 1} for value in actions]
    source = "import {browserActionSchema} from './packages/protocol/src/browser.ts';let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify(JSON.parse(s).map(v=>{const r=browserActionSchema.safeParse(v);return r.success?{ok:true,value:r.data}:{ok:false}})));"
    expected = json.loads(subprocess.run(["node", "--import", "tsx", "--input-type=module", "-e", source],
        input=json.dumps(actions), text=True, capture_output=True, check=True, cwd=root, timeout=10).stdout)
    for value, result in zip(actions, expected, strict=True):
        try: actual = {"ok": True, "value": Action.validate_python(value).model_dump()}
        except (ValueError, TypeError, OverflowError): actual = {"ok": False}
        assert actual == result


def test_nonfinite_numbers_and_unicode_timestamps_fail_validation():
    from pydantic import ValidationError
    from openbot_server.browser_protocol import BrowserFrame
    for number in (float("inf"), float("-inf"), float("nan")):
        with pytest.raises(ValidationError):
            Action.validate_python(dict(kind="scroll", deltaY=number))
    with pytest.raises(ValidationError):
        BrowserFrame.model_validate({**FRAME, "capturedAt": "٢٠٢٦-٠٩-٢٥T٠٠:٠٠:٠٠Z"})
