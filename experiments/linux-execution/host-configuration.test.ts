/** Strict operator configuration shape; path ownership is exercised by root native qualification. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { hostConfigurationSchema } from "./host-configuration.ts";
const config = () => ({
  state: "/opt/fixture/state",
  socket: "/run/fixture/command.sock",
  nodeUid: 62425,
  nodeGid: 62425,
  route: {
    nodeId: "node",
    providerId: "provider",
    enforcementKeyId: "enforcer",
    ledgerId: "00000000-0000-4000-8000-000000000001",
  },
  policy: {
    prepareBudgetMs: 30000,
    challengeBudgetMs: 5000,
    runtimeMaxMs: 50000,
    stopAllowanceMs: 5000,
    clockRateErrorPpm: 1000,
    clockQuantizationMs: 100,
    policyDigest: "d".repeat(64),
  },
  controlIssuer: "control",
  enforcementIssuer: "enforcer",
  native: {},
  privateKey: "/opt/fixture/secrets/private.pem",
  controlPins: [{ kid: "control-1", path: "/opt/fixture/pins/public.pem" }],
});
test("root configuration has an explicit route, timing, nonroot peer and pinned local keys", () =>
  assert.deepEqual(hostConfigurationSchema.parse(config()), config()));
for (const field of ["nodeUid", "nodeGid"] as const)
  for (const value of [0, -1, 1.1, true, "62425", 2147483648])
    test(`invalid ${field} ${value}`, () =>
      assert.throws(() => hostConfigurationSchema.parse({ ...config(), [field]: value })));
for (const field of ["state", "socket", "privateKey"] as const)
  for (const value of ["relative", "/a\0b", "/a\nb", ""])
    test("rejects unsafe host path " + field + JSON.stringify(value), () =>
      assert.throws(() => hostConfigurationSchema.parse({ ...config(), [field]: value })),
    );
test("missing, extra and unbounded key pins refuse", () => {
  assert.throws(() => hostConfigurationSchema.parse({ ...config(), extra: true }));
  for (const pins of [
    [],
    Array(9).fill(config().controlPins[0]),
    [{ kid: "control-1", path: "relative" }],
    [{ ...config().controlPins[0], secret: "extra" }],
  ])
    assert.throws(() => hostConfigurationSchema.parse({ ...config(), controlPins: pins }));
});
