/** Ports frozen A1/composition/logging/socket assertions without starting any host service. */
import {
  browserCompositionCreate,
  validateCompositionBrowser,
} from "./native-browser-container.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { browserA1Create, validateBrowserA1 } from "./browser-a1-contract.ts";
import {
  browserConfigurations,
  browserImageConfig,
  browserImageManifest,
  browserProperties,
  browserRemaining,
  browserRoot,
  browserSocketPaths,
  browserSystemdArguments,
  browserUnit,
  loadedBrowserImage,
  preflightBrowserRoot,
  validateBrowserImage,
  validateBrowserRuntime,
  validateBrowserSocketPaths,
  validateBrowserUnit,
  validateSentryArguments,
} from "./native-browser-contract.ts";
import { unitProperties } from "../linux-execution/native-facts.ts";
const base = "/opt/openbot-qualification-20260925-c8b2",
  root = browserRoot("deadline-a1-r3", base),
  binary = base + "/bin";
const seccomp = { defaultAction: "SCMP_ACT_ERRNO", syscalls: [] };
function fixture() {
  const image = {
    Id: browserImageManifest,
    Os: "linux",
    Architecture: "amd64",
    Descriptor: { digest: browserImageManifest },
    Config: { Env: ["PATH=/usr/bin:/bin", "LANG=en_US.UTF-8"] },
  };
  const value = {
    Id: "a".repeat(64),
    Image: image.Id,
    Name: "/deadline-a1-r3",
    Config: {
      User: "1001:1001",
      Entrypoint: ["/usr/bin/node"],
      Cmd: ["/qualification/probe.ts"],
      Image: image.Id,
      Labels: {
        "openbot.qualification": "browser-A1",
        "openbot.qualification.root": "deadline-a1-r3",
      },
      Env: ["PATH=/usr/bin:/bin", "HOME=/tmp", "LANG=C.UTF-8"],
    },
    HostConfig: {
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
      LogConfig: {
        Type: "local",
        Config: { "max-size": "1m", "max-file": "1", compress: "false" },
      },
      SecurityOpt: ["no-new-privileges", "seccomp=" + JSON.stringify(seccomp)],
      Ulimits: [
        { Name: "nofile", Soft: 4096, Hard: 4096 },
        { Name: "nproc", Soft: 256, Hard: 256 },
      ],
      Tmpfs: Object.fromEntries(
        ["/tmp", "/profiles"].map((path) => [
          path,
          "rw,nosuid,nodev,noexec,size=256m,uid=1001,gid=1001,mode=700",
        ]),
      ),
    },
    Mounts: [
      {
        Destination: "/qualification",
        Source: root + "/input",
        Type: "bind",
        RW: false,
        Propagation: "rprivate",
      },
    ],
    State: { Status: "created", Running: false, Pid: 0, StartedAt: "0001-01-01T00:00:00Z" },
  };
  return { image, value };
}
test("frozen v3 construction changes only probe extension and explicit one-file compression", () => {
  const bytes = readFileSync(
    new URL("../browser-execution/fixtures/v3-construction.json", import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "7a917941604c293eec6d4887cdcefbd9a4fda06c3225a43760a69d7d931d22eb",
  );
  const prior = JSON.parse(bytes.toString());
  assert.equal(
    prior.provenance.sourceSha256,
    "b63b641f2b5ae3dfb1692a131241234a9d790a58dfa62ddc544447df3958392a",
  );
  const argv = browserA1Create(root, browserImageManifest),
    i = argv.indexOf("compress=false");
  assert.equal(argv[i - 1], "--log-opt");
  argv.splice(i - 1, 2);
  assert.equal(prior.createArgv.at(-1), "/qualification/probe.mjs");
  prior.createArgv[prior.createArgv.length - 1] = "/qualification/probe.ts";
  assert.deepEqual(argv, prior.createArgv);
  const configuration = browserConfigurations(root, binary);
  assert.deepEqual([configuration.daemon, configuration.containerd], prior.configurations);
  const originalProperties = prior.systemdArgv.filter((v: string) => v.startsWith("--property="));
  assert.deepEqual(
    browserSystemdArguments(root, false, "/opt/obp4/node", "/opt/obp4/browser-native.cjs").filter(
      (v) => v.startsWith("--property="),
    ),
    originalProperties,
  );
  assert.equal(unitProperties.RuntimeMaxSec, "60");
  assert.equal(browserProperties(false).RuntimeMaxSec, "180");
  assert.deepEqual(
    [
      browserProperties(true).RuntimeMaxSec,
      browserProperties(true).MemoryMax,
      browserProperties(true).TasksMax,
    ],
    ["600", "3072M", "2048"],
  );
});
test("A1 create never starts, pulls, enables privilege or mounts an archive", () => {
  const argv = browserA1Create(root, browserImageManifest);
  assert.equal(argv[0], "create");
  assert.equal(argv.filter((v) => v === "--mount").length, 1);
  assert.deepEqual(
    argv.filter((v, i) => argv[i - 1] === "--log-opt"),
    ["max-size=1m", "max-file=1", "compress=false"],
  );
  for (const forbidden of [
    "--no-sandbox",
    "--privileged",
    "--rm",
    "start",
    "unconfined",
    "SYS_ADMIN",
    "runc",
  ])
    assert(!argv.includes(forbidden));
  assert.throws(() => browserA1Create(root, "python:latest"));
  for (const name of [
    "../production",
    "deadline-a1-",
    "deadline-other",
    "deadline-a1-" + "x".repeat(13),
    "deadline-a1-a;b",
  ])
    assert.throws(() => browserRoot(name));
});
test("full Unix socket bytes preserve original 108-byte failure, 102-byte fix and proc 106-byte bound", () => {
  const old = browserSocketPaths(browserRoot("deadline-a1-0925a1r1", base));
  assert.equal(Buffer.byteLength(old.libnetwork_external_key), 108);
  assert.throws(
    () => preflightBrowserRoot("deadline-a1-0925a1r1", base),
    /libnetwork_external_key/,
  );
  const path = preflightBrowserRoot("deadline-a1-r2", base),
    inventory = validateBrowserSocketPaths(browserSocketPaths(path));
  assert.equal(inventory.libnetwork_external_key!.bytes, 102);
  assert.equal(inventory.runsc_control_bind_proc_alias_bound!.bytes, 106);
  const actual = validateBrowserSocketPaths(
    browserSocketPaths(browserRoot("deadline-a1-p4abcdef")),
  );
  assert(Object.values(actual).every((v) => v.bytes <= 107));
  for (const [label] of Object.entries(inventory))
    assert.throws(
      () =>
        validateBrowserSocketPaths({ ...browserSocketPaths(path), [label]: "/" + "x".repeat(107) }),
      new RegExp(label),
    );
  for (const value of [
    "/" + "x".repeat(107),
    "/" + "你".repeat(36),
    "relative.sock",
    "/nul\0.sock",
  ])
    assert.throws(() => validateBrowserSocketPaths({ bad: value }));
  validateBrowserSocketPaths({ exact: "/" + "x".repeat(106), unicode: "/" + "你".repeat(35) });
  const paths = browserSocketPaths(path),
    configuration = browserConfigurations(path, binary);
  assert.deepEqual(configuration.daemon.hosts, ["unix://" + paths.docker_api]);
  assert.equal(configuration.daemon.containerd, paths.containerd_grpc);
  assert(configuration.containerd.includes('address = "' + paths.containerd_grpc + '"'));
  assert.equal(paths.containerd_ttrpc, paths.containerd_grpc + ".ttrpc");
  assert(paths.containerd_shim_ttrpc.endsWith("f".repeat(64)));
});
test("fixed image readbacks reject other platform/config/descriptor and only fall back after absent manifest", async () => {
  for (const id of [browserImageManifest, browserImageConfig])
    assert.equal(validateBrowserImage({ Id: id, Architecture: "amd64", Os: "linux" }), id);
  for (const image of [
    { Id: "sha256:" + "0".repeat(64), Architecture: "amd64", Os: "linux" },
    { Id: browserImageManifest, Architecture: "arm64", Os: "linux" },
    {
      Id: browserImageManifest,
      Architecture: "amd64",
      Os: "linux",
      Descriptor: { digest: browserImageConfig },
    },
  ])
    assert.throws(() => validateBrowserImage(image));
  for (const fallback of [false, true]) {
    const calls: string[] = [],
      image = {
        Id: fallback ? browserImageConfig : browserImageManifest,
        Os: "linux",
        Architecture: "amd64",
      };
    assert.equal(
      await loadedBrowserImage(async (id) => {
        calls.push(id);
        return fallback && id === browserImageManifest ? null : image;
      }),
      image,
    );
    assert.deepEqual(
      calls,
      fallback ? [browserImageManifest, browserImageConfig] : [browserImageManifest],
    );
  }
  let calls = 0;
  await assert.rejects(
    loadedBrowserImage(async () => {
      calls++;
      return { Id: browserImageManifest, Os: "linux", Architecture: "arm64" };
    }),
  );
  assert.equal(calls, 1);
});
test("daemon and live Sentry require exact normalized single flags before boot", () => {
  const runtime = {
    path: binary + "/runsc",
    runtimeArgs: ["--platform=systrap", "--oci-seccomp=true"],
  };
  validateBrowserRuntime({ Runtimes: { runsc: runtime } }, binary);
  for (const value of [
    {},
    { Path: runtime.path, Args: runtime.runtimeArgs },
    { ...runtime, path: "/usr/bin/runsc" },
    { ...runtime, runtimeArgs: ["--platform=systrap"] },
    { ...runtime, runtimeArgs: ["--platform=systrap", "--oci-seccomp=false"] },
    { ...runtime, runtimeArgs: [...runtime.runtimeArgs, "--oci-seccomp=false"] },
  ])
    assert.throws(() => validateBrowserRuntime({ Runtimes: { runsc: value } }, binary));
  const argv = [
      "runsc-sandbox",
      ...runtime.runtimeArgs,
      "boot",
      "--bundle=/owned/bundle",
      "a".repeat(64),
    ],
    observed = (argv: string[]) => ({ processes: [{ argv }] });
  validateSentryArguments(observed(argv), "a".repeat(64));
  for (const bad of [
    ["gvisor-sentry-prewarmer", ...argv],
    [...argv.slice(0, 2), ...argv.slice(3)],
    argv.map((v) => v.replace("--oci-seccomp=true", "--oci-seccomp=false")),
    [...argv.slice(0, 2), "--oci-seccomp", ...argv.slice(3)],
    [...argv.slice(0, 3), "--oci-seccomp=false", ...argv.slice(3)],
    [...argv.slice(0, 2), "boot", "--oci-seccomp=true", ...argv.slice(4)],
    [...argv.slice(0, -1), "b".repeat(64)],
  ])
    assert.throws(() => validateSentryArguments(observed(bad), "a".repeat(64)));
  for (const processes of [[], [{ argv }, { argv }]])
    assert.throws(() => validateSentryArguments({ processes }, "a".repeat(64)));
});
test("A1 exact container shape rejects every old isolation, mount, environment and state downgrade", () => {
  const { image, value } = fixture();
  assert.equal(validateBrowserA1(root, image, value, seccomp, true), "a".repeat(64));
  const mutations: [string, string, unknown][] = [
    ...[
      ["Runtime", "runc"],
      ["Privileged", true],
      ["Init", 1],
      ["Memory", "1610612736"],
      ["NetworkMode", "host"],
      ["MemorySwap", -1],
      ["PidsLimit", 0],
      ["CapAdd", ["SYS_ADMIN"]],
      ["SecurityOpt", ["no-new-privileges", "seccomp=unconfined"]],
      ["PortBindings", { "80/tcp": [{}] }],
    ].map(([key, value]) => ["HostConfig", key, value] as [string, string, unknown]),
    ["Config", "User", "0:0"],
    ["Config", "Cmd", ["/bin/sh"]],
    ["Config", "Env", ["HOME=/tmp", "API_KEY=bad"]],
    ["State", "Status", "exited"],
  ];
  for (const [section, key, replacement] of mutations) {
    const changed = structuredClone(value) as unknown as Record<string, Record<string, unknown>>;
    changed[section]![key] = replacement;
    assert.throws(() => validateBrowserA1(root, image, changed, seccomp, true), section + key);
  }
  const changed = { ...value, Mounts: [...value.Mounts, { Destination: "/host", Type: "bind" }] };
  assert.throws(() => validateBrowserA1(root, image, changed, seccomp, true));
  for (const prefix of [
    "OPENBOT_",
    "AWS_",
    "AZURE_",
    "GOOGLE_",
    "OPENAI_",
    "ANTHROPIC_",
    "GITHUB_",
    "DOCKER_",
    "PG",
    "POSTGRES",
  ]) {
    const imageWithSecret = structuredClone(image),
      containerWithSecret = structuredClone(value);
    imageWithSecret.Config.Env.push(prefix + "SECRET=synthetic");
    containerWithSecret.Config.Env.push(prefix + "SECRET=synthetic");
    assert.throws(() =>
      validateBrowserA1(root, imageWithSecret, containerWithSecret, seccomp, true),
    );
  }
});
test("one-file logging refuses absent, widened, coerced or extra compression settings", () => {
  const { image, value } = fixture(),
    good = value.HostConfig.LogConfig.Config;
  for (const config of [
    { "max-size": "1m", "max-file": "1" },
    { ...good, compress: "true" },
    { ...good, compress: false },
    { ...good, compress: "0" },
    { ...good, "max-file": "2" },
    { ...good, "max-file": 1 },
    { ...good, "max-size": "2m" },
    { ...good, "max-size": "1048576" },
    { ...good, mode: "non-blocking" },
  ])
    assert.throws(() =>
      validateBrowserA1(
        root,
        image,
        {
          ...value,
          HostConfig: { ...value.HostConfig, LogConfig: { Type: "local", Config: config } },
        },
        seccomp,
        true,
      ),
    );
});
test("typed original unit readback and exhausted lifetime never become a fresh deadline", () => {
  const value: Record<string, string> = {
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
    MemoryMax: String(2500 * 1024 ** 2),
    MemorySwapMax: "0",
    TasksMax: "1536",
    ControlGroup: "/system.slice/" + browserUnit(root),
    RuntimeMaxUSec: "3min",
    RuntimeRandomizedExtraUSec: "0",
    TimeoutStopUSec: "1s",
    CPUQuotaPerSecUSec: "1.500000s",
    InvocationID: "a".repeat(32),
    ActiveState: "active",
    ActiveEnterTimestampMonotonic: "1000000",
  };
  assert.equal(validateBrowserUnit(root, value, false), 181);
  for (const [key, other] of [
    ["RuntimeMaxUSec", "1min"],
    ["Restart", "on-failure"],
    ["KillMode", "process"],
    ["InvocationID", ""],
    ["ActiveState", "failed"],
    ["MemoryMax", "3072M"],
  ])
    assert.throws(() => validateBrowserUnit(root, { ...value, [key!]: other! }, false));
  assert.equal(
    validateBrowserUnit(
      root,
      { ...value, MemoryMax: String(3072 * 1024 ** 2), TasksMax: "2048", RuntimeMaxUSec: "10min" },
      true,
    ),
    601,
  );
  assert.equal(browserRemaining(110, 100, 2), 8);
  assert.throws(() => browserRemaining(100, 100));
  assert.throws(() => browserRemaining(110, 100, 11));
});

test("composition creates only two declared browser identities and only the profile bind is writable", () => {
  const root = "/opt/obp4/units/deadline-a1-p4abcdef";
  for (const index of [1, 2]) {
    const args = browserCompositionCreate(root, browserImageManifest, index);
    assert.equal(args[0], "create");
    assert(args.includes("--pull=never"));
    assert(!args.includes("--privileged"));
    const mounts = args.filter((_, i) => args[i - 1] === "--mount");
    assert.equal(mounts.length, 7);
    assert.deepEqual(
      mounts.filter((v) => !v.endsWith(",readonly")),
      ["type=bind,src=" + root + "/profiles,dst=/profiles"],
    );
  }
  assert.throws(() => browserCompositionCreate(root, browserImageManifest, 3));
  const policy = { defaultAction: "SCMP_ACT_ERRNO" };
  const value = {
    HostConfig: {
      Runtime: "runsc",
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      PortBindings: {},
      Memory: 1536 * 1024 ** 2,
      MemorySwap: 1536 * 1024 ** 2,
      Tmpfs: { "/tmp": "bounded" },
      SecurityOpt: ["seccomp=" + JSON.stringify(policy)],
    },
    Config: { User: "1001:1001" },
    NetworkSettings: { Networks: { "composition-client": {} } },
    Mounts: [
      "/service",
      "/usr/local/bin/bun",
      "/socket_probe.mjs",
      "/tunnel_probe.mjs",
      "/profiles",
      "/fixture-trust",
      "/browser-entry.mjs",
    ].map((Destination) => ({ Destination, Type: "bind", RW: Destination === "/profiles" })),
  };
  validateCompositionBrowser(value, policy);
  for (const [key, replacement] of [
    ["Runtime", "runc"],
    ["Privileged", true],
    ["ReadonlyRootfs", false],
    ["CapDrop", []],
    ["PortBindings", { "80/tcp": [] }],
    ["Memory", "1610612736"],
    ["MemorySwap", -1],
    ["Tmpfs", { "/host": "rw" }],
    ["SecurityOpt", ["seccomp=unconfined"]],
  ] as const)
    assert.throws(() =>
      validateCompositionBrowser(
        { ...value, HostConfig: { ...value.HostConfig, [key]: replacement } },
        policy,
      ),
    );
  assert.throws(() =>
    validateCompositionBrowser(
      { ...value, Mounts: value.Mounts.map((v) => ({ ...v, RW: true })) },
      policy,
    ),
  );
  assert.throws(() =>
    validateCompositionBrowser({ ...value, NetworkSettings: { Networks: { host: {} } } }, policy),
  );
});
