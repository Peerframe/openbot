"""Real private files, process leases, TS crypto interoperability and bounded metadata I/O."""
import asyncio
import base64
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys

import httpx2 as httpx
import pytest
from pydantic import ValidationError

from openbot_server.control_errors import ControlError
from openbot_server.model_presets import model_provider_presets
from openbot_server.model_settings import ModelSettingsError, ModelSettingsService
import openbot_server.model_settings as module


INPUT = {"provider": "openai", "model": "fixture-model", "apiKey": "fixture-key-never-real", "revision": None}
KEY = "a" * 64


def service_at(tmp_path, handler=None):
    # macOS exposes /var via a system symlink; use the canonical fixture location intentionally.
    directory = tmp_path.resolve() / "private"
    return ModelSettingsService(directory, handler or (lambda request: httpx.Response(200, json={"id": INPUT["model"]})))


def test_roundtrip_encryption_opt_in_revision_and_listeners(tmp_path):
    async def check():
        calls = []
        def response(request):
            calls.append(request)
            return httpx.Response(200, json={"id": INPUT["model"]})
        service = service_at(tmp_path, response)
        assert await service.summary() == {"status": "unconfigured", "revision": None}
        assert await service.active() is None
        first = await service.save(INPUT)
        assert first["status"] == "configured" and first["agentEnabled"] is False
        assert await service.active() is None
        changes = []
        unsubscribe = service.on_change(lambda: changes.append("changed"))
        enabled = await service.save({**INPUT, "revision": first["revision"], "agentEnabled": True})
        active = await service.load_active()
        assert active["apiKey"] == INPUT["apiKey"] and active["agentEnabledAt"].endswith("Z")
        timestamp = active["agentEnabledAt"]
        again = await service.save({**INPUT, "revision": enabled["revision"], "agentEnabled": True})
        assert (await service.active())["agentEnabledAt"] == timestamp
        assert ModelSettingsService(service.directory)._current() == service._current()
        disabled = await service.save({**INPUT, "revision": again["revision"]})
        assert await service.active() is None and changes == ["changed"] * 3
        unsubscribe()
        with pytest.raises(ModelSettingsError, match="conflict"):
            await service.save(INPUT)
        assert await service.summary() == disabled
        assert INPUT["apiKey"] not in service.path.read_text()
        assert INPUT["apiKey"] not in json.dumps(disabled)
        for name in ("settings.json", "encryption.key", ".settings.json.lock"):
            assert stat.S_IMODE((service.directory / name).stat().st_mode) == 0o600
        assert not list(service.directory.glob("*.tmp")) and not (service.directory / ".settings.json.pending").exists()
        assert all(str(request.url) == "https://api.openai.com/v1/models/fixture-model" for request in calls)
        assert calls[0].headers["authorization"] == f"Bearer {INPUT['apiKey']}"
    asyncio.run(check())


@pytest.mark.parametrize("preset", model_provider_presets(), ids=lambda p: p["id"])
def test_every_provider_discovery_save_and_region_contract(tmp_path, preset):
    async def check():
        calls = []
        model = "vendor/fixture@v1+fast" if preset["id"] in {"openrouter", "siliconflow"} else "fixture-model"
        def response(request):
            calls.append(request)
            if request.url.path.endswith("/key"):
                return httpx.Response(200, json={"data": {"is_management_key": False}})
            if request.url.path.endswith("/endpoints"):
                return httpx.Response(200, json={"data": {"id": model, "endpoints": [{"supported_parameters": ["tools"]}]}})
            if request.url.path.endswith("/models/fixture-model"):
                return httpx.Response(200, json={"id": model})
            return httpx.Response(200, json={"data": [{"id": model}, {"id": model}, {"id": "bad?url"}]})
        service = service_at(tmp_path, response)
        selected = {**INPUT, "provider": preset["id"], "model": model, "baseUrl": preset["endpoints"][-1]["baseUrl"], "agentEnabled": True}
        discovery = {field: selected[field] for field in ("provider", "baseUrl", "apiKey")}
        if preset["discovery"]:
            assert await service.discover(discovery) == [model]
        else:
            with pytest.raises(ModelSettingsError, match="model_unavailable"):
                await service.discover(discovery)
        assert await service.summary() == {"status": "unconfigured", "revision": None}
        saved = await service.save(selected)
        assert saved["baseUrl"] == selected["baseUrl"]
        assert saved["verification"] == ("metadata" if preset["discovery"] else "not_checked")
        assert (await service.active())["baseUrl"] == selected["baseUrl"]
        if not preset["discovery"]:
            assert calls == []
        else:
            query = "?output_modalities=text" if preset["id"] == "openrouter" else (
                "?type=text&sub_type=chat" if preset["id"] == "siliconflow" else "")
            native = "/v1" if preset["id"] == "anthropic" else ""
            assert str(calls[0].url) == f"{selected['baseUrl']}{native}/models{query}"
            if preset["id"] == "anthropic":
                assert calls[0].headers["x-api-key"] == INPUT["apiKey"]
                assert calls[0].headers["anthropic-version"] == "2023-06-01"
                assert "authorization" not in calls[0].headers
            else:
                assert "x-api-key" not in calls[0].headers
        assert all(request.method == "GET" for request in calls)
    asyncio.run(check())


