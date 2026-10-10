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

test("native stage diagnostics accept only complete fixed lines and never leak raw log values", async () => {
  const { nativeBrowserStage, nativeBrowserFailure } = await import("./native-browser-protocol.ts");
  assert.equal(
    nativeBrowserStage(
      "private cookie\nnative-browser-stage:packet\nnative-browser-stage:images\nraw password",
    ),
    "images",
  );
  for (const raw of [
    "native-browser-stage:secret-value",
    "prefix native-browser-stage:unit",
    "native-browser-stage:unit\rcookie",
    "x".repeat(2 * 1024 * 1024 + 1),
  ])
    assert.equal(nativeBrowserStage(raw), undefined);
  assert.equal(
    nativeBrowserFailure("readiness", { nativeStage: "images", log: "private" })
      .nativeBrowserFailure.nativeStage,
    "images",
  );
  assert(
    !JSON.stringify(
      nativeBrowserFailure("readiness", { nativeStage: "private", log: "private" }),
    ).includes("private"),
  );
});

test("startup diagnostics retain only fixed checks, error codes and bounded bundle lines", async () => {
  const { nativeBrowserStartupError, nativeBrowserFailure } = await import(
    "./native-browser-protocol.ts"
  );
  const error = Object.assign(new Error("private payload"), {
    code: "ERR_ASSERTION",
    stack: "Error: private\n    at launch (/opt/obp4/browser-launcher.cjs:211:7)",
  });
  const direct = nativeBrowserFailure("readiness", {
    launcherCheck: "program-pin",
    ...nativeBrowserStartupError(error),
  });
  assert.equal(direct.nativeBrowserFailure.launcherCheck, "program-pin");
  assert.equal(direct.nativeBrowserFailure.errorCode, "assertion");
  assert.equal(direct.nativeBrowserFailure.launcherLine, 211);
  assert.deepEqual(nativeBrowserFailure("readiness", direct), direct);
  assert(!JSON.stringify(direct).includes("private"));
  for (const launcherLine of [-1, 0, 1.5, 1000001, "private"])
    assert.equal(
      nativeBrowserFailure("readiness", { launcherLine }).nativeBrowserFailure.launcherLine,
      undefined,
    );
  const refused = nativeBrowserFailure("readiness", {
    launcherCheck: "private",
    ...nativeBrowserStartupError(new Error("private")),
  });
  assert.equal(refused.nativeBrowserFailure.errorCode, "unknown");
  assert.equal(
    nativeBrowserFailure("readiness", { errorCode: "private" }).nativeBrowserFailure.errorCode,
    undefined,
  );
  assert(!JSON.stringify(refused).includes("private"));
});
