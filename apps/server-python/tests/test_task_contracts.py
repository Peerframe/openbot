"""Contract tests for the task submission bundle: inputs, recipient selection, Run projections.

Everything asserted here was first probed against the real modules, so each expectation is the
observed behaviour rather than a restatement of the TypeScript source. These are unit tests: they do
not prove Owner authority, SQL, transaction boundaries or dispatch.
"""
import json
from datetime import datetime, timedelta, timezone
from typing import get_args

import pytest
from pydantic import ValidationError

from openbot_server import identity_inputs, message_models, task_inputs, task_models, task_routing

A = "1f8b0f1e-5e3d-4f8a-9c2b-7d6e5f4a3b2c"
B = "2f8b0f1e-5e3d-4f8a-9c2b-7d6e5f4a3b2c"
C = "3f8b0f1e-5e3d-4f8a-9c2b-7d6e5f4a3b2c"
ABSENT = "9f8b0f1e-5e3d-4f8a-9c2b-7d6e5f4a3b2c"
SEVEN = [f"1f8b0f1e-5e3d-4f8a-9c2b-{index:012x}" for index in range(7)]
WHEN = datetime(2026, 1, 2, 3, 4, 5, 123000, tzinfo=timezone.utc)


def candidate(identity, name, role, profile="docker-linux"):
    return task_routing.TaskCandidate(id=identity, name=name, role=role, computerProfile=profile)


def members():
    """A chief by role, a chief by name, and a plain member, in stored order."""
    return [candidate(A, "运维", "值班"), candidate(B, "Chief operator", "ops"),
            candidate(C, "调度中心", "调度")]


def run_row(**overrides):
    row = {"id": "run-1", "channel_id": "chan", "bot_id": A, "execution_profile": "docker-linux",
           "instruction": "巡检", "title": "巡检", "status": "queued", "model_usage": None,
           "created_at": WHEN, "updated_at": WHEN}
    row.update(overrides)
    return row


def public(model):
    """The payload every route actually sends: camelCase keys, no ``null`` optional field."""
    return model.model_dump(mode="json", exclude_none=True)


def usage(**overrides):
    value = {"provider": "openai", "model": "gpt-4.1-mini", "steps": 1, "inputTokens": 4,
             "outputTokens": 5}
    value.update(overrides)
    return value


def message():
    """The stored human message the submission envelope returns, projected by the accepted reader."""
    return message_models.project_messages([{
        "id": "m1", "channel_id": "chan", "author_type": "human", "content": "巡检",
        "created_at": WHEN, "author_id": None, "reply_to_message_id": None, "run_id": "run-1"}])[0]


# ---------------------------------------------------------------------------
# createMessageInputSchema
# ---------------------------------------------------------------------------

def test_content_is_trimmed_then_bounded_in_code_points():
    assert task_inputs.parse_message({"content": "  巡检\u00a0 "}).content == "巡检"
    assert len(task_inputs.parse_message({"content": "\U0001f600" * 8000}).content) == 8000
    for payload in ({"content": "   "}, {"content": "\ufeff"}, {"content": "\U0001f600" * 8001},
                    {"content": 5}, {}):
        with pytest.raises(ValidationError):
            task_inputs.parse_message(payload)


def test_unknown_keys_are_stripped_and_the_list_is_not_aliased():
    """The schema is a non-strict ``z.object``, and Zod returns a fresh array."""
    given = [A]
    parsed = task_inputs.parse_message({"content": "a", "botIds": given, "role": "chief"})
    assert list(public(parsed)) == ["content", "botIds"]
    given.append(B)
    assert parsed.botIds == [A]


def test_omission_differs_from_an_explicit_null_for_every_optional_field():
    omitted = task_inputs.parse_message({"content": "a"})
    assert (omitted.botId, omitted.botIds, omitted.replyToMessageId) == (None, None, None)
    for field in ("botId", "botIds", "replyToMessageId"):
        with pytest.raises(ValidationError):
            task_inputs.parse_message({"content": "a", field: None})
    # A present key is not an omission, and the public payload carries only what was sent.
    assert set(public(task_inputs.parse_message({"content": "a", "replyToMessageId": B}))) == {
        "content", "replyToMessageId"}


