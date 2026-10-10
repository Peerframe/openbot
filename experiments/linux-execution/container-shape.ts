/** Fixed command container resources and independent daemon readback of the admitted shape. */
import { isDeepStrictEqual as same } from "node:util";
import type { WorkCommand } from "../../apps/server/dist/work-command-contract.js";
import { requireFact } from "./protected-io.ts";
import { object } from "./docker-cli.ts";
export const labels = {
  owner: "openbot.experiment.owner",
  action: "openbot.action.id",
  digest: "openbot.action.digest",
  epoch: "openbot.action.epoch",
};
export type Shape = {
  name: string;
  action: string;
  epoch: number;
  intent: string;
  input: string;
  output: string;
  command: WorkCommand;
};
const logShape = (command: WorkCommand) => ({
  "max-size": Math.max(8, Math.ceil(command.limits.capturedOutputKiB / 2)) + "k",
  "max-file": "2",
});
export function createArguments(value: Shape) {
  const c = value.command,
    l = c.limits;
  requireFact(
    ![value.input, value.output].some((path) => /[,\n\r\0]/.test(path)),
    "unsafe_mount_delimiter",
  );
  const log = logShape(c);
  return [
    "--pull=never",
    "--name",
    value.name,
    "--runtime",
    "runsc",
    "--restart",
    "no",
    "--network",
    "none",
    "--user",
    "10001:10001",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    l.memoryMiB + "m",
    "--memory-swap",
    l.memoryMiB + "m",
    "--cpus",
    String(l.nanoCPUs / 1000000000),
    "--pids-limit",
    String(l.pids),
    "--ulimit",
    `nofile=${l.nofile}:${l.nofile}`,
    "--ulimit",
    `nproc=${l.pids}:${l.pids}`,
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,noexec,size=${l.tmpMiB}m`,
    "--log-driver",
    "local",
    "--log-opt",
    "max-size=" + log["max-size"],
    "--log-opt",
    "max-file=" + log["max-file"],
    "--mount",
    `type=bind,src=${value.input},dst=/input,readonly`,
    "--mount",
    `type=bind,src=${value.output},dst=/output`,
    "--label",
    labels.owner + "=linux-execution-precursor",
    "--label",
    labels.action + "=" + value.action,
    "--label",
    labels.digest + "=" + value.intent,
    "--label",
    labels.epoch + "=" + value.epoch,
    c.image,
    ...c.argv,
  ];
}
export function assertCreatedShape(value: Shape, inspected: Record<string, unknown>) {
  const config = object(inspected.Config),
    host = object(inspected.HostConfig),
    limits = value.command.limits;
  requireFact(config.User === "10001:10001", "container_user_changed");
  for (const [key, expected] of Object.entries({
    PidsLimit: limits.pids,
    Memory: limits.memoryMiB * 1024 ** 2,
    MemorySwap: limits.memoryMiB * 1024 ** 2,
    NanoCpus: limits.nanoCPUs,
  }))
    requireFact(
      Number.isSafeInteger(host[key]) && host[key] === expected,
      "container_resources_changed",
    );
  requireFact(
    Array.isArray(host.Ulimits) && host.Ulimits.length === 2,
    "container_ulimits_changed",
  );
  for (const [name, limit] of [
    ["nofile", limits.nofile],
    ["nproc", limits.pids],
  ] as const) {
    const entries = host.Ulimits.map(object).filter((v) => v.Name === name);
    requireFact(
      entries.length === 1 && entries[0]!.Soft === limit && entries[0]!.Hard === limit,
      "container_ulimits_changed",
    );
  }
  const tmpfs = object(host.Tmpfs),
    options = typeof tmpfs["/tmp"] === "string" ? tmpfs["/tmp"].split(",") : [],
    sizes = new Set([
      `size=${limits.tmpMiB}m`,
      `size=${limits.tmpMiB * 1024}k`,
      `size=${limits.tmpMiB * 1024 ** 2}`,
    ]);
  requireFact(
    same(Object.keys(tmpfs), ["/tmp"]) &&
      options.length === 5 &&
      new Set(options).size === 5 &&
      options.filter((v) => sizes.has(v)).length === 1 &&
      same(
        new Set(options.filter((v) => !sizes.has(v))),
        new Set(["rw", "nosuid", "nodev", "noexec"]),
      ),
    "container_tmpfs_changed",
  );
  requireFact(
    host.Runtime === "runsc" &&
      host.NetworkMode === "none" &&
      host.ReadonlyRootfs === true &&
      host.Privileged === false &&
      same(host.CapDrop, ["ALL"]) &&
      Array.isArray(host.SecurityOpt) &&
      host.SecurityOpt.includes("no-new-privileges"),
    "container_isolation_changed",
  );
  requireFact(
    ["no", ""].includes(String(object(host.RestartPolicy).Name ?? "no")) &&
      (!host.CapAdd || same(host.CapAdd, [])),
    "container_authority_changed",
  );
  const log = object(host.LogConfig),
    logOptions = object(log.Config);
  requireFact(
    log.Type === "local" &&
      Object.entries(logShape(value.command)).every(([k, v]) => logOptions[k] === v),
    "container_logging_changed",
  );
  requireFact(Array.isArray(inspected.Mounts), "container_mounts_changed");
  const mounted = inspected.Mounts.map(object);
  requireFact(
    new Set(mounted.map((m) => m.Destination)).size === mounted.length,
    "container_mounts_ambiguous",
  );
  for (const [destination, source, writable] of [
    ["/input", value.input, false],
    ["/output", value.output, true],
  ] as const) {
    const m = mounted.find((m) => m.Destination === destination);
    requireFact(
      m &&
        m.Type === "bind" &&
        m.Source === source &&
        m.RW === writable &&
        m.Propagation === "rprivate",
      "container_bind_changed",
    );
  }
  requireFact(
    mounted.every(
      (m) =>
        m.Destination === "/input" ||
        m.Destination === "/output" ||
        (m.Destination === "/tmp" && m.Type === "tmpfs"),
    ),
    "container_mounts_changed",
  );
  requireFact(
    config.Env === undefined ||
      config.Env === null ||
      (Array.isArray(config.Env) &&
        config.Env.every(
          (item) =>
            typeof item === "string" &&
            !/^(OPENBOT_|AWS_|AZURE_|GOOGLE_|OPENAI_|ANTHROPIC_|GITHUB_|DOCKER_|PG|POSTGRES)/.test(
              item.split("=")[0]!.toUpperCase(),
            ),
        )),
    "container_secret_environment",
  );
}
