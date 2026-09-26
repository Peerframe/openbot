"""The complete migrated provider/input contract, without provider credentials or I/O."""
import pytest
from pydantic import ValidationError

from openbot_server.model_presets import (
    MODEL_PROVIDER_IDS, RetainedModelSettings, model_provider_base_url, model_provider_preset,
    model_provider_presets, parse_model_discovery, parse_model_settings,
)

INPUT = {"provider": "openai", "model": "fixture-model", "apiKey": "fixture-not-real-key", "revision": None}
REVISION = "12345678-1234-4234-8234-123456789012"


def test_all_eleven_presets_preserve_exact_endpoints_and_public_dto():
    expected = {
        "openai": ["https://api.openai.com/v1"],
        "anthropic": ["https://api.anthropic.com"],
        "gemini": ["https://generativelanguage.googleapis.com/v1beta/openai"],
        "deepseek": ["https://api.deepseek.com"],
        "moonshot": ["https://api.moonshot.cn/v1", "https://api.moonshot.ai/v1"],
        "openrouter": ["https://openrouter.ai/api/v1"],
        "siliconflow": ["https://api.siliconflow.cn/v1", "https://api.siliconflow.com/v1"],
        "dashscope": ["https://dashscope.aliyuncs.com/compatible-mode/v1", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "https://dashscope-us.aliyuncs.com/compatible-mode/v1"],
        "zai": ["https://open.bigmodel.cn/api/paas/v4", "https://api.z.ai/api/paas/v4"],
        "minimax": ["https://api.minimax.cn/v1", "https://api.minimax.io/v1"],
        "ark": ["https://ark.cn-beijing.volces.com/api/v3"],
    }
    presets = model_provider_presets()
    assert tuple(p["id"] for p in presets) == MODEL_PROVIDER_IDS == tuple(expected)
    for preset in presets:
        assert set(preset) == {"id", "name", "protocol", "endpoints", "suggestedModels", "discovery", "description", "docsUrl"}
        assert [p["baseUrl"] for p in preset["endpoints"]] == expected[preset["id"]]
        assert preset["discovery"] == (preset["id"] not in {"ark", "zai", "dashscope"})
        assert model_provider_base_url(preset["id"]) == expected[preset["id"]][0]
        for url in expected[preset["id"]]:
            assert model_provider_base_url(preset["id"], url) == url
    presets[0]["endpoints"][0]["baseUrl"] = "https://untrusted.invalid"
    assert model_provider_base_url("openai") == expected["openai"][0]


@pytest.mark.parametrize("url", [
    "https://evil.example/v1", "https://api.moonshot.cn/v1", "https://api.openai.com/v1/",
    "https://API.openai.com/v1", "http://api.openai.com/v1", "https://api.openai.com/v1?key=x",
    "https://api.openai.com:443/v1", "https://api.openai.com/v1#fragment", "",
])
def test_endpoint_is_exact_allowlist(url):
    with pytest.raises(ValidationError):
        parse_model_settings({**INPUT, "baseUrl": url})


@pytest.mark.parametrize("model", [
    "https://other.example/x", "a/../b", "a//b", "a/b?key=value", "a/b#fragment",
    "~openai/latest", "a/b/c", "a/%2f", "a\\b", "a b", "", "a" * 129,
])
def test_model_path_substitution_is_rejected(model):
    with pytest.raises(ValidationError):
        parse_model_settings({**INPUT, "provider": "openrouter", "model": model})


@pytest.mark.parametrize("provider", ["openai", "anthropic", "moonshot", "deepseek"])
def test_direct_provider_rejects_qualified_slug(provider):
    with pytest.raises(ValidationError):
        parse_model_settings({**INPUT, "provider": provider, "model": "vendor/model"})


@pytest.mark.parametrize("override", [
    {"unexpected": True}, {"baseUrl": None}, {"provider": "unknown"}, {"model": None},
    {"agentEnabled": None}, {"agentEnabled": 1}, {"apiKey": "a" * 15}, {"apiKey": "a" * 513},
    {"apiKey": " " + "a" * 20}, {"apiKey": "a" * 20 + "\n"}, {"apiKey": "a" * 20 + "é"},
    {"revision": "12345678-1234-9234-8234-123456789012"}, {"revision": "not-a-uuid"},
    {"model": "\u0085fixture-model\u0085"},
])
def test_strict_input_and_ecmascript_trim_boundaries(override):
    with pytest.raises(ValidationError):
        parse_model_settings({**INPUT, **override})


def test_defaults_uuid_spelling_and_retained_activation_compatibility():
    parsed = parse_model_settings({**INPUT, "model": "\ufeff fixture-model\u2029"})
    assert parsed.model == "fixture-model" and parsed.agentEnabled is False
    assert parsed.baseUrl is None and parsed.revision is None
    parsed = parse_model_settings({**INPUT, "provider": "openrouter", "model": "vendor/model@v1+fast:free"})
    assert parsed.model == "vendor/model@v1+fast:free"
    for revision in (REVISION.upper(), "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"):
        assert parse_model_settings({**INPUT, "revision": revision}).revision == revision
    retained = RetainedModelSettings.model_validate({**INPUT, "revision": REVISION})
    assert retained.agentEnabledAt is None
    with pytest.raises(ValidationError):
        RetainedModelSettings.model_validate({**INPUT, "revision": None})
    for timestamp in ("2026-09-24T12:30:00.000Z", "2026-09-24T12:30Z"):
        assert RetainedModelSettings.model_validate({**INPUT, "revision": REVISION, "agentEnabledAt": timestamp}).agentEnabledAt == timestamp
    for timestamp in ("2026-02-30T00:00:00Z", "2026-09-24T00:00:00+00:00", "2026-09-24"):
        with pytest.raises(ValidationError):
            RetainedModelSettings.model_validate({**INPUT, "revision": REVISION, "agentEnabledAt": timestamp})


def test_discovery_rejects_extra_settings_and_explicit_null():
    assert parse_model_discovery({"provider": "openai", "apiKey": INPUT["apiKey"]}).provider == "openai"
    for extra in ({"model": "fixture"}, {"revision": None}, {"baseUrl": None}):
        with pytest.raises(ValidationError):
            parse_model_discovery({"provider": "openai", "apiKey": INPUT["apiKey"], **extra})
    with pytest.raises(ValueError):
        model_provider_preset("unknown")
