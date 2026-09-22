#!/usr/bin/env python3
"""Verify that the installed environment and the declared dependencies match the lock.

Two drift checks, both cheap and dependency-free:

1. every ``name==version`` in ``requirements.lock`` is installed at that exact version,
   and nothing else is installed except ``pip``;
2. every direct pin in ``requirements.txt`` appears in the lock at the same version, so
   the declared direct dependencies cannot silently diverge from the frozen closure.

Exit code is non-zero on drift, with the differences printed.
"""

from __future__ import annotations

import re
import sys
from importlib import metadata
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
LOCK_FILE = PACKAGE_ROOT / "requirements.lock"
DIRECT_FILES = ("requirements.txt", "requirements-dev.txt")
IGNORED = {"pip", "setuptools", "wheel"}


def canonical(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).strip().lower()


def parse_pins(lines: list[str]) -> dict[str, str]:
    pins: dict[str, str] = {}
    for raw in lines:
        line = raw.split("#", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        name, separator, version = line.partition("==")
        if not separator:
            raise SystemExit(f"unsupported requirement line (expected name==version): {raw!r}")
        pins[canonical(name)] = version.strip()
    return pins


def main() -> int:
    if not LOCK_FILE.is_file():
        print(f"missing lock file: {LOCK_FILE}", file=sys.stderr)
        return 1
    lock = parse_pins(LOCK_FILE.read_text(encoding="utf-8").splitlines())

    problems: list[str] = []
    for name, version in sorted(lock.items()):
        try:
            installed = metadata.version(name)
        except metadata.PackageNotFoundError:
            problems.append(f"not installed: {name}=={version}")
            continue
        if installed != version:
            problems.append(f"version drift: {name} installed {installed}, lock {version}")

    installed_names = {
        canonical(dist.metadata["Name"])
        for dist in metadata.distributions()
        if dist.metadata["Name"]
    }
    for name in sorted(installed_names - set(lock) - IGNORED):
        problems.append(f"unexpected installed distribution: {name}")

    direct: dict[str, str] = {}
    for filename in DIRECT_FILES:
        path = PACKAGE_ROOT / filename
        if path.is_file():
            direct.update(parse_pins(path.read_text(encoding="utf-8").splitlines()))
    for name, version in sorted(direct.items()):
        if name not in lock:
            problems.append(f"direct dependency missing from the lock: {name}=={version}")
        elif lock[name] != version:
            problems.append(
                f"direct dependency disagrees with the lock: {name}=={version} vs {lock[name]}"
            )

    if problems:
        print("environment does not match the lock:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        print(
            "re-resolve deliberately and refresh requirements.lock if the change is intended",
            file=sys.stderr,
        )
        return 1

    print(f"environment matches the lock ({len(lock)} pinned distributions)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
