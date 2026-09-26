"""The three retained Owner browser routes. Register inside the product write allowlist."""
import asyncio

from fastapi import HTTPException, Request, Response
from pydantic import ValidationError

from .auth_routes import validate_origins
from .authority import AuthenticationRequired
from .control_errors import ControlError
from .database import StoreUnavailable
from .http_input import read_json


BROWSER_WRITE_ROUTES = (("POST", r"/api/v1/bots/[^/]+/browser"),
                        ("POST", r"/api/v1/browser-sessions/[^/]+/commands"),
                        ("DELETE", r"/api/v1/browser-sessions/[^/]+"))


def register_browser_routes(app, service, *, secure_cookies, allowed_origins):
    validate_origins(allowed_origins)
    cookie = "__Host-openbot_session" if secure_cookies else "openbot_session"

    async def token(request):
        if request.headers.get("origin") not in allowed_origins:
            raise HTTPException(403, "Request origin is not allowed.")
        value = request.cookies.get(cookie)
        try:
            await service.authorize(value)
        except AuthenticationRequired:
            raise HTTPException(401, "Authentication required.") from None
        return value

    async def guarded(operation):
        try:
            return await operation
        except AuthenticationRequired:
            raise HTTPException(401, "Authentication required.") from None
        except ControlError as error:
            raise HTTPException(error.status, error.code) from None
        except ValidationError:
            raise HTTPException(422, "Invalid browser input.") from None
        except (StoreUnavailable, RuntimeError, ValueError, TimeoutError, OSError):
            raise HTTPException(503, "Browser operation was not confirmed; input is never retried automatically.") from None

    @app.post("/api/v1/bots/{bot_id}/browser", status_code=201, operation_id="openEmployeeBrowser")
    async def open_browser(request: Request, bot_id: str):
        return await guarded(service.open(await token(request), bot_id))

    @app.post("/api/v1/browser-sessions/{session_id}/commands", operation_id="commandEmployeeBrowser")
    async def command(request: Request, session_id: str):
        owner = await token(request)
        value = await read_json(request, max_bytes=20_000)
        # A disconnected viewer may have caused an effect. Cancelling the wait still records
        # uncertain outcome and leaves the browser paused; it never retries or releases control.
        async def watch(task):
            while not task.done():
                if await request.is_disconnected():
                    task.cancel()
                    return
                await asyncio.sleep(.05)
        task = asyncio.create_task(service.command(owner, session_id, value))
        watcher = asyncio.create_task(watch(task))
        try:
            return await guarded(task)
        finally:
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)

    @app.delete("/api/v1/browser-sessions/{session_id}", status_code=204, operation_id="closeEmployeeBrowser")
    async def close_browser(request: Request, session_id: str):
        await guarded(service.close(await token(request), session_id))
        return Response(status_code=204)
