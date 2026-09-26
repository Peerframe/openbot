import importlib.util
import subprocess
import sys
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("boundaries", ROOT / "scripts/check-boundaries.py")
assert spec and spec.loader
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


@pytest.mark.parametrize(
    "source",
    [
        "import openbot_server",
        "from psycopg import connect",
        "import openai",
        "from providers import live",
        "import importlib; importlib.import_module('psycopg')",
        "__import__('openbot_server')",
    ],
)
def test_dependency_back_edges_cannot_enter_the_core(source):
    assert checker.imports(source, "executor.py")


def test_control_consumers_cannot_depend_on_private_modules():
    assert checker.consumer_imports(
        "from openbot_agent_runtime.sdk_ports import PortModel", "consumer"
    )
    assert checker.consumer_imports("from openbot_agent_runtime.worker import main", "consumer")
    assert not checker.consumer_imports("from openbot_agent_runtime import PortModel", "consumer")
    assert not checker.consumer_imports(
        "from openbot_agent_runtime.temporal_agent import build_temporal_agent", "consumer"
    )


def test_plain_import_does_not_load_optional_temporal_or_control():
    result = subprocess.run(
        [
            sys.executable,
            "-I",
            "-c",
            "import sys, openbot_agent_runtime; "
            "assert not any(n.split('.')[0] in {'temporalio', 'openbot_server', 'psycopg', 'openai'} for n in sys.modules)",
        ],
        capture_output=True,
        text=True,
        timeout=20,
        cwd=ROOT.parent,
    )
    assert result.returncode == 0, result.stderr


def test_real_package_and_consumers_obey_boundaries():
    assert checker.main() == 0


@pytest.mark.parametrize("source", [
    "from openbot_agent_runtime import does_not_exist",
    "from openbot_agent_runtime import *",
    "import openbot_agent_runtime.sdk_ports as ports",
])
def test_undeclared_or_private_consumer_imports_are_rejected(source):
    assert checker.consumer_imports(source, "consumer")


def test_declared_public_exports_are_installed_and_loadable():
    import openbot_agent_runtime as runtime

    assert set(runtime.__all__) == checker.public_exports()
    for name in runtime.__all__:
        assert hasattr(runtime, name), name
