/**
 * Dependency-free adapter over the pinned agent-computer browser endpoints.
 *
 * This module is the integration surface: it drives the caller-supplied
 * `request` transport and returns validated `{ frame, page }` values. It does
 * NOT provide egress isolation. The origin allowlist and `checkUrl` are policy
 * checks only, never a network boundary. The caller owns per-Bot serialization
 * and the human-control latch; this function re-checks GET /control before any
 * operation.
 *
 * Every failure is thrown as a fixed, content-free `BrowserTaskError`. A
 * mutating request (navigate/click/type/key/scroll) is dispatched at most once
 * per invocation and is never retried here, because a failed or ambiguous
 * response may still mean the mutation occurred.
 *
 * Endpoints used: GET /control, GET /screenshot, POST /navigate, POST /click,
 * POST /type, POST /key, POST /scroll, GET /read, POST /snapshot. Nothing else
 * (no human/*, take/release, shell, evaluate, selectors or file endpoints).
 */
import { createHash } from "node:crypto";
import { browserTaskActionSchema } from "@openbot/protocol";

// --- public types ---------------------------------------------------------

/** Frozen evidence a mutation must still match when it is dispatched. */
export interface Expected {
  readonly url: string;
  readonly snapshotId: number;
  readonly frameSha256: string;
}

/** The only actions this adapter will perform. */
export type TaskAction =
  | { readonly kind: "read" }
  | { readonly kind: "navigate"; readonly url: string }
  | { readonly kind: "click"; readonly ref: string; readonly expected: Expected }
  | {
      readonly kind: "type";
      readonly ref: string;
      readonly text: string;
      readonly expected: Expected;
    }
  | { readonly kind: "key"; readonly key: string; readonly expected: Expected }
  | { readonly kind: "scroll"; readonly deltaY: number; readonly expected: Expected };

export interface BrowserTaskOptions {
  /** Transport owned by the caller; path is relative to the computer base URL. */
  readonly request: (path: string, body?: unknown) => Promise<unknown>;
  /** Additional URL policy check. Not an egress control. */
  readonly checkUrl: (url: string) => Promise<void>;
  /** Exact HTTP(S) origins allowed for this task. */
  readonly origins: readonly string[];
  readonly action: TaskAction;
  readonly signal: AbortSignal;
}

/** Validated payload of GET /read. */
export interface BrowserRead {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly truncated: boolean;
}

/** Validated element of POST /snapshot. */
export interface BrowserElement {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  readonly value?: string;
  readonly disabled?: boolean;
  readonly checked?: boolean;
}

/** Validated payload of POST /snapshot. */
export interface BrowserSnapshot {
  readonly url: string;
  readonly snapshotId: number;
  readonly elements: readonly BrowserElement[];
  readonly truncated: boolean;
}

/** Page view assembled from /read and /snapshot. */
export interface BrowserPage {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly snapshotId: number;
  readonly elements: readonly BrowserElement[];
}

/** Validated PNG frame captured from /screenshot. */
export interface BrowserFrame {
  readonly base64: string;
  readonly width: number;
  readonly height: number;
  readonly capturedAt: string;
  readonly url: string;
}

export interface BrowserTaskResult {
  readonly frame: unknown;
  readonly page: unknown;
}

/** The single fixed, content-free failure message. */
export const BROWSER_TASK_ERROR = "Browser task failed.";

/**
 * Fixed-message error. `uncertain` is true when a mutation had already been
 * dispatched, so the caller must not retry automatically.
 */
export class BrowserTaskError extends Error {
  readonly uncertain: boolean;
  constructor(uncertain = false) {
    super(BROWSER_TASK_ERROR);
    this.name = "BrowserTaskError";
    this.uncertain = uncertain;
  }
}

// --- bounds and patterns ---------------------------------------------------

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_IHDR_LENGTH = 13;
const MAX_FRAME_BYTES = 5 * 1024 * 1024;
const MAX_FRAME_BASE64_LENGTH = 7_000_000;
const MIN_FRAME_BASE64_LENGTH = 12;
const MAX_DIMENSION = 8192;
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 1024;
const MAX_TEXT_LENGTH = 16000;
const MAX_ELEMENTS = 200;
const MAX_ROLE_LENGTH = 64;
const MAX_NAME_LENGTH = 1024;
const MAX_VALUE_LENGTH = 4096;
const MAX_REF_LENGTH = 18;
const MAX_CAPTURED_AT_LENGTH = 64;
const MAX_PAGE_JSON_BYTES = 65536;

const REF_PATTERN = /^(?:f[0-9]{1,8})?e[0-9]{1,8}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/;
const ELEMENT_KEYS = new Set(["ref", "role", "name", "value", "disabled", "checked"]);

// --- primitive validators --------------------------------------------------

function invalid(): Error {
  // Internal sentinel; the public boundary replaces this with BrowserTaskError.
  return new Error("invalid browser data");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, maximum: number, minimum = 0): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum)
    throw invalid();
  return value;
}

function safeInteger(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw invalid();
  return value;
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw invalid();
  return value;
}

