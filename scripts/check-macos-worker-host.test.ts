import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  expectedMacOSLaunchAgentPlist,
  macOSLaunchAgentURL,
  validateMacOSLaunchAgent,
} from "./check-macos-worker-host.ts";

test("accepts the fixed app-bundled LaunchAgent contract", async () => {
  await assert.doesNotReject(validateMacOSLaunchAgent(macOSLaunchAgentURL));

  const keys = Array.from(
    expectedMacOSLaunchAgentPlist.matchAll(/<key>([^<]+)<\/key>/g),
    (item) => item[1],
  );
  assert.deepEqual(keys, [
    "Label",
    "BundleProgram",
    "ProgramArguments",
    "KeepAlive",
    "SuccessfulExit",
    "ThrottleInterval",
    "ProcessType",
    "ExitTimeOut",
    "Umask",
  ]);
  assert.doesNotMatch(
    expectedMacOSLaunchAgentPlist,
    /EnvironmentVariables|StandardInPath|UserName|GroupName|RootDirectory|EnablePressuredExit|AbandonProcessGroup|credential|token|secret/i,
  );
});

test("rejects lifecycle or executable drift", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "openbot-macos-launchd-drift-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const plist = join(root, "agent.plist");

  for (const changed of [
    expectedMacOSLaunchAgentPlist.replace("<integer>30</integer>", "<integer>1</integer>"),
    expectedMacOSLaunchAgentPlist.replace(
      "Contents/MacOS/OpenBotWorkerHostControl",
      "/usr/local/bin/node",
    ),
    `${expectedMacOSLaunchAgentPlist}<key>EnvironmentVariables</key>`,
  ]) {
    await writeFile(plist, changed);
    await assert.rejects(validateMacOSLaunchAgent(plist), /contract is invalid/);
  }
});

test("rejects symlinks and oversized property lists", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "openbot-macos-launchd-shape-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "target.plist");
  const link = join(root, "link.plist");
  await writeFile(target, expectedMacOSLaunchAgentPlist);
  await symlink(target, link);
  await assert.rejects(validateMacOSLaunchAgent(link), /contract is invalid/);

  await writeFile(target, "x".repeat(4 * 1024 + 1));
  await assert.rejects(validateMacOSLaunchAgent(target), /contract is invalid/);
});

test("returns only bounded generic diagnostics", async () => {
  await assert.rejects(validateMacOSLaunchAgent(new URL("file:///path/that/does/not/exist")), {
    message: "The macOS LaunchAgent contract is unavailable.",
  });
});
