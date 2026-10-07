"""Export real Work request/response/error contracts without starting services."""

import json
import sys
from pathlib import Path

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
    return schema


if __name__ == "__main__":
    print(json.dumps(contract(), ensure_ascii=False, sort_keys=True))
