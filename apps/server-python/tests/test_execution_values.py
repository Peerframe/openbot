"""Boundary tests for the persisted execution values: failure text, proposals, bounded text,
knowledge/skill references and retained report artifacts.

Every expectation was probed against the real module before it was written, and the ported text rules
were additionally compared with the compiled Server modules by ``scripts/compare-execution-values.mjs``
(40 maintained cases). These are unit tests: they prove no SQL, no Owner authority, no artifact byte
acceptance and no dispatch.
"""
import json
import math

import pytest
from pydantic import ValidationError

from openbot_server import execution_values as values

RUN = "1f8b0f1e-5e3d-4f8a-9c2b-7d6e5f4a3b2c"
OTHER_RUN = "2f8b0f1e-5e3d-4f8a-9c2b-7d6e5f4a3b2c"
ARTIFACT = "9c2b-7d6e5f4a3b2c"
OTHER_ARTIFACT = "8d1e-0a1b2c3d4e5f"
THIRD_ARTIFACT = "7a1b-2c3d4e5f6a7b"
DIGEST = "9f" * 32
WHEN = "2026-01-02T03:04:05.123Z"
KEY = f"runs/{RUN}/{ARTIFACT}.md"


def proposal(**overrides):
    """A payload the Server accepts; each refused case below is this payload with one defect."""
    value = {"kind": "semantic", "title": "Deployment notes", "content": "Rotate the key monthly."}
    value.update(overrides)
    return value


def artifact(**overrides):
    value = {"id": ARTIFACT, "runId": RUN, "name": "report.md", "mediaType": "text/markdown",
             "sha256": DIGEST, "sizeBytes": 12, "createdAt": WHEN}
    value.update(overrides)
    return value


def persisted(**overrides):
    value = {"artifact": artifact(), "storageKey": KEY, "metadata": {"sizeBytes": 12}}
    value.update(overrides)
    return value


def encoded_metadata(value):
    """The compact encoding the byte bound is measured on."""
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")


def nested(levels):
    """Build a nested JSON object around one scalar."""
    value = {"leaf": 1}
    for _ in range(levels - 1):
        value = {"child": value}
    return value


# --- public failure text ---------------------------------------------------------------

def test_failure_map_is_the_declared_twenty_codes():
    """The Server stores these strings verbatim, so the code set is frozen, not merely non-empty."""
    assert set(values.FAILURE_MESSAGES) == {
        "plugin_rejected", "plugin_approval_expired", "plugin_changed", "plugin_unavailable",
        "attachment_model_unsupported", "attachment_unavailable", "model_credentials",
        "model_rate_limit", "model_unavailable", "settings_changed", "scope_revoked",
        "invalid_target", "conflict", "skills_changed", "memory_changed", "task_limit",
        "tool_unavailable", "task_timeout", "server_interrupted", "execution_failed",
    }
    assert len(values.FAILURE_MESSAGES) == 20
    assert all(message == message.strip() and message for message in values.FAILURE_MESSAGES.values())
    # Exact parity with ``nativeFailureMessages`` is the comparator's job; this pins the accessor.
    assert values.failure_message("execution_failed") == values.FAILURE_MESSAGES["execution_failed"]
    assert values.failure_message("task_limit") == (
        "The task exceeded its execution limits. Split it into smaller tasks.")


def test_failure_message_refuses_an_unknown_code_without_echoing_it():
    """A refused code must never become public text: the caller supplies it."""
    for refused in ["", "unknown", "Execution_Failed", None, 7, True, "'; DROP TABLE runs; --"]:
        with pytest.raises(ValueError) as refused_case:
            values.failure_message(refused)
        assert "DROP TABLE" not in str(refused_case.value)
        assert "unknown" not in str(refused_case.value)


# --- knowledge proposals ---------------------------------------------------------------

def test_validate_proposal_normalizes_the_stored_shape():
    result = values.validate_proposal(proposal(title="  Trim me \t", content="\nBody\u00a0"))
    assert result == {"kind": "semantic", "title": "Trim me", "content": "Body"}
    assert set(result) == {"kind", "title", "content"}


@pytest.mark.parametrize("kind", ["semantic", "episodic", "procedural"])
def test_validate_proposal_accepts_every_declared_kind(kind):
    assert values.validate_proposal(proposal(kind=kind))["kind"] == kind


