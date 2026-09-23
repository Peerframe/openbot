"""Acquire the child PID before the first await, then reuse asyncio's bounded pipe transports."""
import asyncio
from asyncio.streams import FlowControlMixin
import contextlib
import subprocess


class PipeProcess:
    def __init__(self, executable: str, args: tuple[str, ...], *, cwd: str, env: dict[str, str]):
        # asyncio's high-level factory also calls Popen synchronously, but withholds the handle
        # while connecting pipes. Owning it here lets cancellation always terminate its group.
        self._child = subprocess.Popen((executable, *args), cwd=cwd, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True, bufsize=0)
        self.pid = self._child.pid
        self.stdin: asyncio.StreamWriter | None = None
        self.stdout: asyncio.StreamReader | None = None
        self.stderr: asyncio.StreamReader | None = None
        self._transports: list[asyncio.BaseTransport] = []

    @property
    def returncode(self):
        return self._child.poll()

    async def connect(self) -> None:
        loop = asyncio.get_running_loop()
        protocol = FlowControlMixin(loop=loop)
        transport, _ = await loop.connect_write_pipe(lambda: protocol, self._child.stdin)
        self._transports.append(transport)
        self.stdin = asyncio.StreamWriter(transport, protocol, None, loop)
        for name in ("stdout", "stderr"):
            reader = asyncio.StreamReader(limit=65536)
            protocol = asyncio.StreamReaderProtocol(reader)
            transport, _ = await loop.connect_read_pipe(lambda: protocol, getattr(self._child, name))
            self._transports.append(transport)
            setattr(self, name, reader)

    async def wait(self) -> int:
        # Popen.poll uses the platform waitpid and records its result. No blocking wait thread can
        # outlive the invocation, and even a cancelled pipe attachment cannot prevent reaping.
        while (code := self._child.poll()) is None:
            await asyncio.sleep(.01)
        return code

    def close_stdin(self) -> None:
        if self.stdin is not None:
            self.stdin.close()
        elif self._child.stdin is not None:
            self._child.stdin.close()

    def close_pipes(self) -> None:
        for transport in self._transports:
            transport.close()
        for pipe in (self._child.stdin, self._child.stdout, self._child.stderr):
            if pipe is not None:
                with contextlib.suppress(OSError):
                    pipe.close()
