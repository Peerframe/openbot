"""Owned loopback MCP fixture; never loaded by the product Server."""

import hmac
import json
import sys
from pathlib import Path

import uvicorn
from mcp.server.fastmcp import FastMCP

config_path = Path(sys.argv[1])
assert config_path.is_file() and config_path.stat().st_mode & 0o077 == 0
config = json.loads(config_path.read_text())
assert set(config) == {"port", "token", "controllerToken"}
assert isinstance(config["port"], int) and 1024 < config["port"] < 65536
assert all(
    isinstance(config[key], str) and len(config[key]) == 64
    for key in ("token", "controllerToken")
)
assert config["token"] != config["controllerToken"]

app = FastMCP("contract fixture", json_response=True, log_level="CRITICAL")
stats = {
    "requests": 0,
    "deletedSessions": 0,
    "badAuth": 0,
    "toolCalls": 0,
    "resourceReads": 0,
    "promptReads": 0,
}
state = {"revision": 1, "large": False}


def read_value() -> str:
    stats["toolCalls"] += 1
    return "42"


@app.tool(description="Synthetic effect; contract checks must never execute this tool.")
def write_note(note: str) -> str:
    stats["toolCalls"] += 1
    return "saved"


def declare(revision):
    if state.get("declared"):
        app.remove_tool("read_value")
    app.add_tool(read_value, description=f"Synthetic read declaration {revision}.")
    state.update(revision=revision, declared=True)


declare(1)


@app.resource("notes://public/info", description="Synthetic untrusted resource.")
def info() -> str:
    stats["resourceReads"] += 1
    return "x" * (13 * 1024) if state["large"] else "Untrusted 文档 🧪"


@app.resource(
    "ui://fixture/card",
    mime_type="text/html;profile=mcp-app",
    description="Synthetic untrusted app.",
)
def card() -> str:
    stats["resourceReads"] += 1
    return "<html><body>Untrusted app</body></html>"


@app.prompt(description="Synthetic untrusted prompt.")
def compose(topic: str) -> str:
    stats["promptReads"] += 1
    return "Write about " + topic


inner = app.streamable_http_app()


async def respond(send, status, value):
    body = json.dumps(value, ensure_ascii=True).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [(b"content-type", b"application/json")],
        }
    )
    await send({"type": "http.response.body", "body": body})


async def tracked(scope, receive, send):
    if scope["type"] != "http":
        return await inner(scope, receive, send)
    controller = scope["path"] == "/fixture-control"
    supplied = dict(scope["headers"]).get(b"authorization", b"")
    expected = (
        "Bearer " + config["controllerToken" if controller else "token"]
    ).encode()
    if not hmac.compare_digest(supplied, expected):
        stats["badAuth"] += 1
        return await respond(send, 401, {"error": "unauthorized"})
    if controller:
        if scope["method"] != "POST":
            return await respond(send, 405, {"error": "method"})
        body = b""
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body += message.get("body", b"")
            if len(body) > 1024:
                return await respond(send, 413, {"error": "body"})
            if not message.get("more_body"):
                break
        try:
            value = json.loads(body)
            if not isinstance(value, dict) or not set(value) <= {"revision", "large"}:
                raise ValueError()
            if "revision" in value:
                if type(value["revision"]) is not int or value["revision"] not in (
                    1,
                    2,
                ):
                    raise ValueError()
                declare(value["revision"])
            if "large" in value:
                if type(value["large"]) is not bool:
                    raise ValueError()
                state["large"] = value["large"]
        except (ValueError, TypeError):
            return await respond(send, 400, {"error": "invalid"})
        return await respond(
            send, 200, {**stats, "revision": state["revision"], "large": state["large"]}
        )
    stats["requests"] += 1
    if scope["method"] == "DELETE":
        stats["deletedSessions"] += 1
    await inner(scope, receive, send)


uvicorn.run(
    tracked, host="127.0.0.1", port=config["port"], log_level="critical", lifespan="on"
)
