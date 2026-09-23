"""Owner-controlled direct conversations and member joins, without task dispatch."""
from typing import Protocol

from fastapi import FastAPI, HTTPException, Path, Request
from pydantic import ValidationError

from .authority import AuthenticationRequired
from .auth_routes import validate_origins
from .conversations import ConversationNotFound, DirectMembershipLocked, JoinChannelInput, parse_join
from .http_input import read_json
from .identity_routes import ChannelResponse
from .models import Channel


class ConversationStore(Protocol):
    async def verify_schema(self) -> None: ...
    async def direct(self, token: str | None, bot_id: str) -> Channel: ...
    async def join(self, token: str | None, channel_id: str, value: JoinChannelInput) -> Channel: ...


def register_conversation_routes(app: FastAPI, writer: ConversationStore, read_store, *, secure_cookies: bool,
                                 allowed_origins: tuple[str, ...]) -> None:
    validate_origins(allowed_origins)
    cookie_name = "__Host-openbot_session" if secure_cookies else "openbot_session"

    async def authorize(request: Request):
        if request.headers.get("origin") not in allowed_origins:
            raise HTTPException(403, "Request origin is not allowed.")
        token = request.cookies.get(cookie_name)
        if (await read_store.read(token, "session")).expires_at is None:
            raise HTTPException(401, "Authentication required.")
        return token

    async def invoke(operation):
        try:
            return ChannelResponse(channel=await operation)
        except AuthenticationRequired:
            raise HTTPException(401, "Authentication required.") from None
        except ConversationNotFound:
            raise HTTPException(404, "Bot or channel not found.") from None
        except DirectMembershipLocked:
            raise HTTPException(422, "Direct conversation membership cannot be changed.") from None

    @app.post("/api/v1/bots/{bot_id}/conversation", response_model=ChannelResponse,
              response_model_exclude_none=True, operation_id="getOrCreateDirectConversation")
    async def direct(request: Request, bot_id: str = Path(min_length=1, max_length=128)):
        token = await authorize(request)
        return await invoke(writer.direct(token, bot_id))

    @app.post("/api/v1/channels/{channel_id}/bots", response_model=ChannelResponse,
              response_model_exclude_none=True, operation_id="joinBotToChannel",
              openapi_extra={"requestBody": {"required": True, "content": {
                  "application/json": {"schema": JoinChannelInput.model_json_schema()}}}})
    async def join(request: Request, channel_id: str = Path(min_length=1, max_length=128)):
        token = await authorize(request)
        try:
            value = parse_join(await read_json(request))
        except (ValidationError, ValueError):
            raise HTTPException(422, "Invalid member input.") from None
        return await invoke(writer.join(token, channel_id, value))
