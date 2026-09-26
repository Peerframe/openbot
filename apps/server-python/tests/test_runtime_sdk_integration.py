"""Actual separate SDK worker with a deterministic control model; no live provider/database."""
import asyncio
from dataclasses import replace
from pathlib import Path
import sys

import pytest

from openbot_server.runtime_executor import execute_runtime
from openbot_server.runtime_host import RuntimeHost
from openbot_server.runtime_ports import ModelStep, RuntimeDenied
from test_runtime_host import Fixture, intent

ROOT = Path(__file__).resolve().parents[3]
PYTHON = ROOT / "apps/agent-runtime-python/.venv/bin/python"
WORKER = ROOT / "apps/agent-runtime-python/scripts/run-worker.py"
pytestmark = pytest.mark.skipif(sys.platform == "win32" or not PYTHON.exists(),
    reason="Requires the separately bootstrapped Python SDK worker on POSIX")


async def run(host, deadline=10):
    return await execute_runtime(host,python_executable=str(PYTHON),worker_entrypoint=str(WORKER),deadline_seconds=deadline)


def test_real_sdk_uses_control_ports_for_tool_evidence_and_nullable_usage():
    async def check():
        f=Fixture([ModelStep("Investigating.",[intent()],"tool-calls",None,1),ModelStep("Delivered.",[],"stop",8,2)])
        result=await run(f.host())
        assert result=={"text":"Delivered.","appliedCorrectionIds":[]}
        assert f.effects==[({"query":"facts"},"c1")]
        assert f.usage[-1]["inputTokens"] is None and f.usage[-1]["outputTokens"]==3
        assert f.calls[-1].messages[1]["content"][0]=={"type":"text","text":"Investigating."}
        assert f.calls[-1].messages[-1]["content"][0]["output"]["value"]=={"evidence":"facts"}
    asyncio.run(check())


def test_real_sdk_multiple_tool_returns_and_reused_ids_keep_exact_host_history():
    async def check():
        f=Fixture([ModelStep("",[intent("c1"),intent("c2",query="other")],"tool-calls",1,1),
                   ModelStep("",[intent("c1",query="again")],"tool-calls",1,1),ModelStep("done",[],"stop",1,1)])
        result=await run(f.host())
        assert result["text"]=="done"
        assert [call[1] for call in f.effects]==["c1","c2","c1"]
        assert len(f.calls[1].messages[-1]["content"])==2 and len(f.calls[2].messages[-1]["content"])==1
    asyncio.run(check())


def test_real_sdk_cannot_turn_revoked_tool_or_usage_failure_into_success():
    async def check(which):
        f=Fixture();denial=RuntimeDenied("scope_revoked" if which=="tool" else "execution_failed")
        if which=="tool":
            async def effect(args,context): raise denial
            f.ports=replace(f.ports,tools=(replace(f.ports.tools[0],execute=effect),))
        else:
            async def save(value): raise denial
            f.ports=replace(f.ports,save_usage=save)
        with pytest.raises(RuntimeDenied) as error: await run(f.host())
        assert error.value is denial and len(f.calls)==1
    asyncio.run(check("tool"));asyncio.run(check("usage"))


def test_real_sdk_model_wait_is_bounded_by_parent_deadline():
    async def check():
        f=Fixture();entered=asyncio.Event()
        async def model(request,emit): entered.set();await asyncio.Event().wait()
        f.ports=replace(f.ports,generate=model)
        with pytest.raises(RuntimeDenied) as error: await run(f.host(),deadline=5)
        assert entered.is_set(), "the deadline must exercise a waiting model, not just worker startup"
        assert error.value.code=="task_limit" and not f.usage
    asyncio.run(check())


def test_real_sdk_cancel_while_model_waits_cannot_publish_late_answer():
    async def check():
        f=Fixture();entered=asyncio.Event()
        async def model(request,emit):
            entered.set()
            try: await asyncio.Event().wait()
            except asyncio.CancelledError: return ModelStep("late",[],"stop",1,1)
        f.ports=replace(f.ports,generate=model)
        task=asyncio.create_task(run(f.host()))
        await asyncio.wait_for(entered.wait(),5);task.cancel()
        with pytest.raises(asyncio.CancelledError): await asyncio.wait_for(task,3)
        assert not f.usage
    asyncio.run(check())


def test_executor_rejects_untrusted_paths_or_deadlines_before_process_start():
    async def check():
        for executable,entry,deadline in [("python",str(WORKER),1),(str(PYTHON),"worker.py",1),
                                        (str(PYTHON),str(WORKER),True),(str(PYTHON),str(WORKER),301),
                                        (str(PYTHON),str(WORKER),10**1000),
                                        (str(PYTHON),str(WORKER),float("nan"))]:
            with pytest.raises(RuntimeDenied) as error:
                await execute_runtime(Fixture().host(),python_executable=executable,worker_entrypoint=entry,deadline_seconds=deadline)
            assert error.value.code=="invalid_target"
    asyncio.run(check())


def test_real_sdk_cancellation_arriving_during_success_cleanup_still_cancels(monkeypatch):
    from openbot_server import runtime_process
    async def check():
        f = Fixture([ModelStep("Delivered.", [], "stop", 1, 1)])
        host = f.host()
        catalog = await host.catalog()
        caller = None
        delivered = False
        original = runtime_process._Supervision._signal_group
        def signal_group(supervisor, number):
            nonlocal delivered
            if not delivered:
                delivered = True
                # Align the cancellation with cleanup of an otherwise successful real worker.
                asyncio.get_running_loop().call_soon(caller.cancel)
            return original(supervisor, number)
        monkeypatch.setattr(runtime_process._Supervision, "_signal_group", signal_group)
        caller = asyncio.create_task(runtime_process.supervise_runtime(str(PYTHON),
            ("-I", "-u", str(WORKER)), {"jsonrpc": "2.0", "id": "run", "method": "runtime.execute",
                "params": {"protocol": "openbot-agent-runtime/1", "tools": catalog, "deadlineMs": 10000}},
            host.dispatch, deadline_seconds=10))
        with pytest.raises(asyncio.CancelledError):
            await caller
        assert delivered
    asyncio.run(check())
