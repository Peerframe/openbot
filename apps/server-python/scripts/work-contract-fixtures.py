"""Deterministic public DTO/HTTP samples for the real TypeScript consumer."""

from copy import deepcopy
import json
from pathlib import Path
import sys
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from openbot_server.authority import AuthenticationRequired
from openbot_server.work_models import WorkSnapshot, CreateTask
from openbot_server.work_routes import register_work_routes
from openbot_server.work_values import WorkConflict, WorkNotFound


def snapshot() -> dict:
    return {
        "id": "task-one",
        "botId": "bot-one",
        "objective": "Read 文档",
        "status": "open",
        "revision": 1,
        "resultSummary": None,
        "artifacts": [],
        "authorityActive": True,
        "cancelRequested": False,
        "attention": "reconciliation",
        "usage": {"tokenLimit": 10, "reservedTokens": 2, "spentTokens": 0},
        "runs": [{"id": "run-one", "ordinal": 1, "status": "running"}],
        "actions": [
            {
                "id": "action-one",
                "runId": "run-one",
                "intent": {"value": [None, "汉字", True]},
                "intentDigest": "a" * 64,
                "decision": "approved",
                "status": "unknown",
                "expiresAt": "2026-09-27T00:00:00Z",
                "reservedTokens": 2,
                "actualTokens": None,
                "evidence": None,
            }
        ],
        "events": [{"revision": 1, "kind": "observation", "payload": {"summary": "unknown"}}],
        "eventsTruncated": False,
    }


