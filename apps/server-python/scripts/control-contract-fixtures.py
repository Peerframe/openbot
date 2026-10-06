"""Actual public DTO serialization and retained request parser parity, without product services."""

import json
import sys
from copy import deepcopy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from datetime import datetime

from openbot_server import browser_protocol as browser
from openbot_server import employee_portability_inputs as portability
from openbot_server import plugin_inputs as plugins
from openbot_server.approval_settings import ApprovalSettingsInput
from openbot_server.attachment_processing import AttachmentProcessInput
from openbot_server.auth_routes import LoginInput, LoginResponse, PasswordChangeInput
from openbot_server.bot_appearance import AppearanceInput, AppearanceResult
from openbot_server.automation_store import CreateAutomationInput as AutomationInput
from openbot_server.automation_store import _project as project_automation
from openbot_server.control_errors import ControlError
from openbot_server.conversation_interactions import SetMessageReaction
from openbot_server.conversations import JoinChannelInput
from openbot_server.employee_knowledge import _evolution, _memory, _memory_event, _skill
from openbot_server.employee_knowledge_inputs import (
    CreateMemoryInput,
    CreateSkillInput,
    DeleteMemoryInput,
    ImportSkillInput,
    ReviewProposalInput,
    SkillStateInput,
    UpdateMemoryInput,
    parse_memory_create,
    parse_memory_update,
)
from openbot_server.employee_portability import _receipt
from openbot_server.employee_portability_format import inspect_template, prepare_export
from openbot_server.identity_inputs import (
    CreateBotInput,
    CreateChannelInput,
    QuickCreateBotInput,
)
from openbot_server.identity_lifecycle import RenameBotInput, RenameChannelInput
from openbot_server.identity_routes import (
    BotResponse,
    ChannelResponse,
    QuickBotResponse,
)
from openbot_server.message_models import Message, MessagesResponse
from openbot_server.model_connections_inputs import (
    CreateModelConnectionInput,
    DeleteModelConnectionInput,
    TestModelConnectionInput,
    UpdateEmployeeModelInput,
    UpdateModelConnectionInput,
    VerifyModelConnectionInput,
)
from openbot_server.models import (
    AuthSession,
    Bot,
    BotsResponse,
    Channel,
    ChannelsResponse,
)
from openbot_server.owner_preferences import PreferencesInput
from openbot_server.product_control import AutomationEnabled
from openbot_server.profile_details import ProfileDetailsInput, ProfileMutationResult
from openbot_server.run_commands import (
    CancelRunInput,
    CancelRunResponse,
    SteeringResponse,
    SteerRunInput,
)
from openbot_server.task_inputs import CreateMessageInput
from openbot_server.task_models import Run, RunsResponse, RunUsage, SubmitTaskResult
from openbot_server.transcription_settings import TranscriptionInput
from openbot_server.worker_host_protocol import EnrollmentInput, ExchangeInput
from openbot_server.workspace_settings import PrimaryBotInput
from pydantic import SecretStr, TypeAdapter, ValidationError

TIME = "2026-10-06T00:00:00.000Z"
ID = "00000000-0000-4000-8000-000000000001"
APPEARANCE = {
    "head": "round",
    "body": "classic",
    "mobility": "feet",
    "accessory": "none",
    "accent": "green",
}
BOT = {
    "id": ID,
    "name": "Synthetic 员工 🧪",
    "role": "Read fixtures",
    "status": "idle",
    "computerProfile": "none",
    "createdAt": TIME,
}
CHANNEL = {
    "id": "channel",
    "name": "Room",
    "description": "",
    "botIds": [ID],
    "createdAt": TIME,
}
MESSAGE = {
    "id": "message",
    "channelId": "channel",
    "authorType": "human",
    "content": "文档",
    "createdAt": TIME,
}
USAGE = {
    "provider": "openai",
    "model": "fixture/model",
    "steps": 1,
    "inputTokens": None,
    "outputTokens": 0,
}
RUN = {
    "id": "run",
    "channelId": "channel",
    "botId": ID,
    "executionProfile": "none",
    "instruction": "Read",
    "title": "Read",
    "status": "queued",
    "createdAt": TIME,
    "updatedAt": TIME,
}
AUTH = {
    "authenticated": True,
    "owner": {"id": "owner", "name": "Owner"},
    "expiresAt": TIME,
}


def public_secrets(value):
    # Only fixed synthetic secrets travel to the comparator; no inherited credentials are read.
    if isinstance(value, SecretStr):
        return value.get_secret_value()
    if isinstance(value, dict):
        return {key: public_secrets(item) for key, item in value.items()}
    if isinstance(value, list):
        return [public_secrets(item) for item in value]
    return value


