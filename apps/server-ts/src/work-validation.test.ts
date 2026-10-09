import { beforeEach, expect, it, vi } from "vitest";
import type { WorkDb, WorkTaskRow } from "./work-handoff.js";
import { currentWork, withCurrentWork, type WorkScope } from "./work-ledger.js";
const mocked = vi.hoisted(() => ({ accepted: vi.fn(), fence: vi.fn(), context: vi.fn() }));
vi.mock("./work-execution.js", () => ({
  acceptedWork: mocked.accepted,
  checkWorkFence: mocked.fence,
}));
vi.mock("./work-commands.js", () => ({ checkWorkContext: mocked.context }));
const task = { id: "task", bot_id: "bot" } as WorkTaskRow;
const scope = {
  binding: { input: { taskId: "task", runId: "run" } },
  fence: { runId: "run", claimId: "claim", epoch: 1 },
  contextId: "context",
} as WorkScope;
const db = (async () => [{ id: "bot" }]) as unknown as WorkDb;
beforeEach(() => {
  vi.resetAllMocks();
  mocked.accepted.mockResolvedValue(task);
  mocked.fence.mockResolvedValue(undefined);
  mocked.context.mockResolvedValue(undefined);
});
it("reuses only locked reads and rechecks authority after the validation pass", async () => {
  let escaped!: WorkScope;
  await withCurrentWork(db, scope, async (validation) => {
    escaped = validation;
    expect(await currentWork(db, validation)).toBe(task);
    expect(await currentWork(db, validation)).toBe(task);
    expect(mocked.accepted).toHaveBeenCalledTimes(1);
  });
  mocked.accepted.mockRejectedValueOnce(new Error("revoked"));
  await expect(currentWork(db, escaped)).rejects.toThrow("revoked");
  expect(mocked.accepted).toHaveBeenCalledTimes(2);
});
it("rejects expiry at the end and never reuses a Task in another transaction or after failure", async () => {
  let escaped!: WorkScope;
  mocked.fence.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("expired"));
  await expect(
    withCurrentWork(db, scope, async (validation) => {
      escaped = validation;
    }),
  ).rejects.toThrow("expired");
  await currentWork(db, escaped);
  expect(mocked.accepted).toHaveBeenCalledTimes(2);
  await withCurrentWork(db, scope, async (validation) => {
    const other = (async () => [{ id: "bot" }]) as unknown as WorkDb;
    await currentWork(other, validation);
  });
  expect(mocked.accepted).toHaveBeenCalledTimes(4);
});
