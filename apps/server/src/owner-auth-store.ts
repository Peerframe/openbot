/** Persists Owner credentials, sessions and login throttles using the established security lock order. */
import { LOCK_NAMESPACE } from "./database-locks.js";
import { databasePool } from "./database-pool.js";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { boundedAdmission } from "./request-limits.js";
import { digest } from "./owner-auth-crypto.js";
import { HttpFailure, storageUnavailable } from "./http-errors.js";

type Credential = { revision: number; password_hash: string } | undefined;
type Attempt =
  | { status: "invalid" }
  | { status: "throttled"; retryAfter: number }
  | { status: "issued"; expiresAt?: string };
import { sessionDigest, requireOwnerSession, findOwnerSession } from "./owner-session.js";
export { sessionDigest } from "./owner-session.js";
export function ownerAuthStore(databaseUrl: string) {
  const pool = databasePool(databaseUrl);
  const sql = pool.sql;
  const admit = boundedAdmission(4, { waitForSettlement: true, committedResult: true });
  const transaction = <T>(
    signal: AbortSignal,
    action: (db: postgres.TransactionSql, check: () => void) => Promise<T>,
  ) =>
    admit(
      signal,
      async (check) =>
        (await sql.begin("isolation level read committed", async (db) => {
          check();
          const result = await action(db, check);
          check();
          return result;
        })) as T,
    );
  const credential = async (db: postgres.TransactionSql): Promise<Credential> =>
    (
      await db<
        NonNullable<Credential>[]
      >`SELECT revision,password_hash FROM owner_credentials WHERE owner_id='owner'`
    )[0];
  const lock = (db: postgres.TransactionSql) => db`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE.ownerAuthentication},1)`;
  const authorize = requireOwnerSession;
  const security = <T>(
    token: string | undefined,
    signal: AbortSignal,
    action: (db: postgres.TransactionSql, tokenDigest: string) => Promise<T>,
  ) => {
    const tokenDigest = sessionDigest(token);
    return transaction(signal, async (db, check) => {
      // Same lock order as Python login/rotation, before any session SHARE lock.
      await lock(db);
      check();
      await authorize(db, tokenDigest, true);
      check();
      const result = await action(db, tokenDigest);
      check();
      await authorize(db, tokenDigest);
      return result;
    });
  };
  const audit = (
    db: postgres.TransactionSql,
    type: string,
    payload: Record<string, string | number>,
  ) =>
    db`INSERT INTO run_events(id,type,payload) VALUES(${randomUUID()},${type},${db.json(payload)})`;
  async function reserve(
    db: postgres.TransactionSql,
    client: string,
  ): Promise<Attempt | undefined> {
    await db`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE.requestThrottle},hashtext(${"owner-login:" + client}))`;
    const now = (
      await db<{ now: Date }[]>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`
    )[0]!.now;
    await db`DELETE FROM request_throttle_buckets WHERE updated_at<${new Date(now.getTime() - 600000)}`;
    const current = (
      await db<{ attempt_count: number; window_started_at: Date; blocked_until: Date | null }[]>`
      SELECT attempt_count,window_started_at,blocked_until FROM request_throttle_buckets WHERE scope='owner-login' AND client_digest=${client}`
    )[0];
    if (current?.blocked_until && current.blocked_until > now)
      return {
        status: "throttled",
        retryAfter: Math.ceil((current.blocked_until.getTime() - now.getTime()) / 1000),
      };
    const expired = !current || now.getTime() - current.window_started_at.getTime() >= 300000;
    const count = expired ? 1 : current!.attempt_count + 1;
    const started = expired ? now : current!.window_started_at;
    const blocked = count >= 5 ? new Date(now.getTime() + 300000) : null;
    await db`INSERT INTO request_throttle_buckets(scope,client_digest,attempt_count,window_started_at,blocked_until,updated_at)
      VALUES('owner-login',${client},${count},${started},${blocked},${now})
      ON CONFLICT(scope,client_digest) DO UPDATE SET attempt_count=EXCLUDED.attempt_count,
      window_started_at=EXCLUDED.window_started_at,blocked_until=EXCLUDED.blocked_until,updated_at=EXCLUDED.updated_at`;
  }
  return {
    async verify() {
      await sql`SELECT id,owner_id,token_digest,created_at,expires_at,revoked_at,user_agent FROM auth_sessions WHERE false`;
      await sql`SELECT owner_id,revision,password_hash,updated_at FROM owner_credentials WHERE false`;
      await sql`SELECT scope,client_digest,attempt_count,window_started_at,blocked_until,updated_at FROM request_throttle_buckets WHERE false`;
      await sql`SELECT id,type,payload FROM run_events WHERE false`;
    },
    close: () => pool.close(),
    credentials: (signal: AbortSignal, token?: string, required = false) =>
      required ? security(token, signal, (db) => credential(db)) : transaction(signal, credential),
    session(token: string | undefined, signal: AbortSignal) {
      if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return Promise.resolve(undefined);
      return transaction(signal, async (db, check) => {
        const tokenDigest = digest(token);
        const session = await findOwnerSession(db, tokenDigest);
        check();
        if (!session) return undefined;
        const current = await findOwnerSession(db, tokenDigest);
        return current ? session.expires_at.toISOString() : undefined;
      });
    },
    sessions: (token: string | undefined, signal: AbortSignal) =>
      security(token, signal, async (db, tokenDigest) => {
        const rows =
          await db`SELECT id,user_agent,created_at,expires_at,token_digest=${tokenDigest} AS current
        FROM auth_sessions WHERE owner_id='owner' AND revoked_at IS NULL AND expires_at>clock_timestamp()
        ORDER BY created_at DESC,id LIMIT 101`;
        if (rows.length > 100) throw storageUnavailable();
        return rows.map((row) => ({
          id: row.id as string,
          userAgent: row.user_agent as string,
          current: row.current as boolean,
          createdAt: (row.created_at as Date).toISOString(),
          expiresAt: (row.expires_at as Date).toISOString(),
        }));
      }),
    revokeOthers: (token: string | undefined, signal: AbortSignal) =>
      security(token, signal, async (db, tokenDigest) => {
        const rows =
          await db`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE owner_id='owner'
        AND token_digest<>${tokenDigest} AND revoked_at IS NULL AND expires_at>clock_timestamp() RETURNING id`;
        await audit(db, "OWNER_SESSIONS_REVOKED", { actor: "owner", revokedSessions: rows.length });
        return rows.length;
      }),
    logout(token: string | undefined, signal: AbortSignal) {
      if (
        !token ||
        token.length !== 43 ||
        [...token].some((character) => character.charCodeAt(0) > 127)
      )
        return Promise.resolve(false);
      return transaction(signal, async (db) => {
        const rows =
          await db`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE token_digest=${digest(token)}
          AND owner_id='owner' AND revoked_at IS NULL AND expires_at>clock_timestamp() RETURNING id`;
        if (rows.length) await audit(db, "AUTH_LOGOUT", { actor: "owner" });
        return rows.length === 1;
      });
    },
    login(
      input: {
        valid: boolean;
        revision: number | undefined;
        client: string;
        token: string;
        ttlHours: number;
        userAgent: string;
      },
      signal: AbortSignal,
    ): Promise<Attempt> {
      return transaction(signal, async (db, check) => {
        await lock(db);
        check();
        const blocked = await reserve(db, input.client);
        check();
        if (blocked) return blocked;
        const current = await credential(db);
        check();
        if (!input.valid || current?.revision !== input.revision) {
          await audit(db, "AUTH_LOGIN_FAILED", {});
          // Return normally: invalid attempts and audit must commit.
          return { status: "invalid" };
        }
        const now = (
          await db<{ now: Date }[]>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`
        )[0]!.now;
        await db`DELETE FROM request_throttle_buckets WHERE scope='owner-login' AND client_digest=${input.client}`;
        await db`DELETE FROM auth_sessions WHERE expires_at<=${now}`;
        const count = (
          await db`SELECT count(*) AS count FROM auth_sessions WHERE owner_id='owner' AND revoked_at IS NULL AND expires_at>clock_timestamp()`
        )[0]!.count;
        check();
        if (Number(count) >= 100) return { status: "throttled", retryAfter: 300 };
        const expires = new Date(now.getTime() + input.ttlHours * 3600000);
        await db`INSERT INTO auth_sessions(id,owner_id,token_digest,expires_at,created_at,user_agent)
          VALUES(${randomUUID()},'owner',${digest(input.token)},${expires},${now},${input.userAgent})`;
        await audit(db, "AUTH_LOGIN_SUCCEEDED", { actor: "owner" });
        return { status: "issued", expiresAt: expires.toISOString() };
      });
    },
    rotate(
      token: string | undefined,
      input: {
        valid: boolean;
        revision: number | undefined;
        client: string;
        hash: string | undefined;
      },
      signal: AbortSignal,
    ): Promise<Attempt> {
      const tokenDigest = sessionDigest(token);
      return transaction(signal, async (db, check) => {
        await lock(db);
        check();
        await authorize(db, tokenDigest, true);
        check();
        const blocked = await reserve(db, input.client);
        check();
        if (blocked) return blocked;
        const current = await credential(db);
        check();
        if (!input.valid || current?.revision !== input.revision) return { status: "invalid" };
        if (!input.hash) throw storageUnavailable();
        await db`INSERT INTO owner_credentials(owner_id,password_hash,revision) VALUES('owner',${input.hash},1)
          ON CONFLICT(owner_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,
          revision=owner_credentials.revision+1,updated_at=clock_timestamp()`;
        await db`DELETE FROM request_throttle_buckets WHERE scope='owner-login' AND client_digest=${input.client}`;
        check();
        await authorize(db, tokenDigest);
        check();
        // The initiating session is intentionally revoked too; final authority check precedes it.
        const rows =
          await db`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE owner_id='owner' AND revoked_at IS NULL RETURNING id`;
        await audit(db, "OWNER_PASSWORD_CHANGED", { actor: "owner", revokedSessions: rows.length });
        return { status: "issued" };
      });
    },
  };
}
