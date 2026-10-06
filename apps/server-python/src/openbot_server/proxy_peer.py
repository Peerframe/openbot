"""Explicit private single-hop transport metadata, never identity/session authority."""
import ipaddress
from urllib.parse import urlsplit

from starlette.responses import JSONResponse

from .auth import InvalidClientIdentity, client_digest
from .auth_routes import validate_origins
from .worker_host_identity import resolve_client_address


class PrivateProxyPeer:
    def __init__(self, app, *, address, public_origin):
        validate_origins((public_origin,))
        try:
            if not ipaddress.ip_address(address).is_loopback:
                raise ValueError()
        except ValueError:
            raise ValueError("A numeric loopback proxy peer is required.") from None
        self.app = app
        self.address = address
        self.digest = client_digest(address)
        self.origin = urlsplit(public_origin)

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        try:
            peer = scope.get("client")
            if not peer or client_digest(peer[0]) != self.digest:
                raise InvalidClientIdentity()
            forwarded = [value for key, value in scope["headers"] if key.lower() == b"forwarded"]
            if len(forwarded) != 1 or not 0 < len(forwarded[0]) <= 256:
                raise InvalidClientIdentity()
            address, source = resolve_client_address(
                peer[0], forwarded[0].decode("ascii"), self.address)
        except (InvalidClientIdentity, UnicodeDecodeError):
            if scope["type"] == "websocket":
                return await send({"type": "websocket.close", "code": 1008})
            return await JSONResponse({"error": "Invalid proxy peer metadata."}, status_code=400)(
                scope, receive, send)
        # Only this trusted composition writes the private marker. Public headers/bodies
        # cannot choose the peer, advertised URL, enrollment source or authorization.
        scope = dict(scope)
        scope["client"] = (address, 0)
        scope["openbot.proxy_client"] = {"digest": client_digest(address), "source": source}
        scope["scheme"] = ("wss" if self.origin.scheme == "https" else "ws") if scope["type"] == "websocket" else self.origin.scheme
        scope["server"] = (self.origin.hostname, self.origin.port or (443 if self.origin.scheme == "https" else 80))
        scope["headers"] = [(key, value) for key, value in scope["headers"]
                            if key.lower() not in (b"host", b"forwarded")]
        scope["headers"].append((b"host", self.origin.netloc.encode("ascii")))
        await self.app(scope, receive, send)