def test_recipient_sets_are_unambiguous_bounded_and_never_normalised():
    with pytest.raises(ValidationError, match="Choose botId or botIds, not both."):
        task_inputs.parse_message({"content": "a", "botId": A, "botIds": [A]})
    with pytest.raises(ValidationError, match="Bot recipients must be unique."):
        task_inputs.parse_message({"content": "a", "botIds": [A, A]})
    for count in (0, 7):
        with pytest.raises(ValidationError):
            task_inputs.parse_message({"content": "a", "botIds": SEVEN[:count]})
    # Case is part of the identity: two spellings are two recipients, and each is kept verbatim.
    upper = A.upper()
    parsed = task_inputs.parse_message({"content": "a", "botIds": [upper, A]})
    assert parsed.botIds == [upper, A]
    with pytest.raises(ValidationError):
        task_inputs.parse_message({"content": "a", "botId": "nope"})


def test_the_published_request_body_describes_the_real_bounds():
    """The route publishes this schema as ``openapi_extra``, so it must not understate a limit."""
    body = task_inputs.CreateMessageInput.model_json_schema()
    properties = body["properties"]
    assert body["required"] == ["content"]
    assert properties["content"]["minLength"] == 1
    assert properties["content"]["maxLength"] == 8000
    assert properties["botIds"]["minItems"] == 1
    assert properties["botIds"]["maxItems"] == 6
    # One UUID text, shared with the accepted identity adapters rather than re-derived here.
    for field in ("botId", "botIds", "replyToMessageId"):
        assert field not in body.get("required", [])
    assert properties["botId"]["pattern"] == identity_inputs._UUID_PATTERN_TEXT
    assert properties["botIds"]["items"]["pattern"] == properties["replyToMessageId"]["pattern"]
    assert "null" not in json.dumps(properties)
    assert "default" not in json.dumps(properties)


# ---------------------------------------------------------------------------
# task-routing
# ---------------------------------------------------------------------------

def select(payload, candidates=None, direct=None):
    return task_routing.select_assignees(candidates if candidates is not None else members(),
                                        task_inputs.parse_message(payload), direct)


def test_the_default_recipient_is_a_chief_like_member_else_the_first():
    assert [c.id for c in select({"content": "x"})] == [B]          # "Chief" in the name
    assert [c.id for c in select({"content": "x"}, [candidate(A, "运维", "总管辖")])] == [A]
    assert [c.id for c in select({"content": "x"}, [candidate(A, "运维", "协调组")])] == [A]
    plain = [candidate(A, "运维", "值班"), candidate(B, "值班", "值班")]
    assert [c.id for c in select({"content": "x"}, plain)] == [A]
    with pytest.raises(task_routing.TaskValidation,
                       match="Add a Bot to this channel before assigning a task."):
        select({"content": "x"}, [])


def test_requested_recipients_keep_the_callers_order_and_are_all_validated():
    assert [c.id for c in select({"content": "x", "botIds": [C, A]})] == [C, A]
    assert [c.id for c in select({"content": "x", "botId": A})] == [A]
    # A missing member rejects the whole set: no partial recipient list may reach a writer.
    with pytest.raises(task_routing.TaskValidation,
                       match="The selected Bot is not a member of this channel."):
        select({"content": "x", "botIds": [A, ABSENT]})
    with pytest.raises(task_routing.TaskValidation,
                       match="The selected Bot is not a member of this channel."):
        select({"content": "x", "botId": ABSENT})


def test_a_direct_conversation_can_only_address_its_own_bot():
    assert [c.id for c in select({"content": "x"}, direct=A)] == [A]
    with pytest.raises(task_routing.TaskValidation,
                       match="A direct conversation can only address its Bot."):
        select({"content": "x", "botId": B}, direct=A)
    with pytest.raises(task_routing.TaskValidation,
                       match="A direct conversation can only address its Bot."):
        select({"content": "x", "botIds": [A, B]}, direct=A)
    with pytest.raises(task_routing.TaskValidation,
                       match="The selected Bot is not a member of this channel."):
        select({"content": "x"}, [], direct=A)


