/** One root-private, disposable CI command journey. Never discovers or installs a production Host. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  cpSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual as same } from "node:util";
import { strictCommandJson } from "../../apps/server/dist/work-command-values.js";
import { loadHostConfiguration } from "../linux-execution/host-configuration.ts";
import { Host } from "../linux-execution/protected-host.ts";
import { UnixService } from "../linux-execution/host-service.ts";
import { LinuxNative, type NativeReservation } from "../linux-execution/linux-native.ts";
import { nativeClock } from "../linux-execution/kernel-facts.ts";
import {
  reviewedBinaryHashes,
  reviewedImage,
  reviewedImageTag,
  reviewedImageConfig,
  trustedFile,
  type NativeConfiguration,
} from "../linux-execution/native-config.ts";
import { command, cgroupMembers } from "../linux-execution/native-unit.ts";
import { readKernelText } from "../linux-execution/output-capacity.ts";
import {
  directory,
  digest,
  exclusive,
  fsyncDirectory,
  readBytes,
  readRecord,
  requireFact,
} from "../linux-execution/protected-io.ts";
import {
  cleanupUnusedKey,
  clock,
  enrollmentInput,
  oneActionNative,
  reserveRun,
  withStageLock,
  requireUnreserved,
  safeCode,
  validateListeners,
  validatePublic,
  UID,
  RUNNER_MS,
  SESSION_MS,
  type Guard,
} from "./product-host-boundary.ts";
import { snapshotHost } from "./native-host-baseline.ts";
const ROOT = "/opt/obp5/product",
  PROGRAM = "/opt/obp5/code/product-host.cjs",
  NODE = "/opt/obp5/code/node",
  RELAY = "/opt/oc25n/node",
  PUBLIC = "/opt/obp5r",
  SOCKET = "/run/obp5/command.sock",
  NATIVE = "/opt/obc5",
  PACKET = "/opt/obp4";
const environment = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" };
const runCommand = command(environment);
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
function present(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function copy(source: string, target: string, mode = 0o600) {
  requireFact(!present(target), "packet_target_exists");
  requireFact(
    lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink(),
    "packet_source_changed",
  );
  cpSync(source, target, { force: false, errorOnExist: true, dereference: false });
  requireFact(
    lstatSync(target).isFile() && !lstatSync(target).isSymbolicLink(),
    "packet_copy_changed",
  );
  chownSync(target, 0, 0);
  chmodSync(target, mode);
  trustedFile(target);
}
function secret(path: string, bytes: string) {
  const fd = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    ),
    data = Buffer.from(bytes);
  try {
    for (let n = 0; n < data.length; ) {
      const count = writeSync(fd, data, n, data.length - n);
      requireFact(count > 0, "secret_write_unknown");
      n += count;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(ROOT + "/secrets");
}
async function stdin(maximum: number) {
  const parts: Buffer[] = [];
  let length = 0;
  for await (const raw of process.stdin) {
    const bytes = Buffer.from(raw);
    length += bytes.length;
    requireFact(length <= maximum, "stdin_bound");
    parts.push(bytes);
  }
  return Buffer.concat(parts);
}
async function prepare() {
  requireFact(
    process.env.GITHUB_ACTIONS === "true" && process.argv.length === 5,
    "disposable_linux_ci_only",
  );
  const relay = process.argv[3]!,
    output = process.argv[4]!;
  directory("/opt/obp5");
  directory(PACKET);
  requireFact(
    !present(ROOT) &&
      !present(PUBLIC) &&
      !present(NATIVE) &&
      !present("/run/obp5") &&
      !present("/opt/oc25n") &&
      !present(output),
    "fresh_product_packet_required",
  );
  for (const path of [ROOT, NATIVE, ROOT + "/docker-config"]) mkdirSync(path, { mode: 0o700 });
  mkdirSync("/run/obp5", { mode: 0o750 });
  chownSync("/run/obp5", 0, UID);
  chmodSync("/run/obp5", 0o750);
  copy(realpathSync(process.argv[1]!), PROGRAM);
  copy(relay, ROOT + "/product-command-node.cjs");
  // The unprivileged peer needs only this sealed executable, never access to root-private code.
  trustedFile(NODE);
  mkdirSync("/opt/oc25n", { mode: 0o755 });
  chmodSync("/opt/oc25n", 0o755);
  copy(NODE, RELAY, 0o755);
  const plan = JSON.parse(
    new TextDecoder("utf8", { fatal: true }).decode(
      readBytes(PACKET + "/PLAN.json", 2 * 1024 * 1024),
    ),
  ) as {
    command: { archiveSha256: string; manifest: string; config: string };
  };
  requireFact(
    plan.command.manifest === reviewedImage.split("@")[1] &&
      plan.command.config === reviewedImageConfig,
    "reviewed_image_changed",
  );
  const native: NativeConfiguration = {
    base: NATIVE,
    binaries: PACKET + "/bin",
    archive: PACKET + "/downloads/command-node-amd64.tar",
    archiveSha256: plan.command.archiveSha256,
    image: reviewedImage,
    imageTag: reviewedImageTag,
    helper: "/opt/obp5/code/native-helper.cjs",
    helperSha256: digest("/opt/obp5/code/native-helper.cjs"),
    node: NODE,
    nodeSha256: digest(NODE),
    binaryHashes: reviewedBinaryHashes,
    secretsDirectory: ROOT + "/secrets",
  };
  exclusive(ROOT + "/native.json", native);
  exclusive(
    ROOT + "/pins.json",
    Object.fromEntries(
      [PROGRAM, NODE, RELAY, ROOT + "/product-command-node.cjs", native.helper].map((path) => {
        trustedFile(path);
        return [path, digest(path)];
      }),
    ),
  );
  exclusive(output, { version: 2, program: PROGRAM, node: NODE });
  emit({ nativeProductPacketReady: true, typescriptHost: true });
}
function verifyPacket() {
  requireFact(
    realpathSync(process.argv[1]!) === PROGRAM && realpathSync(process.execPath) === NODE,
    "root_ci_packet_required",
  );
  directory(ROOT);
  const pins = readRecord(ROOT + "/pins.json") as Record<string, string>;
  requireFact(
    same(
      Object.keys(pins).sort(),
      [
        PROGRAM,
        NODE,
        RELAY,
        ROOT + "/product-command-node.cjs",
        "/opt/obp5/code/native-helper.cjs",
      ].sort(),
    ),
    "native_packet_changed",
  );
  for (const [path, pin] of Object.entries(pins)) trustedFile(path, pin);
}
function peerFree() {
  for (const database of ["passwd", "group"]) {
    const r = spawnSync("/usr/bin/getent", [database, String(UID)], {
      env: environment,
      timeout: 2000,
      maxBuffer: 16384,
    });
    requireFact(!r.error && r.status === 2 && r.stdout.length === 0, "fixture_uid_occupied");
  }
  for (const id of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      requireFact(lstatSync("/proc/" + id).uid !== UID, "fixture_uid_occupied");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  requireFact(!present(SOCKET), "fixture_socket_occupied");
}
async function stage() {
  const value = validatePublic(strictCommandJson(await stdin(16384), 16384));
  await peerFree();
  requireFact(!present(PUBLIC), "public_directory_occupied");
  requireFact(
    digest(ROOT + "/product-command-node.cjs") === value.nodeBundleSha256,
    "node_bundle_changed",
  );
  exclusive(ROOT + "/stage-reserved.json", { version: 1, route: value.route });
  for (const name of ["state", "secrets", "evidence"]) mkdirSync(join(ROOT, name), { mode: 0o700 });
  const key = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  secret(ROOT + "/secrets/control.pub", value.controlPublicPem);
  secret(ROOT + "/secrets/enforcer.pem", key.privateKey);
  secret(ROOT + "/secrets/enforcer.pub", key.publicKey);
  exclusive(ROOT + "/config.json", {
    state: ROOT + "/state",
    socket: SOCKET,
    nodeUid: UID,
    nodeGid: UID,
    route: value.route,
    policy: value.timing,
    controlIssuer: value.controlIssuer,
    enforcementIssuer: value.enforcementIssuer,
    native: readRecord(ROOT + "/native.json"),
    privateKey: ROOT + "/secrets/enforcer.pem",
    controlPins: [{ kid: value.controlKid, path: ROOT + "/secrets/control.pub" }],
  });
  exclusive(ROOT + "/public.json", value);
  const cfg = await loadHostConfiguration(ROOT + "/config.json");
  await LinuxNative.open(cfg.native);
  mkdirSync(PUBLIC, { mode: 0o750 });
  chmodSync(PUBLIC, 0o750);
  chownSync(PUBLIC, 0, UID);
  copy(ROOT + "/product-command-node.cjs", PUBLIC + "/product-command-node.cjs", 0o640);
  chownSync(PUBLIC + "/product-command-node.cjs", 0, UID);
  fsyncDirectory(PUBLIC);
  emit({
    version: 1,
    stageReady: true,
    route: value.route,
    enforcementIssuer: value.enforcementIssuer,
    enforcementKeyId: value.route.enforcementKeyId,
    enforcementPublicPem: key.publicKey,
    serverUrl: `ws://127.0.0.1:${value.serverPort}/ws/nodes`,
  });
}
async function host() {
  const cfg = await loadHostConfiguration(ROOT + "/config.json"),
    native = await LinuxNative.open(cfg.native),
    guard = readRecord(ROOT + "/run-reserved.json") as Guard;
  await new UnixService(
    new Host(cfg, oneActionNative(native, cfg.route, guard, ROOT + "/single-action.json")),
  ).serve();
}
const failedChildren = new WeakSet<ChildProcess>();
const live = (child: ChildProcess | undefined) =>
  !!child &&
  !failedChildren.has(child) &&
  child.pid !== undefined &&
  child.exitCode === null &&
  child.signalCode === null;
function launch(argv: string[], log: string, pipe = false) {
  const fd = openSync(
    log,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const child = spawn(argv[0]!, argv.slice(1), {
      env: environment,
      stdio: [pipe ? "pipe" : "ignore", fd, fd],
      shell: false,
    });
    child.on("error", () => {
      failedChildren.add(child);
    });
    return child;
  } finally {
    closeSync(fd);
  }
}
async function close(child: ChildProcess | undefined) {
  if (!live(child)) return;
  child!.kill("SIGTERM");
  let end = Date.now() + 3000;
  while (live(child) && Date.now() < end) await delay(20);
  if (live(child)) {
    child!.kill("SIGKILL");
    end = Date.now() + 2000;
    while (live(child) && Date.now() < end) await delay(20);
  }
  requireFact(!live(child), "owned_child_stop_unknown");
}
async function baseline() {
  const actual = await snapshotHost(runCommand, PACKET + "/bin/docker", ROOT + "/docker-config"),
    path = ROOT + "/host-baseline.json";
  if (!present(path)) exclusive(path, actual);
  requireFact(same(readRecord(path), actual), "native_host_state_changed");
  return {
    containerCount: actual.containers.length,
    identitiesAndStateUnchanged: true,
    ipv4Ipv6SemanticsUnchanged: true,
  };
}
async function cleanup(native: LinuxNative, evidence: Record<string, unknown>) {
  if (!present(ROOT + "/single-action.json")) {
    evidence.actionCount = 0;
    return;
  }
  const gate = readRecord(ROOT + "/single-action.json") as { binding: { preparationId: string } },
    binding = gate.binding,
    root = join(NATIVE, binding.preparationId.replaceAll("-", "").slice(0, 12));
  evidence.actionCount = 1;
  evidence.binding = binding;
  if (!present(root + "/native.json")) {
    evidence.nativeReservationIncomplete = true;
    return;
  }
  const record = readRecord(root + "/native.json") as NativeReservation,
    observed = readRecord(root + "/unit-observed.json") as { invocationId: string };
  requireFact(same(record.binding, binding), "native_binding_changed");
  let facts = await native.show(record.unit);
  requireFact(facts.InvocationID === observed.invocationId, "invocation_changed");
  const active = Number(facts.ActiveEnterTimestampMonotonic),
    end = active + 55000000;
  while (
    ["active", "activating", "deactivating"].includes(facts.ActiveState!) &&
    nativeClock()[0] < end
  ) {
    await delay(100);
    facts = await native.show(record.unit);
  }
  requireFact(
    facts.InvocationID === observed.invocationId &&
      facts.MainPID === "0" &&
      facts.NRestarts === "0" &&
      ["failed", "inactive"].includes(facts.ActiveState!),
    "native_not_terminal",
  );
  const stopped = Number(evidence._stopObservationUs ?? nativeClock()[0]);
  delete evidence._stopObservationUs;
  requireFact(stopped >= active && stopped <= end, "native_stop_observation_late");
  requireFact(
    cgroupMembers("/sys/fs/cgroup/system.slice/" + record.unit).length === 0,
    "native_cgroup_not_empty",
  );
  await native.cleanup(record);
  await native.command(["/usr/bin/systemctl", "reset-failed", record.unit]);
  requireFact((await native.show(record.unit)).LoadState === "not-found", "unit_not_released");
  evidence.native = {
    unit: record.unit,
    invocationId: observed.invocationId,
    result: facts.Result,
    originalCgroupEmpty: true,
    stopObservedWithin5SecondMargin: true,
    unitReleased: true,
    reservationRetained: true,
    privateRuntimeAbsent: [
      "docker-data",
      "docker-exec",
      "containerd-data",
      "containerd-state",
    ].every((name) => !present(join(root, name))),
    backingAbsent: !present(root + "/output.ext4"),
  };
}
function unused(stage: unknown) {
  cleanupUnusedKey(ROOT, stage, {
    directory,
    readRecord,
    readBytes,
    requirePeerFree: peerFree,
  });
}
async function run() {
  const result = await reserveRun(
    ROOT,
    async () => {
      const cfg = await loadHostConfiguration(ROOT + "/config.json"),
        native = await LinuxNative.open(cfg.native),
        value = validatePublic(readRecord(ROOT + "/public.json")),
        input = enrollmentInput(await stdin(512));
      await peerFree();
      validateListeners(
        readKernelText("/proc/net/tcp", 4 * 1024 * 1024),
        readKernelText("/proc/net/tcp6", 4 * 1024 * 1024),
        value.serverPort,
      );
      requireFact(
        digest(PUBLIC + "/product-command-node.cjs") === value.nodeBundleSha256,
        "node_bundle_changed",
      );
      verifyPacket();
      return { cfg, native, value, input };
    },
    unused,
  );
  const { cfg, native, value, input } = result.prepared,
    guard = result.guard,
    evidence: Record<string, unknown> = {
      version: 1,
      productAuthorityLocal: true,
      workSuccessNotInferred: true,
    };
  let hostChild: ChildProcess | undefined,
    nodeChild: ChildProcess | undefined,
    failure: string | undefined,
    interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  process.on("SIGTERM", interrupt);
  process.on("SIGINT", interrupt);
  try {
    evidence.before = await baseline();
    hostChild = launch([NODE, PROGRAM, "host"], ROOT + "/evidence/host-private.log");
    let end = Date.now() + 5000;
    while (!present(SOCKET)) {
      requireFact(live(hostChild) && Date.now() < end, "host_not_ready");
      await delay(20);
    }
    nodeChild = launch(
      [
        "/usr/bin/setpriv",
        `--reuid=${UID}`,
        `--regid=${UID}`,
        "--clear-groups",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--bounding-set=-all",
        "--no-new-privs",
        RELAY,
        PUBLIC + "/product-command-node.cjs",
      ],
      ROOT + "/evidence/node-private.log",
      true,
    );
    end = Date.now() + 3000;
    let verified = false;
    while (live(nodeChild) && Date.now() < end) {
      const status = Object.fromEntries(
        readKernelText(`/proc/${nodeChild.pid}/status`)
          .split("\n")
          .filter((l) => l.includes(":"))
          .map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]),
      );
      if (
        readlinkSync(`/proc/${nodeChild.pid}/exe`) === RELAY &&
        status.Uid?.split(/\s+/).join(",") === Array(4).fill(UID).join(",") &&
        status.Gid?.split(/\s+/).join(",") === Array(4).fill(UID).join(",") &&
        status.Groups === "" &&
        ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].every(
          (k) => status[k] && BigInt("0x" + status[k]) === 0n,
        ) &&
        status.NoNewPrivs === "1"
      ) {
        verified = true;
        break;
      }
      await delay(10);
    }
    requireFact(verified, "node_credentials_changed");
    nodeChild.stdin!.on("error", () => {
      failure ??= "node_input_failed";
    });
    nodeChild.stdin!.end(
      JSON.stringify({
        version: 1,
        nodeId: cfg.route.nodeId,
        serverUrl: `ws://127.0.0.1:${value.serverPort}/ws/nodes`,
        socketPath: SOCKET,
        selection: cfg.route,
        enrollmentToken: input.enrollmentToken,
      }) + "\n",
    );
    input.enrollmentToken = "";
    emit({
      version: 1,
      event: "remote_ready",
      socketReady: true,
      nodeSpawned: true,
      nodeUid: UID,
      serverAuthenticated: false,
    });
    while (
      clock()[0] < guard.startedBoottimeMs + SESSION_MS &&
      live(nodeChild) &&
      live(hostChild)
    ) {
      requireFact(!interrupted, "fixture_interrupted");
      if (present(ROOT + "/single-action.json")) {
        const gate = readRecord(ROOT + "/single-action.json") as {
            binding: { preparationId: string };
          },
          root = join(NATIVE, gate.binding.preparationId.replaceAll("-", "").slice(0, 12));
        if (present(root + "/unit-observed.json")) {
          const observed = readRecord(root + "/unit-observed.json") as { invocationId: string },
            record = readRecord(root + "/native.json") as NativeReservation,
            facts = await native.show(record.unit);
          requireFact(facts.InvocationID === observed.invocationId, "invocation_changed");
          if (["failed", "inactive"].includes(facts.ActiveState!)) {
            evidence._stopObservationUs = nativeClock()[0];
            break;
          }
        }
      }
      await delay(250);
    }
  } catch (error) {
    failure = safeCode(error);
  } finally {
    for (const child of [nodeChild, hostChild])
      try {
        await close(child);
      } catch (error) {
        failure ??= safeCode(error);
      }
    try {
      await cleanup(native, evidence);
    } catch (error) {
      evidence.cleanupFailure = safeCode(error);
      failure ??= "cleanup_failed";
    }
    try {
      evidence.after = await baseline();
    } catch (error) {
      evidence.productionFailure = safeCode(error);
      failure ??= "production_comparison_failed";
    }
    const key = ROOT + "/secrets/enforcer.pem";
    if (present(key)) {
      unlinkSync(key);
      fsyncDirectory(ROOT + "/secrets");
    }
    evidence.enforcerKeyRemoved = !present(key);
    evidence.socketAbsent = !present(SOCKET);
    evidence.runnerWithin150s = clock()[0] <= guard.startedBoottimeMs + RUNNER_MS;
    evidence.runnerSucceeded =
      !failure &&
      evidence.actionCount === 1 &&
      (evidence.native as { unitReleased?: boolean } | undefined)?.unitReleased === true &&
      evidence.runnerWithin150s === true;
    if (failure) evidence.failure = failure;
    exclusive(ROOT + "/evidence/safe-result.json", evidence);
    emit({ event: "remote_finished", ...evidence });
    process.off("SIGTERM", interrupt);
    process.off("SIGINT", interrupt);
  }
  requireFact(evidence.runnerSucceeded, "native_product_failed");
}
async function main() {
  process.umask(0o077);
  requireFact(
    process.platform === "linux" && process.arch === "x64" && process.geteuid?.() === 0,
    "disposable_linux_root_required",
  );
  const mode = process.argv[2];
  if (mode === "prepare") {
    await prepare();
    return;
  }
  requireFact(process.argv.length === 3, "invalid_native_ci_operation");
  verifyPacket();
  if (mode === "stage") await stage();
  else if (mode === "host") await host();
  else if (mode === "run") await run();
  else if (mode === "check") {
    requireFact(!present(ROOT + "/single-action.json"), "action_already_reserved");
    requireFact(
      (readRecord(ROOT + "/run-reserved.json") as { maximumMs: number }).maximumMs === RUNNER_MS,
      "runner_reservation_changed",
    );
    emit({
      version: 1,
      singleActionAbsent: true,
      runnerReserved: true,
      route: (readRecord(ROOT + "/public.json") as { route: unknown }).route,
    });
  } else if (mode === "cleanup") {
    requireUnreserved(ROOT);
    await withStageLock(ROOT, unused);
    emit({ unusedStageKeyRemoved: true });
  } else throw new Error("invalid_native_ci_operation");
}
main().catch((error) => {
  emit({ nativeFixtureFailure: { code: safeCode(error) } });
  process.exitCode = 1;
});
