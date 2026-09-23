from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient
import pytest

from openbot_server.app import create_app
from openbot_server.auth import AttemptResult, OwnerAuthentication
from openbot_server.database import ReadResult, StoreUnavailable

PASSWORD = "synthetic-owner-passphrase"
ORIGIN = "https://control.test"


@pytest.fixture
def api():
    persistence = AsyncMock()
    persistence.attempt.return_value = AttemptResult("issued", datetime.now(timezone.utc) + timedelta(hours=12))
    persistence.revoke.return_value = True
    reader = AsyncMock()
    reader.read.return_value = ReadResult(None)
    auth = OwnerAuthentication(persistence, owner_name="Owner", password=PASSWORD)
    with TestClient(create_app(reader, owner_name="Owner", allowed_origins=(ORIGIN,), auth=auth),
                    base_url=ORIGIN, client=("127.0.0.1", 10000)) as client:
        yield client, persistence


def login(client, **kwargs):
    return client.post("/api/v1/auth/login", json={"password": PASSWORD}, headers={"Origin": ORIGIN}, **kwargs)


def test_cookie_issuance_and_revocation_happen_after_persistence(api):
    client, persistence = api
    response = login(client)
    assert response.status_code == 200
    assert response.json()["session"]["authenticated"] is True
    cookie = response.headers["set-cookie"]
    assert "__Host-openbot_session=" in cookie
    for flag in ("HttpOnly", "Secure", "SameSite=strict", "Path=/", "Max-Age="):
        assert flag in cookie
    assert "Domain=" not in cookie
    assert PASSWORD not in response.text
    assert response.headers["cache-control"] == "no-store"
    assert len(client.cookies["__Host-openbot_session"]) == 43
    persistence.attempt.assert_awaited_once()
    response = client.post("/api/v1/auth/logout", headers={"Origin": ORIGIN})
    assert response.status_code == 204 and response.content == b""
    persistence.revoke.assert_awaited_once()
    assert "Max-Age=0" in response.headers["set-cookie"]


@pytest.mark.parametrize("headers", [{}, {"Origin": "null"}, {"Origin": "https://evil.test"},
    {"Host": "evil.test", "Origin": "https://evil.test"},
    {"Origin": "https://evil.test", "Forwarded": "host=control.test;proto=https"}])
def test_mutation_trust_is_not_inferred_from_untrusted_headers(api, headers):
    client, persistence = api
    response = client.post("/api/v1/auth/login", json={"password": PASSWORD}, headers=headers)
    assert response.status_code == 403
    persistence.attempt.assert_not_called()


def test_forwarded_headers_cannot_choose_a_different_throttle_identity(api):
    client, persistence = api
    assert login(client).status_code == 200
    first = persistence.attempt.call_args.kwargs["client_digest"]
    response = client.post("/api/v1/auth/login", json={"password": PASSWORD},
                           headers={"Origin": ORIGIN, "Forwarded": "for=198.51.100.1", "X-Forwarded-For": "198.51.100.2"})
    assert response.status_code == 200
    assert persistence.attempt.call_args.kwargs["client_digest"] == first


@pytest.mark.parametrize("body, expected", [
    ('{"password": "x"}', 200),
    ('{"password": 123456789}', 422),
    ('{"password": ""}', 422),
    ('{"password": "' + "x" * 1025 + '"}', 422),
    ('{"password": "\\ud800"}', 422),
    ("broken json", 422),
    ("[1,2,3]", 422),
    ('{"password": "' + "x" * 9000 + '"}', 413),
])
def test_invalid_inputs_are_bounded_and_not_echoed(api, body, expected):
    client, persistence = api
    # This mock models a persistence result; this test concerns HTTP admission, not password matching.
    if expected == 200:
        persistence.attempt.return_value = AttemptResult("invalid")
        expected = 401
    response = client.post("/api/v1/auth/login", content=body,
                           headers={"Origin": ORIGIN, "Content-Type": "application/json"})
    assert response.status_code == expected
    assert "123456789" not in response.text
    assert "set-cookie" not in response.headers


def test_chunked_body_is_bounded_without_trusting_content_length(api):
    client, persistence = api
    response = client.post("/api/v1/auth/login", content=iter([b'{"password":"', b'x' * 9000, b'"}']),
                           headers={"Origin": ORIGIN, "Content-Type": "application/json"})
    assert response.status_code == 413
    persistence.attempt.assert_not_called()


def test_storage_failure_and_throttle_never_issue_or_clear_cookies(api):
    client, persistence = api
    persistence.attempt.side_effect = StoreUnavailable("PRIVATE")
    response = login(client)
    assert response.status_code == 503
    assert "PRIVATE" not in response.text and "set-cookie" not in response.headers
    persistence.attempt.side_effect = None
    persistence.attempt.return_value = AttemptResult("throttled", retry_after=300)
    response = login(client)
    assert response.status_code == 429 and response.headers["retry-after"] == "300"
    assert "set-cookie" not in response.headers
    client.cookies.set("__Host-openbot_session", "s" * 43)
    persistence.revoke.side_effect = StoreUnavailable("PRIVATE")
    response = client.post("/api/v1/auth/logout", headers={"Origin": ORIGIN})
    assert response.status_code == 503 and "set-cookie" not in response.headers


def test_auth_selection_does_not_enable_business_mutations(api):
    client, persistence = api
    assert login(client).status_code == 200
    for path in ("/api/v1/bots", "/api/v1/channels", "/api/v1/runs/anything/cancel"):
        assert client.post(path, headers={"Origin": ORIGIN}, json={}).status_code == 405
    schema = client.get("/openapi.json").json()
    assert schema["paths"]["/api/v1/auth/login"]["post"]["security"] == []
    assert schema["paths"]["/api/v1/auth/logout"]["post"]["security"] == [{"OwnerSession": []}]
    password = schema["paths"]["/api/v1/auth/login"]["post"]["requestBody"]["content"]["application/json"]["schema"]["properties"]["password"]
    assert password["writeOnly"] is True


@pytest.mark.parametrize("origins", [(), ("*",), ("null",), ("https://web.test/path",), ("https://u:p@web.test",), ("https://*.test",)])
def test_owner_auth_requires_explicit_literal_origins(origins):
    auth = OwnerAuthentication(AsyncMock(), owner_name="Owner", password=PASSWORD)
    with pytest.raises(ValueError):
        create_app(AsyncMock(), owner_name="Owner", allowed_origins=origins, auth=auth)
