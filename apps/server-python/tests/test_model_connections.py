"""Feature-source DTO/cipher, real SDK transport, and isolated PostgreSQL regressions.

All credentials are generated fixture data. Set OPENBOT_MODEL_CONNECTION_TEST_FIXTURE to an
owned disposable canonical-schema fixture; the additive candidate is applied to that DB only.
The original 9cc73c9 TypeScript cipher is executed with Node for interoperability.
"""
import asyncio
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
from urllib.parse import urlparse
from uuid import uuid4

import httpx2
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import ValidationError
from pydantic_ai.messages import ModelRequest, TextPart, ThinkingPart, ToolCallPart, ToolReturnPart, UserPromptPart
import pytest

from openbot_agent_runtime.contracts import ModelStepRequest, ToolDescriptor
from openbot_server.authority import AuthenticationRequired, OwnerTransactions
from openbot_server.control_errors import ControlError
from openbot_server.database import StoreUnavailable
from openbot_server.model_connections import ModelConnectionsService, PostgresModelConnectionStore
from openbot_server.model_connections_cipher import ModelCredentialCipher
from openbot_server.model_connections_inputs import (
    ConnectionPolicy, CreateModelConnectionInput, ModelSelection, ResolvedModelConnection,
    UpdateEmployeeModelInput, UpdateModelConnectionInput, connection_presets,
)
from openbot_server.model_connections_port import ModelConnectionPort
from openbot_server.product_model import ProductModelError

KEY = "synthetic-connection-key"
RAW_KEY = bytes(range(32))
CONTEXT = {"id": "synthetic-id", "presetId": "kimi", "baseUrl": "https://api.moonshot.cn/v1"}
TOOL = ToolDescriptor(name="fixture_tool", description="Fixture only", input_schema={
    "type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"], "additionalProperties": False})


def selection(identity, model="test-model"):
    return {"connectionId": identity, "modelId": model}


def create(preset="kimi", **extra):
    p = ConnectionPolicy().preset(preset)
    return {"name": "Synthetic " + uuid4().hex, "presetId": preset, "baseUrl": p["endpoints"][0]["baseUrl"], "apiKey": KEY, **extra}


def resolved(preset="kimi", model="test-model", endpoint=None):
    p = ConnectionPolicy().preset(preset)
    return ResolvedModelConnection("synthetic-id", 1, preset, p["protocol"], endpoint or p["endpoints"][0]["baseUrl"], model, KEY)


def request(messages=None, tools=()):
    return ModelStepRequest(step=1, messages=tuple(messages or [ModelRequest(parts=[UserPromptPart("Synthetic prompt")])]), tools=tools)


def reply(preset="kimi", model="test-model", *, tool=False, thinking=False):
    if preset == "anthropic":
        content = ([{"type": "thinking", "thinking": "private reasoning", "signature": "signature-fixture"}] if thinking else [])
        content.append({"type": "text", "text": "OK"})
        if tool:
            content.append({"type": "tool_use", "id": "call_fixture", "name": TOOL.name, "input": {"value": "x"}})
        return {"id": "msg_fixture", "type": "message", "role": "assistant", "model": model, "content": content,
                "stop_reason": "tool_use" if tool else "end_turn", "stop_sequence": None,
                "usage": {"input_tokens": 10, "output_tokens": 4}}
    message = {"role": "assistant", "content": "OK"}
    if thinking:
        if preset in ("openrouter", "minimax"):
            message["reasoning_details"] = [{"type": "reasoning.text", "text": "private reasoning", "format": "unknown"}]
        else:
            message["reasoning_content"] = "private reasoning"
    if tool:
        message["tool_calls"] = [{"id": "call_fixture", "type": "function", "function": {"name": TOOL.name, "arguments": '{"value":"x"}'}}]
    return {"id": "chat_fixture", "object": "chat.completion", "created": 1, "model": model,
            "choices": [{"index": 0, "finish_reason": "tool_calls" if tool else "stop", "message": message}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14},
            **({"provider": "synthetic-downstream"} if preset == "openrouter" else {})}


@pytest.mark.parametrize("value", ["a/b/c@route+suffix", "m" * 256, "x:", "x/"])
def test_source_model_ids_preserved(value):
    assert ModelSelection.model_validate(selection("legacy-kimi", value)).modelId == value


@pytest.mark.parametrize("field,value", [("apiKey", "x" * 2049), ("apiKey", "has space"), ("name", "😀" * 41),
    ("name", " "), ("baseUrl", "http://127.0.0.1:1"), ("baseUrl", "https://user:pass@localhost"),
    ("baseUrl", "https://localhost/?x=1"), ("baseUrl", "https://localhost/#x")])
def test_strict_source_create_bounds(field, value):
    with pytest.raises(ValidationError):
        CreateModelConnectionInput.model_validate(create(**{field: value}))


