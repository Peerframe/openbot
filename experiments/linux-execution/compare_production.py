"""Compare root-supplied real production snapshots; no production connection here."""
import argparse
import json
from pathlib import Path
import re


def canonical(value):
    if set(value) != {"containers", "firewallSha256"}:
        raise ValueError("snapshot must contain containers and firewallSha256")
    containers = value["containers"]
    if not isinstance(containers, list):
        raise ValueError("containers must be a list")
    normalized = {}
    for row in containers:
        if set(row) != {"id", "startedAt", "status"} or not all(type(v) is str and v for v in row.values()):
            raise ValueError("invalid container observation")
        if re.fullmatch(r"[0-9a-f]{64}", row["id"]) is None or row["id"] in normalized:
            raise ValueError("invalid or duplicated immutable container ID")
        normalized[row["id"]] = (row["startedAt"], row["status"])
    firewall = value["firewallSha256"]
    if not isinstance(firewall, dict) or not firewall or not all(
        type(k) is str and k and type(v) is str and re.fullmatch(r"[0-9a-f]{64}", v)
        for k, v in firewall.items()
    ):
        raise ValueError("actual named firewall hashes are required")
    return normalized, firewall


def compare(before, after):
    left, right = canonical(before), canonical(after)
    if left != right:
        raise ValueError("production container identity/start/status or firewall rules changed")
    return {"productionUnchanged": True, "containerCount": len(left[0]),
            "firewallSnapshots": sorted(left[1])}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("before", type=Path); parser.add_argument("after", type=Path)
    args = parser.parse_args()
    for path in (args.before, args.after):
        if path.stat().st_size > 1024 * 1024:
            raise ValueError("snapshot too large")
    print(json.dumps(compare(json.loads(args.before.read_text()), json.loads(args.after.read_text()))))
