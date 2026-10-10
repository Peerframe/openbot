/** Real Server scenario; synthetic rows and peers are restricted to its owned fixture. */
import { scenarioStep as check } from "./scenario-step.ts";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase } from "@openbot/db";
import { channelResponseSchema, channelsResponseSchema } from "@openbot/protocol";
const identityRoutes = [
  ["POST", "/api/v1/channels"],
  ["POST", "/api/v1/bots/{bot_id}/conversation"],
  ["POST", "/api/v1/channels/{channel_id}/bots"],
  ["PATCH", "/api/v1/bots/{bot_id}/profile"],
  ["PATCH", "/api/v1/bots/{bot_id}/appearance"],
  ["PATCH", "/api/v1/bots/{bot_id}"],
  ["PATCH", "/api/v1/channels/{channel_id}"],
  ["POST", "/api/v1/channels/{channel_id}/read"],
  ["GET", "/api/v1/channels/unread"],
  ["GET", "/api/v1/channels/{channel_id}/reactions"],
  ["PUT", "/api/v1/channels/{channel_id}/messages/{message_id}/reactions"],
].map(([method, path]) => ({ method: method!, path: path! }));

export async function qualifyProductIdentity(options: {
  databaseUrl: string;
  origin: string;
  cookie: string;
  restart(): Promise<void>;
}) {
  const database = createDatabase(options.databaseUrl),
    sql = database.client;
  const bot = randomUUID(),
    channel = randomUUID(),
    message = randomUUID();
  const botPath = `/api/v1/bots/${bot}`,
    channelPath = `/api/v1/channels/${channel}`;
  const call = async (
    path: string,
    method = "GET",
    body?: unknown,
    cookie = options.cookie,
    signal = AbortSignal.timeout(8000),
  ) => {
    const response = await fetch(options.origin + path, {
      method,
      headers: {
        Origin: options.origin,
        Cookie: cookie,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal,
      redirect: "manual",
    });
    return { status: response.status, body: await response.json() };
  };
  const events = async (type: string) =>
    await sql`SELECT id,payload FROM run_events WHERE type=${type} AND (bot_id=${bot} OR channel_id=${channel}) ORDER BY id`;
  const fixture = async (seconds = 120) => {
    const token = randomBytes(32).toString("base64url"),
      hash = createHash("sha256").update(token).digest("hex");
    await sql`INSERT INTO auth_sessions(id,token_digest,owner_id,expires_at) VALUES(${randomUUID()},${hash},'owner',clock_timestamp()+${seconds}*interval '1 second')`;
    return { hash, cookie: options.cookie.split("=", 1)[0] + "=" + token };
  };
  try {
    await sql`INSERT INTO bots(id,name,role,status,computer_profile) VALUES(${bot},${"Product " + bot},'Initial role','idle','none')`;
    await sql`INSERT INTO channels(id,name,description) VALUES(${channel},${"Product " + channel},'')`;
    await sql`INSERT INTO messages(id,channel_id,author_type,content) VALUES(${message},${channel},'system','Synthetic identity fixture')`;

    await check(
      "Origin, session, invalid bodies and malformed paths retain their precedence",
      async () => {
        const denied = await fetch(options.origin + botPath, {
          method: "PATCH",
          headers: { Cookie: options.cookie, "Content-Type": "application/json" },
          body: "{",
        });
        assert.equal(denied.status, 403);
        await denied.arrayBuffer();
        assert.equal((await call(botPath, "PATCH", {}, "")).status, 401);
        assert.equal((await call(botPath, "PATCH", { name: "" })).status, 422);
        assert.equal(
          (
            await call(botPath + "/profile", "PATCH", {
              role: "x",
              description: "",
              expectedRevision: 1,
              unknown: 1,
            })
          ).status,
          422,
        );
        assert.equal(
          (await call("/api/v1/bots/" + "x".repeat(129) + "/profile", "PATCH", {}, "")).status,
          422,
        );
        assert.equal((await call("/api/v1/bots/" + "x".repeat(129), "PATCH", {}, "")).status, 401);
      },
    );
    await check(
      "group creation, direct singleton and member join preserve idempotence and audit",
      async () => {
        const created = await call("/api/v1/channels", "POST", {
          name: "😀".repeat(80),
          botIds: [bot, bot],
          unknown: true,
        });
        assert.equal(created.status, 201);
        assert.deepEqual(channelResponseSchema.parse(created.body).channel.botIds, [bot]);
        assert.equal((await call(channelPath + "/bots", "POST", { botId: bot })).status, 200);
        assert.equal((await call(channelPath + "/bots", "POST", { botId: bot })).status, 200);
        assert.equal(
          (await events("BOT_JOINED_CHANNEL")).filter(
            (e) => e.payload && Object.keys(e.payload).length === 0,
          ).length,
          2,
        );
        const opened = await call(botPath + "/conversation", "POST");
        assert.equal(opened.status, 200);
        assert.deepEqual(channelResponseSchema.parse(opened.body).channel.botIds, [bot]);
        assert.deepEqual(await call(botPath + "/conversation", "POST"), opened);
        assert.equal(
          (
            await call(
              `/api/v1/channels/${channelResponseSchema.parse(opened.body).channel.id}/bots`,
              "POST",
              { botId: bot },
            )
          ).status,
          422,
        );
        const renamed = await call(botPath, "PATCH", { name: "Renamed " + bot });
        assert.equal(renamed.status, 200);
        assert.equal(
          channelResponseSchema.parse((await call(botPath + "/conversation", "POST")).body).channel
            .name,
          "Renamed " + bot,
        );
      },
    );
    await check("concurrent profile CAS has one winner, one evolution and one audit", async () => {
      const results = await Promise.all(
        ["First", "Second"].map((role) =>
          call(botPath + "/profile", "PATCH", {
            role,
            description: "Qualified",
            expectedRevision: 1,
          }),
        ),
      );
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
      assert.equal((await events("EMPLOYEE_PROFILE_UPDATED")).length, 1);
      const [row] = await sql`SELECT profile_revision FROM bots WHERE id=${bot}`;
      assert.equal(row!.profile_revision, 2);
      assert.equal(
        (await sql`SELECT id FROM employee_evolution_events WHERE bot_id=${bot}`).length,
        1,
      );
    });
    await check("reaction upsert and clear emit only one audit per actual change", async () => {
      const path = channelPath + `/messages/${message}/reactions`;
      for (let n = 0; n < 2; n++)
        assert.equal((await call(path, "PUT", { emoji: "👍", active: true })).status, 200);
      assert.equal((await events("MESSAGE_REACTION_CHANGED")).length, 1);
      assert.deepEqual((await call(channelPath + "/reactions")).body, {
        reactions: [{ messageId: message, emoji: "👍", actor: "owner" }],
      });
      assert.equal((await call(path, "PUT", { emoji: "👍", active: false })).status, 200);
      assert.equal((await events("MESSAGE_REACTION_CHANGED")).length, 2);
    });
    await check("audit failure rolls back both identity and invalidation", async () => {
      const before = await sql`SELECT name FROM channels WHERE id=${channel}`;
      await sql`CREATE FUNCTION openbot_p3_identity_fail() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF NEW.type = ''CHANNEL_RENAMED'' THEN RAISE EXCEPTION ''synthetic audit refusal''; END IF; RETURN NEW; END'`;
      await sql`CREATE TRIGGER openbot_p3_identity_fail BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION openbot_p3_identity_fail()`;
      try {
        assert.deepEqual(await call(channelPath, "PATCH", { name: "Must roll back" }), {
          status: 503,
          body: { error: "identity_lifecycle_unavailable" },
        });
        assert.deepEqual(await sql`SELECT name FROM channels WHERE id=${channel}`, before);
      } finally {
        await sql`DROP TRIGGER openbot_p3_identity_fail ON run_events`;
        await sql`DROP FUNCTION openbot_p3_identity_fail()`;
      }
    });
    await check("final authority expiry rolls back a staged mutation and audit", async () => {
      const before = await sql`SELECT name FROM channels WHERE id=${channel}`,
        audit = await events("CHANNEL_RENAMED");
      await sql`CREATE FUNCTION openbot_p3_identity_wait() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF NEW.type = ''CHANNEL_RENAMED'' THEN PERFORM pg_sleep(0.5); END IF; RETURN NEW; END'`;
      await sql`CREATE TRIGGER openbot_p3_identity_wait BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION openbot_p3_identity_wait()`;
      try {
        const session = await fixture(0.3);
        assert.equal(
          (await call(channelPath, "PATCH", { name: "Expired mutation" }, session.cookie)).status,
          401,
        );
        assert.deepEqual(await sql`SELECT name FROM channels WHERE id=${channel}`, before);
        assert.deepEqual(await events("CHANNEL_RENAMED"), audit);
      } finally {
        await sql`DROP TRIGGER openbot_p3_identity_wait ON run_events`;
        await sql`DROP FUNCTION openbot_p3_identity_wait()`;
      }
    });
    await check("revocation waits for admitted mutation, then refuses reuse", async () => {
      const session = await fixture(),
        reserved = await sql.reserve();
      await reserved`BEGIN`;
      await reserved`SELECT id FROM channels WHERE id=${channel} FOR UPDATE`;
      const update = call(channelPath, "PATCH", { name: "Admitted " + channel }, session.cookie);
      try {
        const until = Date.now() + 800;
        let blocked = false;
        while (Date.now() < until) {
          const rows =
            await sql`SELECT 1 FROM pg_stat_activity WHERE application_name='openbot-transactions' AND wait_event_type='Lock'`;
          if (rows.length) {
            blocked = true;
            break;
          }
          await delay(10);
        }
        assert(blocked);
        let revoked = false;
        const revoke =
          sql`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE token_digest=${session.hash}`.then(
            () => {
              revoked = true;
            },
          );
        await delay(80);
        assert.equal(revoked, false);
        await reserved`ROLLBACK`;
        assert.equal((await update).status, 200);
        await revoke;
        assert.equal(
          (await call(channelPath, "PATCH", { name: "Revoked mutation" }, session.cookie)).status,
          401,
        );
      } finally {
        await reserved`ROLLBACK`;
        reserved.release();
      }
    });
    await check("selected writes and reads remain available with a restarted Server", async () => {
      await options.restart();
      try {
        assert.equal(
          (await call(channelPath, "PATCH", { name: "TS offline " + channel })).status,
          200,
        );
        assert.equal((await call(channelPath + "/read", "POST")).status, 200);
        assert.equal((await call("/api/v1/channels/unread")).status, 200);
      } finally {
        await options.restart();
      }
    });
    await check(
      "Server restarting preserves newer facts, sessions and subsequent committed writes",
      async () => {
        const before = await call(botPath + "/conversation", "POST");
        await options.restart();
        try {
          assert.deepEqual(await call(botPath + "/conversation", "POST"), before);
          assert.equal(
            (await call(channelPath, "PATCH", { name: "Server restart " + channel })).status,
            200,
          );
        } finally {
          await options.restart();
        }
        const row = channelsResponseSchema
          .parse((await call("/api/v1/channels")).body)
          .channels.find((c: { id: string }) => c.id === channel);
        assert(row);
        assert.equal(row.name, "Server restart " + channel);
      },
    );

  } finally {
    await database.close();
  }
}
