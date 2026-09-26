"""Pure persisted execution values shared by the trusted completion transaction.

Ported from the OpenBot MIT application code that already owns these strings and shapes:
``agent-observations.ts`` (``nativeFailureMessages``), ``agent-knowledge.ts``
(``knowledgeProposalSchema``, ``validateKnowledgeProposal``, ``boundedKnowledgeText`` and the
``KnowledgeReference``/``SkillReference`` value shapes), ``sensitive-content.ts``
(``scanSensitiveText`` with ``portable: false``) and ``artifact-storage.ts`` (``decodeReport`` plus
the ``runs/<runId>/<artifactId>.md`` storage-key rule). The reuse decision, the oracle comparison
plan and the limits of these checks are recorded in ``docs/research/python-task-authority.md``. No
upstream source was copied and no dependency was added.

Two boundaries are deliberate:

* Nothing in this module grants authority. A reference, digest or artifact value is evidence a Run
  produced, never permission to read it; the trusted store still re-checks scope, revision and
  digest, and the Server still owns Run identity, budgets, approval and the final commit.
* Argument *types* raise ``TypeError``; refused *values* raise ``ValueError``. All refusals are
  generic, so refused text (which may itself be a credential) is never echoed back.

These are pure functions over already-persisted values: they read no environment, secret or file.
Metadata validation cannot prove that artifact bytes exist or match their digest — that comes from
the trusted storage port, which the Server owns.
"""
import json
import math
import re
import unicodedata
from collections.abc import Sequence
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BeforeValidator, ConfigDict, Field, ValidationError

from .identity_inputs import _ECMASCRIPT_WHITESPACE, _TRIM_NOTE, _bounded_text
from .models import PublicModel
from .task_models import _mathematical_integer

# ``nativeFailureMessages`` of ``agent-observations.ts``, verbatim and in declaration order. The
# Server stores these exact public strings; an unknown code is refused by ``failure_message``
# instead of being echoed, so caller-supplied text never becomes an error message.
FAILURE_MESSAGES: dict[str, str] = {
    "plugin_rejected":
        "The Owner rejected the plugin call. No approved execution was dispatched for that call.",
    "plugin_approval_expired":
        "The plugin call approval expired before execution. Submit a new task if it is still needed.",
    "plugin_changed":
        "Plugin tools or Bot grants changed. Review the installed plugin and submit a new task.",
    "plugin_unavailable":
        "The plugin call could not be confirmed. Check the plugin service; OpenBot did not "
        "automatically retry it.",
    "attachment_model_unsupported":
        "Image/PDF input is not enabled for this provider or model. Choose a compatible OpenAI or "
        "Anthropic model, or attach a text version.",
    "attachment_unavailable":
        "A task attachment is missing, outside this channel, damaged or exceeds its limits. Attach "
        "the file again before submitting a new task.",
    "model_credentials":
        "Model credentials were rejected. Verify the provider key in Settings before submitting a "
        "new task.",
    "model_rate_limit":
        "The model provider rate limit was reached. Wait before submitting a new task.",
    "model_unavailable":
        "The model provider is unavailable. Check the configured model and service status.",
    "settings_changed":
        "Model settings changed during this task. Review the current configuration and submit a "
        "new task.",
    "scope_revoked": "This Bot no longer has access to the task channel. Check its membership.",
    "invalid_target":
        "This task referenced an unknown or ineligible target. Review its task details and "
        "available collaborators or resources.",
    "conflict":
        "The task state changed before this update could be saved. Check the latest Run status "
        "before submitting a new task.",
    "skills_changed":
        "Reviewed skills changed during this task. Review the current skill assignments and "
        "submit a new task.",
    "memory_changed":
        "Employee memory changed during this task. Review current memory and submit a new task.",
    "task_limit": "The task exceeded its execution limits. Split it into smaller tasks.",
    "tool_unavailable":
        "A scoped tool could not complete. Check the task URLs and requested capability.",
    "task_timeout":
        "The task reached its time limit. Try a smaller task or check the provider connection.",
    "server_interrupted": "The Server interrupted this task. Submit a new task when it is ready.",
    "execution_failed":
        "The Agent could not complete. Check model settings, channel access and task scope before "
        "submitting a new task.",
}


