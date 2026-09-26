"""Two explicitly selected Owner identity writes; no task or executor privileges."""
from typing import Protocol

from fastapi import FastAPI, HTTPException, Request
from pydantic import ValidationError

from .auth_routes import validate_origins
from .http_input import authorize_owner, read_json
from .identity_inputs import CreateBotInput, CreateChannelInput, parse_bot_create, parse_channel_create
from .identity_store import AuthenticationRequired, IdentityConflict, UnknownMembers
from .models import Bot, Channel, PublicModel


class BotResponse(PublicModel):
    bot: Bot


class ChannelResponse(PublicModel):
    channel: Channel


class IdentityStore(Protocol):
    async def verify_schema(self) -> None: ...
    async def create_bot(self, token: str | None, value: CreateBotInput) -> Bot: ...
    async def create_channel(self, token: str | None, value: CreateChannelInput) -> Channel: ...


async def creation_payload(request: Request, parse):
    try:
        return parse(await read_json(request))
    except (ValidationError, ValueError):
        raise HTTPException(422, "Invalid creation input.") from None


def register_identity_routes(app: FastAPI, writer: IdentityStore, read_store, *, secure_cookies: bool,
                             allowed_origins: tuple[str, ...]) -> dict:
    validate_origins(allowed_origins)
    cookie_name = "__Host-openbot_session" if secure_cookies else "openbot_session"
    definitions = {}

    def input_schema(model):
        schema = model.model_json_schema(ref_template="#/components/schemas/{model}")
        definitions.update(schema.pop("$defs", {}))
        return schema

    async def create(request: Request, parse, operation):
        token = await authorize_owner(request, read_store, cookie_name=cookie_name, allowed_origins=allowed_origins)
        value = await creation_payload(request, parse)
        try:
            # A preliminary read is not a grant: the transaction rechecks and locks authority.
            return await operation(token, value)
        except AuthenticationRequired:
            raise HTTPException(401, "Authentication required.") from None
        except IdentityConflict as error:
            raise HTTPException(409, str(error)) from None
        except UnknownMembers:
            raise HTTPException(422, "One or more selected Bots no longer exist.") from None

    @app.post("/api/v1/bots", status_code=201, response_model=BotResponse,
              response_model_exclude_none=True, operation_id="createBot",
              openapi_extra={"requestBody": {"required": True, "content": {
                  "application/json": {"schema": input_schema(CreateBotInput)}}}})
    async def create_bot(request: Request):
        return BotResponse(bot=await create(request, parse_bot_create, writer.create_bot))

    @app.post("/api/v1/channels", status_code=201, response_model=ChannelResponse,
              response_model_exclude_none=True, operation_id="createChannel",
              openapi_extra={"requestBody": {"required": True, "content": {
                  "application/json": {"schema": input_schema(CreateChannelInput)}}}})
    async def create_channel(request: Request):
        return ChannelResponse(channel=await create(request, parse_channel_create, writer.create_channel))

    return definitions