def test_role_text_only_changes_the_default_pick_never_who_may_be_addressed():
    """A "chief" title is a hint for the default choice; it grants nothing and hides nobody."""
    crew = [candidate(A, "运维", "值班"), candidate(B, "Chief", "ops"), candidate(C, "巡检", "调度")]
    assert [c.id for c in select({"content": "x", "botId": A}, crew)] == [A]
    assert [c.id for c in select({"content": "x", "botIds": [A, C]}, crew)] == [A, C]
    # The candidate comes back exactly as the membership read produced it: same profile, no extras.
    returned = select({"content": "x", "botId": B}, crew)[0]
    assert returned.computerProfile == "docker-linux"
    assert returned.model_dump() == {"id": B, "name": "Chief", "role": "ops",
                                     "computerProfile": "docker-linux"}
    # Renaming the default winner cannot promote anyone either.
    renamed = [candidate(A, "运维", "值班"), candidate(B, "普通成员", "ops")]
    assert [c.id for c in select({"content": "x"}, renamed)] == [A]


def test_a_hand_built_input_cannot_bypass_the_recipient_rules():
    """``select_assignees`` re-derives the schema's rules instead of trusting the caller."""
    for bot_ids in ([A, A], []):
        hand_built = task_inputs.CreateMessageInput.model_construct(content="x", botIds=bot_ids)
        with pytest.raises(task_routing.TaskValidation,
                           match="Choose one to six unique Bot recipients."):
            task_routing.select_assignees(members(), hand_built)
    both = task_inputs.CreateMessageInput.model_construct(content="x", botId=A, botIds=[A])
    with pytest.raises(task_routing.TaskValidation, match="Choose botId or botIds, not both."):
        task_routing.select_assignees(members(), both)


# ---------------------------------------------------------------------------
# Run and RunModelUsage
# ---------------------------------------------------------------------------

def test_run_optionals_follow_to_runs_two_different_omission_rules():
    """``toRun`` spreads four optionals on truthiness and the rest on null-ness; both are kept."""
    projected = task_models.project_run(run_row(parent_run_id=None, root_run_id="", error_code="",
                                                source_message_id="", node_id="", result_summary="",
                                                error_message=""))
    payload = public(projected)
    assert "parentRunId" not in payload and "rootRunId" not in payload and "errorCode" not in payload
    assert payload["sourceMessageId"] == "" and payload["nodeId"] == ""
    assert payload["resultSummary"] == "" and payload["errorMessage"] == ""
    # ``instruction`` falls back only on null, so an empty stored instruction stays empty.
    assert public(task_models.project_run(run_row(instruction=None)))["instruction"] == "巡检"
    assert public(task_models.project_run(run_row(instruction="")))["instruction"] == ""


def test_stored_state_must_be_a_known_value_and_timestamps_must_be_aware():
    for override in ({"status": "robot"}, {"execution_profile": "quantum"}, {"created_at": "2026-01-02"},
                     {"created_at": datetime(2026, 1, 2, 3, 4, 5)}, {"updated_at": None}):
        with pytest.raises((ValidationError, ValueError)):
            task_models.project_run(run_row(**override))
    with pytest.raises(KeyError):
        task_models.project_run({key: value for key, value in run_row().items() if key != "title"})
    assert task_models.project_run(run_row(status="cancelled")).status == "cancelled"


def test_run_projection_whitelists_columns_and_preserves_content_verbatim():
    content = "\U0001f600 运维 \"quoted\"\n第二行"
    offset = datetime(2026, 1, 2, 11, 4, 5, 123999, tzinfo=timezone(timedelta(hours=8)))
    noisy = run_row(instruction=content, title=content, created_at=offset, updated_at=offset,
                    prompt="hidden", token_budget=7, private_secret="s3cr3t")
    projected = task_models.project_run(noisy)
    payload = public(projected)
    assert sorted(payload) == ["botId", "channelId", "createdAt", "executionProfile", "id",
                               "instruction", "status", "title", "updatedAt"]
    assert "s3cr3t" not in json.dumps(payload)
    assert projected.instruction == content and projected.title == content
    assert projected.createdAt == "2026-01-02T03:04:05.123Z"      # normalised to UTC, ms truncated
    # The content survives JSON transport verbatim, with astral characters left unescaped.
    text = json.dumps(payload, ensure_ascii=False)
    assert json.loads(text)["instruction"] == content
    assert "\U0001f600" in text


