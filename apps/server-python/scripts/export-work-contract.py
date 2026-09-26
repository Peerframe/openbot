"""Export one real HTTP response contract without starting services or reading configuration."""

import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from fastapi import FastAPI
from openbot_server.work_routes import register_work_routes


def contract() -> dict:
    app = FastAPI(title="OpenBot Work response", version="1")
    # Registration is declarative: no writer, store, session, DB or model is called by OpenAPI.
    register_work_routes(
        app,
        None,
        None,
        secure_cookies=True,
        allowed_origins=("https://openbot.invalid",),
    )
    schema = app.openapi()
    path = "/api/v1/tasks/{task_id}"
    schema["paths"] = {path: {"get": schema["paths"][path]["get"]}}
    return schema


if __name__ == "__main__":
    print(json.dumps(contract(), ensure_ascii=False, sort_keys=True))
