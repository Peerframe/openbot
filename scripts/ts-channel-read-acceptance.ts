import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase } from "@openbot/db";

/** Real product reads on the contract driver's owned database; all rows below are disposable. */
export async function qualifyChannelReads(options: {
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
  const bot = randomUUID(),
    channel = randomUUID(),
    empty = randomUUID();
  const prefix = `/api/v1/channels/${channel}`;
  const paths = ["/api/v1/bots", "/api/v1/channels", `${prefix}/messages`, `${prefix}/runs`];
  let passed = 0;
  const check = async (name: string, operation: () => Promise<void>) => {
    await operation();
    passed++;
    console.log(`channel-read: ${name}`);
  };
  const request = async (
    path: string,
    cookie = options.cookie,
    signal = AbortSignal.timeout(8000),
  ) => {
    const response = await fetch(options.origin + path, {
      headers: { Cookie: cookie, Origin: options.origin },
      signal,
      redirect: "manual",
    });
    return { status: response.status, body: await response.json() };
  };
  const snapshot = async () => {
    const values = [];
    for (const path of paths) {
      const value = await request(path);
      assert.equal(value.status, 200, path);
      values.push(value);
    }
    return values;
  };
  const fixtureCookie = async () => {
    const token = randomBytes(32).toString("base64url"),
      digest = createHash("sha256").update(token).digest("hex");
    await sql`INSERT INTO auth_sessions(id,token_digest,owner_id,expires_at) VALUES (${randomUUID()},${digest},'owner',clock_timestamp()+interval '5 minutes')`;
    return { digest, cookie: options.cookie.split("=", 1)[0] + "=" + token };
  };
  const holdMessages = async () => {
    const connection = await sql.reserve();
    await connection`BEGIN`;
    await connection`LOCK TABLE messages IN ACCESS EXCLUSIVE MODE`;
    return async () => {
      try {
        await connection`ROLLBACK`;
      } finally {
        connection.release();
      }
    };
  };
  const waitBlocked = async (count: number) => {
    const until = Date.now() + 900;
    while (Date.now() < until) {
      const rows =
        await sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='openbot-ts-channel-read' AND wait_event_type='Lock'`;
      if (rows[0]!.count >= count) return;
      await delay(10);
    }
    throw new Error("Channel reads did not reach the held table.");
  };
  const cases = async () => {
    const values: unknown[] = [];
    const negatives = [
      `${prefix}/messages?limit=0`,
      `${prefix}/messages?limit=101`,
      `${prefix}/messages?limit=bad`,
      `${prefix}/messages?limit=1?ignored=1`,
      `${prefix}/messages?limit=1.0`,
      `${prefix}/messages?limit=01`,
      `${prefix}/messages?limit=1&limit=2`,
      `${prefix}/messages?other=1`,
      `${prefix}/messages?before=`,
      `${prefix}/messages?limit=3&before=${Buffer.from(JSON.stringify({ v: 1, c: channel, t: "2026-01-02T03:04:05.123004Z", i: channel + "-10" }), "utf16le").toString("base64url")}`,
      `${prefix}/messages?before=${"a".repeat(2049)}`,
      `/api/v1/channels/${"😀".repeat(129)}/messages`,
      `/api/v1/channels/missing-channel/messages`,
      `/api/v1/channels/missing-channel/runs`,
      `/api/v1/channels/${empty}/messages`,
      `/api/v1/channels/${empty}/runs`,
    ];
    for (const path of negatives) values.push({ path, ...(await request(path)) });
    for (const path of paths) {
      const value = await request(path, "");
      assert.equal(value.status, 401);
      values.push(value);
    }
    let before: string | undefined;
    const ids: string[] = [];
    do {
      const value = await request(`${prefix}/messages?limit=3${before ? "&before=" + before : ""}`);
      assert.equal(value.status, 200);
      values.push(value);
      const page = value.body as {
        messages: { id: string }[];
        hasMore: boolean;
        nextCursor?: string;
      };
      ids.push(...page.messages.map((item) => item.id));
      before = page.hasMore ? page.nextCursor : undefined;
      assert(ids.length <= 20, "Pagination cannot repeat a microsecond boundary.");
    } while (before);
    assert.equal(ids.length, 13, "Microsecond cursor must retain all pages.");
    assert.equal(new Set(ids).size, 13);
    return values;
  };
  try {
    await sql`INSERT INTO bots(id,name,role,status,computer_profile,configuration) VALUES (${bot},${"Channel-read " + bot},'Synthetic','idle','none',${JSON.stringify({ private: "not public", appearance: { head: "invalid" } })}::jsonb)`;
    for (const id of [channel, empty])
      await sql`INSERT INTO channels(id,name,description) VALUES (${id},${"Channel-read " + id},'Synthetic')`;
    await sql`INSERT INTO channel_bots(channel_id,bot_id) VALUES (${channel},${bot})`;
    for (let i = 12; i >= 0; i--)
      await sql`INSERT INTO messages(id,channel_id,author_type,content,created_at) VALUES (${channel + "-" + String(i).padStart(2, "0")},${channel},'system',${i === 12 ? "😀".repeat(160) : "Message " + i},'2026-01-02T03:04:05.123001Z'::timestamptz+${Math.floor(i / 3)}*interval '1 microsecond')`;
    for (let i = 0; i < 52; i++)
      await sql`INSERT INTO runs(id,channel_id,bot_id,execution_profile,instruction,title,status,created_at,updated_at) VALUES (${channel + "-run-" + String(i).padStart(2, "0")},${channel},${bot},'none','Synthetic instruction','Synthetic Run','completed','2026-01-02T03:04:05Z','2026-01-02T03:04:05Z')`;
    await check("four private routes quarantine while writes remain Python-owned", async () => {
      for (const path of paths) {
        const result = await fetch(options.privateOrigin + path, {
          headers: {
            Host: new URL(options.origin).host,
            Forwarded: "for=127.0.0.1",
            Cookie: options.cookie,
          },
        });
        assert.equal(result.status, 503);
        assert.deepEqual(await result.json(), { error: "operation_owned_by_ts" });
      }
    });
    await check(
      "real projections, Unicode previews and microsecond pages match Python",
      async () => {
        const current = await snapshot(),
          negative = await cases();
        assert.equal((current[3]!.body as { runs: unknown[] }).runs.length, 50);
        assert(!JSON.stringify(current).includes("not public"));
        await options.reverseToPython();
        try {
          assert.deepEqual(await snapshot(), current);
          assert.deepEqual(await cases(), negative);
        } finally {
          await options.restoreTs();
        }
      },
    );
    await check("reverse switch keeps newer Python writes and deleted-anchor cursor", async () => {
      const first = await request(`${prefix}/messages?limit=3`);
      const page = first.body as { messages: { id: string }[]; nextCursor: string };
      await options.reverseToPython();
      let newer: Awaited<ReturnType<typeof snapshot>>, older: Awaited<ReturnType<typeof request>>;
      try {
        await sql`UPDATE bots SET role='Changed during reverse' WHERE id=${bot}`;
        await sql`UPDATE channels SET description='Newer shared fact' WHERE id=${channel}`;
        await sql`DELETE FROM messages WHERE id=${page.messages[0]!.id}`;
        await sql`INSERT INTO messages(id,channel_id,author_type,content) VALUES (${channel + "-new"},${channel},'system','Newer fact')`;
        newer = await snapshot();
        older = await request(`${prefix}/messages?limit=3&before=${page.nextCursor}`);
      } finally {
        await options.restoreTs();
      }
      assert.deepEqual(await snapshot(), newer!);
      assert.deepEqual(
        await request(`${prefix}/messages?limit=3&before=${page.nextCursor}`),
        older!,
      );
    });
    await check(
      "malformed projections and SQL/final byte ceilings fail without mutation",
      async () => {
        const capture = async () => {
          const values = [];
          await sql`UPDATE bots SET configuration=${JSON.stringify({ model: { invalid: true } })}::jsonb WHERE id=${bot}`;
          try {
            values.push(await request(paths[0]!));
          } finally {
            await sql`UPDATE bots SET configuration='{}'::jsonb WHERE id=${bot}`;
          }
          await sql`UPDATE messages SET content=repeat('x',4194305) WHERE id=${channel + "-new"}`;
          try {
            values.push(await request(paths[2]!));
          } finally {
            await sql`UPDATE messages SET content='Newer fact' WHERE id=${channel + "-new"}`;
          }
          await sql`UPDATE runs SET instruction=repeat('x',4194305) WHERE id=${channel + "-run-51"}`;
          try {
            values.push(await request(paths[3]!));
          } finally {
            await sql`UPDATE runs SET instruction='Synthetic instruction' WHERE id=${channel + "-run-51"}`;
          }
          // Individual SQL text fits; JSON escaping crosses the final serialized response ceiling.
          await sql`UPDATE messages SET content=repeat(chr(1),710000) WHERE id=${channel + "-new"}`;
          try {
            values.push(await request(paths[2]!));
          } finally {
            await sql`UPDATE messages SET content='Newer fact' WHERE id=${channel + "-new"}`;
          }
          for (const value of values) assert.equal(value.status, 503);
          return values;
        };
        const current = await capture();
        await options.reverseToPython();
        try {
          assert.deepEqual(await capture(), current);
        } finally {
          await options.restoreTs();
        }
      },
    );
    for (const expired of [false, true])
      await check(
        expired
          ? "expiry during blocked projection discards data"
          : "revocation during blocked projection discards data",
        async () => {
          const auth = await fixtureCookie(),
            release = await holdMessages();
          let pending: Promise<Awaited<ReturnType<typeof request>>> | undefined;
          try {
            pending = request(paths[2]!, auth.cookie);
            await waitBlocked(1);
            if (expired)
              await sql`UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_digest=${auth.digest}`;
            else
              await sql`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE token_digest=${auth.digest}`;
          } finally {
            await release();
          }
          assert.deepEqual(await pending, {
            status: 401,
            body: { error: "Authentication required." },
          });
        },
      );
    await check(
      "bounded SQL admission and aborted-reader slots survive until cleanup",
      async () => {
        const release = await holdMessages(),
          abort = new AbortController();
        let pending: Promise<unknown>[] = [];
        try {
          pending = Array.from({ length: 4 }, () =>
            request(paths[2]!, options.cookie, abort.signal).catch((error) => error),
          );
          await waitBlocked(4);
          abort.abort();
          await Promise.all(pending);
          assert.equal((await request(paths[0]!)).status, 503);
        } finally {
          await release();
        }
        const until = Date.now() + 3000;
        while (true) {
          const result = await request(paths[0]!);
          if (result.status === 200) break;
          assert(Date.now() < until);
          await delay(20);
        }
      },
    );
    await check("lock timeout is bounded and sanitized without a retry", async () => {
      const release = await holdMessages(),
        start = Date.now();
      try {
        assert.deepEqual(await request(paths[2]!), {
          status: 503,
          body: { error: "Control-plane storage is unavailable." },
        });
        assert(Date.now() - start < 4000);
      } finally {
        await release();
      }
    });
    await check("selected reads remain available with private Python stopped", async () => {
      const current = await snapshot();
      await options.stopPython();
      try {
        assert.deepEqual(await snapshot(), current);
      } finally {
        await options.restorePython();
      }
    });
    console.log(`Channel read acceptance passed (${passed} checks).`);
  } finally {
    await sql.end({ timeout: 1 });
  }
}
