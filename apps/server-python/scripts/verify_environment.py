"""Check the reference environment against fixed source locks; never install or connect."""
import importlib.metadata
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]


def name(value):
    return re.sub(r"[-_.]+", "-", value).lower()


def verify(*, worker=False):
    expected = {}
    for line in (ROOT / ("requirements-worker.lock" if worker else "requirements.lock")).read_text().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        match = re.fullmatch(r"([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+!-]+)", line)
        if not match or name(match[1]) in expected:
            raise ValueError("Invalid control-plane dependency lock.")
        expected[name(match[1])] = match[2]
    if not expected:
        raise ValueError("Empty control-plane dependency lock.")
    installed = {}
    for distribution in importlib.metadata.distributions():
        key = name(distribution.metadata["Name"])
        if key in ("pip", "setuptools", "wheel"):
            continue
        if key in installed:
            raise ValueError("Duplicate installed distribution.")
        installed[key] = distribution.version
    if installed != expected:
        raise ValueError("Control-plane environment differs from requirements.lock; bootstrap it first.")
    for filename in ("requirements.txt", "requirements-dev.txt"):
        for line in (ROOT / filename).read_text().splitlines():
            if not line or line.startswith("#") or line == "-r requirements.txt":
                continue
            match = re.fullmatch(r"([A-Za-z0-9_.-]+)(?:\[[a-z,]+\])?==([A-Za-z0-9_.+!-]+)", line)
            if not match or expected.get(name(match[1])) != match[2]:
                raise ValueError("Direct dependency differs from the lock.")
    return len(expected)


if __name__ == "__main__":
    try:
        if sys.argv[1:] not in ([], ['--worker']): raise ValueError('Unknown environment profile.')
        print(f"Control-plane environment matches {verify(worker=sys.argv[1:] == ['--worker'])} locked distributions.")
    except (ValueError, OSError, KeyError):
        print("Control-plane dependency verification failed.", file=sys.stderr)
        raise SystemExit(1) from None
