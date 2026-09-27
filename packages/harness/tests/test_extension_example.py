"""Exercise the public contribution path with installed harness and real cancellation."""

import asyncio
import importlib.util
from pathlib import Path
import pytest
from openbot_agent_runtime import FailureReason, RuntimeFailure

spec = importlib.util.spec_from_file_location(
    "read_note_example", Path(__file__).resolve().parents[1] / "examples/read_note.py"
)
assert spec and spec.loader
example = importlib.util.module_from_spec(spec)
spec.loader.exec_module(example)


@pytest.mark.anyio
async def test_read_canonical_result_and_projections():
    host = example.FixtureHost()
    result = await host.run()
    assert host.calls == 1 and host.closed
    assert host.result == {"status": "read", "noteId": "welcome", "text": "A bounded fixture note."}
    assert result.text == example.model_summary(host.result)
    assert example.ui_projection(host.result)["summary"] == result.text


@pytest.mark.anyio
async def test_declined_authority_never_opens_the_tool():
    host = example.FixtureHost(allowed=False)
    with pytest.raises(RuntimeFailure) as error:
        await host.run()
    assert error.value.reason == FailureReason.AUTHORITY_REVOKED
    assert host.calls == 0 and host.result is None


@pytest.mark.anyio
async def test_tool_error_cleans_up_and_is_not_a_success():
    host = example.FixtureHost(mode="error")
    with pytest.raises(RuntimeFailure) as error:
        await host.run()
    assert error.value.reason == FailureReason.TOOL_PORT_ERROR
    assert host.closed and host.result is None and host.calls == 1


@pytest.mark.anyio
async def test_unknown_remains_unknown_without_retry_or_publication():
    host = example.FixtureHost(mode="unknown")
    result = await host.run()
    assert host.result == {"status": "unknown", "noteId": "welcome", "text": None}
    assert "unknown" in result.text and host.calls == 1 and host.closed


@pytest.mark.anyio
async def test_cancellation_closes_the_resource_without_returning_a_result():
    host = example.FixtureHost(mode="wait")
    task = asyncio.create_task(host.run())
    await asyncio.wait_for(host.started.wait(), 2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert host.closed and host.result is None and host.calls == 1


@pytest.mark.anyio
async def test_revocation_during_the_read_cleans_up_before_refusal():
    host = example.FixtureHost(mode="wait")
    task = asyncio.create_task(host.run())
    await asyncio.wait_for(host.started.wait(), 2)
    host.allowed = False
    host.release.set()
    with pytest.raises(RuntimeFailure) as error:
        await task
    assert error.value.reason == FailureReason.AUTHORITY_REVOKED
    assert host.closed and host.result is None
