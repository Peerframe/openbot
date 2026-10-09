import { describe, expect, it } from "vitest";
import {
  EngineAlreadyStarted,
  type EnginePort,
  type EngineStart,
  type HandoffPort,
  WORKFLOW_TYPE,
  type WorkStart,
  workStart,
} from "./contracts.js";
import { dispatchOne } from "./handoff.js";

const identity = { taskId: "task", runId: "run" };
const settings = { namespace: "fixture", taskQueue: "ts-only", executionTimeoutMs: 60_000 };
function fixture() {
  let attempt: string | null = null;
  let accepted = false;
  let starts = 0;
  let event: EngineStart | null = null;
  const handoff: HandoffPort = {
    unconfirmed: async () =>
      attempt && !accepted
        ? { engineReference: "temporal:fixture:openbot-work-ts-v1-run", attemptId: attempt }
        : null,
    reserve: async () => {
      if (attempt) return { shouldStart: false, attemptId: attempt };
      attempt = "a".repeat(32);
      return { shouldStart: true, attemptId: attempt };
    },
    acknowledge: async () => {
      const first = !accepted;
      accepted = true;
      return first;
    },
  };
  const engine: EnginePort = {
    namespace: "fixture",
    start: async (_id, input) => {
      starts++;
      event = { workflowType: WORKFLOW_TYPE, taskQueue: "ts-only", firstRunId: "first", input };
    },
    inspectStart: async () => event,
  };
  return {
    handoff,
    engine,
    starts: () => starts,
    accepted: () => accepted,
    setEvent: (value: EngineStart | null) => {
      event = value;
    },
  };
}

describe("single-attempt Temporal handoff", () => {
  it("recovers a lost start reply by history lookup without resubmission", async () => {
    const f = fixture();
    const send = f.engine.start;
    f.engine.start = async (...args) => {
      await send(...args);
      throw new Error("lost reply");
    };
    await expect(dispatchOne(identity, settings, f.handoff, f.engine)).rejects.toThrow(
      "lost reply",
    );
    expect(f.accepted()).toBe(false);
    expect(await dispatchOne(identity, settings, f.handoff, f.engine)).toEqual({
      acknowledged: true,
      startRequested: false,
      reason: "acknowledged",
    });
    expect(f.starts()).toBe(1);
    expect((await dispatchOne(identity, settings, f.handoff, f.engine)).reason).toBe(
      "already_acknowledged",
    );
    expect(f.starts()).toBe(1);
  });
  it("leaves an unobserved start unresolved on every redelivery", async () => {
    const f = fixture();
    f.engine.start = async () => {
      throw new Error("lost before receipt");
    };
    await expect(dispatchOne(identity, settings, f.handoff, f.engine)).rejects.toThrow();
    for (let n = 0; n < 3; n++)
      expect(await dispatchOne(identity, settings, f.handoff, f.engine)).toEqual({
        acknowledged: false,
        startRequested: false,
        reason: "unconfirmed_missing_history",
      });
    expect(f.accepted()).toBe(false);
  });
  it.each(["attempt", "task", "queue", "type", "first"])(
    "refuses a duplicate workflow with different %s",
    async (mismatch) => {
      const f = fixture();
      f.engine.start = async (_id, input) => {
        f.setEvent({
          workflowType: mismatch === "type" ? "Other" : WORKFLOW_TYPE,
          taskQueue: mismatch === "queue" ? "python-only" : "ts-only",
          firstRunId: mismatch === "first" ? "" : "first",
          input: {
            ...input,
            taskId: mismatch === "task" ? "other" : input.taskId,
            attemptId: mismatch === "attempt" ? "b".repeat(32) : input.attemptId,
          },
        });
        throw new EngineAlreadyStarted();
      };
      expect((await dispatchOne(identity, settings, f.handoff, f.engine)).reason).toBe(
        "unconfirmed_start_event_mismatch",
      );
      expect(f.accepted()).toBe(false);
    },
  );
  it("refuses missing provenance without starting", async () => {
    const f = fixture();
    f.handoff.reserve = async () => ({ shouldStart: true, attemptId: null });
    expect((await dispatchOne(identity, settings, f.handoff, f.engine)).reason).toBe(
      "unconfirmed_attempt_unbound",
    );
    expect(f.starts()).toBe(0);
  });
  it("validates exact bounded start shape before transport", () => {
    const valid = { ...identity, attemptId: "a".repeat(32) };
    expect(workStart(valid)).toEqual(valid);
    for (const value of [
      { ...valid, token: "untrusted" },
      { ...valid, attemptId: "x" },
      { ...valid, taskId: "\0" },
    ])
      expect(() => workStart(value as WorkStart)).toThrow();
  });
});
