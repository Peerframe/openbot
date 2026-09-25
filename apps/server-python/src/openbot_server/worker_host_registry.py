"""Live ASGI Worker sockets and Server-owned assignments; no Provider execution.

Callbacks are synchronous notifications, matching the retained Node event handlers. A Runtime
may enqueue its own asynchronous work; a notification must never wait for a socket response.
All methods run on the ASGI event loop. Durable authority checks precede callers' control methods.
"""
import asyncio
from contextlib import asynccontextmanager
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timezone
import inspect
import json
import logging
from uuid import uuid4
from weakref import WeakValueDictionary

from starlette.websockets import WebSocket, WebSocketDisconnect

from .models import iso_timestamp
from .worker_host_protocol import MAX_PAYLOAD_BYTES, PROTOCOL_VERSION, parse_frame, parse_negotiated_frame

_LOG = logging.getLogger(__name__)
_RUN_EVENTS = {"run.start_request", "run.progress", "run.frame", "approval.request", "run.completed", "run.failed"}


def now():
    return iso_timestamp(datetime.now(timezone.utc))


def worker_host_uvicorn_options():
    """Mandatory transport bounds: app-level length checks cannot bound frame buffering."""
    return {"ws": "websockets-sansio", "ws_max_size": MAX_PAYLOAD_BYTES, "ws_ping_interval": 30.0,
            "ws_ping_timeout": 30.0, "ws_per_message_deflate": False, "proxy_headers": False}


@dataclass(eq=False)
class _Connection:
    socket: WebSocket
    node: dict | None = None
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    connection_id: str | None = None
    credential_digest: str | None = None
    command_enabled: bool = False


@dataclass
class _Offer:
    connection: _Connection
    run_id: str
    result: asyncio.Future


