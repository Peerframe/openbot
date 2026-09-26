"""Trusted composition of the control host and separately installed SDK worker."""
import asyncio
import math
from pathlib import Path

from .runtime_host import RuntimeHost
from .runtime_ports import RuntimeDenied


async def execute_runtime(host: RuntimeHost, *, python_executable: str, worker_entrypoint: str,
                          deadline_seconds: float = 300) -> dict:
    if (type(python_executable) is not str or not Path(python_executable).is_absolute()
        or type(worker_entrypoint) is not str or not Path(worker_entrypoint).is_absolute()
        or type(deadline_seconds) not in (int, float) or not 0 < deadline_seconds <= 300
        or not math.isfinite(deadline_seconds)):
        raise RuntimeDenied("invalid_target")
    # Import only the control-owned adapter; the SDK stays in the worker's interpreter/environment.
    from .runtime_process import RuntimeProcessError, supervise_runtime
    loop = asyncio.get_running_loop()
    deadline = loop.time() + deadline_seconds
    try:
        async with asyncio.timeout_at(deadline):
            catalog = await host.catalog()
            remaining = max(0, deadline - loop.time())
            if remaining <= 0:
                raise RuntimeDenied("task_limit")
            text = await supervise_runtime(python_executable, ("-I", "-u", worker_entrypoint), {
                "jsonrpc": "2.0", "id": "run", "method": "runtime.execute",
                "params": {"protocol": "openbot-agent-runtime/1", "tools": catalog,
                           "deadlineMs": min(300000, max(1, math.ceil(remaining * 1000)))},
            }, host.dispatch, deadline_seconds=remaining)
            return await host.finish(text)
    except TimeoutError:
        raise RuntimeDenied("task_limit") from None
    except RuntimeProcessError as error:
        raise RuntimeDenied(error.reason) from None
    finally:
        # Any late callback after process teardown must fail, including after provisional success.
        host.cancelled.set()