@pytest.mark.parametrize("body,code", [
    ({"data": {"is_management_key": True}}, "invalid_credentials"),
    ({"data": {"is_management_key": False, "is_provisioning_key": True}}, "invalid_credentials"),
    ({"data": {"is_management_key": 0}}, "invalid_credentials"),
    ({"data": {}}, "invalid_credentials"),
])
def test_openrouter_management_keys_stop_before_second_request(tmp_path, body, code):
    async def check():
        calls = []
        def response(request):
            calls.append(str(request.url))
            return httpx.Response(200, json=body)
        service = service_at(tmp_path, response)
        with pytest.raises(ModelSettingsError, match=code):
            await service.save({**INPUT, "provider": "openrouter", "model": "vendor/fixture"})
        assert calls == ["https://openrouter.ai/api/v1/key"]
        assert not service.path.exists()
    asyncio.run(check())


@pytest.mark.parametrize("endpoints,model", [
    ([], "vendor/fixture"), ([{"supported_parameters": ["tools"]}], "wrong/model"),
    ([{"supported_parameters": ["temperature"]}], "vendor/fixture"),
    ([{"supported_parameters": None}], "vendor/fixture"),
    ([{"supported_parameters": [0]}], "vendor/fixture"),
    ([{}] * 1001, "vendor/fixture"),
])
def test_openrouter_requires_exact_available_tool_model(tmp_path, endpoints, model):
    async def check():
        def response(request):
            return httpx.Response(200, json={"data": {"is_management_key": False}} if request.url.path.endswith("/key")
                                  else {"data": {"id": model, "endpoints": endpoints}})
        service = service_at(tmp_path, response)
        with pytest.raises(ModelSettingsError, match="model_unavailable"):
            await service.save({**INPUT, "provider": "openrouter", "model": "vendor/fixture", "agentEnabled": True})
        assert not service.path.exists()
    asyncio.run(check())


@pytest.mark.parametrize("status,code", [(401, "invalid_credentials"), (403, "invalid_credentials"), (404, "model_unavailable"),
                                        (302, "provider_unavailable"), (429, "provider_unavailable"), (500, "provider_unavailable")])
def test_http_errors_are_generic_no_redirect_or_retry(tmp_path, status, code):
    async def check():
        calls = []
        def response(request):
            calls.append(request)
            return httpx.Response(status, text="secret upstream response", headers={"location": "https://evil.example"})
        service = service_at(tmp_path, response)
        with pytest.raises(ModelSettingsError) as error:
            await service.save(INPUT)
        assert error.value.code == code and error.value.status == 422 and "secret" not in str(error.value) and len(calls) == 1
        assert not service.path.exists()
    asyncio.run(check())


class Parts(httpx.AsyncByteStream):
    def __init__(self, parts, delay=0):
        self.parts, self.delay, self.closed, self.read_count = parts, delay, False, 0

    async def __aiter__(self):
        for part in self.parts:
            await asyncio.sleep(self.delay)
            self.read_count += 1
            yield part

    async def aclose(self):
        self.closed = True


