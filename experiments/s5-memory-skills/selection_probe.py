"""Exercise the control selection API with the unchanged synthetic held-out tasks."""

import asyncio
import json
from dataclasses import asdict

from probe import load_fixtures
from selection_port import OfflineSelectionPort, SelectionPort, TaskBinding
from study import OfflineControl, Principal, Rejected, Scope, SkillReference, require


async def run():
    training, cases = load_fixtures()
    control = OfflineControl(training["source"])
    owner = Principal("owner", "owner")
    tasks = {case["task"]["id"]: case["task"] for case in cases}
    loader_calls = 0

    async def load_target(task_id, run_id):
        nonlocal loader_calls
        loader_calls += 1
        task = tasks[task_id]
        require(task["run_id"] == run_id, "unknown_run")
        return TaskBinding(task_id, run_id, 1, Scope(**task["scope"]), True)

    port: SelectionPort = OfflineSelectionPort(control, load_target)
    skill = control.propose(training["correction"], owner)
    control.review_lesson(skill.lesson_id, owner, 1, True)
    skill = control.transition(skill.id, owner, 1, "verified", skill.review_digest())
    audit_before = len(control.audit)
    results = []
    receipts = []
    for case in cases:
        task = case["task"]
        selected = await port.select(task["id"], task["run_id"], task["query"])
        current = await port.revalidate(task["id"], task["run_id"], task["query"],
                                        selected.receipt)
        receipts.append(selected.receipt)
        reference = current.skills[0].reference
        fixture_ref = SkillReference(reference.id, reference.revision, reference.reviewed_digest)
        try:
            observed = control.execute(task, fixture_ref)
            passed = observed["output_csv"] == case.get("expected_csv")
            result = {"task_id": task["id"], "passed": passed,
                      "expected_csv": case.get("expected_csv"), "result": observed}
        except Rejected as error:
            passed = str(error) == case.get("expected_error")
            result = {"task_id": task["id"], "passed": passed,
                      "expected_error": case.get("expected_error"), "error": str(error),
                      "consumed_skill": error.used_skills}
        require(passed, "heldout_failed")
        results.append(result)
    require(len(control.audit) == audit_before, "selection_mutated_store")
    task = cases[0]["task"]
    denied = {}
    for state in ("suspended", "verified", "revoked"):
        skill = control.transition(skill.id, owner, skill.revision, state, skill.review_digest())
        try:
            await port.revalidate(task["id"], task["run_id"], task["query"], receipts[0])
        except Rejected as error:
            require(str(error) == "selection_changed", "unexpected_revalidation_error")
            denied[state] = str(error)
        else:
            raise Rejected("stale_selection_reused")
    lesson = control.lessons[skill.lesson_id]
    control.delete_lesson(lesson.id, owner, lesson.revision)
    try:
        await port.revalidate(task["id"], task["run_id"], task["query"], receipts[0])
    except Rejected as error:
        require(str(error) == "selection_changed", "unexpected_deletion_error")
        denied["deleted"] = str(error)
    else:
        raise Rejected("deleted_selection_reused")
    return {
        "schema": "openbot.s5-selection-probe/v1",
        "heldout_passed": len(results), "heldout_total": len(cases), "cases": results,
        "selected_receipt": asdict(receipts[0]), "stale_receipt_denials": denied,
        "target_loader_calls": loader_calls,
        "grants_after": sorted(control.grants), "selection_audit_writes": 0,
        "limits": "Synthetic control adapter and arithmetic interpreter; no live model or product hook.",
    }


if __name__ == "__main__":
    print(json.dumps(asyncio.run(run()), indent=2))
