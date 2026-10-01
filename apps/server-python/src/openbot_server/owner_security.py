"""Atomic Owner credential rotation and session management on the existing auth store."""
import asyncio
from contextlib import asynccontextmanager
import hashlib
import re
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb

from .auth import AttemptResult
from .auth_credentials import StoredCredential
from .authority import AuthenticationRequired, OwnerTransactions
from .control_errors import ControlError
from .database import StoreUnavailable
from .models import iso_timestamp

# All login issuance and Owner security mutations acquire this before session row locks.
AUTH_LOCK = 1745083477


def token_digest(token):
    if not isinstance(token, str) or re.fullmatch(r"[A-Za-z0-9_-]{43}", token) is None:
        raise ControlError(401, "authentication_required")
    return hashlib.sha256(token.encode("ascii")).hexdigest()


class OwnerSecurityMixin:
    @asynccontextmanager
    async def _security(self, token):
        digest = token_digest(token)
        try:
            async with asyncio.timeout(6), self._capacity:
                async with await self._connect() as db:
                    await db.execute("SELECT pg_advisory_xact_lock(%s,1)", (AUTH_LOCK,))
                    await OwnerTransactions._authorize(db, digest, lock=True)
                    yield db, digest
                    await OwnerTransactions._authorize(db, digest)
        except AuthenticationRequired:
            raise ControlError(401, "authentication_required") from None
        except (psycopg.Error, TimeoutError, ValueError, KeyError):
            raise StoreUnavailable("owner_security_unavailable") from None

    @staticmethod
    async def _credential(db):
        row = await (await db.execute("SELECT revision,password_hash FROM owner_credentials WHERE owner_id='owner'")).fetchone()
        return StoredCredential(row["revision"], row["password_hash"]) if row else None

    async def credentials(self, *, token=None, required=False):
        if required:
            async with self._security(token) as (db, _):
                return await self._credential(db)
        try:
            async with asyncio.timeout(6), self._capacity:
                async with await self._connect() as db:
                    return await self._credential(db)
        except (psycopg.Error, TimeoutError, ValueError, KeyError):
            raise StoreUnavailable("owner_security_unavailable") from None

    async def list_sessions(self, token):
        async with self._security(token) as (db, digest):
            rows = await (await db.execute("SELECT id,user_agent,created_at,expires_at,token_digest=%s AS current "
                "FROM auth_sessions WHERE owner_id='owner' AND revoked_at IS NULL "
                "AND expires_at>clock_timestamp() ORDER BY created_at DESC,id LIMIT 101", (digest,))).fetchall()
            if len(rows)>100: raise StoreUnavailable("session_projection_limit")
            return [dict(id=row["id"], userAgent=row["user_agent"], current=row["current"],
                createdAt=iso_timestamp(row["created_at"]), expiresAt=iso_timestamp(row["expires_at"])) for row in rows]

    async def revoke_others(self, token):
        async with self._security(token) as (db, digest):
            rows = await (await db.execute("UPDATE auth_sessions SET revoked_at=clock_timestamp() "
                "WHERE owner_id='owner' AND token_digest<>%s AND revoked_at IS NULL "
                "AND expires_at>clock_timestamp() RETURNING id", (digest,))).fetchall()
            await db.execute("INSERT INTO run_events(id,type,payload) VALUES (%s,'OWNER_SESSIONS_REVOKED',%s)",
                (str(uuid4()), Jsonb(dict(actor="owner", revokedSessions=len(rows)))))
            return len(rows)

    async def rotate_password(self, token, *, valid_password, credential_revision, password_hash, client_digest):
        digest = token_digest(token)
        try:
            async with asyncio.timeout(6), self._capacity:
                async with await self._connect() as db:
                    await db.execute("SELECT pg_advisory_xact_lock(%s,1)", (AUTH_LOCK,))
                    await OwnerTransactions._authorize(db,digest,lock=True)
                    blocked = await self._reserve_attempt(db, client_digest)
                    if blocked: return blocked
                    current = await self._credential(db)
                    revision = current.revision if current else None
                    if not valid_password or revision != credential_revision:
                        return AttemptResult("invalid")
                    await db.execute("INSERT INTO owner_credentials(owner_id,password_hash,revision) VALUES ('owner',%s,1) "
                        "ON CONFLICT(owner_id) DO UPDATE SET password_hash=EXCLUDED.password_hash, "
                        "revision=owner_credentials.revision+1,updated_at=clock_timestamp()", (password_hash,))
                    await db.execute("DELETE FROM request_throttle_buckets WHERE scope='owner-login' AND client_digest=%s", (client_digest,))
                    # Recheck the locked initiating session before intentionally revoking it too.
                    await OwnerTransactions._authorize(db,digest)
                    rows = await (await db.execute("UPDATE auth_sessions SET revoked_at=clock_timestamp() "
                        "WHERE owner_id='owner' AND revoked_at IS NULL RETURNING id")).fetchall()
                    await db.execute("INSERT INTO run_events(id,type,payload) VALUES (%s,'OWNER_PASSWORD_CHANGED',%s)",
                        (str(uuid4()), Jsonb(dict(actor="owner", revokedSessions=len(rows)))))
                    return AttemptResult("issued")
        except AuthenticationRequired:
            raise ControlError(401,"authentication_required") from None
        except (psycopg.Error,TimeoutError,ValueError,KeyError):
            raise StoreUnavailable("owner_security_unavailable") from None
