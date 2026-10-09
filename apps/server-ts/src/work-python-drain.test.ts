import assert from "node:assert/strict";
import { type Client, WorkflowNotFoundError } from "@openbot/work";
import { it } from "vitest";
import { closedPythonWorkflow } from "./work-python-drain.js";

const workflowId = "openbot-work-v1-original",
  queue = "legacy-queue",
  signal = () => AbortSignal.timeout(3000);
function fixture() {
  const info = {
    execution: { workflowId, runId: "last-run" },
    firstRunId: "first-run",
    taskQueue: queue,
    type: { name: "OpenBotWorkV1" },
    status: 2,
    closeTime: { seconds: 100, nanos: 0 },
    historyLength: "4",
  };
  const event = {
    eventType: 2,
    eventId: "4",
    eventTime: info.closeTime,
    workflowExecutionCompletedEventAttributes: {},
  };
  const response = { history: { events: [event] }, nextPageToken: new Uint8Array(0) };
  let calls = 0;
  const state = { info, response, fail: undefined as Error | undefined, changed: false };
  const client = {
    options: { namespace: "fixture" },
    withAbortSignal: async (abort: AbortSignal, operation: () => Promise<unknown>) => {
      abort.throwIfAborted();
      return operation();
    },
    withDeadline: async (_deadline: number, operation: () => Promise<unknown>) => operation(),
    workflow: {
      getHandle: () => ({
        describe: async () => {
          if (state.fail) throw state.fail;
          calls++;
          return {
            raw: {
              workflowExecutionInfo: {
                ...state.info,
                execution: {
                  ...state.info.execution,
                  ...(state.changed && calls > 1 ? { runId: "replacement-run" } : {}),
                },
              },
            },
          };
        },
      }),
    },
    workflowService: { getWorkflowExecutionHistory: async () => state.response },
  } as unknown as Client;
  return { state, client };
}
it("uses latest single-ID state and a stable terminal event; never accepts a chain continuation", async () => {
  const { client, state } = fixture();
  assert.equal(
    await closedPythonWorkflow(client, workflowId, queue, signal(), "first-run"),
    "closed",
  );
  state.info.status = 1;
  assert.equal(await closedPythonWorkflow(client, workflowId, queue, signal()), "running");
  state.info.status = 6;
  assert.equal(await closedPythonWorkflow(client, workflowId, queue, signal()), "running");
  state.info.status = 2;
  await assert.rejects(closedPythonWorkflow(client, workflowId, "wrong-queue", signal()));
  await assert.rejects(closedPythonWorkflow(client, workflowId, queue, signal(), "other-chain"));
  state.response.nextPageToken = new Uint8Array([1]);
  await assert.rejects(closedPythonWorkflow(client, workflowId, queue, signal()));
  state.response.nextPageToken = new Uint8Array(0);
  state.response.history.events[0]!.workflowExecutionCompletedEventAttributes = {
    newExecutionRunId: "future-run",
  };
  await assert.rejects(closedPythonWorkflow(client, workflowId, queue, signal()));
  state.response.history.events[0]!.workflowExecutionCompletedEventAttributes = {};
  const race = fixture();
  race.state.changed = true;
  await assert.rejects(closedPythonWorkflow(race.client, workflowId, queue, signal()));
});
it("distinguishes a proved absent execution from outages, timeout and malformed history", async () => {
  const { client, state } = fixture();
  state.fail = new WorkflowNotFoundError("missing", workflowId);
  assert.equal(await closedPythonWorkflow(client, workflowId, queue, signal()), "missing");
  state.fail = new Error("Unavailable");
  await assert.rejects(closedPythonWorkflow(client, workflowId, queue, signal()));
  state.fail = undefined;
  state.response.history.events = [];
  await assert.rejects(closedPythonWorkflow(client, workflowId, queue, signal()));
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(closedPythonWorkflow(client, workflowId, queue, cancelled.signal));
});
