import { pluginCallReceiptListSchema } from "@openbot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { demoArtifact, demoChannel, demoReport } from "../demo/fixtures";
import { ClientFixtureAdapter, clientScenarios, fixtureRunId } from "./adapter";

const adapters: ClientFixtureAdapter[] = [];
function create(scenario: ConstructorParameters<typeof ClientFixtureAdapter>[1] = "approval") {
  const adapter = new ClientFixtureAdapter("https://fixture.example", scenario);
  adapters.push(adapter);
  return adapter;
}
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.dispose();
});
const prefix = `/api/v1/channels/${demoChannel.id}`;

describe("isolated shared-client scenarios", () => {
  it("exposes only schema-valid synthetic receipt reads and resets failure without replay", async () => {
    const adapter = create("plugin-receipts");
    const path = `/api/v1/runs/${fixtureRunId}/plugin-calls`;
    const result = pluginCallReceiptListSchema.parse(await (await adapter.fetch(path)).json());
    expect(result.calls.map((call) => call.state)).toEqual([
      "outcome_unknown",
      "response_received",
    ]);
    expect(adapter.getSnapshot().runs[0]?.status).toBe("cancelled");
    expect((await adapter.fetch(path, { method: "POST" })).status).toBe(403);
    adapter.toggleReceiptReadFailure();
    expect((await adapter.fetch(path)).status).toBe(503);
    adapter.toggleReceiptReadFailure();
    expect(await (await adapter.fetch(path)).json()).toEqual(result);
    for (const { id } of clientScenarios.filter(({ id }) => id !== "plugin-receipts")) {
      adapter.load(id);
      expect(await (await adapter.fetch(path)).json()).toEqual({ calls: [] });
    }
  });
  it("retains fail-closed transport for foreign URLs, credentials and unknown capabilities", async () => {
    const adapter = create();
    for (const path of [
      "https://other.example/api/v1/auth/session",
      `${prefix}/messages?secret=value`,
    ])
      await expect(adapter.fetch(path)).rejects.toThrow();
    for (const path of [
      "/api/v1/auth/session",
      "/api/v1/workspace",
      "/api/v1/model-settings",
      "/api/v1/plugins/secret",
    ])
      expect((await adapter.fetch(path)).status).toBe(403);
    expect(
      (
        await adapter.fetch(`${prefix}/messages`, {
          method: "POST",
          body: '{"content":"do real work"}',
        })
      ).status,
    ).toBe(403);
    expect(() => adapter.load("unknown" as never)).toThrow();
  });
  it.each(["approve", "reject"])(
    "consumes synthetic %s once without dispatching any external action",
    async (decision) => {
      const adapter = create();
      const request = () =>
        adapter.fetch("/api/v1/approvals/fixture-approval/decision", {
          method: "POST",
          body: JSON.stringify({ decision }),
        });
      expect((await request()).status).toBe(200);
      expect((await request()).status).toBe(409);
      expect(adapter.getSnapshot().runs[0]?.status).toBe(
        decision === "approve" ? "completed" : "cancelled",
      );
      expect(adapter.getSnapshot().messages).toHaveLength(decision === "approve" ? 2 : 1);
    },
  );
  it("isolates resets and withholds artifacts from every unfinished scenario", () => {
    const adapter = create("artifacts");
    expect(adapter.download(`/api/v1/artifacts/${demoArtifact.id}/content`)?.content).toBe(
      demoReport,
    );
    for (const { id } of clientScenarios.filter(({ id }) => id !== "artifacts")) {
      adapter.load(id);
      expect(adapter.getSnapshot().artifacts).toEqual([]);
      expect(adapter.download(`/api/v1/artifacts/${demoArtifact.id}/content`)).toBeUndefined();
      expect(adapter.getSnapshot().messages).toHaveLength(1);
      expect(adapter.getSnapshot().playing).toBe(false);
    }
  });
  it("stops the real fixture cancellation path and retains the terminal state after late output", async () => {
    const adapter = create("cancellation");
    const response = await adapter.fetch(`/api/v1/runs/${fixtureRunId}/cancel`, {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(200);
    adapter.emitLateOutput();
    adapter.advanceOutput();
    expect(adapter.getSnapshot().runs[0]?.status).toBe("cancelled");
    expect(adapter.getSnapshot().artifacts).toEqual([]);
    expect(await (await adapter.fetch(`/api/v1/runs/${fixtureRunId}/output`)).json()).toEqual({
      output: null,
    });
  });
  it("recovers missed final state through existing reads after an offline period", async () => {
    const adapter = create("reconnect");
    const source = new EventTarget();
    const events: string[] = [];
    for (const name of ["message.created", "run.updated"])
      source.addEventListener(name, () => events.push(name));
    adapter.connect(source, `${prefix}/events`);
    adapter.disconnect();
    adapter.completeOffline();
    expect(events).toEqual([]);
    expect((await adapter.fetch(`${prefix}/messages`)).status).toBe(503);
    adapter.reconnect();
    expect((await (await adapter.fetch(`${prefix}/messages`)).json()).messages).toHaveLength(2);
    expect(adapter.getSnapshot().runs[0]?.status).toBe("completed");
  });
});
