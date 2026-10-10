/** Real Server scenario; synthetic rows and peers are restricted to its owned fixture. */
import { scenarioStep as check } from "./scenario-step.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabase } from "@openbot/db";
import { runProgressDetailsSchema } from "@openbot/protocol";

export async function qualifyProductReads(options: {
  databaseUrl: string;
  origin: string;
  cookie: string;
  restart(): Promise<void>;
}) {
  const database = createDatabase(options.databaseUrl),
    sql = database.client;
  const bot = randomUUID(),
    channel = randomUUID(),
    run = randomUUID();
  const request = async (path: string, cookie = options.cookie) => {
    const response = await fetch(options.origin + path, {
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(8000),
    });
    const raw = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      body: response.headers.get("content-type")?.startsWith("application/json")
        ? JSON.parse(raw.toString())
        : raw.toString(),
      next: response.headers.get("x-openbot-next-before"),
    };
  };
  const progress = `/api/v1/runs/${run}/progress`;
  const audit = "/api/v1/audit?category=runs&limit=2";
  try {
    await sql`INSERT INTO bots(id,name,role,status,computer_profile) VALUES(${bot},${"Read fixture " + bot},'Synthetic','idle','none')`;
    await sql`INSERT INTO channels(id,name,description) VALUES(${channel},${"Read fixture " + channel},'Synthetic')`;
    await sql`INSERT INTO runs(id,channel_id,bot_id,execution_profile,instruction,title,status) VALUES(${run},${channel},${bot},'none','Private run instructions','Synthetic','completed')`;
    for (let i = 1; i <= 20; i++)
      await sql`INSERT INTO run_events(id,channel_id,bot_id,run_id,type,payload,created_at) VALUES(${randomUUID()},${channel},${bot},${run},'RUN_PROGRESS',${JSON.stringify({ stage: i % 2 ? "model" : "tool", message: "Private progress text", apiKey: "Private key", sizeBytes: 1.5, name: "=unsafe" })}::jsonb,${"2039-01-01T00:00:00." + String(i).padStart(6, "0") + "Z"})`;

    await check("authorization precedes malformed queries and scoped existence", async () => {
      for (const path of ["/api/v1/audit?before=bad", progress + "?steps=0", progress])
        assert.equal((await request(path, "")).status, 401);
      for (const query of ["steps=1,1", "steps=0", "steps=1&steps=2", "extra=1"])
        assert.equal((await request(progress + "?" + query)).status, 422);
    });
    const snapshot = async () =>
      Promise.all([
        request(audit),
        request(progress),
        request(progress + "?steps=20,1,10"),
        request("/api/v1/audit/export?category=runs&limit=2"),
      ]);
    await check(
      "progress samples actual ordinals and excludes untrusted provider text",
      async () => {
        const value = await request(progress);

        assert.equal(value.status, 200, JSON.stringify(value.body));
        const page = runProgressDetailsSchema.parse(value.body);
        assert.equal(page.totalSteps, 20);
        assert.equal(page.stageName, null);
        assert.equal(page.completedSteps, null);
        assert.deepEqual(
          page.steps.map((row) => row.stepNumber),
          [1, 2, 3, 15, 16, 17, 18, 19, 20],
        );
        assert(!JSON.stringify(page).includes("Private"));
        const selected = runProgressDetailsSchema.parse(
          (await request(progress + "?steps=20,1,10")).body,
        );
        assert.deepEqual(
          selected.steps.map((row) => row.stepNumber),
          [1, 10, 20],
        );
      },
    );
    await check("audit keeps microsecond keysets and excludes private/float payloads", async () => {
      const page = await request(audit);
      assert.equal(page.status, 200);
      assert(page.body.nextBefore.includes(".000019"));
      assert(!JSON.stringify(page).includes("Private"));
      assert(!JSON.stringify(page).includes("sizeBytes"));
      const next = await request(audit + "&before=" + encodeURIComponent(page.body.nextBefore));
      assert(
        next.body.events.every(
          (event: { id: string }) =>
            !page.body.events.some((old: { id: string }) => event.id === old.id),
        ),
      );
    });
    await check("real CSV and persisted progress match paired Server reads after restart", async () => {
      const before = await snapshot();
      await options.restart();
      try {
        assert.deepEqual(await snapshot(), before);
      } finally {
        await options.restart();
      }
    });
    await check("selected audit/progress continue while the Server has restarted", async () => {
      const before = await snapshot();
      await options.restart();
      try {
        assert.deepEqual(await snapshot(), before);
      } finally {
        await options.restart();
      }
    });
    await check("tombstones refuse progress but preserve bounded audit subject names", async () => {
      await sql`UPDATE channels SET deleted_at=clock_timestamp() WHERE id=${channel}`;
      assert.equal((await request(progress)).status, 404);
      const page = await request(audit);
      assert.equal(page.status, 200);
      assert(page.body.events.every((event: { channelDeleted: boolean }) => event.channelDeleted));
    });

  } finally {
    await sql`DELETE FROM run_events WHERE channel_id=${channel}`;
    await sql`DELETE FROM runs WHERE id=${run}`;
    await sql`DELETE FROM channels WHERE id=${channel}`;
    await sql`DELETE FROM bots WHERE id=${bot}`;
    await sql.end({ timeout: 1 });
  }
}
