"""Feature-source per-Bot model connections, credentials and queued-selection seams.

Translated from OpenBot MIT 9cc73c9 model-services/store; reviewed dependencies are reused.
Owner methods are token-first. Internal ``*_in_transaction`` seams grant no authority and must
run inside the caller's already-authorized SQL transaction. Secrets never enter public DTOs,
audit or the Run snapshot. This module does not dispatch work or grant model/tool capabilities.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from functools import wraps
import hmac
import json
from uuid import uuid4

import httpx2
import psycopg
from psycopg.types.json import Jsonb
from pydantic import ValidationError

from .authority import OwnerTransactions, PostgresTransactions
from .control_errors import ControlError
from .database import StoreUnavailable
from .model_connections_cipher import ModelCredentialCipher
from .model_connections_inputs import (
    ConnectionPolicy, CreateModelConnectionInput, LegacyKimiConfiguration, ModelSelection,
    ResolvedModelConnection, TestModelConnectionInput, UpdateEmployeeModelInput,
    UpdateModelConnectionInput, connection_presets, model_id,
)
from .models import BotAppearance, iso_timestamp

_STORAGE = "model_connections_storage_unavailable"
_LOCK_NAMESPACE = 0x4D4F444C


def _guard(function):
    @wraps(function)
    async def guarded(*args, **kwargs):
        try:
            return await function(*args, **kwargs)
        except (psycopg.Error, TimeoutError, KeyError, UnicodeError):
            raise StoreUnavailable(_STORAGE) from None
    return guarded


def _public(row):
    return {"id": row["id"], "name": row["name"], "presetId": row["preset_id"],
            "baseUrl": row["base_url"], "protocol": row["protocol"], "enabled": row["enabled"],
            "hasApiKey": bool(row["encrypted_api_key"]), "revision": row["revision"], "source": "saved",
            "createdAt": iso_timestamp(row["created_at"]), "updatedAt": iso_timestamp(row["updated_at"])}


def _context(row):
    return {"id": row["id"], "presetId": row["preset_id"], "baseUrl": row["base_url"]}


def _selection(value):
    if value is None:
        return None
    try:
        return ModelSelection.model_validate(value).model_dump()
    except ValidationError:
        raise ControlError(422, "stored_model_selection_invalid") from None


def _employee(row):
    configuration = row["configuration"] if isinstance(row["configuration"], dict) else {}
    result = {"id": row["id"], "name": row["name"], "role": row["role"], "status": row["status"],
              "computerProfile": row["computer_profile"], "createdAt": iso_timestamp(row["created_at"])}
    appearance = configuration.get("appearance")
    if isinstance(appearance, dict):
        try:
            result["appearance"] = BotAppearance.model_validate({k: appearance.get(k) for k in BotAppearance.model_fields}).model_dump()
        except ValidationError:
            pass
    selection = _selection(configuration.get("model"))
    if selection is not None:
        result["model"] = selection
    return result


async def _audit(db, event, payload, *, bot_id=None):
    await db.execute("INSERT INTO run_events(id,bot_id,type,payload) VALUES (%s,%s,%s,%s)",
                     (str(uuid4()), bot_id, event, Jsonb(payload)))


class PostgresModelConnectionStore:
    def __init__(self, dsn, cipher: ModelCredentialCipher):
        if not isinstance(cipher, ModelCredentialCipher):
            raise ValueError("Explicit connection cipher is required.")
        self._transactions = OwnerTransactions(dsn, application_name="openbot-model-connections")
        self.cipher = cipher

    @_guard
    async def verify_schema(self):
        await self._transactions.verify_schema()
        # Trusted startup check, not an Owner-facing read or an authority substitute.
        async with PostgresTransactions(self._transactions._dsn).transaction() as db:
            await db.execute("SELECT id,name,preset_id,base_url,protocol,encrypted_api_key,enabled,"
                             "revision,created_at,updated_at FROM model_connections LIMIT 0")
            await db.execute("SELECT model_selection FROM runs LIMIT 0")

    @staticmethod
    @_guard
    async def has_any(dsn):
        # Trusted startup only: deciding whether a replacement key may be created is never HTTP.
        async with PostgresTransactions(dsn).transaction() as db:
            return (await (await db.execute("SELECT EXISTS(SELECT 1 FROM model_connections) AS present")).fetchone())["present"]

    @_guard
    async def list(self, token):
        async with self._transactions.transaction(token) as db:
            rows = await (await db.execute("SELECT * FROM model_connections ORDER BY created_at,id LIMIT 33")).fetchall()
            if len(rows) > 32:
                raise ControlError(503, "model_connection_limit")
            return [_public(row) for row in rows]

    @_guard
    async def create(self, token, value, *, policy: ConnectionPolicy):
        value = CreateModelConnectionInput.model_validate(value)
        try:
            url = policy.endpoint(value.presetId, value.baseUrl)
            protocol = policy.preset(value.presetId)["protocol"]
        except ValueError:
            raise ControlError(422, "model_endpoint_not_authorized") from None
        identity = {"id": str(uuid4()), "presetId": value.presetId, "baseUrl": url}
        encrypted = self.cipher.encrypt(value.apiKey, identity)
        async with self._transactions.transaction(token) as db:
            await db.execute("SELECT pg_advisory_xact_lock(%s,1)", (_LOCK_NAMESPACE,))
            count = (await (await db.execute("SELECT count(*) AS total FROM model_connections")).fetchone())["total"]
            if count >= 32:
                raise ControlError(422, "model_connection_limit")
            row = await (await db.execute("INSERT INTO model_connections(id,name,preset_id,base_url,protocol,encrypted_api_key) "
                "VALUES (%s,%s,%s,%s,%s,%s) RETURNING *", (identity["id"],value.name,value.presetId,url,protocol,encrypted))).fetchone()
            await _audit(db, "MODEL_CONNECTION_CREATED", {"id": row["id"], "presetId": row["preset_id"], "revision": row["revision"]})
            return _public(row)

    @_guard
    async def update(self, token, connection_id, value):
        value = UpdateModelConnectionInput.model_validate(value)
        async with self._transactions.transaction(token) as db:
            if connection_id == "legacy-kimi":
                raise ControlError(422, "environment_model_connection_read_only")
            current = await (await db.execute("SELECT * FROM model_connections WHERE id=%s FOR UPDATE", (connection_id,))).fetchone()
            if current is None:
                raise ControlError(404, "model_connection_not_found")
            if current["revision"] != value.expectedRevision:
                raise ControlError(409, "model_connection_revision_conflict")
            name = current["name"] if value.name is None else value.name
            enabled = current["enabled"] if value.enabled is None else value.enabled
            changed = (["name"] if name != current["name"] else []) + (["apiKey"] if value.apiKey is not None else []) + (["enabled"] if enabled != current["enabled"] else [])
            if not changed:
                return _public(current)
            encrypted = current["encrypted_api_key"] if value.apiKey is None else self.cipher.encrypt(value.apiKey, _context(current))
            row = await (await db.execute("UPDATE model_connections SET name=%s,enabled=%s,encrypted_api_key=%s,"
                "revision=revision+1,updated_at=clock_timestamp() WHERE id=%s AND revision=%s RETURNING *",
                (name,enabled,encrypted,connection_id,value.expectedRevision))).fetchone()
            if row is None:
                raise ControlError(409, "model_connection_revision_conflict")
            await _audit(db, "MODEL_CONNECTION_UPDATED", {"id": connection_id, "presetId": row["preset_id"], "changedFields": changed, "revision": row["revision"]})
            return _public(row)


class ModelConnectionsService:
    def __init__(self, dsn, cipher: ModelCredentialCipher, *, custom_base_urls=(), legacy_kimi=None,
                 transport_factory=None, max_output_tokens=4096, deadline_seconds=90):
        self.policy = ConnectionPolicy(custom_base_urls)
        self.store = PostgresModelConnectionStore(dsn, cipher)
        self._transactions = self.store._transactions
        self._legacy = None if legacy_kimi is None else LegacyKimiConfiguration.model_validate(legacy_kimi)
        self._started = iso_timestamp(datetime.now(timezone.utc))
        self._transport_factory = transport_factory
        if type(max_output_tokens) is not int or not 128 <= max_output_tokens <= 8192:
            raise ValueError("Invalid connection output-token bound.")
        if isinstance(deadline_seconds, bool) or not isinstance(deadline_seconds, (float,int)) or not 1 <= deadline_seconds <= 120:
            raise ValueError("Invalid connection deadline.")
        self._max_output_tokens, self._deadline = max_output_tokens, deadline_seconds
        self._operations = 0

    @classmethod
    async def from_key_path(cls, dsn, path, **options):
        cipher = ModelCredentialCipher.load(path, allow_create=not await PostgresModelConnectionStore.has_any(dsn))
        return cls(dsn, cipher, **options)

    async def verify_schema(self):
        await self.store.verify_schema()

    def _legacy_public(self):
        if self._legacy is None:
            return None
        return {"id": "legacy-kimi", "name": "服务端默认 Kimi", "presetId": "kimi",
                "baseUrl": self._legacy.baseUrl, "protocol": "openai-chat", "enabled": True,
                "hasApiKey": True, "revision": 1, "source": "environment", "defaultModel": self._legacy.modelId,
                "createdAt": self._started, "updatedAt": self._started}

    async def snapshot(self, token):
        connections = await self.store.list(token)
        legacy = self._legacy_public()
        return {"presets": connection_presets(), "connections": ([legacy] if legacy else []) + connections,
                "customBaseUrls": list(self.policy.custom_base_urls)}

    async def create(self, token, value):
        return await self.store.create(token, value, policy=self.policy)

    async def update(self, token, connection_id, value):
        return await self.store.update(token, connection_id, value)

    async def resolve_in_transaction(self, db, selection, *, expected_revision=None):
        """Internal Activity seam: caller owns authority/transaction; no network or history writes."""
        selection = _selection(selection)
        fallback = selection is None
        if fallback:
            if self._legacy is None:
                return None
            selection = {"connectionId": "legacy-kimi", "modelId": self._legacy.modelId}
        identity = selection["connectionId"]
        if identity == "legacy-kimi":
            if self._legacy is None:
                raise ControlError(404, "model_connection_not_found")
            result = ResolvedModelConnection(identity, 1, "kimi", "openai-chat", self._legacy.baseUrl,
                selection["modelId"], self._legacy.apiKey, "environment", self._legacy.reasoningEffort if fallback else None)
        else:
            row = await (await db.execute("SELECT * FROM model_connections WHERE id=%s FOR SHARE", (identity,))).fetchone()
            if row is None:
                raise ControlError(404, "model_connection_not_found")
            if not row["enabled"]:
                raise ControlError(422, "model_connection_disabled")
            try:
                url = self.policy.endpoint(row["preset_id"], row["base_url"], row["protocol"])
            except ValueError:
                raise ControlError(422, "model_endpoint_not_authorized") from None
            key = self.store.cipher.decrypt(row["encrypted_api_key"], _context(row))
            result = ResolvedModelConnection(identity, row["revision"], row["preset_id"], row["protocol"], url, selection["modelId"], key)
        if expected_revision is not None and result.revision != expected_revision:
            raise ControlError(409, "model_connection_revision_conflict")
        return result

    @_guard
    async def resolve(self, token, selection, *, expected_revision=None):
        async with self._transactions.transaction(token) as db:
            return await self.resolve_in_transaction(db, selection, expected_revision=expected_revision)

    async def validate_selection(self, token, selection):
        parsed = ModelSelection.model_validate(selection)
        await self.resolve(token, parsed.model_dump())

    @_guard
    async def update_employee_model(self, token, bot_id, value):
        value = UpdateEmployeeModelInput.model_validate(value)
        selection = None if value.model is None else value.model.model_dump()
        async with self._transactions.transaction(token) as db:
            current = await (await db.execute("SELECT * FROM bots WHERE id=%s FOR UPDATE", (bot_id,))).fetchone()
            if current is None:
                raise ControlError(404, "bot_not_found")
            if current["computer_profile"] not in ("model", "docker-linux"):
                raise ControlError(422, "employee_model_profile_required")
            if current["profile_revision"] != value.expectedRevision:
                raise ControlError(409, "employee_profile_revision_conflict")
            configuration = dict(current["configuration"]) if isinstance(current["configuration"], dict) else {}
            if _selection(configuration.get("model")) == selection:
                raise ControlError(422, "employee_model_unchanged")
            if selection is not None:
                await self.resolve_in_transaction(db, selection)
                configuration["model"] = selection
            else:
                configuration.pop("model", None)
            row = await (await db.execute("UPDATE bots SET configuration=%s,profile_revision=profile_revision+1,"
                "updated_at=clock_timestamp() WHERE id=%s AND profile_revision=%s RETURNING *",
                (Jsonb(configuration), bot_id, value.expectedRevision))).fetchone()
            if row is None:
                raise ControlError(409, "employee_profile_revision_conflict")
            evolution = await (await db.execute("INSERT INTO employee_evolution_events(id,bot_id,type,title,summary,source,evidence) "
                "VALUES (%s,%s,'configuration_changed','Employee model updated',"
                "'Owner updated the model connection and model selection.','manual','[]') RETURNING *", (str(uuid4()),bot_id))).fetchone()
            await _audit(db, "EMPLOYEE_MODEL_UPDATED", {"changedFields": ["model"], "revision": row["profile_revision"]}, bot_id=bot_id)
            return {"employee": _employee(row), "details": {"description": row["description"], "revision": row["profile_revision"], "updatedAt": iso_timestamp(row["updated_at"])},
                    "evolution": {"id": evolution["id"], "botId": bot_id, "type": "configuration_changed", "title": evolution["title"],
                                  "summary": evolution["summary"], "source": "manual", "evidence": [], "createdAt": iso_timestamp(evolution["created_at"])}}

    async def in_transaction(self, db, bot_id):
        """Snapshot seam for root task/automation INSERT in the same authorized transaction.

        Returns only selection or None. Caller inserts it as runs.model_selection, without
        backfilling from future Bot changes. Disabled selections are retained and fail at resolve.
        """
        row = await (await db.execute("SELECT computer_profile,configuration FROM bots WHERE id=%s FOR SHARE", (bot_id,))).fetchone()
        if row is None:
            raise ControlError(404, "bot_not_found")
        if row["computer_profile"] != "model":
            return None
        configuration = row["configuration"] if isinstance(row["configuration"], dict) else {}
        return _selection(configuration.get("model"))

    async def _live(self, token, resolved):
        current = await self.resolve(token, {"connectionId": resolved.connection_id, "modelId": resolved.model_id}, expected_revision=resolved.revision)
        if (current.provenance() != resolved.provenance() or not hmac.compare_digest(current.api_key, resolved.api_key)):
            raise ControlError(409, "model_connection_revision_conflict")

    @asynccontextmanager
    async def _bounded(self):
        if self._operations >= 2:
            raise ControlError(422, "model_connection_checks_busy")
        self._operations += 1
        try:
            yield
        finally:
            self._operations -= 1

    def _transport(self):
        result = self._transport_factory() if self._transport_factory is not None else httpx2.AsyncHTTPTransport(retries=0, trust_env=False)
        if not isinstance(result, httpx2.AsyncBaseTransport):
            raise ControlError(503, "model_connection_transport_unavailable")
        return result

    async def discover(self, token, connection_id):
        async with self._bounded():
            selected = await self.resolve(token, {"connectionId": connection_id, "modelId": "unused"})
            if not self.policy.preset(selected.preset_id)["discovery"]:
                raise ControlError(422, "model_discovery_not_supported")
            query = "?limit=256" if selected.protocol == "anthropic-messages" else "?output_modalities=text" if selected.preset_id == "openrouter" else "?type=text&sub_type=chat" if selected.preset_id == "siliconflow" else ""
            suffix = "/v1/models" if selected.protocol == "anthropic-messages" else "/models"
            headers = {"Accept": "application/json", "Accept-Encoding": "identity"}
            headers.update({"x-api-key": selected.api_key, "anthropic-version": "2023-06-01"} if selected.protocol == "anthropic-messages" else {"Authorization": "Bearer " + selected.api_key})
            try:
                async with asyncio.timeout(self._deadline), httpx2.AsyncClient(transport=self._transport(), trust_env=False,
                        follow_redirects=False, timeout=self._deadline) as client:
                    await self._live(token, selected)
                    async with client.stream("GET", selected.base_url + suffix + query, headers=headers) as response:
                        if response.status_code in (401,403):
                            raise ControlError(422, "model_credentials_invalid")
                        if (not 200 <= response.status_code < 300 or "application/json" not in response.headers.get("content-type", "").lower()
                                or response.headers.get("content-encoding", "identity").lower() != "identity"):
                            raise ControlError(422, "model_provider_unavailable")
                        limit = 2 * 1024 * 1024
                        length = response.headers.get("content-length")
                        if length is not None and (not length.isdigit() or int(length) > limit):
                            raise ControlError(422, "model_provider_unavailable")
                        body = bytearray()
                        if response.is_stream_consumed:
                            if len(response.content) > limit:
                                raise ControlError(422, "model_provider_unavailable")
                            body.extend(response.content)
                        else:
                            async for chunk in response.aiter_raw():
                                if len(body) + len(chunk) > limit:
                                    raise ControlError(422, "model_provider_unavailable")
                                body.extend(chunk)
                    value = json.loads(body, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
                    if not isinstance(value, dict) or not isinstance(value.get("data"), list):
                        raise ValueError()
                    found = {}
                    for item in value["data"]:
                        if len(found) >= 256:
                            break
                        try:
                            identity = model_id(item.get("id") if isinstance(item, dict) else None)
                        except ValueError:
                            continue
                        if selected.api_key not in identity:
                            found[identity] = None
                    await self._live(token, selected)
                    return list(found)
            except (httpx2.HTTPError, TimeoutError, ValueError, UnicodeError):
                raise ControlError(422, "model_provider_unavailable") from None

    async def test(self, token, connection_id, value):
        """Explicit Owner inference probe, one bounded step, no tools or fallback.

        Root may wrap this method in durable probe admission; nothing is scheduled implicitly.
        Authorization and connection revision are rechecked immediately before send and return.
        """
        from openbot_agent_runtime.contracts import ModelStepRequest
        from pydantic_ai.messages import ModelRequest, UserPromptPart
        from .model_connections_port import ModelConnectionPort
        from .product_model import ProductModelError
        value = TestModelConnectionInput.model_validate(value)
        async with self._bounded():
            selected = await self.resolve(token, {"connectionId": connection_id, "modelId": value.modelId})
            try:
                async with ModelConnectionPort(selected, policy=self.policy, max_output_tokens=self._max_output_tokens,
                    deadline_seconds=self._deadline, transport=self._transport(), before_send=lambda: self._live(token, selected)) as port:
                    await port(ModelStepRequest(step=1, messages=(ModelRequest(parts=[UserPromptPart("Reply with OK.")]),), tools=()))
                await self._live(token, selected)
                return {"ok": True}
            except ProductModelError:
                # A gate failure may be wrapped by the SDK. Preserve the current authority/state
                # classification without exposing the original exception or performing another send.
                await self._live(token, selected)
                raise ControlError(422, "model_provider_unavailable") from None
