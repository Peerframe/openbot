import assert from "node:assert/strict";
import test from "node:test";
import {
  artifactContractFixtureSchema,
  browserContractFixtureSchema,
  controlContractFixtureSchema,
  employeeContractFixtureSchema,
  lifecycleContractFixtureSchema,
  nodeContractFixtureSchema,
  pluginContractFixtureSchema,
  productContractFixtureSchema,
  publisherContractFixtureSchema,
  workContractFixtureSchema,
} from "./target.ts";
import { contractTargetSchema } from "./work.ts";

function syntheticUserinfoUrl(base: string, password: string): string {
  const url = new URL(base);
  url.username = "user";
  url.password = password;
  return url.href.endsWith("/") ? url.href.slice(0, -1) : url.href;
}

const target = {
  baseUrl: "http://127.0.0.1:3001",
  origin: "https://openbot.invalid",
  cookie: "openbot_session=synthetic",
  botId: "abcdefab-1234-4234-8234-000000000001",
};
const work = {
  taskId: target.botId,
  intentDigest: "a".repeat(64),
  actions: Object.fromEntries(
    ["approve", "reject", "expired", "stale", "unknown"].map((kind) => [kind, target.botId]),
  ),
};
test("Work published-state fixture accepts scoped IDs without execution or database authority", () => {
  assert.equal(workContractFixtureSchema.safeParse({ ...target, work }).success, true);
  assert.equal(workContractFixtureSchema.safeParse(target).success, true);
  for (const value of [
    { ...work, taskId: "../private" },
    { ...work, intentDigest: "invalid" },
    { ...work, actions: {} },
    { ...work, databaseUrl: "postgres://user-data" },
    { ...work, execute: true },
  ])
    assert.equal(workContractFixtureSchema.safeParse({ ...target, work: value }).success, false);
});
const nativeArtifacts = {
  taskId: target.botId,
  valid: ["text/markdown", "application/octet-stream"].map((mediaType) => ({
    id: target.botId,
    name: "Fixture",
    mediaType,
    base64: "",
  })),
  integrity: target.botId,
  sizeMismatch: target.botId,
  missing: target.botId,
  symlink: target.botId,
  oversized: target.botId,
};
test("publisher target accepts public trust only and requires explicit configured composition", () => {
  const publisher = { keyid: "ed25519:" + "a".repeat(64), publicKey: "synthetic public key" };
  assert.equal(publisherContractFixtureSchema.safeParse({ ...target, publisher }).success, true);
  for (const value of [
    undefined,
    { ...publisher, keyid: "wrong" },
    { ...publisher, publicKey: "" },
    { ...publisher, keyring: "/user/private" },
    { ...publisher, passphrase: "private" },
    { ...publisher, privateKey: "private" },
    { ...publisher, publicKey: "a".repeat(16385) },
  ])
    assert.equal(
      publisherContractFixtureSchema.safeParse({ ...target, publisher: value }).success,
      false,
    );
});
test("refuses credential-bearing, ambiguous and non-HTTP targets before requests", () => {
  for (const value of [
    syntheticUserinfoUrl("https://example.com", "password"),
    "https://example.com/path",
    "https://example.com/",
    "https://example.com?secret=yes",
    "file:///tmp/fixture",
    "null",
  ]) {
    assert.equal(contractTargetSchema.safeParse({ ...target, baseUrl: value }).success, false);
    assert.equal(contractTargetSchema.safeParse({ ...target, origin: value }).success, false);
  }
});
test("lifecycle targets require bounded published-state IDs without database or execution authority", () => {
  const lifecycle = {
    channelId: target.botId,
    unreadMessageId: target.botId,
    approvals: { approve: target.botId, reject: target.botId, expired: target.botId },
  };
  assert.equal(lifecycleContractFixtureSchema.safeParse({ ...target, lifecycle }).success, true);
  for (const value of [
    undefined,
    { ...lifecycle, channelId: "../private" },
    { ...lifecycle, databaseUrl: "postgres://user-data" },
    { ...lifecycle, approvals: { approve: target.botId } },
  ]) {
    assert.equal(
      lifecycleContractFixtureSchema.safeParse({ ...target, lifecycle: value }).success,
      false,
    );
  }
  assert.equal(productContractFixtureSchema.safeParse({ ...target, lifecycle }).success, false);
});
test("Employee published-state fixture admits only scoped IDs and requires all sources", () => {
  const employee = {
    botId: target.botId,
    sourceRunId: target.botId,
    sourceTaskId: target.botId,
    sourceWorkRunId: target.botId,
    proposals: {
      accept: target.botId,
      reject: target.botId,
      native: target.botId,
      incomplete: target.botId,
    },
  };
  assert.equal(employeeContractFixtureSchema.safeParse({ ...target, employee }).success, true);
  for (const value of [
    undefined,
    { ...employee, botId: "../private" },
    { ...employee, databaseUrl: "postgres://user-data" },
    { ...employee, proposals: {} },
  ])
    assert.equal(
      employeeContractFixtureSchema.safeParse({ ...target, employee: value }).success,
      false,
    );
  assert.equal(
    productContractFixtureSchema.safeParse({
      ...target,
      employee,
      password: "synthetic-owner-password",
    }).success,
    false,
  );
  assert.equal(
    productContractFixtureSchema.safeParse({
      ...target,
      employee,
      password: "synthetic-owner-password",
      work,
      lifecycle: {
        channelId: target.botId,
        unreadMessageId: target.botId,
        approvals: { approve: target.botId, reject: target.botId, expired: target.botId },
      },
      nodes: { expiredNodeId: "fixture-expired", expiredToken: "obenr_" + "a".repeat(43) },
      browser: { frameBase64: "a".repeat(64) },
      plugins: {
        endpoint: "http://127.0.0.1:3002/mcp",
        token: "a".repeat(64),
        controllerToken: "b".repeat(64),
      },
      artifacts: {
        native: nativeArtifacts,
        valid: ["text/markdown", "image/png"].map((mediaType) => ({
          id: target.botId,
          name: "Fixture",
          mediaType,
          base64: "Zml4dHVyZQ==",
        })),
        integrity: target.botId,
        refusedKey: target.botId,
        symlink: target.botId,
        oversized: target.botId,
      },
    }).success,
    true,
  );
});
test("Node fixture requires only an expired bootstrap token and scoped identity", () => {
  const nodes = { expiredNodeId: "fixture-expired", expiredToken: "obenr_" + "a".repeat(43) };
  assert.equal(nodeContractFixtureSchema.safeParse({ ...target, nodes }).success, true);
  for (const value of [
    undefined,
    { ...nodes, expiredNodeId: "../private" },
    { ...nodes, expiredToken: "obn_" + "a".repeat(43) },
    { ...nodes, credential: "private" },
  ])
    assert.equal(nodeContractFixtureSchema.safeParse({ ...target, nodes: value }).success, false);
});
test("artifact fixture admits bounded published bytes and scoped rejection records only", () => {
  const artifacts = {
    valid: ["text/markdown", "image/png"].map((mediaType) => ({
      id: target.botId,
      name: "Fixture",
      mediaType,
      base64: "Zml4dHVyZQ==",
    })),
    integrity: target.botId,
    refusedKey: target.botId,
    symlink: target.botId,
    oversized: target.botId,
  };
  assert.equal(artifactContractFixtureSchema.safeParse({ ...target, artifacts }).success, true);
  assert.equal(productContractFixtureSchema.shape.artifacts.safeParse(artifacts).success, false);
  assert.equal(
    artifactContractFixtureSchema.safeParse({
      ...target,
      artifacts: { ...artifacts, native: nativeArtifacts },
    }).success,
    true,
  );
  for (const native of [
    { ...nativeArtifacts, taskId: "../private" },
    { ...nativeArtifacts, privateRoot: "/user/data" },
    { ...nativeArtifacts, symlink: "../private" },
    {
      ...nativeArtifacts,
      valid: nativeArtifacts.valid.map((file) => ({ ...file, base64: "bad?" })),
    },
    {
      ...nativeArtifacts,
      valid: nativeArtifacts.valid.map((file) => ({ ...file, base64: "a".repeat(1025) })),
    },
  ])
    assert.equal(
      artifactContractFixtureSchema.safeParse({ ...target, artifacts: { ...artifacts, native } })
        .success,
      false,
    );
  for (const value of [
    undefined,
    { ...artifacts, valid: [] },
    { ...artifacts, symlink: "../private" },
    { ...artifacts, objectRoot: "/user/data" },
    { ...artifacts, valid: artifacts.valid.map((file) => ({ ...file, base64: "a".repeat(1025) })) },
  ])
    assert.equal(
      artifactContractFixtureSchema.safeParse({ ...target, artifacts: value }).success,
      false,
    );
});
test("refuses header injection and undeclared fixture fields", () => {
  assert.equal(
    contractTargetSchema.safeParse({ ...target, cookie: "session=value\r\nX-Secret: x" }).success,
    false,
  );
  assert.equal(
    contractTargetSchema.safeParse({ ...target, databaseUrl: "postgres://user-data" }).success,
    false,
  );
  assert.equal(contractTargetSchema.safeParse(target).success, true);
});
test("Control fixture requires a bounded synthetic password before any request", () => {
  for (const password of [undefined, "short", "\ud800".repeat(15), "x".repeat(1025)]) {
    assert.equal(controlContractFixtureSchema.safeParse({ ...target, password }).success, false);
  }
  assert.equal(
    controlContractFixtureSchema.safeParse({ ...target, password: "synthetic-owner-password" })
      .success,
    true,
  );
});

