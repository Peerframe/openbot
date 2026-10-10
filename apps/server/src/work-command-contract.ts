/** Validates signed command purposes, causal deadlines and immutable execution bindings. */
import { createHash } from "node:crypto";
import { commandDispatchOperationSchema, commandPreparationBindingSchema } from "@openbot/protocol";
import { z } from "zod";
import { commandValue, invalidCommand } from "./work-command-values.js";

const integer = (min: number, max = Number.MAX_SAFE_INTEGER) => z.number().int().min(min).max(max);
const preparation = commandPreparationBindingSchema;
const { taskId: identity, preparationId: uuid, profileDigest: digest } = preparation.shape;
const positive = integer(1),
  millis = integer(1, 4102444800000),
  seconds = integer(1, 4102444800);
const nonce = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export const workCommandSchema = commandDispatchOperationSchema.shape.command;
export const commandRouteSchema = commandDispatchOperationSchema.shape.route;
export const commandIntentSchema = z
  .object({
    kind: z.literal("work_command"),
    version: z.literal(1),
    profileDigest: digest,
    command: workCommandSchema,
  })
  .strict();
export type WorkCommand = z.infer<typeof workCommandSchema>;
export type CommandIntent = z.infer<typeof commandIntentSchema>;
export type CommandOperation = z.infer<typeof commandDispatchOperationSchema>;
export const timingPolicySchema = z
  .object({
    prepareBudgetMs: integer(1, 30000),
    challengeBudgetMs: integer(1, 5000),
    runtimeMaxMs: integer(1, 60000),
    stopAllowanceMs: integer(1, 5000),
    clockRateErrorPpm: integer(0, 10000),
    clockQuantizationMs: integer(1, 1000),
    policyDigest: digest,
  })
  .strict();
export type TimingPolicy = z.infer<typeof timingPolicySchema>;
function scaledTime(ms: number, policy: TimingPolicy, upper: boolean) {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > Math.floor(Number.MAX_SAFE_INTEGER / 1000000))
    throw invalidCommand();
  return upper
    ? Math.ceil((ms * 1000000) / (1000000 - policy.clockRateErrorPpm)) + policy.clockQuantizationMs
    : Math.max(
        0,
        Math.floor((ms * 1000000) / (1000000 + policy.clockRateErrorPpm)) -
          policy.clockQuantizationMs,
      );
}
export const commandTimeUpper = (policy: TimingPolicy, ms: number) => scaledTime(ms, policy, true);
export const commandTimeLower = (policy: TimingPolicy, ms: number) => scaledTime(ms, policy, false);
export function checkCommandBudget(
  policy: TimingPolicy,
  start: number,
  root: number,
  wall: number,
) {
  if (
    commandTimeUpper(policy, policy.runtimeMaxMs) + policy.stopAllowanceMs > wall * 1000 ||
    start +
      Math.max(policy.prepareBudgetMs, commandTimeUpper(policy, policy.challengeBudgetMs)) +
      commandTimeUpper(policy, policy.runtimeMaxMs) +
      policy.stopAllowanceMs >
      root
  )
    throw invalidCommand();
}
const signedPreparation = {
  ...preparation.shape,
  version: z.literal(2),
  iss: identity,
  aud: identity,
  jti: uuid,
};
const exchange = { ...signedPreparation, requestId: uuid };
const challenge = {
  nonce,
  bootId: uuid,
  enforcerInstanceId: uuid,
  createdBoottimeUs: positive,
  expiresBoottimeUs: positive,
};
const validWindow = (v: { createdBoottimeUs: number; expiresBoottimeUs: number }) =>
  v.expiresBoottimeUs > v.createdBoottimeUs && v.expiresBoottimeUs - v.createdBoottimeUs <= 5000000;
const originalRequest = (v: { requestId: string; preparationId: string }) =>
  v.requestId === v.preparationId;
const stagingSchema = z
  .object({ ...workCommandSchema.shape })
  .omit({ argv: true })
  .strict()
  .refine(
    async (value) =>
      !!(
        await workCommandSchema.safeParseAsync({
          ...value,
          argv: ["/fixed-validation-placeholder"],
        })
      ).success,
  );
export const nativeCommandProofSchema = z
  .object({
    bootId: uuid,
    enforcerInstanceId: uuid,
    unitName: z.string().regex(/^openbot-command-[0-9a-f]{32}\.service$/),
    invocationId: z.string().regex(/^[0-9a-f]{32}$/),
    cgroupPath: z
      .string()
      .min(1)
      .max(256)
      .regex(/^\/[A-Za-z0-9_.:-]+(?:\/[A-Za-z0-9_.:-]+)*$/),
    cgroupInode: positive,
    activeMonotonicUs: positive,
    runtimeMaxUs: integer(1, 60000000),
    observedMonotonicUs: positive,
    observedBoottimeUs: positive,
    runtimeIdentityDigest: digest,
    runtimeShapeDigest: digest,
    timingPolicyDigest: digest,
    startAttempts: z.literal(0),
  })
  .strict()
  .refine((v) => {
    const parts = v.cgroupPath.split("/");
    return (
      parts.slice(1).every((p) => p && p !== "." && p !== "..") &&
      parts.at(-1) === v.unitName &&
      v.activeMonotonicUs <= v.observedMonotonicUs &&
      v.observedMonotonicUs < v.activeMonotonicUs + v.runtimeMaxUs &&
      v.observedBoottimeUs >= v.observedMonotonicUs
    );
  });
