/**
 * Fixed-image CDP qualification only; no Server authority or general browser executor.
 * NUL framing narrowly adapts Playwright v1.62.1 pipeTransport.ts behavior.
 * Copyright 2018 Google Inc. Modifications copyright Microsoft Corporation.
 * Licensed under Apache-2.0; see accompanying LICENSE/NOTICE. OpenBot adds bounds.
 *
 * This module is the single owner of the adapted pipe framing moved from probe.mjs.
 */
import type { Readable, Writable } from "node:stream";
import {
  errorCode,
  fail,
  isJsonObject,
  type JsonObject,
  LIMITS,
  type ProbeFailure,
} from "./probe-contract.ts";

export type CdpMethod =
  | "Browser.getVersion"
  | "Browser.close"
  | "Target.createTarget"
  | "Target.attachToTarget"
  | "Page.enable"
  | "Page.setLifecycleEventsEnabled"
  | "Page.navigate"
  | "Runtime.evaluate"
  | "Emulation.setDeviceMetricsOverride"
  | "Page.captureScreenshot";

// Runtime allowlists stay authoritative; the method type only documents callers.
const METHODS: ReadonlySet<string> = new Set<CdpMethod>([
  "Browser.getVersion",
  "Browser.close",
  "Target.createTarget",
  "Target.attachToTarget",
  "Page.enable",
  "Page.setLifecycleEventsEnabled",
  "Page.navigate",
  "Runtime.evaluate",
  "Emulation.setDeviceMetricsOverride",
  "Page.captureScreenshot",
]);
const EVENTS: ReadonlySet<string> = new Set([
  "Page.lifecycleEvent",
  "Inspector.targetCrashed",
  "Target.targetCrashed",
]);
const MAX_PENDING = 16;
const MAX_CALLS = 96;
const MAX_EVENTS = 128;
const MAX_REQUEST_BYTES = 32768;

/** Lifecycle parameters proven by the matcher; other library fields pass through unchanged. */
export interface LifecycleParams extends JsonObject {
  readonly frameId: string;
  readonly loaderId: string;
  readonly name: string;
}
type LoadedEvent = JsonObject & { readonly params: LifecycleParams };

export interface CdpCaller {
  call(
    method: CdpMethod,
    params?: JsonObject,
    session?: string,
    timeout?: number,
  ): Promise<JsonObject>;
}
export interface CdpLifecycle {
  loaded(
    session: string,
    frameId: string,
    loaderId: string,
    timeout: number,
  ): Promise<LifecycleParams>;
}

interface PendingCall {
  readonly resolve: (result: JsonObject) => void;
  readonly reject: (error: ProbeFailure) => void;
  readonly timer: NodeJS.Timeout;
  readonly session: string;
}
interface LifecycleWaiter {
  readonly resolve: (params: LifecycleParams) => void;
  readonly reject: (error: ProbeFailure) => void;
  readonly matches: (message: JsonObject) => message is LoadedEvent;
  readonly timer: NodeJS.Timeout;
}

function isLoadedEvent(
  message: JsonObject,
  session: string,
  frameId: string,
  loaderId: string,
): message is LoadedEvent {
  const params = message.params;
  return (
    message.method === "Page.lifecycleEvent" &&
    message.sessionId === session &&
    isJsonObject(params) &&
    params.frameId === frameId &&
    params.loaderId === loaderId &&
    params.name === "DOMContentLoaded"
  );
}

/**
 * Owns one browser's CDP pipe: framing, bounds, pending calls, lifecycle waiters and their
 * timers. Closing rejects everything it owns exactly once; a timed-out call is never resent.
 */
export class CDPPipe implements CdpCaller, CdpLifecycle {
  readonly pending = new Map<number, PendingCall>();
  readonly waiters = new Set<LifecycleWaiter>();
  readonly events: JsonObject[] = [];
  readonly eventCounts: Record<string, number> = {};
  /** Wire bytes received; public and writable so tests can exercise the aggregate bound. */
  bytes = 0;
  closed = false;
  reason: string | undefined;
  #buffer: Buffer = Buffer.alloc(0);
  #nextId = 0;
  readonly #write: Writable;

