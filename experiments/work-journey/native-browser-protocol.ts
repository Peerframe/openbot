/** Public fixed native browser diagnostics; never carries stderr, commands, keys or cookies. */
import assert from "node:assert/strict";
/** Fixed public diagnostics; raw root errors, subprocess streams and configuration remain private. */
export const nativeBrowserStages = [
  "entry",
  "packet",
  "allocate",
  "unit",
  "daemon",
  "images",
  "networks",
  "canaries",
  "proxy",
  "browser",
  "tls",
  "product",
  "revoke",
  "expiry",
  "cleanup",
] as const;
export function nativeBrowserStage(log: string) {
  if (Buffer.byteLength(log) > 2 * 1024 * 1024) return undefined;
  return log
    .split("\n")
    .map((line) => /^native-browser-stage:([a-z]+)$/.exec(line)?.[1])
    .filter((value) => nativeBrowserStages.some((stage) => stage === value))
    .at(-1);
}
const launcherChecks = [
  "entry",
  "ancestors",
  "packet",
  "plan",
  "launcher-pin",
  "program-pin",
  "node-pin",
  "fresh-root",
  "log",
  "child",
  "relay",
  "product",
  "finish",
  "expiry",
];
const startupCodes = [
  "assertion",
  "unsafe_path",
  "unsafe_directory",
  "unsafe_file",
  "oversized_file",
  "changed_file",
  "ENOENT",
  "EACCES",
  "EPERM",
  "EEXIST",
  "unknown",
];
export function nativeBrowserStartupError(error: unknown) {
  const item = error instanceof Error ? error : undefined;
  const code = item && "code" in item ? item.code : undefined;
  const errorCode =
    code === "ERR_ASSERTION"
      ? "assertion"
      : ([code, item?.message].find(
          (value) => typeof value === "string" && startupCodes.includes(value),
        ) ?? "unknown");
  const line = item?.stack?.match(/browser-launcher\.cjs:(\d+):\d+/)?.[1];
  return { errorCode, ...(line ? { launcherLine: Number(line) } : {}) };
}

export function nativeBrowserFailure(phase: string, value: unknown) {
  const phases = ["readiness", "product", "finish", "expiry"];
  assert(phases.includes(phase), "Native failure phase changed");
  const object = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const outer = object(value),
    item = object(outer.nativeBrowserFailure),
    flags = object(item.nativeFlags ?? value);
  const codes = [
    "verified_tls_tunnel_missing",
    "tunnel_revocation_missing",
    "tunnel_revocation_failed",
    "native_timeout_changed",
    "native_cgroup_not_empty",
    "native_host_state_changed",
    "image_name_missing",
    "image_digest_missing",
    "native_acceptance_failed",
    "fixture_failed",
  ];
  const result: Record<string, unknown> = {
    phase: typeof item.phase === "string" && phases.includes(item.phase) ? item.phase : phase,
    code: typeof item.code === "string" && codes.includes(item.code) ? item.code : "fixture_failed",
    nativeFlags: Object.fromEntries(
      [
        "accepted",
        "actualRunsc",
        "actualSquid",
        "actualProductJourney",
        "originalNativeExpiryVerified",
        "failedOriginalUnitClosed",
        "productionUnchanged",
        "ownedRuntimeRemoved",
      ]
        .filter((k) => typeof flags[k] === "boolean")
        .map((k) => [k, flags[k]]),
    ),
  };
  const startup = { ...outer, ...item };
  if (typeof startup.launcherCheck === "string" && launcherChecks.includes(startup.launcherCheck))
    result.launcherCheck = startup.launcherCheck;
  if (typeof startup.errorCode === "string" && startupCodes.includes(startup.errorCode))
    result.errorCode = startup.errorCode;
  if (
    typeof startup.launcherLine === "number" &&
    Number.isSafeInteger(startup.launcherLine) &&
    startup.launcherLine > 0 &&
    startup.launcherLine <= 1000000
  )
    result.launcherLine = startup.launcherLine;
  const stage = item.nativeStage ?? outer.nativeStage;
  if (nativeBrowserStages.some((value) => value === stage)) result.nativeStage = stage;
  for (const name of ["nativeDeadlineSeconds", "existingContainerCount"]) {
    const n = item[name] ?? outer[name];
    if (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 65535) result[name] = n;
  }
  for (const name of ["failureCode", "cleanupFailureCode"])
    if (typeof item[name] === "string" && codes.includes(item[name])) result[name] = item[name];
  return { nativeBrowserFailure: result };
}
