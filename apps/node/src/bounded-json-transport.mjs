/**
 * bounded-json-transport.mjs
 *
 * A standalone, generic, bounded length-prefixed JSON transport for an
 * already-connected, exclusively-owned Duplex (typically a node:net.Socket).
 *
 * Wire (frozen): [u32 big-endian payload length][UTF-8 JSON payload]
 *   - payload length is 1..32768, validated before its body is allocated
 *   - the top-level JSON value must be an ordinary object (not null/array/scalar)
 *   - invalid UTF-8, invalid JSON, invalid length, an initial BOM and partial
 *     EOF all destroy the transport
 *
 * This module does not connect, listen, resolve paths, authenticate, reconnect
 * or replay, and it never treats a delivered message as authorization.
 * Only Node built-ins are used.
 *
 * Retained-input accounting (inbound)
 * -----------------------------------
 * We retain at most:
 *   - 0..3 bytes of an incomplete frame header (counted as the in-progress
 *     frame, so a partial header after 4 queued frames is itself an overflow),
 *   - at most one 32768-byte body buffer while that frame is being assembled,
 *   - decoded-but-undelivered frames waiting in the serial callback queue, and
 *   - the single frame whose onMessage invocation is currently active.
 * The caps are 65536 retained payload bytes AND 4 retained frames, counting the
 * partially assembled frame and the active callback. Exceeding either cap is a
 * fatal overflow; the check runs on every partial header byte and on every
 * completed header *before* its body is allocated. A whole coalesced chunk is
 * parsed immediately so the original chunk buffer is not retained; excess
 * complete frames therefore count against the queue and can overflow.
 *
 * Outbound accounting
 * -------------------
 * Every accepted send counts 4 (header) + payload bytes. The cap is 65536
 * bytes AND 4 frames, counting frames queued AND the active write. A send that
 * would exceed either cap is rejected without adding its bytes and the
 * transport is closed so partial progress cannot be mistaken for a retry.
 *
 * Socket highWaterMark distinction
 * --------------------------------
 * The upstream socket's highWaterMark is a per-stream buffering heuristic that
 * only decides whether write() returns false and when 'drain' fires. It is not
 * this transport's bound, gives no authorization, and is independent of the
 * retained byte/frame caps above. We honour write(false)/'drain' ordering, but
 * the module's own caps are what enforce bounded retention.
 *
 * Write-completion rule
 * ---------------------
 * send() resolves only for locally completed progress: the stream's write
 * callback must fire without an error argument, and the next queued frame is
 * not handed to the socket until both the active callback has settled and the
 * write(false)/'drain' gate is open. If a supplied Duplex calls its write
 * callback synchronously, completion is deferred until write() has returned so
 * that the return value (backpressure) is known first.
 */

import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";

const MAX_PAYLOAD = 32768; // inbound and outbound payload bytes
const MAX_RETAINED_BYTES = 65536; // inbound retained payload bytes
const MAX_RETAINED_FRAMES = 4; // inbound retained frames, active callback included
const MAX_SEND_BYTES = 65536; // outbound queued + active frame bytes, headers included
const MAX_SEND_FRAMES = 4; // outbound queued + active frames
const MAX_DEPTH = 12; // outbound structural nesting, root container counts as depth 1
const MAX_VALUES = 4096; // outbound visited values, containers and scalars alike

/** Finite, payload-free error / close codes. */
export const TRANSPORT_CODES = Object.freeze({
  CLOSED: "ERR_JSON_TRANSPORT_CLOSED",
  ABORTED: "ERR_JSON_TRANSPORT_ABORTED",
  PROTOCOL: "ERR_JSON_TRANSPORT_PROTOCOL",
  OVERFLOW: "ERR_JSON_TRANSPORT_OVERFLOW",
  ENCODE: "ERR_JSON_TRANSPORT_ENCODE",
  CALLBACK: "ERR_JSON_TRANSPORT_CALLBACK",
  SOCKET: "ERR_JSON_TRANSPORT_SOCKET",
  REMOTE: "ERR_JSON_TRANSPORT_REMOTE",
});

/** Error carrying only a finite code; no payload or peer text is attached. */
export class TransportError extends Error {
  constructor(code) {
    super(code);
    this.name = "TransportError";
    this.code = code;
  }
}

