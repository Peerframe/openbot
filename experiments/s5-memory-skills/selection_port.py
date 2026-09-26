"""Read-only Python control port over the accepted S5 offline selector.

Hermes Agent inspires the reviewed learning/provenance model. This adapter owns no
authorization, persistence, model, or executor. See SELECTION_PORT.md for integration gates.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, field
from typing import Protocol

from study import OfflineControl, Rejected, Scope, Source, canonical, digest, require


def bounded_text(value: str, maximum: int, code: str) -> None:
    require(type(value) is str, code)
    try:
        size = len(value.encode("utf-8"))
    except UnicodeError:
        raise Rejected(code) from None
    require(1 <= size <= maximum and "\0" not in value, code)


def identity(value: str) -> None:
    bounded_text(value, 128, "invalid_identity")
    require(bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]*", value)), "invalid_identity")


def revision(value: int) -> None:
    require(type(value) is int and 1 <= value <= 2**53 - 1, "invalid_revision")


@dataclass(frozen=True)
class TaskBinding:
    """Trusted control projection, loaded afresh; constructing one is not authentication."""

    task_id: str
    run_id: str
    revision: int
    scope: Scope
    active: bool


@dataclass(frozen=True)
class MemoryVersion:
    id: str
    revision: int
    content_sha256: str
    source: Source


@dataclass(frozen=True)
class ReviewedSkillVersion:
    id: str
    version: str
    revision: int
    content_sha256: str
    reviewed_digest: str
    source: Source


@dataclass(frozen=True)
class SelectionReceipt:
    target: TaskBinding
    query_sha256: str
    memories: tuple[MemoryVersion, ...]
    skills: tuple[ReviewedSkillVersion, ...]
    schema: str = field(default="openbot.s5-selection/v1", init=False)


@dataclass(frozen=True)
class MemoryContext:
    reference: MemoryVersion
    content: str


@dataclass(frozen=True)
class SkillContext:
    reference: ReviewedSkillVersion
    markdown: str


@dataclass(frozen=True)
class Selection:
    receipt: SelectionReceipt
    memories: tuple[MemoryContext, ...]
    skills: tuple[SkillContext, ...]

    def to_dict(self) -> dict:
        """A detached serialization projection; it grants no right to use this context."""
        return asdict(self)


class SelectionPort(Protocol):
    async def select(self, task_id: str, run_id: str, query: str) -> Selection: ...

    async def revalidate(self, task_id: str, run_id: str, query: str,
                         receipt: SelectionReceipt) -> Selection: ...


TaskLoader = Callable[[str, str], Awaitable[TaskBinding]]


class OfflineSelectionPort:
    """Reference adapter; reuse existing ranking and lifecycle without a second store.

    The loader must be trusted control code, never a model/plugin-supplied callback.
    Single-threaded fixture reads have no await after loading the target. This does
    not provide a database transaction or a lock spanning later context use/publication.
    """

    def __init__(self, control: OfflineControl, load_task: TaskLoader):
        self._control = control
        self._load_task = load_task

    async def _target(self, task_id: str, run_id: str) -> TaskBinding:
        identity(task_id)
        identity(run_id)
        try:
            target = await self._load_task(task_id, run_id)
        except Exception:
            raise Rejected("target_unavailable") from None
        require(type(target) is TaskBinding and type(target.scope) is Scope, "target_invalid")
        require(target.task_id == task_id and target.run_id == run_id, "target_mismatch")
        revision(target.revision)
        for value in asdict(target.scope).values():
            identity(value)
        require(target.active is True, "target_inactive")
        return target

    def _source(self, reference: Source, scope: Scope) -> None:
        require(type(reference) is Source, "source_invalid")
        for value in (reference.task_id, reference.run_id, reference.artifact_id,
                      reference.correction_id):
            identity(value)
        facts = self._control.source
        # This is the existing single synthetic source, not a new registry or authority.
        try:
            bounded_text(facts["artifact_csv"], 4096, "source_unavailable")
            bounded_text(facts["input_csv"], 4096, "source_unavailable")
            valid = (
                facts["status"] == "completed" and Scope(**facts["scope"]) == scope
                and facts["task_id"] == reference.task_id
                and facts["run_id"] == reference.run_id
                and facts["artifact_id"] == reference.artifact_id
                and facts["artifact_sha256"] == reference.artifact_sha256
                == digest(facts["artifact_csv"])
                and facts["input_sha256"] == digest(facts["input_csv"])
            )
        except (KeyError, TypeError, ValueError, AttributeError):
            valid = False
        require(valid, "source_unavailable")

    async def select(self, task_id: str, run_id: str, query: str) -> Selection:
        bounded_text(query, 512, "invalid_query")
        target = await self._target(task_id, run_id)
        scope = target.scope
        control = self._control
        memories = []
        for row in control.retrieve(scope, query, limit=4):
            lesson = control.lessons.get(row["id"])
            require(lesson is not None and lesson.scope == scope
                    and lesson.state == "reviewed" and lesson.model_use is True
                    and lesson.revision == row["revision"] and lesson.text == row["content"]
                    and asdict(lesson.source) == row["source"]
                    and asdict(scope) == row["scope"], "memory_changed")
            identity(lesson.id)
            revision(lesson.revision)
            bounded_text(lesson.text, 2000, "memory_size")
            self._source(lesson.source, scope)
            reference = MemoryVersion(lesson.id, lesson.revision, digest(lesson.text),
                                      lesson.source)
            memories.append(MemoryContext(reference, lesson.text))
        require(len(memories) <= 4 and len({item.reference.id for item in memories})
                == len(memories), "memory_limit")
        skills = []
        selected = control.select_skill(scope, query)
        if selected is not None:
            skill = control.skills.get(selected.id)
            require(skill is not None and skill.scope == scope and skill.state == "verified"
                    and skill.revision == selected.revision
                    and skill.review_digest() == selected.review_digest
                    == control.reviewed.get(skill.id), "skill_changed")
            lesson = control.lessons.get(skill.lesson_id)
            require(lesson is not None and lesson.scope == scope
                    and lesson.source == skill.source, "skill_source_changed")
            identity(skill.id)
            revision(skill.revision)
            bounded_text(skill.markdown, 12 * 1024, "skill_size")
            bounded_text(skill.version, 64, "skill_version")
            require(bool(re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", skill.version)),
                    "skill_version")
            self._source(skill.source, scope)
            reference = ReviewedSkillVersion(
                skill.id, skill.version, skill.revision, digest(skill.markdown),
                selected.review_digest, skill.source,
            )
            skills.append(SkillContext(reference, skill.markdown))
        receipt = SelectionReceipt(
            target, digest(query), tuple(item.reference for item in memories),
            tuple(item.reference for item in skills),
        )
        result = Selection(receipt, tuple(memories), tuple(skills))
        require(len(canonical(result.to_dict()).encode()) <= 32 * 1024, "selection_size")
        return result

    async def revalidate(self, task_id: str, run_id: str, query: str,
                         receipt: SelectionReceipt) -> Selection:
        require(type(receipt) is SelectionReceipt, "invalid_receipt")
        current = await self.select(task_id, run_id, query)
        require(current.receipt == receipt, "selection_changed")
        return current
