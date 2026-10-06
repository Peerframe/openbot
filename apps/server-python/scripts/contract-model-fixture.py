"""Real product entry with synthetic provider transports, never a production configuration.

Only existing trusted constructor seams change. No public route/header can select this fixture;
the owned driver starts this entry in an empty disposable database with an allowlisted environment.
Receipts contain bounded counts, never credentials, prompts, provider bodies or user identifiers.
"""

import json
import runpy
import sys
from pathlib import Path

import httpx2

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from openbot_server import model_connections

receipt_path = Path(sys.argv[1])
assert len(sys.argv) == 2 and receipt_path.is_absolute()
assert receipt_path.is_file() and receipt_path.stat().st_mode & 0o077 == 0
stats = {"discovery": 0, "probes": 0, "refused": 0, "modes": {}}


def handler(request):
    endpoint = (request.url.host, request.url.path, request.method)
    allowed = {
        ("api.openai.com", "/v1/models", "GET"),
        ("api.openai.com", "/v1/chat/completions", "POST"),
        ("api.anthropic.com", "/v1/models", "GET"),
        ("api.anthropic.com", "/v1/messages", "POST"),
    }
    credential = request.headers.get("x-api-key") or request.headers.get(
        "authorization", ""
    ).removeprefix("Bearer ")
    mode = credential.removeprefix("synthetic-contract-")
    modes = {
        "success",
        "credentials",
        "redirect",
        "invalid-json",
        "oversize",
        "failure",
    }
    if (
        endpoint not in allowed
        or request.url.scheme != "https"
        or request.url.port not in (None, 443)
        or mode not in modes
    ):
        stats["refused"] += 1
        receipt_path.write_text(json.dumps(stats))
        return httpx2.Response(403)
    stats["discovery" if request.method == "GET" else "probes"] += 1
    stats["modes"][mode] = stats["modes"].get(mode, 0) + 1
    assert stats["discovery"] + stats["probes"] <= 100
    receipt_path.write_text(json.dumps(stats))
    if mode == "credentials":
        return httpx2.Response(
            401, json={"error": {"message": "Synthetic private provider diagnostic"}}
        )
    if mode == "redirect":
        return httpx2.Response(
            302, headers={"location": "https://foreign.invalid/private"}
        )
    if mode == "invalid-json":
        return httpx2.Response(
            200,
            headers={"content-type": "application/json"},
            content=b"Synthetic private provider diagnostic",
        )
    if mode == "oversize":
        return httpx2.Response(
            200,
            headers={
                "content-type": "application/json",
                "content-length": str(2 * 1024 * 1024 + 1),
            },
            content=b"{}",
        )
    if mode == "failure":
        return httpx2.Response(
            503, json={"error": {"message": "Synthetic private provider diagnostic"}}
        )
    if request.method == "GET":
        if request.url.host == "api.anthropic.com":
            assert (
                request.url.query == b"limit=256"
                and request.headers["anthropic-version"] == "2023-06-01"
            )
        else:
            assert not request.url.query
        return httpx2.Response(
            200,
            json={
                "data": [
                    None,
                    {"id": "bad space"},
                    {"id": " contract/model "},
                    {"id": "contract/model"},
                    {"id": credential},
                    *({"id": f"model-{index}"} for index in range(300)),
                ]
            },
        )
    body = json.loads(request.content)
    assert not body.get("tools") and body["model"] == "contract/model"
    assert len(body["messages"]) == 1 and body["messages"][0]["role"] == "user"
    prompt = body["messages"][0]["content"]
    if isinstance(prompt, list):
        assert len(prompt) == 1 and prompt[0]["type"] == "text"
        prompt = prompt[0]["text"]
    assert prompt == "Reply with OK."
    if request.url.host == "api.anthropic.com":
        return httpx2.Response(
            200,
            json={
                "id": "contract-message",
                "type": "message",
                "role": "assistant",
                "model": body["model"],
                "content": [{"type": "text", "text": "OK"}],
                "stop_reason": "end_turn",
                "stop_sequence": None,
                "usage": {"input_tokens": 10, "output_tokens": 4},
            },
        )
    return httpx2.Response(
        200,
        json={
            "id": "contract-chat",
            "object": "chat.completion",
            "created": 1,
            "model": body["model"],
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": "OK"},
                }
            ],
            "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14},
        },
    )


class ContractModelConnections(model_connections.ModelConnectionsService):
    def __init__(self, *args, **options):
        assert "transport_factory" not in options
        super().__init__(
            *args, transport_factory=lambda: httpx2.MockTransport(handler), **options
        )


model_connections.ModelConnectionsService = ContractModelConnections
runpy.run_path(str(Path(__file__).with_name("serve.py")), run_name="__main__")
