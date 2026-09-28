"""Export real Work request/response/error contracts without starting services."""

import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from fastapi import FastAPI
from openbot_server.work_routes import register_work_routes


def contract() -> dict:
    app = FastAPI(title="OpenBot Work HTTP", version="1")
    # Registration is declarative: no writer, store, session, DB or model is called by OpenAPI.
    register_work_routes(
        app,
        None,
        None,
        secure_cookies=True,
        allowed_origins=("https://openbot.invalid",),
    )
    schema = app.openapi()
    schema["paths"] = {
        path: {method: schema["paths"][path][method]}
        for path, method in (
            ("/api/v1/tasks", "post"),
            ("/api/v1/tasks/{task_id}", "get"),
            ("/api/v1/tasks/{task_id}/cancel", "post"),
        )
    }
    return schema


if __name__ == "__main__":
    print(json.dumps(contract(), ensure_ascii=False, sort_keys=True))
