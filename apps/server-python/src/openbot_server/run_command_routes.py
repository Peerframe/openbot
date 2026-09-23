"""Owner commands for the reference authority; runtime notifications belong after commit."""
from typing import Protocol

from fastapi import FastAPI, HTTPException, Path, Request
from pydantic import TypeAdapter, ValidationError

from .auth_routes import validate_origins
from .authority import AuthenticationRequired
from .http_input import authorize_owner, read_json
from .identity_inputs import ChannelBotId
from .run_commands import (CancelRunInput, CancelRunResponse, SteerRunInput, SteeringInstruction,
                           SteeringResponse, parse_cancel, parse_steering)
from .run_command_store import (CancelledRuns, InvalidRunCommand, RunCommandConflict,
                                RunCommandNotFound, SteeringAttachmentRefused)


class RunCommandStore(Protocol):
    async def verify_schema(self) -> None: ...
    async def cancel(self, token: str | None, run_id: str) -> CancelledRuns: ...
    async def steer(self, token: str | None, run_id: str, instruction: str) -> SteeringInstruction: ...


def register_run_command_routes(app: FastAPI, writer: RunCommandStore, read_store, *,
                                secure_cookies: bool, allowed_origins: tuple[str, ...]) -> None:
    validate_origins(allowed_origins)
    cookie_name = '__Host-openbot_session' if secure_cookies else 'openbot_session'

    async def authorize(request):
        return await authorize_owner(request, read_store, cookie_name=cookie_name, allowed_origins=allowed_origins)

    def body_schema(model):
        return {'requestBody': {'required': True, 'content': {'application/json': {'schema': model.model_json_schema()}}}}

    async def command(operation):
        try:
            return await operation
        except AuthenticationRequired:
            raise HTTPException(401, 'Authentication required.') from None
        except RunCommandNotFound:
            raise HTTPException(404, 'Task not found.') from None
        except RunCommandConflict as error:
            raise HTTPException(409, str(error)) from None
        except InvalidRunCommand:
            raise HTTPException(422, 'Invalid task command.') from None
        except SteeringAttachmentRefused:
            raise HTTPException(400, 'Additional attachments require a new task; steering accepts text only.') from None

    @app.post('/api/v1/runs/{run_id}/cancel', response_model=CancelRunResponse,
              response_model_exclude_none=True, operation_id='cancelNativeRun',
              openapi_extra=body_schema(CancelRunInput))
    async def cancel(request: Request, run_id: str = Path(min_length=1, max_length=128)):
        token = await authorize(request)
        try:
            parse_cancel(await read_json(request, max_bytes=128))
        except (ValidationError, ValueError):
            raise HTTPException(422, 'Invalid task command.') from None
        result = await command(writer.cancel(token, run_id))
        return CancelRunResponse(run=result.run)

    @app.post('/api/v1/runs/{run_id}/steer', status_code=202, response_model=SteeringResponse,
              response_model_exclude_none=True, operation_id='steerNativeRun',
              openapi_extra=body_schema(SteerRunInput))
    async def steer(request: Request, run_id: str = Path(min_length=1, max_length=128)):
        token = await authorize(request)
        try:
            TypeAdapter(ChannelBotId).validate_python(run_id)
            value = parse_steering(await read_json(request, max_bytes=18000))
        except (ValidationError, ValueError):
            raise HTTPException(422, 'Invalid task command.') from None
        # The store repeats this check for direct callers. Refuse even when a writer is replaced.
        from .task_store import TooManyAttachments, attachment_ids
        try:
            has_attachments = bool(attachment_ids(value.instruction))
        except TooManyAttachments:
            has_attachments = True
        if has_attachments:
            raise HTTPException(400, 'Additional attachments require a new task; steering accepts text only.')
        return SteeringResponse(steering=await command(writer.steer(token, run_id, value.instruction)))