def test_validate_proposal_bounds_title_and_content():
    accepted = [
        ("title of 160", proposal(title="t" * 160)),
        ("content of 2000 code points", proposal(content="b" * 2000)),
        ("content of 2000 astral code points is exactly the 8000-byte ceiling",
         proposal(content="\U0001f600" * 2000)),
        ("content of 2000 three-byte code points", proposal(content="\u20ac" * 2000)),
        ("one character", proposal(title="t", content="b")),
    ]
    for label, value in accepted:
        assert values.validate_proposal(value) == value, label
    refused = [
        ("title of 161", proposal(title="t" * 161)),
        ("content of 2001 code points", proposal(content="b" * 2001)),
        ("content of 2001 astral code points", proposal(content="\U0001f600" * 2001)),
        ("title trimmed to empty", proposal(title="  \t\u00a0 ")),
        ("content trimmed to empty", proposal(content="\ufeff")),
        ("NUL in title", proposal(title="note\0name")),
        ("NUL in content", proposal(content="body\0body")),
        ("unknown kind", proposal(kind="procedural2")),
        ("missing kind", {"title": "t", "content": "b"}),
        ("missing title", {"kind": "semantic", "content": "b"}),
        ("missing content", {"kind": "semantic", "title": "t"}),
        ("extra key", proposal(ownerReviewed=True)),
        ("explicit null title", proposal(title=None)),
        ("numeric title", proposal(title=7)),
        ("boolean content", proposal(content=True)),
        ("list content", proposal(content=["b"])),
        ("null payload", None),
        ("string payload", "semantic"),
        ("list payload", [proposal()]),
    ]
    for label, value in refused:
        with pytest.raises(ValueError):
            values.validate_proposal(value)
        assert label


def test_the_content_byte_ceiling_is_unreachable_past_the_code_point_bound():
    """No JSON character exceeds four UTF-8 bytes, so 2000 code points can never exceed 8000 bytes.

    The source ``refine`` byte clause is therefore a defensive duplicate of its code-point clause.
    This port keeps it for parity instead of inventing a refusal no input can reach.
    """
    assert len(("\U0001f600" * 2000).encode("utf-8")) == 8000
    assert len(("\U0001f600" * 2001).encode("utf-8")) == 8004
    with pytest.raises(ValueError):
        values.validate_proposal(proposal(content="\U0001f600" * 2001))


def test_validate_proposal_refuses_credentials_without_echoing_them():
    secrets = [
        "-----BEGIN RSA PRIVATE KEY-----",
        "AKIAIOSFODNN7EXAMPLE",
        "sk_live_0123456789abcdef",
        "Bearer abcdefghijklmnopqrst",
        "password=abcdef",
        "npm_0123456789abcdefghijklmnopqrstuvwxyz",
    ]
    for secret in secrets:
        for field in ("title", "content"):
            with pytest.raises(ValueError) as refused:
                values.validate_proposal(proposal(**{field: secret}))
            assert "credential values or private keys" in str(refused.value)
            assert secret[:12] not in str(refused.value)


def test_validate_proposal_keeps_the_non_portable_path_rule():
    """``portable: false`` refuses credentials only; a local-only record may name a machine path."""
    value = proposal(content="See /Users/owner/notes.md for the inventory.")
    assert values.validate_proposal(value)["content"].endswith("inventory.")


def test_validate_proposal_refuses_text_that_is_not_utf8():
    """Python can hold lone surrogates; the server transport cannot. Refuse instead of replacing."""
    for broken in ["\ud800", "\udfff", "note\ud800name", "\ud83d"]:
        for field in ("title", "content"):
            with pytest.raises(ValueError):
                values.validate_proposal(proposal(**{field: broken}))
        assert "\ufffd" not in broken


# --- sensitive-text scanner ------------------------------------------------------------