def failure_message(code: object) -> str:
    """Return the public message of a known failure code; refuse anything else without echoing it."""
    if type(code) is not str or code not in FAILURE_MESSAGES:
        raise ValueError("Unknown Run failure code.")
    return FAILURE_MESSAGES[code]


def _character_class(characters: str) -> str:
    """Render a literal character set as explicit ``\\uXXXX`` class members."""
    return "".join(f"\\u{ord(character):04x}" for character in characters)


# JavaScript ``\s`` is the ECMAScript WhiteSpace + LineTerminator set, which is *not* Python's:
# Python additionally accepts U+001C-U+001F and U+0085 and rejects U+FEFF. The character set is
# therefore written out from the shared constant instead of using ``\s``.
_ECMA_SPACE_CLASS = "[" + _character_class(_ECMASCRIPT_WHITESPACE) + "]"
_NON_ECMA_SPACE_CLASS = "[^" + _character_class(_ECMASCRIPT_WHITESPACE) + "\"',;]"
_OPTIONAL_QUOTE = "[\"']?"

# The ``credential-like-content`` and ``private-key-content`` expressions of
# ``sensitive-content.ts``, in declaration order and with its ``/i`` flag. ``re.ASCII`` reproduces
# the two JavaScript semantics that Python otherwise changes: non-Unicode ``\b`` is ASCII-only, and
# case folding must not accept characters the JavaScript non-Unicode fold rejects (``'ſ'`` for
# ``s``, ``'K'`` for ``k``). The portable-only ``local-path-content`` expression is deliberately
# absent: a local-only record may legitimately name a machine path.
_SENSITIVE_EXPRESSIONS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(text, re.IGNORECASE | re.ASCII)
    for text in (
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
        r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9_]{20,}\b"
        r"|\bglpat-[A-Za-z0-9_-]{20,}\b|\bnpm_[A-Za-z0-9]{36}\b",
        r"\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b"
        r"|\bAIza[A-Za-z0-9_-]{35}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b",
        r"\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret"
        r"|session(?:id|_token)?)" + _ECMA_SPACE_CLASS + r"*[:=]" + _ECMA_SPACE_CLASS + r"*"
        + _OPTIONAL_QUOTE + _NON_ECMA_SPACE_CLASS + r"{6,}",
        r"\bBearer" + _ECMA_SPACE_CLASS + r"+[A-Za-z0-9._~+/=-]{12,}",
    )
)


def has_sensitive_text(value: str) -> bool:
    """Report whether text carries a credential or private-key marker.

    This is exactly the ``portable: false`` scan of ``sensitive-content.ts``. It is a heuristic over
    a fixed pattern list — it does not detect every credential, and a match is a reason to refuse
    rather than proof of a secret. Machine-local paths are not refused here.
    """
    if type(value) is not str:
        raise TypeError("Sensitive text scanning requires a string.")
    return any(expression.search(value) is not None for expression in _SENSITIVE_EXPRESSIONS)


def _stored_text(value: str) -> str:
    """Refuse text this process could never persist: NUL and anything outside UTF-8.

    Python and JavaScript strings may carry lone surrogates, including through escaped JSON.
    Refuse them before PostgreSQL/UTF-8 persistence; this is stricter than the original helper.
    """
    if "\0" in value:
        raise ValueError("Expected text without a NUL character.")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        raise ValueError("Expected text that is valid UTF-8.") from None
    return value


def _within_bytes(maximum_bytes: int) -> Any:
    def validate(value: str) -> str:
        if len(value.encode("utf-8")) > maximum_bytes:
            raise ValueError(f"Expected text within {maximum_bytes} UTF-8 bytes.")
        return value

    return validate


_INVALID_PROPOSAL = "Invalid knowledge proposal."
_SENSITIVE_PROPOSAL = "Knowledge proposals cannot contain credential values or private keys."