function hasLoneSurrogate(value) {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * JSON-encode one string after bounding its source length. A string longer than
 * the payload cap can never fit in a frame, so it is rejected before
 * JSON.stringify can materialize a very large intermediate text.
 */
function writeString(value) {
  if (value.length > MAX_PAYLOAD) throw new TransportError(TRANSPORT_CODES.ENCODE);
  if (hasLoneSurrogate(value)) throw new TransportError(TRANSPORT_CODES.ENCODE);
  return JSON.stringify(value);
}

/**
 * Append one already-JSON-encoded fragment, bounding the accumulated text
 * before it grows large. JSON text's UTF-8 byte length is always >= its UTF-16
 * code-unit length, so exceeding the code-unit cap implies exceeding the byte
 * cap and may be rejected early. The exact 32768-byte check still runs on the
 * final buffer.
 */
function push(ctx, text) {
  ctx.units += text.length;
  if (ctx.units > MAX_PAYLOAD) throw new TransportError(TRANSPORT_CODES.ENCODE);
  ctx.parts.push(text);
}

function writeObject(node, depth, ctx) {
  if (depth > MAX_DEPTH) throw new TransportError(TRANSPORT_CODES.ENCODE);
  const proto = Object.getPrototypeOf(node);
  if (proto !== Object.prototype && proto !== null) {
    throw new TransportError(TRANSPORT_CODES.ENCODE);
  }
  if ("toJSON" in node) throw new TransportError(TRANSPORT_CODES.ENCODE);
  if (ctx.seen.has(node)) throw new TransportError(TRANSPORT_CODES.ENCODE);
  ctx.seen.add(node);

  // Reflect.ownKeys is used instead of Object.keys so that symbol keys,
  // non-enumerable own data properties and own accessors are all seen and
  // rejected rather than silently dropped by JSON normalization.
  const ownKeys = Reflect.ownKeys(node);
  push(ctx, "{");
  for (let i = 0; i < ownKeys.length; i += 1) {
    const key = ownKeys[i];
    if (typeof key === "symbol" || key === "toJSON") {
      throw new TransportError(TRANSPORT_CODES.ENCODE);
    }
    const descriptor = Object.getOwnPropertyDescriptor(node, key);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      throw new TransportError(TRANSPORT_CODES.ENCODE);
    }
    if (i > 0) push(ctx, ",");
    push(ctx, writeString(key));
    push(ctx, ":");
    writeValue(descriptor.value, depth + 1, ctx);
  }
  push(ctx, "}");
  ctx.seen.delete(node);
}

function writeArray(node, depth, ctx) {
  if (depth > MAX_DEPTH) throw new TransportError(TRANSPORT_CODES.ENCODE);
  if (Object.getPrototypeOf(node) !== Array.prototype) {
    throw new TransportError(TRANSPORT_CODES.ENCODE);
  }
  if ("toJSON" in node) throw new TransportError(TRANSPORT_CODES.ENCODE);
  if (ctx.seen.has(node)) throw new TransportError(TRANSPORT_CODES.ENCODE);
  ctx.seen.add(node);

  const length = node.length;
  // Reject extra own properties and symbol keys; Object.keys would silently
  // ignore them. Only 'length' and canonical in-range index keys are allowed.
  const ownKeys = Reflect.ownKeys(node);
  for (let k = 0; k < ownKeys.length; k += 1) {
    const key = ownKeys[k];
    if (key === "length") continue;
    if (typeof key === "symbol") throw new TransportError(TRANSPORT_CODES.ENCODE);
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== key) {
      throw new TransportError(TRANSPORT_CODES.ENCODE);
    }
    const descriptor = Object.getOwnPropertyDescriptor(node, key);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      throw new TransportError(TRANSPORT_CODES.ENCODE);
    }
  }

  push(ctx, "[");
  for (let i = 0; i < length; i += 1) {
    if (i > 0) push(ctx, ",");
    const descriptor = Object.getOwnPropertyDescriptor(node, String(i));
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new TransportError(TRANSPORT_CODES.ENCODE); // sparse hole
    }
    writeValue(descriptor.value, depth + 1, ctx);
  }
  push(ctx, "]");
  ctx.seen.delete(node);
}

function writeValue(node, depth, ctx) {
  ctx.count += 1;
  if (ctx.count > MAX_VALUES) throw new TransportError(TRANSPORT_CODES.ENCODE);
  switch (typeof node) {
    case "string":
      push(ctx, writeString(node));
      return;
    case "number":
      if (!Number.isFinite(node)) throw new TransportError(TRANSPORT_CODES.ENCODE);
      push(ctx, JSON.stringify(node));
      return;
    case "boolean":
      push(ctx, node ? "true" : "false");
      return;
    case "object":
      break;
    default:
      // undefined, function, symbol and bigint are unsupported.
      throw new TransportError(TRANSPORT_CODES.ENCODE);
  }
  if (node === null) {
    push(ctx, "null");
    return;
  }
  if (Array.isArray(node)) writeArray(node, depth, ctx);
  else writeObject(node, depth, ctx);
}

