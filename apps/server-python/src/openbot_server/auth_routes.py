"""HTTP adaptation for explicitly enabled Owner-auth writes; all other writes stay unavailable."""
from datetime import datetime, timezone
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError

from .auth import InvalidClientIdentity, InvalidCredentials, OwnerAuthentication, RateLimited, password_length
from .models import AuthenticatedSession
from .http_input import read_json


class LoginInput(BaseModel):
    model_config = ConfigDict(strict=True, extra="ignore")
    password: SecretStr = Field(min_length=1, max_length=1024)


class LoginResponse(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    session: AuthenticatedSession


def validate_origins(origins: tuple[str, ...]) -> None:
    if not origins:
        raise ValueError("Owner-auth writes require explicit allowed origins.")
    for origin in origins:
        if not isinstance(origin, str) or not origin.isascii() or any(c.isspace() for c in origin) or "\\" in origin or "*" in origin:
            raise ValueError("Owner-auth origins must be literal HTTP(S) origins.")
        parts = urlsplit(origin)
        if (parts.scheme not in ("https", "http") or not parts.hostname or parts.path
                or parts.query or parts.fragment or parts.username or parts.password
                or origin != f"{parts.scheme}://{parts.netloc}" or origin in ("null", "*")):
            raise ValueError("Owner-auth origins must be exact HTTP(S) origins without paths.")
        try:
            parts.port
        except ValueError:
            raise ValueError("Owner-auth origin has an invalid port.") from None


async def login_payload(request: Request) -> str:
    try:
        payload = LoginInput.model_validate(await read_json(request))
        password = payload.password.get_secret_value()
        password.encode("utf-8")  # Reject lone surrogates before credential comparison.
        if not 1 <= password_length(password) <= 1024:
            raise ValueError("Invalid length")
        return password
    except (ValidationError, ValueError):
        # Pydantic errors may contain submitted values, so never forward their details.
        raise HTTPException(422, "Invalid login input.") from None


def register_auth_routes(app: FastAPI, auth: OwnerAuthentication, *, secure_cookies: bool,
                         allowed_origins: tuple[str, ...]) -> None:
    validate_origins(allowed_origins)
    cookie_name = "__Host-openbot_session" if secure_cookies else "openbot_session"

    def require_origin(request: Request):
        if request.headers.get("origin") not in allowed_origins:
            raise HTTPException(403, "Request origin is not allowed.")

    @app.post("/api/v1/auth/login", response_model=LoginResponse, operation_id="loginOwner",
              openapi_extra={"requestBody": {"required": True, "content": {
                  "application/json": {"schema": LoginInput.model_json_schema()}}}})
    async def login(request: Request):
        require_origin(request)
        password = await login_payload(request)
        try:
            result = await auth.login(password, request.client.host if request.client else None)
        except InvalidClientIdentity:
            raise HTTPException(400, "Client network identity is unavailable.") from None
        except InvalidCredentials:
            raise HTTPException(401, "Password is incorrect.") from None
        except RateLimited as error:
            return JSONResponse({"error": str(error)}, status_code=429,
                                headers={"Retry-After": str(error.retry_after)})
        expires = datetime.fromisoformat(result.session.expiresAt.replace("Z", "+00:00"))
        response = JSONResponse(LoginResponse(session=result.session).model_dump(mode="json"))
        response.set_cookie(cookie_name, result.token, httponly=True, secure=secure_cookies,
                            samesite="strict", path="/",
                            max_age=max(1, int((expires - datetime.now(timezone.utc)).total_seconds())))
        return response

    @app.post("/api/v1/auth/logout", status_code=204, response_class=Response, operation_id="logoutOwner")
    async def logout(request: Request):
        require_origin(request)
        if not await auth.logout(request.cookies.get(cookie_name)):
            raise HTTPException(401, "Authentication required.")
        response = Response(status_code=204)
        response.delete_cookie(cookie_name, path="/", secure=secure_cookies, httponly=True, samesite="strict")
        return response