def test_has_sensitive_text_matches_the_portable_false_patterns():
    cases = [
        ("private key marker", "-----BEGIN RSA PRIVATE KEY-----", True),
        ("private key marker, lower case", "-----begin rsa private key-----", True),
        ("AWS key id", "AKIAIOSFODNN7EXAMPLE", True),
        ("AWS key id, lower case", "akiaiosfodnn7example", True),
        ("GitHub token", f"ghp_{'a' * 36}", True),
        ("GitLab token", f"glpat-{'a' * 20}", True),
        ("npm token", f"npm_{'a' * 36}", True),
        ("stripe key", f"sk_live_{'A' * 16}", True),
        ("project key", f"sk-proj-{'a' * 20}", True),
        ("google key", f"AIza{'a' * 35}", True),
        ("slack token", f"xoxb-{'a' * 20}", True),
        ("bearer token", f"Bearer {'a' * 12}", True),
        ("assignment", "password: 'abcdef'", True),
        ("assignment without a quote", "api_key = abcdef", True),
        ("refresh token assignment", "refresh_token=abcdef", True),
        ("session id assignment", "session=abcdefgh", True),
        ("short value after a separator", "token=abc", False),
        ("keyword without a value", "secret", False),
        ("machine-local path", "/Users/owner/notes.md", False),
        ("ASCII word boundary before a non-word letter", "\u00e9secret=abcdef", True),
        ("no non-ASCII case fold in the ASCII word", "\u017fecret=abcdef", False),
        ("U+001C is not ECMAScript whitespace", "password\u001c=abcdef", False),
        ("U+FEFF is ECMAScript whitespace", "password\ufeff=abcdef", True),
    ]
    for label, text, expected in cases:
        assert values.has_sensitive_text(text) is expected, label


@pytest.mark.parametrize("refused", [None, 7, True, b"password=abcdef", ["password=abcdef"]])
def test_has_sensitive_text_requires_a_string(refused):
    with pytest.raises(TypeError):
        values.has_sensitive_text(refused)


# --- bounded text ----------------------------------------------------------------------

def test_bounded_text_keeps_whole_code_points():
    cases = [
        ("exact fit", ("abc", 3), "abc"),
        ("one byte short", ("abc", 2), "ab"),
        ("astral code point does not fit", ("a\U0001f600", 4), "a"),
        ("astral code point fits", ("a\U0001f600", 5), "a\U0001f600"),
        ("second astral code point does not fit", ("\U0001f600\U0001f600", 7), "\U0001f600"),
        ("budget below one astral code point", ("\U0001f600", 3), ""),
        ("two-byte letters", ("\u00e9\u00e9\u00e9", 4), "\u00e9\u00e9"),
        ("combining mark is kept whole", (" e\u0301", 3), " e"),
        ("empty value", ("", 0), ""),
        ("empty result for a zero budget", ("abc", 0), ""),
        ("NBSP is content, not padding", ("\u00a0abc", 4), "\u00a0ab"),
        ("BOM is content, not padding", ("\ufeffa", 4), "\ufeffa"),
        ("a value inside the budget is unchanged", ("x" * 100, 10000), "x" * 100),
    ]
    for label, (value, maximum), expected in cases:
        result = values.bounded_text(value, maximum)
        assert result == expected, label
        assert value.startswith(result), label
        assert len(result.encode("utf-8")) <= maximum, label
        assert "\ufffd" not in result, label


def test_bounded_text_refuses_a_budget_it_cannot_honour():
    """The TypeScript original answers "" for a negative budget; this port refuses the caller defect."""
    for refused in [-1, -100]:
        with pytest.raises(ValueError):
            values.bounded_text("abc", refused)
    for refused in [True, 3.0, "3", None]:
        with pytest.raises(TypeError):
            values.bounded_text("abc", refused)
    for refused in [None, 7, True, ["abc"], b"abc"]:
        with pytest.raises(TypeError):
            values.bounded_text(refused, 3)


def test_bounded_text_refuses_text_that_is_not_utf8():
    for broken in ["\ud800", "\udfff", "a\ud800b"]:
        with pytest.raises(ValueError):
            values.bounded_text(broken, 100)


# --- knowledge and skill references ----------------------------------------------------

def test_knowledge_reference_bounds_id_and_revision():
    for accepted in [{"id": "a", "revision": 1}, {"id": "i" * 128, "revision": 2147483647},
                     {"id": "note-1", "revision": 2.0}]:
        assert values.KnowledgeReference.model_validate(accepted).revision >= 1
    for refused in [{"id": "", "revision": 1}, {"id": "i" * 129, "revision": 1},
                    {"id": "note\0id", "revision": 1}, {"id": "note\ud800id", "revision": 1},
                    {"id": "note", "revision": 0}, {"id": "note", "revision": -1},
                    {"id": "note", "revision": 2147483648}, {"id": "note", "revision": 1.5},
                    {"id": "note", "revision": True}, {"id": "note", "revision": "1"},
                    {"id": "note", "revision": math.inf}, {"id": "note", "revision": math.nan},
                    {"id": "note", "revision": 1, "sha256": DIGEST},
                    {"id": "note"}, {"revision": 1}, None]:
        with pytest.raises((ValueError, TypeError)):
            values.KnowledgeReference.model_validate(refused)