def test_source_optional_null_trim_revision_and_key_repr():
    value = CreateModelConnectionInput.model_validate(create(apiKey="\ufeff x \t", name="\ufeff Hello \n"))
    assert value.apiKey == "x" and value.name == "Hello" and "apiKey" not in repr(value)
    assert UpdateModelConnectionInput.model_validate({"expectedRevision": 1.0, "enabled": False}).expectedRevision == 1
    for body in ({"expectedRevision": True, "enabled": False}, {"expectedRevision": 1},
                 {"expectedRevision": 1, "apiKey": None}, {"expectedRevision": 1, "enabled": None},
                 {"expectedRevision": 1, "name": None}, {"expectedRevision": 1, "baseUrl": "https://example.com"}):
        with pytest.raises(ValidationError):
            UpdateModelConnectionInput.model_validate(body)
    assert UpdateEmployeeModelInput.model_validate({"expectedRevision": 1, "model": None}).model is None


def test_source_presets_and_operator_allowlist():
    presets = connection_presets()
    assert len(presets) == 12 and {p["id"] for p in presets} == {
        "openai", "anthropic", "gemini", "deepseek", "kimi", "openrouter", "siliconflow", "dashscope", "zai", "minimax", "ark", "custom"}
    assert ConnectionPolicy().endpoint("kimi", "https://api.moonshot.cn/v1///", "openai-chat") == "https://api.moonshot.cn/v1"
    policy = ConnectionPolicy(["https://127.0.0.1:8443/v1///"])
    assert policy.endpoint("custom", "https://127.0.0.1:8443/v1") == "https://127.0.0.1:8443/v1"
    for args in (("custom", "https://localhost:8443/v1"), ("kimi", "https://127.0.0.1:8443/v1"),
                 ("openai", "https://api.openai.com/v1", "anthropic-messages")):
        with pytest.raises(ValueError):
            policy.endpoint(*args)
    presets[0]["endpoints"][0]["baseUrl"] = "https://attacker.test"
    assert connection_presets()[0]["endpoints"][0]["baseUrl"] == "https://api.openai.com/v1"


def test_exact_feature_typescript_cipher_round_trip(tmp_path):
    source = (Path(__file__).parent / "fixtures/model-feature/model-credential-cipher.ts").read_bytes()
    module = tmp_path / "original-cipher.ts"
    module.write_bytes(source)
    cipher = ModelCredentialCipher(RAW_KEY)
    encrypted = cipher.encrypt(KEY, CONTEXT)
    script = """
import {ModelCredentialCipher} from './original-cipher.ts';
let text=''; for await (const chunk of process.stdin) text += chunk;
const input=JSON.parse(text); const cipher=ModelCredentialCipher.fromKey(Buffer.from(input.key,'hex'));
console.log(JSON.stringify({clear:cipher.decrypt(input.value,input.context),cipher:cipher.encrypt(input.clear,input.context)}));
"""
    runner = tmp_path / "run.mjs"
    runner.write_text(script)
    result = subprocess.run(["node", str(runner)], input=json.dumps({"key": RAW_KEY.hex(), "value": encrypted, "clear": KEY, "context": CONTEXT}), capture_output=True, text=True, check=True)
    value = json.loads(result.stdout)
    assert value["clear"] == KEY and cipher.decrypt(value["cipher"], CONTEXT) == KEY
    for name in CONTEXT:
        with pytest.raises(ControlError):
            cipher.decrypt(value["cipher"], {**CONTEXT, name: "changed"})
    with pytest.raises(ControlError):
        ModelCredentialCipher(b"z" * 32).decrypt(encrypted, CONTEXT)


@pytest.mark.parametrize("mutation", [lambda v: v + ".extra", lambda v: v.replace("v1.", "v2.", 1),
    lambda v: v + "=", lambda v: ".".join(v.split(".")[:3]), lambda v: "A" * 5601])
def test_cipher_refuses_noncanonical_or_invalid_envelope(mutation):
    cipher = ModelCredentialCipher(RAW_KEY)
    with pytest.raises(ControlError, match="model_credential_unavailable"):
        cipher.decrypt(mutation(cipher.encrypt(KEY, CONTEXT)), CONTEXT)


def test_protected_raw_key_file_create_reopen_missing_and_symlink(tmp_path):
    path = tmp_path / "key"
    a = ModelCredentialCipher.load(path, allow_create=True)
    assert path.stat().st_size == 32 and path.stat().st_mode & 0o777 == 0o600
    b = ModelCredentialCipher.load(path, allow_create=False)
    assert b.decrypt(a.encrypt(KEY, CONTEXT), CONTEXT) == KEY
    original = path.read_bytes()
    ModelCredentialCipher.load(path, allow_create=True)
    assert path.read_bytes() == original
    path.chmod(0o644)
    with pytest.raises(ControlError):
        ModelCredentialCipher.load(path, allow_create=True)
    path.chmod(0o600)
    link = tmp_path / "link"
    link.symlink_to(path)
    with pytest.raises(ControlError):
        ModelCredentialCipher.load(link, allow_create=True)
    with pytest.raises(ControlError):
        ModelCredentialCipher.load(tmp_path / "missing", allow_create=False)
    assert not (tmp_path / "missing").exists()