/**
 * Encode exactly one message. Traversal is bounded in depth and value count,
 * string/array/object work is bounded before large intermediate JSON text is
 * produced, getters/toJSON/cycles/non-finite numbers/lone surrogates and
 * unsupported own properties are rejected, and UTF-8 is produced exactly once.
 */
function encodeMessage(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TransportError(TRANSPORT_CODES.ENCODE);
  }
  const ctx = { count: 0, units: 0, parts: [], seen: new Set() };
  writeValue(value, 1, ctx);
  const text = ctx.parts.join("");
  const payload = Buffer.from(text, "utf8");
  if (payload.length > MAX_PAYLOAD) throw new TransportError(TRANSPORT_CODES.ENCODE);
  return payload;
}

function isThenable(value) {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof value.then === "function"
  );
}

/**
 * Attach the transport to an already-connected, exclusively-owned Duplex.
 *
 * @param {object} socket event-emitting Duplex owned by the caller
 * @param {{signal?: AbortSignal, onMessage?: Function, onClose?: Function}} [options]
 * @returns {{send: (value: object) => Promise<void>, close: () => void}}
 */
export function attachJsonTransport(socket, options = {}) {
  if (socket === null || typeof socket !== "object" || typeof socket.on !== "function") {
    throw new TypeError("socket must be an event-emitting Duplex");
  }
  const { signal, onMessage, onClose } = options;
  if (typeof onMessage !== "function") {
    throw new TypeError("onMessage must be a function");
  }
  if (onClose !== undefined && onClose !== null && typeof onClose !== "function") {
    throw new TypeError("onClose must be a function or omitted");
  }

  // ignoreBOM: true keeps a leading U+FEFF visible instead of silently stripping
  // it; the byte-level check below rejects it explicitly.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

  let finished = false;
  let finalCode = null;
  let closeNotified = false;
  let closeObserved = false;

  // Inbound assembly and delivery state.
  const header = Buffer.allocUnsafe(4);
  let headerFill = 0;
  let activeFrame = null; // { buf, fill }
  const inboundQueue = [];
  let inboundQueueBytes = 0;
  let inFlight = null; // { value, bytes }
  let paused = false;

  // Outbound write state.
  const outbound = [];
  let outboundBytes = 0;
  let outboundCount = 0;
  let activeWrite = null;
  let needDrain = false;
  let drainGeneration = 0;

  let abortHandler = null;

  function notifyClose(code) {
    if (closeNotified) return;
    closeNotified = true;
    if (typeof onClose === "function") {
      try {
        onClose(code);
      } catch {
        // A close notification cannot itself be reported; it is best-effort.
      }
    }
  }

  function detachAbort() {
    if (signal && abortHandler !== null && typeof signal.removeEventListener === "function") {
      signal.removeEventListener("abort", abortHandler);
    }
    abortHandler = null;
  }

  function detachSocket() {
    if (typeof socket.removeListener === "function") {
      socket.removeListener("data", onData);
      socket.removeListener("end", onEnd);
      socket.removeListener("close", onSocketClose);
      socket.removeListener("error", onSocketError);
      socket.removeListener("drain", onDrain);
    }
  }

  function fail(code) {
    if (finished) return;
    finished = true;
    finalCode = code;

    headerFill = 0;
    activeFrame = null;
    inboundQueue.length = 0;
    inboundQueueBytes = 0;
    inFlight = null;
    paused = false;

    const error = new TransportError(code);
    if (activeWrite !== null) {
      const entry = activeWrite;
      activeWrite = null;
      try {
        entry.reject(error);
      } catch {
        // The caller owns its own thenable.
      }
    }
    while (outbound.length > 0) {
      const entry = outbound.shift();
      try {
        entry.reject(error);
      } catch {
        // The caller owns its own thenable.
      }
    }
    outboundBytes = 0;
    outboundCount = 0;
    needDrain = false;

    // The abort listener is ours alone and can go immediately.
    detachAbort();

    const alreadyClosed = socket.closed === true;
    let destroyThrew = false;
    try {
      if (typeof socket.destroy === "function") socket.destroy();
    } catch {
      destroyThrew = true;
    }

    // Notify immediately; the socket's own listeners, in particular 'error',
    // are kept until the stream actually reports 'close'. Asynchronous
    // destruction (_destroy with a delayed callback) can emit an error after
    // destroy() returns, and removing the listener here would surface it as an
    // unhandled stream error.
    notifyClose(code);
    if (alreadyClosed || destroyThrew || closeObserved) detachSocket();
  }

  function pauseRead() {
    if (paused || finished) return;
    paused = true;
    if (typeof socket.pause === "function") socket.pause();
  }

  function resumeRead() {
    if (!paused) return;
    paused = false;
    if (!finished && typeof socket.resume === "function") socket.resume();
  }

  function retainedBytes() {
    let total = headerFill;
    if (activeFrame !== null) total += activeFrame.buf.length;
    total += inboundQueueBytes;
    if (inFlight !== null) total += inFlight.bytes;
    return total;
  }

  function retainedFrames() {
    return (
      inboundQueue.length +
      (activeFrame !== null || headerFill > 0 ? 1 : 0) +
      (inFlight !== null ? 1 : 0)
    );
  }

  function retainedOverflowed() {
    return retainedFrames() > MAX_RETAINED_FRAMES || retainedBytes() > MAX_RETAINED_BYTES;
  }

  function deliver(entry) {
    inFlight = entry;
    let result;
    try {
      result = onMessage(entry.value);
    } catch {
      fail(TRANSPORT_CODES.CALLBACK);
      return true;
    }

    // Reading result.then can itself throw (e.g. a throwing getter). That must
    // fail closed, not escape the stream callback as an uncaught exception.
    let thenable;
    try {
      thenable = isThenable(result);
    } catch {
      fail(TRANSPORT_CODES.CALLBACK);
      return true;
    }
    if (!thenable) {
      inFlight = null;
      return false;
    }

    pauseRead();
    let chain;
    try {
      chain = Promise.resolve(result);
    } catch {
      fail(TRANSPORT_CODES.CALLBACK);
      return true;
    }
    chain.then(
      () => {
        if (inFlight === entry && !finished) {
          inFlight = null;
          pump();
        }
      },
      () => {
        fail(TRANSPORT_CODES.CALLBACK);
      },
    );
    return true;
  }

  function pump() {
    if (finished) return;
    while (!finished && inFlight === null && inboundQueue.length > 0) {
      const entry = inboundQueue.shift();
      inboundQueueBytes -= entry.bytes;
      if (deliver(entry)) return;
    }
    if (!finished && inFlight === null && inboundQueue.length === 0) resumeRead();
  }

  function handlePayload(payload) {
    if (payload.length >= 3 && payload[0] === 0xef && payload[1] === 0xbb && payload[2] === 0xbf) {
      fail(TRANSPORT_CODES.PROTOCOL);
      return;
    }
    let text;
    try {
      text = decoder.decode(payload);
    } catch {
      fail(TRANSPORT_CODES.PROTOCOL);
      return;
    }
    if (text.length > 0 && text.charCodeAt(0) === 0xfeff) {
      fail(TRANSPORT_CODES.PROTOCOL);
      return;
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      fail(TRANSPORT_CODES.PROTOCOL);
      return;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail(TRANSPORT_CODES.PROTOCOL);
      return;
    }
    const entry = { value, bytes: payload.length };
    inboundQueue.push(entry);
    inboundQueueBytes += entry.bytes;
    if (retainedOverflowed()) {
      fail(TRANSPORT_CODES.OVERFLOW);
      return;
    }
    pump();
  }

  function onData(chunk) {
    if (finished) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < data.length) {
      if (finished) return;
      if (activeFrame === null) {
        const need = 4 - headerFill;
        const take = Math.min(need, data.length - offset);
        data.copy(header, headerFill, offset, offset + take);
        headerFill += take;
        offset += take;
        if (headerFill < 4) {
          // A partial header is a retained in-progress frame; count it before
          // waiting for the rest so it cannot creep past either cap.
          if (retainedOverflowed()) {
            fail(TRANSPORT_CODES.OVERFLOW);
            return;
          }
          break;
        }
        const length = header.readUInt32BE(0);
        if (length < 1 || length > MAX_PAYLOAD) {
          headerFill = 0;
          fail(TRANSPORT_CODES.PROTOCOL);
          return;
        }
        // Count the prospective frame before allocating its body. While the
        // header is complete but not reset, headerFill still represents this
        // frame; the four header bytes are replaced by the body buffer, so the
        // post-allocation retained size is (retained - headerFill + length).
        // A queue already at the cap is detected here, before the allocation.
        const prospectiveBytes = retainedBytes() - headerFill + length;
        if (retainedFrames() > MAX_RETAINED_FRAMES || prospectiveBytes > MAX_RETAINED_BYTES) {
          fail(TRANSPORT_CODES.OVERFLOW);
          return;
        }
        // Length is validated before the body is allocated.
        headerFill = 0;
        activeFrame = { buf: Buffer.allocUnsafe(length), fill: 0 };
        continue;
      }
      const need = activeFrame.buf.length - activeFrame.fill;
      const take = Math.min(need, data.length - offset);
      data.copy(activeFrame.buf, activeFrame.fill, offset, offset + take);
      activeFrame.fill += take;
      offset += take;
      if (activeFrame.fill === activeFrame.buf.length) {
        const payload = activeFrame.buf;
        activeFrame = null;
        handlePayload(payload);
        if (finished) return;
      }
    }
  }

  function onEnd() {
    if (finished) return;
    if (headerFill !== 0 || activeFrame !== null) fail(TRANSPORT_CODES.PROTOCOL);
    else fail(TRANSPORT_CODES.REMOTE);
  }

  function onSocketClose() {
    closeObserved = true;
    if (!finished) {
      fail(TRANSPORT_CODES.REMOTE);
    } else {
      detachSocket();
    }
  }

  function onSocketError() {
    if (!finished) fail(TRANSPORT_CODES.SOCKET);
    // After failure the listener stays attached until 'close' so that a delayed
    // destruction-time error is absorbed instead of becoming unhandled.
  }

  function onDrain() {
    if (finished) return;
    drainGeneration += 1;
    needDrain = false;
    if (activeWrite?.callbackDone) completeActiveWrite(activeWrite, null);
    else maybeWriteNext();
  }

  function completeActiveWrite(entry, error) {
    if (activeWrite !== entry) return;
    if (error) {
      // A write callback error argument is not local completion: fail with a
      // finite code and reject every outstanding send.
      fail(TRANSPORT_CODES.SOCKET);
      return;
    }
    entry.callbackDone = true;
    if (needDrain) return;
    activeWrite = null;
    outboundBytes -= entry.frame.length;
    outboundCount -= 1;
    try {
      entry.resolve();
    } catch {
      // The caller owns its own thenable.
    }
    maybeWriteNext();
  }

  function maybeWriteNext() {
    if (finished) return;
    if (activeWrite !== null || needDrain) return;
    if (outbound.length === 0) return;
    const entry = outbound.shift();
    activeWrite = entry;

    let writeReturned = false;
    let callbackDone = false;
    let callbackError = null;
    const onWriteCallback = (error) => {
      callbackDone = true;
      callbackError = error || null;
      // If the Duplex called back synchronously, wait until write() has
      // returned so the write(false)/drain state is known before resolving or
      // starting the next frame.
      if (!writeReturned) return;
      completeActiveWrite(entry, callbackError);
    };

    let writable;
    const drainBeforeWrite = drainGeneration;
    try {
      writable = socket.write(entry.frame, onWriteCallback);
    } catch {
      fail(TRANSPORT_CODES.SOCKET);
      return;
    }
    if (writable === false && drainGeneration === drainBeforeWrite) needDrain = true;
    writeReturned = true;
    if (callbackDone) completeActiveWrite(entry, callbackError);
  }

  function send(value) {
    if (finished) return Promise.reject(new TransportError(finalCode || TRANSPORT_CODES.CLOSED));
    let payload;
    try {
      payload = encodeMessage(value);
    } catch (error) {
      return Promise.reject(
        error instanceof TransportError ? error : new TransportError(TRANSPORT_CODES.ENCODE),
      );
    }
    const frameLength = 4 + payload.length;
    if (outboundBytes + frameLength > MAX_SEND_BYTES || outboundCount + 1 > MAX_SEND_FRAMES) {
      const error = new TransportError(TRANSPORT_CODES.OVERFLOW);
      fail(TRANSPORT_CODES.OVERFLOW);
      return Promise.reject(error);
    }
    const frame = Buffer.allocUnsafe(frameLength);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, 4);
    return new Promise((resolve, reject) => {
      outbound.push({ frame, resolve, reject });
      outboundBytes += frameLength;
      outboundCount += 1;
      maybeWriteNext();
    });
  }

  function close() {
    if (finished) return;
    fail(TRANSPORT_CODES.CLOSED);
  }

  socket.on("data", onData);
  socket.on("end", onEnd);
  socket.on("close", onSocketClose);
  socket.on("error", onSocketError);
  socket.on("drain", onDrain);

  if (signal) {
    if (signal.aborted) {
      fail(TRANSPORT_CODES.ABORTED);
    } else if (typeof signal.addEventListener === "function") {
      abortHandler = () => fail(TRANSPORT_CODES.ABORTED);
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  if (!finished && (socket.destroyed === true || socket.readableEnded === true)) {
    fail(TRANSPORT_CODES.REMOTE);
  }

  return { send, close };
}
