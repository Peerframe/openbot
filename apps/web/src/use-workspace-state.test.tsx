// @vitest-environment jsdom
import type { Run, WorkspaceSnapshot } from "@openbot/domain";
import { act, StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deferred,
  interact,
  type RenderedComponent,
  renderComponent,
} from "./test/render-component";
import { useWorkspaceState } from "./use-workspace-state";

const createdAt = "2026-09-22T00:00:00.000Z";
const oldRun: Run = {
  id: "off-page",
  channelId: "channel",
  botId: "bot",
  executionProfile: "none",
  instruction: "Synthetic count reconciliation",
  status: "running",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: createdAt,
};
function snapshot(activeRuns = 7): WorkspaceSnapshot {
  return {
    channels: [],
    bots: [],
    nodes: [],
    approvals: [],
    artifacts: [],
    progress: [],
    // These 50 newer completed records intentionally omit all globally active Runs.
    runs: Array.from({ length: 50 }, (_, index) => ({
      ...oldRun,
      id: `recent-${index}`,
      status: "completed",
      createdAt,
    })),
    counts: { channels: 0, bots: 0, connectedNodes: 0, activeRuns },
  };
}
type Read = ReturnType<typeof deferred<Response>> & { signal: AbortSignal | undefined };
let reads: Read[];
let rendered: RenderedComponent | undefined;
let controls: ReturnType<typeof useWorkspaceState>;
function WorkspaceConsumer() {
  const [error, setError] = useState<string>();
  controls = useWorkspaceState(setError);
  return (
    <>
      <output aria-label="global active runs">{controls.workspace?.counts.activeRuns}</output>
      <output aria-label="recent runs">
        {controls.workspace?.runs.map((run) => `${run.id}:${run.status}`).join(",")}
      </output>
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  reads = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      // Ignore abort deliberately: request ownership must reject late completions too.
      const read = { ...deferred<Response>(), signal: init?.signal ?? undefined };
      reads.push(read);
      return read.promise;
    }),
  );
});
afterEach(async () => {
  await rendered?.unmount();
  rendered = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function mount(initial = snapshot(), strict = false) {
  rendered = await renderComponent(
    strict ? (
      <StrictMode>
        <WorkspaceConsumer />
      </StrictMode>
    ) : (
      <WorkspaceConsumer />
    ),
  );
  await resolve(reads.length - 1, initial);
}
async function resolve(index: number, value: WorkspaceSnapshot) {
  await interact(() => reads[index]?.resolve(Response.json(value)));
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function count() {
  return rendered?.container.querySelector('[aria-label="global active runs"]')?.textContent;
}

describe("authoritative workspace global counts", () => {
  it.each(["running", "completed"] as const)(
    "reconciles an off-page %s event without estimating its previous global membership",
    async (status) => {
      await mount();
      await interact(() => controls.projectRun({ ...oldRun, status }));
      expect(count()).toBe("7");
      expect(controls.workspace?.runs).toHaveLength(50);
      expect(controls.workspace?.runs.some((run) => run.id === oldRun.id)).toBe(false);
      await advance(1000);
      expect(reads).toHaveLength(2);
      await resolve(1, snapshot(status === "running" ? 7 : 6));
      expect(count()).toBe(status === "running" ? "7" : "6");
      await advance(10_000);
      expect(reads).toHaveLength(2);
    },
  );

  it("coalesces duplicate channel/workspace projections and a synchronous burst into one read", async () => {
    await mount();
    await interact(() => {
      for (let index = 0; index < 200; index++) controls.projectRun(oldRun);
    });
    expect(count()).toBe("7");
    await advance(999);
    expect(reads).toHaveLength(1);
    await advance(1);
    expect(reads).toHaveLength(2);
    expect(reads[1]?.signal?.aborted).toBe(false);
    await resolve(1, snapshot());
    await advance(5000);
    expect(reads).toHaveLength(2);
    expect(count()).toBe("7");
  });

  it("never adds a replayed event to a Server count that already includes it", async () => {
    await mount();
    await interact(() => {
      void controls.refresh();
    });
    await interact(() => controls.projectRun(oldRun));
    await resolve(1, snapshot(7));
    expect(count()).toBe("7");
    await advance(1000);
    expect(reads).toHaveLength(3);
    await resolve(2, snapshot(7));
    expect(count()).toBe("7");
    await advance(5000);
    expect(reads).toHaveLength(3);
  });

  it("keeps entities immediate and queues one follow-up for any number of invalidations during a slow read", async () => {
    const initial = snapshot(8);
    const live = { ...oldRun, id: "visible", createdAt, status: "running" as const };
    initial.runs = [live];
    await mount(initial);
    await interact(() => controls.projectRun(live));
    await advance(1000);
    expect(reads).toHaveLength(2);
    const completed = {
      ...live,
      status: "completed" as const,
      updatedAt: "2026-09-22T00:00:02.000Z",
    };
    await interact(() => {
      for (let index = 0; index < 200; index++) controls.projectRun(completed);
    });
    expect(rendered?.container.textContent).toContain("visible:completed");
    expect(count()).toBe("8");
    await advance(5000);
    expect(reads).toHaveLength(2);
    expect(reads[1]?.signal?.aborted).toBe(false);
    await resolve(1, initial);
    expect(rendered?.container.textContent).toContain("visible:completed");
    expect(count()).toBe("8");
    await advance(0);
    expect(reads).toHaveLength(3);
    await resolve(2, {
      ...initial,
      runs: [completed],
      counts: { ...initial.counts, activeRuns: 7 },
    });
    expect(count()).toBe("7");
    await advance(10_000);
    expect(reads).toHaveLength(3);
  });

  it("spaces event-driven reads even when responses settle immediately", async () => {
    await mount();
    await interact(() => controls.projectRun(oldRun));
    await advance(1000);
    await interact(() => controls.projectRun({ ...oldRun, status: "completed" }));
    await resolve(1, snapshot());
    await advance(999);
    expect(reads).toHaveLength(2);
    await advance(1);
    expect(reads).toHaveLength(3);
    await resolve(2, snapshot(6));
    expect(count()).toBe("6");
  });

  it("retains data and reports failure without automatically retrying the dirty read", async () => {
    await mount();
    await interact(() => controls.projectRun(oldRun));
    await advance(1000);
    const completed = {
      ...oldRun,
      id: "visible",
      createdAt: "2026-09-22T00:00:03.000Z",
      status: "completed" as const,
    };
    await interact(() => controls.projectRun(completed));
    await interact(() => reads[1]?.reject(new Error("Synthetic count read unavailable")));
    expect(count()).toBe("7");
    expect(rendered?.container.textContent).toContain("visible:completed");
    expect(rendered?.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Synthetic count read unavailable",
    );
    await advance(10_000);
    expect(reads).toHaveLength(2);
    // Even the same external event can recover after a failure; no permanent dedup cache.
    await interact(() => controls.projectRun(oldRun));
    await advance(0);
    expect(reads).toHaveLength(3);
    await resolve(2, snapshot(6));
    expect(count()).toBe("6");
    expect(rendered?.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("lets explicit refresh consume a queued invalidation and supersede an in-flight read", async () => {
    await mount();
    await interact(() => controls.projectRun(oldRun));
    await interact(() => {
      void controls.refresh();
    });
    expect(reads).toHaveLength(2);
    await advance(1000);
    expect(reads).toHaveLength(2);
    await interact(() => controls.projectRun(oldRun));
    await interact(() => {
      void controls.refresh();
    });
    expect(reads).toHaveLength(3);
    expect(reads[1]?.signal?.aborted).toBe(true);
    await resolve(2, snapshot(6));
    await resolve(1, snapshot(99));
    expect(count()).toBe("6");
    await advance(10_000);
    expect(reads).toHaveLength(3);
  });

  it.each([false, true])(
    "cleans up scheduled and in-flight reconciliation on unmount (in flight: %s)",
    async (inFlight) => {
      await mount(snapshot(), true);
      expect(reads[0]?.signal?.aborted).toBe(true);
      await interact(() => controls.projectRun(oldRun));
      if (inFlight) await advance(1000);
      const total = reads.length;
      const pending = reads.at(-1);
      await rendered?.unmount();
      rendered = undefined;
      if (inFlight) {
        expect(pending?.signal?.aborted).toBe(true);
        await interact(() => pending?.reject(new Error("late failure")));
      }
      await advance(10_000);
      expect(reads).toHaveLength(total);
      expect(document.body.textContent).toBe("");
    },
  );
});