def test_skill_reference_pins_the_reviewed_digest():
    accepted = {"id": "note-1", "revision": 3, "sha256": DIGEST}
    assert values.SkillReference.model_validate(accepted).sha256 == DIGEST
    for refused in ["", DIGEST.upper(), DIGEST[:63], DIGEST + "0", DIGEST[:-1] + "z", " " + DIGEST]:
        with pytest.raises((ValueError, TypeError)):
            values.SkillReference.model_validate({"id": "note-1", "revision": 3, "sha256": refused})


# --- retained report artifacts ---------------------------------------------------------

def test_validate_artifacts_accepts_up_to_two_distinct_reports():
    assert values.validate_artifacts(RUN, []) == []
    single = values.validate_artifacts(RUN, [persisted()])
    assert [type(item) for item in single] == [values.PersistedArtifact]
    assert single[0].artifact.name == "report.md"
    assert single[0].storageKey == KEY
    assert single[0].artifact.sha256 == DIGEST
    assert single[0].metadata == {"sizeBytes": 12}
    second = persisted(artifact=artifact(id=OTHER_ARTIFACT),
                       storageKey=f"runs/{RUN}/{OTHER_ARTIFACT}.md")
    assert len(values.validate_artifacts(RUN, [persisted(), second])) == 2
    # Identifiers are hexadecimal and case-insensitive, not normalised.
    upper = persisted(artifact=artifact(id=ARTIFACT.upper(), runId=RUN.upper()),
                      storageKey=f"runs/{RUN.upper()}/{ARTIFACT.upper()}.md")
    assert values.validate_artifacts(RUN.upper(), [upper])[0].artifact.id == ARTIFACT.upper()


def test_validate_artifacts_refuses_foreign_keys_and_traversal():
    refused = [
        ("foreign Run", RUN, [persisted(artifact=artifact(runId=OTHER_RUN))]),
        ("foreign key", RUN, [persisted(storageKey=f"runs/{OTHER_RUN}/{ARTIFACT}.md")]),
        ("key of another artifact", RUN,
         [persisted(storageKey=f"runs/{RUN}/{OTHER_ARTIFACT}.md")]),
        ("image extension", RUN,
         [persisted(storageKey=f"runs/{RUN}/{ARTIFACT}.png")]),
        ("traversal in the key", RUN, [persisted(storageKey=f"runs/{RUN}/../{ARTIFACT}.md")]),
        ("traversal in the Run identifier", "../etc", [persisted()]),
        ("blank Run identifier", "", [persisted()]),
        ("separator in the artifact identifier", RUN,
         [persisted(artifact=artifact(id="a/b"), storageKey=f"runs/{RUN}/a/b.md")]),
        ("non-hexadecimal Run identifier", "not-a-run", [persisted()]),
    ]
    for label, run_id, artifacts in refused:
        with pytest.raises(ValueError):
            values.validate_artifacts(run_id, artifacts)
        assert label


def test_validate_artifacts_refuses_a_third_or_duplicated_report():
    second = persisted(artifact=artifact(id=OTHER_ARTIFACT),
                       storageKey=f"runs/{RUN}/{OTHER_ARTIFACT}.md")
    third = persisted(artifact=artifact(id=THIRD_ARTIFACT),
                      storageKey=f"runs/{RUN}/{THIRD_ARTIFACT}.md")
    # Three distinct reports exceed the retained-report limit; the duplicate cases below would also
    # be refused by the uniqueness rule, so both defects need their own case.
    with pytest.raises(ValueError):
        values.validate_artifacts(RUN, [persisted(), second, third])
    with pytest.raises(ValueError):
        values.validate_artifacts(RUN, [persisted(), second, second])
    with pytest.raises(ValueError):
        values.validate_artifacts(RUN, [persisted(), persisted()])


def test_validate_artifacts_requires_the_expected_argument_types():
    for refused in [None, 7, True, b"run"]:
        with pytest.raises(TypeError):
            values.validate_artifacts(refused, [])
    for refused in ["runs/x/y.md", b"{}", {"artifact": artifact()}]:
        with pytest.raises(TypeError):
            values.validate_artifacts(RUN, refused)


