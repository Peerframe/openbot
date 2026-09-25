/**
 * bounded-json-transport.test.mjs
 *
 * Executable tests for bounded-json-transport.mjs using Node's built-in test
 * runner and assert. All fixtures are synthetic Duplex streams owned by this
 * test; no existing socket is connected and no port is opened.
 *
 * Run with:  node --test bounded-json-transport.test.mjs
 */

import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import test from "node:test";

import {
  attachJsonTransport,
  TRANSPORT_CODES as CODES,
  TransportError,
} from "./bounded-json-transport.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle() {
  await tick();
  await tick();
  await tick();
}

/** Wait for a real stream to report 'close' without hanging the suite. */
async function waitForClose(socket, rounds = 50) {
  for (let i = 0; i < rounds && socket.closed !== true; i += 1) await tick();
  return socket.closed === true;
}

/**
 * A controllable synthetic Duplex standing in for an owned connected socket.
 *   - feed(bytes) injects peer -> transport bytes on the readable side
 *   - endInput()  injects clean EOF
 *   - written[]   records transport -> peer frames
 *   - autoWriteCallback:false holds _write callbacks until releaseWrite()
 *   - syncWriteCallback:true calls the _write callback synchronously
 *   - forceWriteFalse:true makes write() always report backpressure
 */
class ManualSocket extends Duplex {
  constructor(options = {}) {
    super();
    this.written = [];
    this.pendingWriteCallbacks = [];
    this.autoWriteCallback = options.autoWriteCallback !== false;
    this.syncWriteCallback = options.syncWriteCallback === true;
    this.forceWriteFalse = options.forceWriteFalse === true;
  }

  _read() {}

  _write(chunk, _encoding, callback) {
    this.written.push(Buffer.from(chunk));
    if (!this.autoWriteCallback) {
      this.pendingWriteCallbacks.push(callback);
    } else if (this.syncWriteCallback) {
      callback();
    } else {
      setImmediate(callback);
    }
  }

  write(chunk, callback) {
    const result = super.write(chunk, callback);
    return this.forceWriteFalse ? false : result;
  }

  releaseWrite() {
    const callback = this.pendingWriteCallbacks.shift();
    if (callback) callback();
  }

  feed(bytes) {
    this.push(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  }

  endInput() {
    this.push(null);
  }
}

function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  return frameFromPayload(payload);
}

function frameFromPayload(payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function headerOfLength(length) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(length, 0);
  return header;
}

/** Build an object whose JSON payload is exactly `size` ASCII bytes. */
function objectOfPayloadSize(size) {
  const value = { s: "a".repeat(size - 8) };
  assert.equal(Buffer.byteLength(JSON.stringify(value), "utf8"), size);
  return value;
}

function payloadOfObject(value) {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function recorder() {
  const messages = [];
  const closes = [];
  return {
    messages,
    closes,
    onMessage: (value) => messages.push(value),
    onClose: (code) => closes.push(code),
  };
}

// ---------------------------------------------------------------------------
// Inbound framing
// ---------------------------------------------------------------------------

test("reassembles a frame delivered one byte at a time", async () => {
  const socket = new ManualSocket();
  const rec = recorder();
  attachJsonTransport(socket, { onMessage: rec.onMessage, onClose: rec.onClose });

  const frame = encodeFrame({ hello: "world" });
  for (const byte of frame) {
    socket.feed(Buffer.from([byte]));
    await tick();
  }
  await settle();

  assert.deepEqual(rec.messages, [{ hello: "world" }]);
  assert.deepEqual(rec.closes, []);
  socket.destroy();
});

test("handles two coalesced frames and an empty object", async () => {
  const socket = new ManualSocket();
  const rec = recorder();
  attachJsonTransport(socket, { onMessage: rec.onMessage, onClose: rec.onClose });

  socket.feed(Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({})]));
  await settle();

  assert.deepEqual(rec.messages, [{ a: 1 }, {}]);
  assert.deepEqual(rec.closes, []);
  socket.destroy();
});

test("accepts a payload of exactly 32768 bytes", async () => {
  const socket = new ManualSocket();
  const rec = recorder();
  attachJsonTransport(socket, { onMessage: rec.onMessage, onClose: rec.onClose });

  const payload = payloadOfObject(objectOfPayloadSize(32768));
  socket.feed(frameFromPayload(payload));
  await settle();

  assert.equal(rec.messages.length, 1);
  assert.equal(rec.messages[0].s.length, 32768 - 8);
  assert.deepEqual(rec.closes, []);
  socket.destroy();
});

