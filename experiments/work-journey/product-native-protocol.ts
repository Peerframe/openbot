/** Validates only public stage/lifetime evidence; Work success is asserted by the product probe. */
import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import { z } from "zod";
import { commandRouteSchema } from "../../apps/server/dist/work-command-contract.js";
import { commandPreparationBindingSchema } from "../../packages/protocol/dist/index.js";

export const nativeControllerConfiguration = z
  .object({
    version: z.literal(2),
    program: z.literal("/opt/obp5/code/product-host.cjs"),
    node: z.literal("/opt/obp5/code/node"),
  })
  .strict();
export type Route = z.infer<typeof commandRouteSchema>;
export type PreparationBinding = z.infer<typeof commandPreparationBindingSchema>;
const stageSchema = z
  .object({
    version: z.literal(1),
    stageReady: z.literal(true),
    route: commandRouteSchema,
    enforcementIssuer: z.literal("product-enforcer"),
    enforcementKeyId: z.string(),
    enforcementPublicPem: z.string().max(4096),
    serverUrl: z.string(),
  })
  .strict();
export function stagedPin(value: unknown, route: Route, port: number): string {
  const result = stageSchema.parse(value);
  assert.deepEqual(result.route, route, "stage_identity_changed");
  assert.equal(result.enforcementKeyId, route.enforcementKeyId, "stage_identity_changed");
  assert(Number.isInteger(port) && port >= 1024 && port <= 65535, "invalid_explicit_loopback_port");
  assert.equal(result.serverUrl, `ws://127.0.0.1:${port}/ws/nodes`, "stage_identity_changed");
  assert(
    result.enforcementPublicPem.startsWith("-----BEGIN PUBLIC KEY-----\n"),
    "invalid_enforcer_public_key",
  );
  const key = createPublicKey(result.enforcementPublicPem);
  assert.equal(key.asymmetricKeyType, "ed25519", "invalid_enforcer_public_key");
  assert.equal(
    key.export({ type: "spki", format: "pem" }),
    result.enforcementPublicPem,
    "noncanonical_enforcer_public_key",
  );
  return result.enforcementPublicPem;
}
const baselineSchema = z
  .object({
    containerCount: z.number().int().nonnegative(),
    identitiesAndStateUnchanged: z.literal(true),
    ipv4Ipv6SemanticsUnchanged: z.literal(true),
  })
  .strict();
const finishedSchema = z
  .object({
    version: z.literal(1),
    event: z.literal("remote_finished"),
    binding: commandPreparationBindingSchema,
    productAuthorityLocal: z.literal(true),
    workSuccessNotInferred: z.literal(true),
    runnerSucceeded: z.literal(true),
    runnerWithin150s: z.literal(true),
    enforcerKeyRemoved: z.literal(true),
    socketAbsent: z.literal(true),
    actionCount: z.literal(1),
    before: baselineSchema,
    after: baselineSchema,
    native: z
      .object({
        unit: z.string(),
        invocationId: z.string().regex(/^[a-f0-9]{32}$/),
        result: z.string().min(1),
        originalCgroupEmpty: z.literal(true),
        stopObservedWithin5SecondMargin: z.literal(true),
        unitReleased: z.literal(true),
        reservationRetained: z.literal(true),
        privateRuntimeAbsent: z.literal(true),
        backingAbsent: z.literal(true),
      })
      .passthrough(),
  })
  .passthrough();
export function finishedEvidence(value: unknown, binding: PreparationBinding) {
  const result = finishedSchema.parse(value);
  assert.deepEqual(
    result.binding,
    commandPreparationBindingSchema.parse(binding),
    "remote_binding_changed",
  );
  assert.deepEqual(result.before, result.after, "native_host_state_changed");
  assert.equal(
    result.native.unit,
    `openbot-command-${binding.preparationId.replaceAll("-", "")}.service`,
    "remote_native_identity_changed",
  );
  for (const key of [
    "failure",
    "cleanupFailure",
    "productionFailure",
    "nativeReservationIncomplete",
  ])
    assert(!Object.hasOwn(result, key), "remote_fixture_failed");
  return result;
}
export function readyEvidence(value: unknown) {
  assert.deepEqual(
    value,
    {
      version: 1,
      event: "remote_ready",
      socketReady: true,
      nodeSpawned: true,
      nodeUid: 62425,
      serverAuthenticated: false,
    },
    "native_ready_changed",
  );
}
