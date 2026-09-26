"""Original node enrollment/control routes and the single retained Worker WebSocket path."""
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import TypeAdapter, ValidationError

from .auth import InvalidClientIdentity, RateLimited, client_digest
from .auth_routes import validate_origins
from .authority import AuthenticationRequired
from .http_input import read_json
from .worker_host_identity import resolve_client_identity
from .worker_host_protocol import EnrollmentInput, ExchangeInput, NodeId


def register_worker_host_routes(app: FastAPI, identity, registry, *, secure_cookies: bool,
                               allowed_origins: tuple[str, ...], trusted_proxy_address=None):
    """Mount once. Shutdown must await registry.close(); use worker_host_uvicorn_options()."""
    validate_origins(allowed_origins)
    if trusted_proxy_address is not None:
        client_digest(trusted_proxy_address)
    cookie_name = "__Host-openbot_session" if secure_cookies else "openbot_session"

    async def owner(request, *, write=False):
        if write and request.headers.get("origin") not in allowed_origins:
            raise HTTPException(403, "Request origin is not allowed.")
        token = request.cookies.get(cookie_name)
        try:
            await identity.authorize(token)
        except AuthenticationRequired:
            raise HTTPException(401, "Authentication required.") from None
        return token

    async def payload(request, validator):
        try:
            return validator.model_validate(await read_json(request, max_bytes=8192)).model_dump()
        except (ValueError, ValidationError, OverflowError):
            raise HTTPException(422, "Invalid node identity input.") from None

    async def owner_call(operation, *arguments):
        try:
            return await operation(*arguments)
        except AuthenticationRequired:
            raise HTTPException(401, "Authentication required.") from None

    @app.get("/api/v1/nodes", operation_id="listWorkerNodes")
    async def nodes(request: Request):
        await owner(request)
        return {"nodes": registry.list()}

    @app.get("/api/v1/node-identities", operation_id="listWorkerNodeIdentities")
    async def identities(request: Request):
        token = await owner(request)
        rows = await owner_call(identity.list, token)
        connected = {node["id"]: node for node in registry.list()}
        return {"identities": [{"nodeId": row["nodeId"], "status": "revoked" if row["revokedAt"] else "active",
            "connected": row["nodeId"] in connected, "enrolledAt": row["enrolledAt"],
            **({"lastAuthenticatedAt": row["lastAuthenticatedAt"]} if row["lastAuthenticatedAt"] else {}),
            **({"revokedAt": row["revokedAt"]} if row["revokedAt"] else {}),
            **({"node": connected[row["nodeId"]]} if row["nodeId"] in connected else {})} for row in rows]}

    @app.post("/api/v1/nodes/enrollment-tokens", status_code=201, operation_id="issueWorkerEnrollmentToken")
    async def issue(request: Request):
        token = await owner(request, write=True)
        return await owner_call(identity.issue, token, await payload(request, EnrollmentInput))

    @app.post("/api/v1/nodes/enroll", status_code=201, operation_id="exchangeWorkerEnrollment")
    async def enroll(request: Request):
        value = await payload(request, ExchangeInput)
        # ASGI must see the direct socket peer. Uvicorn proxy_headers stays disabled; only
        # this existing one-proxy RFC 7239 policy may consume forwarding metadata.
        try:
            forwarded = request.headers.getlist("forwarded")
            client = resolve_client_identity(request.client.host if request.client else None,
                                            ",".join(forwarded) if forwarded else None, trusted_proxy_address)
        except InvalidClientIdentity:
            raise HTTPException(400, "Invalid client identity.") from None
        try:
            async with registry.identity_guard(value["nodeId"]):
                result = await identity.enroll(value, client)
                await registry.disconnect(value["nodeId"])
        except RateLimited as error:
            return JSONResponse({"error": "Too many node enrollment attempts. Try again later."}, status_code=429,
                                headers={"Retry-After": str(error.retry_after)})
        return result

    @app.post("/api/v1/nodes/{node_id}/revoke", status_code=204, operation_id="revokeWorkerIdentity")
    async def revoke(request: Request, node_id: str):
        token = await owner(request, write=True)
        try:
            node_id = TypeAdapter(NodeId).validate_python(node_id, strict=True)
        except ValidationError:
            raise HTTPException(422, "Node id is invalid.") from None
        async with registry.identity_guard(node_id):
            await owner_call(identity.revoke, token, node_id)
            await registry.disconnect(node_id)
        return Response(status_code=204)

    app.add_api_websocket_route("/ws/nodes", registry.handle, name="workerHostChannel")
