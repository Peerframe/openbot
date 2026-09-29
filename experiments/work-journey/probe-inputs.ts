import { readFile, unlink, writeFile } from "node:fs/promises";

/**
 * Typed JSON boundaries for the Work journey Node fixtures. Python writes these documents
 * (product_browser_probe.py, product_command_probe.py); each entry narrows only fields it uses.
 * Authority checks (loopback relays, SSH target, fixed synthetic values) stay in each entry.
 */
export type JsonRecord = Readonly<Record<string, unknown>>;

export interface ProbeClientConfig {
  readonly nodeId: string;
  readonly serverUrl: string;
  readonly credential: string;
  readonly directory: string;
  readonly computerUrl: string;
  readonly token: string;
  readonly targetUrl: string;
}

export interface BrowserProbeInput {
  readonly nodeId: string;
  readonly botId: string;
  readonly serverUrl: string;
  readonly credential: string;
  readonly directory: string;
  readonly upstream: string;
  readonly recovery: boolean;
  readonly nodeProcess: boolean;
  readonly responseLoss: boolean;
  readonly profileRestart: boolean;
}

export interface RemoteBrowserInput {
  readonly nodeId: string;
  readonly serverUrl: string;
  readonly credential: string;
  readonly directory: string;
  /** Checked only by the remote entry, which owns the SSH and relay authority rules. */
  readonly remote: unknown;
}

export interface CommandNodeInput {
  readonly version: 1;
  readonly nodeId: string;
  readonly serverUrl: string;
  readonly socketPath: string;
  readonly enrollmentToken: string;
  readonly selection: Readonly<{
    nodeId: string;
    providerId: string;
    enforcementKeyId: string;
    ledgerId: string;
  }>;
}

export interface ControlRequest {
  readonly id: number;
  /** A missing or non-string operation reaches each entry's own lifecycle refusal. */
  readonly operation: string | undefined;
  readonly credential: string | undefined;
}

export interface ControlLoopOptions {
  readonly directory: string;
  readonly maximumId: number;
  readonly refusal: string;
  isStopped(): boolean;
  handle(request: ControlRequest): Promise<void>;
  stop(): Promise<void>;
}

export interface ControlLoop {
  close(): void;
}

export const CONTROL_POLL_MS = 100;

export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function jsonRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Invalid fixture ${label}`);
  return value as JsonRecord;
}

function text(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`Invalid fixture field ${key}`);
  return value;
}

function flag(record: JsonRecord, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`Invalid fixture field ${key}`);
  return value;
}

/** Decodes once after collecting bytes, so a UTF-8 sequence split across chunks stays intact. */
export async function readStdinText(
  input: AsyncIterable<unknown>,
  maximumBytes?: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of input) {
    let chunk: Buffer;
    if (typeof part === "string") chunk = Buffer.from(part, "utf8");
    else if (part instanceof Uint8Array)
      chunk = Buffer.from(part.buffer, part.byteOffset, part.byteLength);
    else throw new TypeError("Fixture input must be bytes or text");
    size += chunk.byteLength;
    if (maximumBytes !== undefined && size > maximumBytes)
      throw new Error("Oversized fixture input");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

export async function readStdinJson(
  input: AsyncIterable<unknown>,
  maximumBytes?: number,
): Promise<unknown> {
  const value: unknown = JSON.parse(await readStdinText(input, maximumBytes));
  return value;
}

/** A missing private fixture file is "not yet written"; every other failure is reported. */
export async function readOptionalJson(path: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
  const value: unknown = JSON.parse(source);
  return value;
}

export function parseProbeClientConfig(value: unknown): ProbeClientConfig {
  const record = jsonRecord(value, "client configuration");
  return {
    nodeId: text(record, "nodeId"),
    serverUrl: text(record, "serverUrl"),
    credential: text(record, "credential"),
    directory: text(record, "directory"),
    computerUrl: text(record, "computerUrl"),
    token: text(record, "token"),
    targetUrl: text(record, "targetUrl"),
  };
}

export function parseBrowserProbeInput(value: unknown): BrowserProbeInput {
  const record = jsonRecord(value, "browser input");
  return {
    nodeId: text(record, "nodeId"),
    botId: text(record, "botId"),
    serverUrl: text(record, "serverUrl"),
    credential: text(record, "credential"),
    directory: text(record, "directory"),
    upstream: text(record, "upstream"),
    recovery: flag(record, "recovery"),
    nodeProcess: flag(record, "nodeProcess"),
    responseLoss: flag(record, "responseLoss"),
    profileRestart: flag(record, "profileRestart"),
  };
}

export function parseRemoteBrowserInput(value: unknown): RemoteBrowserInput {
  const record = jsonRecord(value, "remote browser input");
  return {
    nodeId: text(record, "nodeId"),
    serverUrl: text(record, "serverUrl"),
    credential: text(record, "credential"),
    directory: text(record, "directory"),
    remote: record.remote,
  };
}

export function parseCommandNodeInput(value: unknown): CommandNodeInput {
  const config = jsonRecord(value, "command input");
  const selection = jsonRecord(config.selection, "command selection");
  const nodeId = text(config, "nodeId");
  if (config.version !== 1 || nodeId !== selection.nodeId)
    throw new Error("Explicit fixture identity required");
  return {
    version: 1,
    nodeId,
    serverUrl: text(config, "serverUrl"),
    socketPath: text(config, "socketPath"),
    enrollmentToken: text(config, "enrollmentToken"),
    selection: {
      nodeId,
      providerId: text(selection, "providerId"),
      enforcementKeyId: text(selection, "enforcementKeyId"),
      ledgerId: text(selection, "ledgerId"),
    },
  };
}

/** Reads one staged request; an out-of-range id is refused before the file is consumed. */
export async function takeControlRequest(
  directory: string,
  maximumId: number,
  refusal: string,
): Promise<ControlRequest | undefined> {
  const path = `${directory}/control-request.json`;
  const value = await readOptionalJson(path);
  if (value === undefined) return undefined;
  const request = jsonRecord(value, "control request");
  const id = request.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 || id > maximumId)
    throw new Error(refusal);
  await unlink(path);
  const { operation, credential } = request;
  if (credential === undefined || typeof credential === "string")
    return { id, operation: typeof operation === "string" ? operation : undefined, credential };
  throw new Error("Invalid fixture control credential");
}

/** Owns the 100 ms private control poll: one request at a time; a failure stops the fixture. */
export function startControlLoop(options: ControlLoopOptions): ControlLoop {
  let busy = false;
  const poll = async (): Promise<void> => {
    if (busy || options.isStopped()) return;
    busy = true;
    try {
      const request = await takeControlRequest(
        options.directory,
        options.maximumId,
        options.refusal,
      );
      if (request === undefined) return;
      await options.handle(request);
      await writeFile(
        `${options.directory}/control-${request.id}.json`,
        JSON.stringify({ done: true }),
      );
    } catch (error) {
      process.stderr.write(`${String(error)}\n`);
      await options.stop();
      process.exitCode = 1;
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => {
    void poll();
  }, CONTROL_POLL_MS);
  return {
    close: () => clearInterval(timer),
  };
}