def test_raw_stream_bound_and_cancellation_close_body(tmp_path, monkeypatch):
    async def check():
        stream = Parts([b"x" * (32 * 1024), b"x", b"unread"])
        service = service_at(tmp_path, lambda request: httpx.Response(200, headers={"content-type": "application/json"}, stream=stream))
        with pytest.raises(ModelSettingsError, match="provider_unavailable"):
            await service.save(INPUT)
        assert stream.closed and stream.read_count == 2
        monkeypatch.setattr(module, "_METADATA_DEADLINE", 0.02)
        stream = Parts([b"{}"], delay=0.1)
        with pytest.raises(ModelSettingsError, match="provider_unavailable"):
            await service.save(INPUT)
        assert stream.closed
        monkeypatch.setattr(module, "_METADATA_DEADLINE", 8)
        started = asyncio.Event()
        async def response(request):
            started.set()
            return httpx.Response(200, headers={"content-type": "application/json"}, stream=stream)
        service._fetcher = response
        stream = Parts([b"{}"], delay=10)
        task = asyncio.create_task(service.save(INPUT))
        await started.wait()
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert stream.closed and not service._busy and not service.path.exists()
    asyncio.run(check())


@pytest.mark.parametrize("body,headers", [
    (b"not-json", {"content-type": "application/json"}),
    (b'{"id":NaN}', {"content-type": "application/json"}),
    (b"{}", {"content-type": "text/html"}),
    (b"{}", {"content-type": "application/json", "content-length": "32769"}),
    (b"{}", {"content-type": "application/json", "content-encoding": "gzip"}),
])
def test_invalid_or_compressed_metadata_fails_without_storage(tmp_path, body, headers):
    async def check():
        service = service_at(tmp_path, lambda request: httpx.Response(200, headers=headers, stream=Parts([body])))
        with pytest.raises(ModelSettingsError, match="provider_unavailable"):
            await service.save(INPUT)
        assert not service.path.exists()
    asyncio.run(check())


def test_discovery_order_dedup_limit_and_whole_body_validation(tmp_path):
    async def check():
        data = [{"id": "first"}, {"id": "first"}, {"id": "bad?"}] + [{"id": f"model-{i}"} for i in range(300)]
        service = service_at(tmp_path, lambda request: httpx.Response(200, json={"data": data}))
        request = {"provider": "openai", "apiKey": INPUT["apiKey"]}
        found = await service.discover(request)
        assert found == ["first"] + [f"model-{i}" for i in range(255)]
        data.append({"id": "x" * 129})
        with pytest.raises(ModelSettingsError, match="provider_unavailable"):
            await service.discover(request)
        assert not service.path.exists()
    asyncio.run(check())


def test_unsafe_paths_files_missing_key_and_ciphertext_are_never_overwritten(tmp_path):
    async def check():
        service = service_at(tmp_path)
        await service.save(INPUT)
        original = service.path.read_bytes()
        service.path.chmod(0o644)
        with pytest.raises(ModelSettingsError, match="storage_unavailable"):
            await service.summary()
        service.path.chmod(0o600)
        extra = service.directory / "hardlink"
        os.link(service.path, extra)
        with pytest.raises(ModelSettingsError, match="storage_unavailable"):
            await service.summary()
        extra.unlink()
        service.path.unlink()
        extra.write_bytes(original)
        extra.chmod(0o600)
        service.path.symlink_to(extra)
        with pytest.raises(ModelSettingsError, match="storage_unavailable"):
            await service.summary()
        service.path.unlink()
        service.path.write_bytes(original)
        service.path.chmod(0o600)
        envelope = json.loads(original)
        envelope["tag"] = base64.b64encode(b"x" * 16).decode()
        service.path.write_text(json.dumps(envelope))
        with pytest.raises(ModelSettingsError, match="storage_unavailable"):
            await service.save(INPUT)
        assert service.path.read_bytes() != original
        key_path = service.directory / "encryption.key"
        key_path.unlink()
        with pytest.raises(ModelSettingsError, match="storage_unavailable"):
            ModelSettingsService(service.directory)
        assert not key_path.exists()
        with pytest.raises(ModelSettingsError, match="storage_unavailable"):
            await service.summary()
        link = tmp_path.resolve() / "linked"
        link.symlink_to(service.directory, target_is_directory=True)
        with pytest.raises(ModelSettingsError, match="storage_unavailable"):
            ModelSettingsService(link)
        with pytest.raises(ModelSettingsError, match="storage_unavailable"):
            ModelSettingsService("relative/directory")
        exposed = tmp_path.resolve() / "exposed"
        exposed.mkdir(mode=0o755)
        with pytest.raises(ModelSettingsError, match="storage_unavailable"):
            ModelSettingsService(exposed)
    asyncio.run(check())