for (const [name, length] of [
  ["zero", 0],
  ["32769", 32769],
  ["uint32 maximum", 0xffffffff],
]) {
  test(`rejects a ${name} length before allocating a body`, async () => {
    const socket = new ManualSocket();
    const rec = recorder();
    attachJsonTransport(socket, { onMessage: rec.onMessage, onClose: rec.onClose });

    socket.feed(headerOfLength(length));
    await settle();

    assert.deepEqual(rec.messages, []);
    assert.deepEqual(rec.closes, [CODES.PROTOCOL]);
    assert.equal(socket.destroyed, true);
  });
}

for (const [name, payload] of [
  ["malformed JSON", Buffer.from('{"a":}', "utf8")],
  ["fatal UTF-8", Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d])],
  [
    "an initial BOM",
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}', "utf8")]),
  ],
  ["a number scalar", Buffer.from("123", "utf8")],
  ["a string scalar", Buffer.from('"x"', "utf8")],
  ["a boolean scalar", Buffer.from("true", "utf8")],
  ["an array", Buffer.from("[1,2]", "utf8")],
  ["null", Buffer.from("null", "utf8")],
]) {
  test(`destroys the transport on ${name}`, async () => {
    const socket = new ManualSocket();
    const rec = recorder();
    attachJsonTransport(socket, { onMessage: rec.onMessage, onClose: rec.onClose });

    socket.feed(frameFromPayload(payload));
    await settle();

    assert.deepEqual(rec.messages, []);
    assert.deepEqual(rec.closes, [CODES.PROTOCOL]);
    assert.equal(socket.destroyed, true);
  });
}

test("partial header then EOF destroys with the protocol code", async () => {
  const socket = new ManualSocket();
  const rec = recorder();
  attachJsonTransport(socket, { onMessage: rec.onMessage, onClose: rec.onClose });

  socket.feed(Buffer.from([0x00, 0x00]));
  await settle();
  socket.endInput();
  await settle();

  assert.deepEqual(rec.messages, []);
  assert.deepEqual(rec.closes, [CODES.PROTOCOL]);
});

test("partial body then EOF destroys with the protocol code", async () => {
  const socket = new ManualSocket();
  const rec = recorder();
  attachJsonTransport(socket, { onMessage: rec.onMessage, onClose: rec.onClose });

  socket.feed(Buffer.concat([headerOfLength(10), Buffer.from("abc", "utf8")]));
  await settle();
  socket.endInput();
  await settle();

  assert.deepEqual(rec.messages, []);
  assert.deepEqual(rec.closes, [CODES.PROTOCOL]);
});

test("clean remote EOF closes once with the remote code", async () => {
  const socket = new ManualSocket();
  const rec = recorder();
  attachJsonTransport(socket, { onMessage: rec.onMessage, onClose: rec.onClose });

  socket.endInput();
  await settle();

  assert.deepEqual(rec.messages, []);
  assert.deepEqual(rec.closes, [CODES.REMOTE]);
});

// ---------------------------------------------------------------------------
// Inbound serialization and retained-input bounds
// ---------------------------------------------------------------------------

test("invokes onMessage serially and waits for async callbacks", async () => {
  const socket = new ManualSocket();
  const order = [];
  const pending = [];
  const closes = [];
  attachJsonTransport(socket, {
    onMessage: (value) => {
      order.push(value.n);
      return new Promise((resolve) => pending.push(resolve));
    },
    onClose: (code) => closes.push(code),
  });

  socket.feed(Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ n: 2 }), encodeFrame({ n: 3 })]));
  await settle();
  assert.deepEqual(order, [1]);

  pending.shift()();
  await settle();
  assert.deepEqual(order, [1, 2]);

  pending.shift()();
  await settle();
  assert.deepEqual(order, [1, 2, 3]);

  pending.shift()();
  await settle();
  assert.deepEqual(order, [1, 2, 3]);
  assert.deepEqual(closes, []);
  socket.destroy();
});

test("destroys when retained inbound frames exceed four", async () => {
  const socket = new ManualSocket();
  const order = [];
  const closes = [];
  attachJsonTransport(socket, {
    onMessage: (value) => {
      order.push(value.n);
      return new Promise(() => {});
    },
    onClose: (code) => closes.push(code),
  });

  const frames = [];
  for (let i = 0; i < 5; i += 1) frames.push(encodeFrame({ n: i + 1 }));
  socket.feed(Buffer.concat(frames));
  await settle();

  assert.deepEqual(order, [1]);
  assert.deepEqual(closes, [CODES.OVERFLOW]);
  assert.equal(socket.destroyed, true);
});

