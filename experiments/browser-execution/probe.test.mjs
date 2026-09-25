import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { crc32, deflateSync } from "node:zlib";
import {
  CDPPipe,
  LIMITS,
  FORBIDDEN,
  chromeArgs,
  proof,
  domEvidence,
  pngEvidence,
  stage,
  page,
  captureDOM,
  capturePNG,
  sandboxProof,
  serialize,
} from "./probe.mjs";

function pair() {
  const write = new PassThrough(),
    read = new PassThrough(),
    sent = [];
  write.on("data", (b) => sent.push(JSON.parse(b.subarray(0, -1).toString())));
  const c = new CDPPipe(write, read);
  return { c, write, read, sent, reply: (v) => read.write(Buffer.from(JSON.stringify(v) + "\0")) };
}
const value = {
  synthetic: true,
  sum: 25,
  text: "a.b 你好",
  previous: false,
  cookiePrevious: false,
};
const dom = '<pre id="result">' + JSON.stringify(value) + "</pre>";
function png() {
  const chunk = (type, payload) => {
    const b = Buffer.alloc(payload.length + 12);
    b.writeUInt32BE(payload.length);
    b.write(type, 4);
    payload.copy(b, 8);
    b.writeUInt32BE(crc32(b.subarray(4, -4)), b.length - 4);
    return b;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1280);
  header.writeUInt32BE(800, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc(800 * (1 + 1280 * 4)))),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

