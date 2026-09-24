import { readFile } from "node:fs/promises";
import { createDatabase } from "@openbot/db";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeAgentRunner } from "../../apps/server/src/native-agent.js";
import { PostgresAgentStore } from "../../apps/server/src/postgres-agent-store.js";
import {
  call,
  createFixture,
  createMcpFixture,
  type Fixture,
  fixtureDatabaseUrl,
  grant,
  reopen,
} from "./fixtures.js";

const url = fixtureDatabaseUrl();
let f: Fixture;
const cleanup: (() => Promise<void>)[] = [];
beforeAll(async () => {
  const database = createDatabase(url);
  try {
    await database.migrate();
  } finally {
    await database.close();
  }
});
beforeEach(async () => {
  f = await createFixture();
});
afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) await close();
  } finally {
    await f?.database.close();
  }
});

async function mcp() {
  const fixture = await createMcpFixture(f);
  cleanup.push(() => fixture.close());
  return fixture;
}
async function child() {
  return (await f.native.delegate(f.parent, { botId: f.childBot.id, task: "Inspect fixture." }))
    .run;
}

describe("S6 real Server compatibility with synthetic inputs", { timeout: 20_000 }, () => {
  it("S6-GRANT: delegation does not inherit the parent MCP grant; explicit child grant survives reopen", async () => {
    const c = await child();
    const p = await mcp();
    const granted = await grant(p.service, p.installed, f.parentBot.id);
    const enabled = await p.service.setEnabled(granted.id, {
      revision: granted.revision,
      enabled: true,
    });
    expect(JSON.stringify(await call(p.service, f.parent, enabled))).toContain("42");
    const requests = p.fault.acceptedRequests;
    expect(await p.service.catalog(c)).toEqual({ tools: [], truncated: false });
    await expect(call(p.service, c, enabled)).rejects.toMatchObject({ code: "forbidden" });
    expect(p.fault.acceptedRequests).toBe(requests);
    const independent = await grant(p.service, enabled, c.botId);
    await reopen(f);
    p.reopen();
    expect(JSON.stringify(await call(p.service, c, independent))).toContain("42");
    expect(await readFile(p.path, "utf8")).not.toContain(p.token);
    expect(JSON.stringify(await p.service.snapshot())).not.toContain(p.token);
  });

  it("S6-CANCEL: persisted parent cancellation fences child effects and late publication after reopen", async () => {
    const c = await child();
    const p = await mcp();
    const granted = await grant(p.service, p.installed, c.botId);
    const enabled = await p.service.setEnabled(granted.id, {
      revision: granted.revision,
      enabled: true,
    });
    const completed = await f.native.delegate(c, {
      // A third identity permits a completed descendant without an ancestry loop.
      botId: (await addThirdBot()).id,
      task: "Commit evidence before cancellation.",
    });
    await f.native.complete(completed.run, "Retained synthetic evidence");
    await reopen(f);
    const cancelled = await f.native.cancelWithDescendants(f.parent.id);
    expect(cancelled.descendants.map((run) => run.id)).toEqual([c.id]);
    await reopen(f);
    p.reopen();
    const { parentRunId: _parent, rootRunId: _root, delegatedByBotId: _by, ...stripped } = c;
    await expect(f.native.assertScope(stripped)).rejects.toMatchObject({ code: "conflict" });
    await expect(call(p.service, stripped, enabled)).rejects.toMatchObject({ code: "conflict" });
    await expect(f.native.complete(stripped, "Forbidden late reply")).rejects.toThrow();
    expect((await f.native.lookup(c.id))?.status).toBe("cancelled");
    expect((await f.native.lookup(completed.run.id))?.status).toBe("completed");
    const messages = await f.control.listMessages(f.channel.id);
    expect(messages.some((message) => message.content === "Retained synthetic evidence")).toBe(
      true,
    );
    expect(messages.some((message) => message.content === "Forbidden late reply")).toBe(false);
    expect(p.demo.notes).toEqual([]);
  });

  it("S6-APPROVAL: a parent cancelled during child approval cannot authorize a write", async () => {
    const c = await child();
    const p = await mcp();
    const granted = await grant(p.service, p.installed, c.botId, true);
    const enabled = await p.service.setEnabled(granted.id, {
      revision: granted.revision,
      enabled: true,
    });
    const controller = new AbortController();
    const outcome = p.service
      .call(
        c,
        {
          pluginId: enabled.id,
          revision: enabled.revision,
          toolName: "append_note",
          arguments: { text: "Must never be appended" },
        },
        controller.signal,
      )
      .then(
        () => ({ code: "unexpected_success" }),
        (error: unknown) => error,
      );
    try {
      await vi.waitFor(async () =>
        expect((await p.service.snapshot()).pendingCalls).toHaveLength(1),
      );
      const pending = (await p.service.snapshot()).pendingCalls[0];
      if (!pending) throw new Error("Pending approval missing.");
      await f.native.cancel(f.parent.id);
      await expect(p.service.decide(pending.id, "approve")).rejects.toMatchObject({
        code: "conflict",
      });
      // This explicitly exercises the caller's abort seam; DB cancellation alone is not an abort signal.
      controller.abort();
      expect(await outcome).toMatchObject({ code: "unavailable" });
      expect((await p.service.snapshot()).pendingCalls).toEqual([]);
      await expect(p.service.decide(pending.id, "approve")).rejects.toMatchObject({
        code: "not_found",
      });
      expect(p.demo.notes).toEqual([]);
      expect((await p.store.read()).audit.some((entry) => entry.phase === "dispatching")).toBe(
        false,
      );
    } finally {
      controller.abort();
      await outcome;
    }
  });

  it("S6-MCP: remote 401 blocks calls/catalog refresh; local revocation survives endpoint recovery and reopen", async () => {
    const c = await child();
    const p = await mcp();
    const granted = await grant(p.service, p.installed, c.botId);
    const enabled = await p.service.setEnabled(granted.id, {
      revision: granted.revision,
      enabled: true,
    });
    await call(p.service, c, enabled);
    const before = await p.store.read();
    p.fault.unauthorized = true;
    await expect(call(p.service, c, enabled)).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      p.service.previewUpdate(enabled.id, enabled.revision, AbortSignal.timeout(5000)),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(p.fault.deniedRequests).toBe(2);
    const after = await p.store.read();
    expect(after.plugins).toEqual(before.plugins);
    expect(after.audit.filter((entry) => entry.phase === "dispatching")).toHaveLength(1);
    expect(after.audit.filter((entry) => entry.phase === "failed")).toHaveLength(1);
    const revoked = await p.service.grant(enabled.id, c.botId, {
      revision: enabled.revision,
      tools: [],
    });
    p.fault.unauthorized = false;
    await reopen(f);
    p.reopen();
    const refresh = await p.service.previewUpdate(
      revoked.id,
      revoked.revision,
      AbortSignal.timeout(5000),
    );
    expect(refresh.changed).toBe(false);
    const requests = p.fault.acceptedRequests;
    await expect(call(p.service, c, revoked)).rejects.toMatchObject({ code: "forbidden" });
    expect(p.fault.acceptedRequests).toBe(requests);
    expect(p.demo.notes).toEqual([]);
  });

  it("S6-CONFLICT: independent root claims coexist while a same-Bot/channel root is serialized", async () => {
    const peer = createDatabase(url);
    cleanup.push(() => peer.close());
    const other = new PostgresAgentStore(peer.db);
    const second = await f.control.submitTask(f.channel.id, {
      content: "Independent",
      botId: f.childBot.id,
    });
    const duplicate = await f.control.submitTask(f.channel.id, {
      content: "Same identity",
      botId: f.parentBot.id,
    });
    const [claimed, blocked] = await Promise.all([
      other.claim(second.run, f.since),
      f.native.claim(duplicate.run, f.since),
    ]);
    expect(claimed?.status).toBe("running");
    expect(blocked).toBeUndefined();
    await f.native.cancel(f.parent.id);
    await reopen(f);
    expect((await f.native.claim(duplicate.run, f.since))?.status).toBe("running");
  });

  it("S6-BUDGET-BASELINE: parent and child independently admit five web reads across their per-Run budgets", async () => {
    await f.database.client`update runs set status = 'queued' where id = ${f.parent.id}`;
    const parentModel = new MockLanguageModelV4({
      doGenerate: [
        toolCall("fetch", { url: "https://example.com/parent-1" }),
        toolCall("fetch", { url: "https://example.com/parent-2" }),
        toolCall("fetch", { url: "https://example.com/parent-3" }),
        toolCall("delegate_task", { botId: f.childBot.id, task: "Read two synthetic sources." }),
        answer("Parent completed"),
      ],
    });
    const childModel = new MockLanguageModelV4({
      doGenerate: [
        toolCall("fetch", { url: "https://example.com/child-1" }),
        toolCall("fetch", { url: "https://example.com/child-2" }),
        answer("Child completed"),
      ],
    });
    const reads: string[] = [];
    let models = 0;
    const errors = vi.fn();
    const runner = new NativeAgentRunner(
      f.native,
      {
        agentSettings: async () => ({
          provider: "openai",
          model: "fixture",
          apiKey: "synthetic-model-key",
          revision: "fixture",
          agentEnabled: true,
          agentEnabledAt: f.since,
        }),
        onChange: () => () => {},
      },
      { publish: () => {} },
      errors,
      () => (models++ === 0 ? parentModel : childModel),
      {
        webSearch: () => undefined,
        readSource: async (source) => {
          reads.push(source);
          return {
            url: source,
            text: "Synthetic evidence",
            truncated: false,
            fetchedAt: new Date().toISOString(),
          };
        },
      },
    );
    runner.start();
    try {
      await vi.waitFor(
        async () => expect((await f.native.lookup(f.parent.id))?.status).toBe("completed"),
        { timeout: 10_000 },
      );
      expect(errors).not.toHaveBeenCalled();
      const runs = await f.control.listRuns(f.channel.id);
      expect(runs).toHaveLength(2);
      expect(runs.every((run) => run.status === "completed")).toBe(true);
      // Current limits are per Run. S6 requires a separate shared Task admission contract.
      // Replace with the selected aggregate limit when that control-owned port is integrated.
      expect(reads).toHaveLength(5);
      expect(parentModel.doGenerateCalls).toHaveLength(5);
      expect(childModel.doGenerateCalls).toHaveLength(3);
    } finally {
      await runner.stop();
    }
  });
});

async function addThirdBot() {
  const bot = await f.control.createBot({
    name: "S6 Writer",
    role: "Writer",
    computerProfile: "none",
  });
  await f.database
    .client`insert into channel_bots (channel_id, bot_id) values (${f.channel.id}, ${bot.id})`;
  return bot;
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};
function toolCall(toolName: string, input: unknown) {
  return {
    content: [
      {
        type: "tool-call" as const,
        toolCallId: "fixture-call",
        toolName,
        input: JSON.stringify(input),
      },
    ],
    usage,
    finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
    warnings: [],
  };
}
function answer(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    usage,
    finishReason: { unified: "stop" as const, raw: "stop" },
    warnings: [],
  };
}
