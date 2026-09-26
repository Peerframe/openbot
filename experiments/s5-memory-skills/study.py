"""Synthetic S5 control fixture. No product imports, model, network, or external effects.

Learning/provenance concepts are inspired by Hermes Agent. This trusted, single-process
fixture exercises proposed contracts; Python object access is not an authentication boundary.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import re
from copy import deepcopy
from dataclasses import asdict, dataclass, replace
from decimal import Decimal


class Rejected(ValueError):
    """A fixture policy or consistency check rejected a request."""

    def __init__(self, reason: str, used_skills: tuple = ()):
        super().__init__(reason)
        self.used_skills = list(used_skills)


def require(condition: bool, reason: str) -> None:
    if not condition:
        raise Rejected(reason)


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def tokens(text: str) -> set[str]:
    # This closed CSV experiment has a declared vocabulary, not a general NLP retriever.
    vocabulary = {"csv", "dollar", "cent", "refund"}
    words = {word.removesuffix("s") for word in re.findall(r"[a-z0-9]+", text.lower())}
    return words & vocabulary


def read_csv(text: str, field: str) -> list[dict[str, str]]:
    require(isinstance(text, str) and len(text.encode()) <= 4096, "csv_size")
    reader = csv.DictReader(io.StringIO(text))
    require(reader.fieldnames == ["id", field], "csv_columns")
    rows = list(reader)
    require(1 <= len(rows) <= 32, "csv_rows")
    seen = set()
    for row in rows:
        require(set(row) == {"id", field}, "csv_columns")
        require(bool(re.fullmatch(r"[a-z0-9-]{1,40}", row["id"] or "")), "csv_id")
        require(row["id"] not in seen, "duplicate_row")
        seen.add(row["id"])
        require(bool(re.fullmatch(r"-?[0-9]{1,8}(?:\.[0-9]{1,4})?", row[field] or "")),
                "csv_decimal")
    return rows


def write_csv(rows: list[dict[str, str]]) -> str:
    output = io.StringIO()
    writer = csv.DictWriter(output, ["id", "amount_cents"], lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue()


@dataclass(frozen=True)
class Scope:
    owner_id: str
    bot_id: str
    workspace_id: str
    task_kind: str


@dataclass(frozen=True)
class Principal:
    owner_id: str
    role: str


@dataclass(frozen=True)
class Source:
    task_id: str
    run_id: str
    artifact_id: str
    artifact_sha256: str
    correction_id: str


@dataclass(frozen=True)
class Lesson:
    id: str
    scope: Scope
    source: Source
    text: str
    state: str = "pending"
    revision: int = 1
    model_use: bool = False


@dataclass(frozen=True)
class Skill:
    id: str
    lesson_id: str
    scope: Scope
    source: Source
    markdown: str
    factor: int
    version: str = "1.0.0"
    state: str = "candidate"
    revision: int = 1

    def review_digest(self) -> str:
        # Bind the interpreter rule and scope as well as the displayed standard document.
        envelope = asdict(self)
        del envelope["state"]
        del envelope["revision"]
        return digest(canonical(envelope))


@dataclass(frozen=True)
class SkillReference:
    id: str
    revision: int
    review_digest: str


class OfflineControl:
    """A small reference state machine; source facts and principals come from the fixture."""

    def __init__(self, source: dict):
        self.source = deepcopy(source)
        self.scope = Scope(**source["scope"])
        self.lessons: dict[str, Lesson] = {}
        self.skills: dict[str, Skill] = {}
        self.reviewed: dict[str, str] = {}
        self.audit: list[dict] = []
        self.tombstones: set[str] = set()
        self.grants = frozenset({"csv.read", "artifact.write"})

    def owner(self, principal: Principal) -> None:
        require(principal == Principal(self.scope.owner_id, "owner"), "owner_required")

    def event(self, action: str, record_id: str, revision: int) -> None:
        # No text, text hash, raw correction, or generated output survives in the audit.
        self.audit.append({"action": action, "id": record_id, "revision": revision})

    def propose(self, correction: dict, principal: Principal) -> Skill:
        self.owner(principal)
        require(set(correction) == {"id", "source", "scope", "lesson", "corrected_csv"},
                "correction_fields")
        require(bool(re.fullmatch(r"[a-z0-9-]{1,64}", correction["id"])), "correction_id")
        require(isinstance(correction["lesson"], str)
                and 1 <= len(correction["lesson"].encode()) <= 2000, "lesson_size")
        require(Scope(**correction["scope"]) == self.scope, "source_scope")
        expected_source = {
            "task_id": self.source["task_id"], "run_id": self.source["run_id"],
            "artifact_id": self.source["artifact_id"],
            "artifact_sha256": self.source["artifact_sha256"],
        }
        require(correction["source"] == expected_source, "source_reference")
        require(self.source["status"] == "completed", "source_not_completed")
        require(self.source["artifact_sha256"] == digest(self.source["artifact_csv"]),
                "artifact_integrity")
        require(self.source["input_sha256"] == digest(self.source["input_csv"]),
                "input_integrity")
        inputs = read_csv(self.source["input_csv"], "amount_dollars")
        original = read_csv(self.source["artifact_csv"], "amount_cents")
        corrected = read_csv(correction["corrected_csv"], "amount_cents")
        require([r["id"] for r in inputs] == [r["id"] for r in original]
                == [r["id"] for r in corrected], "correction_rows")
        require(corrected != original, "no_correction")
        # Induce only a constant decimal scale from two or more nonzero training pairs.
        ratios = set()
        nonzero = 0
        for before, after in zip(inputs, corrected):
            value, target = Decimal(before["amount_dollars"]), Decimal(after["amount_cents"])
            require(target == target.to_integral_value(), "noninteger_target")
            if value:
                nonzero += 1
                ratios.add(target / value)
            else:
                require(target == 0, "inconsistent_correction")
        require(nonzero >= 2 and len(ratios) == 1, "inconsistent_correction")
        ratio = ratios.pop()
        require(ratio == ratio.to_integral_value() and 1 <= ratio <= 1000,
                "unsupported_rule")
        lesson_id, skill_id = "lesson-" + correction["id"], "skill-" + correction["id"]
        require(lesson_id not in self.lessons and lesson_id not in self.tombstones,
                "correction_already_consumed")
        source = Source(**expected_source, correction_id=correction["id"])
        lesson = Lesson(lesson_id, self.scope, source, correction["lesson"])
        factor = int(ratio)
        markdown = (
            "---\nname: csv-dollar-to-cent\n"
            "description: Convert scoped CSV dollar amounts into integer cent amounts.\n"
            "---\n\n" + lesson.text + "\n\n"
            f"Multiply each decimal amount_dollars value by {factor}. "
            "Require an exact integer result; preserve row IDs and order. "
            "Reject sub-cent values. Publish only through existing authorized actions.\n"
        )
        skill = Skill(skill_id, lesson_id, self.scope, source, markdown, factor)
        self.lessons[lesson_id], self.skills[skill_id] = lesson, skill
        self.event("lesson.proposed", lesson_id, 1)
        self.event("skill.proposed", skill_id, 1)
        return skill

    def review_lesson(self, lesson_id: str, principal: Principal, revision: int,
                      model_use: bool = False) -> Lesson:
        self.owner(principal)
        lesson = self.lessons[lesson_id]
        require(lesson.revision == revision and lesson.state == "pending", "lesson_conflict")
        require(type(model_use) is bool, "model_use")
        lesson = replace(lesson, state="reviewed", revision=revision + 1, model_use=model_use)
        self.lessons[lesson_id] = lesson
        self.event("lesson.reviewed", lesson_id, lesson.revision)
        return lesson

    def transition(self, skill_id: str, principal: Principal, revision: int,
                   state: str, reviewed_digest: str = "") -> Skill:
        self.owner(principal)
        skill = self.skills[skill_id]
        require(skill.revision == revision, "skill_conflict")
        permitted = {"candidate": {"verified", "revoked"},
                     "verified": {"suspended", "revoked"},
                     "suspended": {"verified", "revoked"}, "revoked": set()}
        require(state in permitted[skill.state], "invalid_transition")
        if state == "verified":
            require(reviewed_digest == skill.review_digest(), "review_digest")
            self.reviewed[skill_id] = reviewed_digest
        else:
            self.reviewed.pop(skill_id, None)
        if state in {"suspended", "revoked"} or skill.state == "suspended":
            lesson = self.lessons[skill.lesson_id]
            lesson = replace(lesson, revision=lesson.revision + 1)
            self.lessons[lesson.id] = lesson
            self.event("lesson.eligibility_changed", lesson.id, lesson.revision)
        skill = replace(skill, state=state, revision=revision + 1)
        self.skills[skill_id] = skill
        self.event("skill." + state, skill_id, skill.revision)
        return skill

    def delete_lesson(self, lesson_id: str, principal: Principal, revision: int) -> None:
        self.owner(principal)
        lesson = self.lessons[lesson_id]
        require(lesson.revision == revision, "lesson_conflict")
        # Conservative experiment policy: remove derived text/rules too, preserving only IDs.
        for skill_id, skill in list(self.skills.items()):
            if skill.lesson_id == lesson_id:
                del self.skills[skill_id]
                self.reviewed.pop(skill_id, None)
                self.tombstones.add(skill_id)
                self.event("skill.deleted", skill_id, skill.revision + 1)
        del self.lessons[lesson_id]
        self.tombstones.add(lesson_id)
        self.event("lesson.deleted", lesson_id, revision + 1)

    def retrieve(self, scope: Scope, query: str, limit: int = 4) -> list[dict]:
        require(1 <= limit <= 8 and type(limit) is int, "retrieval_limit")
        require(isinstance(query, str) and len(query.encode()) <= 512, "query_size")
        scored = []
        for lesson in self.lessons.values():
            if lesson.scope != scope or lesson.state != "reviewed" or not lesson.model_use:
                continue
            if any(skill.lesson_id == lesson.id and skill.state in {"suspended", "revoked"}
                   for skill in self.skills.values()):
                continue
            score = len(tokens(query) & tokens(lesson.text))
            if score >= 2:
                scored.append((score, lesson.id, lesson))
        result = []
        for score, _, lesson in sorted(scored, key=lambda item: (-item[0], item[1]))[:limit]:
            item = {"id": lesson.id, "revision": lesson.revision, "content": lesson.text,
                    "source": asdict(lesson.source), "scope": asdict(lesson.scope),
                    "score": score}
            if len(canonical(result + [item]).encode()) > 10 * 1024:
                break
            result.append(item)
        return result

    def select_skill(self, scope: Scope, query: str) -> SkillReference | None:
        require(isinstance(query, str) and len(query.encode()) <= 512, "query_size")
        eligible = []
        for skill in self.skills.values():
            if (skill.scope == scope and skill.state == "verified"
                    and self.reviewed.get(skill.id) == skill.review_digest()
                    and skill.lesson_id in self.lessons):
                score = len(tokens(query) & tokens(skill.markdown))
                if score >= 2:
                    eligible.append((score, skill.id, skill))
        if not eligible:
            return None
        skill = sorted(eligible, key=lambda item: (-item[0], item[1]))[0][2]
        return SkillReference(skill.id, skill.revision, skill.review_digest())

    def admit(self, capability: str) -> None:
        require(capability in self.grants, "capability_denied")

    def execute(self, task: dict, reference: SkillReference | None = None) -> dict:
        """The deterministic interpreter never receives the held-out answer key."""
        require(set(task) == {"id", "run_id", "scope", "query", "input_csv"}, "task_fields")
        scope = Scope(**task["scope"])
        require(scope.owner_id == self.scope.owner_id, "task_owner")
        self.admit("csv.read")
        self.admit("artifact.write")
        factor = None
        if reference:
            skill = self.skills.get(reference.id)
            require(skill is not None and skill.scope == scope
                    and skill.state == "verified" and skill.revision == reference.revision
                    and self.reviewed.get(skill.id) == reference.review_digest
                    and skill.review_digest() == reference.review_digest
                    and self.select_skill(scope, task["query"]) == reference, "skill_changed")
            factor = skill.factor
        rows = read_csv(task["input_csv"], "amount_dollars")
        output = []
        for row in rows:
            value = row["amount_dollars"]
            if factor is not None:
                scaled = Decimal(value) * factor
                if scaled != scaled.to_integral_value():
                    raise Rejected("subcent_value", (asdict(reference),))
                value = str(int(scaled))
            output.append({"id": row["id"], "amount_cents": value})
        content = write_csv(output)
        return {
            "task_id": task["id"], "run_id": task["run_id"], "scope": asdict(scope),
            "output_csv": content, "sha256": digest(content), "size_bytes": len(content.encode()),
            "used_skills": [asdict(reference)] if reference else [],
            "grants": sorted(self.grants),
        }


def check_split(source: dict, cases: list[dict]) -> None:
    require(1 <= len(cases) <= 16, "evaluation_size")
    training_ids = {row["id"] for row in read_csv(source["input_csv"], "amount_dollars")}
    seen_tasks, seen_runs, seen_rows = {source["task_id"]}, {source["run_id"]}, set(training_ids)
    for case in cases:
        task = case["task"]
        rows = read_csv(task["input_csv"], "amount_dollars")
        ids = {row["id"] for row in rows}
        require(task["id"] not in seen_tasks and task["run_id"] not in seen_runs
                and not ids & seen_rows, "evaluation_overlap")
        require(task["input_csv"] != source["input_csv"], "evaluation_overlap")
        seen_tasks.add(task["id"])
        seen_runs.add(task["run_id"])
        seen_rows.update(ids)


def evaluate(control: OfflineControl, cases: list[dict]) -> dict:
    records = []
    for case in cases:
        task = case["task"]
        reference = control.select_skill(Scope(**task["scope"]), task["query"])
        try:
            result = control.execute(task, reference)
            correct = result["output_csv"] == case.get("expected_csv")
            records.append({"id": task["id"], "passed": correct,
                            "expected_csv": case.get("expected_csv"), "result": result})
        except Rejected as error:
            records.append({"id": task["id"], "passed": str(error) == case.get("expected_error"),
                            "expected_error": case.get("expected_error"),
                            "error": str(error), "used_skills": error.used_skills})
        records[-1]["selected_skills"] = [asdict(reference)] if reference else []
    return {"passed": sum(record["passed"] for record in records),
            "total": len(records), "cases": records}
