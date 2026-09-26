"""Derive/check the product closure from real installed metadata and existing reviewed pins."""

from importlib import metadata
from pathlib import Path
import re
import sys
from packaging.requirements import Requirement

ROOT = Path(__file__).resolve().parents[1]


def roots(path):
    for line in path.read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        if line.startswith("-r "):
            yield from roots(path.parent / line[3:])
        else:
            yield Requirement(line)


def normalized(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def render():
    reviewed = {}
    for line in (ROOT / "requirements-worker.lock").read_text().splitlines():
        if line and not line.startswith("#"):
            key, version = line.split("==")
            reviewed[normalized(key)] = version
    pending = list(roots(ROOT / "requirements-product.txt"))
    visited = set()
    required = {}
    while pending:
        requirement = pending.pop()
        name = normalized(requirement.name)
        extras = frozenset(requirement.extras)
        if (name, extras) in visited:
            continue
        visited.add((name, extras))
        version = metadata.version(name)
        if reviewed.get(name) != version or version not in requirement.specifier:
            raise ValueError(f"Dependency no longer matches reviewed Worker pin: {name}")
        required[name] = version
        for raw in metadata.requires(name) or []:
            child = Requirement(raw)
            if child.marker is None or any(
                child.marker.evaluate({"extra": extra}) for extra in {"", *extras}
            ):
                pending.append(child)
    forbidden = {"pytest", "iniconfig", "pluggy", "pygments", "ruff", "mypy", "hatchling"}
    if required.keys() & forbidden:
        raise ValueError("Product closure contains contributor tooling")
    return (
        "# Runtime metadata closure from reviewed Worker pins; derive-product-lock.py --check.\n"
        + "".join(f"{name}=={version}\n" for name, version in sorted(required.items()))
    )


if __name__ == "__main__":
    output = render()
    if sys.argv[1:] == ["--check"]:
        assert (ROOT / "requirements-product.lock").read_text() == output, (
            "Product dependency lock is stale"
        )
        print(
            f"Product closure matches {len(output.splitlines()) - 1} external runtime distributions."
        )
    elif not sys.argv[1:]:
        (ROOT / "requirements-product.lock").write_text(output)
    else:
        raise SystemExit("Only --check is supported")