def test_real_process_lease_and_optimistic_revision_after_network(tmp_path):
    async def check():
        service = service_at(tmp_path)
        with service._lease():
            code = "from openbot_server.model_settings import ModelSettingsService,ModelSettingsError\nimport sys\ntry: ModelSettingsService(sys.argv[1])\nexcept ModelSettingsError as exc: print(exc.code)\n"
            child = subprocess.run([sys.executable, "-I", "-c", "import sys; sys.path.insert(0, " + repr(str(Path(__file__).resolve().parents[1] / "src")) + ");\n" + code, str(service.directory)], capture_output=True, text=True, check=True)
            assert child.stdout.strip() == "busy"
        waiting, release = asyncio.Event(), asyncio.Event()
        async def response(request):
            waiting.set()
            await release.wait()
            return httpx.Response(200, json={"id": INPUT["model"]})
        service._fetcher = response
        first = asyncio.create_task(service.save(INPUT))
        await waiting.wait()
        with pytest.raises(ModelSettingsError, match="busy"):
            await service.save(INPUT)
        other = ModelSettingsService(service.directory, lambda request: httpx.Response(200, json={"id": INPUT["model"]}))
        second = await other.save(INPUT)
        release.set()
        with pytest.raises(ModelSettingsError, match="conflict"):
            await first
        assert await service.summary() == second
    asyncio.run(check())


def test_authority_before_each_send_and_final_commit_failure_rolls_back(tmp_path):
    async def check():
        service = service_at(tmp_path)
        saved = await service.save(INPUT)
        previous = service.path.read_bytes()
        checks, transmissions = [], []
        @asynccontextmanager
        async def guard():
            checks.append("enter")
            yield
            checks.append("exit")
        def response(request):
            assert checks[-1] == "exit"
            transmissions.append(str(request.url))
            return httpx.Response(200, json={"data": {"is_management_key": False}} if request.url.path.endswith("/key")
                                  else {"data": {"id": "vendor/fixture", "endpoints": [{"supported_parameters": ["tools"]}]}})
        service._fetcher = response
        peer = ModelSettingsService(service.directory)
        entries = 0
        @asynccontextmanager
        async def failing_guard():
            nonlocal entries
            entries += 1
            async with guard():
                yield
                if entries == 3:
                    with pytest.raises(ModelSettingsError, match="busy"):
                        await peer.summary()
                    raise ControlError(401, "owner_session_revoked")
        with pytest.raises(ControlError, match="owner_session_revoked"):
            await service.save({**INPUT, "provider": "openrouter", "model": "vendor/fixture", "revision": saved["revision"], "agentEnabled": True}, authority=failing_guard)
        assert len(transmissions) == 2 and entries == 3
        assert service.path.read_bytes() == previous and await peer.summary() == saved
        assert not (service.directory / service._journal_name).exists()
        denied_calls = 0
        @asynccontextmanager
        async def denied():
            nonlocal denied_calls
            denied_calls += 1
            raise ControlError(401, "owner_session_revoked")
            yield
        with pytest.raises(ControlError, match="owner_session_revoked"):
            await service.discover({"provider": "openai", "apiKey": INPUT["apiKey"]}, authority=denied)
        assert denied_calls == 1 and len(transmissions) == 2
    asyncio.run(check())


def test_authority_revoked_between_openrouter_requests_stops_transmission(tmp_path):
    async def check():
        checks = calls = 0
        @asynccontextmanager
        async def guard():
            nonlocal checks
            checks += 1
            if checks > 1:
                raise ControlError(401, "owner_session_revoked")
            yield
        def response(request):
            nonlocal calls
            calls += 1
            return httpx.Response(200, json={"data": {"is_management_key": False}})
        service = service_at(tmp_path, response)
        with pytest.raises(ControlError, match="owner_session_revoked"):
            await service.save({**INPUT, "provider": "openrouter", "model": "vendor/fixture"}, authority=guard)
        assert calls == 1 and not service.path.exists()
    asyncio.run(check())