@pytest.mark.parametrize("preset,endpoint", [(p["id"], e["baseUrl"]) for p in connection_presets() for e in p["endpoints"]])
def test_every_feature_preset_region_uses_explicit_sdk_protocol(preset, endpoint):
    async def run():
        calls = []
        def handler(req):
            calls.append(req)
            return httpx2.Response(200, json=reply(preset))
        async with ModelConnectionPort(resolved(preset, endpoint=endpoint), transport=httpx2.MockTransport(handler)) as port:
            result = await port(request())
            assert result.text == "OK" and result.usage.input_tokens == 10 and result.usage.output_tokens == 4
            assert result.provider_name == preset and result.model_name == "test-model"
            assert port.protocol == ("anthropic-messages-v1" if preset == "anthropic" else "chat-completions-v1")
        assert len(calls) == 1
        req = calls[0]
        assert str(req.url) == endpoint + ("/v1/messages" if preset == "anthropic" else "/chat/completions")
        body = json.loads(req.content)
        assert body["max_completion_tokens" if preset == "openai" else "max_tokens"] == 4096
        assert body["stream"] is False and "apiKey" not in body
        assert req.headers["accept-encoding"] == "identity"
        if preset == "openai":
            assert body["store"] is False
        assert not any(k.startswith("x-stainless") for k in req.headers)
    asyncio.run(run())


@pytest.mark.parametrize("preset", ["openai", "anthropic", "kimi", "deepseek", "openrouter", "minimax"])
def test_protocol_tools_usage_and_signed_reasoning_round_trip(preset):
    async def run():
        calls = []
        def handler(req):
            calls.append(json.loads(req.content))
            return httpx2.Response(200, json=reply(preset, tool=len(calls)==1, thinking=preset!="openai" and len(calls)==1))
        async with ModelConnectionPort(resolved(preset), transport=httpx2.MockTransport(handler)) as port:
            first = request(tools=(TOOL,))
            result = await port(first)
            assert any(isinstance(p, ToolCallPart) for p in result.parts)
            assert "private" not in result.text
            if preset != "openai":
                assert any(isinstance(p, ThinkingPart) for p in result.parts)
            again = await port(request([*first.messages,result,ModelRequest(parts=[ToolReturnPart(TOOL.name,"done","call_fixture")])], (TOOL,)))
            assert again.text == "OK" and len(calls) == 2
    asyncio.run(run())


@pytest.mark.parametrize("effort", [None,"low","high","max"])
def test_kimi_k3_completion_tokens_and_explicit_legacy_effort(effort):
    async def run():
        calls=[]
        def handler(req):
            calls.append(json.loads(req.content)); return httpx2.Response(200,json=reply(model="kimi-k3"))
        async with ModelConnectionPort(replace(resolved(model="kimi-k3"),reasoning_effort=effort),transport=httpx2.MockTransport(handler)) as port:
            await port(request())
        assert calls[0]["max_completion_tokens"] == 4096 and calls[0]["reasoning_effort"] == (effort or "low")
    asyncio.run(run())


def test_custom_wide_model_and_short_key_cannot_silently_fallback():
    async def run():
        model="m/" + "x"*254
        config=ResolvedModelConnection("custom-id",1,"custom","openai-chat","https://127.0.0.1:8443/v1",model,"x")
        calls=[]
        def handler(req):
            calls.append(req); return httpx2.Response(200,json=reply("custom",model))
        with pytest.raises(ProductModelError):
            ModelConnectionPort(config,transport=httpx2.MockTransport(handler))
        async with ModelConnectionPort(config,policy=ConnectionPolicy([config.base_url]),transport=httpx2.MockTransport(handler)) as port:
            result=await port(request()); assert result.model_name==model
        assert len(calls)==1 and calls[0].headers["authorization"]=="Bearer x"
        with pytest.raises(ProductModelError):
            ModelConnectionPort(replace(config,protocol="responses-v1"),policy=ConnectionPolicy([config.base_url]))
    asyncio.run(run())


@pytest.mark.parametrize("status", [301,401,403,429,500])
def test_port_never_retries_or_follows(status):
    async def run():
        calls=[]
        def handler(req):
            calls.append(req); return httpx2.Response(status,headers={"location":"https://attacker.test"},json={"secret":KEY})
        async with ModelConnectionPort(resolved(),transport=httpx2.MockTransport(handler)) as port:
            with pytest.raises(ProductModelError) as error:
                await port(request())
        assert KEY not in str(error.value) and error.value.__cause__ is None and len(calls)==1
    asyncio.run(run())


