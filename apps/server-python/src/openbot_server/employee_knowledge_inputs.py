"""Strict knowledge inputs translated from the retained OpenBot TypeScript contracts.

The Employee learning direction is inspired by Hermes Agent. Candidate proposals never confer
model-use authority. This single-file skill adapter intentionally grants no executable capability.
"""
import hashlib
import json
import re
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator, model_validator

from .control_errors import ControlError
from .identity_inputs import ChannelBotId, _ECMASCRIPT_WHITESPACE, _bounded_text
from .profile_details import ExpectedRevision


def text_type(maximum: int):
    return _bounded_text(1, maximum, description="Trimmed bounded text.")


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    @model_validator(mode="before")
    @classmethod
    def no_nulls(cls, value):
        if isinstance(value, dict) and any(item is None for item in value.values()):
            raise ValueError("Explicit null is not an omission.")
        if isinstance(value, dict) and "ownerReviewed" in value and value["ownerReviewed"] is not True:
            raise ValueError("Explicit Owner review is required.")
        return value


class Evidence(Input):
    kind: Literal["run", "artifact", "approval", "manual", "import"]
    id: text_type(160)
    label: text_type(240) | None = None


Capability = Literal["browser", "shell", "screenshot", "cua", "lume", "coder",
                     "browser.observe", "browser.input", "screen.capture", "desktop.observe",
                     "desktop.input", "shell.execute", "filesystem.read", "filesystem.write",
                     "computer.takeover", "vm.manage", "code.execute"]


class CreateSkillInput(Input):
    skillMarkdown: Annotated[str, Field(min_length=1, max_length=12288)] | None = None
    slug: text_type(64)
    name: text_type(160)
    description: text_type(1024)
    version: text_type(64)
    source: Literal["built-in", "installed", "learned", "imported", "manual"]
    requiredCapabilities: list[Capability] = Field(default_factory=list, max_length=64)
    dependencySkillIds: list[ChannelBotId] = Field(default_factory=list, max_length=64)
    evidence: list[Evidence] = Field(default_factory=list, max_length=32)
    reason: text_type(1000)

    @field_validator("slug")
    @classmethod
    def slug_format(cls, value):
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", value):
            raise ValueError("Invalid Agent Skills name.")
        return value

    @field_validator("version")
    @classmethod
    def version_format(cls, value):
        if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?", value):
            raise ValueError("Use a semantic version.")
        return value

    @field_validator("requiredCapabilities", "dependencySkillIds")
    @classmethod
    def unique(cls, value):
        return sorted(set(value))


class SkillReview(Input):
    reason: text_type(1000)
    evidence: list[Evidence] = Field(default_factory=list, max_length=32)
    ownerReviewed: Literal[True]


class VerifySkillInput(SkillReview):
    state: Literal["verified"]
    reviewedContentSha256: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")] | None = None
    confidence: Annotated[ExpectedRevision, Field(le=100)]


class SuspendSkillInput(SkillReview):
    state: Literal["suspended"]


class RevokeSkillInput(SkillReview):
    state: Literal["revoked"]


SkillStateInput = Annotated[VerifySkillInput | SuspendSkillInput | RevokeSkillInput, Field(discriminator="state")]


