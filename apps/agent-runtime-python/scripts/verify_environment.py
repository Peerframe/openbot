#!/usr/bin/env python3
"""Verify that the installed environment matches one of the approved dependency locks.

Two profiles are approved, and either can be verified directly:

``--profile dev`` (the default)
    ``requirements.lock``: every ``name==version`` is installed at exactly that
    version, nothing else is present except ``pip``/``setuptools``/``wheel``, and
    every direct pin in ``requirements.txt``/``requirements-dev.txt`` appears in
    the lock at the same version.

``--profile runtime``
    The same checks against ``requirements-runtime.lock`` and the direct runtime
    pins in ``requirements.txt``. This is the profile a production image
    installs; it deliberately excludes the test tooling.

``--profile auto``
    Selects a profile by matching the installed distributions against a *whole*
    lock, then runs that profile's checks. It succeeds only on an exact match: a
    partial development install, a missing runtime pin, a version drift and an
    extra distribution are all the same class of problem, namely that the
    environment is not one this package approved.

The module never installs anything, never touches the network and never accepts a
caller-supplied lock path -- the lock for a profile is a fixed file beside this
package. Lock files are parsed strictly and fail closed: an unparseable,
option-bearing or conflicting entry is an error, never a silently skipped line.

Exit status is ``0`` on a match, ``1`` for any lock or drift problem, and ``2``
for an invalid ``--profile`` value (argparse's documented behaviour).
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from importlib import metadata
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
DEV_LOCK_FILE = PACKAGE_ROOT / "requirements.lock"
RUNTIME_LOCK_FILE = PACKAGE_ROOT / "requirements-runtime.lock"

# Distributions that an interpreter's own tooling owns. They are exempt in both
# directions: `python -m venv` provisions pip, and setuptools/wheel may appear in
# older interpreters, so their presence is not drift and their absence is not a
# missing pin.
IGNORED = {"pip", "setuptools", "wheel"}

PROFILE_DEV = "dev"
PROFILE_RUNTIME = "runtime"
PROFILE_AUTO = "auto"
PROFILE_CHOICES = (PROFILE_DEV, PROFILE_RUNTIME, PROFILE_AUTO)

# A pin is `name==version`. The name is a distribution name (no extras, no
# brackets, no marker) and the version is a single token. Anything else -- an
# option line, an extras request, a range, a trailing environment marker -- is a
# malformed lock entry and is refused rather than partially honoured.
_NAME_PATTERN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$")
_VERSION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.!+_-]*$")

# How many names of one category are printed before the list is elided. The
# Server runs this verifier under a bounded output buffer, so the report has to
# stay small enough to be useful rather than truncated by the caller.
_NAMES_SHOWN = 6


class LockError(Exception):
    """A lock file is missing, unparseable, or internally inconsistent."""


@dataclass(frozen=True)
class Profile:
    """One approved environment: its frozen closure and its declared direct pins."""

    name: str
    lock_file: Path
    direct_files: tuple[str, ...]


DEV_PROFILE = Profile(
    PROFILE_DEV, DEV_LOCK_FILE, ("requirements.txt", "requirements-dev.txt")
)
RUNTIME_PROFILE = Profile(PROFILE_RUNTIME, RUNTIME_LOCK_FILE, ("requirements.txt",))
PROFILE_SPECS = {profile.name: profile for profile in (DEV_PROFILE, RUNTIME_PROFILE)}


def canonical(name: str) -> str:
    """Normalise a distribution name the way the packaging specifications do."""
    return re.sub(r"[-_.]+", "-", name).strip().lower()


def parse_pins(path: Path, *, allow_options: bool) -> dict[str, str]:
    """Parse a ``name==version`` list, failing closed on anything else.

    ``allow_options`` exists because the *direct* requirement files legitimately
    carry a ``-r`` include line, while a lock file is a list of pins and nothing
    else. Duplicate entries are refused outright: a distribution pinned twice is
    never correct, and it is reported as a conflict when the versions disagree.
    """
    if not path.is_file():
        raise LockError(f"missing lock file: {path}")

    pins: dict[str, str] = {}
    for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        if line.startswith("-"):
            if allow_options:
                continue
            raise LockError(
                f"{path.name}:{number}: a lock lists pins only, not pip options: {raw.strip()!r}"
            )
        name, separator, version = line.partition("==")
        if not separator:
            raise LockError(
                f"{path.name}:{number}: expected name==version, got {raw.strip()!r}"
            )
        name = name.strip()
        version = version.strip()
        if not _NAME_PATTERN.match(name) or not _VERSION_PATTERN.match(version):
            raise LockError(
                f"{path.name}:{number}: expected a bare name==version pin, "
                f"got {raw.strip()!r}"
            )
        key = canonical(name)
        previous = pins.get(key)
        if previous is not None:
            if previous != version:
                raise LockError(
                    f"{path.name}:{number}: conflicting duplicate pin for {key}: "
                    f"{previous} and {version}"
                )
            raise LockError(f"{path.name}:{number}: duplicate pin for {key}=={version}")
        pins[key] = version

    if not pins:
        raise LockError(f"{path.name}: no pinned distributions found")
    return pins


def installed_distributions() -> tuple[dict[str, str], list[str]]:
    """Return the installed distributions, plus any inconsistency found.

    Two installs of the same distribution at different versions leave the
    environment ill-defined, so that is reported rather than silently resolved
    in favour of whichever was discovered last.
    """
    observed: dict[str, str] = {}
    problems: list[str] = []
    for distribution in metadata.distributions():
        name = distribution.metadata["Name"]
        if not name:
            continue
        key = canonical(name)
        version = distribution.version
        previous = observed.get(key)
        if previous is not None and previous != version:
            problems.append(
                f"the same distribution is installed twice at different versions: "
                f"{key} ({previous} and {version})"
            )
            continue
        observed[key] = version
    return observed, problems


def _declared_direct(profile: Profile) -> tuple[dict[str, tuple[str, str]], list[str]]:
    """Read the profile's direct declarations as ``name -> (version, file)``."""
    declared: dict[str, tuple[str, str]] = {}
    problems: list[str] = []
    for filename in profile.direct_files:
        path = PACKAGE_ROOT / filename
        if not path.is_file():
            continue
        for name, version in parse_pins(path, allow_options=True).items():
            previous = declared.get(name)
            if previous is not None and previous[0] != version:
                problems.append(
                    "direct dependency declared twice with conflicting versions: "
                    f"{name}=={version} in {filename} and "
                    f"{name}=={previous[0]} in {previous[1]}"
                )
                continue
            declared[name] = (version, filename)
    return declared, problems


