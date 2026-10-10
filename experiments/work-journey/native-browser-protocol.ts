/** Public fixed native browser diagnostics; never carries stderr, commands, keys or cookies. */
import assert from "node:assert/strict";
/** Fixed public diagnostics; raw root errors, subprocess streams and configuration remain private. */
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
  for (const name of ["nativeDeadlineSeconds", "existingContainerCount"]) {
    const n = item[name] ?? outer[name];
    if (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 65535) result[name] = n;
  }
  for (const name of ["failureCode", "cleanupFailureCode"])
    if (typeof item[name] === "string" && codes.includes(item[name])) result[name] = item[name];
  return { nativeBrowserFailure: result };
}
