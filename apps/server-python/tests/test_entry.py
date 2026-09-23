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
