import { z } from "zod";

/** Candidate command-only protocol. The existing Node channel remains on its current version. */
export const commandProtocolVersion = "0.10.0" as const;
export const commandFrameMaxBytes = 32_768;
const inputBytes = 20 * 1024 * 1024;
const outputBytes = 1024 * 1024;
const utf8 = new TextEncoder();

export class CommandFrameError extends Error {
  constructor() {
    super("invalid_command_frame");
    this.name = "CommandFrameError";
  }
}

/** Equivalent to the Python bounded JSON value domain, before any schema traversal or hashing. */
function boundedValue(value: unknown): boolean {
  let remaining = 4096;
  const parents = new Set<object>();
  const text = (s: string) => !s.includes("\0") && !/[\uD800-\uDFFF]/u.test(s);
  function visit(item: unknown, depth: number): void {
    if (--remaining < 0 || depth > 12) throw new CommandFrameError();
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isSafeInteger(item)) return;
    if (typeof item === "string" && text(item)) return;
    if (typeof item !== "object" || item === null || parents.has(item))
      throw new CommandFrameError();
    const array = Array.isArray(item);
    if (
      !array &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw new CommandFrameError();
    parents.add(item);
    const keys = Reflect.ownKeys(item);
    if (array && keys.length !== item.length + 1) throw new CommandFrameError();
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string" || !key || !text(key) || utf8.encode(key).length > 128)
        throw new CommandFrameError();
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) throw new CommandFrameError();
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))
        throw new CommandFrameError();
      visit(descriptor.value, depth + 1);
    }
    parents.delete(item);
  }
  try {
    visit(value, 0);
    return utf8.encode(JSON.stringify(value)).length <= commandFrameMaxBytes;
  } catch {
    return false;
  }
}

const identity = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const actionIdentity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const integer = (min: number, max: number) => z.number().int().min(min).max(max);
const filename = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const token = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

export const commandPreparationBindingSchema = z
  .object({
    taskId: identity,
    runId: identity,
    actionId: actionIdentity,
    preparationId: uuid,
    connectionId: uuid,
    originalEpoch: integer(1, 10_000),
    authorityGeneration: integer(1, Number.MAX_SAFE_INTEGER),
    profileDigest: digest,
    intentDigest: digest,
    operationFingerprint: digest,
    nodeId: identity,
    providerId: identity,
    enforcementKeyId: identity,
    ledgerId: uuid,
  })
  .strict();
export type CommandPreparationBinding = z.infer<typeof commandPreparationBindingSchema>;

const inputFile = z
  .object({ path: filename, size: integer(0, inputBytes), sha256: digest })
  .strict();
const limits = z
  .object({
    nanoCPUs: integer(1, 1_000_000_000),
    memoryMiB: integer(1, 512),
    pids: integer(1, 512),
    nofile: integer(1, 256),
    tmpMiB: integer(1, 32),
    wallSeconds: integer(1, 60),
    outputMiB: integer(1, 64),
    capturedOutputKiB: integer(1, 1024),
  })
  .strict();
