"""Tests consume the installed wheel, as product hosts do."""
import pytest

@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"
