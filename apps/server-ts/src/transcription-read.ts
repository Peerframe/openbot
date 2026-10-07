import { createHash } from "node:crypto";
import { transcriptionSettingsSchema } from "@openbot/protocol";
import postgres from "postgres";

export class ReadFailure extends Error {
  constructor(
    readonly status: 401 | 503,
    readonly body: { error: string },
  ) {
    super("Owner read refused.");
  }
}
const unauthorized = () => new ReadFailure(401, { error: "Authentication required." });
const unavailable = () => new ReadFailure(503, { error: "Control-plane storage is unavailable." });

// Retain Starlette's last named cookie and CPython quoted-cookie wire behavior. This
// is an independent compatibility implementation; URL percent decoding is not cookie parsing.
export function ownerCookie(header: string | undefined, secure: boolean): string | undefined {
  const name = secure ? "__Host-openbot_session" : "openbot_session";
  let value: string | undefined;
  for (const chunk of (header ?? "").split(";")) {
    const separator = chunk.indexOf("=");
    if (separator < 0 || chunk.slice(0, separator).trim() !== name) continue;
    value = chunk.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value
        .slice(1, -1)
        .replace(/\\([0-3][0-7]{2}|[\s\S])/g, (_match, escaped: string) =>
          /^[0-3][0-7]{2}$/.test(escaped) ? String.fromCharCode(parseInt(escaped, 8)) : escaped,
        );
    }
  }
  return value !== undefined && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}

export function transcriptionReader(databaseUrl: string) {
  const sql = postgres(databaseUrl, {
    max: 4,
    connect_timeout: 3,
    onnotice: () => undefined,
    connection: {
      application_name: "openbot-ts-transcription-read",
      statement_timeout: 3000,
      lock_timeout: 1000,
      idle_in_transaction_session_timeout: 5000,
      search_path: "public,pg_catalog",
      timezone: "UTC",
    },
  });
  let active = 0;
  return {
    async verify() {
      await sql`SELECT token_digest, owner_id, revoked_at, expires_at FROM auth_sessions WHERE false`;
      await sql`SELECT revision, transcription_connection_id FROM owner_preferences WHERE false`;
    },
    close: () => sql.end({ timeout: 1 }),
    async read(token: string | undefined, signal: AbortSignal) {
      if (!token) throw unauthorized();
      if (active >= 4 || signal.aborted) throw unavailable();
      active++;
      const digest = createHash("sha256").update(token, "ascii").digest("hex");
      const deadline = new AbortController();
      const bounded = AbortSignal.any([signal, deadline.signal]);
      const check = () => {
        if (bounded.aborted) throw unavailable();
      };
      const failure = new Promise<never>((_resolve, reject) => {
        bounded.addEventListener("abort", () => reject(unavailable()), {
          once: true,
        });
      });
      const timer = setTimeout(() => deadline.abort(), 6000);
      timer.unref();
      // Keep admission occupied until the actual transaction settles, even after a client
      // abort/deadline. PostgreSQL timeouts bound cleanup. Never cancel a reused pool socket.
      const transaction = sql
        .begin("isolation level read committed", async (db) => {
          check();
          const session = await db`SELECT token_digest FROM auth_sessions
          WHERE token_digest = ${digest} AND owner_id = 'owner'
            AND revoked_at IS NULL AND expires_at > clock_timestamp() FOR SHARE`;
          check();
          if (session.length !== 1) throw unauthorized();
          const rows = await db`SELECT revision, transcription_connection_id AS "connectionId"
          FROM owner_preferences WHERE owner_id = 'owner' FOR SHARE`;
          check();
          if (rows.length !== 1)
            throw new ReadFailure(503, {
              error: "owner_preferences_unavailable",
            });
          const settings = transcriptionSettingsSchema.parse(rows[0]);
          // SHARE also blocks revocation through the final authority check and commit.
          const current = await db`SELECT token_digest FROM auth_sessions
          WHERE token_digest = ${digest} AND owner_id = 'owner'
            AND revoked_at IS NULL AND expires_at > clock_timestamp()`;
          check();
          if (current.length !== 1) throw unauthorized();
          return settings;
        })
        .finally(() => {
          active--;
        });
      try {
        const settings = await Promise.race([transaction, failure]);
        check();
        return settings;
      } catch (error) {
        throw error instanceof ReadFailure ? error : unavailable();
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