@pytest.fixture(scope="module")
def fixture():
    path=os.environ.get("OPENBOT_MODEL_CONNECTION_TEST_FIXTURE")
    if not path:
        pytest.skip("Requires a dedicated disposable model-connections PostgreSQL fixture")
    f=json.loads(Path(path).read_text())
    parsed=urlparse(f["dsn"])
    assert parsed.hostname=="127.0.0.1" and parsed.path.startswith("/openbot_control_test_")
    with psycopg.connect(f["dsn"]) as db:
        if db.execute("SELECT to_regclass('model_connections')").fetchone()[0] is None:
            sql_path=Path(__file__).parents[3]/"candidate_model_connections.sql"
            if not sql_path.exists():
                sql_path=Path(os.environ["OPENBOT_MODEL_CONNECTION_CANDIDATE_SQL"])
            db.execute(sql_path.read_text())
    return f


@pytest.fixture
def clean(fixture):
    # This fixture database is exclusively owned by this responsibility module.
    with psycopg.connect(fixture["dsn"]) as db:
        db.execute("DELETE FROM model_connections")
    return fixture


def service(f, **options):
    return ModelConnectionsService(f["dsn"],ModelCredentialCipher(RAW_KEY),**options)


def invoke(f, method, *args, **options):
    return asyncio.run(getattr(service(f,**options),method)(f["token"],*args))


def bot(f, profile="model", configuration=None):
    identity=str(uuid4())
    with psycopg.connect(f["dsn"]) as db:
        db.execute("INSERT INTO bots(id,name,role,computer_profile,configuration) VALUES (%s,%s,'Fixture',%s,%s)",
                   (identity,"Fixture " + identity,profile,Jsonb(configuration or {"unrelated":{"retained":True}})))
    return identity


def test_pg_connection_encryption_update_revision_and_content_free_audit(clean):
    f=clean
    created=invoke(f,"create",create())
    assert created["revision"]==1 and created["enabled"] and created["hasApiKey"]
    assert created["source"]=="saved" and "apiKey" not in created
    current=invoke(f,"resolve",selection(created["id"]))
    assert current.api_key==KEY and KEY not in repr(current) and KEY not in json.dumps(current.provenance())
    unchanged=invoke(f,"update",created["id"],{"expectedRevision":1,"name":created["name"]})
    assert unchanged==created
    updated=invoke(f,"update",created["id"],{"expectedRevision":1,"enabled":False,"apiKey":"replacement-fixture-key"})
    assert updated["revision"]==2 and not updated["enabled"]
    with pytest.raises(ControlError,match="disabled"):
        invoke(f,"resolve",selection(created["id"]))
    with pytest.raises(ControlError,match="revision_conflict"):
        invoke(f,"update",created["id"],{"expectedRevision":1,"enabled":True})
    invoke(f,"update",created["id"],{"expectedRevision":2,"enabled":True})
    assert invoke(f,"resolve",selection(created["id"])).api_key=="replacement-fixture-key"
    with psycopg.connect(f["dsn"]) as db:
        encrypted=db.execute("SELECT encrypted_api_key FROM model_connections WHERE id=%s",(created["id"],)).fetchone()[0]
        assert encrypted.startswith("v1.") and KEY not in encrypted
        events=db.execute("SELECT payload FROM run_events WHERE payload->>'id'=%s ORDER BY created_at",(created["id"],)).fetchall()
        assert len(events)==3 and KEY not in json.dumps(events) and "replacement-fixture-key" not in json.dumps(events)


def test_pg_concurrent_update_single_winner_and_auth_required(clean):
    f=clean; c=invoke(f,"create",create())
    async def run():
        s=service(f)
        return await asyncio.gather(*(s.update(f["token"],c["id"],{"expectedRevision":1,"name":name}) for name in ("One","Two")),return_exceptions=True)
    results=asyncio.run(run())
    assert sum(isinstance(r,dict) for r in results)==1
    assert sum(isinstance(r,ControlError) and r.status==409 for r in results)==1
    for token in (None,"invalid",secrets.token_urlsafe(32)):
        with pytest.raises(AuthenticationRequired):
            asyncio.run(service(f).snapshot(token))


