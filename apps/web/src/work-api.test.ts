// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { workFixture } from "./test/work-fixture";
import { cancelWorkTask, createWorkTask, getWorkTask } from "./work-api";

afterEach(() => vi.unstubAllGlobals());
it("uses the work paths, same-origin session, bounded signals and exact explicit input", async () => {
  const fetcher = vi.fn(async () => Response.json(workFixture()));
  vi.stubGlobal("fetch", fetcher);
  const signal = new AbortController().signal;
  const input = {
    botId: "bot-one",
    objective: "objective",
    tokenLimit: 10,
    requestKey: "same-key",
  };
  await createWorkTask(input, signal);
  await getWorkTask("task-one", signal);
  await cancelWorkTask("task-one", signal);
  expect(fetcher.mock.calls).toEqual([
    [
      "/api/v1/tasks",
      {
        credentials: "include",
        cache: "no-store",
        signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    ],
    ["/api/v1/tasks/task-one", { credentials: "include", cache: "no-store", signal }],
    [
      "/api/v1/tasks/task-one/cancel",
      {
        credentials: "include",
        cache: "no-store",
        signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    ],
  ]);
});
it("invalidates the existing session on 401 without exposing server diagnostics", async () => {
  const listener = vi.fn();
  window.addEventListener("openbot:unauthorized", listener);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ detail: "private detail" }, { status: 401 })),
  );
  try {
    await expect(getWorkTask("task-one", new AbortController().signal)).rejects.toThrow(
      "Work request failed (401).",
    );
    expect(listener).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener("openbot:unauthorized", listener);
  }
});
it.each([{ status: "success" }, { cancelRequested: "false" }, { revision: -1 }, { id: "other" }])(
  "rejects incompatible or wrong-task snapshots %j",
  async (change) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ...workFixture(), ...change })),
    );
    await expect(getWorkTask("task-one", new AbortController().signal)).rejects.toThrow();
  },
);