test("destroys when retained inbound bytes exceed 65536", async () => {
  const socket = new ManualSocket();
  const order = [];
  const closes = [];
  attachJsonTransport(socket, {
    onMessage: (value) => {
      order.push(value);
      return new Promise(() => {});
    },
    onClose: (code) => closes.push(code),
  });

  const big = payloadOfObject(objectOfPayloadSize(30000));
  socket.feed(Buffer.concat([frameFromPayload(big), frameFromPayload(big), frameFromPayload(big)]));
  await settle();

  assert.equal(order.length, 1);
  assert.deepEqual(closes, [CODES.OVERFLOW]);
  assert.equal(socket.destroyed, true);
});

test("counts a partial header against the retained byte cap before allocating a body", async () => {
  const socket = new ManualSocket();
  const order = [];
  const closes = [];
  attachJsonTransport(socket, {
    onMessage: (value) => {
      order.push(value.n);
      return new Promise(() => {});
    },
    onClose: (code) => closes.push(code),
  });

  // Two 32768-byte frames fill the 65536 retained-byte budget exactly: the
  // first is the active callback, the second waits in the queue. The next
  // frame's header has not even been completed, yet its first byte already
  // exceeds the cap and must fail before any body is allocated. The byte rides
  // in the same coalesced chunk because the transport pauses reads while the
  // callback is active.
  const big = payloadOfObject(objectOfPayloadSize(32768));
  socket.feed(Buffer.concat([frameFromPayload(big), frameFromPayload(big), Buffer.from([0x00])]));
  await settle();

  assert.equal(order.length, 1);
  assert.deepEqual(closes, [CODES.OVERFLOW]);
  assert.equal(socket.destroyed, true);
});

test("counts a partial header as the fifth retained frame", async () => {
  const socket = new ManualSocket();
  const order = [];
  const closes = [];
  attachJsonTransport(socket, {
    onMessage: (value) => {
      order.push(value.n);
      return new Promise(() => {});
    },
    onClose: (code) => closes.push(code),
  });

  // One active callback plus three queued frames already reach the 4-frame cap;
  // a partial header for a fifth frame overflows on the first byte. As above the
  // byte is coalesced with the frames because reads are paused.
  const frames = [];
  for (let i = 0; i < 4; i += 1) frames.push(encodeFrame({ n: i + 1 }));
  frames.push(Buffer.from([0x00]));
  socket.feed(Buffer.concat(frames));
  await settle();

  assert.equal(order.length, 1);
  assert.deepEqual(closes, [CODES.OVERFLOW]);
  assert.equal(socket.destroyed, true);
});

test("treats a throwing onMessage callback as fatal and stops callbacks", async () => {
  const socket = new ManualSocket();
  const order = [];
  const closes = [];
  attachJsonTransport(socket, {
    onMessage: (value) => {
      order.push(value.n);
      throw new Error("callback boom");
    },
    onClose: (code) => closes.push(code),
  });

  socket.feed(Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ n: 2 })]));
  await settle();

  assert.deepEqual(order, [1]);
  assert.deepEqual(closes, [CODES.CALLBACK]);
  assert.equal(socket.destroyed, true);
});

test("treats a rejecting onMessage promise as fatal", async () => {
  const socket = new ManualSocket();
  const order = [];
  const closes = [];
  attachJsonTransport(socket, {
    onMessage: (value) => {
      order.push(value.n);
      return Promise.reject(new Error("callback boom"));
    },
    onClose: (code) => closes.push(code),
  });

  socket.feed(encodeFrame({ n: 1 }));
  await settle();
  await settle();

  assert.deepEqual(order, [1]);
  assert.deepEqual(closes, [CODES.CALLBACK]);
  assert.equal(socket.destroyed, true);
});

