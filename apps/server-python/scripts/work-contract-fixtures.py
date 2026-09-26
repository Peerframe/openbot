"""Deterministic public DTO/HTTP samples for the real TypeScript consumer."""

from copy import deepcopy
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from openbot_server.authority import AuthenticationRequired
from openbot_server.work_models import WorkSnapshot
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
        "events": [
            {"revision": 1, "kind": "observation", "payload": {"summary": "unknown"}}
        ],
        "eventsTruncated": False,
    }


def fixtures() -> dict:
    cases = []
    for name, changes in [
        ("nulls-and-unicode", {}),
        ("summary", {"resultSummary": "A bounded summary. 中文"}),
        ("wrong-status", {"status": "success"}),
        ("wrong-boolean", {"authorityActive": "false"}),
        ("null-required-array", {"actions": None}),
    ]:
        value = snapshot() | changes
        cases.append((name, value))
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
            results.append(
                {"name": name, "input": value, "valid": True, "serialized": serialized}
            )
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

    app = FastAPI()
    register_work_routes(
        app,
        Writer(),
        None,
        secure_cookies=True,
        allowed_origins=("https://openbot.invalid",),
    )
    with TestClient(app) as client:
        responses = []
        for name in ("task-one", "unauthorized", "missing", "conflict"):
            response = client.get(f"/api/v1/tasks/{name}")
            responses.append(
                {"id": name, "status": response.status_code, "body": response.json()}
            )
    return {"cases": results, "responses": responses}


if __name__ == "__main__":
    print(json.dumps(fixtures(), ensure_ascii=False, allow_nan=False))
