import assert from "node:assert/strict";
import { test } from "node:test";
import { subscribeWorkspace } from "./reader.mjs";

class Source {
  static latest;
  constructor() {
    Source.latest = this;
  }
  addEventListener(_type, listener) {
    this.listener = listener;
  }
  close() {
    this.closed = true;
  }
  emit(sequence, streamId = "first", version = 1) {
    this.listener({
      data: JSON.stringify({
        type: "workspace.snapshot",
        version,
        streamId,
        sequence,
        snapshot: {
          channels: [],
          bots: [],
          nodes: [],
          runs: [],
          approvals: [],
          artifacts: [],
          progress: [],
          counts: { channels: 0, bots: 0, connectedNodes: 0, activeRuns: 78 },
        },
      }),
    });
  }
}

test("replaces full snapshots, ignores duplicate and older frames, recovers after reconnect", () => {
  const snapshots = [];
  const states = [];
  const stop = subscribeWorkspace({
    EventSourceImpl: Source,
    onSnapshot: (v) => snapshots.push(v),
    onState: (v) => states.push(v),
  });
  const source = Source.latest;
  source.onopen();
  source.emit(1);
  source.emit(1);
  source.emit(3);
  source.emit(2);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].counts.activeRuns, 78);
  assert.equal(snapshots[0].runs.length, 0);
  source.onerror();
  assert.equal(states.at(-1), "stale");
  source.onopen();
  source.emit(1, "second");
  assert.equal(snapshots.length, 3);
  assert.equal(states.at(-1), "current");
  stop();
  source.emit(2, "second");
  assert.equal(snapshots.length, 3);
  assert.ok(source.closed);
});

test("unknown contract fails visibly and closes instead of applying a partial projection", () => {
  const states = [];
  subscribeWorkspace({
    EventSourceImpl: Source,
    onSnapshot: () => assert.fail("must not project"),
    onState: (v) => states.push(v),
  });
  Source.latest.emit(1, "first", 2);
  assert.ok(Source.latest.closed);
  assert.equal(states.at(-1), "incompatible");
});

test("a silent proxy marks the view stale and reconnects without accepting late old-source frames", () => {
  const callbacks = new Map();
  let next = 0;
  const timers = {
    set(callback, delay) {
      const id = ++next;
      callbacks.set(id, { callback, delay });
      return id;
    },
    clear(id) {
      callbacks.delete(id);
    },
  };
  const fire = (delay) => {
    const [id, value] = [...callbacks].find(([, value]) => value.delay === delay);
    callbacks.delete(id);
    value.callback();
  };
  const states = [];
  const snapshots = [];
  const stop = subscribeWorkspace({
    EventSourceImpl: Source,
    timers,
    onSnapshot: (v) => snapshots.push(v),
    onState: (v) => states.push(v),
  });
  const old = Source.latest;
  old.onopen();
  old.emit(1);
  fire(35_000);
  assert.equal(states.at(-1), "stale");
  assert.ok(old.closed);
  fire(2000);
  const fresh = Source.latest;
  assert.notEqual(fresh, old);
  old.emit(9);
  assert.equal(snapshots.length, 1);
  fresh.onopen();
  fresh.emit(1, "fresh");
  assert.equal(states.at(-1), "current");
  assert.equal(snapshots.length, 2);
  stop();
  assert.equal(callbacks.size, 0);
});