def test_pg_bot_cas_preserves_configuration_and_run_snapshot(clean):
    f=clean; first=invoke(f,"create",create()); second=invoke(f,"create",create("openai")); employee=bot(f)
    result=invoke(f,"update_employee_model",employee,{"expectedRevision":1,"model":selection(first["id"],"old/model")})
    assert result["employee"]["id"]==employee and result["details"]["revision"]==2 and result["employee"]["model"]["connectionId"]==first["id"]
    run_id=str(uuid4())
    async def queue():
        s=service(f)
        async with s._transactions.transaction(f["token"]) as db:
            snapshot=await s.in_transaction(db,employee)
            await db.execute("INSERT INTO runs(id,bot_id,channel_id,execution_profile,model_selection,instruction,title,status) "
                "VALUES (%s,%s,%s,'model',%s,'Synthetic','Synthetic','queued')",(run_id,employee,f["channelId"],Jsonb(snapshot)))
    asyncio.run(queue())
    invoke(f,"update_employee_model",employee,{"expectedRevision":2,"model":selection(second["id"],"new/model")})
    with pytest.raises(ControlError,match="revision_conflict"):
        invoke(f,"update_employee_model",employee,{"expectedRevision":2,"model":None})
    with psycopg.connect(f["dsn"]) as db:
        assert db.execute("SELECT model_selection FROM runs WHERE id=%s",(run_id,)).fetchone()[0]==selection(first["id"],"old/model")
        conf=db.execute("SELECT configuration FROM bots WHERE id=%s",(employee,)).fetchone()[0]
        assert conf["unrelated"]=={"retained":True} and conf["model"]==selection(second["id"],"new/model")
        assert db.execute("SELECT count(*) FROM employee_evolution_events WHERE bot_id=%s",(employee,)).fetchone()[0]==2
        assert db.execute("SELECT count(*) FROM run_events WHERE bot_id=%s AND type='EMPLOYEE_MODEL_UPDATED'",(employee,)).fetchone()[0]==2
    cleared=invoke(f,"update_employee_model",employee,{"expectedRevision":3,"model":None})
    assert "model" not in cleared["employee"] and cleared["details"]["revision"]==4
    with pytest.raises(ControlError,match="profile_required"):
        invoke(f,"update_employee_model",bot(f,"none"),{"expectedRevision":1,"model":selection(first["id"])})


def test_pg_disabled_and_missing_selection_never_falls_back(clean):
    f=clean
    legacy={"apiKey":KEY,"modelId":"kimi-k3"}
    assert invoke(f,"resolve",None) is None
    s=service(f,legacy_kimi=legacy)
    assert asyncio.run(s.resolve(f["token"],None)).connection_id=="legacy-kimi"
    snapshot=asyncio.run(s.snapshot(f["token"]))
    assert snapshot["connections"][0]["source"]=="environment" and KEY not in json.dumps(snapshot)
    with pytest.raises(ControlError,match="not_found"):
        asyncio.run(s.resolve(f["token"],selection("missing")))
    c=asyncio.run(s.create(f["token"],create()))
    asyncio.run(s.update(f["token"],c["id"],{"expectedRevision":1,"enabled":False}))
    with pytest.raises(ControlError,match="disabled"):
        asyncio.run(s.resolve(f["token"],selection(c["id"])))
    with pytest.raises(ControlError,match="read_only"):
        asyncio.run(s.update(f["token"],"legacy-kimi",{"expectedRevision":1,"enabled":False}))


def test_pg_key_missing_with_existing_rows_never_reinitialized(clean,tmp_path):
    f=clean; invoke(f,"create",create()); key=tmp_path/"missing-key"
    with pytest.raises(ControlError,match="credential_unavailable"):
        asyncio.run(ModelConnectionsService.from_key_path(f["dsn"],key))
    assert not key.exists()


def test_pg_audit_failure_rolls_back_and_hides_sql(clean):
    f=clean; employee=bot(f); c=invoke(f,"create",create())
    with psycopg.connect(f["dsn"]) as db:
        db.execute("CREATE FUNCTION connections_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private fixture diagnostic'; END $$")
        db.execute("CREATE TRIGGER connections_test_reject BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION connections_test_reject()")
    try:
        for method,args in (("create",(create(),)),("update",(c["id"],{"expectedRevision":1,"enabled":False})),
            ("update_employee_model",(employee,{"expectedRevision":1,"model":selection(c["id"])}))):
            with pytest.raises(StoreUnavailable,match="model_connections_storage_unavailable") as error:
                invoke(f,method,*args)
            assert "private" not in str(error.value) and error.value.__cause__ is None
        with psycopg.connect(f["dsn"]) as db:
            assert db.execute("SELECT count(*) FROM model_connections").fetchone()[0]==1
            assert db.execute("SELECT revision,enabled FROM model_connections WHERE id=%s",(c["id"],)).fetchone()==(1,True)
            assert db.execute("SELECT profile_revision,configuration FROM bots WHERE id=%s",(employee,)).fetchone()==(1,{"unrelated":{"retained":True}})
            assert db.execute("SELECT count(*) FROM employee_evolution_events WHERE bot_id=%s",(employee,)).fetchone()[0]==0
    finally:
        with psycopg.connect(f["dsn"]) as db:
            db.execute("DROP TRIGGER connections_test_reject ON run_events")
            db.execute("DROP FUNCTION connections_test_reject()")