def _elide(names: list[str]) -> str:
    shown = ", ".join(names[:_NAMES_SHOWN])
    return shown if len(names) <= _NAMES_SHOWN else f"{shown}, and {len(names) - _NAMES_SHOWN} more"


def _summarise(lock: dict[str, str], observed: dict[str, str]) -> list[str]:
    """Compact per-category differences between an observed set and a lock."""
    missing = sorted(name for name in lock if name not in observed)
    drift = sorted(
        name for name in lock if name in observed and observed[name] != lock[name]
    )
    unexpected = sorted(
        name for name in observed if name not in lock and name not in IGNORED
    )
    summary: list[str] = []
    if missing:
        summary.append(f"missing {len(missing)} ({_elide(missing)})")
    if drift:
        summary.append(f"version drift {len(drift)} ({_elide(drift)})")
    if unexpected:
        summary.append(f"unexpected {len(unexpected)} ({_elide(unexpected)})")
    return summary


def check_profile(profile: Profile, observed: dict[str, str] | None = None) -> list[str]:
    """Return every way the environment fails to be this profile. Empty means match."""
    problems: list[str] = []
    lock = parse_pins(profile.lock_file, allow_options=False)
    if observed is None:
        observed, inconsistency = installed_distributions()
        problems.extend(inconsistency)

    for name, version in sorted(lock.items()):
        installed_version = observed.get(name)
        if installed_version is None:
            problems.append(f"not installed: {name}=={version}")
        elif installed_version != version:
            problems.append(
                f"version drift: {name} installed {installed_version}, lock {version}"
            )

    for name in sorted(set(observed) - set(lock) - IGNORED):
        problems.append(f"unexpected installed distribution: {name}")

    declared, declared_problems = _declared_direct(profile)
    problems.extend(declared_problems)
    for name, (version, _filename) in sorted(declared.items()):
        if name not in lock:
            problems.append(
                f"direct dependency missing from {profile.lock_file.name}: {name}=={version}"
            )
        elif lock[name] != version:
            problems.append(
                f"direct dependency disagrees with {profile.lock_file.name}: "
                f"{name}=={version} vs {lock[name]}"
            )
    return problems