def test_new_file_rollback_on_cancellation_and_pending_journal_restart_recovery(tmp_path):
    async def check():
        service = service_at(tmp_path)
        entered, release = asyncio.Event(), asyncio.Event()
        @asynccontextmanager
        async def guard():
            yield
            if service.path.exists():
                entered.set()
                await release.wait()
        task = asyncio.create_task(service.save(INPUT, authority=guard))
        await entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not service.path.exists()
        assert await service.summary() == {"status": "unconfigured", "revision": None}
        saved = await service.save(INPUT)
        previous = service.path.read_bytes()
        await service.save({**INPUT, "revision": saved["revision"], "agentEnabled": True})
        journal = service.directory / service._journal_name
        journal.write_text(json.dumps({"version": 1, "previous": base64.b64encode(previous).decode()}))
        journal.chmod(0o600)
        restarted = ModelSettingsService(service.directory)
        assert await restarted.summary() == saved and await restarted.active() is None
        assert not journal.exists()
    asyncio.run(check())


def test_process_crash_during_authority_commit_recovers_previous_config(tmp_path):
    async def check():
        service = service_at(tmp_path)
        saved = await service.save(INPUT)
        original = service.path.read_bytes()
        code = """import asyncio, os, sys
from contextlib import asynccontextmanager
from openbot_server.model_settings import ModelSettingsService
@asynccontextmanager
async def crash_before_authority_commit():
    yield
    os._exit(17)
async def main():
    service = ModelSettingsService(sys.argv[1])
    await service.save({'provider':'ark','model':'ep-fixture','apiKey':'fixture-never-real-key',
                        'revision':sys.argv[2],'agentEnabled':True}, authority=crash_before_authority_commit)
asyncio.run(main())
"""
        child = subprocess.run([sys.executable, "-I", "-c", "import sys; sys.path.insert(0, " + repr(str(Path(__file__).resolve().parents[1] / "src")) + ");\n" + code, str(service.directory), saved["revision"]], capture_output=True, text=True)
        assert child.returncode == 17 and (service.directory / service._journal_name).exists()
        assert service.path.read_bytes() != original
        recovered = ModelSettingsService(service.directory)
        assert await recovered.summary() == saved and await recovered.active() is None
        assert service.path.read_bytes() == original
    asyncio.run(check())


def test_file_failure_after_atomic_publication_rolls_back(tmp_path, monkeypatch):
    async def check():
        service = service_at(tmp_path)
        saved = await service.save(INPUT)
        original = service.path.read_bytes()
        write = module._atomic_write
        injected = False
        def failing_write(root, name, contents):
            nonlocal injected
            write(root, name, contents)
            if name == "settings.json" and not injected:
                injected = True
                raise OSError("private filesystem detail")
        monkeypatch.setattr(module, "_atomic_write", failing_write)
        with pytest.raises(ModelSettingsError, match="storage_unavailable") as error:
            await service.save({**INPUT, "revision": saved["revision"], "agentEnabled": True})
        assert str(error.value) == "storage_unavailable"
        assert service.path.read_bytes() == original and await service.summary() == saved
    asyncio.run(check())


def test_model_list_mismatch_preserves_existing_settings(tmp_path):
    async def check():
        service = service_at(tmp_path)
        saved = await service.save(INPUT)
        original = service.path.read_bytes()
        service._fetcher = lambda request: httpx.Response(200, json={"data": [{"id": "unrelated-model"}]})
        with pytest.raises(ModelSettingsError, match="model_unavailable"):
            await service.save({**INPUT, "provider": "moonshot", "model": "kimi-k3", "revision": saved["revision"]})
        assert service.path.read_bytes() == original and await service.summary() == saved
    asyncio.run(check())


@pytest.mark.parametrize("fault", ["mode", "oversize", "changed", "symlink", "hardlink"])
def test_key_is_reverified_for_each_read(tmp_path, fault):
    async def check():
        service = service_at(tmp_path)
        await service.save(INPUT)
        ciphertext = service.path.read_bytes()
        key_path = service.directory / "encryption.key"
        if fault == "mode":
            key_path.chmod(0o644)
        elif fault == "oversize":
            key_path.write_text("a" * 65)
        elif fault == "changed":
            key_path.write_text("b" * 64)
        elif fault == "symlink":
            target = service.directory / "other.key"
            key_path.rename(target)
            key_path.symlink_to(target)
        else:
            os.link(key_path, service.directory / "other.key")
        with pytest.raises(ModelSettingsError, match="storage_unavailable"):
            await service.summary()
        assert service.path.read_bytes() == ciphertext
    asyncio.run(check())