test("fails closed when the callback result then-getter throws", async () => {
  const socket = new ManualSocket();
  const order = [];
  const closes = [];
  // biome-ignore lint/suspicious/noThenProperty: Exercise a malicious then getter at the callback boundary.
  const poisoned = Object.defineProperty({}, "then", {
    get() {
      throw new Error("poisoned then");
    },
  });
  attachJsonTransport(socket, {
    onMessage: (value) => {
      order.push(value.n);
      return poisoned;
    },
    onClose: (code) => closes.push(code),
  });

  socket.feed(Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ n: 2 })]));
  await settle();
  await settle();

  assert.deepEqual(order, [1]);
  assert.deepEqual(closes, [CODES.CALLBACK]);
  assert.equal(socket.destroyed, true);
});

test("fails closed when the callback result then-function throws", async () => {
  const socket = new ManualSocket();
  const order = [];
  const closes = [];
  attachJsonTransport(socket, {
    onMessage: (value) => {
      order.push(value.n);
      return {
        // biome-ignore lint/suspicious/noThenProperty: Exercise an intentionally rejecting thenable.
        then() {
          throw new Error("throwing then");
        },
      };
    },
    onClose: (code) => closes.push(code),
  });

  socket.feed(encodeFrame({ n: 1 }));
  await settle();
  await settle();

  assert.deepEqual(order, [1]);
  assert.deepEqual(closes, [CODES.CALLBACK]);
  assert.equal(socket.destroyed, true);
});

// ---------------------------------------------------------------------------
// Outbound framing and backpressure
// ---------------------------------------------------------------------------

test("writes a four-byte big-endian length followed by UTF-8 JSON", async () => {
  const socket = new ManualSocket();
  const transport = attachJsonTransport(socket, { onMessage() {}, onClose() {} });

  await transport.send({ a: 1 });
  await settle();

  assert.equal(socket.written.length, 1);
  const frame = socket.written[0];
  assert.equal(frame.readUInt32BE(0), Buffer.byteLength('{"a":1}', "utf8"));
  assert.equal(frame.subarray(4).toString("utf8"), '{"a":1}');
  socket.destroy();
});

test("respects write(false), the write callback and drain ordering", async () => {
  const socket = new ManualSocket({ autoWriteCallback: false, forceWriteFalse: true });
  const closes = [];
  const transport = attachJsonTransport(socket, { onMessage() {}, onClose: (c) => closes.push(c) });

  const first = transport.send({ a: 1 });
  first.catch(() => {});
  await settle();
  assert.equal(socket.written.length, 1);

  const second = transport.send({ b: 2 });
  second.catch(() => {});
  await settle();
  assert.equal(socket.written.length, 1, "must not write while the active write is unresolved");

  socket.releaseWrite();
  await settle();
  assert.equal(socket.written.length, 1, "must not write before backpressure is relieved");

  socket.emit("drain");
  await settle();
  assert.equal(socket.written.length, 2);

  await first;
  socket.releaseWrite();
  socket.emit("drain");
  await second;
  assert.deepEqual(closes, []);
  socket.destroy();
});

test("fails when the socket write callback receives an error", async () => {
  class ErrorWriteSocket extends Duplex {
    _read() {}
    _write(_chunk, _encoding, callback) {
      callback(new Error("write failed"));
    }
  }
  const socket = new ErrorWriteSocket();
  const closes = [];
  const transport = attachJsonTransport(socket, {
    onMessage() {},
    onClose: (code) => closes.push(code),
  });

  await assert.rejects(transport.send({ a: 1 }), { code: CODES.SOCKET });
  assert.deepEqual(closes, [CODES.SOCKET]);
  await settle();
  assert.equal(socket.destroyed, true);
  assert.equal(socket.listenerCount("error"), 0, "error listener released on close");
});

test("does not resolve or write ahead when the write callback is synchronous", async () => {
  const socket = new ManualSocket({ syncWriteCallback: true, forceWriteFalse: true });
  const closes = [];
  const transport = attachJsonTransport(socket, {
    onMessage() {},
    onClose: (code) => closes.push(code),
  });

  const first = transport.send({ a: 1 });
  const second = transport.send({ b: 2 });
  await settle();

  // The first write completed synchronously, but write(false) was observed, so
  // the drain gate must still hold the second frame back.
  assert.equal(socket.written.length, 1, "must not write ahead of the drain gate");
  let completed = false;
  void first.then(() => {
    completed = true;
  });
  await settle();
  assert.equal(completed, false, "send remains pending until required drain");
  assert.equal(socket.written.length, 1);

  socket.emit("drain");
  await settle();
  assert.equal(socket.written.length, 2);
  await first;
  socket.emit("drain");
  await second;
  assert.deepEqual(closes, []);
  socket.destroy();
});

