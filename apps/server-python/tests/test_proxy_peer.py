"""Private proxy metadata changes network context, never Owner authority."""
import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock
from urllib.parse import urlunsplit

import pytest
from fastapi.testclient import TestClient
from openbot_server.app import create_app
from openbot_server.auth import AttemptResult, OwnerAuthentication, client_digest
from openbot_server.database import ReadResult
from openbot_server.proxy_peer import PrivateProxyPeer


def request(*, client=("127.0.0.1", 4000), headers=None, kind="http"):
    return {"type": kind, "client": client, "headers": headers if headers is not None else
            [(b"forwarded", b'for="[2001:db8::1]"'), (b"host", b"private.invalid")],
            "scheme": "http", "server": ("127.0.0.1", 3102), "method": "GET", "path": "/health"}


def run(scope):
    captured = []
    messages = []

    async def downstream(scope, receive, send):
        captured.append(scope)

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        messages.append(message)

    app = PrivateProxyPeer(downstream, address="127.0.0.1", public_origin="https://public.example:8443")
    asyncio.run(app(scope, receive, send))
    return captured, messages


def test_peer_context_and_private_node_source():
    original = request()
    captured, messages = run(original)
    assert not messages
    scope = captured[0]
    assert scope["client"] == ("2001:db8::1", 0)
    assert scope["scheme"] == "https"
    assert scope["server"] == ("public.example", 8443)
    assert scope["headers"] == [(b"host", b"public.example:8443")]
    assert scope["openbot.proxy_client"] == {"digest": client_digest("2001:db8::1"), "source": "forwarded"}
    assert original["client"] == ("127.0.0.1", 4000)
    captured, _ = run(request(kind="websocket"))
    assert captured[0]["scheme"] == "wss"


@pytest.mark.parametrize("scope", [
    request(client=None), request(client=("127.0.0.2", 4000)),
    request(headers=[]), request(headers=[(b"forwarded", b"for=unknown")]),
    request(headers=[(b"forwarded", b"for=127.0.0.2"), (b"forwarded", b"for=127.0.0.3")]),
    request(headers=[(b"forwarded", b"for=127.0.0.2,for=127.0.0.3")]),
    request(headers=[(b"forwarded", b"for=127.0.0.2:42")]),
    request(headers=[(b"forwarded", b"for=127.0.0.2;for=127.0.0.3")]),
    request(headers=[(b"forwarded", b"for=" + b"1" * 256)]),
    request(headers=[(b"forwarded", b"for=\xff")]),
])
def test_metadata_fails_closed(scope):
    captured, messages = run(scope)
    assert not captured
    assert messages[0]["status"] == 400
    assert b"Invalid proxy peer metadata." in messages[1]["body"]
    scope["type"] = "websocket"
    captured, messages = run(scope)
    assert not captured
    assert messages == [{"type": "websocket.close", "code": 1008}]


@pytest.mark.parametrize("address,origin", [
    ("localhost", "https://public.example"), ("192.0.2.1", "https://public.example"),
    ("127.0.0.1", "https://public.example/path"), ("127.0.0.1", urlunsplit(("https", "user:pass@" + "public.example", "", "", ""))),
])
def test_operator_boundary(address, origin):
    with pytest.raises(ValueError):
        PrivateProxyPeer(None, address=address, public_origin=origin)


def test_lifespan_is_unchanged():
    captured, messages = run({"type": "lifespan"})
    assert captured == [{"type": "lifespan"}]
    assert not messages


def test_actual_owner_route_uses_distinct_forwarded_throttle_buckets():
    persistence = AsyncMock()
    persistence.credentials.return_value = None
    persistence.attempt.return_value = AttemptResult(
        "issued", datetime.now(timezone.utc) + timedelta(hours=12))
    reader = AsyncMock()
    reader.read.return_value = ReadResult(None)
    origin = "https://public.example:8443"
    password = "synthetic-owner-passphrase"
    auth = OwnerAuthentication(persistence, owner_name="Owner", password=password)
    app = create_app(reader, owner_name="Owner", auth=auth, allowed_origins=(origin,),
                     proxy_address="127.0.0.1", public_origin=origin)
    with TestClient(app, base_url="http://private.invalid", client=("127.0.0.1", 4000)) as client:
        for address in ("192.0.2.1", "2001:db8::1"):
            forwarded = f'for="[{address}]"' if ":" in address else f"for={address}"
            response = client.post("/api/v1/auth/login", json={"password": password},
                                   headers={"Origin": origin, "Forwarded": forwarded})
            assert response.status_code == 200
            assert "__Host-openbot_session=" in response.headers["set-cookie"]
            assert persistence.attempt.await_args.kwargs["client_digest"] == client_digest(address)
        assert persistence.attempt.await_count == 2
        response = client.post("/api/v1/auth/login", json={"password": password},
                               headers={"Origin": "https://wrong.example", "Forwarded": "for=192.0.2.1"})
        assert response.status_code == 403
        response = client.post("/api/v1/auth/login", json={"password": password}, headers={"Origin": origin})
        assert response.status_code == 400
        assert response.headers["cache-control"] == "no-store"
        assert persistence.attempt.await_count == 2
        redirect = client.get("/api/v1/auth/session/", headers={"Forwarded": "for=192.0.2.1"}, follow_redirects=False)
        assert redirect.status_code == 307
        assert redirect.headers["location"] == origin + "/api/v1/auth/session"
        assert client.get("/api/v1/auth/session", headers={"Forwarded": "for=192.0.2.1"}).json() == {"authenticated": False}
    with pytest.raises(ValueError):
        create_app(reader, owner_name="Owner", proxy_address="127.0.0.1")
