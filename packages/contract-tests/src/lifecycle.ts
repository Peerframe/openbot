import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  approvalDecisionResponseSchema,
  approvalSettingsSchema,
  auditPageSchema,
  botResponseSchema,
  botsResponseSchema,
  cancelledRunResponseSchema,
  channelReadResponseSchema,
  channelResponseSchema,
  channelsResponseSchema,
  controlHttpErrorSchema,
  deletedBotResponseSchema,
  deletedChannelResponseSchema,
  healthResponseSchema,
  reactionMutationResponseSchema,
  reactionsResponseSchema,
  removeChannelMemberResponseSchema,
  renamedBotResponseSchema,
  renamedChannelResponseSchema,
  runsResponseSchema,
  steeringResponseSchema,
  submitTaskResponseSchema,
  unreadResponseSchema,
  workspacePrimaryBotSchema,
  workspaceSnapshotSchema,
} from "@openbot/protocol";
import { contractClient, type RequestOptions } from "./client.ts";
import {
  contractTargetSchema,
  type ContractTarget,
  lifecycleScenarioSchema,
  type LifecycleScenario,
} from "./target.ts";

/** The supplied scenario contains synthetic published records, with no execution worker. */
export async function runLifecycleContracts(input: ContractTarget, scenario: LifecycleScenario) {
  const target = contractTargetSchema.parse(input),
    seeded = lifecycleScenarioSchema.parse(scenario);
  const client = contractClient(target),
    { request } = client;
  const passed: string[] = [];
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
  const audit = async (query = "") => {
    const result = await request(`/api/v1/audit${query}`);
    assert.equal(result.response.status, 200);
    return auditPageSchema.parse(result.body);
  };
  await check("health is anonymous and accurately identifies the service", async () => {
    const result = await request("/health", { cookie: false });
    assert.equal(result.response.status, 200);
    healthResponseSchema.parse(result.body);
  });
  for (const path of [
    "/api/v1/audit",
    "/api/v1/audit/export",
    "/api/v1/channels/unread",
    "/api/v1/settings/approvals",
  ]) {
    await check(`Owner authorization ${path}`, () =>
      error(path, 401, { cookie: false }).then(() => {}),
    );
  }
  let botId = "",
    peerId = "",
    channelId = "",
    directId = "",
    runId = "",
    peerRunId = "",
    messageId = "";
  const suffix = randomUUID(),
    name = `Lifecycle ${suffix}`;
  await check("create isolated Bot, peer, group and direct identities", async () => {
    for (const [field, display] of [
      ["bot", name],
      ["peer", `Peer ${suffix}`],
    ] as const) {
      const result = await request("/api/v1/bots", {
        method: "POST",
        body: { name: display, role: "Synthetic contracts", computerProfile: "none" },
      });
      assert.equal(result.response.status, 201);
      const created = botResponseSchema.parse(result.body).bot;
      if (field === "bot") botId = created.id;
      else peerId = created.id;
    }
    const group = await request("/api/v1/channels", {
      method: "POST",
      body: { name: `Group ${suffix}`, botIds: [botId, peerId] },
    });
    assert.equal(group.response.status, 201);
    channelId = channelResponseSchema.parse(group.body).channel.id;
    const direct = await request(`/api/v1/bots/${botId}/conversation`, { method: "POST" });
    assert.equal(direct.response.status, 200);
    directId = channelResponseSchema.parse(direct.body).channel.id;
  });
  await check(
    "rename normalizes input and updates direct identity without returning a full Bot",
    async () => {
      const result = await request(`/api/v1/bots/${botId}`, {
        method: "PATCH",
        body: { name: ` Renamed ${suffix} `, extra: true },
      });
      assert.equal(result.response.status, 200);
      assert.deepEqual(renamedBotResponseSchema.parse(result.body), {
        bot: { botId, name: `Renamed ${suffix}` },
      });
      const direct = channelResponseSchema.parse(
        (await request(`/api/v1/bots/${botId}/conversation`, { method: "POST" })).body,
      ).channel;
      assert.equal(direct.name, `Renamed ${suffix}`);
      const renamed = await request(`/api/v1/channels/${channelId}`, {
        method: "PATCH",
        body: { name: " =1+1 ", extra: true },
      });
      assert.equal(renamed.response.status, 200);
      assert.deepEqual(renamedChannelResponseSchema.parse(renamed.body), {
        channel: { channelId, name: "=1+1" },
      });
    },
  );
  await check(
    "duplicate/no-op names and direct-channel guards retain authoritative state/audit",
    async () => {
      const before = await audit("?category=bots&limit=100");
      await error(`/api/v1/bots/${botId}`, 409, {
        method: "PATCH",
        body: { name: `Peer ${suffix}` },
      });
      await request(`/api/v1/bots/${botId}`, {
        method: "PATCH",
        body: { name: `Renamed ${suffix}` },
      });
      assert.deepEqual(await audit("?category=bots&limit=100"), before);
      await error(`/api/v1/channels/${directId}`, 409, {
        method: "PATCH",
        body: { name: "Different" },
      });
      await error(`/api/v1/channels/${directId}`, 409, { method: "DELETE" });
      await error(`/api/v1/channels/${directId}/bots/${botId}`, 409, { method: "DELETE" });
      const bots = botsResponseSchema.parse((await request("/api/v1/bots")).body).bots;
      assert.equal(bots.find((bot) => bot.id === botId)?.name, `Renamed ${suffix}`);
    },
  );
  await check("invalid rename and foreign-Origin commands fail before mutations", async () => {
    await error(`/api/v1/bots/${botId}`, 422, { method: "PATCH", body: { name: " " } });
    await error(`/api/v1/channels/${channelId}`, 422, { method: "PATCH", body: { name: 1 } });
    await error(`/api/v1/bots/${botId}`, 403, {
      method: "DELETE",
      origin: "https://foreign.invalid",
    });
  });
  await check("seeded Bot unread state becomes read with a monotonic cursor", async () => {
    const prior = unreadResponseSchema.parse((await request("/api/v1/channels/unread")).body);
    assert.equal(prior.unread[seeded.channelId], 1);
    const path = `/api/v1/channels/${seeded.channelId}/read`;
    const first = await request(path, { method: "POST" });
    assert.equal(first.response.status, 200);
    const cursor = channelReadResponseSchema.parse(first.body);
    assert.equal(cursor.channelId, seeded.channelId);
    const second = channelReadResponseSchema.parse(
      (await request(path, { method: "POST", body: { ignored: true } })).body,
    );
    assert(Date.parse(second.lastReadAt) >= Date.parse(cursor.lastReadAt));
    assert.equal(
      unreadResponseSchema.parse((await request("/api/v1/channels/unread")).body).unread[
        seeded.channelId
      ],
      undefined,
    );
    await error(`/api/v1/channels/${randomUUID()}/read`, 404, { method: "POST" });
  });
  await check("message admission creates two real queued Runs", async () => {
    const result = await request(`/api/v1/channels/${channelId}/messages`, {
      method: "POST",
      body: { content: "Synthetic private message sentinel", botIds: [botId, peerId] },
    });
    assert.equal(result.response.status, 201);
    const admitted = submitTaskResponseSchema.parse(result.body);
    messageId = admitted.message.id;
    runId = admitted.runs?.find((run) => run.botId === botId)?.id ?? "";
    peerRunId = admitted.runs?.find((run) => run.botId === peerId)?.id ?? "";
    assert(runId && peerRunId);
  });
  await check("Owner reactions are idempotent and bound to the channel/message", async () => {
    const path = `/api/v1/channels/${channelId}/messages/${messageId}/reactions`;
    const payload = { emoji: "👍", active: true };
    const result = await request(path, { method: "PUT", body: payload });
    assert.equal(result.response.status, 200);
    const data = reactionMutationResponseSchema.parse(result.body);
    assert.deepEqual(data.reactions, [{ messageId, emoji: "👍", actor: "owner" }]);
    const before = await audit("?category=channels&limit=100");
    assert.deepEqual(
      reactionMutationResponseSchema.parse(
        (await request(path, { method: "PUT", body: payload })).body,
      ),
      data,
    );
    assert.deepEqual(await audit("?category=channels&limit=100"), before);
    assert.deepEqual(
      reactionsResponseSchema.parse(
        (await request(`/api/v1/channels/${channelId}/reactions`)).body,
      ),
      data,
    );
    await error(`/api/v1/channels/${channelId}/messages/${seeded.unreadMessageId}/reactions`, 404, {
      method: "PUT",
      body: payload,
    });
    for (const body of [
      { emoji: "🚀", active: true },
      { ...payload, active: 1 },
      { ...payload, extra: true },
    ])
      await error(path, 422, { method: "PUT", body });
    const removed = await request(path, { method: "PUT", body: { ...payload, active: false } });
    assert.equal(removed.response.status, 200);
    assert.deepEqual(reactionMutationResponseSchema.parse(removed.body).reactions, []);
  });
  await check("native steering is accepted, bounded and refuses attachment admission", async () => {
    const path = `/api/v1/runs/${runId}/steer`;
    const result = await request(path, { method: "POST", body: { instruction: " Correct 🧪 " } });
    assert.equal(result.response.status, 202);
    const data = steeringResponseSchema.parse(result.body).steering;
    assert.equal(data.runId, runId);
    assert.equal(data.channelId, channelId);
    assert.equal(data.botId, botId);
    assert.equal(data.instruction, "Correct 🧪");
    await error(path, 422, { method: "POST", body: { instruction: " " } });
    await error(path, 422, { method: "POST", body: { instruction: "text", extra: true } });
    await error(path, 400, {
      method: "POST",
      body: { instruction: `[OpenBot attachment: ${randomUUID()}]` },
    });
    await error(path, 422, { method: "POST", body: { instruction: "\ud800" } });
  });
  await check("active Run guards block deletion and cancellation remains idempotent", async () => {
    await error(`/api/v1/bots/${botId}`, 409, { method: "DELETE" });
    await error(`/api/v1/channels/${channelId}`, 409, { method: "DELETE" });
    const path = `/api/v1/runs/${runId}/cancel`;
    await error(path, 422, { method: "POST", body: { extra: true } });
    const result = await request(path, { method: "POST", body: {} });
    assert.equal(result.response.status, 200);
    assert.equal(cancelledRunResponseSchema.parse(result.body).run.status, "cancelled");
    assert.deepEqual(
      cancelledRunResponseSchema.parse((await request(path, { method: "POST", body: {} })).body),
      cancelledRunResponseSchema.parse(result.body),
    );
    await error(`/api/v1/runs/${runId}/steer`, 409, {
      method: "POST",
      body: { instruction: "Ended" },
    });
  });
  await check(
    "membership revocation cancels persisted Work and refuses later commands",
    async () => {
      const path = `/api/v1/channels/${channelId}/bots/${peerId}`;
      const result = await request(path, { method: "DELETE" });
      assert.equal(result.response.status, 200);
      const data = removeChannelMemberResponseSchema.parse(result.body);
      assert(!data.channel.botIds.includes(peerId));
      assert.equal(data.cancelledRuns.find((run) => run.id === peerRunId)?.status, "cancelled");
      const replay = removeChannelMemberResponseSchema.parse(
        (await request(path, { method: "DELETE" })).body,
      );
      assert.deepEqual(replay.cancelledRuns, []);
      await error(`/api/v1/runs/${peerRunId}/steer`, 409, {
        method: "POST",
        body: { instruction: "After removal" },
      });
      const runs = runsResponseSchema.parse(
        (await request(`/api/v1/channels/${channelId}/runs`)).body,
      ).runs;
      assert(runs.every((run) => run.status === "cancelled"));
    },
  );
  await check(
    "additional approval configuration validates exact targets and revision CAS",
    async () => {
      const path = "/api/v1/settings/approvals";
      const prior = approvalSettingsSchema.parse((await request(path)).body);
      const base = {
        expectedRevision: prior.revision,
        productRead: "required",
        publicWeb: "required",
        exceptions: [],
      };
      await error(path, 422, {
        method: "PUT",
        rawBody: JSON.stringify(base).replace(
          `"expectedRevision":${prior.revision}`,
          `"expectedRevision":${prior.revision}.0`,
        ),
      });
      const entry = {
        botId,
        category: "product_read",
        target: { kind: "channel", value: channelId },
      };
      for (const body of [
        { ...base, extra: true },
        { ...base, exceptions: [entry, entry] },
        { ...base, exceptions: [{ ...entry, category: "delete" }] },
        { ...base, exceptions: [{ ...entry, target: { kind: "channel", value: "*" } }] },
      ])
        await error(path, 422, { method: "PUT", body });
      const changed = await request(path, {
        method: "PUT",
        body: { ...base, exceptions: [entry] },
      });
      assert.equal(changed.response.status, 200);
      const data = approvalSettingsSchema.parse(changed.body);
      assert.equal(data.revision, prior.revision + 1);
      assert.deepEqual(data.exceptions, [entry]);
      const noop = await request(path, {
        method: "PUT",
        body: { ...base, expectedRevision: data.revision, exceptions: [entry] },
      });
      assert.deepEqual(approvalSettingsSchema.parse(noop.body), data);
      await error(path, 409, { method: "PUT", body: base });
      const restored = await request(path, {
        method: "PUT",
        body: {
          expectedRevision: data.revision,
          productRead: prior.productRead,
          publicWeb: prior.publicWeb,
          exceptions: prior.exceptions,
        },
      });
      assert.equal(restored.response.status, 200);
    },
  );
  await check(
    "seeded Worker approvals approve/reject once and expire transactionally",
    async () => {
      for (const decision of ["approve", "reject"] as const) {
        const path = `/api/v1/approvals/${seeded.approvals[decision]}/decision`;
        await error(path, 422, { method: "POST", body: { decision: "unknown" } });
        const result = await request(path, { method: "POST", body: { decision, ignored: true } });
        assert.equal(result.response.status, 200);
        const data = approvalDecisionResponseSchema.parse(result.body);
        assert.equal(data.approval.status, decision === "approve" ? "approved" : "rejected");
        assert.equal(data.approval.decidedBy, "owner");
        assert.equal(data.run.status, decision === "approve" ? "running" : "blocked");
        await error(path, 409, { method: "POST", body: { decision } });
      }
      const expired = `/api/v1/approvals/${seeded.approvals.expired}/decision`;
      await error(expired, 409, { method: "POST", body: { decision: "approve" } });
      await error(expired, 409, { method: "POST", body: { decision: "approve" } });
    },
  );
  await check(
    "audit keyset categories preserve safe fields and explicit preference nulls",
    async () => {
      const first = await audit("?limit=1");
      assert.equal(first.events.length, 1);
      assert(first.nextBefore);
      const next = await audit(`?limit=1&before=${encodeURIComponent(first.nextBefore)}`);
      assert.equal(next.events.length, 1);
      assert.notEqual(next.events[0]?.id, first.events[0]?.id);
      const settings = await audit("?category=settings&limit=100");
      assert(settings.events.every((event) => event.category === "settings"));
      assert(settings.events.some((event) => event.details.previousBotId === null));
      assert(settings.events.some((event) => event.details.fileName === "😀".repeat(160)));
      assert(settings.events.some((event) => event.details.name === "😀".repeat(120)));
      assert(
        settings.events.some(
          (event) =>
            "freedBytes" in event.details ||
            "trashAutoPurgeDays" in event.details ||
            event.type === "SETTINGS_APPROVAL_UPDATED",
        ),
      );
      const body = JSON.stringify(settings);
      assert(!body.includes("Synthetic audit private sentinel"));
      assert(!body.includes("Synthetic private Run instruction"));
    },
  );
  await check("audit queries reject unknown/duplicate/range/category/cursor values", async () => {
    for (const query of [
      "extra=1",
      "limit=0",
      "limit=101",
      "limit=1&limit=2",
      "category=unknown",
      "before=bad",
      "before=",
    ])
      await error(`/api/v1/audit?${query}`, 422);
    await error("/api/v1/audit/export?limit=1001", 422);
  });
  await check("CSV export is bounded, BOM/CRLF framed and spreadsheet-safe", async () => {
    const result = await client.download("/api/v1/audit/export", 4 * 1024 * 1024);
    assert.equal(result.response.status, 200);
    assert.match(result.response.headers.get("content-type") ?? "", /^text\/csv;/);
    assert.equal(
      result.response.headers.get("content-disposition"),
      'attachment; filename="openbot-audit.csv"',
    );
    assert.deepEqual(result.bytes.slice(0, 3), new Uint8Array([239, 187, 191]));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
    assert(text.startsWith('"id","createdAt","category","type",'));
    assert(text.includes("\r\n"));
    assert(text.includes(`"'=1+1"`));
    for (const privateValue of [
      "Synthetic private message sentinel",
      "Synthetic audit private sentinel",
      "Synthetic private Run instruction",
      "Correct 🧪",
    ])
      assert(!text.includes(privateValue));
    const page = await client.download("/api/v1/audit/export?limit=1", 16384);
    assert.equal(page.response.status, 200);
    assert(page.response.headers.get("x-openbot-next-before"));
  });
  await check(
    "tombstones remove content and memberships after all active tasks close",
    async () => {
      const removed = await request(`/api/v1/channels/${channelId}`, { method: "DELETE" });
      assert.equal(removed.response.status, 200);
      assert.deepEqual(deletedChannelResponseSchema.parse(removed.body), {
        deleted: true,
        channelId,
        attachmentsRemoved: true,
      });
      await error(`/api/v1/channels/${channelId}/messages`, 404);
      await error(`/api/v1/channels/${channelId}`, 404, { method: "DELETE" });
      const channels = channelsResponseSchema.parse(
        (await request("/api/v1/channels")).body,
      ).channels;
      assert(!channels.some((channel) => channel.id === channelId));
      const bots = botsResponseSchema.parse((await request("/api/v1/bots")).body).bots;
      assert(bots.some((bot) => bot.id === botId));
      const preferences = workspaceSnapshotSchema.parse((await request("/api/v1/workspace")).body);
      const selected = await request("/api/v1/workspace/primary-bot", {
        method: "PUT",
        body: { expectedRevision: preferences.revision, botId },
      });
      assert.equal(selected.response.status, 200);
      assert.equal(workspacePrimaryBotSchema.parse(selected.body).primaryBotId, botId);
      const deleted = await request(`/api/v1/bots/${botId}`, { method: "DELETE" });
      assert.equal(deleted.response.status, 200);
      assert.deepEqual(deletedBotResponseSchema.parse(deleted.body), {
        deleted: true,
        botId,
        pluginGrantsRemoved: true,
        attachmentsRemoved: true,
      });
      await error(`/api/v1/bots/${botId}/conversation`, 404, { method: "POST" });
      await error(`/api/v1/bots/${botId}`, 404, { method: "DELETE" });
      const workspace = workspaceSnapshotSchema.parse((await request("/api/v1/workspace")).body);
      assert.equal(workspace.primaryBotId, null);
      assert(
        !botsResponseSchema
          .parse((await request("/api/v1/bots")).body)
          .bots.some((bot) => bot.id === botId),
      );
      assert(
        !channelsResponseSchema
          .parse((await request("/api/v1/channels")).body)
          .channels.some((channel) => channel.id === directId),
      );
      const tombstones = await audit("?limit=100");
      assert(
        tombstones.events.some(
          (event) => event.channelId === channelId && event.channelDeleted === true,
        ),
      );
      assert(tombstones.events.some((event) => event.botId === botId && event.botDeleted === true));
    },
  );
  return { count: passed.length, passed };
}
