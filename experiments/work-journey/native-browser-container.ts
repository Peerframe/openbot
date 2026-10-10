/** One create/start per declared browser instance; replacement reuses only the private profile after proven exit. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { object } from "../linux-execution/docker-cli.ts";
import { browserMembers, browserRuntimeObservation } from "./native-browser-observer.ts";
import { validateSentryArguments } from "./native-browser-contract.ts";
import {
  BrowserLifetime,
  browserBase,
  browserPacket,
  browserToken,
  browserNow,
  browserWait,
  browserRead,
} from "./native-browser-lifetime.ts";
export function browserCommon(name: string, network: string, address: string, memory: string) {
  return [
    "create",
    "--pull=never",
    "--name",
    name,
    "--runtime",
    "runsc",
    "--restart",
    "no",
    "--network",
    network,
    "--ip",
    address,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--ipc",
    "private",
    "--init",
    "--memory",
    memory,
    "--memory-swap",
    memory,
    "--cpus",
    "1.5",
    "--pids-limit",
    "1536",
    "--ulimit",
    "nproc=256:256",
    "--ulimit",
    "nofile=4096:4096",
    "--log-driver",
    "local",
    "--log-opt",
    "max-size=1m",
    "--log-opt",
    "max-file=1",
    "--log-opt",
    "compress=false",
  ];
}
export function browserCompositionCreate(root: string, id: string, index: number) {
  assert(index === 1 || index === 2, "Two declared browser instances only");
  const mounts = [
    [browserPacket + "/api", "/service", true],
    [browserPacket + "/bun", "/usr/local/bin/bun", true],
    [browserPacket + "/socket_probe.mjs", "/socket_probe.mjs", true],
    [browserPacket + "/tunnel_probe.mjs", "/tunnel_probe.mjs", true],
    [root + "/profiles", "/profiles", false],
    [browserPacket + "/nssdb", "/fixture-trust", true],
    [browserPacket + "/browser-entry.mjs", "/browser-entry.mjs", true],
  ] as const;
  const env = [
    "HOME=/tmp",
    "LANG=C.UTF-8",
    "PORT=4100",
    "COMPUTER_TOKEN=" + browserToken,
    "COMPUTER_SANDBOX=on",
    "COMPUTER_MAX_BROWSERS=2",
    "PROFILES_DIR=/profiles",
    "WORKSPACE_DIR=/tmp/workspace",
    "EGRESS_PROXY_DEFAULT=http://10.77.11.2:3128",
    "NAVIGATION_TIMEOUT_MS=15000",
    "ACTION_TIMEOUT_MS=5000",
    "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
  ];
  return [
    ...browserCommon("composition-browser-" + index, "composition-client", "10.77.10.2", "1536m"),
    "--ip6",
    "fd77:10::2",
    "--user",
    "1001:1001",
    "--shm-size",
    "256m",
    "--security-opt",
    "seccomp=" + browserPacket + "/seccomp_profile.json",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=256m,uid=1001,gid=1001,mode=700",
    ...mounts.flatMap(([source, destination, readonly]) => [
      "--mount",
      "type=bind,src=" + source + ",dst=" + destination + (readonly ? ",readonly" : ""),
    ]),
    "--workdir",
    "/service",
    ...env.flatMap((entry) => ["--env", entry]),
    "--entrypoint",
    "/usr/local/bin/bun",
    id,
    "/browser-entry.mjs",
  ];
}
export function validateCompositionBrowser(value: Record<string, unknown>, policy: unknown) {
  const host = object(value.HostConfig),
    config = object(value.Config),
    network = object(value.NetworkSettings);
  assert.deepEqual(
    [host.Runtime, host.Privileged, host.ReadonlyRootfs, host.CapDrop],
    ["runsc", false, true, ["ALL"]],
  );
  assert(host.PortBindings == null || Object.keys(object(host.PortBindings)).length === 0);
  assert.deepEqual(
    [config.User, host.Memory, host.MemorySwap],
    ["1001:1001", 1536 * 1024 ** 2, 1536 * 1024 ** 2],
  );
  assert.deepEqual(Object.keys(object(network.Networks)), ["composition-client"]);
  assert(Array.isArray(value.Mounts));
  const binds = value.Mounts.map(object).filter((v) => v.Type === "bind");
  assert.equal(binds.length, 7);
  assert.deepEqual(
    binds.map((v) => v.Destination).sort(),
    [
      "/service",
      "/usr/local/bin/bun",
      "/socket_probe.mjs",
      "/tunnel_probe.mjs",
      "/profiles",
      "/fixture-trust",
      "/browser-entry.mjs",
    ].sort(),
  );
  assert.deepEqual(
    binds.filter((v) => v.RW).map((v) => v.Destination),
    ["/profiles"],
  );
  assert.deepEqual(Object.keys(object(host.Tmpfs)), ["/tmp"]);
  assert(Array.isArray(host.SecurityOpt) && host.SecurityOpt.every((v) => typeof v === "string"));
  const seccomp = (host.SecurityOpt as string[]).filter((v) => v.startsWith("seccomp="));
  assert.equal(seccomp.length, 1);
  assert.deepEqual(JSON.parse(seccomp[0]!.slice(8)), policy);
}
export async function createCompositionBrowser(c: BrowserLifetime, index: number) {
  const image = browserRead(c.root + "/browser-image.json");
  assert(typeof image.Id === "string");
  const argv = browserCompositionCreate(c.root, image.Id, index);
  c.receipt("browser-" + index + "-create-reserved.json", { index });
  const id = await c.docker(argv);
  assert(/^[a-f0-9]{64}$/.test(id));
  const value = await c.inspect(id);
  validateCompositionBrowser(
    value,
    JSON.parse(readFileSync(browserPacket + "/seccomp_profile.json", "utf8")),
  );
  c.receipt("browser-" + index + "-created.json", value);
  c.receipt("browser-" + index + "-start-reserved.json", { id });
  await c.docker(["start", id]);
  await browserWait(
    async () => {
      try {
        return (await c.relay("control", "/health")).status === 200 || undefined;
      } catch {
        return undefined;
      }
    },
    browserNow() + 25,
    "actual Bun browser service",
  );
  const group = "/sys/fs/cgroup/system.slice/" + c.unit,
    members = browserMembers(group),
    args = browserRuntimeObservation(group, members, browserBase + "/bin");
  validateSentryArguments({ processes: args.processes.filter((v) => v.argv.at(-1) === id) }, id);
  c.receipt("browser-" + index + "-runtime.json", { members, arguments: args });
  return id;
}
export async function replaceCompositionBrowser(c: BrowserLifetime) {
  await c.original();
  const before = browserRead(c.root + "/ready.json").browserId;
  assert(typeof before === "string" && /^[a-f0-9]{64}$/.test(before));
  c.receipt("restart-reserved.json", { old: before });
  await c.docker(["stop", "--time", "12", before]);
  const old = object((await c.inspect(before)).State);
  assert.deepEqual(
    [old.Running, old.ExitCode, old.OOMKilled],
    [false, 0, false],
    "Original browser did not close gracefully",
  );
  await c.docker(["rm", before]);
  const after = await createCompositionBrowser(c, 2);
  assert.notEqual(after, before);
  const result = {
    oldContainerExited: true,
    oldExitCode: 0,
    newContainer: true,
    samePrivateProfile: true,
  };
  c.receipt("replacement.json", result);
  return result;
}
