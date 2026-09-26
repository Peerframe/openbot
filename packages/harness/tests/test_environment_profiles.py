"""The dev / runtime / auto contract of ``scripts/verify_environment.py``.

Two kinds of evidence are used, on purpose.

*Pure metadata fixtures.* A fixture run launches the *real* verifier as a
subprocess with ``-S`` (which disables ``site``), so ``importlib.metadata`` sees
no site-packages at all, and puts a directory of synthetic ``*.dist-info`` trees
on ``sys.path``. The installed set is therefore entirely constructed by the test
while the code under test, the lock files and ``importlib.metadata`` are all real.
No environment is installed, no second virtualenv is created and the active
``.venv`` is never modified.

*Real-environment checks.* The development profile, the ``auto`` selection and the
exact Server preflight invocation are also exercised against the actual package
environment, because those are the invocations production depends on.
"""

from __future__ import annotations

import ast
import importlib.util
import shutil
import subprocess
import sys
from dataclasses import dataclass
from importlib import metadata
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parents[1]
VERIFIER_PATH = PACKAGE / "scripts" / "verify_environment.py"
SRC_DIR = PACKAGE / "src"
DEV_LOCK = PACKAGE / "requirements.lock"
RUNTIME_LOCK = PACKAGE / "requirements-runtime.lock"

# The development environment is the interpreter running this suite, so the real
# metadata and the real locks can be checked without any fixture.
_REAL_ENV = PACKAGE / ".venv"


