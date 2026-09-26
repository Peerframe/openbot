"""Optional bounded notifications on the original Worker socket; never Work authority."""
import asyncio
from contextlib import asynccontextmanager
from contextvars import ContextVar
from copy import deepcopy
from dataclasses import dataclass, field
import inspect

from .work_command_contract import bounded_value
from .work_command_frames import parse_command_frame
from .work_command_store import LiveCommandConnection

_IN_GUARD = ContextVar('worker_command_guard', default=False)
MAX_ITEMS, MAX_BYTES, TIMEOUT = 4, 65536, 5.0


class CommandChannelError(ValueError):
    def __init__(self):
        super().__init__('command_channel_unavailable')


def _notify(callback, *args):
    result = callback(*args)
    if inspect.isawaitable(result):
        if inspect.iscoroutine(result): result.close()
        raise CommandChannelError()
    return result


@dataclass(frozen=True)
class CommandChannelConfiguration:
    """Trusted composition only. on_frame must enqueue synchronously and return True."""
    on_frame: object
    on_connected: object = None
    on_disconnected: object = None

    def __post_init__(self):
        if self.on_frame is None: raise TypeError('command_notification_required')
        for callback in (self.on_frame, self.on_connected, self.on_disconnected):
            if callback is not None and (not callable(callback) or inspect.iscoroutinefunction(callback)):
                raise TypeError('command_notifications_must_be_synchronous')


@dataclass(eq=False, repr=False)
class _Handle:
    connection: object
    live: LiveCommandConnection
    items: dict = field(default_factory=dict)
    pending: set = field(default_factory=set)
    replied: set = field(default_factory=set)
    bytes: int = 0
    closed: bool = False


@dataclass(eq=False, repr=False, frozen=True)
class CommandPending:
    """Opaque identity plus a copy-only view. Constructed values have no registry membership."""
    connection: object
    _frame: dict

    @property
    def frame(self):
        return deepcopy(self._frame)


class WorkerCommandChannel:
    def __init__(self, registry, configuration):
        if type(configuration) is not CommandChannelConfiguration:
            raise TypeError('command_configuration_required')
        self.registry, self.configuration = registry, configuration
        self._handles = {}
        self._closing = set()

    def activate(self, connection):
        live = LiveCommandConnection(connection.node['id'], connection.connection_id,
                                     connection.credential_digest)
        handle = _Handle(connection, live)
        self._handles[connection] = handle
        if self.configuration.on_connected:
            _notify(self.configuration.on_connected, handle)

    def connection(self, node_id):
        connection = self.registry._nodes.get(node_id)
        handle = self._handles.get(connection)
        self._current(handle)
        return handle

    def _current(self, handle):
        if (type(handle) is not _Handle or handle.closed or self.registry._closed
                or self._handles.get(handle.connection) is not handle
                or not self.registry._current(handle.connection)):
            raise CommandChannelError()
        clock = asyncio.get_running_loop().time()
        if any(timer is not None and timer.when() <= clock for _, timer in handle.items.values()):
            self._fail(handle)
            raise CommandChannelError()
        return handle

    @asynccontextmanager
    async def guard(self, handle):
        self._current(handle)
        async with self.registry.identity_guard(handle.live.node_id):
            self._current(handle)
            token = _IN_GUARD.set(True)
            try:
                yield handle.live
                self._current(handle)
            finally:
                _IN_GUARD.reset(token)

    def detach(self, connection):
        handle = self._handles.pop(connection, None)
        if handle is None: return
        handle.closed = True
        for _, timer in handle.items.values():
            if timer is not None: timer.cancel()
        handle.items.clear(); handle.pending.clear(); handle.replied.clear(); handle.bytes = 0
        if self.configuration.on_disconnected:
            try: _notify(self.configuration.on_disconnected, handle)
            except Exception: pass

    def _fail(self, handle):
        if type(handle) is not _Handle or handle.closed: return
        connection = handle.connection
        self.registry._detach(connection, 'Command channel unavailable.')
        task = asyncio.create_task(self.registry._close(connection, 1008, 'command-unavailable'))
        self._closing.add(task)
        task.add_done_callback(self._closing.discard)

    async def drain(self):
        if self._closing: await asyncio.gather(*tuple(self._closing), return_exceptions=True)

    def _reserve(self, handle, key, size, *, timed=False):
        self._current(handle)
        if key in handle.items or len(handle.items) >= MAX_ITEMS or handle.bytes + size > MAX_BYTES:
            self._fail(handle)
            raise CommandChannelError()
        timer = asyncio.get_running_loop().call_later(TIMEOUT, self._fail, handle) if timed else None
        handle.items[key] = (size, timer)
        handle.bytes += size

    def _release(self, handle, key):
        entry = handle.items.pop(key, None)
        if entry is None: return False
        size, timer = entry
        if timer is not None: timer.cancel()
        handle.bytes -= size
        return True

    def receive(self, connection, frame, raw_size):
        handle = self._handles.get(connection)
        self._current(handle)
        if frame['nodeId'] != handle.live.node_id:
            self._fail(handle); raise CommandChannelError()
        pending = CommandPending(handle, deepcopy(frame))
        self._reserve(handle, pending, raw_size + 4, timed=True)
        # One exchange can emit several consecutive frames with the same request UUID.
        # Membership belongs to this observation; Control validates stream order/authenticity.
        handle.pending.add(pending)
        try:
            if _notify(self.configuration.on_frame, pending) is not True:
                raise CommandChannelError()
            self._current(handle)
        except Exception:
            self._fail(handle)
            raise CommandChannelError() from None

    def _pending(self, pending):
        if type(pending) is not CommandPending: raise CommandChannelError()
        handle = self._current(pending.connection)
        if pending not in handle.pending or pending not in handle.items:
            raise CommandChannelError()
        return handle

    def complete(self, pending):
        handle = self._pending(pending)
        handle.pending.remove(pending)
        handle.replied.discard(pending)
        self._release(handle, pending)

    async def reply(self, pending, frame):
        handle = self._pending(pending)
        if any(frame.get(k) != pending._frame[k] for k in ('nodeId', 'requestId', 'preparationId')):
            raise CommandChannelError()
        if pending in handle.replied: raise CommandChannelError()
        handle.replied.add(pending)
        await self.send(pending.connection, frame, _pending=pending)

    async def send(self, handle, frame, *, _pending=None):
        """Bounded local write only. Call after authority SQL/guard scopes have exited."""
        if _IN_GUARD.get(): raise CommandChannelError()
        self._current(handle)
        frame = parse_command_frame(frame, server=True)
        if frame['nodeId'] != handle.live.node_id: raise CommandChannelError()
        for binding in (frame['payload'] if frame['type'] == 'work.command.prepare_open' else
                        frame['payload']['binding'] if frame['type'] == 'work.command.control_open' else None,):
            if binding is not None and binding['connectionId'] != handle.live.connection_id:
                raise CommandChannelError()
        raw = bounded_value(frame, maximum=32768)
        key = object()
        self._reserve(handle, key, len(raw) + 4)
        try:
            async with asyncio.timeout(TIMEOUT), handle.connection.send_lock:
                self._current(handle)
                if _pending is not None: self._pending(_pending)
                await handle.connection.socket.send_text(raw.decode('utf-8'))
                self._current(handle)
                if _pending is not None: self._pending(_pending)
        except asyncio.CancelledError:
            self._fail(handle)
            raise
        except Exception:
            self._fail(handle)
            raise CommandChannelError() from None
        finally:
            self._release(handle, key)