function requireRef(value: unknown): string {
  const ref = boundedString(value, MAX_REF_LENGTH, 2);
  if (!REF_PATTERN.test(ref)) throw invalid();
  return ref;
}

// --- origin / URL policy ---------------------------------------------------

/** Normalize the configured origins; every entry must be a bare HTTP(S) origin. */
function buildAllowlist(origins: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(origins) || origins.length === 0 || origins.length > 10) throw invalid();
  const allowlist = new Set<string>();
  for (const entry of origins) {
    const raw = boundedString(entry, MAX_URL_LENGTH, 1);
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw invalid();
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw invalid();
    if (parsed.username !== "" || parsed.password !== "" || parsed.origin !== raw) throw invalid();
    allowlist.add(parsed.origin);
  }
  if (allowlist.size === 0) throw invalid();
  return allowlist;
}

/**
 * Require an exact allowlisted HTTP(S) origin with no credentials. `about:blank`
 * is accepted only when the caller explicitly allows it (the `read` action).
 * `checkUrl` runs only for a non-blank URL and is an additional policy check,
 * never egress control.
 */
async function assertUrlAllowed(
  rawUrl: string,
  allowlist: ReadonlySet<string>,
  checkUrl: (url: string) => Promise<void>,
  signal: AbortSignal,
  allowBlank: boolean,
): Promise<void> {
  if (rawUrl === "about:blank") {
    if (!allowBlank) throw invalid();
    return;
  }
  const raw = boundedString(rawUrl, MAX_URL_LENGTH, 1);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalid();
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw invalid();
  if (parsed.username !== "" || parsed.password !== "") throw invalid();
  if (!allowlist.has(parsed.origin)) throw invalid();
  signal.throwIfAborted();
  await checkUrl(raw);
  signal.throwIfAborted();
}

// --- response validators ---------------------------------------------------

function parseExpected(value: unknown): Expected {
  const raw = asRecord(value);
  const url = boundedString(raw.url, MAX_URL_LENGTH, 1);
  const snapshotId = safeInteger(raw.snapshotId, 1, Number.MAX_SAFE_INTEGER);
  const frameSha256 = boundedString(raw.frameSha256, 64, 64);
  if (!SHA256_PATTERN.test(frameSha256)) throw invalid();
  return { url, snapshotId, frameSha256 };
}

function parseRead(value: unknown): BrowserRead {
  const raw = asRecord(value);
  return {
    url: boundedString(raw.url, MAX_URL_LENGTH, 1),
    title: boundedString(raw.title, MAX_TITLE_LENGTH),
    text: boundedString(raw.text, MAX_TEXT_LENGTH),
    truncated: requireBoolean(raw.truncated),
  };
}

function parseElement(value: unknown): BrowserElement {
  const raw = asRecord(value);
  for (const key of Object.keys(raw)) {
    if (!ELEMENT_KEYS.has(key)) throw invalid();
  }
  const ref = requireRef(raw.ref);
  const role = boundedString(raw.role, MAX_ROLE_LENGTH, 1);
  const name = boundedString(raw.name, MAX_NAME_LENGTH);
  const element: {
    ref: string;
    role: string;
    name: string;
    value?: string;
    disabled?: boolean;
    checked?: boolean;
  } = { ref, role, name };
  if (Object.prototype.hasOwnProperty.call(raw, "value")) {
    element.value = boundedString(raw.value, MAX_VALUE_LENGTH);
  }
  if (Object.prototype.hasOwnProperty.call(raw, "disabled")) {
    element.disabled = requireBoolean(raw.disabled);
  }
  if (Object.prototype.hasOwnProperty.call(raw, "checked")) {
    element.checked = requireBoolean(raw.checked);
  }
  return element;
}

function parseSnapshot(value: unknown): BrowserSnapshot {
  const raw = asRecord(value);
  const url = boundedString(raw.url, MAX_URL_LENGTH, 1);
  const snapshotId = safeInteger(raw.snapshotId, 1, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(raw.elements) || raw.elements.length > MAX_ELEMENTS) throw invalid();
  const seen = new Set<string>();
  const elements: BrowserElement[] = [];
  for (const item of raw.elements) {
    const element = parseElement(item);
    if (seen.has(element.ref)) throw invalid();
    seen.add(element.ref);
    elements.push(element);
  }
  return { url, snapshotId, elements, truncated: requireBoolean(raw.truncated) };
}

interface ObservedFrame {
  readonly frame: BrowserFrame;
  readonly sha256: string;
}

/**
 * Validate a /screenshot payload: canonical base64, <= 5 MiB decoded, PNG
 * signature, 24-byte IHDR header, dimensions 1..8192 matching the metadata.
 */
