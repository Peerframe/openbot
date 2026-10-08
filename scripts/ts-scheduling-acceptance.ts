import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabase } from "@openbot/db";

export async function qualifySchedulingOwnership(options: {
  databaseUrl: string;
  origin: string;
  privateOrigin: string;
  cookie: string;
  stopPython(): Promise<void>;
  restorePython(): Promise<void>;
  reverseToPython(): Promise<void>;
  restoreTs(): Promise<void>;
  admit(scheduleId: string): Promise<void>;
}) {
  const database = createDatabase(options.databaseUrl),
    sql = database.client;
  const bot = randomUUID(),
    channel = randomUUID(),
    node = randomUUID();
  const request = async (
    path: string,
    method = "GET",
    body?: unknown,
    origin = options.origin,
    cookie = options.cookie,
  ) => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: options.origin,
        Host: new URL(options.origin).host,
        ...(origin === options.privateOrigin
          ? { Forwarded: "for=127.0.0.1" }
          : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(12000),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  let passed = 0;
  const check = async (name: string, work: () => Promise<void>) => {
    await work();
    passed++;
    console.log("scheduling-ownership: " + name);
  };
  const settings = "/api/v1/settings/approvals";
  const create = () =>
    request("/api/v1/automations", "POST", {
      name: "Synthetic scheduled work",
      channelId: channel,
      botId: bot,
      prompt: "Read synthetic facts",
      intervalMinutes: 60,
      firstRunAt: new Date(Date.now() + 3600000).toISOString(),
    });
  const approval = async () => {
    const id = randomUUID(),
      run = randomUUID();
    await sql`INSERT INTO runs(id,channel_id,bot_id,execution_profile,instruction,title,status) VALUES(${run},${channel},${bot},'none','Synthetic','Synthetic','waiting_approval')`;
    await sql`INSERT INTO approvals(id,run_id,node_id,action,target,summary,risk,target_fingerprint,before_state,expires_at) VALUES(${id},${run},${node},'fixture.write','synthetic','Synthetic','write',${"a".repeat(64)},'{}'::jsonb,now()+interval '1 hour')`;
    return { id, run, path: `/api/v1/approvals/${id}/decision` };
  };
  try {
    await sql`INSERT INTO nodes(id,name,platform,status) VALUES(${node},'Synthetic offline Host','linux','offline')`;
    await sql`INSERT INTO bots(id,name,role,computer_profile) VALUES(${bot},${"Scheduling " + bot},'Synthetic','none')`;
    await sql`INSERT INTO channels(id,name,description) VALUES(${channel},${"Scheduling " + channel},'Synthetic')`;
    await sql`INSERT INTO channel_bots(channel_id,bot_id) VALUES(${channel},${bot})`;
    await check(
      "all seven private routes refuse the second public owner",
      async () => {
        for (const [method, path] of [
          ["GET", settings],
          ["PUT", settings],
          ["POST", "/api/v1/approvals/fixture/decision"],
          ["GET", "/api/v1/automations"],
          ["POST", "/api/v1/automations"],
          ["PATCH", "/api/v1/automations/fixture"],
          ["DELETE", "/api/v1/automations/fixture"],
        ]) {
          const r = await request(
            path!,
            method,
            method === "GET" ? undefined : {},
            options.privateOrigin,
          );
          assert.equal(r.status, 503);
          assert.equal(r.body.error, "operation_owned_by_ts");
        }
      },
    );
    await check(
      "session and Origin checks precede all mutation input",
      async () => {
        assert.equal(
          (await request(settings, "PUT", {}, options.origin, "")).status,
          401,
        );
        const r = await fetch(options.origin + "/api/v1/automations", {
          method: "POST",
          headers: {
            Cookie: options.cookie,
            Origin: "https://foreign.invalid",
            "Content-Type": "application/json",
          },
          body: "broken",
        });
        assert.equal(r.status, 403);
      },
    );
    await options.stopPython();
    const original = (await request(settings)).body;
    let saved: any;
    await check(
      "policy CAS and simultaneous single-use decisions work without Python",
      async () => {
        const next = {
          expectedRevision: original.revision,
          productRead: "required",
          publicWeb: "required",
          exceptions: [],
        };
        const responses = await Promise.all([
          request(settings, "PUT", next),
          request(settings, "PUT", next),
        ]);
        assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
        saved = responses.find((r) => r.status === 200)!.body;
        const entry = await approval();
        const decisions = await Promise.all([
          request(entry.path, "POST", { decision: "approve" }),
          request(entry.path, "POST", { decision: "reject" }),
        ]);
        assert.deepEqual(decisions.map((r) => r.status).sort(), [200, 409]);
        const events =
          await sql`SELECT type FROM run_events WHERE run_id=${entry.run}`;
        assert.equal(events.length, 1);
      },
    );
    await check(
      "audit failure rolls back approval, Run and policy revision",
      async () => {
        const entry = await approval();
        await sql`ALTER TABLE run_events ADD CONSTRAINT ts_scheduling_audit CHECK (type NOT IN ('APPROVAL_APPROVED','SETTINGS_APPROVAL_UPDATED')) NOT VALID`;
        try {
          assert.equal(
            (await request(entry.path, "POST", { decision: "approve" })).status,
            503,
          );
          assert.equal(
            (
              await request(settings, "PUT", {
                expectedRevision: saved.revision,
                productRead: "inherit",
                publicWeb: "required",
                exceptions: [],
              })
            ).status,
            503,
          );
          assert.deepEqual((await request(settings)).body, saved);
          assert.equal(
            (await sql`SELECT status FROM approvals WHERE id=${entry.id}`)[0]!
              .status,
            "pending",
          );
          assert.equal(
            (await sql`SELECT status FROM runs WHERE id=${entry.run}`)[0]!
              .status,
            "waiting_approval",
          );
        } finally {
          await sql`ALTER TABLE run_events DROP CONSTRAINT ts_scheduling_audit`;
        }
      },
    );
    const schedule = await create();
    assert.equal(schedule.status, 201, JSON.stringify(schedule.body));
    const id = schedule.body.automation.id;
    await check(
      "TS schedules enter the sole retained Work admission exactly once",
      async () => {
        await options.admit(id);
        const rows =
          await sql`SELECT a.last_run_id,a.last_outcome,s.task_id,h.run_id FROM automations a JOIN work_sources s ON s.legacy_run_id=a.last_run_id JOIN work_runs w ON w.task_id=s.task_id JOIN work_admissions h ON h.run_id=w.id WHERE a.id=${id}`;
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.last_outcome, "skipped_active");
        assert.equal(
          (
            await request(`/api/v1/automations/${id}`, "PATCH", {
              enabled: false,
            })
          ).status,
          200,
        );
        await sql`UPDATE automations SET next_run_at=now()-interval '2 days' WHERE id=${id}`;
        assert.equal(
          (
            await request(`/api/v1/automations/${id}`, "PATCH", {
              enabled: true,
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await sql`SELECT next_run_at>now() AS future FROM automations WHERE id=${id}`
          )[0]!.future,
          true,
        );
      },
    );
    await options.restorePython();
    await check(
      "paired reverse preserves TS policy and admitted schedules",
      async () => {
        const before = (await request("/api/v1/automations")).body;
        await options.reverseToPython();
        assert.deepEqual((await request(settings)).body, saved);
        assert.deepEqual((await request("/api/v1/automations")).body, before);
        assert.equal(
          (
            await request(`/api/v1/automations/${id}`, "PATCH", {
              enabled: false,
            })
          ).status,
          200,
        );
        const r = await request(settings, "PUT", {
          expectedRevision: saved.revision,
          productRead: original.productRead,
          publicWeb: original.publicWeb,
          exceptions: original.exceptions,
        });
        assert.equal(r.status, 200);
        saved = r.body;
        await options.restoreTs();
        assert.deepEqual((await request(settings)).body, saved);
        assert.equal(
          (await request("/api/v1/automations")).body.automations.find(
            (a: any) => a.id === id,
          ).enabled,
          false,
        );
        assert.equal(
          (await request(`/api/v1/automations/${id}`, "DELETE", {})).status,
          200,
        );
        assert.equal(
          (
            await sql`SELECT count(*)::int AS n FROM work_sources WHERE channel_id=${channel}`
          )[0]!.n,
          1,
        );
      },
    );
    console.log(
      `Scheduling/approval ownership: ${passed} checks passed; real retained Work admission, no Worker/Temporal execution or provider calls.`,
    );
  } finally {
    await database.close();
  }
}