# ``knowledgeProposalSchema``: a strict ``kind``/``title``/``content`` object whose title is 1-160
# and whose content is 1-2000 code points (the ECMAScript trim and code-point semantics of
# ``_bounded_text``). NUL is refused in both fields and the content is additionally capped at 8000
# UTF-8 bytes, exactly as the source ``refine`` does.
_ProposalTitle = Annotated[_bounded_text(
    1, 160, required_message="Knowledge proposal title is required.",
    description=f"Knowledge proposal title. {_TRIM_NOTE}"), AfterValidator(_stored_text)]
_ProposalContent = Annotated[_bounded_text(
    1, 2000, required_message="Knowledge proposal content is required.",
    description=f"Knowledge proposal content. {_TRIM_NOTE}"), AfterValidator(_stored_text),
    AfterValidator(_within_bytes(8000))]


class KnowledgeProposal(PublicModel):
    """``KnowledgeProposalDraft``: a pending draft the Owner must review before activation."""

    model_config = ConfigDict(revalidate_instances="always")

    kind: Literal["semantic", "episodic", "procedural"]
    title: _ProposalTitle
    content: _ProposalContent


def validate_proposal(value: object) -> dict[str, str]:
    """Validate a knowledge proposal payload and return its normalized fields.

    Raises ``ValueError`` for every refused input — malformed shape, NUL, non-UTF-8 text or
    credential-like content — with a generic message, because the refused text may itself be the
    secret. The returned mapping is the stored shape (ECMAScript-trimmed title and content).
    """
    try:
        proposal = KnowledgeProposal.model_validate(value)
    except ValidationError:
        raise ValueError(_INVALID_PROPOSAL) from None
    for field in ("title", "content"):
        if has_sensitive_text(getattr(proposal, field)):
            raise ValueError(_SENSITIVE_PROPOSAL)
    return {"kind": proposal.kind, "title": proposal.title, "content": proposal.content}


def bounded_text(value: str, maximum_bytes: int) -> str:
    """``boundedKnowledgeText``: keep whole code points up to a UTF-8 byte budget.

    The TypeScript original returns whatever fits, so it answers ``""`` for a negative budget and
    counts a lone surrogate as its three-byte replacement. This port refuses both instead: an
    unusable budget is a caller defect, and text that cannot be encoded as UTF-8 must be reported
    rather than rewritten with a replacement character.
    """
    if type(value) is not str:
        raise TypeError("Bounded text requires a string value.")
    if type(maximum_bytes) is not int:
        raise TypeError("Bounded text requires an integer byte budget.")
    if maximum_bytes < 0:
        raise ValueError("Bounded text requires a non-negative byte budget.")
    _stored_text(value)
    size = 0
    end = 0
    for index, character in enumerate(value):
        size += len(character.encode("utf-8"))
        if size > maximum_bytes:
            break
        end = index + 1
    return value[:end]


# ``KnowledgeReference`` of ``agent-knowledge.ts`` and ``SkillReference`` of ``agent-skills.ts``.
# They are values, not grants: the store re-asserts scope, revision and digest before anything is
# read, and no model here carries authority.
_REVISION_CEILING = 2_147_483_647
_ReferenceId = Annotated[str,
                         Field(min_length=1, max_length=128,
                               description="Stored identifier of a knowledge or skill record."),
                         AfterValidator(_stored_text)]
_Revision = Annotated[int, Field(ge=1, le=_REVISION_CEILING,
                                 description="Stored revision of that record."),
                      BeforeValidator(_mathematical_integer)]

_SHA256_PATTERN_TEXT = r"^[0-9a-f]{64}$"
_SHA256_PATTERN = re.compile(_SHA256_PATTERN_TEXT)


def _digest(value: str) -> str:
    """Accept the lowercase hexadecimal digest the reviewed skill content is pinned to."""
    if _SHA256_PATTERN.fullmatch(value) is None:
        raise ValueError("Expected a lowercase SHA-256 hexadecimal digest.")
    return value


_Digest = Annotated[str, Field(pattern=_SHA256_PATTERN_TEXT,
                               description="SHA-256 of the reviewed content, lowercase hexadecimal."),
                    AfterValidator(_digest)]