def _report_mismatch(profile: Profile, problems: list[str]) -> None:
    print("environment does not match the lock:", file=sys.stderr)
    for problem in problems:
        print(f"  - {problem}", file=sys.stderr)
    print(
        f"re-resolve deliberately and refresh {profile.lock_file.name} "
        "if the change is intended",
        file=sys.stderr,
    )


def _report_success(profile: Profile, lock_size: int) -> None:
    print(f"environment matches the lock ({lock_size} pinned distributions)")


def _run_profile(profile: Profile) -> int:
    try:
        problems = check_profile(profile)
    except LockError as error:
        print(f"invalid lock: {error}", file=sys.stderr)
        return 1
    if problems:
        _report_mismatch(profile, problems)
        return 1
    lock = parse_pins(profile.lock_file, allow_options=False)
    _report_success(profile, len(lock))
    return 0


def _run_auto() -> int:
    observed, inconsistency = installed_distributions()
    if inconsistency:
        print("the installed environment is inconsistent:", file=sys.stderr)
        for problem in inconsistency:
            print(f"  - {problem}", file=sys.stderr)
        return 1

    matches: list[Profile] = []
    lines: list[str] = []
    try:
        for profile in PROFILE_SPECS.values():
            lock = parse_pins(profile.lock_file, allow_options=False)
            summary = _summarise(lock, observed)
            if summary:
                lines.append(f"  {profile.name}: " + "; ".join(summary))
            else:
                matches.append(profile)
    except LockError as error:
        print(f"invalid lock: {error}", file=sys.stderr)
        return 1

    if not matches:
        print("environment matches no approved profile:", file=sys.stderr)
        for line in lines:
            print(line, file=sys.stderr)
        print(
            "install one approved profile: requirements.lock (dev) or "
            "requirements-runtime.lock (runtime)",
            file=sys.stderr,
        )
        return 1
    if len(matches) > 1:
        # Only reachable if the two locks became identical. Auto cannot choose
        # between them, and guessing would hide exactly the ambiguity this mode
        # exists to detect, so it fails closed.
        names = ", ".join(profile.name for profile in matches)
        print(
            f"environment matches more than one approved profile ({names}); "
            "the locks must stay distinguishable for auto to select one",
            file=sys.stderr,
        )
        return 1

    profile = matches[0]
    try:
        problems = check_profile(profile, observed)
    except LockError as error:
        print(f"invalid lock: {error}", file=sys.stderr)
        return 1
    if problems:
        _report_mismatch(profile, problems)
        return 1
    print(f"auto selected the {profile.name} profile")
    lock = parse_pins(profile.lock_file, allow_options=False)
    _report_success(profile, len(lock))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="verify_environment.py",
        description=(
            "Verify the installed distributions against an approved dependency "
            "lock. Reads metadata only: it never installs and never uses the network."
        ),
    )
    parser.add_argument(
        "--profile",
        choices=PROFILE_CHOICES,
        default=PROFILE_DEV,
        help=(
            "dev (default) checks requirements.lock; runtime checks "
            "requirements-runtime.lock; auto selects whichever approved profile "
            "the environment matches exactly"
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.profile == PROFILE_AUTO:
        return _run_auto()
    return _run_profile(PROFILE_SPECS[args.profile])


if __name__ == "__main__":
    raise SystemExit(main())
