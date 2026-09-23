"""Runs only against the owned fixture created by scripts/test-python-control.mjs."""
import asyncio
import hashlib
import json
import os
import socket
import signal
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import Request, urlopen
from pathlib import Path

import psycopg
import pytest
from fastapi.testclient import TestClient

from openbot_server.app import create_app
from openbot_server.database import PostgresReadStore, StoreUnavailable




def equivalent_response(path, response):
    if path == "/api/v1/channels":
        # Membership is a set in the legacy contract; its SQL query has no member order.
        return {"channels": [{**channel, "botIds": sorted(channel["botIds"])}
                             for channel in response["channels"]]}
    return response


def test_real_typescript_session_and_api_responses(fixture):
    store = PostgresReadStore(fixture["dsn"])
    app = create_app(store, owner_name=fixture["ownerName"], secure_cookies=False)
    with TestClient(app) as client:
        assert client.get("/api/v1/bots").status_code == 401
        client.cookies.set("openbot_session", fixture["token"])
        for path, expected in fixture["expected"].items():
            response = client.get(path)
            assert response.status_code == 200
            assert equivalent_response(path, response.json()) == equivalent_response(path, expected)
        try:
            with psycopg.connect(fixture["dsn"]) as connection:
                connection.execute("UPDATE auth_sessions SET revoked_at=now() WHERE token_digest=%s",
                                   (hashlib.sha256(fixture["token"].encode()).hexdigest(),))
            assert client.get("/api/v1/channels").status_code == 401
            assert client.get("/api/v1/auth/session").json() == {"authenticated": False}
            with psycopg.connect(fixture["dsn"]) as connection:
                connection.execute("UPDATE auth_sessions SET revoked_at=NULL, expires_at=now()-interval '1 second' "
                                   "WHERE token_digest=%s", (hashlib.sha256(fixture["token"].encode()).hexdigest(),))
            assert client.get("/api/v1/bots").status_code == 401
        finally:
            with psycopg.connect(fixture["dsn"]) as connection:
                connection.execute("UPDATE auth_sessions SET revoked_at=NULL, expires_at=%s WHERE token_digest=%s",
                                   (fixture["expected"]["/api/v1/auth/session"]["expiresAt"],
                                    hashlib.sha256(fixture["token"].encode()).hexdigest()))


def test_database_refuses_effects_on_reference_connection(fixture):
    async def check():
        store = PostgresReadStore(fixture["dsn"])
        async with await store._connect() as connection:
            with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
                await connection.execute("CREATE TABLE must_not_exist (id integer)")
    asyncio.run(check())


def test_schema_drift_prevents_startup_without_repair(fixture):
    with psycopg.connect(fixture["dsn"]) as connection:
        rows = connection.execute("SELECT id, hash FROM drizzle.__drizzle_migrations ORDER BY id LIMIT 1").fetchall()
        identity, old_hash = rows[0]
        connection.execute("UPDATE drizzle.__drizzle_migrations SET hash=%s WHERE id=%s", ("0" * 64, identity))
    try:
        with pytest.raises(StoreUnavailable, match="schema_history_mismatch"):
            asyncio.run(PostgresReadStore(fixture["dsn"]).verify_schema())
        with psycopg.connect(fixture["dsn"]) as connection:
            assert connection.execute("SELECT hash FROM drizzle.__drizzle_migrations WHERE id=%s", (identity,)).fetchone()[0] == "0" * 64
    finally:
        with psycopg.connect(fixture["dsn"]) as connection:
            connection.execute("UPDATE drizzle.__drizzle_migrations SET hash=%s WHERE id=%s", (old_hash, identity))


def test_loopback_entry_uses_real_http_and_stops_on_sigterm(fixture):
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    root = Path(__file__).resolve().parents[1]
    child = subprocess.Popen(
        [sys.executable, "-I", str(root / "scripts/serve.py")], cwd=root,
        env={"PATH": os.defpath, "LANG": "C.UTF-8", "OPENBOT_CONTROL_DATABASE_URL": fixture["dsn"],
             "OPENBOT_CONTROL_COOKIE_MODE": "loopback", "OPENBOT_CONTROL_PORT": str(port),
             "OPENBOT_OWNER_NAME": fixture["ownerName"]},
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        for _ in range(100):
            assert child.poll() is None, "Reference HTTP process exited before readiness"
            try:
                with urlopen(base + "/health", timeout=0.25) as response:
                    assert json.load(response)["phase"] == "s2a-read-reference"
                break
            except (URLError, TimeoutError):
                time.sleep(0.05)
        else:
            pytest.fail("Reference HTTP process did not become ready")
        for path, expected in fixture["expected"].items():
            request = Request(base + path, headers={"Cookie": "openbot_session=" + fixture["token"]})
            with urlopen(request, timeout=3) as response:
                assert equivalent_response(path, json.load(response)) == equivalent_response(path, expected)
                assert response.headers["Cache-Control"] == "no-store"
        child.terminate()
        # Uvicorn 0.53.0 re-raises the captured signal after its graceful shutdown.
        assert child.wait(timeout=10) == -signal.SIGTERM
        with socket.socket() as probe:
            assert probe.connect_ex(("127.0.0.1", port)) != 0
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)


def test_invalid_legacy_status_fails_closed_without_rewriting_the_row(fixture):
    identity = fixture["expected"]["/api/v1/bots"]["bots"][0]["id"]
    original = fixture["expected"]["/api/v1/bots"]["bots"][0]["status"]
    with psycopg.connect(fixture["dsn"]) as connection:
        connection.execute("UPDATE bots SET status=%s WHERE id=%s", ("unsupported-legacy-state", identity))
    try:
        app = create_app(PostgresReadStore(fixture["dsn"]), owner_name=fixture["ownerName"], secure_cookies=False)
        with TestClient(app) as client:
            client.cookies.set("openbot_session", fixture["token"])
            response = client.get("/api/v1/bots")
            assert response.status_code == 503
            assert "unsupported-legacy-state" not in response.text
        with psycopg.connect(fixture["dsn"]) as connection:
            assert connection.execute("SELECT status FROM bots WHERE id=%s", (identity,)).fetchone()[0] == "unsupported-legacy-state"
    finally:
        with psycopg.connect(fixture["dsn"]) as connection:
            connection.execute("UPDATE bots SET status=%s WHERE id=%s", (original, identity))
