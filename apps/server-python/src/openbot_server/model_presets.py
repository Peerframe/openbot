"""OpenBot's eleven reviewed provider presets and strict settings inputs.

This translates the project's MIT model-providers.ts/model-settings.ts contracts. Endpoint
selection is an exact allowlist, never a URL supplied directly to a provider client.
"""
from copy import deepcopy
from datetime import datetime
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.json_schema import SkipJsonSchema

from .identity_inputs import ChannelBotId, _ECMASCRIPT_WHITESPACE, _omit_default

ModelProviderId = Literal[
    "openai", "anthropic", "gemini", "deepseek", "moonshot", "openrouter",
    "siliconflow", "dashscope", "zai", "minimax", "ark",
]
MODEL_PROVIDER_IDS = (
    "openai", "anthropic", "gemini", "deepseek", "moonshot", "openrouter",
    "siliconflow", "dashscope", "zai", "minimax", "ark",
)
MODEL_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:@+-]*(?:/[A-Za-z0-9][A-Za-z0-9._:@+-]*)?")

_PRESETS: tuple[dict[str, Any], ...] = (
    {
        "id": "openai", "name": "OpenAI", "protocol": "openai-chat",
        "endpoints": [{"name": "Global", "baseUrl": "https://api.openai.com/v1"}],
        "suggestedModels": ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna"],
        "discovery": True, "description": "GPT models through the standard OpenAI API.",
        "docsUrl": "https://developers.openai.com/api/docs/models",
    },
    {
        "id": "anthropic", "name": "Anthropic / Claude", "protocol": "anthropic-messages",
        "endpoints": [{"name": "Global", "baseUrl": "https://api.anthropic.com"}],
        "suggestedModels": ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5-20251001"],
        "discovery": True, "description": "Claude models through the native Messages API.",
        "docsUrl": "https://platform.claude.com/docs/en/models/overview",
    },
    {
        "id": "gemini", "name": "Google Gemini", "protocol": "openai-chat",
        "endpoints": [{"name": "Global", "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai"}],
        "suggestedModels": ["gemini-3.8-flash", "gemini-3.5-flash-lite"],
        "discovery": True, "description": "Gemini text chat through Google's beta OpenAI compatibility API.",
        "docsUrl": "https://ai.google.dev/gemini-api/docs/openai",
    },
    {
        "id": "deepseek", "name": "DeepSeek", "protocol": "openai-chat",
        "endpoints": [{"name": "Standard API", "baseUrl": "https://api.deepseek.com"}],
        "suggestedModels": ["deepseek-v4-flash", "deepseek-v4-pro"],
        "discovery": True, "description": "DeepSeek models through its standard API.",
        "docsUrl": "https://api-docs.deepseek.com/",
    },
    {
        "id": "moonshot", "name": "Kimi / Moonshot", "protocol": "openai-chat",
        "endpoints": [
            {"name": "China", "baseUrl": "https://api.moonshot.cn/v1"},
            {"name": "Global", "baseUrl": "https://api.moonshot.ai/v1"},
        ],
        "suggestedModels": ["kimi-k2.6", "kimi-k3", "kimi-k2.7-code"],
        "discovery": True, "description": "Choose the region that issued your Moonshot API key.",
        "docsUrl": "https://platform.kimi.ai/docs/models",
    },
    {
        "id": "openrouter", "name": "OpenRouter", "protocol": "openai-chat",
        "endpoints": [{"name": "Global", "baseUrl": "https://openrouter.ai/api/v1"}],
        "suggestedModels": [], "discovery": True,
        "description": "Discover text model IDs, or enter a specific model from the provider catalog.",
        "docsUrl": "https://openrouter.ai/docs/quickstart",
    },
    {
        "id": "siliconflow", "name": "SiliconFlow / 硅基流动", "protocol": "openai-chat",
        "endpoints": [
            {"name": "China", "baseUrl": "https://api.siliconflow.cn/v1"},
            {"name": "Global", "baseUrl": "https://api.siliconflow.com/v1"},
        ],
        "suggestedModels": [], "discovery": True,
        "description": "Discover text chat models using the region that issued your API key.",
        "docsUrl": "https://docs.siliconflow.cn/docs/userguide/quickstart",
    },
    {
        "id": "dashscope", "name": "Alibaba Cloud Model Studio / 阿里云百炼", "protocol": "openai-chat",
        "endpoints": [
            {"name": "China", "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1"},
            {"name": "International", "baseUrl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"},
            {"name": "US", "baseUrl": "https://dashscope-us.aliyuncs.com/compatible-mode/v1"},
        ],
        "suggestedModels": ["qwen3.8-max"], "discovery": False,
        "description": "Select your API key's region and enter a model enabled in that workspace.",
        "docsUrl": "https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope",
    },
    {
        "id": "zai", "name": "Zhipu / Z.AI / 智谱", "protocol": "openai-chat",
        "endpoints": [
            {"name": "China", "baseUrl": "https://open.bigmodel.cn/api/paas/v4"},
            {"name": "Global", "baseUrl": "https://api.z.ai/api/paas/v4"},
        ],
        "suggestedModels": ["glm-5.3", "glm-4.7-flash"], "discovery": False,
        "description": "Standard GLM API access; model IDs and API keys depend on the region.",
        "docsUrl": "https://docs.z.ai/api-reference/llm/chat-completion",
    },
    {
        "id": "minimax", "name": "MiniMax", "protocol": "openai-chat",
        "endpoints": [
            {"name": "China", "baseUrl": "https://api.minimax.cn/v1"},
            {"name": "Global", "baseUrl": "https://api.minimax.io/v1"},
        ],
        "suggestedModels": ["MiniMax-M3", "MiniMax-M2.7"], "discovery": True,
        "description": "MiniMax text chat with reasoning kept separate from the visible answer.",
        "docsUrl": "https://platform.minimax.io/docs/api-reference/text-openai-api",
    },
    {
        "id": "ark", "name": "Volcengine Ark / 火山方舟", "protocol": "openai-chat",
        "endpoints": [{"name": "Beijing", "baseUrl": "https://ark.cn-beijing.volces.com/api/v3"}],
        "suggestedModels": [], "discovery": False,
        "description": "Enter the inference endpoint or model ID enabled in your Ark account.",
        "docsUrl": "https://www.volcengine.com/docs/82379/1330310",
    },
)