test("writes the next frame after a synchronous successful write callback", async () => {
  const socket = new ManualSocket({ syncWriteCallback: true });
  const transport = attachJsonTransport(socket, { onMessage() {}, onClose() {} });

  await transport.send({ a: 1 });
  await transport.send({ b: 2 });
  await settle();

  assert.equal(socket.written.length, 2);
  assert.equal(socket.written[0].subarray(4).toString("utf8"), '{"a":1}');
  assert.equal(socket.written[1].subarray(4).toString("utf8"), '{"b":2}');
  socket.destroy();
});

test("rejects and closes when the outbound message count exceeds four", async () => {
  const socket = new ManualSocket({ autoWriteCallback: false });
  const closes = [];
  const transport = attachJsonTransport(socket, { onMessage() {}, onClose: (c) => closes.push(c) });

  const held = [];
  for (let i = 0; i < 4; i += 1) {
    const promise = transport.send({ n: i });
    promise.catch(() => {});
    held.push(promise);
  }
  await settle();
  assert.equal(socket.written.length, 1);

  const overflow = transport.send({ n: 4 });
  await assert.rejects(overflow, { code: CODES.OVERFLOW });
  for (const promise of held) await assert.rejects(promise, { code: CODES.OVERFLOW });

  assert.deepEqual(closes, [CODES.OVERFLOW]);
  assert.equal(socket.destroyed, true);
});

test("rejects and closes when the outbound byte budget exceeds 65536", async () => {
  const socket = new ManualSocket({ autoWriteCallback: false });
  const closes = [];
  const transport = attachJsonTransport(socket, { onMessage() {}, onClose: (c) => closes.push(c) });

  const big = objectOfPayloadSize(30000); // frame = 4 + 30000 = 30004 bytes
  const first = transport.send(big);
  first.catch(() => {});
  const second = transport.send(big); // 60008 total, accepted
  second.catch(() => {});
  await settle();

  const third = transport.send(big); // would reach 90012, rejected without adding bytes
  await assert.rejects(third, { code: CODES.OVERFLOW });
  await assert.rejects(first, { code: CODES.OVERFLOW });
  await assert.rejects(second, { code: CODES.OVERFLOW });

  assert.deepEqual(closes, [CODES.OVERFLOW]);
  assert.equal(socket.destroyed, true);
});

// ---------------------------------------------------------------------------
// Outbound encoding edge cases
// ---------------------------------------------------------------------------

test("send rejects invalid values without closing the transport", async () => {
  const socket = new ManualSocket();
  const closes = [];
  const transport = attachJsonTransport(socket, { onMessage() {}, onClose: (c) => closes.push(c) });

  const cyclic = {};
  cyclic.self = cyclic;
  const cases = [
    ["null", null],
    ["an array", []],
    ["a number", 1],
    ["a string", "x"],
    [
      "a getter",
      {
        get a() {
          return 1;
        },
      },
    ],
    [
      "a toJSON method",
      {
        toJSON() {
          return {};
        },
      },
    ],
    ["a cycle", cyclic],
    ["NaN", { a: Number.NaN }],
    ["Infinity", { a: Number.POSITIVE_INFINITY }],
    ["a lone surrogate", { a: "\ud800" }],
    ["undefined", { a: undefined }],
    ["a function", { a() {} }],
    ["a bigint", { a: 1n }],
    ["a class instance", new Date()],
    ["a boxed number", { a: new Number(1) }],
    // biome-ignore lint/suspicious/noSparseArray: A hole must be rejected independently of explicit undefined.
    ["a sparse array hole", { a: [1, , 3] }],
  ];

  for (const [name, value] of cases) {
    await assert.rejects(
      transport.send(value),
      (error) => error instanceof TransportError && error.code === CODES.ENCODE,
      `expected ENCODE for ${name}`,
    );
  }

  assert.deepEqual(closes, []);
  assert.equal(socket.destroyed, false);

  await transport.send({ ok: true });
  socket.destroy();
});

test("send accepts ordinary and null-prototype objects", async () => {
  const socket = new ManualSocket();
  const transport = attachJsonTransport(socket, { onMessage() {}, onClose() {} });

  await transport.send({ a: 1 });
  const nullProto = Object.create(null);
  nullProto.b = 2;
  await transport.send(nullProto);
  await settle();

  assert.equal(socket.written[0].subarray(4).toString("utf8"), '{"a":1}');
  assert.equal(socket.written[1].subarray(4).toString("utf8"), '{"b":2}');
  socket.destroy();
});

