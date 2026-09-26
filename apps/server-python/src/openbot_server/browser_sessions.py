"""Server-owned F browser sessions. No page text, credentials or frames enter durable audit."""
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
from uuid import uuid4

from psycopg.types.json import Jsonb
from pydantic import TypeAdapter

from .authority import OwnerTransactions, PostgresTransactions
from .browser_gate import BrowserPauseGate
from .browser_protocol import Action, Id, validate_frame
from .control_errors import ControlError
from .models import iso_timestamp


def now():
    return datetime.now(timezone.utc)


def compatible(node):
    return any(cap["id"] == "browser.session" and cap["version"] == 1 and cap["providerId"] == "docker"
               for cap in node["capabilityManifest"])


@dataclass
class _Session:
    id: str
    bot_id: str
    node_id: str
    node_name: str
    owner: str
    expires_at: datetime


class BrowserSessionsService:
    def __init__(self, dsn, registry, *, gate=None, agent_gate_configured=False):
        if type(agent_gate_configured) is not bool:
            raise TypeError("Browser execution integration must be explicit.")
        self.owner = OwnerTransactions(dsn, application_name="openbot-browser-owner")
        self.trusted = PostgresTransactions(dsn, application_name="openbot-browser-audit")
        self.gate = gate or BrowserPauseGate(dsn)
        self.registry = registry
        self.agent_gate_configured = agent_gate_configured
        self._sessions = {}
        self._opening = set()
        self._closed = False
        self._unsubscribe = registry.on_browser_unavailable(self._unavailable)

    def _unavailable(self, node):
        for identity, session in list(self._sessions.items()):
            if session.node_id == node["id"]:
                self._sessions.pop(identity, None)
        # Persisted paused state deliberately survives disconnect/reconnect.

    async def stop(self):
        self._closed = True
        self._unsubscribe()
        self._sessions.clear()

    async def authorize(self, token):
        async with self.owner.transaction(token):
            pass

    @staticmethod
    async def _authority(db, token, bot_id):
        bot = await (await db.execute("SELECT computer_profile FROM bots WHERE id=%s FOR SHARE", (bot_id,))).fetchone()
        if bot is None:
            raise ControlError(404, "browser_employee_not_found")
        if bot["computer_profile"] != "docker-linux":
            raise ControlError(403, "browser_employee_profile_changed")
        row = await (await db.execute(
            "SELECT expires_at,clock_timestamp() AS now FROM auth_sessions WHERE token_digest=%s",
            (hashlib.sha256(token.encode("ascii")).hexdigest(),))).fetchone()
        return row["now"], row["expires_at"]

    @staticmethod
    async def _event(db, session, request_id, action, phase):
        await db.execute("INSERT INTO run_events(id,bot_id,node_id,type,payload,created_at) "
                         "VALUES(%s,%s,%s,%s,%s,clock_timestamp())",
            (str(uuid4()), session.bot_id, session.node_id,
             "BROWSER_OPENED" if action == "open" else "BROWSER_COMMAND",
             Jsonb(dict(actor="owner", requestId=request_id, action=action, phase=phase))))

    @staticmethod
    async def _state(db, session, state):
        # State records contain only control identity/expiry. Appending a lease record preserves
        # exclusive renewal across Server processes; an observation never stores its page content.
        await db.execute("INSERT INTO run_events(id,bot_id,node_id,type,payload,created_at) "
                         "VALUES(%s,%s,%s,'BROWSER_CONTROL_STATE',%s,clock_timestamp())",
                         (str(uuid4()), session.bot_id, session.node_id, Jsonb(state)))

    @staticmethod
    def _active(state, stamp):
        return bool(state.get("sessionId") and datetime.fromisoformat(state["expiresAt"]) > stamp)

    def _session(self, identity, token):
        session = self._sessions.get(identity)
        if (self._closed or session is None or session.expires_at <= now()
                or not isinstance(token, str)
                or not hmac.compare_digest(session.owner, hashlib.sha256(token.encode()).hexdigest())):
            raise ControlError(404, "browser_view_expired")
        return session

    def _view(self, session, state):
        active = self._active(state, now())
        return {"id": session.id, "botId": session.bot_id, "nodeId": session.node_id,
                "nodeName": session.node_name,
                "control": ("mine" if state.get("sessionId") == session.id else "other") if active
                    else "paused" if state.get("paused") else "available",
                **({"controlExpiresAt": state["expiresAt"]} if state.get("expiresAt") else {})}

    async def open(self, token, bot_id):
        # Authorization before existence/capacity disclosure; mutating transaction checks again.
        await self.authorize(token)
        bot_id = TypeAdapter(Id).validate_python(bot_id)
        for identity, session in list(self._sessions.items()):
            if session.expires_at <= now(): self._sessions.pop(identity, None)
        if self._closed or len(self._sessions) + len(self._opening) >= 64 or bot_id in self._opening:
            raise ControlError(409, "browser_busy")
        self._opening.add(bot_id)
        try:
            async with self.gate.human(bot_id):
                async with self.owner.transaction(token) as db:
                    await self._authority(db, token, bot_id)
                    row = await (await db.execute(
                        "SELECT node_id FROM run_events WHERE bot_id=%s AND type='BROWSER_OPENED' "
                        "ORDER BY created_at DESC,id DESC LIMIT 1", (bot_id,))).fetchone()
                    if row is None:
                        row = await (await db.execute("SELECT node_id FROM runs WHERE bot_id=%s AND node_id IS NOT NULL "
                                                     "ORDER BY created_at DESC LIMIT 1", (bot_id,))).fetchone()
                    previous = row["node_id"] if row else None
                    candidates = sorted((node for node in self.registry.list() if compatible(node)), key=lambda node: node["id"])
                    node = next((node for node in candidates if not previous or node["id"] == previous), None)
                    if node is None:
                        raise ControlError(503, "browser_original_host_unavailable" if previous else "browser_host_unavailable")
                    await db.execute("INSERT INTO nodes(id,name,platform,capabilities,capability_manifest,status) "
                        "VALUES(%s,%s,%s,%s,%s,'online') ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,"
                        "platform=EXCLUDED.platform,capabilities=EXCLUDED.capabilities,capability_manifest=EXCLUDED.capability_manifest",
                        (node["id"], node["name"], node["platform"], Jsonb(node["capabilities"]), Jsonb(node["capabilityManifest"])))
                    session = _Session(str(uuid4()), bot_id, node["id"], node["name"],
                                       hashlib.sha256(token.encode("ascii")).hexdigest(), now() + timedelta(minutes=10))
                    await self._event(db, session, str(uuid4()), "open", "completed")
                    state = await self.gate.state(db, bot_id)
                # No view exists before the final Owner check and audit commit succeed.
                if not any(node["id"] == session.node_id and compatible(node) for node in self.registry.list()):
                    raise ControlError(503, "browser_host_unavailable")
                self._sessions[session.id] = session
                return self._view(session, state)
        finally:
            self._opening.discard(bot_id)

    async def command(self, token, identity, value):
        await self.authorize(token)
        action = Action.validate_python(value).model_dump()
        session = self._session(identity, token)
        kind, request_id = action["kind"], str(uuid4())
        if kind == "take" and not self.agent_gate_configured:
            raise ControlError(503, "browser_agent_gate_not_configured")
        async with self.gate.human(session.bot_id):
            self._session(identity, token)
            async with self.owner.transaction(token) as db:
                stamp, owner_expiry = await self._authority(db, token, session.bot_id)
                state = await self.gate.state(db, session.bot_id)
                active = self._active(state, stamp)
                if kind == "take":
                    if active and state.get("sessionId") != identity:
                        raise ControlError(409, "browser_control_held_elsewhere")
                    state = dict(paused=True, sessionId=identity,
                                 expiresAt=iso_timestamp(min(stamp + timedelta(seconds=30), owner_expiry)))
                elif kind != "observe" and (not active or state.get("sessionId") != identity):
                    raise ControlError(409, "browser_control_required")
                elif active and state.get("sessionId") == identity:
                    state = {**state, "expiresAt": iso_timestamp(min(stamp + timedelta(seconds=30), owner_expiry))}
                if kind == "take" or (active and state.get("sessionId") == identity):
                    await self._state(db, session, state)
                if kind != "observe":
                    await self._event(db, session, request_id, kind, "intent")
            frame = dict(type="browser.command", protocolVersion="0.9.0", nodeId=session.node_id,
                         botId=session.bot_id, sessionId=identity, requestId=request_id,
                         expiresAt=iso_timestamp(min(stamp + timedelta(seconds=25), owner_expiry)), action=action)
            if state.get("sessionId") == identity and self._active(state, now()):
                frame["controlExpiresAt"] = state["expiresAt"]

            @asynccontextmanager
            async def dispatch_guard(message):
                # Registry invokes this inside its exact socket's send/identity lock, not at
                # queue insertion. The lease cannot extend beyond current Owner expiry.
                async with self.owner.transaction(token) as db:
                    current, expiry = await self._authority(db, token, session.bot_id)
                    self._session(identity, token)
                    message["expiresAt"] = iso_timestamp(min(current + timedelta(seconds=25), expiry,
                                                               datetime.fromisoformat(message["expiresAt"])))
                    if "controlExpiresAt" in message:
                        message["controlExpiresAt"] = iso_timestamp(min(expiry, datetime.fromisoformat(message["controlExpiresAt"])))
                    yield

            try:
                result = await self.registry.browser_command(frame, dispatch_guard=dispatch_guard)
                if not result.get("ok") or not result.get("frame"):
                    raise ValueError("Browser operation was not confirmed.")
                observed = validate_frame(result["frame"])
                async with self.owner.transaction(token) as db:
                    await self._authority(db, token, session.bot_id)
                    self._session(identity, token)
                    if kind != "observe": await self._event(db, session, request_id, kind, "completed")
                    if kind == "release":
                        state = {"paused": False}
                        await self._state(db, session, state)
                session.expires_at = now() + timedelta(minutes=10)
                return {**self._view(session, state), "frame": observed}
            except BaseException:
                # Intent is already durable. This is a trusted receipt update, not renewed
                # Owner authority; failure retains the earlier pause and never returns a frame.
                if kind != "observe":
                    async with self.trusted.transaction() as db:
                        await self._event(db, session, request_id, kind, "uncertain")
                        if state.get("sessionId") == identity:
                            await self._state(db, session, dict(paused=True, sessionId=identity,
                                                               expiresAt=iso_timestamp(now())))
                raise

    async def close(self, token, identity):
        await self.authorize(token)
        session = self._session(identity, token)
        async with self.gate.human(session.bot_id):
            async with self.owner.transaction(token) as db:
                state = await self.gate.state(db, session.bot_id)
                if state.get("sessionId") == identity:
                    await self._state(db, session, dict(paused=True, sessionId=identity, expiresAt=iso_timestamp(now())))
            self._sessions.pop(identity, None)
