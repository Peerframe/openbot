import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { CompactSign, importPKCS8 } from "jose";
import { expect, it } from "vitest";
import { CommandPrepareClock } from "./work-command-clock.js";
import {
  type CommandClaims,
  commandTokenType,
  parseCommandClaims,
} from "./work-command-contract.js";
import { CommandSigner, CommandVerifier } from "./work-command-crypto.js";
import { commandValue } from "./work-command-values.js";

const now = 1800000000000,
  nonce = randomBytes(32).toString("base64url");
const keys = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
};
const binding = () => ({
  taskId: "task",
  runId: "run",
  actionId: "action",
  preparationId: randomUUID(),
  connectionId: randomUUID(),
  originalEpoch: 1,
  authorityGeneration: 1,
  profileDigest: "a".repeat(64),
  intentDigest: "b".repeat(64),
  operationFingerprint: "c".repeat(64),
  nodeId: "node",
  providerId: "linux-command",
  enforcementKeyId: "enforcement-key",
  ledgerId: randomUUID(),
  version: 2 as const,
  dispatchId: randomUUID(),
  hardDeadlineMs: now + 55000,
  readinessDigest: "d".repeat(64),
});
const dispatch = (original = binding()): CommandClaims<"work_command_dispatch"> => ({
  ...original,
  purpose: "work_command_dispatch",
  iss: "control",
  aud: "enforcer",
  jti: randomUUID(),
  iat: now / 1000,
  nbf: now / 1000,
  exp: now / 1000 + 30,
  anchors: {
    admittedAtMs: now,
    rootDeadlineMs: now + 300000,
    nativeDeadlineMs: original.hardDeadlineMs,
    wallSeconds: 60,
    hardDeadlineMs: original.hardDeadlineMs,
    deadlineProfileVersion: 2,
  },
});

it("verifies only the pinned role, original binding and exact execution time", async () => {
  const control = keys(),
    original = binding(),
    claims = dispatch(original);
  const signer = await CommandSigner.create({
    issuer: "control",
    kid: "control-key",
    role: "control",
    privatePem: control.privatePem,
  });
  const verifier = await CommandVerifier.create([
    { issuer: "control", kid: "control-key", role: "control", publicPem: control.publicPem },
  ]);
  const token = await signer.sign(claims.purpose, claims, now),
    options = {
      purpose: claims.purpose,
      issuer: "control",
      audience: "enforcer",
      binding: original,
      nowMs: now,
    };
  expect(await verifier.verify(token, options)).toEqual(claims);
  for (const nowMs of [now - 1, now + 30000, now + 55000])
    await expect(verifier.verify(token, { ...options, nowMs })).rejects.toThrow(
      "invalid_command_token",
    );
  for (const key of ["preparationId", "connectionId", "dispatchId", "ledgerId"] as const)
    await expect(
      verifier.verify(token, { ...options, binding: { ...original, [key]: randomUUID() } }),
    ).rejects.toThrow();
  await expect(
    verifier.verify(token, { ...options, request: { requestId: randomUUID(), nonce } }),
  ).rejects.toThrow();
  await expect(verifier.verify(token, { ...options, audience: "other" })).rejects.toThrow();
  await expect(
    CommandVerifier.create([
      { issuer: "control", kid: "control-key", role: "control", publicPem: control.publicPem },
      {
        issuer: "enforcer",
        kid: "enforcement-key",
        role: "enforcement",
        publicPem: control.publicPem,
      },
    ]),
  ).rejects.toThrow();
  await expect(
    CommandVerifier.create([
      { issuer: "control", kid: "control-key", role: "control", publicPem: control.privatePem },
    ]),
  ).rejects.toThrow();
  const privateKey = await importPKCS8(control.privatePem, "Ed25519");
  for (const header of [
    { alg: "EdDSA", typ: commandTokenType(claims.purpose), kid: "control-key" },
    {
      alg: "Ed25519",
      typ: commandTokenType(claims.purpose),
      kid: "control-key",
      jku: "https://example.invalid/keys",
    },
  ]) {
    const altered = await new CompactSign(commandValue(claims, 8192))
      .setProtectedHeader(header)
      .sign(privateKey);
    await expect(verifier.verify(altered, options)).rejects.toThrow();
  }
  for (const raw of [
    JSON.stringify(claims).replace("{", '{"iss":"control",'),
    JSON.stringify(claims).replace('"originalEpoch":1', '"originalEpoch":1.0'),
    JSON.stringify({ ...claims, unknown: true }),
  ]) {
    const altered = await new CompactSign(Buffer.from(raw))
      .setProtectedHeader({
        alg: "Ed25519",
        typ: commandTokenType(claims.purpose),
        kid: "control-key",
      })
      .sign(privateKey);
    await expect(verifier.verify(altered, options)).rejects.toThrow("invalid_command_token");
  }
});

