/**
 * bounded-json-transport.ts
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
 * Encoding constants, TransportError, and encodeMessage live in
 * bounded-json-codec.ts; this file owns Duplex lifecycle and accounting.
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
import type { Duplex } from "node:stream";
import { TextDecoder } from "node:util";

import {
  encodeMessage,
  MAX_PAYLOAD,
  MAX_RETAINED_BYTES,
  MAX_RETAINED_FRAMES,
  MAX_SEND_BYTES,
  MAX_SEND_FRAMES,
  TRANSPORT_CODES,
  TransportError,
  type JsonTransportMessage,
  type TransportCode,
} from "./bounded-json-codec.js";

export { TRANSPORT_CODES, TransportError };
export type { JsonTransportMessage, TransportCode };

export type AttachJsonTransportOptions = {
  readonly signal?: AbortSignal;
  readonly onMessage: (value: JsonTransportMessage) => unknown;
  readonly onClose?: (code: TransportCode) => void;
};

export type JsonTransport = {
  readonly send: (value: unknown) => Promise<void>;
  readonly close: () => void;
};

type ActiveFrame = {
  buf: Buffer;
  fill: number;
};

type InboundEntry = {
  value: JsonTransportMessage;
  bytes: number;
};

type OutboundEntry = {
  frame: Buffer;
  resolve: () => void;
  reject: (error: TransportError) => void;
  callbackDone: boolean;
};

type WriteCallback = (error?: Error | null) => void;

function isThenable(value: unknown): boolean {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function isJsonTransportMessage(value: unknown): value is JsonTransportMessage {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Attach the transport to an already-connected, exclusively-owned Duplex.
 */
