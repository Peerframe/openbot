"""Feature-source model connection DTOs (OpenBot MIT, 9cc73c9).

The singleton settings DTO is intentionally separate: connection model IDs, credentials,
protocols and integer revisions have different retained contracts.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
import re
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, field_validator, model_validator

from .identity_inputs import _ECMASCRIPT_WHITESPACE
from .model_presets import model_provider_presets
from .profile_details import ExpectedRevision


def _trim(value):
    return value.strip(_ECMASCRIPT_WHITESPACE) if isinstance(value, str) else value


def model_id(value):
    value = _trim(value)
    if type(value) is not str or not 1 <= len(value) <= 256 or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/@+-]*", value) is None:
        raise ValueError("Invalid model ID.")
    return value


def api_key(value):
    value = _trim(value)
    if type(value) is not str or not 1 <= len(value) <= 2048 or re.fullmatch(r"[\x21-\x7e]+", value) is None:
        raise ValueError("Invalid API key.")
    return value


def base_url(value):
    if type(value) is not str or len(value) > 2048 or re.fullmatch(r"https://[^/?#@\\]+(?:/[^?#\\]*)?", value) is None:
        raise ValueError("Invalid API base URL.")
    parsed = urlsplit(value)
    if (not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment
            or any(ord(c) <= 32 or ord(c) == 127 for c in value)):
        raise ValueError("Invalid API base URL.")
    try:
        parsed.port
    except ValueError:
        raise ValueError("Invalid API base URL.") from None
    return value


def _name(value):
    value = _trim(value)
    if type(value) is not str or not 1 <= len(value.encode("utf-16-le")) // 2 <= 80:
        raise ValueError("Invalid connection name.")
    return value


ModelId = Annotated[str, BeforeValidator(model_id)]
ApiKey = Annotated[str, BeforeValidator(api_key)]
BaseUrl = Annotated[str, BeforeValidator(base_url)]
ConnectionId = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")]
Protocol = Literal["openai-chat", "anthropic-messages"]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, revalidate_instances="always", hide_input_in_errors=True)


class ModelSelection(Input):
    connectionId: ConnectionId
    modelId: ModelId


class CreateModelConnectionInput(Input):
    name: Annotated[str, BeforeValidator(_name)]
    presetId: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9-]+$")
    baseUrl: BaseUrl
    apiKey: ApiKey = Field(repr=False)


class UpdateModelConnectionInput(Input):
    expectedRevision: ExpectedRevision
    name: Annotated[str, BeforeValidator(_name)] | None = None
    apiKey: ApiKey | None = Field(default=None, repr=False)
    enabled: bool | None = None

    @field_validator("name", "apiKey", "enabled", mode="before")
    @classmethod
    def no_null(cls, value):
        if value is None:
            raise ValueError("Explicit null is not an omission.")
        return value

    @model_validator(mode="after")
    def changed(self):
        if not {"name", "apiKey", "enabled"}.intersection(self.model_fields_set):
            raise ValueError("Change at least one connection field.")
        return self


class UpdateEmployeeModelInput(Input):
    expectedRevision: ExpectedRevision
    model: ModelSelection | None


class TestModelConnectionInput(Input):
    modelId: ModelId


def connection_presets():
    presets = model_provider_presets()
    for preset in presets:
        if preset["id"] == "moonshot":
            preset["id"] = "kimi"
    presets.append({"id": "custom", "name": "Custom OpenAI-compatible API / 自定义兼容 API",
        "protocol": "openai-chat", "endpoints": [], "suggestedModels": [], "discovery": True,
        "description": "Use an exact HTTPS endpoint authorized by the Server operator.",
        "docsUrl": "https://developers.openai.com/api/reference/resources/chat/subresources/completions"})
    return presets


class ConnectionPolicy:
    """An explicit immutable operator allowlist; a URL in an HTTP body grants nothing."""
    def __init__(self, custom_base_urls=()):
        if not isinstance(custom_base_urls, (list, tuple)) or len(custom_base_urls) > 128:
            raise ValueError("Invalid custom endpoint configuration.")
        self.custom_base_urls = tuple(dict.fromkeys(base_url(url).rstrip("/") for url in custom_base_urls))
        self._presets = {item["id"]: item for item in connection_presets()}

    def preset(self, preset_id):
        if preset_id not in self._presets:
            raise ValueError("Unknown model preset.")
        return deepcopy(self._presets[preset_id])

    def endpoint(self, preset_id, value, protocol=None):
        preset = self.preset(preset_id)
        if protocol is not None and protocol != preset["protocol"]:
            raise ValueError("Connection protocol does not match its preset.")
        value = base_url(value).rstrip("/")
        allowed = self.custom_base_urls if preset_id == "custom" else tuple(e["baseUrl"].rstrip("/") for e in preset["endpoints"])
        if value not in allowed:
            raise ValueError("Model endpoint is not authorized.")
        return value


class LegacyKimiConfiguration(Input):
    """Trusted startup-only source configuration; this module never consults os.environ."""
    apiKey: ApiKey = Field(repr=False, max_length=512)
    baseUrl: Literal["https://api.moonshot.cn/v1", "https://api.moonshot.ai/v1"] = "https://api.moonshot.cn/v1"
    modelId: str = Field(default="kimi-k3", min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9._-]+$")
    reasoningEffort: Literal["low", "high", "max"] = "low"


@dataclass(frozen=True)
class ResolvedModelConnection:
    connection_id: str
    revision: int
    preset_id: str
    protocol: str
    base_url: str
    model_id: str
    api_key: str = field(repr=False)
    source: str = "saved"
    reasoning_effort: str | None = None

    def provenance(self):
        return {"connectionId": self.connection_id, "connectionRevision": self.revision,
                "presetId": self.preset_id, "protocol": self.protocol, "baseUrl": self.base_url,
                "modelId": self.model_id, "source": self.source}
