"""Retained single-use Worker enrollment, digest credentials and Owner revocation."""
from contextlib import asynccontextmanager
from datetime import timedelta
import hashlib
import math
import re
import secrets
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb
from pydantic import TypeAdapter

from .auth import InvalidClientIdentity, RateLimited, client_digest
from .authority import OwnerTransactions, PostgresTransactions
from .control_errors import ControlError
from .database import StoreUnavailable
from .models import iso_timestamp
from .worker_host_protocol import Credential, EnrollmentInput, ExchangeInput, NodeId


def digest_secret(kind, value):
    return hashlib.sha256((f"openbot:{kind}:" + value).encode("utf-8")).hexdigest()


def resolve_client_identity(remote_address, forwarded=None, trusted_proxy_address=None):
    direct = client_digest(remote_address)
    if trusted_proxy_address is None or direct != client_digest(trusted_proxy_address):
        return {"digest": direct, "source": "direct"}
    if not isinstance(forwarded, str) or not forwarded.strip() or "," in forwarded:
        raise InvalidClientIdentity()
    selected = None
    for parameter in forwarded.split(";"):
        key, separator, value = parameter.partition("=")
        if not separator or not key.strip():
            raise InvalidClientIdentity()
        if key.strip().lower() != "for":
            continue
        if selected is not None:
            raise InvalidClientIdentity()
        selected = value.strip()
        if selected.startswith('"'):
            if len(selected) < 2 or not selected.endswith('"') or "\\" in selected[1:-1]:
                raise InvalidClientIdentity()
            selected = selected[1:-1]
    if selected and selected.startswith("[") and selected.endswith("]"):
        selected = selected[1:-1]
    return {"digest": client_digest(selected), "source": "forwarded"}