class KnowledgeReference(PublicModel):
    """A stored knowledge revision this Run's result was produced from."""

    model_config = ConfigDict(revalidate_instances="always")

    id: _ReferenceId
    revision: _Revision


class SkillReference(KnowledgeReference):
    """A stored skill revision, pinned to the digest of the content that was reviewed."""

    sha256: _Digest


# ``decodeReport`` of ``artifact-storage.ts``: ``[\p{L}\p{N}][\p{L}\p{N} ._-]{0,100}\.md``, whose
# lengths are 4-104 once the extension is counted. Python's ``re`` has no Unicode property escapes,
# so inspect the Unicode general category directly. ``sizeBytes`` is the byte length of a report that already passed the 32 KiB limit.
_REPORT_NAME_MAX = 104
_PERSISTED_SIZE_CEILING = 32 * 1024   # decodeReport's own limit; keep in sync with storage.
_MAX_PERSISTED_ARTIFACTS = 2
_METADATA_BYTE_CEILING = 8192
_METADATA_DEPTH_CEILING = 8
_STORAGE_ID_PATTERN_TEXT = r"^[0-9a-fA-F-]{1,128}$"
_STORAGE_ID_PATTERN = re.compile(_STORAGE_ID_PATTERN_TEXT)


def _is_letter_or_number(character: str) -> bool:
    r"""``\p{L}`` or ``\p{N}`` for one character."""
    return unicodedata.category(character)[0] in {"L", "N"}


def _report_name(value: str) -> str:
    """Refuse any name ``decodeReport`` would refuse: shape, extension and both length bounds."""
    if not value.endswith(".md"):
        raise ValueError("Persisted report names must end with .md.")
    stem = value[: -len(".md")]
    if not 1 <= len(stem) <= _REPORT_NAME_MAX - len(".md"):
        raise ValueError(f"Expected 1 to {_REPORT_NAME_MAX - len('.md')} characters before .md.")
    if not _is_letter_or_number(stem[0]):
        raise ValueError("Report names must start with a letter or a number.")
    if not all(_is_letter_or_number(character) or character in " ._-" for character in stem[1:]):
        raise ValueError("Report names may only contain letters, numbers, spaces, . _ and -.")
    return value


def _aware_timestamp(value: str) -> str:
    """Accept an ISO-8601 timestamp that carries its own UTC offset; refuse a naive one."""
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        raise ValueError("Expected an ISO-8601 timestamp.") from None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("Expected a timezone-aware timestamp.")
    return value


def _bounded_metadata(value: dict[str, Any]) -> dict[str, Any]:
    """Bound plain JSON before encoding; cyclic/deep objects cannot exhaust the encoder stack."""
    pending, visited = [(value, 0)], 0
    while pending:
        item, depth = pending.pop()
        visited += 1
        if depth > _METADATA_DEPTH_CEILING or visited > _METADATA_BYTE_CEILING:
            raise ValueError("Metadata exceeds its depth or byte budget.")
        if type(item) is dict:
            if len(item) > _METADATA_BYTE_CEILING or any(type(key) is not str for key in item):
                raise ValueError("Metadata must be plain JSON with string keys.")
            for key in item:
                _stored_text(key)
            pending.extend((child, depth + 1) for child in item.values())
        elif type(item) is list:
            if len(item) > _METADATA_BYTE_CEILING:
                raise ValueError("Metadata exceeds its byte budget.")
            pending.extend((child, depth + 1) for child in item)
        elif type(item) is str:
            _stored_text(item)
        elif type(item) is float:
            if not math.isfinite(item):
                raise ValueError("Metadata must be finite JSON.")
        elif type(item) not in (int, bool, type(None)):
            raise ValueError("Metadata must be plain JSON.")
    try:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True,
                             separators=(",", ":")).encode("utf-8")
    except (ValueError, TypeError, RecursionError):
        raise ValueError("Metadata must be finite, acyclic JSON.") from None
    if len(encoded) > _METADATA_BYTE_CEILING:
        raise ValueError("Metadata exceeds its byte budget.")
    return value


