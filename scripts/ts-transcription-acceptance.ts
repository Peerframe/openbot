import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase } from "@openbot/db";
import { transcriptionSettingsSchema } from "@openbot/protocol";

/** Real disposable SQL/HTTP authority checks; no synthetic upstream or provider calls. */
export async function qualifyTranscriptionRead(options: {
  databaseUrl: string;
  origin: string;
  privateOrigin: string;
  cookie: string;
  stopPython(): Promise<void>;
  restorePython(): Promise<void>;
  reverseToPython(): Promise<void>;
  restoreTs(): Promise<void>;
}) {
  const database = createDatabase(options.databaseUrl),
    sql = database.client;
  const path = "/api/v1/settings/transcription";
  const cookieName = options.cookie.split("=")[0]!;
  let passed = 0;
  const check = async (name: string, operation: () => Promise<void>) => {
    await operation();
    passed++;
    console.log(`TS read PASS ${passed}: ${name}`);
  };
  const request = async (
    cookie = options.cookie,
    target = path,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(`${options.origin}${target}`, {
      headers: { Cookie: cookie, ...headers },
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: await response.json(),
    };
  };
  const read = async () => {
    const result = await request();
    assert.equal(result.status, 200);
    return transcriptionSettingsSchema.parse(result.body);
  };
  const session = async (condition = "live") => {
    const token = randomBytes(32).toString("base64url");
    const digest = createHash("sha256").update(token).digest("hex");
    await sql`INSERT INTO auth_sessions(id,owner_id,token_digest,expires_at,created_at,revoked_at)
      VALUES (${randomUUID()},'owner',${digest},clock_timestamp() + interval '1 hour',clock_timestamp(),
        ${condition === "revoked" ? new Date().toISOString() : null})`;
    if (condition === "expired")
      await sql`UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_digest=${digest}`;
    return { token, digest, cookie: `${cookieName}=${token}` };
  };
  const waitBlocked = async (count: number, query = "SELECT revision") => {
    const until = Date.now() + 900;
    while (Date.now() < until) {
      const rows = await sql`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE application_name = 'openbot-ts-transcription-read' AND wait_event_type = 'Lock'
          AND query LIKE ${`%${query}%`}`;
      if (rows[0]!.count >= count) return;
      await delay(10);
    }
    throw new Error("The owned TS SQL transaction did not reach the expected lock.");
  };
  const heldPreferences = async () => {
    const held = await sql.reserve();
    await held`BEGIN`;
    await held`SELECT revision FROM owner_preferences WHERE owner_id='owner' FOR UPDATE`;
    return {
      async release() {
        try {
          await held`ROLLBACK`;
        } finally {
          held.release();
        }
      },
    };
  };
  try {
    const initial = await read();
    await check("shared projection, ignored query, encoded path and security headers", async () => {
      for (const target of [path, `${path}?retained=ignored`, "/api/v1/settings/%74ranscription"]) {
        const result = await request(options.cookie, target);
        assert.equal(result.status, 200);
        assert.deepEqual(result.body, initial);
        assert.equal(result.headers.get("cache-control"), "no-store");
        assert.equal(result.headers.get("x-content-type-options"), "nosniff");
        assert.equal(result.headers.get("x-frame-options"), "DENY");
      }
      const head = await fetch(`${options.origin}${path}`, {
        method: "HEAD",
        headers: { Cookie: options.cookie },
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(head.status, 405);
      await head.arrayBuffer();
    });
    await check("CORS retains configured and untrusted Origin behavior", async () => {
      const allowed = await request(options.cookie, path, {
        Origin: options.origin,
      });
      assert.equal(allowed.headers.get("access-control-allow-origin"), options.origin);
      assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");
      assert.equal(allowed.headers.get("access-control-expose-headers"), "X-OpenBot-Next-Before");
      const secondary = await request(options.cookie, path, {
        Origin: "https://secondary.example.test",
      });
      assert.equal(secondary.status, 200);
      assert.equal(
        secondary.headers.get("access-control-allow-origin"),
        "https://secondary.example.test",
      );
      const other = await request(options.cookie, path, {
        Origin: "https://untrusted.example.test",
      });
      assert.equal(other.status, 200);
      assert.equal(other.headers.get("access-control-allow-origin"), null);
    });
    await check(
      "missing, malformed, unknown, expired and revoked cookies fail closed",
      async () => {
        const expired = await session("expired"),
          revoked = await session("revoked");
        for (const cookie of [
          "",
          `${cookieName}=bad`,
          `${cookieName}=${randomBytes(32).toString("base64url")}`,
          expired.cookie,
          revoked.cookie,
        ]) {
          const result = await request(cookie);
          assert.equal(result.status, 401);
          assert.deepEqual(result.body, { error: "Authentication required." });
        }
      },
    );
    await check("quoted and duplicate cookies retain Python wire behavior", async () => {
      const value = options.cookie.slice(cookieName.length + 1);
      assert.equal((await request(`${cookieName}=bad; ${cookieName}="${value}"`)).status, 200);
      assert.equal((await request(`${options.cookie}; ${cookieName}=bad`)).status, 401);
      const otherName = cookieName.startsWith("__Host-")
        ? "openbot_session"
        : "__Host-openbot_session";
      assert.equal((await request(`${otherName}=${value}`)).status, 401);
    });
    await check("Python private GET is quarantined rather than a hidden fallback", async () => {
      const response = await fetch(`${options.privateOrigin}${path}`, {
        headers: {
          Host: new URL(options.origin).host,
          Forwarded: "for=127.0.0.1",
          Cookie: options.cookie,
        },
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: "operation_owned_by_ts",
      });
    });
    await check(
      "Python PUT stays the single settings writer with revision conflict protection",
      async () => {
        await sql`UPDATE owner_preferences SET revision=revision+1, transcription_connection_id='disposable-prior' WHERE owner_id='owner'`;
        const previous = await read();
        const response = await fetch(`${options.origin}${path}`, {
          method: "PUT",
          headers: {
            Origin: options.origin,
            "Content-Type": "application/json",
            Cookie: options.cookie,
          },
          body: JSON.stringify({
            expectedRevision: previous.revision,
            connectionId: null,
          }),
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(response.status, 200);
        const written = transcriptionSettingsSchema.parse(await response.json());
        assert.deepEqual(await read(), written);
        assert.equal(written.revision, previous.revision + 1);
        const stale = await fetch(`${options.origin}${path}`, {
          method: "PUT",
          headers: {
            Origin: options.origin,
            "Content-Type": "application/json",
            Cookie: options.cookie,
          },
          body: JSON.stringify({ expectedRevision: previous.revision, connectionId: null }),
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(stale.status, 409);
        await stale.arrayBuffer();
        const invalid = await fetch(`${options.origin}${path}`, {
          method: "PUT",
          headers: {
            Origin: options.origin,
            "Content-Type": "application/json",
            Cookie: options.cookie,
          },
          body: JSON.stringify({
            expectedRevision: written.revision,
            connectionId: null,
            extra: true,
          }),
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(invalid.status, 422);
        await invalid.arrayBuffer();
      },
    );
    await check("expiration during a blocked read is rechecked before commit", async () => {
      const short = await session();
      const held = await heldPreferences();
      try {
        await sql`UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '600 milliseconds' WHERE token_digest=${short.digest}`;
        const pending = request(short.cookie);
        await waitBlocked(1);
        await sql`SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM (expires_at-clock_timestamp())))+0.03)
          FROM auth_sessions WHERE token_digest=${short.digest}`;
        await held.release();
        assert.equal((await pending).status, 401);
      } catch (error) {
        await held.release().catch(() => undefined);
        throw error;
      }
    });
    await check(
      "revocation waits for the admitted read, then denies subsequent reads",
      async () => {
        const live = await session();
        const held = await heldPreferences();
        let revoke: Promise<unknown> | undefined;
        try {
          const pending = request(live.cookie);
          await waitBlocked(1);
          let revoked = false;
          revoke =
            sql`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE token_digest=${live.digest}`.then(
              () => {
                revoked = true;
              },
            );
          const until = Date.now() + 500;
          let blocked = false;
          while (Date.now() < until) {
            const rows =
              await sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'UPDATE auth_sessions SET revoked_at=%'`;
            if (rows[0]!.count > 0) {
              blocked = true;
              break;
            }
            await delay(10);
          }
          assert(blocked && !revoked, "Revocation must wait on the Owner SHARE lock.");
          await held.release();
          assert.equal((await pending).status, 200);
          await revoke;
          assert.equal((await request(live.cookie)).status, 401);
        } catch (error) {
          await held.release().catch(() => undefined);
          await revoke;
          throw error;
        }
      },
    );
    await check("bounded admission and lock timeout return sanitized 503 and recover", async () => {
      const held = await heldPreferences();
      try {
        const pending = Array.from({ length: 4 }, () => request());
        await waitBlocked(4);
        assert.equal((await request()).status, 503);
        for (const result of await Promise.all(pending)) {
          assert.equal(result.status, 503);
          assert.deepEqual(result.body, {
            error: "Control-plane storage is unavailable.",
          });
        }
      } finally {
        await held.release();
      }
      assert.equal((await request()).status, 200);
    });
    await check("client abort releases the actual transaction and admission", async () => {
      const held = await heldPreferences();
      const abort = new AbortController();
      const pending = fetch(`${options.origin}${path}`, {
        headers: { Cookie: options.cookie },
        signal: abort.signal,
      });
      const failure = assert.rejects(pending);
      try {
        await waitBlocked(1);
        abort.abort();
        await failure;
      } finally {
        abort.abort();
        await held.release();
      }
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await sql`SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE application_name='openbot-ts-transcription-read' AND state != 'idle'`;
        if (rows[0]!.count === 0) break;
        if (attempt === 99) throw new Error("Aborted SQL transaction was not released.");
        await delay(20);
      }
      assert.equal((await request()).status, 200);
    });
    await check("missing settings fail closed without initializing data", async () => {
      const retained = await sql`SELECT * FROM owner_preferences WHERE owner_id='owner'`;
      assert.equal(retained.length, 1);
      await sql`DELETE FROM owner_preferences WHERE owner_id='owner'`;
      try {
        const result = await request();
        assert.equal(result.status, 503);
        assert.deepEqual(result.body, { error: "owner_preferences_unavailable" });
        const rows = await sql`SELECT count(*)::int AS count FROM owner_preferences`;
        assert.equal(rows[0]!.count, 0);
      } finally {
        await sql`INSERT INTO owner_preferences SELECT * FROM jsonb_populate_record(NULL::owner_preferences, ${JSON.stringify(retained[0]!)}::jsonb)`;
      }
      assert.deepEqual(await read(), {
        revision: retained[0]!.revision,
        connectionId: retained[0]!.transcription_connection_id,
      });
    });
    await check("reads do not mutate sessions, preferences or audit", async () => {
      const snapshot = async () => {
        const rows = await sql`SELECT (SELECT jsonb_agg(t) FROM auth_sessions t) AS sessions,
          (SELECT jsonb_agg(t) FROM owner_preferences t) AS preferences,
          (SELECT count(*)::int FROM run_events) AS audit`;
        return rows;
      };
      const before = await snapshot();
      await read();
      await read();
      assert.deepEqual(await snapshot(), before);
    });
    await check(
      "owned GET works with Python stopped; forwarded Work read reports upstream failure",
      async () => {
        const before = await read();
        await options.stopPython();
        try {
          assert.deepEqual(await read(), before);
          const response = await request(options.cookie, "/api/v1/tasks");
          assert.equal(response.status, 503);
          assert.deepEqual(response.body, {
            error: "Control-plane upstream is unavailable.",
          });
        } finally {
          await options.restorePython();
        }
      },
    );
    await check(
      "explicit reverse switch and restoration keep issued session and newer SQL data",
      async () => {
        await sql`UPDATE owner_preferences SET revision=revision+1, transcription_connection_id='disposable-selection' WHERE owner_id='owner'`;
        const before = await read();
        assert.equal(before.connectionId, "disposable-selection");
        await options.reverseToPython();
        const anonymous = await request("");
        assert.equal(anonymous.status, 401);
        assert.deepEqual(anonymous.body, { error: "Authentication required." });
        assert.deepEqual(await read(), before);
        await options.restoreTs();
        assert.deepEqual(await read(), before);
        await sql`UPDATE owner_preferences SET transcription_connection_id=NULL WHERE owner_id='owner'`;
      },
    );
    console.log(`TS transcription read qualification: ${passed} passed (real HTTP/PostgreSQL).`);
  } finally {
    await database.close();
  }
}
