/**
 * bounded-json-codec.ts
 *
 * Pure bounded JSON encoding for the length-prefixed JSON transport.
 * Shared constants, finite TransportError codes, and encodeMessage live here.
 * Duplex lifecycle belongs in bounded-json-transport.ts.
 */

import { Buffer } from "node:buffer";

export const MAX_PAYLOAD = 32768; // inbound and outbound payload bytes
export const MAX_RETAINED_BYTES = 65536; // inbound retained payload bytes
export const MAX_RETAINED_FRAMES = 4; // inbound retained frames, active callback included
export const MAX_SEND_BYTES = 65536; // outbound queued + active frame bytes, headers included
export const MAX_SEND_FRAMES = 4; // outbound queued + active frames
export const MAX_DEPTH = 12; // outbound structural nesting, root container counts as depth 1
export const MAX_VALUES = 4096; // outbound visited values, containers and scalars alike

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

export type TransportCode = (typeof TRANSPORT_CODES)[keyof typeof TRANSPORT_CODES];

/** Error carrying only a finite code; no payload or peer text is attached. */
export class TransportError extends Error {
  readonly code: TransportCode;

  constructor(code: TransportCode) {
    super(code);
    this.name = "TransportError";
    this.code = code;
  }
}

export type JsonTransportMessage = Record<string, unknown>;

type EncodeContext = {
  count: number;
  units: number;
  parts: string[];
  seen: Set<object>;
};

function hasLoneSurrogate(value: string): boolean {
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
function writeString(value: string): string {
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
function push(ctx: EncodeContext, text: string): void {
  ctx.units += text.length;
  if (ctx.units > MAX_PAYLOAD) throw new TransportError(TRANSPORT_CODES.ENCODE);
  ctx.parts.push(text);
}

function writeObject(node: object, depth: number, ctx: EncodeContext): void {
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
    if (key === undefined) throw new TransportError(TRANSPORT_CODES.ENCODE);
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

function writeArray(node: unknown[], depth: number, ctx: EncodeContext): void {
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
    if (key === undefined) throw new TransportError(TRANSPORT_CODES.ENCODE);
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

function writeValue(node: unknown, depth: number, ctx: EncodeContext): void {
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
export function encodeMessage(value: unknown): Buffer {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TransportError(TRANSPORT_CODES.ENCODE);
  }
  const ctx: EncodeContext = { count: 0, units: 0, parts: [], seen: new Set() };
  writeValue(value, 1, ctx);
  const text = ctx.parts.join("");
  const payload = Buffer.from(text, "utf8");
  if (payload.length > MAX_PAYLOAD) throw new TransportError(TRANSPORT_CODES.ENCODE);
  return payload;
}
