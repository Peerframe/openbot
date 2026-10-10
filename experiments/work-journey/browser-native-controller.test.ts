/** Actual child pipes qualify complete private capture, fixed invocation and failed-receipt retention. */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { nativeBrowserFailure, qualifyNativeBrowser } from "./product-browser-native.ts";
const remote = {
  fixtureEnvironment: "disposable-github-linux",
  computerUrl: "http://127.0.0.1:34101",
  stateUrl: "http://127.0.0.1:34102",
  targetUrl: "https://example.com:18443",
  token: "synthetic-linux-composition-fixture-only",
};
const native = {
  accepted: true,
  actualRunsc: true,
  actualSquid: true,
  actualProductJourney: true,
  originalNativeExpiryVerified: true,
  productionUnchanged: true,
  ownedRuntimeRemoved: true,
  nativeDeadlineSeconds: 600,
};
async function fixture(t: TestContext, overflow = false, success = false) {
  const parent = await mkdtemp(join(tmpdir(), "ob-browser-controller-")),
    directory = join(parent, "owned");
  t.after(() => rm(parent, { recursive: true, force: true }));
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  assert(platform);
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  t.after(() => Object.defineProperty(process, "platform", platform));
  const diagnostic = nativeBrowserFailure("expiry", {
    accepted: false,
    failedOriginalUnitClosed: true,
    productionUnchanged: true,
    ownedRuntimeRemoved: true,
  });
  const script = `process.stdout.write(JSON.stringify(${JSON.stringify(remote)})+'\\n');process.stdin.once('data',()=>{process.stderr.write(${overflow ? "'x'.repeat(96*1024+1)" : "'private first chunk'"});setTimeout(()=>{process.stderr.write(' private final chunk');process.stdout.write(JSON.stringify(${JSON.stringify(success ? native : diagnostic)})+'\\n');process.exitCode=${success ? 0 : 1};},20);});`;
  const realSpawn = childProcess.spawn;
  let calls = 0;
  const replacement = t.mock.method(childProcess, "spawn", (command: unknown, args: unknown) => {
    calls++;
    assert.equal(command, "/usr/bin/sudo");
    assert.deepEqual(args, [
      "-n",
      "/usr/bin/python3",
      "-B",
      "/opt/obp4/browser_launcher.py",
      "--root",
    ]);
    return realSpawn(process.execPath, ["-e", script], { stdio: "pipe" });
  });
  syncBuiltinESMExports();
  t.after(() => {
    replacement.mock.restore();
    syncBuiltinESMExports();
  });
  const messages: string[] = [];
  t.mock.method(console, "log", (value: unknown) => {
    messages.push(String(value));
  });
  const product = async () => {
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      join(directory, "RESULT.json"),
      JSON.stringify({
        accepted: true,
        isolatedLinuxBrowserProduct: true,
        ownedFixturesClosed: true,
      }),
      { mode: 0o600 },
    );
  };
  return {
    directory,
    diagnostic,
    messages,
    product,
    calls: () => calls,
    options: { directory, upstream: "/owned/upstream", browsers: "/owned/browsers" },
  };
}
test("retains failed native facts and every stderr chunk without printing private text", async (t) => {
  const f = await fixture(t);
  await assert.rejects(qualifyNativeBrowser(f.options, f.product));
  const value = JSON.parse(await readFile(join(f.directory, "RESULT.json"), "utf8"));
  assert.equal(value.accepted, false);
  assert.equal(value.nativeCleanupComplete, false);
  assert.deepEqual(value.nativeFailure, f.diagnostic.nativeBrowserFailure);
  assert.equal(
    await readFile(join(f.directory, "native.stderr-private"), "utf8"),
    "private first chunk private final chunk",
  );
  assert.equal(f.calls(), 1);
  assert(!f.messages.join("").includes("private"));
});
test("overflow cannot yield a successful product receipt even if original native flags claim success", async (t) => {
  const f = await fixture(t, true, true);
  await assert.rejects(qualifyNativeBrowser(f.options, f.product), /bound exceeded/);
  const value = JSON.parse(await readFile(join(f.directory, "RESULT.json"), "utf8"));
  assert.equal(value.accepted, false);
  assert.equal(value.nativeCleanupComplete, false);
  assert.equal(f.calls(), 1);
});
test("one original native result closes the complete TS journey", async (t) => {
  const f = await fixture(t, false, true);
  await qualifyNativeBrowser(f.options, f.product);
  const value = JSON.parse(await readFile(join(f.directory, "RESULT.json"), "utf8"));
  assert.equal(value.accepted, true);
  assert.equal(value.nativeCleanupComplete, true);
  assert.equal(value.remoteNativeCleanupPending, false);
  assert.deepEqual(value.nativeAcceptance, native);
  assert.equal(f.calls(), 1);
});
test("an existing output is rejected before launching the root fixture or writing it", async (t) => {
  const f = await fixture(t);
  await mkdir(f.directory);
  await writeFile(join(f.directory, "retained"), "retained");
  await assert.rejects(qualifyNativeBrowser(f.options, f.product), /fresh owned/);
  assert.equal(f.calls(), 0);
  assert.equal(await readFile(join(f.directory, "retained"), "utf8"), "retained");
});
