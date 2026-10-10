/** Pure readbacks for the fixed native browser packet; never grants host execution authority. */
import assert from "node:assert/strict";
import { posix } from "node:path";
import { configurationValues, unitProperties } from "../linux-execution/native-facts.ts";
import { durationUs } from "../linux-execution/native-unit.ts";
export const browserRuntimeArguments = ["--platform=systrap", "--oci-seccomp=true"];
export const browserImageManifest =
  "sha256:c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac";
export const browserImageConfig =
  "sha256:fee853fafa59550d162cef52bca02d907694b44ebf6ef9fb075bcc0c65d8dedb";
export function browserRoot(name: string, base = "/opt/obp4") {
  assert(/^deadline-a1-[a-z0-9]{1,12}$/.test(name), "Invalid fresh native browser name");
  return posix.join(base, "units", name);
}
export function browserUnit(root: string) {
  assert(/^deadline-a1-[a-z0-9]{1,12}$/.test(posix.basename(root)), "Invalid browser unit name");
  return "openbot-qualification-" + posix.basename(root) + ".service";
}
export function browserSocketPaths(root: string) {
  const controller = "f".repeat(12),
    digest = "f".repeat(64),
    proc = "/proc/2147483647/fd/2147483647";
  return {
    docker_api: posix.join(root, "docker.sock"),
    containerd_grpc: posix.join(root, "containerd.sock"),
    containerd_ttrpc: posix.join(root, "containerd.sock.ttrpc"),
    docker_metrics: posix.join(root, "docker-exec/metrics.sock"),
    libnetwork_external_key: posix.join(root, "docker-exec/libnetwork", controller + ".sock"),
    containerd_shim_ttrpc: "/run/containerd/s/" + digest,
    containerd_shim_debug: "/run/containerd/s/" + digest,
    runsc_control_bind_proc_alias_bound: proc + "/runsc-" + digest + ".sock",
    runsc_control_connect_proc_alias_bound: proc,
    ...Object.fromEntries(
      [
        ["var_run", "/var/run"],
        ["run", "/run"],
        ["tmp", "/tmp"],
      ].map(([label, directory]) => [
        "runsc_control_" + label,
        directory + "/runsc-" + digest + ".sock",
      ]),
    ),
  };
}
export function validateBrowserSocketPaths(paths: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(paths).map(([label, path]) => {
      assert(
        posix.isAbsolute(path) && !path.includes("\0") && Buffer.byteLength(path) <= 107,
        "Native Unix socket bound: " + label,
      );
      return [label, { upperBoundPath: path, bytes: Buffer.byteLength(path) }];
    }),
  );
}
export function browserConfigurations(root: string, binaries: string) {
  const { daemon, containerd } = configurationValues(root, browserUnit(root), binaries);
  daemon.runtimes.runsc.runtimeArgs = [...browserRuntimeArguments];
  // The original browser fixture uses a separately owned containerd namespace.
  daemon["containerd-namespace"] = "openbot-qualification";
  daemon["containerd-plugins-namespace"] = "openbot-qualification-plugins";
  const { compress: _compression, ...logOptions } = daemon["log-opts"];
  return { daemon: { ...daemon, "log-opts": logOptions }, containerd };
}
export function browserProperties(composition: boolean) {
  return {
    ...unitProperties,
    RuntimeMaxSec: composition ? "600" : "180",
    ...(composition ? { MemoryMax: "3072M", TasksMax: "2048" } : {}),
  };
}
export function validateBrowserRuntime(value: unknown, binaries: string) {
  const info = value as { Runtimes?: { runsc?: { path?: unknown; runtimeArgs?: unknown } } };
  assert.equal(
    info?.Runtimes?.runsc?.path,
    posix.join(binaries, "runsc"),
    "Daemon runsc path changed",
  );
  assert.deepEqual(
    info?.Runtimes?.runsc?.runtimeArgs,
    browserRuntimeArguments,
    "Daemon runtime flags changed",
  );
}
export function validateBrowserImage(value: unknown) {
  assert(value && typeof value === "object" && !Array.isArray(value));
  const image = value as Record<string, unknown>;
  assert(
    [browserImageManifest, browserImageConfig].includes(String(image.Id)) &&
      image.Architecture === "amd64" &&
      image.Os === "linux",
    "Loaded browser identity/platform changed",
  );
  if (image.Descriptor !== undefined && image.Descriptor !== null)
    assert.equal(
      (image.Descriptor as Record<string, unknown>).digest,
      browserImageManifest,
      "Loaded browser descriptor changed",
    );
  return image.Id as string;
}
export async function loadedBrowserImage(inspect: (id: string) => Promise<unknown | null>) {
  const image = (await inspect(browserImageManifest)) ?? (await inspect(browserImageConfig));
  validateBrowserImage(image);
  return image;
}
export function validateSentryArguments(
  observed: { processes: { argv: string[]; [key: string]: unknown }[] },
  id: string,
) {
  const candidates = observed.processes.filter((value) => value.argv[0] === "runsc-sandbox");
  assert.equal(candidates.length, 1, "Exact owned Sentry argv was not observed");
  const value = candidates[0]!,
    argv = value.argv;
  assert.equal(argv.filter((value) => value === "boot").length, 1, "Sentry boot count changed");
  assert.equal(argv.at(-1), id, "Sentry container identity changed");
  const boot = argv.indexOf("boot");
  for (const [name, expected] of [
    ["oci-seccomp", "--oci-seccomp=true"],
    ["platform", "--platform=systrap"],
  ] as const) {
    const positions = argv
      .map((value, index) => (value.replace(/^-+/, "").split("=")[0] === name ? index : -1))
      .filter((value) => value >= 0);
    assert(
      positions.length === 1 && positions[0]! < boot && argv[positions[0]!] === expected,
      "Sentry runtime flag changed: " + name,
    );
  }
  return value;
}
export function validateBrowserUnit(
  root: string,
  value: Record<string, string>,
  composition: boolean,
) {
  const expected = {
    Type: "exec",
    KillMode: "control-group",
    KillSignal: "9",
    FinalKillSignal: "9",
    SendSIGKILL: "yes",
    Restart: "no",
    NRestarts: "0",
    NotifyAccess: "none",
    ExecStop: "",
    ExecStopPost: "",
    TriggeredBy: "",
    PrivateNetwork: "yes",
    PrivateMounts: "yes",
    DelegateSubgroup: "supervisor",
    MemoryMax: String((composition ? 3072 : 2500) * 1024 ** 2),
    MemorySwapMax: "0",
    TasksMax: composition ? "2048" : "1536",
    ControlGroup: "/system.slice/" + browserUnit(root),
  };
  for (const [name, expectedValue] of Object.entries(expected))
    assert.equal(value[name], expectedValue, "Native unit property changed: " + name);
  for (const [name, expectedUs] of [
    ["RuntimeMaxUSec", (composition ? 600 : 180) * 1000000],
    ["RuntimeRandomizedExtraUSec", 0],
    ["TimeoutStopUSec", 1000000],
    ["CPUQuotaPerSecUSec", 1500000],
  ] as const)
    assert.equal(durationUs(value[name]!), expectedUs, "Native unit duration changed: " + name);
  assert(/^[a-f0-9]{32}$/.test(value.InvocationID ?? ""), "Native invocation missing");
  assert(
    value.ActiveState === "active" &&
      /^[1-9][0-9]*$/.test(value.ActiveEnterTimestampMonotonic ?? ""),
    "Active native lifetime missing",
  );
  const started = Number(value.ActiveEnterTimestampMonotonic);
  assert(Number.isSafeInteger(started));
  return started / 1000000 + (composition ? 600 : 180);
}

export function preflightBrowserRoot(name: string, base = "/opt/obp4") {
  const root = browserRoot(name, base);
  validateBrowserSocketPaths(browserSocketPaths(root));
  return root;
}
export function browserSystemdArguments(
  root: string,
  composition: boolean,
  node: string,
  program: string,
) {
  validateBrowserSocketPaths(browserSocketPaths(root));
  return [
    "/usr/bin/systemd-run",
    "--unit=" + browserUnit(root),
    "--service-type=exec",
    ...Object.entries(browserProperties(composition)).map(
      ([name, value]) => "--property=" + name + "=" + value,
    ),
    node,
    program,
    "daemon",
    "--root",
    root,
  ];
}
export function browserRemaining(deadline: number, now: number, reserve = 0) {
  assert(
    Number.isFinite(deadline) && Number.isFinite(now) && Number.isFinite(reserve) && reserve >= 0,
  );
  const remaining = deadline - now - reserve;
  assert(remaining > 0, "Native lifetime exhausted; no replacement deadline");
  return remaining;
}
