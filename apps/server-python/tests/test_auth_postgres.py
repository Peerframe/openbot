"""Auth writes against the disposable database owned by test-python-control.mjs only."""
import asyncio
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import signal
from urllib.error import URLError
from urllib.request import Request, urlopen

import psycopg
import pytest
from fastapi.testclient import TestClient

from openbot_server.app import create_app
from openbot_server.auth import OwnerAuthentication, InvalidCredentials, RateLimited, client_digest
from openbot_server.auth_store import PostgresAuthStore
from openbot_server.database import PostgresReadStore


def authentication(fixture):
    return OwnerAuthentication(PostgresAuthStore(fixture["dsn"]), owner_name=fixture["ownerName"],
                               password=fixture["ownerPassword"])


def test_concurrent_failures_and_restart_keep_the_same_persistent_throttle(fixture):
    async def check():
        auth = authentication(fixture)
        async def attempt():
            try:
                await auth.login("wrong synthetic input", "192.0.2.41")
                return "unexpected"
            except InvalidCredentials:
                return "invalid"
            except RateLimited:
                return "throttled"
        outcomes = await asyncio.gather(*(attempt() for _ in range(10)))
        assert Counter(outcomes) == {"invalid": 5, "throttled": 5}
        with pytest.raises(RateLimited):
            await authentication(fixture).login(fixture["ownerPassword"], "192.0.2.41")
    asyncio.run(check())
    with psycopg.connect(fixture["dsn"]) as connection:
        row = connection.execute("SELECT attempt_count, blocked_until IS NOT NULL FROM request_throttle_buckets "
                                 "WHERE scope='owner-login' AND client_digest=%s",
                                 (client_digest("192.0.2.41"),)).fetchone()
        assert row == (5, True)


def test_success_clears_failures_and_failed_commit_cannot_issue_cookie(fixture):
    app = create_app(PostgresReadStore(fixture["dsn"]), owner_name=fixture["ownerName"],
                     secure_cookies=False, allowed_origins=("http://control.test",), auth=authentication(fixture))
    with TestClient(app, base_url="http://control.test", client=("192.0.2.42", 30000)) as client:
        headers = {"Origin": "http://control.test"}
        assert client.post("/api/v1/auth/login", json={"password": "wrong"}, headers=headers).status_code == 401
        with psycopg.connect(fixture["dsn"]) as connection:
            connection.execute("CREATE FUNCTION control_test_reject_session() RETURNS trigger LANGUAGE plpgsql AS $$ "
                               "BEGIN RAISE EXCEPTION 'private fixture database detail'; END $$")
            connection.execute("CREATE TRIGGER control_test_reject_session BEFORE INSERT ON auth_sessions "
                               "FOR EACH ROW EXECUTE FUNCTION control_test_reject_session()")
        try:
            response = client.post("/api/v1/auth/login", json={"password": fixture["ownerPassword"]}, headers=headers)
            assert response.status_code == 503
            assert "set-cookie" not in response.headers and "private fixture" not in response.text
            with psycopg.connect(fixture["dsn"]) as connection:
                # The attempted clear and reservation rolled back with the failed INSERT.
                assert connection.execute("SELECT attempt_count FROM request_throttle_buckets "
                                          "WHERE scope='owner-login' AND client_digest=%s",
                                          (client_digest("192.0.2.42"),)).fetchone() == (1,)
        finally:
            with psycopg.connect(fixture["dsn"]) as connection:
                connection.execute("DROP TRIGGER control_test_reject_session ON auth_sessions")
                connection.execute("DROP FUNCTION control_test_reject_session()")
        response = client.post("/api/v1/auth/login", json={"password": fixture["ownerPassword"]}, headers=headers)
        assert response.status_code == 200
        with psycopg.connect(fixture["dsn"]) as connection:
            assert connection.execute("SELECT attempt_count FROM request_throttle_buckets "
                                      "WHERE scope='owner-login' AND client_digest=%s",
                                      (client_digest("192.0.2.42"),)).fetchone() is None