def fixtures() -> dict:
    cases = []
    mutations: list[tuple[str, dict[str, Any]]] = [
        ("nulls-and-unicode", {}),
        ("summary", {"resultSummary": "A bounded summary. 中文"}),
        ("wrong-status", {"status": "success"}),
        ("wrong-boolean", {"authorityActive": "false"}),
        ("null-required-array", {"actions": None}),
    ]
    for name, changes in mutations:
        value = snapshot() | changes
        cases.append((name, value))
    for name, field_path in (
        ("fractional-usage", ("usage", "spentTokens")),
        ("negative-usage", ("usage", "reservedTokens")),
        ("fractional-action", ("actions", 0, "actualTokens")),
    ):
        value = snapshot()
        target = value
        for key in field_path[:-1]:
            target = target[key]
        target[field_path[-1]] = -1 if name.startswith("negative") else 0.5
        cases.append((name, value))
    cases.append(("negative-revision", snapshot() | {"revision": -1}))
    missing = snapshot()
    del missing["resultSummary"]
    cases.append(("missing-required-nullable", missing))
    missing_nested = deepcopy(snapshot())
    del missing_nested["actions"][0]["actualTokens"]
    cases.append(("missing-nested-nullable", missing_nested))
    results = []
    for name, value in cases:
        try:
            serialized = WorkSnapshot.model_validate(value).model_dump(mode="json")
            results.append({"name": name, "input": value, "valid": True, "serialized": serialized})
        except ValidationError:
            results.append({"name": name, "input": value, "valid": False})

    class Writer:
        async def snapshot(self, token, task_id):
            if task_id == "unauthorized":
                raise AuthenticationRequired()
            if task_id == "missing":
                raise WorkNotFound()
            if task_id == "conflict":
                raise WorkConflict("task_changed")
            return snapshot()

        async def create(self, token, *, bot_id, objective, token_limit, request_key, **kwargs):
            assert token == "fixture-session"
            if request_key == "conflict":
                raise WorkConflict("private create diagnostic")
            return snapshot() | {
                "botId": bot_id,
                "objective": objective,
                "usage": {"tokenLimit": token_limit, "reservedTokens": 0, "spentTokens": 0},
            }

        async def cancel(self, token, task_id):
            if task_id in ("missing", "conflict"):
                return await self.snapshot(token, task_id)
            return snapshot() | {"id": task_id, "cancelRequested": True, "authorityActive": False}

    class Reader:
        async def read(self, token, resource):
            from types import SimpleNamespace

            return SimpleNamespace(expires_at="future" if token == "fixture-session" else None)

    app = FastAPI()
    register_work_routes(
        app,
        Writer(),
        Reader(),
        secure_cookies=True,
        allowed_origins=("https://openbot.invalid",),
    )
    create = {"botId": "bot-one", "objective": "Read 文档", "tokenLimit": 10, "requestKey": "key"}
    identities = [f"abcdefab-1234-4234-8234-{index:012x}" for index in range(33)]
    scope = {
        "version": 1,
        "attachmentIds": [identities[0]],
        "collaboratorBotIds": [identities[1]],
        "knowledge": True,
        "plugins": False,
        "web": True,
    }
    inputs = [
        ("omitted-scope", create),
        ("null-scope", create | {"scope": None}),
        ("zero-budget", create | {"tokenLimit": 0}),
        ("max-budget", create | {"tokenLimit": 1_000_000_000}),
        ("oversize-budget", create | {"tokenLimit": 1_000_000_001}),
        ("fractional-budget", create | {"tokenLimit": 0.5}),
        ("boolean-budget", create | {"tokenLimit": True}),
        ("null-objective", create | {"objective": None}),
        ("empty-objective", create | {"objective": ""}),
        ("unknown-input", create | {"unexpected": True}),
        ("missing-key", {key: value for key, value in create.items() if key != "requestKey"}),
        ("unicode-boundary", create | {"botId": "🧪" * 128}),
        ("unicode-overflow", create | {"botId": "🧪" * 129}),
    ]
    for name, changes in (
        ("nonempty-scope", {}),
        ("attachment-boundary", {"attachmentIds": identities[:8]}),
        ("attachment-overflow", {"attachmentIds": identities[:9]}),
        ("collaborator-boundary", {"collaboratorBotIds": identities[:32]}),
        ("collaborator-overflow", {"collaboratorBotIds": identities}),
        ("duplicate-attachment", {"attachmentIds": [identities[0], identities[0]]}),
        ("case-duplicate-attachment", {"attachmentIds": [identities[0], identities[0].upper()]}),
        (
            "case-duplicate-collaborator",
            {"collaboratorBotIds": [identities[0], identities[0].upper()]},
        ),
        ("uppercase-scope", {"attachmentIds": [identities[0].upper()]}),
        ("invalid-identity", {"attachmentIds": ["not-a-uuid"]}),
        ("invalid-scope-boolean", {"knowledge": "true"}),
    ):
        inputs.append((name, create | {"scope": scope | changes}))
    requests = []
    for name, value in inputs:
        try:
            serialized = CreateTask.model_validate(value).model_dump(mode="json")
            requests.append({"name": name, "input": value, "valid": True, "serialized": serialized})
        except ValidationError:
            requests.append({"name": name, "input": value, "valid": False})
    with TestClient(app, base_url="https://openbot.invalid") as client:
        responses = []
        for name in ("task-one", "unauthorized", "missing", "conflict"):
            response = client.get(f"/api/v1/tasks/{name}")
            responses.append({"id": name, "status": response.status_code, "body": response.json()})
        commands = []
        for operation, identity, payload, origin, token in (
            ("create", "null-scope", create | {"scope": None}, True, True),
            ("create", "omitted-scope", create, True, True),
            ("create", "nonempty-scope", create | {"scope": scope}, True, True),
            (
                "create",
                "scope-overflow",
                create | {"scope": scope | {"attachmentIds": identities[:9]}},
                True,
                True,
            ),
            ("create", "conflict", create | {"requestKey": "conflict"}, True, True),
            ("create", "invalid", create | {"tokenLimit": -1}, True, True),
            ("create", "too-large", create | {"objective": "文" * 7000}, True, True),
            ("cancel", "task-one", {}, True, True),
            ("cancel", "missing", {}, True, True),
            ("cancel", "conflict", {}, True, True),
            ("cancel", "invalid", {"extra": True}, True, True),
            ("cancel", "forbidden", {}, False, True),
            ("cancel", "unauthorized", {}, True, False),
            ("cancel", "x" * 129, {}, True, True),
        ):
            headers = {"Origin": "https://openbot.invalid" if origin else "https://other.invalid"}
            if token:
                headers["Cookie"] = "__Host-openbot_session=fixture-session"
            path = "/api/v1/tasks" if operation == "create" else f"/api/v1/tasks/{identity}/cancel"
            response = client.post(path, json=payload, headers=headers)
            commands.append(
                {
                    "operation": operation,
                    "id": identity,
                    "input": payload,
                    "status": response.status_code,
                    "body": response.json(),
                }
            )
    return {"cases": results, "responses": responses, "requests": requests, "commands": commands}


if __name__ == "__main__":
    print(json.dumps(fixtures(), ensure_ascii=False, allow_nan=False))
