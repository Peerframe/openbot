/** Disposable root CI adapter qualification. Uses reviewed offline inputs, never a product endpoint. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  chownSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  commandFingerprint,
  type CommandOperation,
} from "../../apps/server/dist/work-command-contract.js";
import compatibility from "../../scripts/integration/fixtures/command-compatibility.json" with {
  type: "json",
};
import { LinuxNative, type NativeReservation } from "./linux-native.ts";
import { nativeClock } from "./kernel-facts.ts";
import {
  reviewedBinaryHashes,
  reviewedImage,
  reviewedImageTag,
  reviewedImageConfig,
  type NativeConfiguration,
} from "./native-config.ts";
import { cgroupMembers, NativeCommandFailure } from "./native-unit.ts";
import {
  directory,
  digest,
  exclusive,
  readRecord,
  readBytes,
  requireFact,
} from "./protected-io.ts";
import { EventLedger } from "./event-ledger.ts";
import type { NativeHost } from "./protected-host.ts";
const base = "/opt/obp5",
  packet = "/opt/obp4";
function copyTree(source: string, target: string) {
  requireFact(!existsSync(target), "fresh_packet_required");
  cpSync(source, target, { recursive: true, dereference: false, errorOnExist: true, force: false });
  const pending = [target];
  while (pending.length) {
    const path = pending.pop()!,
      st = lstatSync(path);
    requireFact(!st.isSymbolicLink(), "unsealed_native_module");
    chownSync(path, 0, 0);
    requireFact(lstatSync(path).uid === 0, "unsealed_native_module");
    chmodSync(path, st.isDirectory() ? 0o755 : 0o644);
    if (st.isDirectory()) for (const child of readdirSync(path)) pending.push(join(path, child));
  }
}
async function main() {
  requireFact(
    process.platform === "linux" &&
      process.arch === "x64" &&
      process.geteuid?.() === 0 &&
      process.env.GITHUB_ACTIONS === "true",
    "disposable_linux_ci_only",
  );
  const [flag, helper, flagModules, modules, ...extra] = process.argv.slice(2);
  requireFact(
    flag === "--helper" && helper && flagModules === "--koffi" && modules && extra.length === 0,
    "explicit_native_packet_required",
  );
  directory(packet);
  directory("/opt", 0, false);
  requireFact(!existsSync(base), "fresh_native_root_required");
  mkdirSync(base, { mode: 0o700 });
  for (const name of ["secrets", "state", "code", "code/node_modules"])
    mkdirSync(join(base, name), { mode: 0o700 });
  cpSync(realpathSync(process.execPath), join(base, "code/node"), {
    errorOnExist: true,
    force: false,
  });
  chownSync(join(base, "code/node"), 0, 0);
  chmodSync(join(base, "code/node"), 0o755);
  cpSync(helper, join(base, "code/native-helper.cjs"), { errorOnExist: true, force: false });
  // Root seals its fresh copy; the build input remains owned by the unprivileged CI runner.
  chownSync(join(base, "code/native-helper.cjs"), 0, 0);
  chmodSync(join(base, "code/native-helper.cjs"), 0o600);
  copyTree(modules, join(base, "code/node_modules/koffi"));
  mkdirSync(join(base, "code/node_modules/@koromix"), { mode: 0o755 });
  copyTree(
    join(dirname(modules), "@koromix/koffi-linux-x64"),
    join(base, "code/node_modules/@koromix/koffi-linux-x64"),
  );
  const archive = join(packet, "downloads/command-node-amd64.tar"),
    config: NativeConfiguration = {
      base,
      binaries: join(packet, "bin"),
      archive,
      archiveSha256: digest(archive),
      image: reviewedImage,
      imageTag: reviewedImageTag,
      helper: join(base, "code/native-helper.cjs"),
      helperSha256: digest(join(base, "code/native-helper.cjs")),
      node: join(base, "code/node"),
      nodeSha256: digest(join(base, "code/node")),
      binaryHashes: reviewedBinaryHashes,
      secretsDirectory: join(base, "secrets"),
    };
  // Reuse the existing packet's independently checked image manifest/config, never just a new hash.
  const plan = JSON.parse(
    new TextDecoder("utf8", { fatal: true }).decode(
      readBytes(join(packet, "PLAN.json"), 2 * 1024 * 1024),
    ),
  ) as {
    command: { archiveSha256: string; manifest: string; config: string };
  };
  requireFact(
    plan.command.archiveSha256 === config.archiveSha256 &&
      plan.command.manifest === reviewedImage.split("@")[1] &&
      plan.command.config === reviewedImageConfig,
    "reviewed_image_changed",
  );
  const native = await LinuxNative.open(config),
    instance = randomUUID();
  native.instancePath = join(base, "state/instance.json");
  exclusive(native.instancePath, { instanceId: instance });
  const operation = structuredClone(
    compatibility.fingerprints.positive[0]!.operation,
  ) as CommandOperation;
  operation.command.image = reviewedImage;
  operation.command.inputManifest = [];
  operation.command.inputDigest = "sha256:" + createHash("sha256").update("[]").digest("hex");
  operation.command.limits.outputMiB = 64;
  operation.command.argv = [
    "/usr/local/bin/node",
    "-e",
    "const fs = require('node:fs'); const fd = fs.openSync('/output/result.csv', 'wx'); fs.writeFileSync(fd, 'one,execution\\n'); fs.fsyncSync(fd); fs.closeSync(fd);",
  ];
  operation.command.output = { name: "result.csv", mediaType: "text/csv", maxBytes: 1024 };
  const binding = {
    taskId: operation.taskId,
    runId: operation.runId,
    actionId: operation.actionId,
    preparationId: randomUUID(),
    connectionId: randomUUID(),
    originalEpoch: operation.originalEpoch,
    authorityGeneration: operation.authorityGeneration,
    profileDigest: operation.profileDigest,
    intentDigest: operation.intentDigest,
    operationFingerprint: await commandFingerprint(operation),
    ...operation.route,
  };
  const { argv: _argv, ...staging } = operation.command;
  const authorization: Parameters<NativeHost["reserve"]>[1] = {
    ...binding,
    version: 2,
    purpose: "work_command_prepare_authorize",
    iss: "fixture-control",
    aud: "fixture-enforcer",
    jti: randomUUID(),
    requestId: binding.preparationId,
    nonce: "a".repeat(43),
    challengeDigest: "b".repeat(64),
    issuedAtMs: Date.now(),
    rootDeadlineMs: Date.now() + 300000,
    staging,
    timing: {
      prepareBudgetMs: 30000,
      challengeBudgetMs: 5000,
      runtimeMaxMs: 50000,
      stopAllowanceMs: 5000,
      clockRateErrorPpm: 1000,
      clockQuantizationMs: 100,
      policyDigest: "e".repeat(64),
    },
  };
  let record: NativeReservation | undefined,
    failure: unknown,
    stage = "reserve";
  const checks: Record<string, boolean> = {};
  try {
    record = await native.reserve(binding, authorization, instance);
    stage = "prepare";
    await native.prepare(record, authorization, nativeClock());
    stage = "readiness";
    const proof = await native.readiness(record, authorization);
    checks.originalUnitAndCapacity = true;
    const launch = {
      bootId: nativeClock()[2],
      enforcerInstanceId: instance,
      expiresBoottimeUs: nativeClock()[1] + 5000000,
      digest: "f".repeat(64),
    };
    stage = "execute";
    await native.execute(record, operation, launch);
    await assert.rejects(() => native.execute(record!, operation, launch));
    checks.noSecondLaunch = true;
    stage = "lookup";
    const deadline = nativeClock()[0] + 8000000;
    let observation: Awaited<ReturnType<LinuxNative["lookup"]>> | undefined;
    while (nativeClock()[0] < deadline) {
      observation = await native.lookup(record, operation, true);
      if (observation.observation.phase === "exited") break;
      await delay(50);
    }
    assert.equal(observation?.observation.phase, "exited");
    assert.equal(observation.observation.exitCode, 0);
    assert.equal(observation.data?.toString(), "one,execution\n");
    assert.equal(observation.observation.startAttempts, 1);
    checks.actualRunscOutput = true;
    const ledger = new EventLedger(join(record.root, "work/events.jsonl"));
    assert.equal(ledger.counters(binding.actionId, binding.originalEpoch).startAttempts, 1);
    assert.equal(
      ledger
        .forAction(binding.actionId, binding.originalEpoch)
        .filter((e) => e.event === "container_create_reserved").length,
      1,
    );
    // An already running/exited container stays in the original PID1 lifetime after our control work ends.
    stage = "expiry";
    const remaining = proof.activeMonotonicUs + proof.runtimeMaxUs - nativeClock()[0];
    if (remaining > 0) await delay(remaining / 1000 + 250);
    const stopDeadline = nativeClock()[0] + 5000000;
    while (
      nativeClock()[0] < stopDeadline &&
      cgroupMembers("/sys/fs/cgroup/system.slice/" + record.unit).length
    )
      await delay(50);
    assert.deepEqual(cgroupMembers("/sys/fs/cgroup/system.slice/" + record.unit), []);
    assert.equal((await native.lookup(record, operation, true)).observation.phase, "unknown");
    checks.pid1OriginalExpiry = true;
  } catch (error) {
    failure = error;
    if (record) {
      try {
        const state = await native.show(record.unit);
        const journal = await native.command(
          [
            "/usr/bin/journalctl",
            "--unit=" + record.unit,
            "--no-pager",
            "--output=json",
            "--lines=30",
          ],
          3000,
          262144,
        );
        const helperCodes = journal
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line).MESSAGE as unknown)
          .filter(
            (value): value is string => typeof value === "string" && /^[a-z_]{1,80}$/.test(value),
          );
        process.stderr.write(
          JSON.stringify({
            nativeFailure: {
              stage,
              active: state.ActiveState,
              result: state.Result,
              helperCodes,
              ...(error instanceof NativeCommandFailure ? { command: error.diagnostic } : {}),
            },
          }) + "\n",
        );
      } catch {
        /* Diagnostics must not replace the original qualification failure. */
      }
    }
  }
  if (record) {
    try {
      await native.stop(record);
      await native.cleanup(record);
      checks.originalCleanup = true;
    } catch (error) {
      failure ??= error;
    }
  }
  const receipt = {
    version: 1,
    scope: "native-adapter-only",
    actualRunsc: true,
    checks,
    succeeded: failure === undefined,
  };
  exclusive(join(base, "RESULT.json"), receipt);
  process.stdout.write(JSON.stringify(receipt) + "\n");
  if (failure) throw failure;
}
main().catch((error) => {
  process.stderr.write(
    (error instanceof Error ? error.message : "native_qualification_failed") + "\n",
  );
  if (error instanceof Error && error.message === "unsafe_native_file")
    process.stderr.write(JSON.stringify({ nativeFileFacts: error.cause }) + "\n");
  process.exitCode = 1;
});