def test_python_revokes_typescript_cookie_and_issues_one_for_typescript(fixture):
    app = create_app(PostgresReadStore(fixture["dsn"]), owner_name=fixture["ownerName"],
                     secure_cookies=False, allowed_origins=("http://control.test",), auth=authentication(fixture))
    with TestClient(app, base_url="http://control.test", client=("192.0.2.43", 30000)) as client:
        headers = {"Origin": "http://control.test"}
        client.cookies.set("openbot_session", fixture["tsRevocableToken"])
        assert client.get("/api/v1/auth/session").json()["authenticated"] is True
        assert client.post("/api/v1/auth/logout", headers=headers).status_code == 204
        client.cookies.clear()
        client.cookies.set("openbot_session", fixture["tsRevocableToken"])
        assert client.get("/api/v1/auth/session").json() == {"authenticated": False}
        client.cookies.clear()
        response = client.post("/api/v1/auth/login", json={"password": fixture["ownerPassword"]}, headers=headers)
        assert response.status_code == 200
        token = client.cookies["openbot_session"]
        assert client.get("/api/v1/bots").status_code == 200
        with psycopg.connect(fixture["dsn"]) as connection:
            row = connection.execute("SELECT owner_id, token_digest, expires_at > created_at FROM auth_sessions "
                                     "WHERE token_digest=%s", (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
            assert row == ("owner", hashlib.sha256(token.encode()).hexdigest(), True)
        # Return only the synthetic token to the owning Node fixture, with restrictive creation.
        with os.fdopen(os.open(fixture["authResult"], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
            json.dump({"pythonToken": token}, output)


def test_explicit_owner_auth_entry_logs_in_reads_and_logs_out_over_http(fixture):
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    root = Path(__file__).resolve().parents[1]
    child = subprocess.Popen(
        [sys.executable, "-I", str(root / "scripts/serve.py")], cwd=root,
        env={"PATH": os.defpath, "LANG": "C.UTF-8", "OPENBOT_CONTROL_DATABASE_URL": fixture["dsn"],
             "OPENBOT_CONTROL_COOKIE_MODE": "loopback", "OPENBOT_CONTROL_PORT": str(port),
             "OPENBOT_OWNER_NAME": fixture["ownerName"], "OPENBOT_CONTROL_AUTHORITY": "owner-auth",
             "OPENBOT_CONTROL_OWNER_PASSWORD": fixture["ownerPassword"]},
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        for _ in range(100):
            assert child.poll() is None
            try:
                with urlopen(base + "/health", timeout=0.25) as response:
                    assert json.load(response)["phase"] == "s2a-auth-reference"
                break
            except (URLError, TimeoutError):
                time.sleep(0.05)
        else:
            pytest.fail("Owner-auth HTTP process did not become ready")
        request = Request(base + "/api/v1/auth/login", data=json.dumps({"password": fixture["ownerPassword"]}).encode(),
                          headers={"Content-Type": "application/json", "Origin": base}, method="POST")
        with urlopen(request, timeout=5) as response:
            assert json.load(response)["session"]["authenticated"] is True
            cookie = response.headers["Set-Cookie"].split(";", 1)[0]
        with urlopen(Request(base + "/api/v1/bots", headers={"Cookie": cookie}), timeout=3) as response:
            assert len(json.load(response)["bots"]) == 2
        request = Request(base + "/api/v1/auth/logout", headers={"Cookie": cookie, "Origin": base}, method="POST")
        with urlopen(request, timeout=3) as response:
            assert response.status == 204
        with urlopen(Request(base + "/api/v1/auth/session", headers={"Cookie": cookie}), timeout=3) as response:
            assert json.load(response) == {"authenticated": False}
        child.terminate()
        assert child.wait(timeout=10) == -signal.SIGTERM
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)