class PostgresWorkerHostIdentity:
    def __init__(self, dsn):
        self._owner = OwnerTransactions(dsn, application_name="openbot-worker-identity")
        self._trusted = PostgresTransactions(dsn, application_name="openbot-worker-enrollment")

    async def verify_schema(self):
        await self._owner.verify_schema()

    @asynccontextmanager
    async def _transaction(self, token=None, *, owner=False):
        try:
            manager = self._owner.transaction(token) if owner else self._trusted.transaction()
            async with manager as connection:
                yield connection
        except psycopg.Error:
            raise StoreUnavailable("node_identity_storage_unavailable") from None

    @staticmethod
    async def _now(connection):
        cursor = await connection.execute("SELECT date_trunc('milliseconds', clock_timestamp()) AS now")
        return (await cursor.fetchone())["now"]

    @staticmethod
    async def _event(connection, node_id, kind, details, now):
        await connection.execute(
            "INSERT INTO node_identity_events(id,node_id,type,details,created_at) VALUES(%s,%s,%s,%s,%s)",
            (str(uuid4()), node_id, kind, Jsonb(details), now))

    async def issue(self, token, value):
        value = EnrollmentInput.model_validate(value)
        secret = "obenr_" + secrets.token_urlsafe(32)
        async with self._transaction(token, owner=True) as connection:
            await connection.execute("SELECT pg_advisory_xact_lock(%s,hashtext(%s))", (1326831444, value.nodeId))
            now = await self._now(connection)
            expires = now + timedelta(seconds=value.expiresInSeconds)
            await connection.execute("UPDATE node_enrollment_tokens SET consumed_at=%s WHERE node_id=%s AND consumed_at IS NULL", (now, value.nodeId))
            await connection.execute("INSERT INTO node_enrollment_tokens(id,node_id,token_digest,expires_at,created_at) VALUES(%s,%s,%s,%s,%s)",
                                     (str(uuid4()), value.nodeId, digest_secret("enrollment", secret), expires, now))
            await self._event(connection, value.nodeId, "enrollment_created", {"expiresAt": iso_timestamp(expires)}, now)
        return {"nodeId": value.nodeId, "token": secret, "expiresAt": iso_timestamp(expires)}

    async def _reserve(self, digest):
        # Same shared throttle table and advisory namespace as the retained Node server.
        async with self._transaction() as connection:
            await connection.execute("SELECT pg_advisory_xact_lock(%s,hashtext(%s))", (1745083476, "node-enrollment:" + digest))
            now = await self._now(connection)
            await connection.execute("DELETE FROM request_throttle_buckets WHERE updated_at < %s", (now - timedelta(minutes=10),))
            cursor = await connection.execute("SELECT attempt_count,window_started_at,blocked_until FROM request_throttle_buckets WHERE scope='node-enrollment' AND client_digest=%s", (digest,))
            current = await cursor.fetchone()
            if current and current["blocked_until"] and current["blocked_until"] > now:
                raise RateLimited(math.ceil((current["blocked_until"] - now).total_seconds()))
            expired = current is None or now - current["window_started_at"] >= timedelta(minutes=5)
            count = 1 if expired else current["attempt_count"] + 1
            await connection.execute(
                "INSERT INTO request_throttle_buckets(scope,client_digest,attempt_count,window_started_at,blocked_until,updated_at) "
                "VALUES('node-enrollment',%s,%s,%s,%s,%s) ON CONFLICT(scope,client_digest) DO UPDATE SET "
                "attempt_count=EXCLUDED.attempt_count,window_started_at=EXCLUDED.window_started_at,blocked_until=EXCLUDED.blocked_until,updated_at=EXCLUDED.updated_at",
                (digest, count, now if expired else current["window_started_at"], now + timedelta(minutes=5) if count >= 30 else None, now))

    async def enroll(self, value, client_identity):
        value = ExchangeInput.model_validate(value)
        if (type(client_identity) is not dict or set(client_identity) != {"digest", "source"}
                or re.fullmatch(r"[0-9a-f]{64}", str(client_identity["digest"])) is None
                or client_identity["source"] not in ("direct", "forwarded")):
            raise InvalidClientIdentity()
        await self._reserve(client_identity["digest"])
        credential = "obn_" + secrets.token_urlsafe(32)
        async with self._transaction() as connection:
            now = await self._now(connection)
            cursor = await connection.execute(
                "UPDATE node_enrollment_tokens SET consumed_at=%s WHERE node_id=%s AND token_digest=%s "
                "AND consumed_at IS NULL AND expires_at>%s RETURNING id",
                (now, value.nodeId, digest_secret("enrollment", value.token), now))
            if await cursor.fetchone() is None:
                raise ControlError(401, "Node enrollment token is invalid or expired.")
            await connection.execute(
                "INSERT INTO node_credentials(node_id,credential_digest,enrolled_at,updated_at) VALUES(%s,%s,%s,%s) "
                "ON CONFLICT(node_id) DO UPDATE SET credential_digest=EXCLUDED.credential_digest,enrolled_at=EXCLUDED.enrolled_at,"
                "last_authenticated_at=NULL,revoked_at=NULL,updated_at=EXCLUDED.updated_at",
                (value.nodeId, digest_secret("credential", credential), now, now))
            await self._event(connection, value.nodeId, "enrolled", {"clientIdentityDigest": client_identity["digest"], "clientIdentitySource": client_identity["source"]}, now)
            await connection.execute("DELETE FROM request_throttle_buckets WHERE scope='node-enrollment' AND client_digest=%s", (client_identity["digest"],))
        return {"format": "openbot.node-identity/v1", "nodeId": value.nodeId, "credential": credential, "enrolledAt": iso_timestamp(now)}

    async def authenticate(self, node_id, credential):
        node_id = TypeAdapter(NodeId).validate_python(node_id, strict=True)
        credential = TypeAdapter(Credential).validate_python(credential, strict=True)
        async with self._transaction() as connection:
            now = await self._now(connection)
            cursor = await connection.execute(
                "UPDATE node_credentials SET last_authenticated_at=%s,updated_at=%s WHERE node_id=%s AND credential_digest=%s "
                "AND revoked_at IS NULL RETURNING node_id", (now, now, node_id, digest_secret("credential", credential)))
            accepted = await cursor.fetchone() is not None
        return accepted

    async def list(self, token):
        async with self._transaction(token, owner=True) as connection:
            cursor = await connection.execute("SELECT node_id,enrolled_at,last_authenticated_at,revoked_at FROM node_credentials ORDER BY updated_at DESC")
            rows = await cursor.fetchall()
        return [{"nodeId": row["node_id"], "enrolledAt": iso_timestamp(row["enrolled_at"]),
                 "lastAuthenticatedAt": iso_timestamp(row["last_authenticated_at"]) if row["last_authenticated_at"] else None,
                 "revokedAt": iso_timestamp(row["revoked_at"]) if row["revoked_at"] else None} for row in rows]

    async def authorize(self, token):
        async with self._transaction(token, owner=True):
            pass

    async def revoke(self, token, node_id):
        node_id = TypeAdapter(NodeId).validate_python(node_id, strict=True)
        async with self._transaction(token, owner=True) as connection:
            now = await self._now(connection)
            cursor = await connection.execute("UPDATE node_credentials SET revoked_at=%s,updated_at=%s WHERE node_id=%s AND revoked_at IS NULL RETURNING node_id", (now, now, node_id))
            if await cursor.fetchone() is None:
                raise ControlError(404, "Active Node identity not found.")
            await self._event(connection, node_id, "revoked", {}, now)