test("rejects own properties that Object.keys would silently drop", async () => {
  const socket = new ManualSocket();
  const closes = [];
  const transport = attachJsonTransport(socket, {
    onMessage() {},
    onClose: (code) => closes.push(code),
  });

  const hiddenData = {};
  Object.defineProperty(hiddenData, "hidden", { value: 1, enumerable: false });
  const hiddenAccessor = {};
  Object.defineProperty(hiddenAccessor, "secret", {
    enumerable: false,
    get() {
      return 1;
    },
  });
  const symbolKey = { visible: 1, [Symbol("s")]: 2 };
  const nullProtoSymbol = Object.create(null);
  nullProtoSymbol[Symbol("s")] = 1;

  const cases = [
    ["a symbol key", symbolKey],
    ["a symbol key on a null-prototype object", nullProtoSymbol],
    ["a non-enumerable data property", hiddenData],
    ["a non-enumerable accessor", hiddenAccessor],
  ];

  for (const [name, value] of cases) {
    await assert.rejects(
      transport.send(value),
      (error) => error instanceof TransportError && error.code === CODES.ENCODE,
      `expected ENCODE for ${name}`,
    );
  }

  assert.deepEqual(closes, []);
  assert.equal(socket.destroyed, false);
  await transport.send({ ok: true });
  socket.destroy();
});

test("rejects nonstandard array prototypes and extra own array properties", async () => {
  const socket = new ManualSocket();
  const closes = [];
  const transport = attachJsonTransport(socket, {
    onMessage() {},
    onClose: (code) => closes.push(code),
  });

  class DerivedArray extends Array {}
  const derived = new DerivedArray();
  derived.push(1);
  const rePrototyped = [1, 2];
  Object.setPrototypeOf(rePrototyped, null);
  const extraString = [1];
  extraString.extra = 2;
  const extraSymbol = [1];
  extraSymbol[Symbol("s")] = 2;
  const nonCanonicalIndex = [1];
  nonCanonicalIndex["01"] = 2;

  const cases = [
    ["a subclassed array", derived],
    ["an array with a nonstandard prototype", rePrototyped],
    ["an array with an extra string property", extraString],
    ["an array with an extra symbol property", extraSymbol],
    ["an array with a non-canonical index key", nonCanonicalIndex],
    ["an object using Array.prototype", Object.create(Array.prototype)],
  ];

  for (const [name, value] of cases) {
    await assert.rejects(
      transport.send({ value }),
      (error) => error instanceof TransportError && error.code === CODES.ENCODE,
      `expected ENCODE for ${name}`,
    );
  }

  assert.deepEqual(closes, []);
  await transport.send({ plain: [1, 2, 3] });
  socket.destroy();
});

test("bounds outbound structural depth at 12", async () => {
  const socket = new ManualSocket();
  const transport = attachJsonTransport(socket, { onMessage() {}, onClose() {} });

  function nest(levels) {
    let value = {};
    for (let i = 1; i < levels; i += 1) value = { a: value };
    return value;
  }

  await transport.send(nest(12));
  await assert.rejects(transport.send(nest(13)), { code: CODES.ENCODE });
  socket.destroy();
});

test("bounds outbound structural values at 4096", async () => {
  const socket = new ManualSocket();
  const transport = attachJsonTransport(socket, { onMessage() {}, onClose() {} });

  await transport.send({ a: new Array(4094).fill(0) }); // 1 + 1 + 4094 = 4096 values
  await assert.rejects(transport.send({ a: new Array(4095).fill(0) }), { code: CODES.ENCODE });
  socket.destroy();
});

test("rejects an encoded payload larger than 32768 bytes", async () => {
  const socket = new ManualSocket();
  const transport = attachJsonTransport(socket, { onMessage() {}, onClose() {} });

  await assert.rejects(transport.send(objectOfPayloadSize(32769)), { code: CODES.ENCODE });
  assert.equal(socket.written.length, 0);
  socket.destroy();
});

test("rejects an oversized string before materializing huge JSON text", async () => {
  const socket = new ManualSocket();
  const closes = [];
  const transport = attachJsonTransport(socket, {
    onMessage() {},
    onClose: (code) => closes.push(code),
  });

  // Far longer than any frame; must be rejected by the source-length bound
  // rather than being handed to JSON.stringify.
  await assert.rejects(transport.send({ s: "x".repeat(1_000_000) }), { code: CODES.ENCODE });
  assert.equal(socket.written.length, 0);
  assert.deepEqual(closes, []);
  socket.destroy();
});