def model_provider_presets() -> list[dict[str, Any]]:
    """Return independent public DTOs so a caller cannot mutate the endpoint allowlist."""
    return deepcopy(list(_PRESETS))


def model_provider_preset(provider: str) -> dict[str, Any]:
    for preset in _PRESETS:
        if preset["id"] == provider:
            return deepcopy(preset)
    raise ValueError("Unknown model provider.")


def model_provider_base_url(provider: str, base_url: str | None = None) -> str:
    preset = model_provider_preset(provider)
    endpoint = preset["endpoints"][0]["baseUrl"] if base_url is None else base_url
    if not any(item["baseUrl"] == endpoint for item in preset["endpoints"]):
        raise ValueError("Unapproved model endpoint.")
    return endpoint


class ModelDiscoveryInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, revalidate_instances="always")
    provider: ModelProviderId
    baseUrl: str | SkipJsonSchema[None] = Field(default=None, max_length=512, json_schema_extra=_omit_default)
    apiKey: str = Field(min_length=16, max_length=512, repr=False)

    @field_validator("baseUrl", mode="before")
    @classmethod
    def _base_url_not_null(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("Explicit null is not an omission.")
        return value

    @field_validator("apiKey")
    @classmethod
    def _api_key(cls, value: str) -> str:
        if re.fullmatch(r"[\x21-\x7e]+", value) is None:
            raise ValueError("Invalid API key.")
        return value

    @model_validator(mode="after")
    def _endpoint(self) -> "ModelDiscoveryInput":
        model_provider_base_url(self.provider, self.baseUrl)
        return self


class ModelSettingsInput(ModelDiscoveryInput):
    model: str
    revision: ChannelBotId | None
    agentEnabled: bool = False

    @field_validator("model")
    @classmethod
    def _model_id(cls, value: str) -> str:
        value = value.strip(_ECMASCRIPT_WHITESPACE)
        if not 1 <= len(value) <= 128 or MODEL_ID_PATTERN.fullmatch(value) is None:
            raise ValueError("Invalid model ID.")
        return value

    @model_validator(mode="after")
    def _provider_model(self) -> "ModelSettingsInput":
        if (self.provider == "openrouter" and "/" not in self.model) or (
            self.provider in {"openai", "anthropic", "moonshot", "deepseek"} and "/" in self.model
        ):
            raise ValueError("Invalid model ID for the selected provider.")
        return self


class RetainedModelSettings(ModelSettingsInput):
    revision: ChannelBotId
    agentEnabledAt: str | None = None

    @field_validator("agentEnabledAt")
    @classmethod
    def _timestamp(cls, value: str | None) -> str | None:
        if value is not None:
            if re.fullmatch(r"\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?Z", value) is None:
                raise ValueError("Invalid activation timestamp.")
            datetime.fromisoformat(value)
        return value


def parse_model_settings(value: object) -> ModelSettingsInput:
    return ModelSettingsInput.model_validate(value)


def parse_model_discovery(value: object) -> ModelDiscoveryInput:
    return ModelDiscoveryInput.model_validate(value)
