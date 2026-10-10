/** Migrated public pin, original SQL binding and native lifetime assertions; no privileged calls. */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { strictCommandJson } from "../../apps/server/dist/work-command-values.js";
import {
  finishedEvidence,
  nativeControllerConfiguration,
  readyEvidence,
  stagedPin,
} from "./product-native-protocol.ts";
const route = {
  nodeId: "fixture-node",
  providerId: "linux-command",
  enforcementKeyId: "fixture-enforcer",
  ledgerId: "11111111-1111-1111-1111-111111111111",
};
const binding = {
  taskId: "task-original",
  runId: "run-original",
  actionId: "action-original",
  preparationId: "22222222-2222-2222-2222-222222222222",
  connectionId: "33333333-3333-3333-3333-333333333333",
  originalEpoch: 1,
  authorityGeneration: 1,
  profileDigest: "a".repeat(64),
  intentDigest: "b".repeat(64),
  operationFingerprint: "c".repeat(64),
  ...route,
};
const keys = generateKeyPairSync("ed25519"),
  pem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const stage = (key = pem) => ({
  version: 1,
  stageReady: true,
  route: { ...route },
  enforcementIssuer: "product-enforcer",
  enforcementKeyId: route.enforcementKeyId,
  enforcementPublicPem: key,
  serverUrl: "ws://127.0.0.1:18765/ws/nodes",
});
const finished = () => ({
  version: 1,
  event: "remote_finished",
  productAuthorityLocal: true,
  workSuccessNotInferred: true,
  runnerSucceeded: true,
  runnerWithin150s: true,
  enforcerKeyRemoved: true,
  socketAbsent: true,
  actionCount: 1,
  binding: { ...binding },
  before: {
    containerCount: 10,
    identitiesAndStateUnchanged: true,
    ipv4Ipv6SemanticsUnchanged: true,
  },
  after: {
    containerCount: 10,
    identitiesAndStateUnchanged: true,
    ipv4Ipv6SemanticsUnchanged: true,
  },
  native: {
    unit: `openbot-command-${binding.preparationId.replaceAll("-", "")}.service`,
    invocationId: "a".repeat(32),
    result: "timeout",
    originalCgroupEmpty: true,
    stopObservedWithin5SecondMargin: true,
    unitReleased: true,
    reservationRetained: true,
    privateRuntimeAbsent: true,
    backingAbsent: true,
  },
});
test("canonical Ed25519 public pin only; no private key, alternate algorithm, noncanonical PEM or duplicate JSON", () => {
  assert.equal(stagedPin(stage(), route, 18765), pem);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
  for (const key of [
    keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    rsa,
    pem + "\n",
    "invalid",
  ])
    assert.throws(() => stagedPin(stage(key), route, 18765));
  const raw = JSON.stringify(stage()).slice(0, -1) + ',"version":1}';
  assert.throws(() => strictCommandJson(Buffer.from(raw), 32768));
});
for (const [field, value] of Object.entries({
  version: true,
  stageReady: 1,
  enforcementIssuer: "other",
  enforcementKeyId: "other",
  serverUrl: "ws://0.0.0.0:18765/ws/nodes",
  route: { ...route, nodeId: "other" },
  extra: true,
}))
  test("stage identity refuses " + field, () => {
    assert.throws(() => stagedPin({ ...stage(), [field]: value }, route, 18765));
  });
for (const port of [true, 0, 22, 65536, "18765", 1234.5])
  test("nonprivileged exact port: " + String(port), () => {
    assert.throws(() => stagedPin(stage(), route, port as number));
  });
for (const [field, original] of Object.entries(binding))
  test("original SQL binding field: " + field, () => {
    const value = finished();
    Reflect.set(
      value.binding,
      field,
      typeof original === "number"
        ? original + 1
        : ["preparationId", "connectionId", "ledgerId"].includes(field)
          ? "99999999-9999-9999-9999-999999999999"
          : ["profileDigest", "intentDigest", "operationFingerprint"].includes(field)
            ? "d".repeat(64)
            : "different",
    );
    assert.throws(() => finishedEvidence(value, binding));
  });
test("runner lifetime success never substitutes for Work success", () => {
  assert.equal(finishedEvidence(finished(), binding).workSuccessNotInferred, true);
  const value = finished();
  value.before.containerCount = value.after.containerCount = 0;
  assert.equal(finishedEvidence(value, binding).before.containerCount, 0);
});
for (const field of [
  "productAuthorityLocal",
  "workSuccessNotInferred",
  "runnerSucceeded",
  "runnerWithin150s",
  "enforcerKeyRemoved",
  "socketAbsent",
  "actionCount",
])
  test("required runner evidence: " + field, () => {
    for (const replacement of [false, undefined, "true"]) {
      const value = finished();
      Reflect.set(value, field, replacement);
      assert.throws(() => finishedEvidence(value, binding));
    }
  });
for (const field of [
  "originalCgroupEmpty",
  "stopObservedWithin5SecondMargin",
  "unitReleased",
  "reservationRetained",
  "privateRuntimeAbsent",
  "backingAbsent",
])
  test("required original native cleanup: " + field, () => {
    for (const replacement of [false, undefined, "true"]) {
      const value = finished();
      Reflect.set(value.native, field, replacement);
      assert.throws(() => finishedEvidence(value, binding));
    }
  });
for (const field of [
  "failure",
  "cleanupFailure",
  "productionFailure",
  "nativeReservationIncomplete",
])
  test("explicit failure presence refuses: " + field, () => {
    for (const v of ["failed", null, false])
      assert.throws(() => finishedEvidence({ ...finished(), [field]: v }, binding));
  });
for (const name of ["before", "after"] as const)
  for (const field of [
    "identitiesAndStateUnchanged",
    "ipv4Ipv6SemanticsUnchanged",
    "containerCount",
  ])
    test("fixed host baseline " + name + "." + field, () => {
      const value = finished();
      Reflect.set(value[name], field, false);
      assert.throws(() => finishedEvidence(value, binding));
    });
for (const [field, value] of Object.entries({ unit: "other", invocationId: "other", result: "" }))
  test("native identity: " + field, () => {
    const input = finished();
    Reflect.set(input.native, field, value);
    assert.throws(() => finishedEvidence(input, binding));
  });
test("running container identity counts cannot drift", () => {
  const value = finished();
  value.after.containerCount++;
  assert.throws(() => finishedEvidence(value, binding));
});
test("fixed TS CI program is the only accepted configuration", () => {
  const value = {
    version: 2,
    program: "/opt/obp5/code/product-host.cjs",
    node: "/opt/obp5/code/node",
  };
  assert.deepEqual(nativeControllerConfiguration.parse(value), value);
  for (const [key, v] of Object.entries({
    version: 1,
    program: "/tmp/host.cjs",
    node: "/usr/bin/node",
    extra: true,
  }))
    assert.throws(() => nativeControllerConfiguration.parse({ ...value, [key]: v }));
});
test("readiness requires the actual low UID and makes no Server authentication claim", () => {
  const value = {
    version: 1,
    event: "remote_ready",
    socketReady: true,
    nodeSpawned: true,
    nodeUid: 62425,
    serverAuthenticated: false,
  };
  readyEvidence(value);
  for (const key of Object.keys(value)) {
    const changed = { ...value };
    Reflect.set(changed, key, key === "serverAuthenticated" ? true : null);
    assert.throws(() => readyEvidence(changed));
  }
});