def test_pg_connection_limit_serializes_concurrent_creators(clean):
    f=clean
    async def run():
        a,b=service(f),service(f)
        results=await asyncio.gather(*((a if i%2 else b).create(f["token"],create()) for i in range(34)),return_exceptions=True)
        return results
    results=asyncio.run(run())
    assert sum(isinstance(r,dict) for r in results)==32
    assert sum(isinstance(r,ControlError) and r.code=="model_connection_limit" for r in results)==2


@pytest.mark.parametrize("preset,query",[("kimi",""),("anthropic","?limit=256"),("openrouter","?output_modalities=text"),("siliconflow","?type=text&sub_type=chat")])
def test_pg_metadata_exact_path_filter_bound_and_no_inference(clean,preset,query):
    f=clean; c=invoke(f,"create",create(preset)); calls=[]
    def handler(req):
        calls.append(req)
        return httpx2.Response(200,json={"data":[None,{"id":"bad space"},{"id":" good/model "},{"id":"good/model"},{"id":KEY}]+[{"id":"m"+str(i)} for i in range(400)]})
    value=invoke(f,"discover",c["id"],transport_factory=lambda:httpx2.MockTransport(handler))
    assert len(value)==256 and value[0]=="good/model" and KEY not in value
    assert len(calls)==1 and calls[0].method=="GET"
    assert str(calls[0].url)==c["baseUrl"]+("/v1/models" if preset=="anthropic" else "/models")+query


def test_pg_probe_is_single_explicit_no_tool_sdk_step(clean):
    f=clean; c=invoke(f,"create",create("openai")); calls=[]
    def handler(req):
        calls.append(req); return httpx2.Response(200,json=reply("openai"))
    assert invoke(f,"test",c["id"],{"modelId":"test-model"},transport_factory=lambda:httpx2.MockTransport(handler))=={"ok":True}
    assert len(calls)==1
    body=json.loads(calls[0].content)
    assert not body.get("tools") and body["messages"][0]["content"]=="Reply with OK."


def test_pg_rotation_during_discovery_refuses_stale_result(clean):
    f=clean; c=invoke(f,"create",create())
    async def handler(req):
        await service(f).update(f["token"],c["id"],{"expectedRevision":1,"apiKey":"rotated-fixture-key"})
        return httpx2.Response(200,json={"data":[{"id":"test-model"}]})
    with pytest.raises(ControlError,match="revision_conflict"):
        invoke(f,"discover",c["id"],transport_factory=lambda:httpx2.MockTransport(handler))


def test_source_preset_dtos_match_original_typescript_exactly(tmp_path):
    source=(Path(__file__).parent / "fixtures/model-feature/model-provider-presets.ts").read_bytes()
    (tmp_path/"presets.ts").write_bytes(source)
    (tmp_path/"read.mjs").write_text("import {modelProviderPresets} from './presets.ts'; console.log(JSON.stringify(modelProviderPresets));")
    value=subprocess.run(["node",str(tmp_path/"read.mjs")],capture_output=True,text=True,check=True)
    assert json.loads(value.stdout)==connection_presets()