def mutations(seed):
    yield "base", seed
    yield "unknown-field", seed | {"extra": True}
    for field in seed:
        missing = deepcopy(seed)
        del missing[field]
        yield "missing-" + field, missing
        yield "null-" + field, seed | {field: None}
        yield "boolean-" + field, seed | {field: True}


def fixtures():
    projections = []
    sources = [
        ("BotAppearanceResult", TypeAdapter(AppearanceResult),
         {"bot": BOT | {"appearance": APPEARANCE}, "revision": 2}),
        ("Message", TypeAdapter(Message),
         MESSAGE | {"authorType": "bot", "authorId": ID, "origin": "greeting"}),
        (
            "ProfileMutationResult",
            TypeAdapter(ProfileMutationResult),
            {
                "employee": BOT,
                "details": {
                    "description": "Synthetic biography",
                    "revision": 2,
                    "updatedAt": TIME,
                },
                "evolution": {
                    "id": "evolution",
                    "botId": ID,
                    "type": "role_changed",
                    "title": "Updated",
                    "summary": "Owner updated role.",
                    "source": "manual",
                    "evidence": [],
                    "createdAt": TIME,
                },
            },
        ),
        ("AuthSession", TypeAdapter(AuthSession), AUTH),
        ("AuthSession", TypeAdapter(AuthSession), {"authenticated": False}),
        ("CancelRunResponse", TypeAdapter(CancelRunResponse), {"run": RUN}),
        (
            "SteeringResponse",
            TypeAdapter(SteeringResponse),
            {
                "steering": {
                    "id": "steer",
                    "runId": "run",
                    "channelId": "channel",
                    "botId": ID,
                    "instruction": "Synthetic correction",
                    "createdAt": TIME,
                }
            },
        ),
        ("LoginResponse", TypeAdapter(LoginResponse), {"session": AUTH}),
        (
            "Bot",
            TypeAdapter(Bot),
            BOT
            | {
                "appearance": APPEARANCE,
                "model": {"connectionId": "fixture", "modelId": "model"},
            },
        ),
        (
            "Channel",
            TypeAdapter(Channel),
            CHANNEL
            | {
                "latestMessage": {
                    "id": "message",
                    "authorType": "human",
                    "preview": "🧪" * 160,
                    "createdAt": TIME,
                }
            },
        ),
        (
            "Message",
            TypeAdapter(Message),
            MESSAGE
            | {"authorId": "owner", "replyToMessageId": "prior", "runId": "run"},
        ),
        ("Run", TypeAdapter(Run), RUN | {"modelUsage": USAGE}),
        ("RunUsage", TypeAdapter(RunUsage), USAGE),
        ("BotResponse", TypeAdapter(BotResponse), {"bot": BOT}),
        ("ChannelResponse", TypeAdapter(ChannelResponse), {"channel": CHANNEL}),
        (
            "QuickBotResponse",
            TypeAdapter(QuickBotResponse),
            {"bot": BOT, "channel": CHANNEL},
        ),
        ("BotsResponse", TypeAdapter(BotsResponse), {"bots": [BOT]}),
        ("ChannelsResponse", TypeAdapter(ChannelsResponse), {"channels": [CHANNEL]}),
        (
            "MessagesResponse",
            TypeAdapter(MessagesResponse),
            {"messages": [MESSAGE], "hasMore": False},
        ),
        ("RunsResponse", TypeAdapter(RunsResponse), {"runs": [RUN]}),
        (
            "SubmitTaskResult",
            TypeAdapter(SubmitTaskResult),
            {"message": MESSAGE, "run": RUN, "runs": [RUN]},
        ),
    ]
    for schema, adapter, seed in sources:
        for name, value in mutations(seed):
            record = {"schema": schema, "name": name, "input": value}
            try:
                parsed = adapter.validate_python(value)
                record.update(
                    valid=True,
                    serialized=adapter.dump_python(
                        parsed, mode="json", exclude_none=True
                    ),
                )
            except (ValidationError, ValueError):
                record["valid"] = False
            projections.append(record)

    evolution = {
        "id": "evolution",
        "bot_id": ID,
        "type": "skill_discovered",
        "title": "Added",
        "summary": "Owner review pending.",
        "source": "manual",
        "source_id": "skill",
        "evidence": [],
        "created_at": TIME,
    }
    skill = {
        "id": "skill",
        "slug": "evidence-report",
        "name": "Evidence",
        "description": "Read evidence",
        "version": "1.0.0",
        "required_capabilities": ["browser", 1],
        "skill_markdown": None,
        "content_sha256": None,
    }
    assignment = {
        "source": "manual",
        "state": "candidate",
        "confidence": 0,
        "evidence": [],
        "acquired_at": TIME,
        "updated_at": TIME,
    }
    memory = {
        "id": "memory",
        "bot_id": ID,
        "kind": "semantic",
        "title": "Fact",
        "content": "Evidence",
        "sensitivity": "internal",
        "portability": "never",
        "provenance": {"source": "owner"},
        "model_use_enabled": False,
        "revision": 1,
        "created_at": TIME,
        "updated_at": TIME,
    }
    memory_event = {
        "id": "event",
        "bot_id": ID,
        "memory_id": "memory",
        "action": "created",
        "revision": 1,
        "changed_fields": ["title", "content", "privateField"],
        "created_at": TIME,
    }
    for schema, result in [
        ("EmployeeEvolution", _evolution(evolution)),
        ("EmployeeSkill", _skill(skill, assignment, [])),
        (
            "EmployeeSkill",
            _skill(
                skill
                | {"skill_markdown": "Synthetic source", "content_sha256": "a" * 64},
                assignment,
                [],
            ),
        ),
        ("EmployeeMemory", _memory(memory)),
        ("EmployeeMemoryEvent", _memory_event(memory_event)),
    ]:
        projections.append(
            {
                "schema": schema,
                "name": "actual-helper",
                "input": result,
                "valid": True,
                "serialized": result,
            }
        )

    requests = []
    inputs = [
        (
            "CreateNodeEnrollmentTokenInput",
            EnrollmentInput,
            {"nodeId": " Fixture:host_01 ", "expiresInSeconds": 60.0},
            False,
        ),
        (
            "ExchangeNodeEnrollmentInput",
            ExchangeInput,
            {"nodeId": " Fixture:host_01 ", "token": "obenr_" + "a" * 43},
            False,
        ),
        ("LoginInput", LoginInput, {"password": " synthetic-password "}, False),
        (
            "PasswordChangeInput",
            PasswordChangeInput,
            {
                "currentPassword": "synthetic-current",
                "newPassword": "synthetic-replacement",
            },
            False,
        ),
        (
            "CreateBotInput",
            CreateBotInput,
            {"name": " Bot ", "role": " Read ", "computerProfile": "none"},
            True,
        ),
        ("QuickCreateBotInput", QuickCreateBotInput, {"appearance": APPEARANCE}, True),
        (
            "CreateChannelInput",
            CreateChannelInput,
            {"name": " Room ", "description": " Notes ", "botIds": [ID, ID]},
            True,
        ),
        ("JoinChannelInput", JoinChannelInput, {"botId": ID}, True),
        (
            "CreateMessageInput",
            CreateMessageInput,
            {"content": " Read 文档 ", "botIds": [ID], "replyToMessageId": ID},
            True,
        ),
        (
            "OwnerPreferencesInput",
            PreferencesInput,
            {"expectedRevision": 1, "timezone": "Asia/Singapore", "defaultModel": None},
            False,
        ),
        (
            "WorkspacePrimaryBotInput",
            PrimaryBotInput,
            {"botId": None, "expectedRevision": 1},
            False,
        ),
    ]
    model_input = {
        "name": " Fixture ",
        "presetId": "openai",
        "baseUrl": "https://api.openai.com/v1",
        "apiKey": " synthetic-key ",
        "defaultModel": None,
    }
    inputs.extend(
        [
            (
                "CreateAutomationInput",
                AutomationInput,
                {
                    "name": " Schedule ",
                    "channelId": ID,
                    "botId": ID,
                    "prompt": " Read evidence ",
                    "intervalMinutes": 60.0,
                    "firstRunAt": TIME,
                },
                False,
            ),
            ("UpdateAutomationInput", AutomationEnabled, {"enabled": False}, False),
            (
                "UpdateBotAppearanceInput", AppearanceInput,
                {"expectedRevision": 1, "appearance": APPEARANCE}, False,
            ),
            (
                "UpdateEmployeeProfileDetailsInput",
                ProfileDetailsInput,
                {
                    "role": " Fixture role ",
                    "description": " Biography ",
                    "expectedRevision": 1,
                },
                False,
            ),
            (
                "CreateEmployeeSkillInput",
                CreateSkillInput,
                {
                    "slug": " evidence-report ",
                    "name": " Evidence ",
                    "description": " Read evidence ",
                    "version": " 1.2.3 ",
                    "source": "manual",
                    "requiredCapabilities": ["shell", "browser", "shell"],
                    "dependencySkillIds": [ID, ID],
                    "evidence": [
                        {"kind": "manual", "id": " source ", "label": " Evidence "}
                    ],
                    "reason": " Add ",
                },
                True,
            ),
            (
                "ImportEmployeeSkillInput",
                ImportSkillInput,
                {
                    "markdown": "---\nname: evidence-report\ndescription: Read evidence\n---\nRead sources.\n",
                    "version": "1.0.0",
                    "reason": " Import ",
                },
                True,
            ),
            (
                "UpdateEmployeeSkillStateInput",
                TypeAdapter(SkillStateInput),
                {
                    "state": "verified",
                    "confidence": 80,
                    "ownerReviewed": True,
                    "reason": " Checked ",
                },
                True,
            ),
            (
                "CreateEmployeeMemoryInput",
                CreateMemoryInput,
                {
                    "kind": "semantic",
                    "title": " Fact ",
                    "content": " Evidence ",
                    "sensitivity": "internal",
                    "portability": "never",
                },
                True,
            ),
            (
                "UpdateEmployeeMemoryInput",
                UpdateMemoryInput,
                {"expectedRevision": 1, "title": " Corrected fact "},
                True,
            ),
            (
                "DeleteEmployeeMemoryInput",
                DeleteMemoryInput,
                {"expectedRevision": 1, "ownerReviewed": True},
                True,
            ),
            (
                "ReviewKnowledgeProposalInput",
                TypeAdapter(ReviewProposalInput),
                {
                    "decision": "accept",
                    "ownerReviewed": True,
                    "title": " Fact ",
                    "content": " Evidence ",
                    "modelUseEnabled": False,
                },
                True,
            ),
            ("RenameBotInput", RenameBotInput, {"name": " Fixture 🧪 "}, True),
            ("RenameChannelInput", RenameChannelInput, {"name": " Room 🧪 "}, True),
            (
                "SetMessageReactionInput",
                SetMessageReaction,
                {"emoji": "👍", "active": True},
                True,
            ),
            ("CancelRunInput", CancelRunInput, {}, True),
            ("SteerRunInput", SteerRunInput, {"instruction": " Correct 🧪 "}, True),
            (
                "ApprovalSettingsInput",
                ApprovalSettingsInput,
                {
                    "expectedRevision": 1,
                    "productRead": "inherit",
                    "publicWeb": "required",
                    "exceptions": [
                        {
                            "botId": ID,
                            "category": "product_read",
                            "target": {"kind": "channel", "value": ID},
                        }
                    ],
                },
                True,
            ),
            (
                "CreateModelConnectionInput",
                CreateModelConnectionInput,
                model_input,
                "explicit",
            ),
            (
                "UpdateModelConnectionInput",
                UpdateModelConnectionInput,
                {"expectedRevision": 1, "name": " Fixture ", "defaultModel": None},
                "explicit",
            ),
            (
                "VerifyModelConnectionInput",
                VerifyModelConnectionInput,
                {key: model_input[key] for key in ("presetId", "baseUrl", "apiKey")},
                True,
            ),
            (
                "DeleteModelConnectionInput",
                DeleteModelConnectionInput,
                {"expectedRevision": 1},
                True,
            ),
            (
                "TestModelConnectionInput",
                TestModelConnectionInput,
                {"modelId": " vendor/model@route "},
                True,
            ),
            (
                "UpdateEmployeeModelInput",
                UpdateEmployeeModelInput,
                {"expectedRevision": 1, "model": None},
                False,
            ),
            (
                "TranscriptionSettingsInput",
                TranscriptionInput,
                {"expectedRevision": 1, "connectionId": None},
                False,
            ),
            (
                "AttachmentProcessInput",
                AttachmentProcessInput,
                {"operation": "extract", "password": " transient password "},
                True,
            ),
        ]
    )
    expanded = [
        (schema, model, name, value, exclude_none)
        for schema, model, seed, exclude_none in inputs
        for name, value in mutations(seed)
    ]
    for revision in [1.0, 0, 1.5, "1", 2**53 - 1, 2**53]:
        expanded.append(("UpdateBotAppearanceInput", AppearanceInput, "revision-boundary",
                         {"expectedRevision": revision, "appearance": APPEARANCE}, False))
    for appearance in [
        {**APPEARANCE, "extra": True},
        {key: value for key, value in APPEARANCE.items() if key != "body"},
        {**APPEARANCE, "accent": "orange"},
        *({**APPEARANCE, "accent": accent} for accent in
          ["green", "yellow", "red", "blue", "violet", "teal", "pink", "slate"]),
    ]:
        expanded.append(("UpdateBotAppearanceInput", AppearanceInput, "complete-appearance",
                         {"expectedRevision": 1, "appearance": appearance}, False))
    for origin in ["unknown", False, 1]:
        value = MESSAGE | {"origin": origin}
        try:
            Message.model_validate(value)
            raise AssertionError("Unsupported origin unexpectedly accepted.")
        except ValidationError:
            projections.append({"schema": "Message", "name": "invalid-origin",
                                "input": value, "valid": False})
    portable_skill = {
        "slug": "evidence",
        "name": " Evidence ",
        "description": " Read ",
        "version": " 1.0.0 ",
        "requiredCapabilities": [],
        "dependencySlugs": [],
    }
    portable_payload = {
        "format": "openbot.employee/v1",
        "kind": "template",
        "packageId": ID,
        "generatedAt": TIME,
        "employee": {"name": " Fixture ", "role": " Read ", "appearance": APPEARANCE},
        "configuration": {"recommendedExecutionProfile": "none"},
        "skills": [portable_skill],
        "requestedCapabilities": [],
        "portability": {
            "identity": "new-on-import",
            "authority": "none",
            "memories": "none",
            "importedSkillState": "disabled-pending-review",
        },
        "signature": {"status": "unsigned"},
    }
    portable_package = {
        "payload": portable_payload,
        "integrity": {
            "algorithm": "sha256",
            "canonicalization": "openbot-json-v1",
            "digest": "a" * 64,
        },
    }
    for schema, model, seed in [
        (
            "PortableEmployee",
            portability.PortableEmployee,
            portable_payload["employee"],
        ),
        ("PortableSkill", portability.PortableSkill, portable_skill),
        ("PortablePayload", portability.PortablePayload, portable_payload),
        ("EmployeePackage", portability.EmployeePackage, portable_package),
        (
            "EmployeeDsseEnvelope",
            portability.DsseEnvelope,
            {
                "payload": "YWJj",
                "payloadType": "fixture",
                "signatures": [{"sig": "YWJj", "future": None}],
                "future": [None, True],
            },
        ),
        (
            "EmployeeExportDownloadInput",
            portability.ExportDownloadInput,
            {"packageId": ID, "generatedAt": TIME},
        ),
        (
            "ActivateEmployeeImportInput",
            portability.ActivateInput,
            {
                "package": {"opaque": "service-validated"},
                "expectedPackageId": ID,
                "expectedDigest": "a" * 64,
                "ownerReviewed": True,
                "allowUnsigned": False,
                "idempotencyKey": ID,
                "employeeName": " Name ",
            },
        ),
        ("BrowserOwnerAction", browser.Action, {"kind": "observe"}),
        ("BrowserMaintenanceInput", browser.MaintenanceInput, {"operation": "status"}),
        (
            "BrowserFrame",
            browser.BrowserFrame,
            {
                "base64": "AAAAAAAAAAAA",
                "width": 1.0,
                "height": 1.0,
                "url": "fixture",
                "capturedAt": TIME,
            },
        ),
    ]:
        expanded.extend(
            (schema, model, name, value, True) for name, value in mutations(seed)
        )
    for value in [
        {"kind": "take"},
        {"kind": "release"},
        {"kind": "click", "x": 1, "y": 8192},
        {"kind": "click", "x": True, "y": 1},
        {"kind": "type", "text": "🧪" * 4096},
        {"kind": "type", "text": "🧪" * 4097},
        {"kind": "type", "text": "\ud800"},
        {"kind": "scroll", "deltaY": 2000.0},
        {"kind": "scroll", "deltaY": 2000.5},
        {"kind": "key", "key": "Tab"},
        *(
            {"kind": "navigate", "url": url}
            for url in [
                "https://fixture.invalid/\tpath",
                "mailto:owner@example.invalid",
                "custom:",
                "file:///tmp/fixture",
                "not a URL",
            ]
        ),
    ]:
        expanded.append(
            ("BrowserOwnerAction", browser.Action, "retained-action", value, True)
        )
    for value in [
        {"operation": "clear"},
        {"operation": "clear", "confirmation": "clear-browser-data"},
        {"operation": "restart", "confirmation": "clear-browser-data"},
        {"operation": "status", "confirmation": None},
    ]:
        expanded.append(
            (
                "BrowserMaintenanceInput",
                browser.MaintenanceInput,
                "confirmation",
                value,
                True,
            )
        )
    for stamp in [
        "2026-10-06T00:00Z",
        "2026-10-06T00:00:00.1234567Z",
        "0000-01-01T00:00Z",
        "0000-02-29T00:00:00Z",
        "0000-02-30T00:00:00Z",
        "2026-02-29T00:00Z",
        "2026-10-06T00:00:60Z",
    ]:
        expanded.append(
            (
                "EmployeeExportDownloadInput",
                portability.ExportDownloadInput,
                "timestamp",
                {"packageId": ID, "generatedAt": stamp},
                True,
            )
        )
        expanded.append(
            (
                "BrowserFrame",
                browser.BrowserFrame,
                "timestamp",
                {
                    "base64": "AAAAAAAAAAAA",
                    "width": 1,
                    "height": 1,
                    "url": "fixture",
                    "capturedAt": stamp,
                },
                True,
            )
        )
    for changes in [
        {"name": "🧪" * 64},
        {"name": "🧪" * 65},
        {"description": "\ud800"},
        {"appearance": APPEARANCE | {"extra": True}},
    ]:
        expanded.append(
            (
                "PortableEmployee",
                portability.PortableEmployee,
                "unicode/appearance",
                portable_payload["employee"] | changes,
                True,
            )
        )
    source = {
        "employee": BOT,
        "details": {"description": "Biography"},
        "configuration": {"executionProfile": "none"},
        "skills": [],
        "memories": [{"content": "private"}],
        "evolution": [],
        "records": {
            kind: [] for kind in ("runs", "approvals", "artifacts", "decisions")
        },
    }
    exported = prepare_export(source, package_id=ID, generated_at=TIME)
    for schema, value in [
        ("EmployeeExportPreview", exported["preview"]),
        ("EmployeeImportPreview", inspect_template(exported["document"], [])),
        (
            "EmployeeImportReceipt",
            _receipt(
                {
                    "id": ID,
                    "package_id": ID,
                    "package_digest": "a" * 64,
                    "employee_id": ID,
                    "signature_status": "unsigned",
                    "publisher_key_id": None,
                    "reviewed_at": datetime.fromisoformat(TIME),
                    "imported_skill_count": 0,
                    "created_at": datetime.fromisoformat(TIME),
                }
            ),
        ),
    ]:
        projections.append(
            {
                "schema": schema,
                "name": "actual-helper",
                "input": value,
                "valid": True,
                "serialized": value,
            }
        )
    # Exercise the retained parser, including detach/default/null and alias behavior.
    plugin_models = {
        "PluginEndpointInput": plugins.Endpoint,
        "InstallPluginInput": plugins.Install,
        "UpdatePluginInput": plugins.Enabled,
        "PreviewPluginUpdateInput": plugins.Revision,
        "ApplyPluginUpdateInput": plugins.Update,
        "RemovePluginInput": plugins.Revision,
        "GrantPluginInput": plugins.Grant,
        "ReadPluginContentInput": plugins.Content,
        "DecidePluginCallInput": plugins.Decision,
        "PluginResource": plugins.Resource,
        "PluginPrompt": plugins.Prompt,
        "PluginTool": plugins.Tool,
        "PluginResourceResult": plugins.ResourceResult,
        "PluginPromptResult": plugins.PromptResult,
    }
    endpoint = {"name": " Fixture ", "endpoint": "https://example.invalid/mcp"}
    plugin_seeds = {
        "PluginEndpointInput": endpoint,
        "InstallPluginInput": endpoint | {"reviewedDigest": "a" * 64},
        "UpdatePluginInput": {"revision": ID, "enabled": False},
        "PreviewPluginUpdateInput": {"revision": ID},
        "ApplyPluginUpdateInput": {"revision": ID, "reviewedDigest": "a" * 64},
        "RemovePluginInput": {"revision": ID},
        "GrantPluginInput": {
            "revision": ID,
            "tools": [{"name": "read", "mode": "read"}],
        },
        "ReadPluginContentInput": {
            "pluginId": ID,
            "revision": ID,
            "kind": "resource",
            "name": "notes://info",
        },
        "DecidePluginCallInput": {"decision": "approve"},
        "PluginResource": {
            "uri": "notes://info",
            "name": "Info",
            "description": "Untrusted",
        },
        "PluginPrompt": {
            "name": "compose",
            "description": "Untrusted",
            "arguments": [{"name": "topic", "required": True}],
        },
        "PluginTool": {
            "name": "read",
            "description": "Untrusted",
            "inputSchema": {"type": "object"},
            "annotations": {"readOnlyHint": True},
        },
        "PluginResourceResult": {
            "contents": [
                {
                    "uri": "notes://info",
                    "text": "Untrusted",
                    "_meta": {"fixture": [True, None]},
                }
            ]
        },
        "PluginPromptResult": {
            "messages": [
                {"role": "user", "content": {"type": "text", "text": "Untrusted"}}
            ]
        },
    }
    for schema, seed in plugin_seeds.items():
        expanded.extend(
            (schema, plugin_models[schema], name, value, True)
            for name, value in mutations(seed)
        )
    for name, changes in [
        ("python-whitespace", {"name": "\u0085\u001cFixture\u0085"}),
        ("ecma-only-whitespace", {"name": "\ufeffFixture\ufeff"}),
        ("40-astral-name", {"name": "🧪" * 40}),
        ("41-astral-name", {"name": "🧪" * 41}),
        ("surrogate-name", {"name": "\ud800"}),
        ("service-url-validation", {"endpoint": "not a URL"}),
        ("endpoint-unit-limit", {"endpoint": "🧪" * 1024}),
        ("endpoint-over-unit-limit", {"endpoint": "🧪" * 1025}),
        ("token-null", {"token": None}),
        ("token-whitespace", {"token": "two words"}),
        ("synthetic-token", {"token": "synthetic-token"}),
    ]:
        expanded.append(
            ("PluginEndpointInput", plugins.Endpoint, name, endpoint | changes, True)
        )
    for name, revision in [
        ("uppercase-uuid", "ABCDEFAB-1111-4111-8111-111111111111"),
        ("nonversioned-uuid", "11111111-1111-1111-1111-111111111111"),
        ("urn-uuid", "urn:uuid:" + ID),
    ]:
        expanded.append(
            ("RemovePluginInput", plugins.Revision, name, {"revision": revision}, True)
        )
    for name, args in [
        ("argument-unit-limit", {"topic": "🧪" * 2000}),
        ("argument-over-unit-limit", {"topic": "🧪" * 2001}),
        ("invalid-argument-key", {"space key": "text"}),
        ("null-arguments", None),
    ]:
        expanded.append(
            (
                "ReadPluginContentInput",
                plugins.Content,
                name,
                plugin_seeds["ReadPluginContentInput"] | {"arguments": args},
                True,
            )
        )
    private_record = {
        "id": ID,
        "revision": ID,
        "name": "Fixture",
        "endpoint": endpoint["endpoint"],
        "digest": "a" * 64,
        "enabled": False,
        "createdAt": TIME,
        "token": "synthetic-token",
        "tools": [plugin_seeds["PluginTool"]],
        "grants": [],
    }
    for name, value in [
        *mutations(private_record),
        ("surrogate-time", private_record | {"createdAt": "\ud800"}),
    ]:
        record = {"schema": "InstalledPlugin", "name": name, "input": value}
        try:
            record.update(
                valid=True,
                serialized=plugins.public(plugins.parse(plugins.Record, value)),
            )
        except plugins.PluginError:
            record["valid"] = False
        projections.append(record)
    for node_id in [
        "a" * 128,
        "a" * 129,
        "host/id",
        "😀",
        "-host",
        "\u0085host\u0085",
        "\ufeffhost\ufeff",
    ]:
        expanded.append(
            (
                "CreateNodeEnrollmentTokenInput",
                EnrollmentInput,
                "node-id-admission",
                {"nodeId": node_id},
                False,
            )
        )
    for seconds in [60, 3600, 59, 3601, 600.0, 60.5, "600", True]:
        expanded.append(
            (
                "CreateNodeEnrollmentTokenInput",
                EnrollmentInput,
                "expiry-admission",
                {"nodeId": "fixture-host", "expiresInSeconds": seconds},
                False,
            )
        )
    for token in [
        "obenr_" + "a" * 42,
        "obenr_" + "a" * 250,
        "obenr_" + "a" * 251,
        "obenr_" + "a" * 43 + "\n",
        " obenr_" + "a" * 43,
        "obn_" + "a" * 43,
    ]:
        expanded.append(
            (
                "ExchangeNodeEnrollmentInput",
                ExchangeInput,
                "token-admission",
                {"nodeId": "fixture-host", "token": token},
                False,
            )
        )
    for title in ["😀" * 80, "😀" * 81, "\ud800", "a\0b"]:
        expanded.append(
            (
                "CreateEmployeeMemoryInput",
                CreateMemoryInput,
                "store-text-bound",
                {
                    "kind": "semantic",
                    "title": title,
                    "content": "Evidence",
                    "sensitivity": "internal",
                    "portability": "never",
                },
                True,
            )
        )
    expanded.extend(
        [
            (
                "CreateEmployeeSkillInput",
                CreateSkillInput,
                "unadmitted-capability",
                {
                    "slug": "evidence-report",
                    "name": "Evidence",
                    "description": "Read",
                    "version": "1.0.0",
                    "source": "manual",
                    "reason": "Add",
                    "requiredCapabilities": ["browser.session"],
                },
                True,
            ),
            (
                "ReviewKnowledgeProposalInput",
                TypeAdapter(ReviewProposalInput),
                "reject",
                {"decision": "reject", "ownerReviewed": True},
                True,
            ),
            (
                "UpdateEmployeeSkillStateInput",
                TypeAdapter(SkillStateInput),
                "suspend",
                {"state": "suspended", "reason": "Review", "ownerReviewed": True},
                True,
            ),
            (
                "UpdateEmployeeProfileDetailsInput",
                ProfileDetailsInput,
                "decimal-revision",
                {"role": "Role", "description": "", "expectedRevision": 1.0},
                False,
            ),
            (
                "DeleteEmployeeMemoryInput",
                DeleteMemoryInput,
                "numeric-review",
                {"expectedRevision": 1, "ownerReviewed": 1},
                True,
            ),
        ]
    )
    for name, value in [
        ("utf16-bound", "😀" * 40),
        ("utf16-overflow", "😀" * 41),
        ("surrogate", "\ud800"),
    ]:
        expanded.append(
            (
                "CreateAutomationInput",
                AutomationInput,
                name,
                {
                    "name": value,
                    "channelId": ID,
                    "botId": ID,
                    "prompt": "Evidence",
                    "intervalMinutes": 60,
                    "firstRunAt": TIME,
                },
                False,
            )
        )
    for first_run in [
        "2026-01-01T00:00Z",
        "2026-01-01T00:00:00+00:00",
        "2026-02-30T00:00:00Z",
    ]:
        expanded.append(
            (
                "CreateAutomationInput",
                AutomationInput,
                "strict-utc",
                {
                    "name": "Schedule",
                    "channelId": ID,
                    "botId": ID,
                    "prompt": "Evidence",
                    "intervalMinutes": 60,
                    "firstRunAt": first_run,
                },
                False,
            )
        )
    automation = project_automation(
        {
            "id": "schedule",
            "name": "Schedule",
            "channel_id": ID,
            "bot_id": ID,
            "prompt": "Evidence",
            "interval_minutes": 60,
            "enabled": True,
            "next_run_at": datetime.fromisoformat(TIME),
            "last_run_at": None,
            "last_run_id": None,
            "last_outcome": None,
            "created_at": datetime.fromisoformat(TIME),
        }
    )
    projections.append(
        {
            "schema": "Automation",
            "name": "actual-helper",
            "input": automation,
            "valid": True,
            "serialized": automation,
        }
    )
    for name, changes in [
        ("40-astral-name", {"name": "🧪" * 40}),
        ("41-astral-name", {"name": "🧪" * 41}),
        ("surrogate-name", {"name": "\ud800"}),
        ("trim-model", {"defaultModel": " vendor/model "}),
        ("control-in-url", {"baseUrl": "https://api.openai.com/\tv1"}),
        ("url-userinfo", {"baseUrl": "https://user:synthetic@example.invalid/v1"}),
        ("bad-key-space", {"apiKey": "two parts"}),
    ]:
        expanded.append(
            (
                "CreateModelConnectionInput",
                CreateModelConnectionInput,
                name,
                model_input | changes,
                "explicit",
            )
        )
    for name, value in [
        ("nullable-default-only", {"expectedRevision": 1, "defaultModel": None}),
        ("decimal-revision", {"expectedRevision": 1.0, "enabled": False}),
        ("unsafe-revision", {"expectedRevision": 2**53, "enabled": False}),
    ]:
        expanded.append(
            (
                "UpdateModelConnectionInput",
                UpdateModelConnectionInput,
                name,
                value,
                "explicit",
            )
        )
    for name, password in [
        ("128-astral-password", "🧪" * 128),
        ("129-astral-password", "🧪" * 129),
        ("surrogate-password", "\ud800"),
    ]:
        expanded.append(
            (
                "AttachmentProcessInput",
                AttachmentProcessInput,
                name,
                {"operation": "extract", "password": password},
                True,
            )
        )
    for name, identity in [
        ("canonical-non-version-uuid", "11111111-1111-1111-1111-111111111111"),
        ("uppercase-uuid", "ABCDEFAB-1111-4111-8111-111111111111"),
    ]:
        expanded.append(
            (
                "ApprovalSettingsInput",
                ApprovalSettingsInput,
                name,
                {
                    "expectedRevision": 1,
                    "productRead": "required",
                    "publicWeb": "inherit",
                    "exceptions": [
                        {
                            "botId": ID,
                            "category": "product_read",
                            "target": {"kind": "channel", "value": identity},
                        }
                    ],
                },
                True,
            )
        )
    for schema, model, name, value, exclude_none in expanded:
        record = {"schema": schema, "name": name, "input": value}
        try:
            if schema == "CreateEmployeeMemoryInput":
                parsed = parse_memory_create(value)
            elif schema == "UpdateEmployeeMemoryInput":
                parsed = parse_memory_update(value)
            elif schema in plugin_models:
                record.update(valid=True, serialized=plugins.parse(model, value))
                requests.append(record)
                continue
            else:
                parsed = (
                    model.validate_python(value)
                    if isinstance(model, TypeAdapter)
                    else model.model_validate(value)
                )
            serialized = (
                parsed.model_dump(exclude_unset=True)
                if exclude_none == "explicit"
                else parsed.model_dump(exclude_none=exclude_none)
            )
            record.update(valid=True, serialized=public_secrets(serialized))
        except (ValidationError, ValueError, ControlError, UnicodeError):
            record["valid"] = False
        requests.append(record)
    return {"projections": projections, "requests": requests}


if __name__ == "__main__":
    print(json.dumps(fixtures(), ensure_ascii=True, sort_keys=True))
