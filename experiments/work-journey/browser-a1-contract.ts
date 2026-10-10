/** Fixed A1 container construction/readback; all authority remains with the owned native lifetime. */
import assert from "node:assert/strict";
import { posix } from "node:path";
import { browserImageConfig, browserImageManifest } from "./native-browser-contract.ts";
const temporary = "rw,nosuid,nodev,noexec,size=256m,uid=1001,gid=1001,mode=700";
export function browserA1Create(root: string, image: string) {
  assert([browserImageManifest, browserImageConfig].includes(image), "Unreviewed browser image");
  return [
    "create",
    "--pull=never",
    "--name",
    posix.basename(root),
    "--label",
    "openbot.qualification=browser-A1",
    "--label",
    "openbot.qualification.root=" + posix.basename(root),
    "--runtime",
    "runsc",
    "--restart",
    "no",
    "--network",
    "none",
    "--user",
    "1001:1001",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--security-opt",
    "seccomp=" + root + "/input/seccomp_profile.json",
    "--ipc",
    "private",
    "--shm-size",
    "256m",
    "--init",
    "--cpus",
    "1.5",
    "--memory",
    "1536m",
    "--memory-swap",
    "1536m",
    "--pids-limit",
    "1536",
    "--ulimit",
    "nproc=256:256",
    "--ulimit",
    "nofile=4096:4096",
    "--tmpfs",
    "/tmp:" + temporary,
    "--tmpfs",
    "/profiles:" + temporary,
    "--mount",
    "type=bind,src=" + root + "/input,dst=/qualification,readonly",
    "--env",
    "HOME=/tmp",
    "--env",
    "LANG=C.UTF-8",
    "--log-driver",
    "local",
    "--log-opt",
    "max-size=1m",
    "--log-opt",
    "max-file=1",
    "--log-opt",
    "compress=false",
    "--entrypoint",
    "/usr/bin/node",
    image,
    "/qualification/probe.ts",
  ];
}
function record(value: unknown): Record<string, unknown> {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Missing native readback object",
  );
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  assert(Array.isArray(value), "Missing native readback array");
  return value;
}
function strings(value: unknown): string[] {
  const result = array(value);
  assert(result.every((v) => typeof v === "string"));
  return result as string[];
}
function empty(value: unknown) {
  return (
    value === undefined ||
    value === null ||
    value === false ||
    value === 0 ||
    value === "" ||
    (typeof value === "object" && Object.keys(value).length === 0)
  );
}
export function validateBrowserA1(
  root: string,
  inputImage: unknown,
  inputContainer: unknown,
  seccompPolicy: unknown,
  created: boolean,
) {
  const image = record(inputImage),
    value = record(inputContainer),
    config = record(value.Config),
    host = record(value.HostConfig);
  assert(
    typeof value.Id === "string" && /^[a-f0-9]{64}$/.test(value.Id),
    "Invalid container identity",
  );
  assert.equal(value.Name, "/" + posix.basename(root));
  assert.equal(value.Image, image.Id);
  assert.deepEqual(
    [config.User, config.Entrypoint, config.Cmd, config.Image],
    ["1001:1001", ["/usr/bin/node"], ["/qualification/probe.ts"], image.Id],
  );
  const labels = record(config.Labels);
  assert.equal(labels["openbot.qualification"], "browser-A1");
  assert.equal(labels["openbot.qualification.root"], posix.basename(root));
  const environment = new Map(
    strings(record(image.Config).Env ?? []).map((entry) => [entry.split("=")[0]!, entry]),
  );
  environment.set("HOME", "HOME=/tmp");
  environment.set("LANG", "LANG=C.UTF-8");
  const actualEnvironment = strings(config.Env);
  assert.deepEqual(
    [...actualEnvironment].sort(),
    [...environment.values()].sort(),
    "Image environment changed",
  );
  assert(
    actualEnvironment.every(
      (entry) =>
        !/^(OPENBOT_|AWS_|AZURE_|GOOGLE_|OPENAI_|ANTHROPIC_|GITHUB_|DOCKER_|PG|POSTGRES)/.test(
          entry.split("=")[0]!.toUpperCase(),
        ),
    ),
    "Secret-like image environment refused",
  );
  const exact = {
    Runtime: "runsc",
    NetworkMode: "none",
    IpcMode: "private",
    ReadonlyRootfs: true,
    Privileged: false,
    Init: true,
    PidsLimit: 1536,
    Memory: 1536 * 1024 ** 2,
    MemorySwap: 1536 * 1024 ** 2,
    NanoCpus: 1500000000,
    ShmSize: 256 * 1024 ** 2,
    CapDrop: ["ALL"],
    RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
    LogConfig: { Type: "local", Config: { "max-size": "1m", "max-file": "1", compress: "false" } },
  };
  for (const [key, expected] of Object.entries(exact))
    assert.deepEqual(host[key], expected, "Container boundary changed: " + key);
  for (const key of [
    "CapAdd",
    "Devices",
    "DeviceRequests",
    "DeviceCgroupRules",
    "PortBindings",
    "Binds",
    "VolumesFrom",
    "ExtraHosts",
    "Links",
    "Dns",
    "DnsSearch",
    "DnsOptions",
    "Sysctls",
    "GroupAdd",
    "PidMode",
    "UTSMode",
    "PublishAllPorts",
    "AutoRemove",
  ])
    assert(empty(host[key]), "Unexpected host option: " + key);
  const options = strings(host.SecurityOpt);
  assert(
    options.length === 2 &&
      new Set(options).size === 2 &&
      options.some((v) => ["no-new-privileges", "no-new-privileges=true"].includes(v)),
  );
  const seccomp = options.filter((v) => v.startsWith("seccomp="));
  assert.equal(seccomp.length, 1);
  assert.deepEqual(JSON.parse(seccomp[0]!.slice(8)), seccompPolicy);
  const ulimits = array(host.Ulimits).map((v) => {
    const r = record(v);
    return [r.Name, r.Soft, r.Hard];
  });
  assert.deepEqual(
    ulimits.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    [
      ["nofile", 4096, 4096],
      ["nproc", 256, 256],
    ],
  );
  const tmpfs = record(host.Tmpfs);
  assert.deepEqual(Object.keys(tmpfs).sort(), ["/profiles", "/tmp"]);
  for (const options of Object.values(tmpfs)) {
    assert(typeof options === "string");
    const fields = options.split(","),
      sizes = ["size=256m", "size=262144k", "size=268435456"];
    assert(
      fields.length === 8 &&
        new Set(fields).size === 8 &&
        fields.filter((v) => sizes.includes(v)).length === 1,
    );
    assert.deepEqual(
      fields.filter((v) => !sizes.includes(v)).sort(),
      ["rw", "nosuid", "nodev", "noexec", "uid=1001", "gid=1001", "mode=700"].sort(),
    );
  }
  const mounts = array(value.Mounts).map(record),
    binds = mounts.filter((v) => v.Destination === "/qualification");
  assert.equal(binds.length, 1);
  assert.deepEqual(
    [binds[0]!.Source, binds[0]!.Type, binds[0]!.RW, binds[0]!.Propagation],
    [root + "/input", "bind", false, "rprivate"],
  );
  assert(
    mounts.every(
      (v) =>
        v.Destination === "/qualification" ||
        (typeof v.Destination === "string" &&
          Object.hasOwn(tmpfs, v.Destination) &&
          v.Type === "tmpfs"),
    ),
  );
  assert(empty(config.Volumes) && empty(config.ExposedPorts));
  assert(
    Object.keys(record(record(value.NetworkSettings ?? {}).Networks ?? {})).every(
      (v) => v === "none",
    ),
  );
  if (created) {
    const state = record(value.State);
    assert.deepEqual([state.Status, state.Running, state.Pid], ["created", false, 0]);
    assert(typeof state.StartedAt === "string" && state.StartedAt.startsWith("0001-"));
  }
  return value.Id;
}
