"""Reference entry configuration fails before database startup; no user environment is inherited."""
import os
from pathlib import Path
import subprocess
import sys

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/serve.py"


@pytest.mark.parametrize("overrides, message", [
    ({"OPENBOT_CONTROL_DATABASE_URL": ""}, "explicit OPENBOT_CONTROL_DATABASE_URL"),
    ({"OPENBOT_CONTROL_AUTHORITY": "identity"}, "explicit control-plane Owner password"),
    ({"OPENBOT_CONTROL_AUTHORITY": "unexpected"}, "Unknown control-plane authority"),
    ({"OPENBOT_CONTROL_COOKIE_MODE": "unexpected"}, "Unknown control-plane cookie mode"),
    ({"OPENBOT_CONTROL_PORT": "0"}, "port must be between"),
    ({"OPENBOT_CONTROL_PORT": "65536"}, "port must be between"),
    ({"OPENBOT_CONTROL_AUTHORITY": "owner-auth", "OPENBOT_OWNER_PASSWORD": "synthetic-original-password"}, "explicit control-plane Owner password"),
    ({"OPENBOT_CONTROL_AUTHORITY": "owner-auth", "OPENBOT_CONTROL_OWNER_PASSWORD": "synthetic-control-password",
      "OPENBOT_CONTROL_SESSION_TTL_HOURS": "-1"}, "TTL must be 1 to 168"),
    ({"OPENBOT_CONTROL_AUTHORITY": "owner-auth", "OPENBOT_CONTROL_OWNER_PASSWORD": "synthetic-control-password",
      "OPENBOT_CONTROL_ALLOWED_ORIGINS": "*"}, "explicit origins"),
])
def test_invalid_configuration_never_enters_database_startup(tmp_path, overrides, message):
    result = subprocess.run([sys.executable, "-I", str(SCRIPT)], cwd=tmp_path,
                            env={"PATH": os.defpath, "LANG": "C.UTF-8",
                                 "OPENBOT_CONTROL_DATABASE_URL": "postgresql://fixture.invalid/unused", **overrides},
                            capture_output=True, text=True, timeout=5)
    assert result.returncode != 0
    assert message in result.stderr
    assert "synthetic-original-password" not in result.stderr
    assert "synthetic-control-password" not in result.stderr
    assert "storage_unavailable" not in result.stderr


@pytest.mark.parametrize("host", ["", "localhost", "::", "127.0.0.2", "0.0.0.0:3001", "0.0.0.0\n"])
def test_invalid_host_precedes_database_password_and_product_keys(tmp_path, host):
    result = subprocess.run(
        [sys.executable, "-I", "-B", str(SCRIPT)], cwd=tmp_path,
        env={"PATH": os.defpath, "LANG": "C.UTF-8", "OPENBOT_CONTROL_HOST": host,
             "OPENBOT_CONTROL_AUTHORITY": "product", "OPENBOT_CONTROL_DATABASE_URL": "",
             "OPENBOT_CONTROL_OBJECT_ROOT": str(tmp_path / "must-not-exist")},
        capture_output=True, text=True, timeout=5,
    )
    assert result.returncode != 0
    assert "host must be 127.0.0.1 or 0.0.0.0" in result.stderr
    assert "explicit OPENBOT_CONTROL_DATABASE_URL" not in result.stderr
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("host", [None, "127.0.0.1", "0.0.0.0"])
def test_default_and_explicit_host_only_change_bind_address(monkeypatch, host):
    import importlib.util

    monkeypatch.setattr(sys, "path", sys.path.copy())
    spec = importlib.util.spec_from_file_location("tested_control_entry", SCRIPT)
    entry = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(entry)
    values = {"OPENBOT_CONTROL_DATABASE_URL": "postgresql://synthetic.invalid/unused"}
    if host is not None:
        values["OPENBOT_CONTROL_HOST"] = host
    monkeypatch.setattr(entry.os, "environ", values)
    calls = {}
    monkeypatch.setattr(entry, "PostgresReadStore", lambda dsn: object())

    def app(store, **kwargs):
        calls["app"] = kwargs
        return object()

    def uvicorn(app, **kwargs):
        calls["uvicorn"] = kwargs

    monkeypatch.setattr(entry, "create_app", app)
    monkeypatch.setattr(entry.uvicorn, "run", uvicorn)
    entry.main()
    assert calls["uvicorn"]["host"] == (host if host is not None else "127.0.0.1")
    assert calls["uvicorn"]["port"] == 3101 and calls["uvicorn"]["proxy_headers"] is False
    assert calls["app"]["secure_cookies"] is True and calls["app"]["allowed_origins"] == ()
    assert calls["app"]["auth"] is None and calls["app"]["product"] is None