const command = z
  .object({
    image: z
      .string()
      .min(73)
      .max(256)
      .regex(/^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$/),
    argv: z
      .array(z.string().refine((s) => [...s].length >= 1 && [...s].length <= 4096))
      .min(1)
      .max(64),
    inputManifest: z.array(inputFile).max(8),
    inputDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    output: z
      .object({
        name: filename,
        mediaType: z.enum(["text/plain", "text/csv"]),
        maxBytes: integer(1, outputBytes),
      })
      .strict(),
    limits,
    network: z.literal("none"),
    rootfs: z.literal("readonly"),
    user: z.literal("10001:10001"),
    environment: z.array(z.string()).max(0),
  })
  .strict()
  .refine(async (value) => {
    const names = value.inputManifest.map((entry) => entry.path);
    if (
      names.some((name, i) => i > 0 && name <= (names[i - 1] ?? "")) ||
      value.inputManifest.reduce((sum, entry) => sum + entry.size, 0) > inputBytes
    )
      return false;
    // This fixed ASCII-key record is already in JCS order; no arbitrary-value canonicalization.
    const bytes = utf8.encode(
      JSON.stringify(value.inputManifest.map(({ path, sha256, size }) => ({ path, sha256, size }))),
    );
    const hash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
    return (
      value.inputDigest ===
      `sha256:${Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
    );
  });
const route = z
  .object({ nodeId: identity, providerId: identity, enforcementKeyId: identity, ledgerId: uuid })
  .strict();
export const commandDispatchOperationSchema = z
  .object({
    format: z.literal("openbot.work-command.operation/v1"),
    taskId: identity,
    runId: identity,
    actionId: actionIdentity,
    authorityGeneration: integer(1, Number.MAX_SAFE_INTEGER),
    originalEpoch: integer(1, 10_000),
    profileDigest: digest,
    route,
    intentDigest: digest,
    command,
  })
  .strict();

const refused = z
  .object({
    status: z.enum(["denied", "lookup_required"]),
    code: z.enum([
      "authority_changed",
      "connection_changed",
      "invalid_request",
      "expired",
      "unavailable",
      "lookup_required",
    ]),
  })
  .strict();
const tokenPayload = z.object({ token }).strict();
const chunk = z
  .object({
    fileIndex: integer(0, 7),
    offset: integer(0, inputBytes),
    data: z
      .string()
      .min(4)
      .max(21848)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict()
  .refine((value) => {
    try {
      const raw = atob(value.data);
      return (
        raw.length >= 1 &&
        raw.length <= 16_384 &&
        btoa(raw) === value.data &&
        value.offset + raw.length <= inputBytes
      );
    } catch {
      return false;
    }
  });
const ack = z.object({ fileIndex: integer(0, 7), nextOffset: integer(1, inputBytes) }).strict();
const envelope = {
  protocolVersion: z.literal(commandProtocolVersion),
  nodeId: identity,
  requestId: uuid,
  preparationId: uuid,
};
const frame = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.object({ ...envelope, type: z.literal(type), payload }).strict();
const prepareFrame = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  frame(type, payload).refine((value) => value.requestId === value.preparationId);
const prepare = prepareFrame("work.command.prepare_open", commandPreparationBindingSchema).refine(
  (value) =>
    value.nodeId === value.payload.nodeId && value.preparationId === value.payload.preparationId,
);
const controlOpen = frame(
  "work.command.control_open",
  z
    .object({
      binding: commandPreparationBindingSchema,
      operation: z.enum(["lookup", "stop"]),
    })
    .strict(),
).refine(
  (value) =>
    value.nodeId === value.payload.binding.nodeId &&
    value.preparationId === value.payload.binding.preparationId,
);
const outputChunk = frame("work.command.output_chunk", chunk).refine((value) => {
  try {
    return (
      value.payload.fileIndex === 0 &&
      value.payload.offset + atob(value.payload.data).length <= outputBytes
    );
  } catch {
    return false;
  }
});
const outputAck = frame("work.command.output_ack", ack).refine(
  (value) => value.payload.fileIndex === 0 && value.payload.nextOffset <= outputBytes,
);
const errorFrame = frame("work.command.error", refused);

const serverFrames = z.discriminatedUnion("type", [
  controlOpen,
  prepare,
  prepareFrame("work.command.prepare_authorize", tokenPayload),
  frame(
    "work.command.dispatch",
    z.object({ ticket: token, operation: commandDispatchOperationSchema }).strict(),
  ),
  frame(
    "work.command.consume_result",
    z.union([z.object({ status: z.literal("consumed"), permit: token }).strict(), refused]),
  ),
  frame("work.command.lookup", tokenPayload),
  frame("work.command.stop", tokenPayload),
  frame("work.command.input_chunk", chunk),
  outputAck,
  errorFrame,
]);
const nodeFrames = z.discriminatedUnion("type", [
  frame("work.command.control_challenge", tokenPayload),
  prepareFrame("work.command.prepare_challenge", tokenPayload),
  prepareFrame("work.command.ready", tokenPayload),
  frame("work.command.consume", tokenPayload),
  frame("work.command.lookup_result", tokenPayload),
  outputChunk,
  frame("work.command.input_ack", ack),
  errorFrame,
]);
const bounded = z.unknown().refine(boundedValue, "invalid_command_frame");
/** Always use parseAsync/safeParseAsync: dispatch includes native SHA-256 verification. */
export const commandServerFrameSchema = bounded.pipe(serverFrames);
export const commandNodeFrameSchema = bounded.pipe(nodeFrames);
export type CommandServerFrame = z.infer<typeof commandServerFrameSchema>;
export type CommandNodeFrame = z.infer<typeof commandNodeFrameSchema>;

export async function parseCommandFrame(
  value: unknown,
  options: { server: true },
): Promise<CommandServerFrame>;
export async function parseCommandFrame(
  value: unknown,
  options: { server: false },
): Promise<CommandNodeFrame>;
export async function parseCommandFrame(
  value: unknown,
  options: { server: boolean },
): Promise<CommandServerFrame | CommandNodeFrame>;
export async function parseCommandFrame(
  value: unknown,
  { server }: { server: boolean },
): Promise<CommandServerFrame | CommandNodeFrame> {
  try {
    if (typeof server !== "boolean") throw new CommandFrameError();
    return await (server ? commandServerFrameSchema : commandNodeFrameSchema).parseAsync(value);
  } catch {
    throw new CommandFrameError();
  }
}