export const commandBindingV2Schema = z
  .object({
    ...preparation.shape,
    version: z.literal(2),
    dispatchId: uuid,
    hardDeadlineMs: millis,
    readinessDigest: digest,
  })
  .strict();
export type CommandBindingV2 = z.infer<typeof commandBindingV2Schema>;
const anchorsSchema = z
  .object({
    admittedAtMs: millis,
    rootDeadlineMs: millis,
    nativeDeadlineMs: millis,
    wallSeconds: integer(1, 60),
    hardDeadlineMs: millis,
    deadlineProfileVersion: z.literal(2),
  })
  .strict()
  .refine(
    (v) =>
      v.hardDeadlineMs === v.nativeDeadlineMs &&
      v.hardDeadlineMs > v.admittedAtMs &&
      v.hardDeadlineMs ===
        Math.min(v.rootDeadlineMs, v.nativeDeadlineMs, v.admittedAtMs + v.wallSeconds * 1000),
  );
const execution = {
  ...commandBindingV2Schema.shape,
  iss: identity,
  aud: identity,
  jti: uuid,
  iat: seconds,
  nbf: seconds,
  exp: seconds,
};
const validTimes = (v: { iat: number; nbf: number; exp: number }) =>
  v.nbf === v.iat && v.exp > v.iat && v.exp <= v.iat + 30;
const observation = z
  .object({
    phase: z.enum(["prepared", "running", "exited", "unknown"]),
    containerId: digest.nullable(),
    startAttempts: integer(0, 1),
    exitCode: integer(0, 255).nullable(),
    sequence: positive,
    runtimeShapeDigest: digest.nullable(),
    outputs: z
      .array(
        z
          .object({
            name: workCommandSchema.shape.output.shape.name,
            mediaType: z.enum(["text/plain", "text/csv"]),
            sizeBytes: integer(0, 1024 * 1024),
            sha256: digest,
          })
          .strict(),
      )
      .max(1),
    truncated: z.boolean(),
  })
  .strict()
  .refine((v) => {
    if (v.phase === "exited")
      return (
        v.containerId !== null &&
        v.runtimeShapeDigest !== null &&
        v.exitCode !== null &&
        v.startAttempts === 1
      );
    if (v.exitCode !== null || v.outputs.length) return false;
    if (v.phase === "prepared")
      return v.startAttempts === 0 && v.containerId === null && v.runtimeShapeDigest === null;
    if (v.phase === "running")
      return v.startAttempts === 1 && v.containerId !== null && v.runtimeShapeDigest !== null;
    return true;
  });
const controlRequest = {
  ...signedPreparation,
  purpose: z.literal("work_command_control_request"),
  challengeDigest: digest,
  requestId: uuid,
  nonce,
  issuedAtMs: millis,
  expiresAtMs: millis,
  dispatch: commandBindingV2Schema.nullable(),
};
const validControl = (v: z.infer<z.ZodObject<typeof controlRequest>>) =>
  v.expiresAtMs > v.issuedAtMs &&
  v.expiresAtMs - v.issuedAtMs <= 30000 &&
  (!v.dispatch ||
    Object.keys(preparation.shape).every((k) => Reflect.get(v.dispatch!, k) === Reflect.get(v, k)));
