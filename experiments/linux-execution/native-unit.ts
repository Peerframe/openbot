/** Reads original PID1 unit identity and cgroup membership; no lifecycle mutation. */
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { strictCommandJson } from "../../apps/server/dist/work-command-values.js";
import { readKernelText } from "./output-capacity.ts";
import { requireFact } from "./protected-io.ts";
import { unitShow } from "./native-facts.ts";
import { SubprocessCommander, type CommandResult } from "./subprocess.ts";
export type NativeCommand = (
  argv: readonly string[],
  timeoutMs?: number,
  limit?: number,
) => Promise<string>;
/** Exposes fixed failure facts only; stdout and unstructured stderr stay private. */
export class NativeCommandFailure extends Error {
  readonly diagnostic: {
    operation: string;
    status: number | null;
    timedOut: boolean;
    uncertain: boolean;
    outputTruncated: boolean;
    helperCode: string | null;
  };
  constructor(operation: string, result: CommandResult) {
    super("native_command_unknown");
    const code = result.stderr.trim();
    this.diagnostic = {
      operation: /^[a-z-]{1,40}$/.test(operation) ? operation : "unknown",
      status: result.status,
      timedOut: result.timedOut,
      uncertain: result.uncertain,
      outputTruncated: result.outputTruncated,
      helperCode: /^[a-z_]{1,80}$/.test(code) ? code : null,
    };
  }
}
export function command(environment: Record<string, string>): NativeCommand {
  return async (argv, timeoutMs = 3000, limit = 1048576) => {
    requireFact(
      typeof argv[0] === "string" && argv[0].startsWith("/"),
      "fixed_executable_required",
    );
    const result = await new SubprocessCommander({
      binary: argv[0],
      environment,
      captureLimit: limit,
    }).run(argv.slice(1), timeoutMs);
    if (!result.ok) throw new NativeCommandFailure(basename(argv[0]), result);
    return result.stdout.trim();
  };
}
export function unitName(value: string) {
  requireFact(/^openbot-command-[a-f0-9]{32}\.service$/.test(value), "invalid_unit_name");
  return value;
}
export async function showUnit(unit: string, environment: Record<string, string>) {
  const result = await new SubprocessCommander({
    binary: "/usr/bin/systemctl",
    environment,
    captureLimit: 65536,
  }).run(["show", unitName(unit), "--all", "--no-pager", "--property=" + unitShow.join(",")], 3000);
  const facts: Record<string, string> = {};
  for (const line of result.stdout.trim().split("\n")) {
    const at = line.indexOf("=");
    if (at < 0) continue;
    const key = line.slice(0, at);
    requireFact(!Object.hasOwn(facts, key), "duplicate_unit_property");
    facts[key] = line.slice(at + 1);
  }
  requireFact(
    !result.uncertain && (result.ok || (result.status === 1 && facts.LoadState === "not-found")),
    "native_readback_unknown",
  );
  return facts;
}
export function durationUs(value: string) {
  if (value === "0") return 0;
  requireFact(typeof value === "string" && value.length <= 128, "invalid_systemd_duration");
  const units: Record<string, bigint> = {
    us: 1n,
    ms: 1000n,
    s: 1000000n,
    min: 60000000n,
    h: 3600000000n,
  };
  const compact = value.replaceAll(" ", ""),
    matches = [...compact.matchAll(/([0-9]+)(?:\.([0-9]{1,6}))?(us|ms|s|min|h)/g)];
  requireFact(
    matches.length > 0 && matches.map((v) => v[0]).join("") === compact,
    "invalid_systemd_duration",
  );
  let total = 0n;
  for (const m of matches) {
    const scale = units[m[3]!]!,
      fraction = m[2] ?? "",
      denominator = 10n ** BigInt(fraction.length),
      numerator = BigInt(fraction || "0") * scale;
    requireFact(numerator % denominator === 0n, "invalid_systemd_duration");
    total += BigInt(m[1]!) * scale + numerator / denominator;
  }
  const result = Number(total);
  requireFact(Number.isSafeInteger(result) && result >= 0, "invalid_systemd_duration");
  return result;
}
export async function stopHooks(unit: string, run: NativeCommand) {
  const service = "org.freedesktop.systemd1",
    found = strictCommandJson(
      Buffer.from(
        await run([
          "/usr/bin/busctl",
          "--json=short",
          "call",
          service,
          "/org/freedesktop/systemd1",
          service + ".Manager",
          "GetUnit",
          "s",
          unitName(unit),
        ]),
      ),
      32768,
    ) as { type?: unknown; data?: unknown };
  requireFact(
    found &&
      found.type === "o" &&
      Array.isArray(found.data) &&
      found.data.length === 1 &&
      typeof found.data[0] === "string" &&
      /^\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]+$/.test(found.data[0]),
    "unit_stop_object_changed",
  );
  const lines = (
    await run([
      "/usr/bin/busctl",
      "--json=short",
      "get-property",
      service,
      found.data[0],
      service + ".Service",
      "ExecStop",
      "ExecStopPost",
    ])
  ).split("\n");
  requireFact(
    lines.length === 2 &&
      lines.every((v) =>
        same(strictCommandJson(Buffer.from(v), 32768), { type: "a(sasbttttuii)", data: [] }),
      ),
    "native_stop_hooks_changed",
  );
  return { ExecStop: "", ExecStopPost: "" };
}
export function validateUnit(value: Record<string, string>, unit: string, runtimeMs: number) {
  unitName(unit);
  requireFact(
    Number.isSafeInteger(runtimeMs) && runtimeMs > 0 && runtimeMs <= 50000,
    "unqualified_runtime",
  );
  const exact = {
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
    ControlGroup: "/system.slice/" + unit,
    ActiveState: "active",
  };
  requireFact(
    Object.entries(exact).every(([k, v]) => value[k] === v),
    "unit_shape_changed",
  );
  requireFact(
    durationUs(value.RuntimeMaxUSec!) === runtimeMs * 1000 &&
      durationUs(value.RuntimeRandomizedExtraUSec!) === 0 &&
      durationUs(value.TimeoutStopUSec!) === 1000000 &&
      durationUs(value.CPUQuotaPerSecUSec!) === 1500000,
    "unit_resources_changed",
  );
  requireFact(/^[a-f0-9]{32}$/.test(value.InvocationID ?? ""), "unit_identity_missing");
  requireFact(
    /^[1-9][0-9]*$/.test(value.MainPID ?? "") && Number.isSafeInteger(Number(value.MainPID)),
    "native_pid_missing",
  );
  const active = Number(value.ActiveEnterTimestampMonotonic);
  requireFact(
    /^[1-9][0-9]*$/.test(value.ActiveEnterTimestampMonotonic ?? "") && Number.isSafeInteger(active),
    "unit_not_active",
  );
  return active;
}
export function cgroupMembers(group: string) {
  requireFact(
    /^\/sys\/fs\/cgroup\/system.slice\/openbot-command-[a-f0-9]{32}\.service$/.test(group),
    "invalid_cgroup_path",
  );
  if (!existsSync(group)) return [];
  const pending = [group],
    seen = new Set<number>(),
    result: number[] = [];
  let count = 0;
  while (pending.length) {
    const path = pending.pop()!;
    requireFact(++count <= 4096, "cgroup_tree_bound");
    try {
      requireFact(lstatSync(path).isDirectory(), "cgroup_path_changed");
      for (const item of readdirSync(path, { withFileTypes: true })) {
        requireFact(!item.isSymbolicLink(), "cgroup_alias");
        if (item.isDirectory()) pending.push(join(path, item.name));
      }
      for (const text of readKernelText(join(path, "cgroup.procs")).split(/\s+/).filter(Boolean)) {
        requireFact(
          /^[1-9][0-9]*$/.test(text) && Number.isSafeInteger(Number(text)),
          "invalid_cgroup_pid",
        );
        const pid = Number(text);
        if (seen.has(pid)) continue;
        seen.add(pid);
        try {
          const actual = readKernelText(`/proc/${pid}/cgroup`).trim(),
            expected = group.slice("/sys/fs/cgroup".length);
          requireFact(
            actual === `0::${expected}` || actual.startsWith(`0::${expected}/`),
            "runtime_escaped",
          );
          result.push(pid);
          requireFact(result.length <= 1536, "cgroup_pid_bound");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return result;
}