it("requires the one challenge for permit and allows only fresh historical receipt observation", async () => {
  const control = keys(),
    enforcer = keys(),
    original = binding(),
    requestId = randomUUID();
  const signer = await CommandSigner.create({
    issuer: "control",
    kid: "control-key",
    role: "control",
    privatePem: control.privatePem,
  });
  const observer = await CommandSigner.create({
    issuer: "enforcer",
    kid: "enforcement-key",
    role: "enforcement",
    privatePem: enforcer.privatePem,
  });
  const verifier = await CommandVerifier.create([
    { issuer: "control", kid: "control-key", role: "control", publicPem: control.publicPem },
    {
      issuer: "enforcer",
      kid: "enforcement-key",
      role: "enforcement",
      publicPem: enforcer.publicPem,
    },
  ]);
  const permit = {
    ...original,
    purpose: "work_command_permit" as const,
    iss: "control",
    aud: "enforcer",
    jti: randomUUID(),
    iat: now / 1000,
    nbf: now / 1000,
    exp: now / 1000 + 5,
    requestId,
    nonce,
    requestDigest: "e".repeat(64),
    consumedAtMs: now,
    launchDeadlineMs: now + 5000,
  };
  const token = await signer.sign(permit.purpose, permit, now),
    options = {
      purpose: permit.purpose,
      issuer: "control",
      audience: "enforcer",
      binding: original,
      nowMs: now,
      request: { requestId, nonce },
    };
  expect(await verifier.verify(token, options)).toEqual(permit);
  await expect(verifier.verify(token, { ...options, nowMs: now + 5000 })).rejects.toThrow();
  await expect(
    verifier.verify(token, {
      ...options,
      request: { requestId, nonce: randomBytes(32).toString("base64url") },
    }),
  ).rejects.toThrow();
  await expect(
    signer.sign(permit.purpose, { ...permit, launchDeadlineMs: now + 5001 }, now),
  ).rejects.toThrow();
  const receipt = {
    ...original,
    purpose: "work_command_receipt" as const,
    iss: "enforcer",
    aud: "control",
    jti: randomUUID(),
    iat: now / 1000 + 120,
    nbf: now / 1000 + 120,
    exp: now / 1000 + 150,
    requestId,
    nonce,
    permitDigest: "e".repeat(64),
    observation: {
      phase: "exited" as const,
      containerId: "f".repeat(64),
      startAttempts: 1,
      exitCode: 0,
      sequence: 2,
      runtimeShapeDigest: "d".repeat(64),
      outputs: [],
      truncated: false,
    },
  };
  const observed = await observer.sign(receipt.purpose, receipt, now + 120000);
  expect(
    await verifier.verify(observed, {
      purpose: receipt.purpose,
      issuer: "enforcer",
      audience: "control",
      binding: original,
      request: { requestId, nonce },
      nowMs: now + 120000,
    }),
  ).toEqual(receipt);
  await expect(signer.sign(receipt.purpose, receipt, now + 120000)).rejects.toThrow();
  await expect(
    parseCommandClaims(receipt.purpose, { ...receipt, permitDigest: null }),
  ).rejects.toThrow();
});

it("does not reconstruct preparation clocks or forgive a clock jump", () => {
  const policy = {
    prepareBudgetMs: 30000,
    challengeBudgetMs: 5000,
    runtimeMaxMs: 50000,
    stopAllowanceMs: 5000,
    clockRateErrorPpm: 1000,
    clockQuantizationMs: 1,
    policyDigest: "e".repeat(64),
  };
  let wall = now,
    mono = 100;
  const clock = new CommandPrepareClock(100, () => [wall, mono]);
  clock.begin("action", now);
  wall += 1000;
  mono += 1000;
  expect(clock.check("action", now + 1000, policy)).toBe(true);
  expect(new CommandPrepareClock(100, () => [wall, mono]).check("action", now + 1000, policy)).toBe(
    false,
  );
  expect(clock.check("action", now + 2000, policy)).toBe(false);
  wall += 2000;
  expect(clock.healthy()).toBe(false);
  wall -= 2000;
  expect(clock.healthy()).toBe(false);
  expect(() => clock.begin("other", wall)).toThrow("command_clock_changed");
});