def test_artifact_name_follows_the_decode_report_shape():
    stem = "a" * 101
    accepted = ["report.md", "a.md", f"{stem}.md", "报表-1_v2.3.md", "Ⅷ.md", "٣.md", "a\u00b2.md",
                "notes.report.md"]
    for name in accepted:
        assert values.validate_artifacts(RUN, [persisted(artifact=artifact(name=name))]), name
    refused = [("no extension", "report"), ("upper-case extension", "report.MD"),
               ("trailing space", "report.md "), ("trailing newline", "report.md\n"),
               ("extension only", ".md"), ("leading underscore", "_report.md"),
               ("leading space", " report.md"), ("leading dot", ".report.md"),
               ("stem of 102", f"{stem}a.md"), ("emoji stem", "😀.md"),
               ("NUL in the stem", "report\0.md"), ("empty name", "")]
    for label, name in refused:
        with pytest.raises(ValueError):
            values.validate_artifacts(RUN, [persisted(artifact=artifact(name=name))])
        assert label


def test_artifact_size_and_timestamp_bounds():
    for accepted in [1, 32768, 2048.0]:
        assert values.validate_artifacts(RUN, [persisted(artifact=artifact(sizeBytes=accepted))])
    for refused in [0, -1, 32769, 1.5, math.inf, math.nan, True, "1", None]:
        with pytest.raises(ValueError):
            values.validate_artifacts(RUN, [persisted(artifact=artifact(sizeBytes=refused))])
    for accepted in [WHEN, "2026-01-02T03:04:05+00:00", "2026-01-02T11:04:05.123+08:00"]:
        assert values.validate_artifacts(RUN, [persisted(artifact=artifact(createdAt=accepted))])
    for refused in ["2026-01-02T03:04:05", "2026-01-02", "not-a-date", "", 5, None]:
        with pytest.raises(ValueError):
            values.validate_artifacts(RUN, [persisted(artifact=artifact(createdAt=refused))])


def test_metadata_must_be_bounded_finite_json():
    at_the_byte_ceiling = {"pad": "x" * 8182}
    assert len(encoded_metadata(at_the_byte_ceiling)) == 8192
    assert values.validate_artifacts(RUN, [persisted(metadata=at_the_byte_ceiling)])
    assert len(encoded_metadata({"pad": "x" * 8183})) == 8193
    assert values.validate_artifacts(RUN, [persisted(metadata=nested(8))])
    refused = [
        ("one byte over", {"pad": "x" * 8183}),
        ("one level too deep", nested(9)),
        ("not a number", {"ratio": math.nan}),
        ("infinite", {"ratio": math.inf}),
        ("unserializable", {"bytes": b"\x00"}),
        ("circular", None),
        ("lone surrogate", {"note": "\ud800"}),
        ("non-string key", {1: "a"}),
        ("list metadata", [1, 2]),
        ("string metadata", "{}"),
        ("null metadata", None),
        ("missing metadata", "absent"),
    ]
    circular = {}
    circular["self"] = circular
    for label, metadata in refused:
        if label == "circular":
            metadata = circular
        data = persisted()
        if label == "missing metadata":
            del data["metadata"]
        else:
            data["metadata"] = metadata
        with pytest.raises(ValueError):
            values.validate_artifacts(RUN, [data])


def test_persisted_artifact_refuses_unknown_fields():
    """``PersistedArtifact`` is strict: an unknown key is refused, not stripped."""
    with pytest.raises(ValueError):
        values.validate_artifacts(RUN, [persisted(ownerReviewed=True)])
    with pytest.raises(ValueError):
        values.validate_artifacts(RUN, [{**persisted(), "artifact": artifact(extra=True)}])


@pytest.mark.parametrize('metadata', [nested(1500), {'nested': {1:'coerced'}}, {'tuple': (1,2)},
    {'bad': '\0'}, {'bad\0key': True}, {'bad': object()}, {'nested': {'value':'\ud800'}}])
def test_metadata_rejects_deep_or_non_json_values_before_encoding(metadata):
    with pytest.raises(ValueError):
        values.validate_artifacts(RUN,[persisted(metadata=metadata)])


def test_existing_model_instances_cannot_bypass_artifact_or_proposal_validation():
    record = values.PersistedArtifact.model_validate(persisted())
    record.artifact.sizeBytes = 0
    with pytest.raises(ValueError):
        values.validate_artifacts(RUN,[record])
    record = values.PersistedArtifact.model_validate(persisted())
    record.metadata['nested'] = {1:'coercion'}
    with pytest.raises(ValueError):
        values.validate_artifacts(RUN,[record])
    draft = values.KnowledgeProposal.model_validate(proposal())
    draft.title = 'x'*161
    with pytest.raises(ValueError):
        values.validate_proposal(draft)
