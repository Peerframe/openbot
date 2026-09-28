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


@pytest.mark.parametrize(
    "source",
    [
        "from openbot_agent_runtime import does_not_exist",
        "from openbot_agent_runtime import *",
        "import openbot_agent_runtime.sdk_ports as ports",
    ],
)
def test_undeclared_or_private_consumer_imports_are_rejected(source):
    assert checker.consumer_imports(source, "consumer")


def test_declared_public_exports_are_installed_and_loadable():
    import openbot_agent_runtime as runtime

    assert set(runtime.__all__) == checker.public_exports()
    for name in runtime.__all__:
        assert hasattr(runtime, name), name


@pytest.fixture
def nested_repo(tmp_path, monkeypatch):
    root = tmp_path / "packages/harness"
    core = root / "src/openbot_agent_runtime"
    core.mkdir(parents=True)
    (core / "__init__.py").write_text('__all__ = ["PortModel"]\n')
    (root / "pyproject.toml").write_text(
        '[tool.openbot]\npublic-modules = ["temporal_agent"]\n'
        '[tool.openbot.review-exceptions."executor.py"]\n'
        'maximum-lines = 450\nreason = "Existing lifecycle"\n'
    )
    monkeypatch.setattr(checker, "ROOT", root)

    def write(path, source):
        file = tmp_path / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(source)
        return file

    write(
        "packages/harness/src/openbot_agent_runtime/temporal_agent.py",
        '__all__ = ["build_temporal_agent"]\n',
    )
    return write


@pytest.mark.parametrize(
    "path,source",
    [
        ("packages/harness/src/openbot_agent_runtime/nested/mod.py", "import psycopg\n"),
        ("packages/harness/src/openbot_agent_runtime/nested/sdk_ports.py", "import temporalio\n"),
        ("packages/harness/src/openbot_agent_runtime/nested/executor.py", "# line\n" * 401),
        ("packages/harness/scripts/nested/check.py", "# line\n" * 401),
        (
            "packages/harness/examples/nested/example.py",
            "from openbot_agent_runtime.worker import main\n",
        ),
        (
            "apps/server-python/src/openbot_server/nested/adapter.py",
            "from openbot_agent_runtime.worker import main\n",
        ),
        (
            "apps/server-python/scripts/nested/adapter.py",
            "from openbot_agent_runtime.worker import main\n",
        ),
    ],
)
def test_scans_nested_sources_without_basename_exemptions(nested_repo, path, source):
    nested_repo(path, source)
    assert checker.main() == 1


def test_public_submodule_declarations_and_generated_exclusions(nested_repo):
    nested_repo("packages/harness/src/openbot_agent_runtime/temporal_guard.py", "import temporalio\n")
    nested_repo("packages/harness/src/openbot_agent_runtime/executor.py", "# line\n" * 440)
    nested_repo(
        "packages/harness/examples/nested/example.py",
        "from openbot_agent_runtime.temporal_agent import build_temporal_agent\n",
    )
    for generated in (".venv", "venv", "node_modules", "dist", "build", "__pycache__"):
        nested_repo(f"packages/harness/scripts/{generated}/bad.py", "# line\n" * 500)
        nested_repo(
            f"apps/server-python/src/openbot_server/{generated}/bad.py",
            "from openbot_agent_runtime.worker import main\n",
        )
    assert checker.main() == 0
    assert checker.consumer_imports(
        "from openbot_agent_runtime.temporal_agent import missing", "consumer"
    )
    root = checker.ROOT
    policy = (
        (root / "pyproject.toml")
        .read_text()
        .replace('["temporal_agent"]', '["temporal_agent", "public.extra"]')
    )
    (root / "pyproject.toml").write_text(policy)
    nested_repo(
        "packages/harness/src/openbot_agent_runtime/public/extra.py", '__all__ = ["Extension"]\n'
    )
    assert not checker.consumer_imports(
        "from openbot_agent_runtime.public.extra import Extension", "consumer"
    )
    assert checker.consumer_imports(
        "from openbot_agent_runtime.public.extra import private", "consumer"
    )
