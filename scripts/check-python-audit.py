"""Verify full report coverage, independently of advisory-service availability and CLI counts."""

import json
from pathlib import Path
import re
import sys
from typing import Any


def canonical(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def check(lock: str, report: dict[str, Any]) -> int:
    expected = {}
    for line in lock.splitlines():
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"([A-Za-z0-9_.-]+)==([A-Za-z0-9.!+_-]+)", line)
        if not match or canonical(match[1]) in expected:
            raise ValueError("Product audit requires unique, exact external pins")
        expected[canonical(match[1])] = match[2]
    if not expected:
        raise ValueError("An empty audit is not product coverage")
    observed = {}
    for item in report["dependencies"]:
        name = canonical(item["name"])
        if item.get("vulns"):
            ids = ", ".join(sorted({str(v["id"]) for v in item["vulns"]}))
            raise ValueError(f"Known advisories for {name}=={item.get('version')}: {ids}")
        if name in observed or item.get("skip_reason") or "vulns" not in item:
            raise ValueError("Advisory, skip, duplicate or incomplete dependency report")
        observed[name] = item["version"]
    if observed != expected:
        raise ValueError("Audit did not cover exactly the product dependency closure")
    return len(expected)


if __name__ == "__main__":
    count = check(Path(sys.argv[1]).read_text(), json.loads(Path(sys.argv[2]).read_text()))
    print(f"All {count} external Python product pins audited; no known advisories or skips.")