test("split UTF-8/NUL frames and multiple responses retain correct ids and sessions", async () => {
  const p = pair(),
    a = p.c.call("Browser.getVersion"),
    b = p.c.call("Runtime.evaluate", {}, "session");
  const buffer = Buffer.from(
    JSON.stringify({ id: 2, sessionId: "session", result: { text: "你好" } }) +
      "\0" +
      JSON.stringify({ id: 1, result: { product: "Chrome/151.0.7922.34" } }) +
      "\0",
  );
  for (let i = 0; i < buffer.length; i += 3) p.read.write(buffer.subarray(i, i + 3));
  assert.deepEqual(await b, { text: "你好" });
  assert.equal((await a).product, "Chrome/151.0.7922.34");
  assert.equal(p.sent.length, 2);
  p.c.close();
});
test("wrong response session fails closed", async () => {
  const p = pair(),
    a = p.c.call("Runtime.evaluate", {}, "expected");
  p.reply({ id: 1, sessionId: "other", result: {} });
  await assert.rejects(a, { code: "pipe-session-mismatch" });
  assert.equal(p.c.closed, true);
});
test("protocol error is not a fabricated success", async () => {
  const p = pair(),
    a = p.c.call("Browser.getVersion");
  p.reply({ id: 1, error: { code: -32000, message: "untrusted message" } });
  await assert.rejects(a, { code: "cdp-protocol-error", protocolCode: -32000 });
  p.c.close();
});
test("timed-out request is not resent and late response does not resolve anything", async () => {
  const p = pair(),
    a = p.c.call("Browser.getVersion", {}, "", 5);
  await assert.rejects(a, { code: "cdp-timeout" });
  p.reply({ id: 1, result: { product: "late" } });
  assert.equal(p.sent.length, 1);
  assert.equal(p.c.pending.size, 0);
  p.c.close();
});
test("pipe closure rejects pending calls and lifecycle waiters", async () => {
  const p = pair(),
    a = p.c.call("Browser.getVersion"),
    b = p.c.loaded("s", "f", "l", 100);
  p.c.close("pipe-ended");
  await assert.rejects(a, { code: "pipe-ended" });
  await assert.rejects(b, { code: "pipe-ended" });
  assert.equal(p.c.pending.size, 0);
  assert.equal(p.c.waiters.size, 0);
});
test("malformed, invalid UTF-8 and oversized frames fail before JSON content is trusted", async () => {
  for (const bytes of [
    Buffer.from("{broken\0"),
    Buffer.from([0xff, 0]),
    Buffer.alloc(LIMITS.frame + 1, 65),
  ]) {
    const p = pair(),
      a = p.c.call("Browser.getVersion");
    p.read.write(bytes);
    await assert.rejects(a);
    assert.equal(p.c.closed, true);
  }
});
test("aggregate pipe/event storage is bounded", () => {
  const p = pair();
  for (let i = 0; i < 256; i++)
    p.reply({
      method: "Page.lifecycleEvent",
      sessionId: "s",
      params: { name: "init", frameId: "f", loaderId: String(i) },
    });
  assert.equal(p.c.events.length, 128);
  assert.equal(p.c.eventCounts["Page.lifecycleEvent"], 256);
  p.c.bytes = LIMITS.wire;
  p.read.write(Buffer.from("a"));
  assert.equal(p.c.reason, "pipe-total-bound");
});
test("navigation matches the actual target frame and loader, including an already received event", async () => {
  const p = pair();
  p.reply({
    method: "Page.lifecycleEvent",
    sessionId: "s",
    params: { name: "DOMContentLoaded", frameId: "f", loaderId: "old" },
  });
  const wait = p.c.loaded("s", "f", "new", 100);
  p.reply({
    method: "Page.lifecycleEvent",
    sessionId: "s",
    params: { name: "DOMContentLoaded", frameId: "f", loaderId: "new" },
  });
  assert.equal((await wait).loaderId, "new");
  assert.equal((await p.c.loaded("s", "f", "new", 100)).loaderId, "new");
  p.c.close();
});
test("launch uses only the existing private CDP pipe with no sandbox bypass or CLI aggregate", () => {
  const args = chromeArgs("/profiles/fixture");
  assert(args.includes("--remote-debugging-pipe"));
  assert(!args.some((a) => FORBIDDEN.some((f) => a === f || a.startsWith(f + "="))));
  for (const f of [
    "--remote-debugging-port",
    "--dump-dom",
    "--screenshot",
    "--virtual-time-budget",
    "--timeout",
  ])
    assert(!args.some((a) => a.startsWith(f)));
  assert.equal(LIMITS.totalMs, 65000);
  assert(LIMITS.workMs < LIMITS.evidenceMs && LIMITS.evidenceMs < LIMITS.totalMs);
  assert(LIMITS.totalMs < 75000);
});
test("actual fixed DOM and bounded PNG are retained independently", () => {
  assert.deepEqual(proof(dom), value);
  assert.throws(() => proof('<pre id="result">pending</pre>'));
  const d = domEvidence(dom),
    image = pngEvidence(png());
  assert.equal(d.text, dom);
  assert.equal(image.width, 1280);
  assert(image.bytes > 100);
  const corrupted = Buffer.from(png(), "base64");
  corrupted[30] ^= 1;
  assert.throws(() => pngEvidence(corrupted.toString("base64")));
  assert.throws(() => domEvidence("x".repeat(LIMITS.dom + 1)));
  assert.throws(() => pngEvidence("A".repeat(LIMITS.png * 2)));
  assert.throws(() => pngEvidence("bad!"));
});
test("PNG failure leaves already captured DOM and phase/error timing in the final failed record", async () => {
  const artifact = {},
    record = {
      origin: performance.now(),
      accepted: false,
      runs: [{ artifacts: { page: artifact } }],
      stages: [],
    };
  let calls = 0;
  const browser = {
    cdp: {
      call: async (method) => {
        calls++;
        if (method === "Runtime.evaluate")
          return { result: { value: { url: "http://127.0.0.1:4197/", dom } } };
        throw Object.assign(new Error(), { code: "cdp-timeout" });
      },
    },
  };
  await stage(record, "dom", () => captureDOM(browser, "s", artifact, performance.now() + 1000));
  await assert.rejects(
    stage(record, "png", () => capturePNG(browser, "s", artifact, performance.now() + 1000)),
    { code: "cdp-timeout" },
  );
  assert.equal(calls, 2);
  const retained = JSON.parse(serialize(record));
  assert.equal(retained.runs[0].artifacts.page.dom.text, dom);
  assert.equal(retained.stages[1].status, "failed");
  assert(retained.stages[1].elapsedMs >= 0);
  assert.equal(artifact.pngAttempted, true);
});
test("CDP DOM from an unexpected origin or script exception is rejected", async () => {
  for (const result of [
    { exceptionDetails: {} },
    { result: { value: { url: "https://outside.invalid/", dom } } },
  ])
    await assert.rejects(
      captureDOM({ cdp: { call: async () => result } }, "s", {}, performance.now() + 1000),
      { code: "dom-origin-or-evaluation" },
    );
});
test("inherited process seccomp does not substitute for all internal diagnostic fields", () => {
  assert.throws(() => sandboxProof("Seccomp-BPF sandbox Yes"));
  assert(
    sandboxProof(
      "Layer 1 Sandbox Namespace PID namespaces Yes Network namespaces Yes Seccomp-BPF sandbox Yes",
    ),
  );
});
test("result cap is failclosed and retains artifact hashes without unbounded bodies", () => {
  const artifact = {
    dom: { text: "a".repeat(LIMITS.result), bytes: LIMITS.result, sha256: "a".repeat(64) },
    png: { base64: "b".repeat(LIMITS.result), bytes: 1, sha256: "b".repeat(64) },
  };
  const value = JSON.parse(
    serialize({ accepted: true, runs: [{ artifacts: { page: artifact } }] }),
  );
  assert.equal(value.accepted, false);
  assert.equal(value.failure, "record-bound");
  assert.equal(value.runs[0].artifacts.page.dom.sha256, "a".repeat(64));
  assert(!value.runs[0].artifacts.page.png.base64);
});

test("failed navigation retains the actual attached diagnostic session for bounded evidence", async () => {
  const record = { origin: performance.now(), stages: [] };
  let bound = null;
  const browser = {
    cdp: {
      call: async (method) => {
        if (method === "Target.createTarget") return { targetId: "diagnostic-target" };
        if (method === "Target.attachToTarget") return { sessionId: "diagnostic-session" };
        if (method === "Page.navigate") throw Object.assign(new Error(), { code: "cdp-timeout" });
        return {};
      },
    },
  };
  await assert.rejects(
    page(
      record,
      browser,
      "sandbox",
      "chrome://sandbox",
      performance.now() + 1000,
      (s) => (bound = s),
    ),
    { code: "cdp-timeout" },
  );
  assert.equal(bound, "diagnostic-session");
  assert.equal(record.stages.at(-1).name, "sandbox.navigate");
  assert.equal(record.stages.at(-1).status, "failed");
});