def test_key_concurrent_initializers_publish_one_complete_inode(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    path=tmp_path/"shared"/"key"
    def initialize(_):
        return ModelCredentialCipher.load(path,allow_create=True)
    with ThreadPoolExecutor(max_workers=8) as pool:
        ciphers=list(pool.map(initialize,range(12)))
    ciphertext=ciphers[0].encrypt(KEY,CONTEXT)
    assert all(c.decrypt(ciphertext,CONTEXT)==KEY for c in ciphers)
    assert len(list(path.parent.iterdir()))==1


@pytest.mark.parametrize("variable",["OPENAI_CUSTOM_HEADERS","ANTHROPIC_CUSTOM_HEADERS","OPENAI_LOG","ANTHROPIC_LOG"])
def test_ambient_sdk_options_are_refused(monkeypatch,variable):
    monkeypatch.setenv(variable,"synthetic")
    with pytest.raises(ProductModelError):
        ModelConnectionPort(resolved())


def test_ambient_credentials_and_proxy_are_not_inherited(monkeypatch):
    for name in ("OPENAI_API_KEY","ANTHROPIC_API_KEY","MOONSHOT_API_KEY","HTTP_PROXY","HTTPS_PROXY","ALL_PROXY"):
        monkeypatch.setenv(name,"synthetic-ambient-value")
    async def run():
        calls=[]
        def handler(req):
            calls.append(req); return httpx2.Response(200,json=reply())
        async with ModelConnectionPort(resolved(),transport=httpx2.MockTransport(handler)) as port:
            await port(request())
        assert calls[0].headers["authorization"]=="Bearer "+KEY
        assert "synthetic-ambient-value" not in str(calls[0].headers)
    asyncio.run(run())


def test_gate_failure_prevents_any_provider_transmission():
    async def run():
        calls=[]
        async def gate():
            raise AuthenticationRequired()
        def handler(req):
            calls.append(req); return httpx2.Response(200,json=reply())
        async with ModelConnectionPort(resolved(),before_send=gate,transport=httpx2.MockTransport(handler)) as port:
            with pytest.raises(ProductModelError):
                await port(request())
        assert calls==[]
    asyncio.run(run())


@pytest.mark.parametrize("damage",["wrong_usage","length_stop","hosted_tool","unoffered_tool","minimax_visible_think"])
def test_invalid_outputs_are_not_accepted_as_completed(damage):
    preset="minimax" if damage=="minimax_visible_think" else "kimi"
    value=reply(preset)
    if damage=="wrong_usage":
        value["usage"]["total_tokens"]=999
    elif damage=="length_stop":
        value["choices"][0]["finish_reason"]="length"
    elif damage=="hosted_tool":
        value["choices"][0]["message"]["tool_calls"]=[{"id":"x","type":"web_search"}]
    elif damage=="unoffered_tool":
        value=reply(tool=True)
    else:
        value["choices"][0]["message"]["content"]="<think>private</think>OK"
    async def run():
        async with ModelConnectionPort(resolved(preset),transport=httpx2.MockTransport(lambda req:httpx2.Response(200,json=value))) as port:
            with pytest.raises(ProductModelError):
                await port(request())
    asyncio.run(run())


class FixtureStream(httpx2.AsyncByteStream):
    def __init__(self,parts):
        self.parts=parts; self.closed=False
    async def __aiter__(self):
        for part in self.parts:
            yield part
    async def aclose(self):
        self.closed=True


def test_raw_stream_limit_is_applied_before_json_and_stream_is_closed():
    async def run():
        stream=FixtureStream([b"a"*300,b"b"*300])
        async with ModelConnectionPort(resolved(),max_response_bytes=512,
            transport=httpx2.MockTransport(lambda req:httpx2.Response(200,headers={"content-type":"application/json"},stream=stream))) as port:
            with pytest.raises(ProductModelError,match="task_limit"):
                await port(request())
        assert stream.closed
    asyncio.run(run())


def test_real_localhost_https_allowlist_sdk_chunked_transport(tmp_path):
    import ipaddress
    import ssl
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes,serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID
    key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,"Synthetic localhost")])
    now=datetime.now(timezone.utc)
    cert=(x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=1)).not_valid_after(now+timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]),critical=False)
        .add_extension(x509.BasicConstraints(ca=True,path_length=None),critical=True).sign(key,hashes.SHA256()))
    cert_path,key_path=tmp_path/"cert.pem",tmp_path/"key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
    key_path.chmod(0o600)
    server_ssl=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); server_ssl.load_cert_chain(cert_path,key_path)
    client_ssl=ssl.create_default_context(cafile=str(cert_path))
    async def run():
        calls=[]
        async def handler(reader,writer):
            try:
                headers=await reader.readuntil(b"\r\n\r\n")
                length=int(next(line.split(b":",1)[1] for line in headers.split(b"\r\n") if line.lower().startswith(b"content-length:")))
                body=await reader.readexactly(length); calls.append((headers,json.loads(body)))
                payload=json.dumps(reply("custom")).encode()
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n")
                for piece in (payload[:47],payload[47:]):
                    writer.write(f"{len(piece):x}\r\n".encode()+piece+b"\r\n")
                writer.write(b"0\r\n\r\n"); await writer.drain()
            finally:
                writer.close(); await writer.wait_closed()
        server=await asyncio.start_server(handler,"127.0.0.1",0,ssl=server_ssl)
        url=f"https://127.0.0.1:{server.sockets[0].getsockname()[1]}/v1"
        config=ResolvedModelConnection("local",1,"custom","openai-chat",url,"test-model",KEY)
        try:
            async with ModelConnectionPort(config,policy=ConnectionPolicy([url]),
                transport=httpx2.AsyncHTTPTransport(verify=client_ssl,trust_env=False,retries=0)) as port:
                assert (await port(request())).text=="OK"
        finally:
            server.close(); await server.wait_closed()
        assert len(calls)==1 and calls[0][0].startswith(b"POST /v1/chat/completions HTTP/1.1\r\n")
        assert calls[0][1]["model"]=="test-model"
    asyncio.run(run())


def session(f,seconds=60):
    token=secrets.token_urlsafe(32); identity=str(uuid4())
    with psycopg.connect(f["dsn"]) as db:
        db.execute("INSERT INTO auth_sessions(id,token_digest,expires_at) VALUES (%s,%s,clock_timestamp() + %s * interval '1 second')",
            (identity,hashlib.sha256(token.encode()).hexdigest(),seconds))
    return token,identity