def test_run_batches_are_capped_ordered_and_left_unmutated():
    rows = [run_row(id=f"run-{index}", title=f"t{index}") for index in range(50)]
    assert [run.id for run in task_models.project_runs(rows)] == [row["id"] for row in rows]
    assert task_models.project_runs([]) == []
    assert set(rows[0]) == set(run_row()) and rows[0]["title"] == "t0"
    with pytest.raises(ValueError, match="At most 50 runs"):
        task_models.project_runs([run_row(id=f"run-{index}") for index in range(51)])


def test_usage_is_reported_evidence_and_only_an_unreadable_value_is_dropped():
    assert task_models.project_run(run_row(model_usage=usage())).modelUsage.steps == 1
    assert task_models.project_run(run_row(model_usage=None)).modelUsage is None
    # Zod has one number type, so an integral float is the integer it denotes.
    integral = task_models.project_run(run_row(model_usage=usage(steps=3.0, inputTokens=5.0)))
    assert (integral.modelUsage.steps, integral.modelUsage.inputTokens) == (3, 5)
    unreadable = [
        ("unknown provider", usage(provider="acme")), ("bool steps", usage(steps=True)),
        ("string tokens", usage(inputTokens="4")), ("fractional steps", usage(steps=1.5)),
        ("nine steps", usage(steps=9)), ("extra key", usage(costUsd=0.01)),
        ("nan tokens", usage(inputTokens=float("nan"))), ("infinite tokens", usage(outputTokens=1e400)),
        ("malformed model", usage(model="not ok")), ("not an object", ["openai"]),
    ]
    for label, value in unreadable:
        projected = task_models.project_run(run_row(model_usage=value))
        assert projected.modelUsage is None, label
        assert projected.status == "queued", label       # the Run itself still projects


def test_the_provider_set_is_the_domain_union_and_the_published_usage_is_truthful():
    assert set(get_args(task_models.ModelProviderId)) == {
        "openai", "anthropic", "gemini", "deepseek", "moonshot", "openrouter", "siliconflow",
        "dashscope", "zai", "minimax", "ark"}
    schema = task_models.RunUsage.model_json_schema()
    assert set(schema["required"]) == {"provider", "model", "steps", "inputTokens", "outputTokens"}
    assert schema["properties"]["steps"] == {"maximum": 8, "minimum": 1, "title": "Steps",
                                             "type": "integer"}
    for field in ("inputTokens", "outputTokens"):
        assert schema["properties"][field]["anyOf"][1] == {"type": "null"}
    assert schema["additionalProperties"] is False


def test_explicit_null_token_counts_survive_every_exclude_none_dump():
    """``null`` means "a count was unavailable", so the route's ``exclude_none`` must not drop it."""
    tokens = usage(inputTokens=None, outputTokens=None)
    run = task_models.project_run(run_row(model_usage=tokens))
    payload = public(run)
    assert payload["modelUsage"] == {"provider": "openai", "model": "gpt-4.1-mini", "steps": 1,
                                     "inputTokens": None, "outputTokens": None}
    assert json.loads(json.dumps(payload))["modelUsage"]["inputTokens"] is None
    # A partially reported usage keeps the reported half and the explicit null.
    half = public(task_models.project_run(run_row(model_usage=usage(outputTokens=None))))
    assert half["modelUsage"]["inputTokens"] == 4 and half["modelUsage"]["outputTokens"] is None
    # The same holds two levels down, inside the submission envelope.
    envelope = task_models.SubmitTaskResult(message=message(), run=run, runs=[run])
    assert public(envelope)["runs"][0]["modelUsage"]["outputTokens"] is None


def test_the_submission_envelope_carries_the_runs_list_only_when_recipients_were_named():
    run = task_models.project_run(run_row())
    single = task_models.SubmitTaskResult(message=message(), run=run)
    assert set(public(single)) == {"message", "run"}
    assert set(public(task_models.SubmitTaskResult(message=message(), run=run, runs=[run]))) == {
        "message", "run", "runs"}
    assert task_models.SubmitTaskResult.model_json_schema()["required"] == ["message", "run"]
    assert set(public(task_models.RunsResponse(runs=[run]))) == {"runs"}
