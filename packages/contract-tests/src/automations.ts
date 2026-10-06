import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  automationResponseSchema,
  automationsResponseSchema,
  automationDeletionSchema,
  channelResponseSchema,
  controlHttpErrorSchema,
  auditPageSchema,
} from "@openbot/protocol";
import { contractClient, type RequestOptions } from "./client.ts";
import { contractTargetSchema, type ContractTarget } from "./target.ts";

/** Future schedules exercise CRUD only; the supplied disposable target has no execution worker. */
export async function runAutomationContracts(input: ContractTarget) {
  const target = contractTargetSchema.parse(input),
    { request } = contractClient(target),
    passed: string[] = [];
  const check = async (name: string, action: () => Promise<void>) => {
    await action();
    passed.push(name);
  };
  const error = async (path: string, status: number, options: RequestOptions = {}) => {
    const result = await request(path, options);
    assert.equal(result.response.status, status);
    controlHttpErrorSchema.parse(result.body);
    return result;
  };
  const list = async () => {
    const result = await request("/api/v1/automations");
    assert.equal(result.response.status, 200);
    return automationsResponseSchema.parse(result.body).automations;
  };
  for (const [path, method] of [
    ["", "GET"],
    ["", "POST"],
    [`/${randomUUID()}`, "PATCH"],
    [`/${randomUUID()}`, "DELETE"],
  ] as const)
    await check(`schedule Owner authentication ${method}`, () =>
      error(`/api/v1/automations${path}`, 401, {
        method,
        cookie: false,
        ...(method === "GET" ? {} : { rawBody: "invalid" }),
      }).then(() => {}),
    );
  const createdChannel = await request("/api/v1/channels", {
    method: "POST",
    body: { name: `Schedules ${randomUUID()}`, botIds: [target.botId] },
  });
  assert.equal(createdChannel.response.status, 201);
  const channelId = channelResponseSchema.parse(createdChannel.body).channel.id;
  const prompt = `Synthetic private scheduled instruction ${randomUUID()}`;
  const body = {
    name: " Schedule ",
    channelId,
    botId: target.botId,
    prompt: ` ${prompt} `,
    intervalMinutes: 60,
    firstRunAt: new Date(Date.now() + 3600000).toISOString(),
  };
  const ownIds: string[] = [];
  let scheduleId = "";
  await check(
    "future schedule creation trims input and retains explicit occurrence nulls",
    async () => {
      assert.equal(
        (await list()).length,
        0,
        "Schedule contracts require an empty disposable schedule set.",
      );
      const result = await request("/api/v1/automations", {
        method: "POST",
        rawBody: JSON.stringify(body).replace('"intervalMinutes":60', '"intervalMinutes":60.0'),
      });
      assert.equal(result.response.status, 201);
      const schedule = automationResponseSchema.parse(result.body).automation;
      scheduleId = schedule.id;
      ownIds.push(scheduleId);
      assert.equal(schedule.name, "Schedule");
      assert.equal(schedule.prompt, prompt);
      assert.equal(schedule.intervalMinutes, 60);
      assert.equal(schedule.enabled, true);
      assert.equal(schedule.nextRunAt, body.firstRunAt);
      assert.equal(schedule.lastRunAt, null);
      assert.equal(schedule.lastRunId, null);
      assert.equal(schedule.lastOutcome, null);
      assert.equal((await list())[0]?.id, scheduleId);
    },
  );
  await check(
    "schedule Origin, UTF-16, UTC/range, membership and strict creation guards",
    async () => {
      await error("/api/v1/automations", 403, {
        method: "POST",
        origin: "https://foreign.invalid",
        rawBody: "invalid",
      });
      for (const changes of [
        { name: "😀".repeat(41) },
        { prompt: "\ud800" },
        { intervalMinutes: true },
        { intervalMinutes: 14 },
        { extra: true },
        { botId: randomUUID() },
        { firstRunAt: "2026-01-01T00:00Z" },
        { firstRunAt: new Date(Date.now() - 1000).toISOString() },
        { firstRunAt: new Date(Date.now() + 367 * 86400000).toISOString() },
      ])
        await error("/api/v1/automations", 422, { method: "POST", body: { ...body, ...changes } });
      assert.equal((await list()).length, 1);
    },
  );
  await check(
    "enable DTO strips extras but refuses coercion; no-op produces no audit row",
    async () => {
      for (const enabled of [1, "false", null])
        await error(`/api/v1/automations/${scheduleId}`, 422, {
          method: "PATCH",
          body: { enabled },
        });
      const paused = await request(`/api/v1/automations/${scheduleId}`, {
        method: "PATCH",
        body: { enabled: false, ignored: true },
      });
      assert.equal(paused.response.status, 200);
      const data = automationResponseSchema.parse(paused.body).automation;
      assert.equal(data.enabled, false);
      const before = auditPageSchema.parse((await request("/api/v1/audit?limit=1")).body).events[0]
        ?.id;
      const noop = await request(`/api/v1/automations/${scheduleId}`, {
        method: "PATCH",
        body: { enabled: false },
      });
      assert.equal(noop.response.status, 200);
      assert.deepEqual(automationResponseSchema.parse(noop.body).automation, data);
      assert.equal(
        auditPageSchema.parse((await request("/api/v1/audit?limit=1")).body).events[0]?.id,
        before,
      );
      const overflow = await error(`/api/v1/automations/${scheduleId}`, 413, {
        method: "PATCH",
        body: { enabled: true, ignored: "x".repeat(1025) },
      });
      assert(overflow.body);
    },
  );
  await check(
    "resume rechecks current membership and preserves the paused schedule on refusal",
    async () => {
      const removed = await request(`/api/v1/channels/${channelId}/bots/${target.botId}`, {
        method: "DELETE",
      });
      assert.equal(removed.response.status, 200);
      await error(`/api/v1/automations/${scheduleId}`, 422, {
        method: "PATCH",
        body: { enabled: true },
      });
      assert.equal((await list()).find((item) => item.id === scheduleId)?.enabled, false);
      const restored = await request(`/api/v1/channels/${channelId}/bots`, {
        method: "POST",
        body: { botId: target.botId },
      });
      assert.equal(restored.response.status, 200);
      const resumed = await request(`/api/v1/automations/${scheduleId}`, {
        method: "PATCH",
        body: { enabled: true },
      });
      assert.equal(resumed.response.status, 200);
      const schedule = automationResponseSchema.parse(resumed.body).automation;
      assert.equal(schedule.enabled, true);
      assert.equal(schedule.nextRunAt, body.firstRunAt);
      assert.equal(schedule.lastRunId, null);
    },
  );
  await check("parallel creation at the 50-schedule ceiling commits one claimant", async () => {
    for (let i = 0; i < 48; i++) {
      const result = await request("/api/v1/automations", { method: "POST", body });
      assert.equal(result.response.status, 201);
      ownIds.push(automationResponseSchema.parse(result.body).automation.id);
    }
    const results = await Promise.all([
      request("/api/v1/automations", { method: "POST", body }),
      request("/api/v1/automations", { method: "POST", body }),
    ]);
    assert.deepEqual(results.map((result) => result.response.status).sort(), [201, 422]);
    for (const result of results)
      if (result.response.status === 201)
        ownIds.push(automationResponseSchema.parse(result.body).automation.id);
      else controlHttpErrorSchema.parse(result.body);
    assert.equal((await list()).length, 50);
  });
  await check(
    "deletion removes only owned schedules while audit omits private instructions",
    async () => {
      for (const id of ownIds) {
        const result = await request(`/api/v1/automations/${id}`, { method: "DELETE" });
        assert.equal(result.response.status, 200);
        assert.deepEqual(automationDeletionSchema.parse(result.body), { deleted: true });
      }
      await error(`/api/v1/automations/${scheduleId}`, 404, { method: "DELETE" });
      await error(`/api/v1/automations/${scheduleId}`, 404, {
        method: "PATCH",
        body: { enabled: true },
      });
      assert.deepEqual(await list(), []);
      const events = auditPageSchema.parse((await request("/api/v1/audit?limit=100")).body);
      assert(!JSON.stringify(events).includes(prompt));
    },
  );
  return { count: passed.length, passed };
}
