import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { workspacePrimaryBotSchema, workspaceSnapshotSchema } from "@openbot/protocol";
import { createDatabase } from "@openbot/db";

/** Only the driver-owned PostgreSQL/processes; no configured database or live provider. */
export async function qualifyPrimaryBotWrite(options: {
  databaseUrl: string;
  origin: string;
  privateOrigin: string;
  cookie: string;
  stopPython(): Promise<void>;
  restorePython(): Promise<void>;
  reverseToPython(): Promise<void>;
  restoreTs(): Promise<void>;
}) {
  const database = createDatabase(options.databaseUrl);
  const sql = database.client;
  const path = "/api/v1/workspace/primary-bot";
  const cookieName = options.cookie.split("=", 1)[0]!;
  let passed = 0;
  const check = async (name: string, run: () => Promise<void>) => {
    await run();
    passed++;
    console.log(`primary-bot: ${name}`);
  };
  const request = async (
    value: unknown,
    overrides: {
      cookie?: string;
      origin?: string;
      raw?: string | Uint8Array;
      type?: string;
      target?: string;
      signal?: AbortSignal;
    } = {},
  ) => {
    const response = await fetch(options.origin + (overrides.target ?? path), {
      method: "PUT",
      headers: {
        Cookie: overrides.cookie ?? options.cookie,
        Origin: overrides.origin ?? options.origin,
        "Content-Type": overrides.type ?? "application/json",
      },
      body: overrides.raw ?? JSON.stringify(value),
      redirect: "manual",
      signal: overrides.signal ?? AbortSignal.timeout(8000),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const state = async () => {
    const rows =
      await sql`SELECT primary_bot_id AS "primaryBotId",revision FROM workspace_settings WHERE workspace_id='workspace'`;
    return workspacePrimaryBotSchema.parse(rows[0]);
  };
  const audits = async () => {
    const rows =
      await sql`SELECT id,payload FROM run_events WHERE type='SETTINGS_PRIMARY_BOT_UPDATED' ORDER BY created_at,id`;
    return rows;
  };
  const unchanged = async (before: unknown, events: unknown) => {
    assert.deepEqual(await state(), before);
    assert.deepEqual(await audits(), events);
  };
  const session = async () => {
    const token = randomBytes(32).toString("base64url"),
      digest = createHash("sha256").update(token).digest("hex");
    await sql`INSERT INTO auth_sessions(id,owner_id,token_digest,expires_at,created_at)
      VALUES(${randomUUID()},'owner',${digest},clock_timestamp()+interval '1 hour',clock_timestamp())`;
    return { token, digest, cookie: `${cookieName}=${token}` };
  };
  const bot = async (deleted = false): Promise<string> => {
    const id = randomUUID();
    await sql`INSERT INTO bots(id,name,role,computer_profile,deleted_at) VALUES(${id},${`Primary fixture ${id}`},'assistant','none',${deleted ? new Date().toISOString() : null})`;
    return id;
  };
  const hold = async () => {
    const db = await sql.reserve();
    await db`BEGIN`;
    await db`SELECT revision FROM workspace_settings WHERE workspace_id='workspace' FOR UPDATE`;
    return {
      async release() {
        try {
          await db`ROLLBACK`;
        } finally {
          db.release();
        }
      },
    };
  };
  const waitBlocked = async (count = 1) => {
    const until = Date.now() + 900;
    while (Date.now() < until) {
      const rows =
        await sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='openbot-ts-primary-bot-write' AND wait_event_type='Lock' AND query LIKE '%workspace_settings%'`;
      if (rows[0]!.count >= count) return;
      await delay(10);
    }
    throw new Error("Owned primary Bot mutation did not reach its workspace row lock.");
  };
  const first = await bot(),
    second = await bot(),
    deleted = await bot(true);
  try {
    await check("Origin precedes token/body and no other credentials grant authority", async () => {
      const before = await state(),
        events = await audits();
      for (const origin of ["", "null", "https://other.example.test"])
        assert.deepEqual((await request({}, { origin, cookie: "", raw: "invalid" })).body, {
          error: "Request origin is not allowed.",
        });
      for (const cookie of ["", `${cookieName}=bad`, `${cookieName}=${"z".repeat(43)}`]) {
        const response = await request({}, { cookie, raw: "invalid" });
        assert.equal(response.status, 401);
        assert.deepEqual(response.body, { error: "Authentication required." });
      }
      const bearer = await fetch(options.origin + path, {
        method: "PUT",
        headers: {
          Origin: options.origin,
          Authorization: `Bearer ${options.cookie.split("=")[1]}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      assert.equal(bearer.status, 401);
      await bearer.arrayBuffer();
      await unchanged(before, events);
    });
    await check("strict input and byte/UTF8/JSON bounds preserve failure envelopes", async () => {
      const before = await state(),
        events = await audits();
      for (const body of [
        null,
        {},
        { botId: first, expectedRevision: true },
        { botId: first, expectedRevision: before.revision, permissions: ["all"] },
        { botId: "", expectedRevision: before.revision },
      ])
        assert.deepEqual((await request(body)).body, { error: "Invalid request input." });
      for (const [raw, status, error] of [
        [" ".repeat(1025), 413, "Request is too large."],
        ['{"x":NaN}', 422, "Invalid JSON input."],
        [new Uint8Array([0xc0, 0xaf]), 422, "Invalid JSON input."],
      ] as const) {
        const response = await request({}, { raw });
        assert.equal(response.status, status);
        assert.deepEqual(response.body, { error });
      }
      assert.deepEqual((await request({}, { type: "text/plain" })).body, {
        error: "Invalid request input.",
      });
      assert.deepEqual((await request({}, { type: "application/jsonish" })).body, {
        error: "Request requires JSON.",
      });
      await unchanged(before, events);
    });
    await check(
      "unknown/deleted/code-point bounded Bot references fail without effects",
      async () => {
        const before = await state(),
          events = await audits();
        for (const botId of [randomUUID(), deleted, "🧪".repeat(128)]) {
          const response = await request({ botId, expectedRevision: before.revision });
          assert.equal(response.status, 404);
          assert.deepEqual(response.body, { error: "bot_not_found" });
        }
        assert.equal(
          (await request({ botId: "🧪".repeat(129), expectedRevision: before.revision })).status,
          422,
        );
        for (const botId of ["\ud800", "\u0000"]) {
          const response = await request({ botId, expectedRevision: before.revision });
          assert.equal(response.status, 503);
          assert.deepEqual(response.body, { error: "Control-plane storage is unavailable." });
        }
        await unchanged(before, events);
      },
    );
    await check(
      "CAS/no-op/null commit exactly matching audit and Python workspace projection",
      async () => {
        const prior = await state(),
          events = await audits();
        const selected = await request(
          { botId: first, expectedRevision: prior.revision },
          {
            target: "/api/v1/workspace/primary-%62ot?retained=ignored",
            origin: "https://secondary.example.test",
          },
        );
        assert.equal(selected.status, 200);
        assert.equal(
          selected.headers.get("access-control-allow-origin"),
          "https://secondary.example.test",
        );
        assert.deepEqual(selected.body, { primaryBotId: first, revision: prior.revision + 1 });
        const expected = {
          actor: "owner",
          previousBotId: prior.primaryBotId,
          primaryBotId: first,
          revision: prior.revision + 1,
          reason: "selected",
        };
        assert.deepEqual(
          (await audits())
            .filter((row) => !events.some((event) => event.id === row.id))
            .map((row) => row.payload),
          [expected],
        );
        const after = await audits();
        const stale = await request({ botId: null, expectedRevision: prior.revision });
        assert.equal(stale.status, 409);
        assert.deepEqual(stale.body, { error: "workspace_revision_conflict" });
        assert.deepEqual(
          (await request({ botId: first, expectedRevision: prior.revision + 1 })).body,
          selected.body,
        );
        assert.deepEqual(await audits(), after);
        const workspace = await fetch(options.origin + "/api/v1/workspace", {
          headers: { Cookie: options.cookie },
        });
        assert.equal(workspace.status, 200);
        const snapshot = workspaceSnapshotSchema.parse(await workspace.json());
        assert.equal(snapshot.primaryBotId, first);
        assert.equal(snapshot.revision, prior.revision + 1);
        const audit = await fetch(options.origin + "/api/v1/audit?category=settings", {
          headers: { Cookie: options.cookie },
        });
        assert.equal(audit.status, 200);
        const publicAudit = (await audit.json()) as {
          events: { type: string; details: { primaryBotId?: string } }[];
        };
        assert(
          publicAudit.events.some(
            (e: { type: string; details: { primaryBotId?: string } }) =>
              e.type === "SETTINGS_PRIMARY_BOT_UPDATED" && e.details.primaryBotId === first,
          ),
        );
        const cleared = await request({ botId: null, expectedRevision: prior.revision + 1 });
        assert.equal(cleared.status, 200);
        assert.deepEqual(cleared.body, { primaryBotId: null, revision: prior.revision + 2 });
      },
    );
    await check(
      "independent concurrent TS writers have one revision winner and one audit",
      async () => {
        const prior = await state(),
          events = await audits();
        const results = await Promise.all(
          [first, second].map((botId) => request({ botId, expectedRevision: prior.revision })),
        );
        assert.deepEqual(results.map((value) => value.status).sort(), [200, 409]);
        const after = await state();
        assert.equal(after.revision, prior.revision + 1);
        assert([first, second].includes(after.primaryBotId!));
        assert.equal((await audits()).length, events.length + 1);
      },
    );
    await check("Python deletion and TS selection share workspace-first locking", async () => {
      const id = await bot(),
        prior = await state();
      const [selected, response] = await Promise.all([
        request({ botId: id, expectedRevision: prior.revision }),
        fetch(options.origin + `/api/v1/bots/${id}`, {
          method: "DELETE",
          headers: { Cookie: options.cookie, Origin: options.origin },
        }),
      ]);
      assert.equal(response.status, 200);
      await response.arrayBuffer();
      assert([200, 404, 409].includes(selected.status));
      assert.notEqual((await state()).primaryBotId, id);
      const rows = await sql`SELECT deleted_at FROM bots WHERE id=${id}`;
      assert(rows[0]!.deleted_at);
    });
    await check("expired/revoked sessions refuse before invalid body", async () => {
      const before = await state(),
        events = await audits();
      for (const kind of ["expired", "revoked"]) {
        const owner = await session();
        if (kind === "expired")
          await sql`UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_digest=${owner.digest}`;
        else
          await sql`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE token_digest=${owner.digest}`;
        assert.equal((await request({}, { cookie: owner.cookie, raw: "invalid" })).status, 401);
      }
      await unchanged(before, events);
    });
    await check("expiry while blocked rolls back the candidate update and audit", async () => {
      const owner = await session(),
        prior = await state(),
        events = await audits();
      await sql`UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE token_digest=${owner.digest}`;
      const held = await hold();
      const pending = request(
        { botId: first, expectedRevision: prior.revision },
        { cookie: owner.cookie },
      );
      try {
        await waitBlocked();
        await delay(550);
      } finally {
        await held.release();
      }
      assert.equal((await pending).status, 401);
      await unchanged(prior, events);
    });
    await check("SHARE blocks revocation until mutation settles, then prevents reuse", async () => {
      const owner = await session(),
        prior = await state();
      const target = prior.primaryBotId === first ? second : first;
      const held = await hold();
      const pending = request(
        { botId: target, expectedRevision: prior.revision },
        { cookie: owner.cookie },
      );
      let revocation: Promise<unknown> | undefined,
        done = false;
      try {
        await waitBlocked();
        revocation =
          sql`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE token_digest=${owner.digest}`.then(
            () => {
              done = true;
            },
          );
        await delay(60);
        assert.equal(done, false);
      } finally {
        await held.release();
      }
      assert.equal((await pending).status, 200);
      await revocation;
      assert(done);
      assert.equal(
        (
          await request(
            { botId: null, expectedRevision: prior.revision + 1 },
            { cookie: owner.cookie },
          )
        ).status,
        401,
      );
    });
    await check(
      "four admitted writes bound SQL pressure and recover after lock refusal",
      async () => {
        const prior = await state(),
          events = await audits(),
          held = await hold();
        const pending: ReturnType<typeof request>[] = [];
        try {
          for (let count = 1; count <= 4; count++) {
            pending.push(
              request({
                botId: prior.primaryBotId === first ? second : first,
                expectedRevision: prior.revision,
              }),
            );
            await waitBlocked(count);
          }
          const refused = await request({ botId: null, expectedRevision: prior.revision });
          assert.equal(refused.status, 503);
          assert.deepEqual(refused.body, { error: "Control-plane storage is unavailable." });
        } finally {
          await held.release();
        }
        const outcomes = await Promise.all(pending);
        assert.deepEqual(outcomes.map((value) => value.status).sort(), [200, 409, 409, 409]);
        assert.equal((await audits()).length, events.length + 1);
        const current = await state();
        const locked = await hold();
        try {
          const response = await request({ botId: null, expectedRevision: current.revision });
          assert.equal(response.status, 503);
          assert.deepEqual(response.body, { error: "Control-plane storage is unavailable." });
        } finally {
          await locked.release();
        }
        assert.deepEqual(await state(), current);
        assert.equal(
          (await request({ botId: current.primaryBotId, expectedRevision: current.revision }))
            .status,
          200,
        );
      },
    );
    await check("audit storage failure rolls back preference and hides SQL errors", async () => {
      const prior = await state(),
        events = await audits();
      await sql`CREATE FUNCTION openbot_owned_primary_audit_fail() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF NEW.type = ''SETTINGS_PRIMARY_BOT_UPDATED'' THEN RAISE EXCEPTION ''owned private failure''; END IF; RETURN NEW; END'`;
      await sql`CREATE TRIGGER openbot_owned_primary_audit_fail BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION openbot_owned_primary_audit_fail()`;
      try {
        const response = await request({
          botId: prior.primaryBotId === first ? second : first,
          expectedRevision: prior.revision,
        });
        assert.equal(response.status, 503);
        assert.deepEqual(response.body, { error: "Control-plane storage is unavailable." });
        await unchanged(prior, events);
      } finally {
        await sql`DROP TRIGGER openbot_owned_primary_audit_fail ON run_events`;
        await sql`DROP FUNCTION openbot_owned_primary_audit_fail()`;
      }
    });
    await check("final expiry check rolls back an already staged update/audit", async () => {
      const owner = await session(),
        prior = await state(),
        events = await audits();
      await sql`CREATE FUNCTION openbot_owned_primary_audit_wait() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF NEW.type = ''SETTINGS_PRIMARY_BOT_UPDATED'' THEN PERFORM pg_sleep(0.5); END IF; RETURN NEW; END'`;
      await sql`CREATE TRIGGER openbot_owned_primary_audit_wait BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION openbot_owned_primary_audit_wait()`;
      try {
        await sql`UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE token_digest=${owner.digest}`;
        const response = await request(
          {
            botId: prior.primaryBotId === first ? second : first,
            expectedRevision: prior.revision,
          },
          { cookie: owner.cookie },
        );
        assert.equal(response.status, 401);
        await unchanged(prior, events);
      } finally {
        await sql`DROP TRIGGER openbot_owned_primary_audit_wait ON run_events`;
        await sql`DROP FUNCTION openbot_owned_primary_audit_wait()`;
      }
    });
    await check(
      "client abort releases actual blocked SQL and prevents partial mutation",
      async () => {
        const prior = await state(),
          events = await audits(),
          held = await hold(),
          abort = new AbortController();
        const pending = request(
          {
            botId: prior.primaryBotId === first ? second : first,
            expectedRevision: prior.revision,
          },
          { signal: abort.signal },
        ).then(
          () => false,
          () => true,
        );
        try {
          await waitBlocked();
          abort.abort();
          assert(await pending);
          await delay(60);
        } finally {
          await held.release();
        }
        let released = false;
        const until = Date.now() + 2000;
        while (Date.now() < until) {
          const rows =
            await sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='openbot-ts-primary-bot-write' AND state<>'idle'`;
          if (rows[0]!.count === 0) {
            released = true;
            break;
          }
          await delay(20);
        }
        await unchanged(prior, events);
        assert.equal(
          (await request({ botId: prior.primaryBotId, expectedRevision: prior.revision })).status,
          200,
        );
      },
    );
    await check("missing preference/exhausted revision refuse without initialization", async () => {
      const prior = await state(),
        events = await audits();
      await sql`DELETE FROM workspace_settings WHERE workspace_id='workspace'`;
      try {
        const response = await request({ botId: null, expectedRevision: prior.revision });
        assert.equal(response.status, 503);
        assert.deepEqual(response.body, { error: "workspace_settings_unavailable" });
      } finally {
        await sql`INSERT INTO workspace_settings(workspace_id,primary_bot_id,revision) VALUES('workspace',${prior.primaryBotId},${prior.revision})`;
      }
      await sql`UPDATE workspace_settings SET revision=2147483647 WHERE workspace_id='workspace'`;
      try {
        const response = await request({
          botId: prior.primaryBotId === first ? second : first,
          expectedRevision: 2147483647,
        });
        assert.equal(response.status, 409);
        assert.deepEqual(response.body, { error: "workspace_revision_exhausted" });
      } finally {
        await sql`UPDATE workspace_settings SET revision=${prior.revision} WHERE workspace_id='workspace'`;
      }
      await unchanged(prior, events);
    });
    await check("private Python manual PUT is quarantined with no second audit", async () => {
      const prior = await state(),
        events = await audits();
      const response = await fetch(options.privateOrigin + path, {
        method: "PUT",
        headers: {
          Host: new URL(options.origin).host,
          Forwarded: "for=127.0.0.1",
          Origin: options.origin,
          Cookie: options.cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ botId: null, expectedRevision: prior.revision }),
      });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "operation_owned_by_ts" });
      await unchanged(prior, events);
    });
    await check("selected TS PUT works while owned Python is stopped", async () => {
      const prior = await state();
      await options.stopPython();
      try {
        const response = await request({
          botId: prior.primaryBotId === first ? second : first,
          expectedRevision: prior.revision,
        });
        assert.equal(response.status, 200);
        assert.equal((await state()).revision, prior.revision + 1);
      } finally {
        await options.restorePython();
      }
    });
    await check("paired reverse/reselection preserves newer facts and issued cookie", async () => {
      const prior = await state();
      await options.reverseToPython();
      try {
        const response = await request({ botId: null, expectedRevision: prior.revision });
        assert.equal(response.status, 200);
        assert.deepEqual(await state(), { primaryBotId: null, revision: prior.revision + 1 });
      } finally {
        await options.restoreTs();
      }
      const restored = await state();
      const response = await request({ botId: first, expectedRevision: restored.revision });
      assert.equal(response.status, 200);
      assert.equal((await state()).revision, restored.revision + 1);
    });
    console.log(`TS primary Bot write qualification: ${passed} passed (real HTTP/PostgreSQL).`);
  } finally {
    await database.close();
  }
}
