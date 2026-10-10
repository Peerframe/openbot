/** The qualification controller must stop actual pollers, preserve pause on process restart, and drain once. */
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Worker } from "@temporalio/worker";
import { restartableBrowserWorker } from "./browser-worker-restart.ts";

function fixture(initialPause = false) {
  let paused = initialPause,
    stopped = 0,
    resumed = 0;
  const workers: { polls: number; stops: number; state: ReturnType<Worker["getState"]> }[] = [];
  const create = () => {
    const state = { polls: 0, stops: 0, state: "INITIALIZED" as ReturnType<Worker["getState"]> };
    workers.push(state);
    let finish!: () => void;
    return {
      run: () => {
        state.polls++;
        assert.equal(state.state, "INITIALIZED");
        state.state = "RUNNING";
        return new Promise<void>((resolve) => {
          finish = () => {
            state.state = "STOPPED";
            resolve();
          };
        });
      },
      shutdown: () => {
        assert.equal(state.state, "RUNNING");
        state.stops++;
        finish();
      },
      getState: () => state.state,
    };
  };
  const first = create(),
    wrapper = restartableBrowserWorker(first, async () => create(), {
      paused: async () => paused,
      stopped: async () => {
        assert(workers.every((w) => w.state === "STOPPED"));
        stopped++;
      },
      resumed: async () => {
        assert.equal(workers.at(-1)?.state, "RUNNING");
        resumed++;
      },
    });
  return {
    workers,
    wrapper,
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
    counts: () => ({ stopped, resumed }),
  };
}
async function until(check: () => boolean) {
  const limit = performance.now() + 3000;
  while (!check()) {
    assert(performance.now() < limit);
    await delay(10);
  }
}
test("pause shuts down the original SDK worker before approval; resume creates exactly one replacement", async () => {
  const f = fixture(),
    running = f.wrapper.run();
  assert.equal(f.wrapper.run(), running);
  try {
    await until(() => f.workers[0]?.state === "RUNNING");
    f.pause();
    await until(() => f.counts().stopped === 1);
    assert.equal(f.wrapper.getState(), "RUNNING");
    await delay(160);
    assert.equal(f.workers.length, 1);
    f.resume();
    await until(() => f.counts().resumed === 1);
    assert.equal(f.workers.length, 2);
    assert.deepEqual(
      f.workers.map((w) => w.polls),
      [1, 1],
    );
  } finally {
    f.wrapper.shutdown();
    await running;
  }
  assert.deepEqual(
    f.workers.map((w) => w.stops),
    [1, 1],
  );
});
test("a restarted control process observes the pending pause before signaling that worker stopped", async () => {
  const f = fixture(true),
    running = f.wrapper.run();
  try {
    await until(() => f.counts().stopped === 1);
    assert.equal(f.workers.length, 1);
    assert.equal(f.workers[0]?.state, "STOPPED");
  } finally {
    f.wrapper.shutdown();
    await running;
  }
  assert.equal(f.counts().resumed, 0);
  assert.equal(f.workers.length, 1);
});
test("shutdown while paused drains without creating a replacement", async () => {
  const f = fixture(),
    running = f.wrapper.run();
  f.pause();
  await until(() => f.counts().stopped === 1);
  f.wrapper.shutdown();
  await running;
  f.resume();
  await delay(160);
  assert.equal(f.workers.length, 1);
  assert.equal(f.wrapper.getState(), "STOPPED");
});
test("unexpected SDK run failure is preserved and never recreated", async () => {
  let creates = 0;
  const failure = new Error("owned SDK failed");
  const worker = restartableBrowserWorker(
    {
      run: async () => {
        throw failure;
      },
      shutdown() {},
      getState: () => "FAILED" as const,
    },
    async () => {
      creates++;
      throw Error("Must not retry");
    },
    { paused: async () => false, stopped: async () => {}, resumed: async () => {} },
  );
  await assert.rejects(worker.run(), (error) => error === failure);
  assert.equal(creates, 0);
});
