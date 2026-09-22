"""Shared test configuration.

The package is consumed from ``src/`` (declared in ``pyproject.toml``). The path
insertion is repeated here so the suite still runs when pytest is invoked with an
explicit config that bypasses that setting.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


@pytest.fixture
def anyio_backend() -> str:
    """Run on asyncio only: no trio dependency is installed or claimed."""
    return "asyncio"