def test_pg_expiry_at_commit_rolls_back_connection_and_audit(clean):
    f=clean; token,identity=session(f,0.3)
    with psycopg.connect(f["dsn"]) as db:
        db.execute("CREATE FUNCTION connections_test_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.5); RETURN NEW; END $$")
        db.execute("CREATE TRIGGER connections_test_delay BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION connections_test_delay()")
    try:
        with pytest.raises(AuthenticationRequired):
            asyncio.run(service(f).create(token,create()))
        with psycopg.connect(f["dsn"]) as db:
            assert db.execute("SELECT count(*) FROM model_connections").fetchone()[0]==0
    finally:
        with psycopg.connect(f["dsn"]) as db:
            db.execute("DROP TRIGGER connections_test_delay ON run_events")
            db.execute("DROP FUNCTION connections_test_delay()")


@pytest.mark.parametrize("operation",["discover","test"])
def test_pg_revocation_during_network_refuses_result(operation,clean):
    f=clean; token,identity=session(f); c=invoke(f,"create",create())
    async def handler(req):
        async with await psycopg.AsyncConnection.connect(f["dsn"]) as db:
            await db.execute("UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=%s",(identity,))
        return httpx2.Response(200,json={"data":[{"id":"test-model"}]} if operation=="discover" else reply())
    s=service(f,transport_factory=lambda:httpx2.MockTransport(handler))
    args=(c["id"],) if operation=="discover" else (c["id"],{"modelId":"test-model"})
    with pytest.raises(AuthenticationRequired):
        asyncio.run(getattr(s,operation)(token,*args))


def test_pg_probe_admission_bound_and_cancel_release(clean):
    f=clean; c=invoke(f,"create",create())
    async def run():
        started=asyncio.Event(); calls=0
        async def handler(req):
            nonlocal calls
            calls+=1
            if calls==2: started.set()
            await asyncio.Event().wait()
        s=service(f,transport_factory=lambda:httpx2.MockTransport(handler))
        pending=[asyncio.create_task(s.test(f["token"],c["id"],{"modelId":"test-model"})) for _ in range(2)]
        await asyncio.wait_for(started.wait(),2)
        with pytest.raises(ControlError,match="checks_busy"):
            await s.discover(f["token"],c["id"])
        for task in pending: task.cancel()
        result=await asyncio.gather(*pending,return_exceptions=True)
        assert all(isinstance(r,asyncio.CancelledError) for r in result) and s._operations==0 and calls==2
    asyncio.run(run())


def test_pg_copied_ciphertext_and_protocol_tampering_fail_closed(clean):
    f=clean; a=invoke(f,"create",create()); b=invoke(f,"create",create())
    with psycopg.connect(f["dsn"]) as db:
        db.execute("UPDATE model_connections SET encrypted_api_key=(SELECT encrypted_api_key FROM model_connections WHERE id=%s) WHERE id=%s",(a["id"],b["id"]))
    with pytest.raises(ControlError,match="credential_unavailable"):
        invoke(f,"resolve",selection(b["id"]))
    with psycopg.connect(f["dsn"]) as db:
        db.execute("UPDATE model_connections SET protocol='anthropic-messages' WHERE id=%s",(a["id"],))
    with pytest.raises(ControlError,match="endpoint_not_authorized"):
        invoke(f,"resolve",selection(a["id"]))


def test_port_overall_deadline_and_cancellation_do_not_retry():
    async def run():
        calls=0
        async def handler(req):
            nonlocal calls
            calls+=1
            await asyncio.Event().wait()
        async with ModelConnectionPort(resolved(),deadline_seconds=0.05,transport=httpx2.MockTransport(handler)) as port:
            with pytest.raises(ProductModelError,match="task_timeout"):
                await port(request())
        assert calls==1
    asyncio.run(run())


def test_pg_revision_fence_is_explicit(clean):
    f=clean
    c=invoke(f,"create",create())
    assert asyncio.run(service(f).resolve(f["token"],selection(c["id"]),expected_revision=1)).revision==1
    invoke(f,"update",c["id"],{"expectedRevision":1,"name":"Renamed"})
    with pytest.raises(ControlError,match="revision_conflict"):
        asyncio.run(service(f).resolve(f["token"],selection(c["id"]),expected_revision=1))


def test_pg_malformed_stored_selection_is_not_a_legacy_fallback(clean):
    f=clean; identity=bot(f,configuration={"model":{"connectionId":"missing"}})
    async def run():
        s=service(f,legacy_kimi={"apiKey":KEY})
        async with s._transactions.transaction(f["token"]) as db:
            await s.in_transaction(db,identity)
    with pytest.raises(ControlError,match="stored_model_selection_invalid"):
        asyncio.run(run())