class ImportSkillInput(Input):
    markdown: str = Field(min_length=1, max_length=12288)
    version: str = Field(max_length=64, pattern=r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")
    reason: text_type(1000)


MemoryKind = Literal["working", "episodic", "semantic", "procedural", "secret-reference"]
Sensitivity = Literal["public", "internal", "confidential", "restricted"]
Portability = Literal["never", "owner-selectable"]
MEMORY_FIELDS = ("kind", "title", "content", "sensitivity", "portability", "modelUseEnabled")


def memory_policy(value):
    if value.get("modelUseEnabled") is True and (value.get("kind") == "secret-reference" or value.get("sensitivity") in ("confidential", "restricted")):
        raise ControlError(422, "memory_model_use_forbidden")
    if value.get("kind") == "secret-reference" and (value.get("sensitivity", "restricted") != "restricted" or value.get("portability", "never") != "never"):
        raise ControlError(422, "memory_secret_reference_policy")
    if value.get("portability") == "included":
        raise ControlError(422, "memory_portability_unsupported")
    for field, maximum in (("title", 160), ("content", 8000)):
        if field in value:
            text = value[field]
            # The TS store's .length guard is in UTF-16 code units, after protocol trimming.
            if not text or len(text.encode("utf-16-le")) // 2 > maximum or "\0" in text:
                raise ControlError(422, "invalid_employee_memory")
            if sensitive_text(text):
                raise ControlError(422, "memory_sensitive_content")


class CreateMemoryInput(Input):
    kind: MemoryKind
    title: text_type(160)
    content: text_type(8000)
    sensitivity: Sensitivity
    portability: Portability
    modelUseEnabled: bool | None = None


class UpdateMemoryInput(Input):
    expectedRevision: ExpectedRevision
    kind: MemoryKind | None = None
    title: text_type(160) | None = None
    content: text_type(8000) | None = None
    sensitivity: Sensitivity | None = None
    portability: Portability | None = None
    modelUseEnabled: bool | None = None

    @model_validator(mode="after")
    def require_change(self):
        if not self.model_fields_set.intersection(MEMORY_FIELDS):
            raise ValueError("At least one memory field must change.")
        return self


class DeleteMemoryInput(Input):
    expectedRevision: ExpectedRevision
    ownerReviewed: Literal[True]


class KnowledgeProposalInput(Input):
    kind: Literal["semantic", "episodic", "procedural"]
    title: text_type(160)
    content: text_type(2000)

    @model_validator(mode="after")
    def safe_content(self):
        if "\0" in self.title or "\0" in self.content or len(self.content.encode()) > 8000:
            raise ValueError("Invalid knowledge proposal.")
        if sensitive_text(self.title) or sensitive_text(self.content):
            raise ControlError(422, "knowledge_sensitive_content")
        return self


class AcceptProposalInput(Input):
    decision: Literal["accept"]
    ownerReviewed: Literal[True]
    title: text_type(160)
    content: text_type(2000)
    modelUseEnabled: bool


class RejectProposalInput(Input):
    decision: Literal["reject"]
    ownerReviewed: Literal[True]


ReviewProposalInput = Annotated[AcceptProposalInput | RejectProposalInput, Field(discriminator="decision")]

# Same credential refusal patterns as sensitive-content.ts with portable=false. ASCII word
# boundaries match ECMAScript's non-Unicode \b; local paths are allowed for local-only knowledge.
_JS_SPACE = "[" + _ECMASCRIPT_WHITESPACE + "]"
_SENSITIVE = tuple(re.compile(pattern.replace(r"[^\s", "[^" + _ECMASCRIPT_WHITESPACE).replace(r"\s", _JS_SPACE), re.IGNORECASE | re.ASCII) for pattern in (
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bglpat-[A-Za-z0-9_-]{20,}\b|\bnpm_[A-Za-z0-9]{36}\b",
    r"\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b|\bAIza[A-Za-z0-9_-]{35}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b",
    r'''\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|session(?:id|_token)?)\s*[:=]\s*["']?[^\s"',;]{6,}''',
    r"\bBearer\s+[A-Za-z0-9._~+/=-]{12,}",
))


def sensitive_text(value: str) -> bool:
    return any(pattern.search(value) for pattern in _SENSITIVE)


def parse_skill_document(value: str) -> dict:
    """Retained bounded YAML core metadata; content is opaque and never grants tool access."""
    try:
        if not isinstance(value, str):
            raise ValueError()
        markdown = value.replace("\r\n", "\n")
        if len(markdown.encode()) > 12288 or re.search(r"[\x00-\x08\x0b-\x1f\x7f\u2028\u2029]", markdown):
            raise ValueError()
        match = re.fullmatch(r"---\n([\s\S]*?)\n---\n([\s\S]+)", markdown)
        if not match or not match[2].strip(_ECMASCRIPT_WHITESPACE) or len(match[1].encode()) > 4096:
            raise ValueError()
        if len(json.dumps({"markdown": markdown}, ensure_ascii=False, separators=(",", ":")).encode()) > 14336 or sensitive_text(markdown):
            raise ValueError()
        from .skill_yaml import metadata
        import yaml
        try:
            result = metadata(match[1])
        except yaml.YAMLError:
            raise ValueError() from None
        if set(result) - {"name", "description", "license", "compatibility", "metadata", "allowed-tools"}:
            raise ValueError()
        for key, item in result.items():
            if key == 'metadata':
                if type(item) is not dict or any(type(k) is not str or len(k) > 100 or type(v) is not str or len(v) > 500 for k,v in item.items()):
                    raise ValueError()
            elif type(item) is not str:
                raise ValueError()
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", result.get("name", "")) or len(result["name"]) > 64:
            raise ValueError()
        result["description"] = result.get("description", "").strip(_ECMASCRIPT_WHITESPACE)
        if not 1 <= len(result["description"]) <= 1024:
            raise ValueError()
        for field, maximum in (("license", 500), ("compatibility", 500), ("allowed-tools", 1024)):
            if field in result and not 1 <= len(result[field]) <= maximum:
                raise ValueError()
        return {"markdown": markdown, "sha256": hashlib.sha256(markdown.encode()).hexdigest(), **result}
    except (ValueError, KeyError, UnicodeError):
        raise ControlError(422, "invalid_skill_document") from None


def parse_skill_create(value):
    return CreateSkillInput.model_validate(value)


def parse_skill_state(value):
    return TypeAdapter(SkillStateInput).validate_python(value)


def parse_skill_import(value):
    return ImportSkillInput.model_validate(value)


def parse_memory_create(value):
    parsed = CreateMemoryInput.model_validate(value)
    memory_policy(parsed.model_dump(exclude_none=True))
    return parsed


def parse_memory_update(value):
    parsed = UpdateMemoryInput.model_validate(value)
    memory_policy(parsed.model_dump(exclude_none=True))
    return parsed


def parse_memory_delete(value):
    return DeleteMemoryInput.model_validate(value)


def parse_proposal_review(value):
    return TypeAdapter(ReviewProposalInput).validate_python(value)