export function attachJsonTransport(
  socket: Duplex,
  options: Partial<AttachJsonTransportOptions> = {},
): JsonTransport {
  if (socket === null || typeof socket !== "object" || typeof socket.on !== "function") {
    throw new TypeError("socket must be an event-emitting Duplex");
  }
  const { signal, onMessage: messageHandler, onClose } = options;
  if (typeof messageHandler !== "function") {
    throw new TypeError("onMessage must be a function");
  }
  if (onClose !== undefined && onClose !== null && typeof onClose !== "function") {
    throw new TypeError("onClose must be a function or omitted");
  }

  const onMessage = messageHandler;

  // ignoreBOM: true keeps a leading U+FEFF visible instead of silently stripping
  // it; the byte-level check below rejects it explicitly.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

  let finished = false;
  let finalCode: TransportCode | null = null;
  let closeNotified = false;
  let closeObserved = false;

  // Inbound assembly and delivery state.
  const header = Buffer.allocUnsafe(4);
  let headerFill = 0;
  let activeFrame: ActiveFrame | null = null;
  const inboundQueue: InboundEntry[] = [];
  let inboundQueueBytes = 0;
  let inFlight: InboundEntry | null = null;
  let paused = false;

  // Outbound write state.
  const outbound: OutboundEntry[] = [];
  let outboundBytes = 0;
  let outboundCount = 0;
  let activeWrite: OutboundEntry | null = null;
  let needDrain = false;
  let drainGeneration = 0;

  let abortHandler: (() => void) | null = null;

  function notifyClose(code: TransportCode): void {
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

  function detachAbort(): void {
    if (signal && abortHandler !== null && typeof signal.removeEventListener === "function") {
      signal.removeEventListener("abort", abortHandler);
    }
    abortHandler = null;
  }

  function detachSocket(): void {
    if (typeof socket.removeListener === "function") {
      socket.removeListener("data", onData);
      socket.removeListener("end", onEnd);
      socket.removeListener("close", onSocketClose);
      socket.removeListener("error", onSocketError);
      socket.removeListener("drain", onDrain);
    }
  }

  function fail(code: TransportCode): void {
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
      if (entry === undefined) break;
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

  function pauseRead(): void {
    if (paused || finished) return;
    paused = true;
    if (typeof socket.pause === "function") socket.pause();
  }

  function resumeRead(): void {
    if (!paused) return;
    paused = false;
    if (!finished && typeof socket.resume === "function") socket.resume();
  }

  function retainedBytes(): number {
    let total = headerFill;
    if (activeFrame !== null) total += activeFrame.buf.length;
    total += inboundQueueBytes;
    if (inFlight !== null) total += inFlight.bytes;
    return total;
  }

  function retainedFrames(): number {
    return (
      inboundQueue.length +
      (activeFrame !== null || headerFill > 0 ? 1 : 0) +
      (inFlight !== null ? 1 : 0)
    );
  }

  function retainedOverflowed(): boolean {
    return retainedFrames() > MAX_RETAINED_FRAMES || retainedBytes() > MAX_RETAINED_BYTES;
  }

  function deliver(entry: InboundEntry): boolean {
    inFlight = entry;
    let result: unknown;
    try {
      result = onMessage(entry.value);
    } catch {
      fail(TRANSPORT_CODES.CALLBACK);
      return true;
    }

    // Reading result.then can itself throw (e.g. a throwing getter). That must
    // fail closed, not escape the stream callback as an uncaught exception.
    let thenable: boolean;
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
    let chain: Promise<unknown>;
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

  function pump(): void {
    if (finished) return;
    while (!finished && inFlight === null && inboundQueue.length > 0) {
      const entry = inboundQueue.shift();
      if (entry === undefined) break;
      inboundQueueBytes -= entry.bytes;
      if (deliver(entry)) return;
    }
    if (!finished && inFlight === null && inboundQueue.length === 0) resumeRead();
  }

  function handlePayload(payload: Buffer): void {
    if (payload.length >= 3 && payload[0] === 0xef && payload[1] === 0xbb && payload[2] === 0xbf) {
      fail(TRANSPORT_CODES.PROTOCOL);
      return;
    }
    let text: string;
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      fail(TRANSPORT_CODES.PROTOCOL);
      return;
    }
    if (!isJsonTransportMessage(parsed)) {
      fail(TRANSPORT_CODES.PROTOCOL);
      return;
    }
    const entry: InboundEntry = { value: parsed, bytes: payload.length };
    inboundQueue.push(entry);
    inboundQueueBytes += entry.bytes;
    if (retainedOverflowed()) {
      fail(TRANSPORT_CODES.OVERFLOW);
      return;
    }
    pump();
  }

  function onData(chunk: Buffer | string): void {
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

  function onEnd(): void {
    if (finished) return;
    if (headerFill !== 0 || activeFrame !== null) fail(TRANSPORT_CODES.PROTOCOL);
    else fail(TRANSPORT_CODES.REMOTE);
  }

  function onSocketClose(): void {
    closeObserved = true;
    if (!finished) {
      fail(TRANSPORT_CODES.REMOTE);
    } else {
      detachSocket();
    }
  }

  function onSocketError(): void {
    if (!finished) fail(TRANSPORT_CODES.SOCKET);
    // After failure the listener stays attached until 'close' so that a delayed
    // destruction-time error is absorbed instead of becoming unhandled.
  }

  function onDrain(): void {
    if (finished) return;
    drainGeneration += 1;
    needDrain = false;
    if (activeWrite?.callbackDone) completeActiveWrite(activeWrite, null);
    else maybeWriteNext();
  }

  function completeActiveWrite(entry: OutboundEntry, error: Error | null): void {
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

  function maybeWriteNext(): void {
    if (finished) return;
    if (activeWrite !== null || needDrain) return;
    if (outbound.length === 0) return;
    const entry = outbound.shift();
    if (entry === undefined) return;
    activeWrite = entry;

    let writeReturned = false;
    let callbackDone = false;
    let callbackError: Error | null = null;
    const onWriteCallback: WriteCallback = (error) => {
      callbackDone = true;
      callbackError = error || null;
      // If the Duplex called back synchronously, wait until write() has
      // returned so the write(false)/drain state is known before resolving or
      // starting the next frame.
      if (!writeReturned) return;
      completeActiveWrite(entry, callbackError);
    };

    let writable: boolean;
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

  function send(value: unknown): Promise<void> {
    if (finished) {
      return Promise.reject(new TransportError(finalCode ?? TRANSPORT_CODES.CLOSED));
    }
    let payload: Buffer;
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
      outbound.push({ frame, resolve, reject, callbackDone: false });
      outboundBytes += frameLength;
      outboundCount += 1;
      maybeWriteNext();
    });
  }

  function close(): void {
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
