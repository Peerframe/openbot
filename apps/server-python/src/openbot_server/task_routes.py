"""Commit queued tasks through explicit Owner authority; execution remains a separate service."""
from typing import Protocol

from fastapi import FastAPI, HTTPException, Path, Request
from pydantic import ValidationError

from .authority import AuthenticationRequired
from .auth_routes import validate_origins
from .http_input import authorize_owner, read_json
from .task_inputs import CreateMessageInput, parse_message
from .task_models import SubmitTaskResult
from .task_routing import TaskValidation
from .task_store import TaskChannelNotFound, AttachmentReferencesUnavailable, TooManyAttachments


class TaskStore(Protocol):
    async def verify_schema(self) -> None: ...
    async def submit(self, token: str | None, channel_id: str, value: CreateMessageInput) -> SubmitTaskResult: ...


def register_task_routes(app: FastAPI, writer: TaskStore, read_store, *, secure_cookies: bool,
                         allowed_origins: tuple[str, ...]) -> None:
    validate_origins(allowed_origins)
    cookie_name = "__Host-openbot_session" if secure_cookies else "openbot_session"

    @app.post("/api/v1/channels/{channel_id}/messages", status_code=201, response_model=SubmitTaskResult,
              response_model_exclude_none=True, operation_id="submitTask",
              openapi_extra={"requestBody": {"required": True, "content": {
                  "application/json": {"schema": CreateMessageInput.model_json_schema()}}}})
    async def submit(request: Request, channel_id: str = Path(min_length=1, max_length=128)):
        token = await authorize_owner(request, read_store, cookie_name=cookie_name, allowed_origins=allowed_origins)
        try:
            value = parse_message(await read_json(request, max_bytes=131072))
        except (ValidationError, ValueError):
            raise HTTPException(422, "Invalid task input.") from None
        try:
            return await writer.submit(token, channel_id, value)
        except AuthenticationRequired:
            raise HTTPException(401, "Authentication required.") from None
        except TaskChannelNotFound:
            raise HTTPException(404, "Channel not found.") from None
        except TaskValidation as error:
            raise HTTPException(422, str(error)) from None
        except TooManyAttachments:
            raise HTTPException(413, "At most 8 attachments may be used per task.") from None
        except AttachmentReferencesUnavailable:
            raise HTTPException(503, "Attachment reference validation is unavailable.") from None