@pytest.mark.skipif(shutil.which("node") is None, reason="Two-way TS envelope check needs the repository's Node runtime")
def test_real_node_aes_gcm_legacy_envelope_both_directions(tmp_path):
    async def check():
        directory = tmp_path.resolve() / "legacy"
        directory.mkdir(mode=0o700)
        path = directory / "model-settings.json"
        retained = {**INPUT, "revision": "12345678-1234-4234-8234-123456789012", "agentEnabled": True, "agentEnabledAt": "2026-09-20T01:02:03.004Z"}
        encrypt = """const {createCipheriv}=require('node:crypto');
const input=JSON.parse(require('node:fs').readFileSync(0,'utf8'));
const nonce=Buffer.alloc(12,7), cipher=createCipheriv('aes-256-gcm',Buffer.from(input.key,'hex'),nonce);
cipher.setAAD(Buffer.from('openbot.model-settings/v1'));
const ciphertext=Buffer.concat([cipher.update(JSON.stringify(input.settings)),cipher.final()]);
process.stdout.write(JSON.stringify({version:1,nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}));"""
        result = subprocess.run(["node", "-e", encrypt], input=json.dumps({"key": KEY, "settings": retained}), capture_output=True, text=True, check=True)
        path.write_text(result.stdout)
        path.chmod(0o600)
        service = ModelSettingsService.from_legacy(path, KEY, lambda request: httpx.Response(200, json={"id": INPUT["model"]}))
        assert await service.active() == retained
        assert not (directory / "encryption.key").exists()
        saved = await service.save({**INPUT, "revision": retained["revision"], "agentEnabled": True})
        decrypt = """const {createDecipheriv}=require('node:crypto');
const input=JSON.parse(require('node:fs').readFileSync(0,'utf8')), e=input.envelope;
const decipher=createDecipheriv('aes-256-gcm',Buffer.from(input.key,'hex'),Buffer.from(e.nonce,'base64'));
decipher.setAAD(Buffer.from('openbot.model-settings/v1'));decipher.setAuthTag(Buffer.from(e.tag,'base64'));
process.stdout.write(Buffer.concat([decipher.update(Buffer.from(e.ciphertext,'base64')),decipher.final()]));"""
        decoded = subprocess.run(["node", "-e", decrypt], input=json.dumps({"key": KEY, "envelope": json.loads(path.read_text())}), capture_output=True, text=True, check=True)
        assert json.loads(decoded.stdout) == {**retained, "revision": saved["revision"]}
        with pytest.raises(ModelSettingsError, match="storage_unavailable"):
            ModelSettingsService.from_legacy(path, "b" * 64)
    asyncio.run(check())


def test_real_loopback_stream_using_httpx_transport_and_no_environment_proxy(tmp_path, monkeypatch):
    async def check():
        received = []
        async def handler(reader, writer):
            request = await reader.readuntil(b"\r\n\r\n")
            received.append(request)
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n")
            for chunk in (b'{"id":', b'"fixture-model"}'):
                writer.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                await writer.drain()
            writer.write(b"0\r\n\r\n")
            await writer.drain()
            writer.close()
            await writer.wait_closed()
        server = await asyncio.start_server(handler, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        class LoopbackTransport(httpx.AsyncBaseTransport):
            def __init__(self):
                self.inner = httpx.AsyncHTTPTransport(trust_env=False, retries=0)
            async def handle_async_request(self, request):
                assert str(request.url) == "https://api.openai.com/v1/models/fixture-model"
                request.url = request.url.copy_with(scheme="http", host="127.0.0.1", port=port)
                return await self.inner.handle_async_request(request)
            async def aclose(self):
                await self.inner.aclose()
        monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
        monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:1")
        monkeypatch.setenv("OPENAI_API_KEY", "environment-key-not-authorized")
        try:
            service = service_at(tmp_path, LoopbackTransport())
            saved = await service.save(INPUT)
            assert saved["status"] == "configured" and len(received) == 1
            assert b"Authorization: Bearer fixture-key-never-real" in received[0]
            assert b"environment-key-not-authorized" not in received[0]
        finally:
            server.close()
            await server.wait_closed()
    asyncio.run(check())