test("bounds accumulated encoded text before it exceeds the payload cap", async () => {
  const socket = new ManualSocket();
  const transport = attachJsonTransport(socket, { onMessage() {}, onClose() {} });

  // 4000 x ~22 encoded bytes is well over 32768 bytes, but only 4002 values,
  // so the value/depth bounds alone would not catch it; the text accumulator
  // must reject it as it grows.
  const many = new Array(4000).fill("a".repeat(20));
  await assert.rejects(transport.send({ many }), { code: CODES.ENCODE });
  assert.equal(socket.written.length, 0);
  socket.destroy();
});

// ---------------------------------------------------------------------------
// Abort handling
// ---------------------------------------------------------------------------

test("handles an already-aborted signal", async () => {
  const socket = new ManualSocket();
  const closes = [];
  const controller = new AbortController();
  controller.abort();

  const transport = attachJsonTransport(socket, {
    signal: controller.signal,
    onMessage() {},
    onClose: (code) => closes.push(code),
  });

  assert.deepEqual(closes, [CODES.ABORTED]);
  await assert.rejects(transport.send({ a: 1 }), { code: CODES.ABORTED });
  assert.equal(socket.destroyed, true);
});

test("aborting during a blocked write rejects outstanding sends", async () => {
  const socket = new ManualSocket({ autoWriteCallback: false });
  const closes = [];
  const controller = new AbortController();
  const transport = attachJsonTransport(socket, {
    signal: controller.signal,
    onMessage() {},
    onClose: (code) => closes.push(code),
  });

  const pending = transport.send({ a: 1 });
  pending.catch(() => {});
  await settle();
  assert.equal(socket.written.length, 1);

  controller.abort();
  await assert.rejects(pending, { code: CODES.ABORTED });
  assert.deepEqual(closes, [CODES.ABORTED]);
  assert.equal(socket.destroyed, true);
});

test("aborting during an async callback closes once and suppresses later delivery", async () => {
  const socket = new ManualSocket();
  const order = [];
  const closes = [];
  let release = null;
  const controller = new AbortController();
  attachJsonTransport(socket, {
    signal: controller.signal,
    onMessage: (value) => {
      order.push(value.n);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    onClose: (code) => closes.push(code),
  });

  socket.feed(Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ n: 2 })]));
  await settle();
  assert.deepEqual(order, [1]);

  controller.abort();
  assert.deepEqual(closes, [CODES.ABORTED]);

  release();
  await settle();
  assert.deepEqual(order, [1], "a queued frame must not be delivered after abort");
  assert.deepEqual(closes, [CODES.ABORTED]);
});

// ---------------------------------------------------------------------------
// Shutdown, error and lifecycle
// ---------------------------------------------------------------------------

test("notifies and rejects outstanding sends on a socket error", async () => {
  const socket = new ManualSocket({ autoWriteCallback: false });
  const closes = [];
  const transport = attachJsonTransport(socket, { onMessage() {}, onClose: (c) => closes.push(c) });

  const pending = transport.send({ a: 1 });
  pending.catch(() => {});
  await settle();

  socket.emit("error", new Error("socket boom"));
  await assert.rejects(pending, { code: CODES.SOCKET });
  assert.deepEqual(closes, [CODES.SOCKET]);
  assert.equal(socket.destroyed, true);
});

test("keeps the error listener through delayed asynchronous destruction", async () => {
  class SlowDestroySocket extends Duplex {
    _read() {}
    _write(_chunk, _encoding, callback) {
      callback();
    }
    _destroy(_err, callback) {
      // Destruction is asynchronous and reports an error, so the stream emits
      // 'error' only after destroy() has returned. The transport must keep its
      // listener attached until 'close' is observed, or this error would be
      // unhandled and crash the process.
      setImmediate(() => callback(new Error("delayed destroy failure")));
    }
  }
  const socket = new SlowDestroySocket();
  const closes = [];
  const transport = attachJsonTransport(socket, {
    onMessage() {},
    onClose: (code) => closes.push(code),
  });

  transport.close();
  assert.deepEqual(closes, [CODES.CLOSED]);
  assert.equal(socket.listenerCount("error"), 1, "error listener held during destruction");

  assert.equal(await waitForClose(socket), true);
  assert.equal(socket.listenerCount("error"), 0, "all owned listeners removed on close");
  assert.equal(socket.listenerCount("data"), 0);
  assert.equal(socket.listenerCount("drain"), 0);
});

