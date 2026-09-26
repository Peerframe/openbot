"""Only the owned synthetic reference fixture enables PostgreSQL integration tests."""
import json
import os
from pathlib import Path
from urllib.parse import urlparse

import pytest


@pytest.fixture(scope="module")
def fixture():
    path = os.environ.get("OPENBOT_CONTROL_TEST_FIXTURE")
    if not path:
        pytest.skip("Use the owned test:control:python fixture")
    data = json.loads(Path(path).read_text())
    parsed = urlparse(data["dsn"])
    assert parsed.hostname == "127.0.0.1"
    assert parsed.path.startswith("/openbot_control_test_")
    return data
