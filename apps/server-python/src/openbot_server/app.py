"""Compatible control reads with explicitly selected Owner authentication and identity writes."""

from __future__ import annotations

from contextlib import asynccontextmanager
import json
import re
from datetime import datetime, timezone
from typing import Protocol, TYPE_CHECKING

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError, ResponseValidationError
from fastapi.responses import JSONResponse
from fastapi.security import APIKeyCookie
from starlette.middleware.cors import CORSMiddleware

from .auth import OwnerAuthentication
from .auth_routes import register_auth_routes
from .identity_routes import IdentityStore, register_identity_routes
from .database import ReadResult, StoreUnavailable
from .models import (
    AuthSession, BotsResponse, ChannelsResponse, iso_timestamp, project_bot, project_channels,
)


if TYPE_CHECKING:
    from .conversation_routes import ConversationStore


class ReadStore(Protocol):
    async def verify_schema(self) -> None: ...
    async def read(self, token: str | None, projection: str) -> ReadResult: ...


def create_app(store: ReadStore, *, owner_name: str, secure_cookies: bool = True,
               allowed_origins: tuple[str, ...] = (), auth: OwnerAuthentication | None = None,
               identity: IdentityStore | None = None, conversations: ConversationStore | None = None) -> FastAPI:
    if not owner_name or any(origin == "*" or origin == "null" for origin in allowed_origins):
        raise ValueError("An Owner name and explicit origins are required.")
    if auth is not None and auth.owner_name != owner_name:
        raise ValueError("Owner-auth and read identity must match.")
    cookie_name = "__Host-openbot_session" if secure_cookies else "openbot_session"
    cookie = APIKeyCookie(name=cookie_name, auto_error=False)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await store.verify_schema()
        if auth is not None:
            await auth.verify_schema()
        if identity is not None:
            await identity.verify_schema()
        if conversations is not None:
            await conversations.verify_schema()
        yield

    app = FastAPI(title="OpenBot control-plane reference", version="0.0.0",
                  docs_url=None, redoc_url=None, lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=list(allowed_origins),
                       allow_credentials=True, allow_methods=["GET", "POST"] if auth or identity or conversations else ["GET"],
                       allow_headers=["Content-Type"] if auth or identity or conversations else [])

    @app.middleware("http")
    async def private_response(request: Request, call_next):
        auth_write = auth is not None and request.method == "POST" and request.url.path in (
            "/api/v1/auth/login", "/api/v1/auth/logout")
        identity_write = identity is not None and request.method == "POST" and request.url.path in (
            "/api/v1/bots", "/api/v1/channels")
        conversation_write = conversations is not None and request.method == "POST" and (
            re.fullmatch(r"/api/v1/bots/[^/]+/conversation", request.url.path) is not None
            or re.fullmatch(r"/api/v1/channels/[^/]+/bots", request.url.path) is not None)
        if request.method not in ("GET", "HEAD", "OPTIONS") and not (auth_write or identity_write or conversation_write):
            response = JSONResponse({"error": "Operation is unavailable in this reference."}, status_code=405)
        else:
            response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        return response

    @app.exception_handler(StoreUnavailable)
    async def unavailable(request: Request, error: StoreUnavailable):
        return JSONResponse({"error": "Control-plane storage is unavailable."}, status_code=503)

    @app.exception_handler(RequestValidationError)
    async def bad_request(request: Request, error: RequestValidationError):
        return JSONResponse({"error": "Invalid request input."}, status_code=422)

    @app.exception_handler(ResponseValidationError)
    async def bad_projection(request: Request, error: ResponseValidationError):
        return JSONResponse({"error": "Control-plane data could not be projected."}, status_code=503)

    def bounded_response(value):
        content = value.model_dump(mode="json", exclude_none=True)
        if len(json.dumps(content, ensure_ascii=False).encode("utf-8")) > 4 * 1024 * 1024:
            raise StoreUnavailable("projection_limit")
        return value

    async def read(request: Request, projection: str, *, required: bool = True):
        token = await cookie(request)
        result = await store.read(token, projection)
        if required and result.expires_at is None:
            raise HTTPException(status_code=401, detail="Authentication required.")
        return result

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, error: HTTPException):
        return JSONResponse({"error": error.detail}, status_code=error.status_code)

    @app.get("/health", operation_id="getHealth")
    async def health():
        return {"ok": True, "service": "openbot-server", "phase": "s2a-identity-reference" if identity or conversations else "s2a-auth-reference" if auth else "s2a-read-reference",
                "time": iso_timestamp(datetime.now(timezone.utc))}

    @app.get("/api/v1/auth/session", response_model=AuthSession,
             response_model_exclude_none=True, operation_id="getOwnerSession")
    async def session(request: Request):
        result = await read(request, "session", required=False)
        if result.expires_at is None:
            return {"authenticated": False}
        return {"authenticated": True, "owner": {"id": "owner", "name": owner_name},
                "expiresAt": iso_timestamp(result.expires_at)}

    @app.get("/api/v1/bots", response_model=BotsResponse,
             response_model_exclude_none=True, operation_id="listBots")
    async def bots(request: Request):
        result = await read(request, "bots")
        try:
            return bounded_response(BotsResponse(bots=[project_bot(row) for row in result.rows]))
        except (ValueError, TypeError, KeyError):
            raise StoreUnavailable("invalid_projection") from None

    @app.get("/api/v1/channels", response_model=ChannelsResponse,
             response_model_exclude_none=True, operation_id="listChannels")
    async def channels(request: Request):
        result = await read(request, "channels")
        try:
            return bounded_response(ChannelsResponse(channels=project_channels(result.rows)))
        except (ValueError, TypeError, KeyError):
            raise StoreUnavailable("invalid_projection") from None

    if auth is not None:
        register_auth_routes(app, auth, secure_cookies=secure_cookies, allowed_origins=allowed_origins)

    input_definitions = register_identity_routes(
        app, identity, store, secure_cookies=secure_cookies, allowed_origins=allowed_origins,
    ) if identity is not None else {}

    if conversations is not None:
        from .conversation_routes import register_conversation_routes
        register_conversation_routes(app, conversations, store, secure_cookies=secure_cookies,
                                     allowed_origins=allowed_origins)

    # Cookie parsing is invoked inside the adapter to keep the store request-scoped. Declare
    # that exact scheme in generated OpenAPI too; a schema is never an authorization check.
    schema = app.openapi()
    components = schema.setdefault("components", {}).setdefault("schemas", {})
    for name, definition in input_definitions.items():
        if name in components and components[name] != definition:
            raise ValueError("Conflicting OpenAPI input definitions.")
        components[name] = definition
    schema.setdefault("components", {}).setdefault("securitySchemes", {})["OwnerSession"] = {
        "type": "apiKey", "in": "cookie", "name": cookie_name,
    }
    for path in ("/api/v1/bots", "/api/v1/channels"):
        schema["paths"][path]["get"]["security"] = [{"OwnerSession": []}]
    schema["paths"]["/api/v1/auth/session"]["get"]["security"] = [{}, {"OwnerSession": []}]
    if auth is not None:
        schema["paths"]["/api/v1/auth/logout"]["post"]["security"] = [{"OwnerSession": []}]
        schema["paths"]["/api/v1/auth/login"]["post"]["security"] = []
    if identity is not None:
        for path in ("/api/v1/bots", "/api/v1/channels"):
            schema["paths"][path]["post"]["security"] = [{"OwnerSession": []}]
    if conversations is not None:
        for path in ("/api/v1/bots/{bot_id}/conversation", "/api/v1/channels/{channel_id}/bots"):
            schema["paths"][path]["post"]["security"] = [{"OwnerSession": []}]
    return app
