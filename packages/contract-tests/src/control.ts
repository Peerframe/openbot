import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  authSessionSchema,
  bootstrapSchema,
  botResponseSchema,
  botsResponseSchema,
  channelReadySchema,
  channelMessageCreatedSchema,
  employeeProfileChangedSchema,
  employeeProfileResponseSchema,
  botAppearanceResultSchema,
  channelResponseSchema,
  channelsResponseSchema,
  controlHttpErrorSchema,
  loginResponseSchema,
  messagesResponseSchema,
  ownerPasswordChangeResponseSchema,
  ownerPreferencesSchema,
  ownerSessionRevocationResponseSchema,
  ownerSessionsResponseSchema,
  quickBotResponseSchema,
  runsResponseSchema,
  runProgressDetailsSchema,
  submitTaskResponseSchema,
  workspacePrimaryBotSchema,
  workspaceReadySchema,
  workspaceSnapshotSchema,
} from "@openbot/protocol";
import { contractClient, type RequestOptions } from "./client.ts";
import {
  contractTargetSchema,
  controlContractFixtureSchema,
  type ContractTarget,
} from "./target.ts";

/** Mutates only this explicitly supplied disposable Owner fixture; never model/executor calls. */
export async function runControlContracts(input: ContractTarget, password: string) {
  const target = contractTargetSchema.parse(input);
  controlContractFixtureSchema.parse({ ...target, password });
  const client = contractClient(target);
  const passed: string[] = [];
  let cookie = target.cookie;
  const request = (path: string, options: RequestOptions = {}) =>
    client.request(path, { cookie, ...options });
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
  const login = async (value: string) => {
    const result = await request("/api/v1/auth/login", {
      method: "POST",
      cookie: false,
      body: { password: value },
      userAgent: "OpenBot contract fixture",
    });
    assert.equal(result.response.status, 200);
    loginResponseSchema.parse(result.body);
    const header = result.response.headers.get("set-cookie");
    assert(header);
    assert(
      header?.includes("HttpOnly") &&
        header.includes("SameSite=strict") &&
        header.includes("Path=/"),
    );
    const credential = header.split(";")[0];
    assert(credential);
    return credential;
  };
  await check("anonymous session uses a boolean discriminator", async () => {
    const result = await request("/api/v1/auth/session", { cookie: false });
    assert.equal(result.response.status, 200);
    assert.deepEqual(authSessionSchema.parse(result.body), { authenticated: false });
  });
  for (const path of [
    "/api/v1/bots",
    "/api/v1/channels",
    "/api/v1/workspace",
    "/api/v1/bootstrap",
    "/api/v1/settings/general",
    "/api/v1/auth/sessions",
    "/api/v1/workspace/events",
  ]) {
    await check(`unauthenticated ${path}`, () =>
      error(path, 401, { cookie: false }).then(() => {}),
    );
  }
  await check("login requires the exact Origin before JSON", () =>
    error("/api/v1/auth/login", 403, {
      method: "POST",
      cookie: false,
      origin: "https://foreign.invalid",
      rawBody: "invalid",
    }).then(() => {}),
  );
  await check("creation checks authentication before JSON", () =>
    error("/api/v1/bots", 401, { method: "POST", cookie: false, rawBody: "invalid" }).then(
      () => {},
    ),
  );
  await check("login error never reflects the submitted secret", async () => {
    const secret = `private-${randomUUID()}`;
    const result = await error("/api/v1/auth/login", 422, {
      method: "POST",
      cookie: false,
      body: { password: [secret] },
    });
    assert(!JSON.stringify(result.body).includes(secret));
  });
  await check("login rejects lone UTF-16 surrogates", () =>
    error("/api/v1/auth/login", 422, {
      method: "POST",
      cookie: false,
      body: { password: "\ud800" },
    }).then(() => {}),
  );
  await check("login cookie and authenticated response", async () => {
    cookie = await login(password);
  });
  await check("only the requesting session is current", async () => {
    const result = await request("/api/v1/auth/sessions");
    assert.equal(result.response.status, 200);
    const data = ownerSessionsResponseSchema.parse(result.body);
    assert(data.sessions.length >= 2);
    assert.equal(data.sessions.filter((item) => item.current).length, 1);
    assert.equal(data.sessions.find((item) => item.current)?.userAgent, "OpenBot contract fixture");
  });
  await check("revocation retains this session and invalidates older credentials", async () => {
    const result = await request("/api/v1/auth/sessions/revoke-others", { method: "POST" });
    assert.equal(result.response.status, 200);
    assert(ownerSessionRevocationResponseSchema.parse(result.body).revoked >= 1);
    await error("/api/v1/bots", 401, { cookie: target.cookie });
  });
  const name = "😀".repeat(64);
  const botInput = {
    name: ` ${name} `,
    role: " Synthetic role ",
    computerProfile: "none",
    ignored: "compatibility",
  };
  let botId = "";
  await check("Bot normalization, defaults and Unicode code-point bound", async () => {
    const result = await request("/api/v1/bots", { method: "POST", body: botInput });
    assert.equal(result.response.status, 201);
    const data = botResponseSchema.parse(result.body);
    assert.equal(data.bot.name, name);
    assert.equal(data.bot.role, "Synthetic role");
    assert(!("appearance" in data.bot) && !("model" in data.bot));
    botId = data.bot.id;
  });
  await check("Bot Unicode bound rejects the next code point", () =>
    error("/api/v1/bots", 422, { method: "POST", body: { ...botInput, name: `${name}😀` } }).then(
      () => {},
    ),
  );
  await check("none profile cannot select a model", () =>
    error("/api/v1/bots", 422, {
      method: "POST",
      body: {
        ...botInput,
        name: "Invalid model",
        model: { connectionId: "fixture", modelId: "synthetic" },
      },
    }).then(() => {}),
  );
  const appearance = {
    head: "round",
    body: "classic",
    mobility: "feet",
    accessory: "none",
    accent: "green",
  };
  await check("quick creation rejects unknown appearance fields", () =>
    error("/api/v1/bots/quick", 422, {
      method: "POST",
      body: { appearance: { ...appearance, extra: true } },
    }).then(() => {}),
  );
  await check("quick creation creates an authoritative direct conversation", async () => {
    const result = await request("/api/v1/bots/quick", { method: "POST", body: { appearance } });
    assert.equal(result.response.status, 201);
    const data = quickBotResponseSchema.parse(result.body);
    assert.equal(data.channel.directBotId, data.bot.id);
    assert.deepEqual(data.channel.botIds, [data.bot.id]);
  });
  let channelId = "";
  await check("channel creation strips extras and deduplicates exact Bot IDs", async () => {
    const result = await request("/api/v1/channels", {
      method: "POST",
      body: { name: " Contract room ", botIds: [target.botId, target.botId], extra: true },
    });
    assert.equal(result.response.status, 201);
    const data = channelResponseSchema.parse(result.body);
    assert.equal(data.channel.name, "Contract room");
    assert.equal(data.channel.description, "");
    assert.deepEqual(data.channel.botIds, [target.botId]);
    channelId = data.channel.id;
  });
  await check("channel membership validates missing Bots", () =>
    error("/api/v1/channels", 422, {
      method: "POST",
      body: { name: "Missing", botIds: [randomUUID()] },
    }).then(() => {}),
  );
  await check("joining is idempotent and preserves membership", async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await request(`/api/v1/channels/${channelId}/bots`, {
        method: "POST",
        body: { botId },
      });
      assert.equal(result.response.status, 200);
      assert.deepEqual(
        new Set(channelResponseSchema.parse(result.body).channel.botIds),
        new Set([target.botId, botId]),
      );
    }
  });
  let directId = "";
  await check("direct conversation is idempotent", async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await request(`/api/v1/bots/${botId}/conversation`, { method: "POST" });
      assert.equal(result.response.status, 200);
      const data = channelResponseSchema.parse(result.body).channel;
      assert.equal(data.directBotId, botId);
      assert.deepEqual(data.botIds, [botId]);
      if (directId) assert.equal(data.id, directId);
      directId = data.id;
    }
  });
  await check("direct conversation membership cannot expand", () =>
    error(`/api/v1/channels/${directId}/bots`, 422, {
      method: "POST",
      body: { botId: target.botId },
    }).then(() => {}),
  );
  await check("Bot and channel reads serialize persisted identities", async () => {
    const bots = await request("/api/v1/bots");
    const channels = await request("/api/v1/channels");
    assert.equal(bots.response.status, 200);
    assert.equal(channels.response.status, 200);
    assert(botsResponseSchema.parse(bots.body).bots.some((bot) => bot.id === botId));
    assert(
      channelsResponseSchema
        .parse(channels.body)
        .channels.some((channel) => channel.id === channelId),
    );
  });
  await check("empty channel messages/runs retain their response envelopes", async () => {
    const messages = await request(`/api/v1/channels/${channelId}/messages?limit=1`);
    const runs = await request(`/api/v1/channels/${channelId}/runs`);
    assert.equal(messages.response.status, 200);
    assert.equal(runs.response.status, 200);
    assert.deepEqual(messagesResponseSchema.parse(messages.body), { messages: [], hasMore: false });
    assert.deepEqual(runsResponseSchema.parse(runs.body), { runs: [] });
  });
  await check("message admission preserves single/multiple Run response shapes", async () => {
    for (const recipients of [{ botId }, { botIds: [target.botId, botId] }]) {
      const result = await request(`/api/v1/channels/${channelId}/messages`, {
        method: "POST",
        body: { content: " Read synthetic 文档 ", ...recipients },
      });
      assert.equal(result.response.status, 201);
      const data = submitTaskResponseSchema.parse(result.body);
      assert.equal(data.message.content, "Read synthetic 文档");
      assert.equal(data.run.channelId, channelId);
      assert.equal(data.run.executionProfile, "none");
      assert(data.run.workTaskId);
      if ("botIds" in recipients) assert.equal(data.runs?.length, 2);
      else assert(!("runs" in data));
    }
  });
  await check("message cursors preserve chronological pages and channel binding", async () => {
    const latest = await request(`/api/v1/channels/${channelId}/messages?limit=1`);
    const page = messagesResponseSchema.parse(latest.body);
    assert.equal(page.messages.length, 1);
    assert.equal(page.hasMore, true);
    assert(page.nextCursor);
    const older = await request(
      `/api/v1/channels/${channelId}/messages?limit=1&before=${page.nextCursor}`,
    );
    const previous = messagesResponseSchema.parse(older.body);
    assert.equal(previous.messages.length, 1);
    assert.equal(previous.hasMore, false);
    assert(previous.messages[0] && page.messages[0]);
    assert(previous.messages[0].createdAt < page.messages[0].createdAt);
    await error(`/api/v1/channels/${directId}/messages?before=${page.nextCursor}`, 422);
  });
  await check("persisted Runs and public progress preserve explicit nulls", async () => {
    const result = await request(`/api/v1/channels/${channelId}/runs`);
    const runs = runsResponseSchema.parse(result.body).runs;
    assert.equal(runs.length, 3);
    assert(runs[0]);
    const progress = await request(`/api/v1/runs/${runs[0].id}/progress?steps=1`);
    assert.equal(progress.response.status, 200);
    const data = runProgressDetailsSchema.parse(progress.body);
    assert.equal(data.runId, runs[0].id);
    assert.equal(data.totalSteps, 0);
    assert.equal(data.currentStepNumber, null);
    assert.deepEqual(data.steps, []);
  });
  for (const query of [
    "limit=0",
    "limit=1.0",
    "limit=101",
    "limit=1&limit=2",
    "extra=1",
    "before=invalid",
  ]) {
    await check(`invalid message pagination ${query}`, () =>
      error(`/api/v1/channels/${channelId}/messages?${query}`, 422).then(() => {}),
    );
  }
  await check("missing channel and Run fail through actual read routes", async () => {
    await error(`/api/v1/channels/${randomUUID()}/messages`, 404);
    await error(`/api/v1/runs/${randomUUID()}/progress`, 404);
    await error(`/api/v1/runs/${randomUUID()}/progress?steps=1,1`, 422);
  });
  const snapshot = async () => {
    const result = await request("/api/v1/workspace");
    assert.equal(result.response.status, 200);
    return workspaceSnapshotSchema.parse(result.body);
  };
  await check("workspace and bootstrap counts share persisted facts", async () => {
    const data = await snapshot();
    const bootstrap = await request("/api/v1/bootstrap");
    assert.equal(bootstrap.response.status, 200);
    assert.deepEqual(bootstrapSchema.parse(bootstrap.body).counts, data.counts);
    assert.equal(data.counts.bots, data.bots.length);
    assert.equal(data.counts.channels, data.channels.length);
    assert(data.bots.some((bot) => bot.id === botId));
  });
  await check("primary Bot compare-and-swap, no-op and explicit null", async () => {
    const prior = await snapshot();
    // First creation may already select this Bot after another suite clears the preference.
    const selectedBotId = prior.primaryBotId === botId ? target.botId : botId;
    assert.notEqual(selectedBotId, prior.primaryBotId);
    const result = await request("/api/v1/workspace/primary-bot", {
      method: "PUT",
      body: { botId: selectedBotId, expectedRevision: prior.revision },
    });
    assert.equal(result.response.status, 200);
    const data = workspacePrimaryBotSchema.parse(result.body);
    assert.equal(data.primaryBotId, selectedBotId);
    assert.equal(data.revision, prior.revision + 1);
    await error("/api/v1/workspace/primary-bot", 409, {
      method: "PUT",
      body: { botId: null, expectedRevision: prior.revision },
    });
    const noop = await request("/api/v1/workspace/primary-bot", {
      method: "PUT",
      body: { botId: selectedBotId, expectedRevision: data.revision },
    });
    assert.deepEqual(workspacePrimaryBotSchema.parse(noop.body), data);
    const cleared = await request("/api/v1/workspace/primary-bot", {
      method: "PUT",
      body: { botId: null, expectedRevision: data.revision },
    });
    assert.equal(cleared.response.status, 200);
    assert.deepEqual(workspacePrimaryBotSchema.parse(cleared.body), {
      primaryBotId: null,
      revision: data.revision + 1,
    });
  });
  await check("owner timezone update validates IANA keys and revisions", async () => {
    const initial = await request("/api/v1/settings/general");
    assert.equal(initial.response.status, 200);
    const prior = ownerPreferencesSchema.parse(initial.body);
    const body = {
      expectedRevision: prior.revision,
      timezone: prior.timezone === "Asia/Singapore" ? "UTC" : "Asia/Singapore",
      defaultModel: null,
    };
    await error("/api/v1/settings/general", 422, {
      method: "PUT",
      body: { ...body, timezone: "Unknown/Nowhere" },
    });
    await error("/api/v1/settings/general", 422, { method: "PUT", body: { ...body, extra: true } });
    const result = await request("/api/v1/settings/general", { method: "PUT", body });
    assert.equal(result.response.status, 200);
    const data = ownerPreferencesSchema.parse(result.body);
    assert.equal(data.timezone, body.timezone);
    assert.equal(data.revision, prior.revision + 1);
    await error("/api/v1/settings/general", 409, { method: "PUT", body });
  });
  const ready = (frame: string | null, name: string) => {
    assert(frame);
    assert(frame?.startsWith(`event: ${name}\nretry: 2000\ndata: `) && frame.endsWith("\n\n"));
    return JSON.parse(frame.split("\ndata: ")[1]?.slice(0, -2) ?? "");
  };
  for (const [path, event] of [
    ["/api/v1/workspace/events", "workspace.ready"],
    [`/api/v1/channels/${channelId}/events`, "channel.ready"],
  ] as const) {
    await check(`${event} initial frame, idle heartbeat, abort and reconnect`, async () => {
      const stream = await client.stream(path, { cookie });
      try {
        const value = ready(await stream.next(), event);
        if (event === "workspace.ready") workspaceReadySchema.parse(value);
        else assert.equal(channelReadySchema.parse(value).channelId, channelId);
        // A complete Server can finish an earlier admitted Run between these polls.
        // Validate every intervening invalidation and still require bounded idle liveness.
        let heartbeat = false;
        for (let poll = 0; poll < 4; poll++) {
          const next = await stream.next();
          if (next === "event: heartbeat\ndata: alive\n\n") { heartbeat = true; break; }
          const update = ready(next, event);
          if (event === "workspace.ready") workspaceReadySchema.parse(update);
          else assert.equal(channelReadySchema.parse(update).channelId, channelId);
        }
        assert(heartbeat, "The stream must become idle after bounded background completion.");
      } finally {
        await stream.close();
      }
      const reconnected = await client.stream(path, { cookie });
      try {
        ready(await reconnected.next(), event);
      } finally {
        await reconnected.close();
      }
    });
  }
  await check("appearance SSE invalidation precedes readiness and no-op stays idle", async () => {
    const result = await request(`/api/v1/bots/${target.botId}/profile`, { cookie });
    assert.equal(result.response.status, 200);
    const before = employeeProfileResponseSchema.parse(result.body).profile;
    const appearance = {
      head: "round",
      body: "classic",
      mobility: "feet",
      accessory: "none",
      accent: before.employee.appearance?.accent === "teal" ? "pink" : "teal",
    };
    const stream = await client.stream("/api/v1/workspace/events", { cookie });
    try {
      workspaceReadySchema.parse(ready(await stream.next(), "workspace.ready"));
      const response = await request(`/api/v1/bots/${target.botId}/appearance`, {
        cookie,
        method: "PATCH",
        body: { expectedRevision: before.details.revision, appearance },
      });
      assert.equal(response.response.status, 200);
      const changed = botAppearanceResultSchema.parse(response.body);
      const event = employeeProfileChangedSchema.parse(
        ready(await stream.next(), "employee.profile.changed"),
      );
      assert.equal(event.botId, target.botId);
      assert.deepEqual(event.sections, ["identity"]);
      workspaceReadySchema.parse(ready(await stream.next(), "workspace.ready"));
      const noOp = await request(`/api/v1/bots/${target.botId}/appearance`, {
        cookie,
        method: "PATCH",
        body: { expectedRevision: changed.revision, appearance },
      });
      assert.equal(noOp.response.status, 200);
      assert.equal(botAppearanceResultSchema.parse(noOp.body).revision, changed.revision);
      assert.equal(await stream.next(), "event: heartbeat\ndata: alive\n\n");
    } finally {
      await stream.close();
    }
  });
  await check(
    "workspace readiness and channel message events expose only the expected committed projection",
    async () => {
      const workspace = await client.stream("/api/v1/workspace/events", { cookie });
      const channel = await client.stream(`/api/v1/channels/${channelId}/events`, { cookie });
      const sentinel = `Synthetic private stream content ${randomUUID()}`;
      try {
        workspaceReadySchema.parse(ready(await workspace.next(), "workspace.ready"));
        channelReadySchema.parse(ready(await channel.next(), "channel.ready"));
        const sent = await request(`/api/v1/channels/${channelId}/messages`, {
          method: "POST",
          body: { botId: target.botId, content: sentinel },
        });
        assert.equal(sent.response.status, 201);
        const messageId = submitTaskResponseSchema.parse(sent.body).message.id;
        const frames = await Promise.all([workspace.next(), channel.next()]);
        workspaceReadySchema.parse(ready(frames[0] ?? null, "workspace.ready"));
        const created = channelMessageCreatedSchema.parse(
          ready(frames[1] ?? null, "message.created"),
        );
        assert.equal(created.channelId, channelId);
        assert.equal(created.message.id, messageId);
        assert.equal(created.message.content, sentinel);
        assert.equal(created.message.authorType, "human");
        assert.equal(created.message.origin, undefined);
        assert(frames[1] && !/^id:/m.test(frames[1]));
        const channelFrame = await channel.next();
        channelReadySchema.parse(ready(channelFrame, "channel.ready"));
        for (const frame of [frames[0], channelFrame]) {
          assert(frame && !frame.includes(sentinel) && !/^id:/m.test(frame));
        }
        const result = await request(`/api/v1/channels/${channelId}/messages?limit=1`);
        assert(
          messagesResponseSchema
            .parse(result.body)
            .messages.some((message) => message.id === messageId && message.content === sentinel),
        );
      } finally {
        await workspace.close();
        await channel.close();
      }
    },
  );
  await check(
    "slow SSE consumption coalesces changes into an invalidation and authoritative refresh",
    async () => {
      const stream = await client.stream(`/api/v1/channels/${channelId}/events`, { cookie });
      const names = [1, 2, 3].map((index) => `Slow reader ${index} ${randomUUID()}`);
      try {
        channelReadySchema.parse(ready(await stream.next(), "channel.ready"));
        for (const name of names) {
          const result = await request(`/api/v1/channels/${channelId}`, {
            method: "PATCH",
            body: { name },
          });
          assert.equal(result.response.status, 200);
        }
        // Withhold reads through two real poll periods. Notifications are invalidations, not replay events.
        await delay(6500);
        channelReadySchema.parse(ready(await stream.next(), "channel.ready"));
        assert.equal(await stream.next(), "event: heartbeat\ndata: alive\n\n");
        const result = await request("/api/v1/channels");
        assert.equal(
          channelsResponseSchema.parse(result.body).channels.find((item) => item.id === channelId)
            ?.name,
          names[2],
        );
      } finally {
        await stream.close();
      }
    },
  );
  await check(
    "channel tombstone terminates its existing stream and refuses reconnect",
    async () => {
      const created = await request("/api/v1/channels", {
        method: "POST",
        body: { name: `Disposable stream ${randomUUID()}`, botIds: [] },
      });
      assert.equal(created.response.status, 201);
      const id = channelResponseSchema.parse(created.body).channel.id;
      const path = `/api/v1/channels/${id}/events`;
      const stream = await client.stream(path, { cookie });
      try {
        assert.equal(
          channelReadySchema.parse(ready(await stream.next(), "channel.ready")).channelId,
          id,
        );
        const deleted = await request(`/api/v1/channels/${id}`, { method: "DELETE" });
        assert.equal(deleted.response.status, 200);
        assert.equal(await stream.next(), null);
        await error(path, 404);
      } finally {
        await stream.close();
      }
    },
  );
  await check("password change rejects wrong current password without logging out", async () => {
    await error("/api/v1/auth/password", 401, {
      method: "POST",
      body: { currentPassword: "incorrect", newPassword: randomBytes(24).toString("hex") },
    });
    assert.equal((await request("/api/v1/bots")).response.status, 200);
  });
  await check("password changes reject invalid Unicode and placeholder passwords", async () => {
    for (const newPassword of ["\ud800".repeat(15), "replace-with-a-long-random-owner-password"]) {
      await error("/api/v1/auth/password", 422, {
        method: "POST",
        body: { currentPassword: password, newPassword },
      });
    }
  });
  await check("password change invalidates sessions and terminates existing streams", async () => {
    const stream = await client.stream("/api/v1/workspace/events", { cookie });
    const channel = await client.stream(`/api/v1/channels/${channelId}/events`, { cookie });
    const replacement = randomBytes(24).toString("hex");
    try {
      workspaceReadySchema.parse(ready(await stream.next(), "workspace.ready"));
      channelReadySchema.parse(ready(await channel.next(), "channel.ready"));
      const changed = await request("/api/v1/auth/password", {
        method: "POST",
        body: { currentPassword: password, newPassword: replacement },
      });
      assert.equal(changed.response.status, 200);
      ownerPasswordChangeResponseSchema.parse(changed.body);
      assert(changed.response.headers.get("set-cookie")?.includes("Max-Age=0"));
      await error("/api/v1/bots", 401);
      assert.equal(await stream.next(), null);
      assert.equal(await channel.next(), null);
      await error(`/api/v1/channels/${channelId}/events`, 401);
      cookie = await login(replacement);
    } finally {
      await stream.close();
      await channel.close();
    }
  });
  await check("logout clears credentials and preserves the anonymous envelope", async () => {
    const result = await request("/api/v1/auth/logout", { method: "POST" });
    assert.equal(result.response.status, 204);
    assert.equal(result.body, null);
    assert(result.response.headers.get("set-cookie")?.includes("Max-Age=0"));
    assert.deepEqual(authSessionSchema.parse((await request("/api/v1/auth/session")).body), {
      authenticated: false,
    });
  });
  return { count: passed.length, passed };
}