  constructor(write: Writable, read: Readable) {
    this.#write = write;
    read.on("data", (chunk: Buffer) => this.#receive(chunk));
    read.on("end", () => this.close("pipe-ended"));
    read.on("close", () => this.close("pipe-closed"));
    read.on("error", () => this.close("pipe-read-error"));
    write.on("error", () => this.close("pipe-write-error"));
  }

  close(reason = "pipe-closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.reason = reason;
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(fail(reason));
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(fail(reason));
    }
    this.waiters.clear();
    this.#buffer = Buffer.alloc(0);
  }

  call(
    method: CdpMethod,
    params: JsonObject = {},
    session = "",
    timeout = 1000,
  ): Promise<JsonObject> {
    if (this.closed) return Promise.reject(fail(this.reason ?? "pipe-closed"));
    if (
      !METHODS.has(method) ||
      this.pending.size >= MAX_PENDING ||
      ++this.#nextId > MAX_CALLS ||
      !(timeout > 0)
    )
      return Promise.reject(fail("request-bound"));
    const id = this.#nextId;
    const message = { id, method, params, ...(session ? { sessionId: session } : {}) };
    const bytes = Buffer.from(JSON.stringify(message) + "\0");
    if (bytes.length > MAX_REQUEST_BYTES) return Promise.reject(fail("request-bound"));
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(fail("cdp-timeout"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, session });
      this.#write.write(bytes, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(fail("pipe-write-error"));
        }
      });
    });
  }

  loaded(
    session: string,
    frameId: string,
    loaderId: string,
    timeout: number,
  ): Promise<LifecycleParams> {
    const matches = (message: JsonObject): message is LoadedEvent =>
      isLoadedEvent(message, session, frameId, loaderId);
    const found = this.events.find(matches);
    if (found) return Promise.resolve(found.params);
    if (this.closed) return Promise.reject(fail(this.reason ?? "pipe-closed"));
    return new Promise<LifecycleParams>((resolve, reject) => {
      const waiter: LifecycleWaiter = {
        resolve,
        reject,
        matches,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(fail("navigation-event-timeout"));
        }, timeout),
      };
      this.waiters.add(waiter);
    });
  }

  #receive(chunk: Buffer): void {
    if (this.closed) return;
    try {
      this.bytes += chunk.length;
      if (this.bytes > LIMITS.wire) throw fail("pipe-total-bound");
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      for (;;) {
        const end = this.#buffer.indexOf(0);
        if (end < 0) {
          if (this.#buffer.length > LIMITS.frame) throw fail("pipe-frame-bound");
          break;
        }
        if (end > LIMITS.frame) throw fail("pipe-frame-bound");
        const message: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(this.#buffer.subarray(0, end)),
        );
        this.#buffer = this.#buffer.subarray(end + 1);
        if (!isJsonObject(message)) throw fail("pipe-json-shape");
        if (Object.hasOwn(message, "id")) this.#settle(message);
        else if (typeof message.method === "string" && EVENTS.has(message.method))
          this.#record(message.method, message);
      }
    } catch (error) {
      this.close(errorCode(error) ?? "pipe-malformed-json");
    }
  }

  /** Settle one owned response; unknown ids are ignored, mismatched sessions fail closed. */
  #settle(message: JsonObject): void {
    const id = message.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)
      throw fail("pipe-response-id");
    const pending = this.pending.get(id);
    if (!pending) return;
    if ((message.sessionId ?? "") !== pending.session) throw fail("pipe-session-mismatch");
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (message.error) {
      const error = fail("cdp-protocol-error");
      const code =
        typeof message.error === "object" && message.error !== null
          ? Reflect.get(message.error, "code")
          : undefined;
      if (typeof code === "number" && Number.isSafeInteger(code)) error.protocolCode = code;
      pending.reject(error);
    } else if (!isJsonObject(message.result)) pending.reject(fail("pipe-result-shape"));
    else pending.resolve(message.result);
  }

  #record(method: string, message: JsonObject): void {
    this.eventCounts[method] = (this.eventCounts[method] ?? 0) + 1;
    this.events.push(message);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    for (const waiter of [...this.waiters])
      if (waiter.matches(message)) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(message.params);
      }
  }
}