class WorkerHostRegistry:
    def __init__(self, identity, *, offer_timeout=10.0, enrollment_timeout=10.0,
                 on_available=None, on_updated=None, on_unavailable=None, on_run_message=None, command_channel=None):
        if not 0 < offer_timeout <= 60 or not 0 < enrollment_timeout <= 60:
            raise ValueError("Invalid Worker connection deadline.")
        self._identity = identity
        self._offer_timeout, self._enrollment_timeout = offer_timeout, enrollment_timeout
        self._handlers = {"available": on_available, "updated": on_updated, "unavailable": on_unavailable, "run": on_run_message}
        if any(handler is not None and (not callable(handler) or inspect.iscoroutinefunction(handler)) for handler in self._handlers.values()):
            raise TypeError("Worker callbacks must be synchronous Runtime notifications.")
        self._nodes: dict[str, _Connection] = {}
        self._connections: set[_Connection] = set()
        self._pending: dict[str, _Offer] = {}
        self._identity_locks = WeakValueDictionary()
        self._closed = False
        self._browser_pending = {}
        self._browser_unavailable = set()
        self.commands = None
        if command_channel is not None:
            from .worker_host_commands import WorkerCommandChannel
            self.commands = WorkerCommandChannel(self, command_channel)

    @asynccontextmanager
    async def identity_guard(self, node_id):
        """Routes hold this over identity commit + disconnect; handshake uses the same lock."""
        lock = self._identity_locks.setdefault(node_id, asyncio.Lock())
        async with lock:
            yield

    def on_browser_unavailable(self, handler):
        if not callable(handler) or inspect.iscoroutinefunction(handler):
            raise TypeError("Browser unavailable notification must be synchronous.")
        self._browser_unavailable.add(handler)
        return lambda: self._browser_unavailable.discard(handler)

    def list(self):
        return [deepcopy(connection.node) for connection in self._nodes.values()]

    def _notify(self, kind, connection, message=None):
        handler = self._handlers[kind]
        if handler is None:
            return
        arguments = (deepcopy(connection.node),) if message is None else (deepcopy(connection.node), deepcopy(message))
        result = handler(*arguments)
        if inspect.isawaitable(result):
            if inspect.iscoroutine(result):
                result.close()
            raise TypeError("Runtime notification must enqueue asynchronous work, not return it.")

    def _current(self, connection):
        return connection.node is not None and self._nodes.get(connection.node["id"]) is connection

    def _detach(self, connection, reason, *, notify=True):
        if not self._current(connection):
            return
        del self._nodes[connection.node["id"]]
        if self.commands is not None: self.commands.detach(connection)
        for request_id, pending in list(self._browser_pending.items()):
            if pending[0] is connection:
                self._browser_pending.pop(request_id, None)
                if not pending[2].done(): pending[2].set_result(None)
        # Reconnect invalidates view grants too, even when ordinary unavailable projection is skipped.
        for handler in tuple(self._browser_unavailable):
            try: handler(deepcopy(connection.node))
            except Exception: _LOG.error("Browser unavailable notification failed.")
        for identity, pending in list(self._pending.items()):
            if pending.connection is connection:
                del self._pending[identity]
                if not pending.result.done():
                    pending.result.set_result({"status": "unavailable", "reason": reason})
        if notify:
            try:
                self._notify("unavailable", connection)
            except Exception:
                # Cleanup cannot be vetoed by a Runtime projection failure.
                _LOG.error("Worker unavailable notification failed.")

    async def _close(self, connection, code=1008, reason="not-enrolled"):
        if connection.command_enabled:
            self._detach(connection, "Command connection is closing.")
        try:
            async with asyncio.timeout(5), connection.send_lock:
                await connection.socket.close(code=code, reason=reason)
        except (OSError, RuntimeError, TimeoutError, WebSocketDisconnect):
            pass

    async def _send(self, connection, value, *, require_current=False):
        value = (parse_negotiated_frame if self.commands is not None else parse_frame)(value, server=True)
        try:
            async with asyncio.timeout(5), connection.send_lock:
                if require_current and not self._current(connection):
                    return False
                await connection.socket.send_json(value)
            return True
        except (OSError, RuntimeError, TimeoutError, WebSocketDisconnect):
            self._detach(connection, "Node disconnected before accepting the run.")
            return False

    async def _ack(self, connection, accepted, reason=None, *, initial=False):
        return await self._send(connection, {"type": "server.ack", "protocolVersion": PROTOCOL_VERSION,
            "accepted": accepted, "receivedAt": now(), **({"reason": reason} if reason else {}),
            **({"commandChannel": {"protocolVersion": "0.10.0", "connectionId": connection.connection_id}}
               if initial and accepted and connection.command_enabled else {})})

    async def _reject(self, connection, reason, close_reason, code=1008):
        if connection.command_enabled:
            self._detach(connection, "Command connection rejected a protocol message.")
        await self._ack(connection, False, reason)
        await self._close(connection, code, close_reason)

    async def _receive(self, connection):
        event = await connection.socket.receive()
        if event["type"] == "websocket.disconnect":
            raise WebSocketDisconnect(event.get("code", 1006))
        raw = event.get("text")
        if raw is None:
            raw = event.get("bytes")
        if not isinstance(raw, (str, bytes)):
            raise ValueError("Invalid Worker frame.")
        if len(raw.encode("utf-8") if isinstance(raw, str) else raw) > MAX_PAYLOAD_BYTES:
            await self._close(connection, 1009, "message-too-large")
            raise WebSocketDisconnect(1009)
        value = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Invalid JSON number.")))
        if type(value) is dict and (str(value.get("type", "")).startswith("work.command.") or "commandChannel" in value):
            from .work_command_contract import strict_json
            from .work_command_frames import parse_command_frame
            # Decode the original bytes again with strict duplicate/number rules. The first
            # decode only classifies the retained mixed channel; it is never command evidence.
            original = raw.encode("utf-8") if isinstance(raw, str) else raw
            value = strict_json(original, maximum=32768)
            if str(value.get("type", "")).startswith("work.command."):
                if self.commands is None or not connection.command_enabled or not self._current(connection):
                    raise ValueError("Command channel not negotiated.")
                return (parse_command_frame(value, server=False), len(original))
        return (parse_negotiated_frame if self.commands is not None else parse_frame)(value)

    async def _authenticate(self, connection, hello):
        # Read concurrently with the database: duplicate hello, pre-auth frames, or a closed
        # socket must not become a live node when an in-flight credential check completes.
        authentication = asyncio.create_task(self._identity.authenticate(hello["nodeId"], hello["credential"]))
        early_frame = asyncio.create_task(self._receive(connection))
        try:
            done, _ = await asyncio.wait((authentication, early_frame), return_when=asyncio.FIRST_COMPLETED)
            if early_frame in done:
                message = early_frame.result()
                if message["type"] == "node.hello":
                    await self._reject(connection, "A connection may authenticate only once.", "already-enrolled")
                else:
                    await self._close(connection)
                return None
            try:
                return authentication.result()
            except Exception:
                await self._reject(connection, "Node authentication is temporarily unavailable.", "authentication-unavailable", 1011)
                return None
        finally:
            for task in (authentication, early_frame):
                if not task.done():
                    task.cancel()
            await asyncio.gather(authentication, early_frame, return_exceptions=True)

    async def handle(self, socket: WebSocket):
        connection = _Connection(socket)
        if self._closed:
            await socket.close(code=1012, reason="server-shutdown")
            return
        await socket.accept()
        self._connections.add(connection)
        try:
            async with asyncio.timeout(self._enrollment_timeout):
                hello = await self._receive(connection)
                if hello["type"] != "node.hello":
                    await self._close(connection)
                    return
                async with self.identity_guard(hello["nodeId"]):
                    accepted = await self._authenticate(connection, hello)
                    if accepted is None:
                        return
                    if not accepted:
                        await self._reject(connection, "Node credential is invalid or revoked.", "invalid-credential")
                        return
                    if self._closed:
                        await self._close(connection, 1012, "server-shutdown")
                        return
                    from .worker_host_identity import digest_secret
                    connection.connection_id = str(uuid4())
                    connection.credential_digest = digest_secret("credential", hello.pop("credential"))
                    connection.command_enabled = self.commands is not None and "commandChannel" in hello
                    previous = self._nodes.get(hello["nodeId"])
                    if previous is not None:
                        self._detach(previous, "Node reconnected with a new socket.", notify=False)
                        await self._close(previous, 1001, "node-reconnected")
                    stamp = now()
                    connection.node = {"id": hello["nodeId"], **{key: hello[key] for key in (
                        "name", "platform", "osVersion", "architecture", "deviceClass", "isolation", "trustTier",
                        "capabilities", "capabilityManifest", "maxConcurrentRuns")}, "activeRunIds": [], "connectedAt": stamp, "lastSeenAt": stamp}
                    self._nodes[hello["nodeId"]] = connection
                    if not await self._ack(connection, True, initial=True):
                        return
                    if connection.command_enabled: self.commands.activate(connection)
                    self._notify("available", connection)
            while self._current(connection) and not self._closed:
                message = await self._receive(connection)
                if type(message) is tuple:
                    self.commands.receive(connection, message[0], message[1])
                    continue
                kind = message["type"]
                if kind == "node.hello":
                    await self._reject(connection, "A connection may authenticate only once.", "already-enrolled")
                    return
                if not self._current(connection) or message["nodeId"] != connection.node["id"]:
                    await self._close(connection)
                    return
                connection.node["lastSeenAt"] = now()
                if kind == "node.heartbeat":
                    # Reported activeRunIds are never assignments or routing authority.
                    self._notify("updated", connection)
                elif kind == "browser.result":
                    pending = self._browser_pending.get(message["requestId"])
                    if pending is None:
                        # An expired command is never resurrected by a late valid result.
                        await self._ack(connection, False, "Browser command is no longer pending.")
                        continue
                    if pending[0] is not connection or pending[1] != message["sessionId"]:
                        await self._reject(connection, "Browser result identity mismatch.", "invalid-browser-result")
                        return
                    self._browser_pending.pop(message["requestId"], None)
                    if not pending[2].done(): pending[2].set_result(message)
                elif kind in _RUN_EVENTS:
                    if message["runId"] not in connection.node["activeRunIds"]:
                        await self._ack(connection, False, "Run is not assigned to this Node connection.")
                        continue
                    self._notify("run", connection, message)
                else:
                    pending = self._pending.get(message["offerId"])
                    if pending is None or pending.connection is not connection or pending.run_id != message["runId"]:
                        await self._reject(connection, "Run offer response is invalid or expired.", "invalid-offer-response")
                        return
                    del self._pending[message["offerId"]]
                    if not pending.result.done():
                        pending.result.set_result({"status": "accepted"} if kind == "run.accept" else {"status": "rejected", "reason": message["reason"]})
                if not await self._ack(connection, True):
                    return
        except TimeoutError:
            await self._close(connection, 1008, "enrollment-timeout")
        except (ValueError, TypeError, OverflowError, RecursionError):
            await self._reject(connection, "Invalid node protocol message.", "invalid-message")
        except (WebSocketDisconnect, OSError):
            pass
        except RuntimeError:
            await self._close(connection, 1011, "callback-unavailable")
        except asyncio.CancelledError:
            await self._close(connection, 1012, "server-shutdown")
            raise
        except Exception:
            await self._reject(connection, "Server could not process the node message.", "callback-unavailable", 1011)
        finally:
            self._detach(connection, "Node disconnected before accepting the run.")
            self._connections.discard(connection)

    async def browser_command(self, value, *, dispatch_guard):
        """Only BrowserSessions may supply this short authority context; no unguarded send."""
        frame = parse_frame(value, server=True)
        connection = self._nodes.get(frame["nodeId"])
        if (self._closed or connection is None or len(self._browser_pending) >= 64
                or frame["requestId"] in self._browser_pending
                or not any(cap["id"] == "browser.session" and cap["version"] == 1 and cap["providerId"] == "docker"
                           for cap in connection.node["capabilityManifest"])):
            raise RuntimeError("Browser Host unavailable.")
        future = asyncio.get_running_loop().create_future()
        pending = (connection, frame["sessionId"], future)
        self._browser_pending[frame["requestId"]] = pending
        try:
            async with asyncio.timeout(5), self.identity_guard(frame["nodeId"]), connection.send_lock:
                if not self._current(connection): raise RuntimeError("Browser Host disconnected.")
                async with dispatch_guard(frame):
                    frame = parse_frame(frame, server=True)
                    expiry = datetime.fromisoformat(frame["expiresAt"]).timestamp()
                    if not 0 < expiry - datetime.now(timezone.utc).timestamp() <= 25.1:
                        raise RuntimeError("Browser command expired.")
                    await connection.socket.send_json(frame)
            async with asyncio.timeout(max(0, expiry - datetime.now(timezone.utc).timestamp())):
                result = await future
            if result is None: raise RuntimeError("Browser command delivery is uncertain.")
            return result
        finally:
            if self._browser_pending.get(frame["requestId"]) is pending:
                self._browser_pending.pop(frame["requestId"], None)
            if not future.done(): future.cancel()

    async def offer_run(self, node_id, value):
        frame = parse_frame({**value, "type": "run.offer", "protocolVersion": PROTOCOL_VERSION, "offerId": str(uuid4()), "sentAt": now()}, server=True)
        connection = self._nodes.get(node_id)
        if connection is None:
            return {"status": "unavailable", "reason": "Node is not connected."}
        pending_count = sum(item.connection is connection for item in self._pending.values())
        if len(connection.node["activeRunIds"]) + pending_count >= connection.node["maxConcurrentRuns"]:
            return {"status": "unavailable", "reason": "Node is at capacity."}
        future = asyncio.get_running_loop().create_future()
        pending = _Offer(connection, frame["runId"], future)
        self._pending[frame["offerId"]] = pending
        try:
            if not await self._send(connection, frame, require_current=True):
                return {"status": "unavailable", "reason": "Node disconnected before accepting the run."}
            try:
                async with asyncio.timeout(self._offer_timeout):
                    return await future
            except TimeoutError:
                return {"status": "timeout"}
        finally:
            if self._pending.get(frame["offerId"]) is pending:
                del self._pending[frame["offerId"]]
            if not future.done():
                future.cancel()

    async def confirm_run(self, node_id, run_id):
        message = parse_frame({"type": "run.assigned", "protocolVersion": PROTOCOL_VERSION, "nodeId": node_id, "runId": run_id, "assignedAt": now()}, server=True)
        connection = self._nodes.get(node_id)
        if connection is None:
            return False
        if run_id not in connection.node["activeRunIds"]:
            connection.node["activeRunIds"].append(run_id)
        if not await self._send(connection, message, require_current=True):
            return False
        self._notify("updated", connection)
        return True

    async def _assigned_command(self, node_id, run_id, kind, stamp, **fields):
        message = parse_frame({"type": kind, "protocolVersion": PROTOCOL_VERSION, "nodeId": node_id,
                              "runId": run_id, stamp: now(), **fields}, server=True)
        connection = self._nodes.get(node_id)
        if connection is None or run_id not in connection.node["activeRunIds"]:
            return False
        return await self._send(connection, message, require_current=True)

    async def start_run(self, node_id, run_id):
        return await self._assigned_command(node_id, run_id, "run.start", "startedAt")

    async def resolve_approval(self, node_id, *, run_id, request_id, decision):
        return await self._assigned_command(node_id, run_id, "approval.resolved", "decidedAt", requestId=request_id, decision=decision)

    async def settle_run(self, node_id, run_id, status):
        return await self._remove_run(node_id, run_id, {"type": "run.settled", "nodeId": node_id, "status": status, "settledAt": now()})

    async def cancel_run(self, node_id, run_id, reason):
        return await self._remove_run(node_id, run_id, {"type": "run.cancel", "reason": reason, "cancelledAt": now()})

    async def _remove_run(self, node_id, run_id, value):
        message = parse_frame({"protocolVersion": PROTOCOL_VERSION, "runId": run_id, **value}, server=True)
        connection = self._nodes.get(node_id)
        if connection is None:
            return False
        connection.node["activeRunIds"] = [identity for identity in connection.node["activeRunIds"] if identity != run_id]
        self._notify("updated", connection)
        return await self._send(connection, message, require_current=True)

    async def disconnect(self, node_id, reason="Node identity was revoked."):
        connection = self._nodes.get(node_id)
        if connection is not None:
            self._detach(connection, reason)
            await self._close(connection, 1008, "credential-revoked")

    async def close(self):
        self._closed = True
        connections = list(self._connections)
        for connection in connections:
            self._detach(connection, "Server is shutting down.")
        await asyncio.gather(*(self._close(connection, 1012, "server-shutdown") for connection in connections))
        if self.commands is not None: await self.commands.drain()
