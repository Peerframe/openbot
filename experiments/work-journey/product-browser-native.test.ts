/** The migrated browser controller cannot accept weaker native receipts or an arbitrary relay. */
import assert from "node:assert/strict";
import test from "node:test";
import { nativeBrowserAcceptance } from "./product-browser-native.ts";
import { remoteBrowserConfiguration } from "./product-browser-probe.ts";
const receipt = {
  accepted: true,
  actualRunsc: true,
  actualSquid: true,
  actualProductJourney: true,
  originalNativeExpiryVerified: true,
  productionUnchanged: true,
  ownedRuntimeRemoved: true,
  nativeDeadlineSeconds: 600,
};
const remote = {
  fixtureEnvironment: "disposable-github-linux",
  computerUrl: "http://127.0.0.1:34101",
  stateUrl: "http://127.0.0.1:34102",
  targetUrl: "https://example.com:18443",
  token: "synthetic-linux-composition-fixture-only",
};
test("accepts all original native lifetime, isolation, journey and cleanup facts", () => {
  assert.deepEqual(nativeBrowserAcceptance.parse(receipt), receipt);
});
for (const name of Object.keys(receipt))
  test(`refuses absent or changed native proof: ${name}`, () => {
    const omitted: Record<string, unknown> = { ...receipt };
    delete omitted[name];
    assert.throws(() => nativeBrowserAcceptance.parse(omitted));
    for (const value of [false, "true", 1, null, 599, 601, "600"])
      assert.throws(() => nativeBrowserAcceptance.parse({ ...receipt, [name]: value }));
  });
test("accepts the explicit fixed CI relay only", () => {
  assert.deepEqual(remoteBrowserConfiguration.parse(remote), remote);
});
for (const key of ["computerUrl", "stateUrl"])
  test(`refuses nonloopback or ambiguous ${key}`, () => {
    for (const value of [
      "https://127.0.0.1:34101",
      "http://localhost:34101",
      "http://127.0.0.1",
      "http://127.0.0.1:34101/path",
      "http://user@127.0.0.1:34101",
      "http://127.0.0.1:34101/?x",
      "http://127.0.0.1:34101/#x",
      "http://192.0.2.1:34101",
    ])
      assert.throws(() => remoteBrowserConfiguration.parse({ ...remote, [key]: value }));
  });
for (const key of ["fixtureEnvironment", "targetUrl", "token"])
  test(`refuses changed fixed ${key}`, () => {
    assert.throws(() => remoteBrowserConfiguration.parse({ ...remote, [key]: "changed" }));
  });
test("refuses an added SSH or executable selector", () => {
  for (const key of ["ssh", "program", "node", "keyFile"])
    assert.throws(() => remoteBrowserConfiguration.parse({ ...remote, [key]: "unexpected" }));
});

test("failure diagnostics discard private values and malformed native flags", async () => {
  const { nativeBrowserFailure } = await import("./product-browser-native.ts");
  const value = nativeBrowserFailure("expiry", {
    accepted: false,
    actualRunsc: "private credential",
    failedOriginalUnitClosed: true,
    productionUnchanged: true,
    ownedRuntimeRemoved: true,
    existingContainerCount: 0,
    nativeDeadlineSeconds: 600,
    failure: "private model payload",
  });
  assert(!JSON.stringify(value).includes("private"));
  assert.deepEqual(value.nativeBrowserFailure.nativeFlags, {
    accepted: false,
    failedOriginalUnitClosed: true,
    productionUnchanged: true,
    ownedRuntimeRemoved: true,
  });
  assert.equal(value.nativeBrowserFailure.nativeDeadlineSeconds, 600);
  assert.throws(() => nativeBrowserFailure("arbitrary private phase", {}));
});
