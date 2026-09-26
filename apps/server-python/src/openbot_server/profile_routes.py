"""Explicit Owner profile editing; the revision is an optimistic concurrency requirement."""
from typing import Protocol

from fastapi import FastAPI, HTTPException, Path, Request
from pydantic import ValidationError

from .authority import AuthenticationRequired
from .auth_routes import validate_origins
from .http_input import authorize_owner, read_json
from .profile_details import (ProfileDetailsInput, ProfileMutationResult, ProfileNotFound,
                              ProfileConflict, ProfileUnchanged, parse_profile_details)


class ProfileStore(Protocol):
    async def verify_schema(self) -> None: ...
    async def update(self, token: str | None, bot_id: str, value: ProfileDetailsInput) -> ProfileMutationResult: ...


def register_profile_routes(app: FastAPI, writer: ProfileStore, read_store, *, secure_cookies: bool,
                            allowed_origins: tuple[str, ...]) -> None:
    validate_origins(allowed_origins)
    cookie_name = "__Host-openbot_session" if secure_cookies else "openbot_session"

    @app.patch("/api/v1/bots/{bot_id}/profile", response_model=ProfileMutationResult,
               response_model_exclude_none=True, operation_id="updateEmployeeProfileDetails",
               openapi_extra={"requestBody": {"required": True, "content": {
                   "application/json": {"schema": ProfileDetailsInput.model_json_schema()}}}})
    async def update(request: Request, bot_id: str = Path(min_length=1, max_length=128)):
        token = await authorize_owner(request, read_store, cookie_name=cookie_name, allowed_origins=allowed_origins)
        try:
            value = parse_profile_details(await read_json(request, max_bytes=32768))
        except (ValidationError, ValueError):
            raise HTTPException(422, "Invalid profile input.") from None
        try:
            return await writer.update(token, bot_id, value)
        except AuthenticationRequired:
            raise HTTPException(401, "Authentication required.") from None
        except ProfileNotFound:
            raise HTTPException(404, "Bot not found.") from None
        except ProfileConflict:
            raise HTTPException(409, "The Employee profile changed while it was being edited. Reload and review the current values.") from None
        except ProfileUnchanged:
            raise HTTPException(422, "At least one Employee profile field must change.") from None