class NativeArtifact(PublicModel):
    """``Artifact`` of ``packages/domain/src/index.ts`` for a retained Markdown report."""

    model_config = ConfigDict(revalidate_instances="always")

    id: Annotated[str, Field(min_length=1, max_length=128,
                             description="Identifier the trusted storage layer assigned."),
                  AfterValidator(_stored_text)]
    runId: Annotated[str, Field(min_length=1, max_length=128,
                                description="Run this artifact was produced by."),
                     AfterValidator(_stored_text)]
    name: Annotated[str, Field(min_length=1, max_length=_REPORT_NAME_MAX,
                               description="Report name ending in .md."),
                    AfterValidator(_report_name)]
    mediaType: Literal["text/markdown"]
    sha256: _Digest
    sizeBytes: Annotated[int, Field(ge=1, le=_PERSISTED_SIZE_CEILING,
                                    description="Stored byte length of the report."),
                         BeforeValidator(_mathematical_integer)]
    createdAt: Annotated[str, Field(description="ISO-8601 timestamp with an explicit offset."),
                         AfterValidator(_aware_timestamp)]


class PersistedArtifact(PublicModel):
    """``PersistedArtifact`` of ``artifact-storage.ts``: the value plus where it was written."""

    model_config = ConfigDict(revalidate_instances="always")

    artifact: NativeArtifact
    storageKey: str = Field(description="Storage key inside the Server's artifact root.")
    metadata: Annotated[dict[str, Any], Field(description="Bounded finite JSON metadata."),
                        AfterValidator(_bounded_metadata)]


def _storage_key(run_id: str, artifact_id: str) -> str:
    """Build the only key a trusted report may occupy, refusing traversal by construction.

    Only hexadecimal characters and dashes reach the key, so no separator, dot or escape can appear
    in either identifier and ``..`` cannot be expressed at all.
    """
    for value, label in ((run_id, "Run"), (artifact_id, "artifact")):
        if _STORAGE_ID_PATTERN.fullmatch(value) is None:
            raise ValueError(f"Invalid {label} identifier for a persisted artifact key.")
    return f"runs/{run_id}/{artifact_id}.md"


def validate_artifacts(run_id: object, values: object) -> list[PersistedArtifact]:
    """Validate the retained reports of one Run against its trusted storage results.

    Accepts at most two artifacts with distinct identifiers and storage keys, each belonging to
    ``run_id`` and occupying exactly ``runs/<run_id>/<artifact id>.md``, with a bounded finite-JSON
    metadata value. Raises ``ValueError`` on a refused value and ``TypeError`` when an argument is
    not of the expected type.

    This is metadata validation only. It cannot prove that the stored bytes exist or match the
    digest recorded beside them; that acceptance belongs to the trusted file/database port.
    """
    if type(run_id) is not str:
        raise TypeError("Persisted artifacts require a Run identifier string.")
    if isinstance(values, (str, bytes)) or not isinstance(values, Sequence):
        raise TypeError("Persisted artifacts must be given as a sequence.")
    if len(values) > _MAX_PERSISTED_ARTIFACTS:
        raise ValueError(
            f"At most {_MAX_PERSISTED_ARTIFACTS} persisted Markdown reports may be recorded.")
    if _STORAGE_ID_PATTERN.fullmatch(run_id) is None:
        raise ValueError("Invalid Run identifier for a persisted artifact key.")
    persisted: list[PersistedArtifact] = []
    identities: set[str] = set()
    keys: set[str] = set()
    for value in values:
        try:
            artifact = PersistedArtifact.model_validate(value)
        except ValidationError:
            raise ValueError("Invalid persisted artifact.") from None
        if artifact.artifact.runId != run_id:
            raise ValueError("Persisted artifact belongs to a different Run.")
        if artifact.storageKey != _storage_key(run_id, artifact.artifact.id):
            raise ValueError("Persisted artifact key does not match its Run and identifier.")
        if artifact.artifact.id in identities or artifact.storageKey in keys:
            raise ValueError("Persisted artifact identifiers and keys must be unique.")
        identities.add(artifact.artifact.id)
        keys.add(artifact.storageKey)
        persisted.append(artifact)
    return persisted