export const commandClaimSchemas = {
  work_command_prepare_challenge: z
    .object({ ...exchange, ...challenge, purpose: z.literal("work_command_prepare_challenge") })
    .strict()
    .refine(originalRequest)
    .refine(validWindow),
  work_command_prepare_authorize: z
    .object({
      ...exchange,
      purpose: z.literal("work_command_prepare_authorize"),
      nonce,
      challengeDigest: digest,
      issuedAtMs: millis,
      rootDeadlineMs: millis,
      timing: timingPolicySchema,
      staging: stagingSchema,
    })
    .strict()
    .refine(originalRequest)
    .refine((v) => {
      try {
        checkCommandBudget(v.timing, v.issuedAtMs, v.rootDeadlineMs, v.staging.limits.wallSeconds);
        return true;
      } catch {
        return false;
      }
    }),
  work_command_ready: z
    .object({
      ...exchange,
      purpose: z.literal("work_command_ready"),
      nonce,
      authorizationDigest: digest,
      inputDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      proof: nativeCommandProofSchema,
    })
    .strict()
    .refine(originalRequest)
    .refine(
      (v) => v.proof.unitName === `openbot-command-${v.preparationId.replaceAll("-", "")}.service`,
    ),
  work_command_control_challenge: z
    .object({
      ...signedPreparation,
      ...challenge,
      purpose: z.literal("work_command_control_challenge"),
      operation: z.enum(["lookup", "stop"]),
      requestId: uuid,
    })
    .strict()
    .refine(validWindow),
  work_command_control_request: z.discriminatedUnion("operation", [
    z
      .object({ ...controlRequest, operation: z.literal("lookup"), includeOutput: z.boolean() })
      .strict()
      .refine(validControl)
      .refine((v) => !v.includeOutput || v.dispatch !== null),
    z
      .object({
        ...controlRequest,
        operation: z.literal("stop"),
        reason: z.enum([
          "cancel",
          "revoked",
          "expired",
          "source_changed",
          "identity_changed",
          "owned_cleanup",
        ]),
      })
      .strict()
      .refine(validControl),
  ]),
  work_command_dispatch: z
    .object({ ...execution, purpose: z.literal("work_command_dispatch"), anchors: anchorsSchema })
    .strict()
    .refine(validTimes)
    .refine(
      (v) =>
        v.hardDeadlineMs === v.anchors.hardDeadlineMs &&
        v.iat === Math.floor(v.anchors.admittedAtMs / 1000) &&
        v.exp * 1000 <= v.hardDeadlineMs,
    ),
  work_command_consume: z
    .object({
      ...execution,
      purpose: z.literal("work_command_consume"),
      requestId: uuid,
      nonce,
      ticketDigest: digest,
    })
    .strict()
    .refine(validTimes),
  work_command_permit: z
    .object({
      ...execution,
      purpose: z.literal("work_command_permit"),
      requestId: uuid,
      nonce,
      requestDigest: digest,
      consumedAtMs: millis,
      launchDeadlineMs: millis,
    })
    .strict()
    .refine(validTimes)
    .refine(
      (v) =>
        v.launchDeadlineMs === Math.min(v.consumedAtMs + 5000, v.hardDeadlineMs) &&
        v.consumedAtMs < v.launchDeadlineMs &&
        v.iat === Math.floor(v.consumedAtMs / 1000) &&
        v.exp * 1000 <= v.launchDeadlineMs,
    ),
  work_command_receipt: z
    .object({
      ...execution,
      purpose: z.literal("work_command_receipt"),
      requestId: uuid,
      nonce,
      permitDigest: digest.nullable(),
      observation,
    })
    .strict()
    .refine(validTimes)
    .refine((v) => v.observation.startAttempts === 0 || v.permitDigest !== null),
} as const;
export type CommandPurpose = keyof typeof commandClaimSchemas;
export type CommandClaims<P extends CommandPurpose = CommandPurpose> = z.infer<
  (typeof commandClaimSchemas)[P]
>;
export const commandRoles = {
  work_command_prepare_challenge: "enforcement",
  work_command_prepare_authorize: "control",
  work_command_ready: "enforcement",
  work_command_control_challenge: "enforcement",
  work_command_control_request: "control",
  work_command_dispatch: "control",
  work_command_consume: "enforcement",
  work_command_permit: "control",
  work_command_receipt: "enforcement",
} as const;
export const executionPurpose = (purpose: CommandPurpose) =>
  [
    "work_command_dispatch",
    "work_command_consume",
    "work_command_permit",
    "work_command_receipt",
  ].includes(purpose);
export const commandTokenType = (purpose: CommandPurpose) =>
  `${purpose.replaceAll("_", "-")}-v2+${executionPurpose(purpose) ? "jwt" : "jws"}`;
export async function parseCommandClaims<P extends CommandPurpose>(
  purpose: P,
  value: unknown,
): Promise<CommandClaims<P>> {
  try {
    commandValue(value, 8192);
    return (await commandClaimSchemas[purpose].parseAsync(value)) as CommandClaims<P>;
  } catch {
    throw invalidCommand();
  }
}
export function validateCommandTime(value: CommandClaims, nowMs: number) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 1 || nowMs > 4102444800000) throw invalidCommand();
  if (!("nbf" in value)) return;
  if (
    !(value.nbf * 1000 <= nowMs && nowMs < value.exp * 1000) ||
    value.iat * 1000 > nowMs ||
    (value.purpose !== "work_command_receipt" && nowMs >= value.hardDeadlineMs)
  )
    throw invalidCommand();
  if (value.purpose === "work_command_dispatch" && nowMs < value.anchors.admittedAtMs)
    throw invalidCommand();
  if (
    value.purpose === "work_command_permit" &&
    !(value.consumedAtMs <= nowMs && nowMs < value.launchDeadlineMs)
  )
    throw invalidCommand();
}
export function commandPreparationBinding(value: CommandClaims | CommandBindingV2) {
  return preparation.parse(
    Object.fromEntries(Object.keys(preparation.shape).map((k) => [k, Reflect.get(value, k)])),
  );
}
export function commandExecutionBinding(value: CommandBindingV2) {
  return commandBindingV2Schema.parse(
    Object.fromEntries(
      Object.keys(commandBindingV2Schema.shape).map((k) => [k, Reflect.get(value, k)]),
    ),
  );
}
export async function commandFingerprint(value: unknown) {
  commandValue(value);
  const operation = await commandDispatchOperationSchema.parseAsync(value);
  return createHash("sha256")
    .update("openbot:work-command:operation:v1\0")
    .update(commandValue(operation))
    .digest("hex");
}