function observeFrame(value: unknown): ObservedFrame {
  const raw = asRecord(value);
  const url = boundedString(raw.url, MAX_URL_LENGTH, 1);
  const base64 = boundedString(raw.base64, MAX_FRAME_BASE64_LENGTH, MIN_FRAME_BASE64_LENGTH);
  if (!BASE64_PATTERN.test(base64)) throw invalid();
  const width = safeInteger(raw.width, 1, MAX_DIMENSION);
  const height = safeInteger(raw.height, 1, MAX_DIMENSION);
  const capturedAt = boundedString(raw.capturedAt, MAX_CAPTURED_AT_LENGTH, 1);

  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64) throw invalid();
  if (bytes.length > MAX_FRAME_BYTES || bytes.length < 24) throw invalid();
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw invalid();
  if (bytes.readUInt32BE(8) !== PNG_IHDR_LENGTH) throw invalid();
  if (bytes.subarray(12, 16).toString("latin1") !== "IHDR") throw invalid();
  const pngWidth = bytes.readUInt32BE(16);
  const pngHeight = bytes.readUInt32BE(20);
  if (
    pngWidth < 1 ||
    pngWidth > MAX_DIMENSION ||
    pngHeight < 1 ||
    pngHeight > MAX_DIMENSION ||
    pngWidth !== width ||
    pngHeight !== height
  )
    throw invalid();

  return {
    frame: { base64, width, height, capturedAt, url },
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

// --- entry point -----------------------------------------------------------

/**
 * Run exactly one browser task. Callers must already hold the per-Bot
 * serialization lock and the human-control latch; this function additionally
 * requires GET /control to report `holder: "bot"` before any operation.
 *
 * Mutation semantics: navigate/click/type/key/scroll are each requested at most
 * once. If any step fails after a mutation was dispatched, the caller receives
 * a `BrowserTaskError` with `uncertain === true` and must not retry it blindly.
 */
export async function runBrowserTask(
  options: BrowserTaskOptions,
): Promise<{ frame: unknown; page: unknown }> {
  let uncertain = false;
  try {
    const { request, checkUrl, origins, signal } = options;
    const action = browserTaskActionSchema.parse(options.action);
    if (
      typeof request !== "function" ||
      typeof checkUrl !== "function" ||
      !signal ||
      typeof signal.throwIfAborted !== "function"
    )
      throw invalid();

    const allowlist = buildAllowlist(origins);

    // Signal check before and after every transport call.
    const call = async (path: string, body?: unknown): Promise<unknown> => {
      signal.throwIfAborted();
      const result = await request(path, body);
      signal.throwIfAborted();
      return result;
    };

    // The function re-checks the control latch itself before any operation.
    const control = asRecord(await call("/control"));
    if (control.holder !== "bot") throw invalid();

    if (action.kind === "navigate") {
      const target = boundedString(action.url, MAX_URL_LENGTH, 1);
      await assertUrlAllowed(target, allowlist, checkUrl, signal, false);
      uncertain = true;
      await call("/navigate", { url: target });
    } else if (action.kind === "read") {
      // Non-navigate actions observe first. A read may sit on about:blank.
      const before = observeFrame(await call("/screenshot"));
      await assertUrlAllowed(before.frame.url, allowlist, checkUrl, signal, true);
    } else if (
      action.kind === "click" ||
      action.kind === "type" ||
      action.kind === "key" ||
      action.kind === "scroll"
    ) {
      // No /snapshot before a mutation: it would change upstream snapshot
      // identity and invalidate the frozen expected state.
      const expected = parseExpected(action.expected);
      const before = observeFrame(await call("/screenshot"));
      if (before.frame.url !== expected.url) throw invalid();
      if (before.sha256 !== expected.frameSha256.toLowerCase()) throw invalid();
      await assertUrlAllowed(before.frame.url, allowlist, checkUrl, signal, false);

      // Exactly one mutation attempt; no response inspection and no retry.
      uncertain = true;
      if (action.kind === "click") {
        const ref = requireRef(action.ref);
        await call("/click", { ref, snapshotId: expected.snapshotId });
      } else if (action.kind === "type") {
        const ref = requireRef(action.ref);
        await call("/type", { ref, text: action.text, snapshotId: expected.snapshotId });
      } else if (action.kind === "key") {
        await call("/key", { key: boundedString(action.key, MAX_TEXT_LENGTH, 1) });
      } else {
        if (typeof action.deltaY !== "number" || !Number.isFinite(action.deltaY)) throw invalid();
        await call("/scroll", { deltaY: action.deltaY });
      }
    } else {
      throw invalid();
    }

    // Post-operation observation: GET /read, POST /snapshot, GET /screenshot.
    const read = parseRead(await call("/read"));
    const snapshot = parseSnapshot(await call("/snapshot", {}));
    const observed = observeFrame(await call("/screenshot"));

    if (read.url !== snapshot.url || read.url !== observed.frame.url) throw invalid();
    await assertUrlAllowed(read.url, allowlist, checkUrl, signal, action.kind === "read");

    const page: BrowserPage = {
      url: read.url,
      title: read.title,
      text: read.text,
      truncated: read.truncated || snapshot.truncated,
      snapshotId: snapshot.snapshotId,
      elements: snapshot.elements,
    };
    // Never truncate silently: an oversized page JSON is a hard failure.
    if (Buffer.byteLength(JSON.stringify(page), "utf8") > MAX_PAGE_JSON_BYTES) throw invalid();

    return { frame: observed.frame, page };
  } catch {
    // Fixed message only: never forward service text or page content.
    throw new BrowserTaskError(uncertain);
  }
}
