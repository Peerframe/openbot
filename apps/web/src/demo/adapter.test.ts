import { afterEach, describe, expect, it, vi } from "vitest";
import { DemoAdapter } from "./adapter";
import { demoArtifact, demoChannel, demoReport } from "./fixtures";

const demoOrigin = "https://demo.example";
const prefix = `/api/v1/channels/${demoChannel.id}`;
const instances: DemoAdapter[] = [];
function create() {
  const adapter = new DemoAdapter(demoOrigin);
  instances.push(adapter);
  return adapter;
}
afterEach(() => {
  for (const adapter of instances) adapter.dispose();
  instances.length = 0;
  vi.useRealTimers();
});

describe("isolated product demo transport", () => {
  it("returns empty receipts only for known synthetic Runs without exposing call mutations", async () => {
    const adapter = create();
    adapter.finish();
    const run = adapter.getSnapshot().runs[0];
    const path = `/api/v1/runs/${run?.id}/plugin-calls`;
    expect(await (await adapter.fetch(path)).json()).toEqual({ calls: [] });
    expect((await adapter.fetch(path, { method: "POST" })).status).toBe(403);
    expect((await adapter.fetch("/api/v1/runs/private/plugin-calls")).status).toBe(403);
  });
  it("has no fallback for foreign origins, unknown routes, media, plugins or real channels", async () => {
    const adapter = create();
    for (const url of [
      "https://real.example/api/v1/workspace",
      "//real.example/",
      `${demoOrigin}${prefix}/messages?token=private`,
    ])
      await expect(adapter.fetch(url)).rejects.toThrow();
    for (const path of [
      "/api/v1/workspace",
      "/api/v1/auth/session",
      "/api/v1/channels/real/messages",
      "/api/v1/plugins/secret/call",
    ])
      expect((await adapter.fetch(path)).status).toBe(403);
    expect(
      (await adapter.fetch(`${prefix}/attachments`, { method: "POST", body: new FormData() }))
        .status,
    ).toBe(403);
    expect(() => adapter.connect(new EventTarget(), "https://other.example/events")).toThrow();
    const abort = new AbortController();
    abort.abort();
    await expect(adapter.fetch(`${prefix}/messages`, { signal: abort.signal })).rejects.toThrow();
  });
  it("replays linked tasks, incremental events and a fixed deliverable, while pause and restart clear state", async () => {
    vi.useFakeTimers();
    const adapter = create();
    const source = new EventTarget();
    const outputs: Array<{ sequence: number; runId: string; text: string }> = [];
    source.addEventListener("run.output", (event) =>
      outputs.push(JSON.parse((event as MessageEvent<string>).data)),
    );
    adapter.connect(source, `${prefix}/events`);
    adapter.play();
    await vi.advanceTimersByTimeAsync(650 * 12);
    const tick = adapter.getSnapshot().tick;
    expect(tick).toBe(12);
    expect(outputs.length).toBeGreaterThan(2);
    adapter.pause();
    await vi.advanceTimersByTimeAsync(5000);
    expect(adapter.getSnapshot().tick).toBe(tick);
    adapter.finish();
    expect(adapter.getSnapshot().runs).toHaveLength(3);
    expect(adapter.getSnapshot().runs.every((run) => run.status === "completed")).toBe(true);
    expect(
      adapter.getSnapshot().runs.filter((run) => run.parentRunId === "demo-root"),
    ).toHaveLength(2);
    expect(adapter.download(`/api/v1/artifacts/${demoArtifact.id}/content`)?.content).toBe(
      demoReport,
    );
    expect(adapter.download("/api/v1/artifacts/real/content")).toBeUndefined();
    const research = outputs.filter((output) => output.runId === "demo-research-task");
    expect(research.map((item) => item.sequence)).toEqual(research.map((_, index) => index + 1));
    adapter.restart();
    expect(adapter.getSnapshot().messages).toHaveLength(1);
    expect(adapter.getSnapshot().runs).toEqual([]);
    expect(adapter.getSnapshot().artifacts).toEqual([]);
    expect(adapter.download(`/api/v1/artifacts/${demoArtifact.id}/content`)).toBeUndefined();
  });
  it("supports actual reply and reaction API contracts without inferring model output", async () => {
    vi.useFakeTimers();
    const adapter = create();
    adapter.finish();
    const submitted = await (
      await adapter.fetch(`${prefix}/messages`, {
        method: "POST",
        body: JSON.stringify({
          content: "请补充说明",
          botId: "demo-research",
          replyToMessageId: "demo-final",
        }),
      })
    ).json();
    expect(submitted.message.replyToMessageId).toBe("demo-final");
    expect(submitted.run.botId).toBe("demo-research");
    await vi.advanceTimersByTimeAsync(650 * 7);
    expect(adapter.getSnapshot().messages.at(-1)?.content).toContain("不");
    expect(adapter.getSnapshot().messages.at(-1)?.replyToMessageId).toBe(submitted.message.id);
    const path = `${prefix}/messages/demo-final/reactions`;
    const set = (active: boolean) =>
      adapter.fetch(path, { method: "PUT", body: JSON.stringify({ emoji: "👍", active }) });
    await set(true);
    const reaction = await (await set(true)).json();
    expect(reaction.reactions).toHaveLength(1);
    expect((await (await set(false)).json()).reactions).toEqual([]);
    expect(
      (await adapter.fetch(path, { method: "PUT", body: '{"emoji":"evil","active":true}' })).status,
    ).toBe(400);
  });
  it("preserves all explicitly selected demo Bot identities", async () => {
    const adapter = create();
    const result = await (
      await adapter.fetch(`${prefix}/messages`, {
        method: "POST",
        body: JSON.stringify({
          content: "Review together",
          botIds: ["demo-research", "demo-review"],
        }),
      })
    ).json();
    expect([result.run, ...result.runs].map((run: { botId: string }) => run.botId)).toEqual([
      "demo-research",
      "demo-review",
    ]);
    expect(
      (
        await adapter.fetch(`${prefix}/messages`, {
          method: "POST",
          body: JSON.stringify({ content: "Wrong identity", botIds: ["real-bot"] }),
        })
      ).status,
    ).toBe(400);
  });
  it("cancellation does not publish a later scheduled final result", async () => {
    const adapter = create();
    for (let index = 0; index < 8; index++) adapter.advance();
    await adapter.fetch("/api/v1/runs/demo-root/cancel", { method: "POST", body: "{}" });
    adapter.finish();
    expect(adapter.getSnapshot().runs.every((run) => run.status === "cancelled")).toBe(true);
    expect(adapter.getSnapshot().messages.some((message) => message.id === "demo-final")).toBe(
      false,
    );
    expect(adapter.getSnapshot().artifacts).toEqual([]);
  });
});
