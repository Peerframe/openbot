/** Real Server scenario; synthetic rows and peers are restricted to its owned fixture. */
import { scenarioStep as check } from "./scenario-step.ts";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase } from "@openbot/db";
import {
  authSessionSchema,
  ownerSessionsResponseSchema,
  ownerSessionRevocationResponseSchema,
} from "@openbot/protocol";

/** Real HTTP and SQL on the driver's disposable database; never configured user credentials. */
export async function qualifyOwnerAuth(options: {
  databaseUrl: string;
  origin: string;
  cookie: string;
  restart(): Promise<void>;
  password: string;
}): Promise<string> {
  const database = createDatabase(options.databaseUrl),
    sql = database.client;
  let cookie = options.cookie;
  const cookieName = cookie.split("=", 1)[0]!;
  const newPassword = `Synthetic-${randomBytes(24).toString("base64url")}-😀`;
  const request = async (
    path: string,
    method = "GET",
    value?: unknown,
    overrides: {
      cookie?: string;
      origin?: string;
      raw?: string | Uint8Array;
      type?: string;
      signal?: AbortSignal;
    } = {},
  ) => {
    const response = await fetch(options.origin + "/api/v1/auth/" + path, {
      method,
      headers: {
        Cookie: overrides.cookie ?? cookie,
        Origin: overrides.origin ?? options.origin,
        ...(value !== undefined ? { "Content-Type": overrides.type ?? "application/json" } : {}),
        "User-Agent": "Synthetic Owner auth acceptance",
      },
      ...(value !== undefined ? { body: overrides.raw ?? JSON.stringify(value) } : {}),
      redirect: "manual",
      signal: overrides.signal ?? AbortSignal.timeout(8000),
    });
    return {
      status: response.status,
      body: response.status === 204 ? undefined : await response.json(),
      headers: response.headers,
    };
  };
  const login = async (password: string) => {
    const result = await request("login", "POST", { password });
    assert.equal(result.status, 200);
    const header = result.headers.get("set-cookie");
    assert(header);
    assert(
      header.startsWith(cookieName + "=") &&
        header.includes("HttpOnly") &&
        header.includes("SameSite=strict") &&
        header.includes("Path=/") &&
        !header.includes("Domain="),
    );
    if (options.origin.startsWith("https:")) assert(header.includes("Secure"));
    return header.split(";")[0]!;
  };
  const attempts = () =>
    sql`SELECT client_digest,attempt_count,blocked_until FROM request_throttle_buckets WHERE scope='owner-login'`;
  const clearAttempts = () => sql`DELETE FROM request_throttle_buckets WHERE scope='owner-login'`;
  const snapshot = async () => ({
    credentials: await sql`SELECT * FROM owner_credentials ORDER BY owner_id`,
    sessions: await sql`SELECT * FROM auth_sessions ORDER BY id`,
    events:
      await sql`SELECT id,type,payload FROM run_events WHERE type IN ('AUTH_LOGIN_SUCCEEDED','AUTH_LOGIN_FAILED','AUTH_LOGOUT','OWNER_SESSIONS_REVOKED','OWNER_PASSWORD_CHANGED') ORDER BY id`,
  });
  const hold = async () => {
    const connection = await sql.reserve();
    await connection`BEGIN`;
    await connection`SELECT pg_advisory_xact_lock(1745083477,1)`;
    return {
      connection,
      async release(commit = false) {
        try {
          if (commit) await connection`COMMIT`;
          else await connection`ROLLBACK`;
        } finally {
          connection.release();
        }
      },
    };
  };
  const waitBlocked = async (count = 1) => {
    const until = Date.now() + 900;
    while (Date.now() < until) {
      const rows =
        await sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='openbot-transactions' AND wait_event_type='Lock'`;
      if (rows[0]!.count >= count) return;
      await delay(10);
    }
    throw new Error("Owned authentication did not reach the shared advisory lock.");
  };
  try {

    await check("Origin precedes input; password input precedes session authority", async () => {
      const before = await snapshot();
      for (const path of ["login", "logout", "password", "sessions/revoke-others"])
        assert.deepEqual(
          (await request(path, "POST", {}, { origin: "null", cookie: "", raw: "bad" })).body,
          { error: "Request origin is not allowed." },
        );
      assert.deepEqual((await request("password", "POST", {}, { cookie: "" })).body, {
        error: "Invalid password change input.",
      });
      assert.deepEqual(
        (
          await request(
            "password",
            "POST",
            { currentPassword: options.password, newPassword },
            { cookie: "" },
          )
        ).body,
        { error: "authentication_required" },
      );
      assert.deepEqual((await request("sessions", "GET", undefined, { cookie: "" })).body, {
        error: "authentication_required",
      });
      assert.deepEqual((await request("session", "GET", undefined, { cookie: "" })).body, {
        authenticated: false,
      });
      assert.deepEqual(await snapshot(), before);
    });
    await check("JSON MIME/byte/Unicode bounds and strict password commands", async () => {
      for (const [raw, type, status, error] of [
        [" ".repeat(8193), "application/json", 413, "Request is too large."],
        ['{"password":NaN}', "application/json", 422, "Invalid JSON input."],
        [new Uint8Array([0xc0, 0xaf]), "application/json", 422, "Invalid JSON input."],
        ["{}", "text/plain", 422, "Request requires JSON."],
      ] as const) {
        const result = await request("login", "POST", {}, { raw, type });
        assert.equal(result.status, status);
        assert.deepEqual(result.body, { error });
      }
      for (const password of [true, "", "x".repeat(1025), "\ud800"])
        assert.deepEqual((await request("login", "POST", { password })).body, {
          error: "Invalid login input.",
        });
      for (const value of [
        { currentPassword: options.password, newPassword, extra: true },
        { currentPassword: options.password, newPassword: "short" },
        { currentPassword: "\ud800", newPassword },
      ])
        assert.deepEqual((await request("password", "POST", value)).body, {
          error: "Invalid password change input.",
        });
      const extra = await request(
        "login",
        "POST",
        { password: options.password, extra: true },
        { type: "APPLICATION/JSON" },
      );
      assert.equal(extra.status, 200);
    });
    await check("five failed logins commit, sixth shares bounded throttle and audit", async () => {
      await clearAttempts();
      const before = (await snapshot()).events.length;
      for (let i = 0; i < 5; i++)
        assert.equal((await request("login", "POST", { password: "wrong" })).status, 401);
      const limited = await request("login", "POST", { password: options.password });
      assert.equal(limited.status, 429);
      assert(Number(limited.headers.get("retry-after")) > 0);
      assert.equal((await attempts())[0]!.attempt_count, 5);
      assert.equal((await snapshot()).events.length, before + 5);
      // Rotation reserves in the exact same client-network bucket.
      assert.equal(
        (await request("password", "POST", { currentPassword: options.password, newPassword }))
          .status,
        429,
      );
      await clearAttempts();
    });
    await check("session devices, revoke-others, logout and secret-free audit", async () => {
      const other = await login(options.password);
      const listed = await request("sessions");
      assert.equal(listed.status, 200);
      const current = ownerSessionsResponseSchema
        .parse(listed.body)
        .sessions.filter((row: { current: boolean }) => row.current);
      assert.equal(current.length, 1);
      assert(!JSON.stringify(listed.body).includes("token_digest"));
      const revoked = await request("sessions/revoke-others", "POST");
      assert.equal(revoked.status, 200);
      assert(ownerSessionRevocationResponseSchema.parse(revoked.body).revoked >= 1);
      assert.deepEqual((await request("session", "GET", undefined, { cookie: other })).body, {
        authenticated: false,
      });
      const temporary = await login(options.password);
      const logout = await request("logout", "POST", undefined, { cookie: temporary });
      assert.equal(logout.status, 204);
      assert(logout.headers.get("set-cookie")?.includes("Max-Age=0"));
      assert.equal((await request("logout", "POST", undefined, { cookie: temporary })).status, 401);
      const events = (await snapshot()).events;
      assert(events.some((row) => row.type === "AUTH_LOGOUT"));
      assert(
        !JSON.stringify(events).includes(options.password) &&
          !JSON.stringify(events).includes(cookie.split("=")[1]!),
      );
    });
    await check("audit refusal rolls back issuance, credentials and revocations", async () => {
      const before = await snapshot();
      await sql`CREATE FUNCTION openbot_owned_auth_audit_fail() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF NEW.type IN (''AUTH_LOGIN_SUCCEEDED'',''OWNER_PASSWORD_CHANGED'',''OWNER_SESSIONS_REVOKED'',''AUTH_LOGOUT'') THEN RAISE EXCEPTION ''owned private audit failure''; END IF; RETURN NEW; END'`;
      await sql`CREATE TRIGGER openbot_owned_auth_audit_fail BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION openbot_owned_auth_audit_fail()`;
      try {
        for (const [path, body] of [
          ["login", { password: options.password }],
          ["password", { currentPassword: options.password, newPassword }],
          ["sessions/revoke-others", undefined],
          ["logout", undefined],
        ] as const) {
          const result = await request(path, "POST", body);
          assert.equal(result.status, 503);
          assert.deepEqual(result.body, { error: "Control-plane storage is unavailable." });
          assert(!result.headers.has("set-cookie"));
          assert.deepEqual(await snapshot(), before);
        }
      } finally {
        await sql`DROP TRIGGER openbot_owned_auth_audit_fail ON run_events`;
        await sql`DROP FUNCTION openbot_owned_auth_audit_fail()`;
      }
    });
    await check("four SQL admissions are bounded and lock timeout recovers", async () => {
      const held = await hold(),
        pending: ReturnType<typeof request>[] = [];
      try {
        for (let n = 1; n <= 4; n++) {
          pending.push(request("sessions"));
          await waitBlocked(n);
        }
        assert.equal((await request("sessions")).status, 503);
      } finally {
        await held.release();
      }
      for (const result of await Promise.all(pending)) assert.equal(result.status, 200);
      const locked = await hold();
      try {
        assert.equal((await request("sessions")).status, 503);
      } finally {
        await locked.release();
      }
      assert.equal((await request("sessions")).status, 200);
    });
    await check("disconnect rolls back the actual blocked login transaction", async () => {
      const before = await snapshot(),
        held = await hold(),
        abort = new AbortController();
      const pending = request(
        "login",
        "POST",
        { password: options.password },
        { signal: abort.signal },
      ).then(
        () => false,
        () => true,
      );
      try {
        await waitBlocked();
        abort.abort();
        assert(await pending);
        await delay(50);
      } finally {
        await held.release();
      }
      await delay(100);
      assert.deepEqual(await snapshot(), before);
    });
    await check("expiry behind auth lock refuses the security operation", async () => {
      const temporary = await login(options.password),
        token = temporary.split("=")[1]!;
      const tokenDigest = createHash("sha256").update(token).digest("hex");
      await sql`UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '400 milliseconds' WHERE token_digest=${tokenDigest}`;
      const held = await hold(),
        pending = request("sessions/revoke-others", "POST", undefined, { cookie: temporary });
      try {
        await waitBlocked();
        await delay(450);
      } finally {
        await held.release();
      }
      assert.equal((await pending).status, 401);
      assert(authSessionSchema.parse((await request("session")).body).authenticated);
    });
    await check(
      "TS auth works after Server restart and persisted password overrides bootstrap",
      async () => {
        await options.restart();
        try {
          cookie = await login(options.password);
          const result = await request("password", "POST", {
            currentPassword: options.password,
            newPassword,
          });
          assert.equal(result.status, 200);
          assert.deepEqual(result.body, { changed: true, reauthenticationRequired: true });
          assert(result.headers.get("set-cookie")?.includes("Max-Age=0"));
          assert.deepEqual((await request("session")).body, { authenticated: false });
          assert.equal(
            (await request("login", "POST", { password: options.password })).status,
            401,
          );
          cookie = await login(newPassword);
        } finally {
          await options.restart();
        }
      },
    );
    await check(
      "process restart preserves TS password/session; Server rotation remains readable by TS",
      async () => {
        await options.restart();
        try {
          assert(authSessionSchema.parse((await request("session")).body).authenticated);
          cookie = await login(newPassword);
          const result = await request("password", "POST", {
            currentPassword: newPassword,
            newPassword: options.password,
          });
          assert.equal(result.status, 200);
          cookie = await login(options.password);
        } finally {
          await options.restart();
        }
        assert(authSessionSchema.parse((await request("session")).body).authenticated);
        cookie = await login(options.password);
        const rows =
          await sql`SELECT password_hash,revision FROM owner_credentials WHERE owner_id='owner'`;
        assert.equal(rows[0]!.revision, 2);
        assert.match(rows[0]!.password_hash as string, /^scrypt\$32768\$8\$3\$/);
      },
    );
    await check(
      "post-KDF revision guard rejects stale issuance after another writer commits",
      async () => {
        const held = await hold();
        const pending = request("login", "POST", { password: options.password });
        void pending.catch(() => undefined);
        let committed = false;
        try {
          await waitBlocked();
          // A second authorized writer advances the persisted revision after this request's KDF.
          await held.connection`UPDATE owner_credentials SET revision=revision+1,updated_at=clock_timestamp() WHERE owner_id='owner'`;
          committed = true;
        } finally {
          await held.release(committed);
        }
        assert.equal((await pending).status, 401);
        await clearAttempts();
      },
    );
    await check(
      "concurrent password changes have one winner and revoke prior sessions",
      async () => {
        const result = await Promise.all(
          [1, 2].map(() =>
            request("password", "POST", { currentPassword: options.password, newPassword }),
          ),
        );
        assert.deepEqual(result.map((row) => row.status).sort(), [200, 401]);
        assert.deepEqual((await request("session")).body, { authenticated: false });
        cookie = await login(newPassword);
        assert.equal(
          (
            await request("password", "POST", {
              currentPassword: newPassword,
              newPassword: options.password,
            })
          ).status,
          200,
        );
        cookie = await login(options.password);
      },
    );

    return cookie;
  } finally {
    await database.close();
  }
}