test("close is idempotent, notifies once and rejects later sends", async () => {
  const socket = new ManualSocket();
  const closes = [];
  const transport = attachJsonTransport(socket, { onMessage() {}, onClose: (c) => closes.push(c) });

  transport.close();
  transport.close();
  await settle();

  assert.deepEqual(closes, [CODES.CLOSED]);
  assert.equal(socket.destroyed, true);
  await assert.rejects(transport.send({ a: 1 }), { code: CODES.CLOSED });
});

test("delivers no further callbacks after a fatal close", async () => {
  const socket = new ManualSocket();
  const order = [];
  const closes = [];
  let release = null;
  const transport = attachJsonTransport(socket, {
    onMessage: (value) => {
      order.push(value.n);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    onClose: (code) => closes.push(code),
  });

  socket.feed(Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ n: 2 })]));
  await settle();
  assert.deepEqual(order, [1]);

  transport.close();
  release();
  await settle();

  assert.deepEqual(order, [1]);
  assert.deepEqual(closes, [CODES.CLOSED]);
});

test("close codes are finite strings from the documented set", async () => {
  const socket = new ManualSocket();
  const closes = [];
  attachJsonTransport(socket, { onMessage() {}, onClose: (c) => closes.push(c) });
  socket.destroy();
  await settle();

  const finite = new Set(Object.values(CODES));
  assert.equal(closes.length, 1);
  assert.equal(typeof closes[0], "string");
  assert.equal(finite.has(closes[0]), true);
});

test("never connects, listens, reconnects or replays", async () => {
  const socket = new ManualSocket();
  let connectCalls = 0;
  socket.connect = () => {
    connectCalls += 1;
  };
  const transport = attachJsonTransport(socket, { onMessage() {}, onClose() {} });

  assert.equal(socket.listenerCount("connect"), 0);
  await transport.send({ a: 1 });
  await settle();
  assert.equal(connectCalls, 0);
  assert.equal(socket.written.length, 1);

  transport.close();
  await settle();
  assert.equal(socket.written.length, 1, "closed transport must not replay frames");
  assert.equal(connectCalls, 0);
});

test("removes its abort listener on shutdown and socket listeners on close", async () => {
  const socket = new ManualSocket();
  const abortListeners = new Set();
  const signal = {
    aborted: false,
    addEventListener(_type, handler) {
      abortListeners.add(handler);
    },
    removeEventListener(_type, handler) {
      abortListeners.delete(handler);
    },
  };
  const transport = attachJsonTransport(socket, { signal, onMessage() {}, onClose() {} });
  assert.equal(abortListeners.size, 1);

  transport.close();
  assert.equal(abortListeners.size, 0);
  await settle(); // socket listeners are removed when the stream reports close
  assert.equal(socket.listenerCount("data"), 0);
  assert.equal(socket.listenerCount("drain"), 0);
  assert.equal(socket.listenerCount("error"), 0);
});

test("exchanges bounded frames over a real disposable Unix socket with backpressure", {
  timeout: 5000,
}, async (t) => {
  const { createServer, createConnection } = await import("node:net");
  const { mkdtemp, rm, chmod } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "obj-"));
  await chmod(root, 0o700);
  const peers = new Set();
  const transports = new Set();
  let done;
  const received = [];
  const observed = new Promise((resolve) => {
    done = resolve;
  });
  const server = createServer({ highWaterMark: 16 }, (socket) => {
    peers.add(socket);
    const transport = attachJsonTransport(socket, {
      async onMessage(value) {
        await transport.send({ echo: value });
      },
    });
    transports.add(transport);
  });
  t.after(async () => {
    for (const transport of transports) transport.close();
    for (const socket of peers) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const path = join(root, "s");
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  const socket = createConnection({ path, highWaterMark: 16 });
  peers.add(socket);
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", resolve);
  });
  const transport = attachJsonTransport(socket, {
    onMessage(value) {
      received.push(value);
      if (received.length === 2) done();
    },
  });
  transports.add(transport);
  const messages = [{ text: "中文😀".repeat(200) }, { second: true }];
  await Promise.all([...messages.map((value) => transport.send(value)), observed]);
  assert.deepEqual(
    received,
    messages.map((echo) => ({ echo })),
  );
});
