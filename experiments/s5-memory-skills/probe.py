"""Run the offline S5 journey and optionally retain synthetic review evidence."""

import argparse
import json
import platform
from dataclasses import asdict
from pathlib import Path

from study import (OfflineControl, Principal, Rejected, canonical, check_split,
                   digest, evaluate, require)

ROOT = Path(__file__).resolve().parent


def load_fixtures():
    training = json.loads((ROOT / "fixtures/training.json").read_text())
    cases = json.loads((ROOT / "fixtures/held-out.json").read_text())
    return training, cases


def run_study(training=None, cases=None):
    if training is None or cases is None:
        training, cases = load_fixtures()
    check_split(training["source"], cases)
    control = OfflineControl(training["source"])
    owner = Principal(control.scope.owner_id, "owner")
    initial_grants = sorted(control.grants)
    phases = {"baseline": evaluate(control, cases)}
    skill = control.propose(training["correction"], owner)
    candidate = {**asdict(skill), "review_digest": skill.review_digest()}
    query = cases[0]["task"]["query"]
    require(control.retrieve(control.scope, query) == [], "pending_memory_visible")
    phases["pending"] = evaluate(control, cases)
    control.review_lesson(skill.lesson_id, owner, 1, model_use=True)
    memory = control.retrieve(control.scope, query)
    skill = control.transition(skill.id, owner, skill.revision, "verified", skill.review_digest())
    phases["reviewed"] = evaluate(control, cases)
    old_reference = control.select_skill(control.scope, query)
    try:
        control.admit("network.write")
    except Rejected as error:
        authority_denial = str(error)
    else:
        raise Rejected("authority_increased")
    skill = control.transition(skill.id, owner, skill.revision, "suspended")
    phases["suspended"] = evaluate(control, cases)
    require(control.retrieve(control.scope, query) == [], "suspended_memory_visible")
    skill = control.transition(skill.id, owner, skill.revision, "verified", skill.review_digest())
    phases["resumed"] = evaluate(control, cases)
    try:
        control.execute(cases[0]["task"], old_reference)
    except Rejected as error:
        stale_reference_denial = str(error)
    else:
        raise Rejected("stale_reference_accepted")
    skill = control.transition(skill.id, owner, skill.revision, "revoked")
    phases["revoked"] = evaluate(control, cases)
    require(control.retrieve(control.scope, query) == [], "revoked_memory_visible")
    control.delete_lesson(skill.lesson_id, owner, control.lessons[skill.lesson_id].revision)
    require(not control.lessons and not control.skills, "deletion_failed")
    require(control.retrieve(control.scope, query) == [], "deleted_memory_visible")
    for name, result in phases.items():
        expected = len(cases) if name in {"reviewed", "resumed"} else 0
        require(result["passed"] == expected, "quality_gate_" + name)
    require(sorted(control.grants) == initial_grants, "authority_increased")
    return {
        "schema": "openbot.s5-offline-evidence/v1",
        "interpreter": "decimal-scale-fixture/1",
        "environment": {"python": platform.python_version(), "system": platform.system()},
        "fixture_sha256": digest(canonical({"training": training, "cases": cases})),
        "candidate": candidate, "retrieved_memory": memory,
        "phases": phases,
        "controls": {
            "pending_memory_excluded": True, "suspended_memory_excluded": True,
            "revoked_memory_excluded": True, "authority_denial": authority_denial,
            "grants_before": initial_grants, "grants_after": sorted(control.grants),
            "stale_reference_denial": stale_reference_denial,
            "deleted_lessons": len(control.lessons), "deleted_skills": len(control.skills),
            "tombstones": sorted(control.tombstones),
        },
        "audit": control.audit,
        "limits": [
            "Synthetic deterministic interpreter; no model quality or generalization claim.",
            "Single-process reference checks; no production auth, concurrency or durable storage.",
            "Deletion covers the current fixture store, not original fixtures or exported evidence.",
            "S2 integration and S5 completion remain open.",
        ],
    }


def save_report(report: dict, destination: Path) -> None:
    # A fresh output directory prevents accidental replacement of earlier evidence.
    destination.mkdir(parents=True, exist_ok=False)
    skill_dir = destination / "candidate" / "csv-dollar-to-cent"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(report["candidate"]["markdown"])
    for phase, result in report["phases"].items():
        phase_dir = destination / phase
        phase_dir.mkdir()
        for index, case in enumerate(result["cases"]):
            if "result" in case:
                result_value = case["result"]
                path = phase_dir / f"case-{index + 1}.csv"
                path.write_bytes(result_value["output_csv"].encode())
                actual = path.read_bytes()
                require(digest(actual.decode()) == result_value["sha256"]
                        and len(actual) == result_value["size_bytes"], "export_integrity")
    (destination / "report.json").write_text(json.dumps(report, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    report = run_study()
    if args.output_dir:
        save_report(report, args.output_dir)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