test("MCP controller fixture accepts only the owned loopback origin and bounded separate credentials", () => {
  const plugins = {
    endpoint: "http://127.0.0.1:3002/mcp",
    token: "a".repeat(64),
    controllerToken: "b".repeat(64),
  };
  assert.equal(pluginContractFixtureSchema.safeParse({ ...target, plugins }).success, true);
  for (const changes of [
    { endpoint: "https://remote.invalid/mcp" },
    { endpoint: "http://127.0.0.1:3002/mcp?next=remote" },
    { endpoint: syntheticUserinfoUrl("http://127.0.0.1:3002/mcp", "secret") },
    { controllerToken: "a\r\n" },
    { token: "x".repeat(64) },
    { controllerToken: "a".repeat(64) },
    { extra: true },
  ])
    assert.equal(
      pluginContractFixtureSchema.safeParse({ ...target, plugins: { ...plugins, ...changes } })
        .success,
      false,
    );
});

test("browser fixture admits only bounded authored bytes and no endpoint/executor authority", () => {
  const browser = { frameBase64: "a".repeat(64) };
  assert.equal(browserContractFixtureSchema.safeParse({ ...target, browser }).success, true);
  for (const changes of [
    { frameBase64: "a".repeat(1025) },
    { frameBase64: "invalid?" },
    { endpoint: "http://private.invalid" },
  ])
    assert.equal(
      browserContractFixtureSchema.safeParse({ ...target, browser: { ...browser, ...changes } })
        .success,
      false,
    );
});