def _load_verifier():
    """Import the verifier as a module so its parser can be unit-tested directly."""
    spec = importlib.util.spec_from_file_location("verify_environment_under_test", VERIFIER_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # dataclasses resolves annotations through sys.modules[cls.__module__], so the
    # module has to be registered before it is executed.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


verifier = _load_verifier()

# Runs the verifier through runpy exactly as the Server's startup preflight does:
# an unrelated working directory, an explicit src path and an explicit argv.
_BOOTSTRAP = (
    "import runpy, sys; "
    "sys.path.insert(0, sys.argv[1]); "
    "sys.argv = [sys.argv[2], *sys.argv[3:]]; "
    "runpy.run_path(sys.argv[0], run_name='__main__')"
)

# The Server's own preflight program, reproduced verbatim in shape: it asserts the
# interpreter floor, imports the package, and forces `--profile auto`.
_SERVER_PREFLIGHT = (
    "import sys, runpy; "
    "assert sys.version_info >= (3, 12); "
    "sys.path.insert(0, sys.argv[1]); "
    "import openbot_agent_runtime; "
    'sys.argv = [sys.argv[2], "--profile", "auto"]; '
    'runpy.run_path(sys.argv[0], run_name="__main__")'
)

_METADATA = "Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n"


@dataclass
class Result:
    code: int
    stdout: str
    stderr: str


def pins(path: Path) -> dict[str, str]:
    """The shipped lock's canonical pins, read through the verifier's own parser."""
    return verifier.parse_pins(path, allow_options=False)


def literal_names(path: Path) -> dict[str, str]:
    """The spelling each pin actually uses in the file, keyed canonically."""
    names: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        name, _separator, _version = line.partition("==")
        names[verifier.canonical(name)] = name.strip()
    return names


def write_distribution(root: Path, name: str, version: str) -> None:
    """Create one synthetic ``*.dist-info`` tree that importlib.metadata can read."""
    dist_info = root / f"{name}-{version}.dist-info"
    dist_info.mkdir(parents=True, exist_ok=True)
    (dist_info / "METADATA").write_text(
        _METADATA.format(name=name, version=version), encoding="utf-8"
    )


def materialise(root: Path, installed: dict[str, str]) -> Path:
    for name, version in installed.items():
        write_distribution(root, name, version)
    return root


def run_fixture(
    installed_root: Path | None,
    *args: str,
    verifier_path: Path = VERIFIER_PATH,
) -> Result:
    """Run the verifier with a synthetic installed set and no site-packages."""
    argv = [sys.executable, "-S", "-I"]
    if installed_root is None:
        argv += [str(verifier_path), *args]
    else:
        argv += ["-c", _BOOTSTRAP, str(installed_root), str(verifier_path), *args]
    process = subprocess.run(argv, capture_output=True, text=True, timeout=60)
    return Result(process.returncode, process.stdout, process.stderr)


def run_real(*args: str, cwd: Path | None = None, env: dict[str, str] | None = None) -> Result:
    """Run the verifier against the real package environment."""
    process = subprocess.run(
        [sys.executable, str(VERIFIER_PATH), *args],
        capture_output=True,
        text=True,
        timeout=60,
        cwd=cwd,
        env=env,
    )
    return Result(process.returncode, process.stdout, process.stderr)


@pytest.fixture
def installed(tmp_path: Path) -> Path:
    root = tmp_path / "site"
    root.mkdir()
    return root


@pytest.fixture
def fake_package(tmp_path: Path):
    """Build a throwaway package tree whose lock files the test controls."""

    def build(
        *,
        lock: str | None,
        requirements: str,
        runtime_lock: str | None = None,
        requirements_dev: str | None = None,
    ) -> Path:
        root = tmp_path / "pkg"
        (root / "scripts").mkdir(parents=True, exist_ok=True)
        shutil.copy(VERIFIER_PATH, root / "scripts" / "verify_environment.py")
        if lock is not None:
            (root / "requirements.lock").write_text(lock, encoding="utf-8")
        if runtime_lock is not None:
            (root / "requirements-runtime.lock").write_text(runtime_lock, encoding="utf-8")
        (root / "requirements.txt").write_text(requirements, encoding="utf-8")
        if requirements_dev is not None:
            (root / "requirements-dev.txt").write_text(requirements_dev, encoding="utf-8")
        return root

    return build


# --- lock parsing: fail closed -------------------------------------------------

_INVALID_LOCK_LINES = {
    "a-range": "pydantic-ai-slim>=2.47.0\n",
    "an-option": "-r other-requirements.txt\n",
    "an-extras-request": "pydantic-ai-slim[cli]==2.47.0\n",
    "a-trailing-marker": 'pydantic-ai-slim==2.47.0 ; python_version < "3.13"\n',
    "a-range-suffix": "pydantic-ai-slim==2.47.*\n",
    "an-empty-version": "pydantic-ai-slim==\n",
    "a-menu-entry": "pydantic-ai-slim==2.47.0, jsonschema-rs==0.57.1\n",
}


@pytest.mark.parametrize("identifier", sorted(_INVALID_LOCK_LINES))
def test_a_lock_line_the_parser_cannot_honour_is_refused(
    tmp_path: Path, identifier: str
) -> None:
    path = tmp_path / "requirements.lock"
    path.write_text(_INVALID_LOCK_LINES[identifier], encoding="utf-8")
    with pytest.raises(verifier.LockError):
        verifier.parse_pins(path, allow_options=False)


def test_a_duplicate_pin_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "requirements.lock"
    path.write_text("pydantic==2.13.5\npydantic==2.13.5\n", encoding="utf-8")
    with pytest.raises(verifier.LockError, match="duplicate pin"):
        verifier.parse_pins(path, allow_options=False)


def test_a_conflicting_duplicate_pin_is_refused(tmp_path: Path) -> None:
    """Two versions of one distribution is the case the card calls out."""
    path = tmp_path / "requirements.lock"
    path.write_text("pydantic==2.13.5\npydantic==2.12.0\n", encoding="utf-8")
    with pytest.raises(verifier.LockError, match="conflicting duplicate pin"):
        verifier.parse_pins(path, allow_options=False)


def test_a_missing_lock_is_refused(tmp_path: Path) -> None:
    with pytest.raises(verifier.LockError, match="missing lock file"):
        verifier.parse_pins(tmp_path / "absent.lock", allow_options=False)


def test_a_lock_with_no_pins_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "requirements.lock"
    path.write_text("# only a comment\n\n", encoding="utf-8")
    with pytest.raises(verifier.LockError, match="no pinned distributions"):
        verifier.parse_pins(path, allow_options=False)


def test_a_direct_file_may_include_another_requirements_file(tmp_path: Path) -> None:
    """The dev direct file legitimately carries `-r`; only a lock forbids options."""
    path = tmp_path / "requirements-dev.txt"
    path.write_text("-r requirements.txt\npytest==8.4.2\n", encoding="utf-8")
    assert verifier.parse_pins(path, allow_options=True) == {"pytest": "8.4.2"}


def test_pin_names_are_canonicalised(tmp_path: Path) -> None:
    path = tmp_path / "requirements.lock"
    path.write_text("typing_extensions==4.16.0\nPygments==2.21.0\n", encoding="utf-8")
    assert verifier.parse_pins(path, allow_options=False) == {
        "typing-extensions": "4.16.0",
        "pygments": "2.21.0",
    }


# --- the shipped locks ---------------------------------------------------------

def test_the_runtime_lock_is_a_subset_of_the_development_lock() -> None:
    dev = pins(DEV_LOCK)
    runtime = pins(RUNTIME_LOCK)
    assert set(runtime) <= set(dev)
    for name, version in runtime.items():
        assert dev[name] == version, f"{name} must keep the same pin in both locks"


def test_the_runtime_lock_excludes_the_whole_test_tooling() -> None:
    dev = pins(DEV_LOCK)
    runtime = pins(RUNTIME_LOCK)
    test_only = set(dev) - set(runtime)
    assert test_only == {"pytest", "iniconfig", "packaging", "pluggy", "pygments"}
    assert not test_only & set(runtime)


def test_the_runtime_lock_is_the_metadata_derived_closure() -> None:
    """Re-derive the closure from real metadata and compare it to the artifact.

    Requirements guarded by an ``extra`` marker are skipped: an extra is installed
    only when it is requested, and ``requirements.txt`` requests none. A
    requirement guarded by an *environment* marker is handled by intersecting the
    reachable set with what is actually installed, because a marker that is false
    simply means the distribution is absent -- so no marker evaluator (and no
    extra dependency) is needed to reproduce the derivation.
    """
    if not _REAL_ENV.exists():
        pytest.skip("the package virtualenv is required for the metadata derivation")

    roots = sorted(pins(PACKAGE / "requirements.txt"))
    reachable: set[str] = set()
    frontier = list(roots)
    while frontier:
        current = frontier.pop()
        if current in reachable:
            continue
        reachable.add(current)
        try:
            declared = metadata.requires(current) or []
        except metadata.PackageNotFoundError:
            # A marker-guarded dependency that is not installed (for example
            # `exceptiongroup; python_version < "3.11"`). It cannot appear in the
            # intersection below, so it needs no further walking.
            continue
        for spec in declared:
            marker = spec.split(";", 1)[1].strip() if ";" in spec else ""
            if "extra" in marker:
                continue
            head = spec.split(";", 1)[0].strip()
            name = verifier.canonical(head.split("[", 1)[0].split(">", 1)[0].split("=", 1)[0])
            if name:
                frontier.append(name)

    installed = {
        verifier.canonical(dist.metadata["Name"])
        for dist in metadata.distributions()
        if dist.metadata["Name"]
    }
    assert reachable & installed == set(pins(RUNTIME_LOCK))


# --- the real environment ------------------------------------------------------

def test_the_default_profile_still_accepts_the_real_development_environment() -> None:
    result = run_real()
    assert result.code == 0
    assert result.stdout == "environment matches the lock (23 pinned distributions)\n"
    assert result.stderr == ""


def test_the_explicit_development_profile_matches_the_default() -> None:
    assert run_real("--profile", "dev").stdout == run_real().stdout


def test_auto_selects_the_development_profile_in_the_real_environment() -> None:
    result = run_real("--profile", "auto")
    assert result.code == 0
    assert result.stdout == (
        "auto selected the dev profile\n"
        "environment matches the lock (23 pinned distributions)\n"
    )


def test_the_server_preflight_invocation_succeeds(tmp_path: Path) -> None:
    """The exact shape the Server uses: `-I -u -c <preflight> <src> <verifier>`.

    The working directory is unrelated to the package and the environment carries
    only the locale, so this also proves the verifier resolves its locks from its
    own location rather than from the current directory or the environment.
    """
    unrelated = tmp_path / "unrelated-cwd"
    unrelated.mkdir()
    process = subprocess.run(
        [
            sys.executable,
            "-I",
            "-u",
            "-c",
            _SERVER_PREFLIGHT,
            str(SRC_DIR),
            str(VERIFIER_PATH),
        ],
        capture_output=True,
        text=True,
        timeout=60,
        cwd=unrelated,
        env={"LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"},
    )
    assert process.returncode == 0, process.stderr
    assert "auto selected the dev profile" in process.stdout


def test_an_invalid_profile_is_a_usage_error() -> None:
    result = run_real("--profile", "bogus")
    assert result.code == 2
    assert "invalid choice" in result.stderr
    assert result.stdout == ""


# --- the development profile over synthetic metadata ---------------------------

def test_the_development_profile_accepts_the_exact_locked_set(installed: Path) -> None:
    materialise(installed, pins(DEV_LOCK))
    result = run_fixture(installed, "--profile", "dev")
    assert result.code == 0, result.stderr
    assert result.stdout == "environment matches the lock (23 pinned distributions)\n"


def test_the_development_profile_ignores_interpreter_tooling(installed: Path) -> None:
    """pip/setuptools/wheel are exempt because the interpreter owns them."""
    materialise(installed, pins(DEV_LOCK))
    materialise(installed, {"pip": "25.2", "setuptools": "80.9.0", "wheel": "0.45.1"})
    assert run_fixture(installed, "--profile", "dev").code == 0


def test_the_development_profile_reads_the_literal_lock_spellings(installed: Path) -> None:
    """`Pygments` / `pydantic_core` / `typing_extensions` must still be matched."""
    spellings = literal_names(DEV_LOCK)
    versions = pins(DEV_LOCK)
    materialise(installed, {spellings[name]: versions[name] for name in versions})
    assert run_fixture(installed, "--profile", "dev").code == 0


def test_a_missing_development_pin_is_refused(installed: Path) -> None:
    present = pins(DEV_LOCK)
    del present["pytest"]
    materialise(installed, present)
    result = run_fixture(installed, "--profile", "dev")
    assert result.code == 1
    assert "not installed: pytest==8.4.2" in result.stderr


def test_a_development_version_drift_is_refused(installed: Path) -> None:
    present = pins(DEV_LOCK)
    present["pydantic"] = "2.12.0"
    materialise(installed, present)
    result = run_fixture(installed, "--profile", "dev")
    assert result.code == 1
    assert "version drift: pydantic installed 2.12.0, lock 2.13.5" in result.stderr


def test_an_unexpected_development_distribution_is_refused(installed: Path) -> None:
    present = pins(DEV_LOCK)
    present["ruff"] = "0.16.0"
    materialise(installed, present)
    result = run_fixture(installed, "--profile", "dev")
    assert result.code == 1
    assert "unexpected installed distribution: ruff" in result.stderr


def test_no_arguments_means_the_development_profile(installed: Path) -> None:
    materialise(installed, pins(DEV_LOCK))
    result = run_fixture(installed)
    assert result.code == 0
    assert result.stdout == "environment matches the lock (23 pinned distributions)\n"


# --- the runtime profile over synthetic metadata -------------------------------

def test_the_runtime_profile_accepts_the_exact_runtime_set(installed: Path) -> None:
    materialise(installed, pins(RUNTIME_LOCK))
    result = run_fixture(installed, "--profile", "runtime")
    assert result.code == 0, result.stderr
    assert result.stdout == "environment matches the lock (18 pinned distributions)\n"


def test_the_runtime_profile_ignores_interpreter_tooling(installed: Path) -> None:
    materialise(installed, pins(RUNTIME_LOCK))
    materialise(installed, {"pip": "25.2", "setuptools": "80.9.0", "wheel": "0.45.1"})
    assert run_fixture(installed, "--profile", "runtime").code == 0


def test_the_runtime_profile_refuses_the_test_only_distributions(installed: Path) -> None:
    """The whole development closure is not a valid runtime environment."""
    materialise(installed, pins(DEV_LOCK))
    result = run_fixture(installed, "--profile", "runtime")
    assert result.code == 1
    for name in ("pytest", "iniconfig", "packaging", "pluggy", "pygments"):
        assert f"unexpected installed distribution: {name}" in result.stderr


def test_a_missing_runtime_pin_is_refused(installed: Path) -> None:
    present = pins(RUNTIME_LOCK)
    del present["truststore"]
    materialise(installed, present)
    result = run_fixture(installed, "--profile", "runtime")
    assert result.code == 1
    assert "not installed: truststore==0.10.4" in result.stderr


def test_a_runtime_version_drift_is_refused(installed: Path) -> None:
    present = pins(RUNTIME_LOCK)
    present["jsonschema-rs"] = "0.57.0"
    materialise(installed, present)
    result = run_fixture(installed, "--profile", "runtime")
    assert result.code == 1
    assert "version drift: jsonschema-rs installed 0.57.0, lock 0.57.1" in result.stderr


# --- auto selection ------------------------------------------------------------

def test_auto_selects_the_runtime_profile_for_the_runtime_set(installed: Path) -> None:
    materialise(installed, pins(RUNTIME_LOCK))
    result = run_fixture(installed, "--profile", "auto")
    assert result.code == 0, result.stderr
    assert result.stdout == (
        "auto selected the runtime profile\n"
        "environment matches the lock (18 pinned distributions)\n"
    )


def test_auto_selects_the_development_profile_for_the_development_set(installed: Path) -> None:
    materialise(installed, pins(DEV_LOCK))
    result = run_fixture(installed, "--profile", "auto")
    assert result.code == 0, result.stderr
    assert result.stdout.startswith("auto selected the dev profile\n")


def test_auto_refuses_a_partial_development_install(installed: Path) -> None:
    """Runtime closure plus the test runner, but not its own closure.

    This installs cleanly and runs the tests, which is exactly why it has to be
    refused: it is neither approved profile.
    """
    present = pins(RUNTIME_LOCK)
    present["pytest"] = "8.4.2"
    materialise(installed, present)
    result = run_fixture(installed, "--profile", "auto")
    assert result.code == 1
    assert "environment matches no approved profile:" in result.stderr
    assert "dev: " in result.stderr
    assert "runtime: unexpected" in result.stderr


def test_auto_refuses_an_environment_that_matches_no_profile(installed: Path) -> None:
    present = pins(RUNTIME_LOCK)
    present["httpx"] = "0.28.1"
    materialise(installed, present)
    result = run_fixture(installed, "--profile", "auto")
    assert result.code == 1
    assert "environment matches no approved profile:" in result.stderr
    assert "unexpected 1 (httpx)" in result.stderr


def test_auto_refuses_version_drift_against_both_locks(installed: Path) -> None:
    present = pins(DEV_LOCK)
    present["pydantic-ai-slim"] = "2.48.0"
    materialise(installed, present)
    result = run_fixture(installed, "--profile", "auto")
    assert result.code == 1
    assert "environment matches no approved profile:" in result.stderr
    assert "version drift 1 (pydantic-ai-slim)" in result.stderr


def test_auto_reports_no_match_for_an_empty_environment(installed: Path) -> None:
    result = run_fixture(installed, "--profile", "auto")
    assert result.code == 1
    assert "missing" in result.stderr


# --- fail-closed behaviour through the real entry point -------------------------

_MINIMAL_LOCK = "pydantic-ai-slim==2.47.0\njsonschema-rs==0.57.1\n"
_MINIMAL_DIRECT = "pydantic-ai-slim==2.47.0\njsonschema-rs==0.57.1\n"


def test_a_missing_lock_fails_closed(installed: Path, fake_package) -> None:
    root = fake_package(lock=None, requirements=_MINIMAL_DIRECT)
    materialise(installed, {"pydantic-ai-slim": "2.47.0", "jsonschema-rs": "0.57.1"})
    result = run_fixture(
        installed, "--profile", "dev", verifier_path=root / "scripts" / "verify_environment.py"
    )
    assert result.code == 1
    assert "invalid lock: missing lock file" in result.stderr


def test_a_malformed_lock_fails_closed(installed: Path, fake_package) -> None:
    root = fake_package(lock="pydantic-ai-slim>=2.47.0\n", requirements=_MINIMAL_DIRECT)
    materialise(installed, {"pydantic-ai-slim": "2.47.0"})
    result = run_fixture(
        installed, "--profile", "dev", verifier_path=root / "scripts" / "verify_environment.py"
    )
    assert result.code == 1
    assert "invalid lock:" in result.stderr
    assert "expected name==version" in result.stderr


def test_a_conflicting_duplicate_lock_fails_closed(installed: Path, fake_package) -> None:
    root = fake_package(
        lock="pydantic-ai-slim==2.47.0\npydantic-ai-slim==2.48.0\n",
        requirements=_MINIMAL_DIRECT,
    )
    materialise(installed, {"pydantic-ai-slim": "2.47.0"})
    result = run_fixture(
        installed, "--profile", "dev", verifier_path=root / "scripts" / "verify_environment.py"
    )
    assert result.code == 1
    assert "conflicting duplicate pin" in result.stderr


def test_a_direct_pin_that_drifted_from_the_lock_is_refused(
    installed: Path, fake_package
) -> None:
    root = fake_package(
        lock=_MINIMAL_LOCK,
        requirements="pydantic-ai-slim==2.48.0\njsonschema-rs==0.57.1\n",
    )
    materialise(installed, {"pydantic-ai-slim": "2.47.0", "jsonschema-rs": "0.57.1"})
    result = run_fixture(
        installed, "--profile", "dev", verifier_path=root / "scripts" / "verify_environment.py"
    )
    assert result.code == 1
    assert "direct dependency disagrees with requirements.lock" in result.stderr
    assert "pydantic-ai-slim==2.48.0 vs 2.47.0" in result.stderr


def test_a_direct_pin_missing_from_the_lock_is_refused(installed: Path, fake_package) -> None:
    root = fake_package(
        lock=_MINIMAL_LOCK,
        requirements=_MINIMAL_DIRECT + "extra-direct==1.0.0\n",
    )
    materialise(installed, {"pydantic-ai-slim": "2.47.0", "jsonschema-rs": "0.57.1"})
    result = run_fixture(
        installed, "--profile", "dev", verifier_path=root / "scripts" / "verify_environment.py"
    )
    assert result.code == 1
    assert "direct dependency missing from requirements.lock: extra-direct==1.0.0" in result.stderr


def test_the_runtime_profile_checks_the_runtime_direct_pins(
    installed: Path, fake_package
) -> None:
    """The runtime profile reads requirements.txt, never the development one."""
    root = fake_package(
        lock=_MINIMAL_LOCK,
        runtime_lock=_MINIMAL_LOCK,
        requirements=_MINIMAL_DIRECT,
        requirements_dev="-r requirements.txt\npytest==8.4.2\n",
    )
    materialise(installed, {"pydantic-ai-slim": "2.47.0", "jsonschema-rs": "0.57.1"})
    result = run_fixture(
        installed,
        "--profile",
        "runtime",
        verifier_path=root / "scripts" / "verify_environment.py",
    )
    assert result.code == 0, result.stderr


def test_the_runtime_profile_refuses_a_runtime_direct_drift(
    installed: Path, fake_package
) -> None:
    root = fake_package(
        lock=_MINIMAL_LOCK,
        runtime_lock="pydantic-ai-slim==2.47.0\njsonschema-rs==0.57.0\n",
        requirements=_MINIMAL_DIRECT,
    )
    materialise(installed, {"pydantic-ai-slim": "2.47.0", "jsonschema-rs": "0.57.0"})
    result = run_fixture(
        installed,
        "--profile",
        "runtime",
        verifier_path=root / "scripts" / "verify_environment.py",
    )
    assert result.code == 1
    assert "direct dependency disagrees with requirements-runtime.lock" in result.stderr


# --- the capability boundary ---------------------------------------------------

def test_verifier_imports_exclude_installer_and_network_libraries() -> None:
    """Regression guard for direct imports; this is not an execution sandbox."""
    tree = ast.parse(VERIFIER_PATH.read_text(encoding="utf-8"), filename=str(VERIFIER_PATH))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            imported.add(node.module.split(".")[0])
    forbidden = {
        "subprocess",
        "socket",
        "ssl",
        "http",
        "urllib",
        "ftplib",
        "pip",
        "requests",
        "venv",
        "shutil",
    }
    assert not imported & forbidden
    assert imported <= set(sys.stdlib_module_names)


def test_the_verifier_offers_no_lock_path_option() -> None:
    """The lock for a profile is fixed beside the package, never caller-supplied."""
    options = {
        option
        for action in verifier.build_parser()._actions
        for option in action.option_strings
    }
    assert options == {"-h", "--help", "--profile"}


def test_the_profile_choices_are_the_frozen_three() -> None:
    assert verifier.PROFILE_CHOICES == ("dev", "runtime", "auto")
    assert verifier.build_parser().parse_args([]).profile == "dev"
