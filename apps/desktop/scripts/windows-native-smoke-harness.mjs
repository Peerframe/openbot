/**
 * Portable helpers for the Windows native smoke / cold-start gate.
 * No Electron or Windows runtime required for the pure helpers under test.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { win32 } from "node:path";

export const COLD_START_ROUNDS = 10;

/** Historical install-gate checks that must remain present on the final receipt. */
export const BASE_SMOKE_CHECKS = Object.freeze([
  "postgresql",
  "migrations",
  "dpapi",
  "owner-login",
  "retained-data",
  "stop",
  "restart",
  "cleanup",
]);

export const STATE_FILE_NAME = "cold-start-state.json";
export const LIVE_PROCESSES_FILE_NAME = "harness-live-processes.json";
export const STATE_SCHEMA_VERSION = 2;
export const SMOKE_ROW_VALUE = "retained across cold start";

/**
 * @typedef {{
 *   pid: number,
 *   startTimeUtc: string | null,
 *   executablePath: string | null,
 * }} ProcessIdentity
 */

/**
 * @param {unknown} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 2_147_483_647) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? /** @type {{ code?: string }} */ (error).code
        : undefined;
    // Only ESRCH means the PID is gone. EPERM (and similar) means the process
    // exists but we lack permission — never treat that as "dead".
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

/**
 * @param {string | null | undefined} path
 */
function normalizeExecutablePath(path) {
  if (path == null || path === "") return null;
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/**
 * @param {ProcessIdentity | null | undefined} a
 * @param {ProcessIdentity | null | undefined} b
 */
export function processIdentitiesEqual(a, b) {
  if (a == null || b == null) return false;
  if (!Number.isInteger(a.pid) || !Number.isInteger(b.pid) || a.pid !== b.pid) return false;
  const aStart = a.startTimeUtc ?? null;
  const bStart = b.startTimeUtc ?? null;
  const aPath = normalizeExecutablePath(a.executablePath);
  const bPath = normalizeExecutablePath(b.executablePath);
  // Full identity requires matching start time and path when both sides recorded them.
  if (aStart != null && bStart != null && aStart !== bStart) return false;
  if (aPath != null && bPath != null && aPath !== bPath) return false;
  // If either side lacks start/path, PIDs alone are insufficient to claim equality
  // for kill decisions — callers must not stop on PID-only matches.
  if (aStart == null || bStart == null || aPath == null || bPath == null) return false;
  return aStart === bStart && aPath === bPath;
}

/**
 * @param {unknown} value
 * @returns {value is ProcessIdentity}
 */
export function isProcessIdentity(value) {
  if (!value || typeof value !== "object") return false;
  const identity = /** @type {Record<string, unknown>} */ (value);
  return (
    Number.isInteger(identity.pid) &&
    /** @type {number} */ (identity.pid) > 0 &&
    /** @type {number} */ (identity.pid) <= 2_147_483_647 &&
    (identity.startTimeUtc === null || typeof identity.startTimeUtc === "string") &&
    (identity.executablePath === null || typeof identity.executablePath === "string")
  );
}

/**
 * @param {Partial<ProcessIdentity> & { pid: number }} fields
 * @returns {ProcessIdentity}
 */
export function createProcessIdentity(fields) {
  const identity = {
    pid: fields.pid,
    startTimeUtc: fields.startTimeUtc ?? null,
    executablePath: fields.executablePath ?? null,
  };
  if (!isProcessIdentity(identity)) {
    throw new Error("Process identity is incomplete.");
  }
  return identity;
}

/**
 * Parse Linux /proc/<pid>/stat starttime (field 22; clock ticks after boot).
 * @param {string} statContents
 * @returns {string | null}
 */
export function readLinuxProcStartTimeToken(statContents) {
  const rparen = statContents.lastIndexOf(")");
  if (rparen < 0) return null;
  const rest = statContents
    .slice(rparen + 2)
    .trim()
    .split(/\s+/u);
  const starttime = rest[19];
  if (!starttime || !/^\d+$/u.test(starttime)) return null;
  return `linux-ticks:${starttime}`;
}

/**
 * Observe OS process identity for pid.
 * Linux uses /proc; Darwin uses ps lstart/comm; Windows uses PowerShell.
 * Unsupported platforms return null (fail closed for callers) — never an incomplete
 * identity that looks like a successful observation.
 * @param {number} pid
 * @returns {ProcessIdentity | null}
 */
export function observeProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 2_147_483_647) return null;
  if (process.platform === "linux") {
    try {
      const startTimeUtc = readLinuxProcStartTimeToken(readFileSync(`/proc/${pid}/stat`, "utf8"));
      let executablePath = null;
      try {
        executablePath = readlinkSync(`/proc/${pid}/exe`);
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? /** @type {{ code?: string }} */ (error).code
            : undefined;
        if (code === "ESRCH") return null;
        // EACCES/EPERM on exe symlink: keep path null; start time still usable with path hint.
      }
      if (startTimeUtc == null) return null;
      return createProcessIdentity({ pid, startTimeUtc, executablePath });
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? /** @type {{ code?: string }} */ (error).code
          : undefined;
      if (code === "ESRCH" || code === "ENOENT") return null;
      throw error;
    }
  }
  if (process.platform === "darwin") {
    try {
      const lstart = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        timeout: 5_000,
      }).trim();
      if (!lstart) return null;
      const argsLine = execFileSync("ps", ["-ww", "-p", String(pid), "-o", "comm="], {
        encoding: "utf8",
        timeout: 5_000,
      }).trim();
      if (!argsLine) return null;
      // Preserve spaces in the executable path; argv splitting is not an identity.
      const executablePath = argsLine;
      if (executablePath == null || executablePath === "") return null;
      return createProcessIdentity({
        pid,
        // Opaque locale-safe token — compare equality only, do not parse as Date.
        startTimeUtc: `darwin-lstart:${lstart}`,
        executablePath,
      });
    } catch (error) {
      const status =
        error && typeof error === "object" && "status" in error
          ? /** @type {{ status?: number }} */ (error).status
          : undefined;
      const message = error instanceof Error ? error.message : String(error);
      // ps exits non-zero when the PID is gone; treat as unobservable.
      if (status === 1 || /no such process|not found/iu.test(message)) {
        return null;
      }
      // Other observation failures: return null so callers fail closed.
      return null;
    }
  }
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!systemRoot || !/^[A-Za-z]:\\[^\0\r\n]*$/u.test(systemRoot)) {
      throw new Error("Windows system directory is unavailable.");
    }
    // Match the existing Windows ACL launcher: no cmdlet autoload or stdin protocol.
    const script = `
$ErrorActionPreference = 'Stop'
$p = [Diagnostics.Process]::GetProcessById(${pid})
try {
  $null = $p.Handle
  [Console]::Out.WriteLine($p.Id)
  [Console]::Out.WriteLine($p.StartTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture))
  [Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p.MainModule.FileName)))
} finally { $p.Dispose() }
`;
    try {
      const raw = execFileSync(
        win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          shell: false,
          timeout: 15_000,
          maxBuffer: 4096,
          stdio: ["ignore", "pipe", "pipe"],
          env: { SystemRoot: systemRoot, WINDIR: systemRoot },
        },
      ).trim();
      const fields = raw.split(/\r?\n/u);
      if (fields.length !== 3 || Number(fields[0]) !== pid || !fields[1] || !fields[2]) {
        throw new Error("Windows process observer returned incomplete identity fields.");
      }
      return createProcessIdentity({
        pid,
        startTimeUtc: fields[1],
        executablePath: Buffer.from(fields[2], "base64").toString("utf8"),
      });
    } catch (error) {
      if (!isProcessAlive(pid)) return null;
      throw error;
    }
  }
  // Unknown platform: cannot observe — fail closed (null), do not pretend success.
  return null;
}

/**
 * @param {ProcessIdentity | null | undefined} previous
 * @param {ProcessIdentity} current
 */
export function assertNewProcessIdentity(previous, current) {
  if (!isProcessIdentity(current)) {
    throw new Error("Current process identity is missing.");
  }
  if (previous == null) return;
  if (!isProcessIdentity(previous)) {
    throw new Error("Previous process identity is invalid.");
  }
  if (processIdentitiesEqual(previous, current)) {
    throw new Error(`Expected a new process identity, reused PID ${current.pid}.`);
  }
  // PID-only equality with differing start/path is allowed (PID reuse = new process).
  // PID-only equality with missing start/path is rejected as inconclusive reuse hazard.
  if (
    previous.pid === current.pid &&
    (previous.startTimeUtc == null ||
      current.startTimeUtc == null ||
      previous.executablePath == null ||
      current.executablePath == null)
  ) {
    throw new Error(
      `Expected a new process identity, inconclusive PID ${current.pid} without full start identity.`,
    );
  }
}

/**
 * @param {{
 *   electron?: ProcessIdentity | null,
 *   postgres?: ProcessIdentity | null,
 *   server?: ProcessIdentity | null,
 * }} previous
 * @param {{ observe?: (pid: number) => ProcessIdentity | null }} [hooks]
 */
export function assertPreviousChildrenEnded(previous, hooks = {}) {
  const observe = hooks.observe ?? observeProcessIdentity;
  const lingering = [];
  for (const [label, identity] of [
    ["electron", previous.electron],
    ["postgres", previous.postgres],
    ["server", previous.server],
  ]) {
    if (identity == null) continue;
    if (!isProcessIdentity(identity)) {
      lingering.push(`${label}:invalid`);
      continue;
    }
    // Not alive (ESRCH) → ended / OK.
    if (!isProcessAlive(identity.pid)) continue;

    // Alive + incomplete recorded identity → lingering (fail closed).
    if (identity.startTimeUtc == null || identity.executablePath == null) {
      lingering.push(`${label}:${identity.pid}`);
      continue;
    }

    let current = null;
    try {
      current = observe(identity.pid);
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? /** @type {{ code?: string }} */ (error).code
          : undefined;
      if (code === "EPERM") {
        // Exists but unobservable — treat as lingering to fail closed.
        lingering.push(`${label}:${identity.pid}`);
        continue;
      }
      throw error;
    }

    // Alive + observe null / incomplete observed identity → lingering.
    // Alive + full identities equal → lingering.
    // Alive + full identities clearly unequal (PID reuse) → OK.
    if (
      current == null ||
      current.startTimeUtc == null ||
      current.executablePath == null ||
      processIdentitiesEqual(identity, current)
    ) {
      lingering.push(`${label}:${identity.pid}`);
    }
  }
  if (lingering.length > 0) {
    throw new Error(`Previous harness children still alive: ${lingering.join(", ")}`);
  }
}

/**
 * @param {string} contents
 * @returns {number | null}
 */
export function readPostmasterPid(contents) {
  const first = contents.trim().split(/\r?\n/u)[0];
  const pid = Number(first);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) return null;
  return pid;
}

/**
 * PostgreSQL postmaster.pid line 2 is start time in seconds since the Epoch.
 * @param {string} contents
 * @returns {number | null}
 */
export function readPostmasterStartTimeSeconds(contents) {
  const line = contents.trim().split(/\r?\n/u)[2];
  const started = Number(line);
  if (!Number.isSafeInteger(started) || started <= 0) return null;
  return started;
}

/**
 * @param {number} completedRounds
 */
export function coldStartCheckName(completedRounds) {
  if (!Number.isInteger(completedRounds) || completedRounds < 0) {
    throw new Error("cold-start round count is invalid.");
  }
  return `cold-start-${completedRounds}`;
}

/**
 * @param {{ coldStarts: number, extraChecks?: string[] }} input
 */
export function buildFinalSmokeChecks(input) {
  const coldStarts = input.coldStarts;
  if (!Number.isInteger(coldStarts) || coldStarts < 0) {
    throw new Error("coldStarts must be a non-negative integer.");
  }
  const checks = [...BASE_SMOKE_CHECKS];
  if (coldStarts > 0) checks.push(coldStartCheckName(coldStarts));
  for (const check of input.extraChecks ?? []) {
    if (!checks.includes(check)) checks.push(check);
  }
  return checks;
}

/**
 * SHA-256 hex digest of bootstrap ciphertext bytes (never log raw ciphertext).
 * @param {string} ciphertext
 */
export function digestCiphertext(ciphertext) {
  if (typeof ciphertext !== "string" || ciphertext.length === 0) {
    throw new Error("ciphertext digest requires non-empty ciphertext.");
  }
  return createHash("sha256").update(ciphertext, "utf8").digest("hex");
}

/**
 * Safe receipt fields for one smoke round (no passwords, no raw ciphertext).
 * @param {{
 *   mode: "bootstrap" | "cold-start",
 *   platform: string,
 *   arch: string,
 *   loginCount: number,
 *   ciphertextDigest: string,
 *   electron: ProcessIdentity,
 *   postgres: ProcessIdentity | null,
 *   server: ProcessIdentity | null,
 *   coldStartsCompleted?: number,
 *   checks: string[],
 * }} input
 */
export function buildRoundSmokeReceipt(input) {
  if (!/^[0-9a-f]{64}$/u.test(input.ciphertextDigest)) {
    throw new Error("ciphertextDigest must be a sha256 hex digest.");
  }
  if (!Number.isInteger(input.loginCount) || input.loginCount < 0) {
    throw new Error("loginCount is invalid.");
  }
  if (!isProcessIdentity(input.electron)) {
    throw new Error("electron identity is required on the receipt.");
  }
  /** @type {Record<string, unknown>} */
  const receipt = {
    schemaVersion: 1,
    platform: input.platform,
    arch: input.arch,
    mode: input.mode,
    loginCount: input.loginCount,
    ciphertextDigest: input.ciphertextDigest,
    electron: input.electron,
    postgres: input.postgres,
    server: input.server,
    checks: input.checks,
  };
  if (input.mode === "cold-start") {
    receipt.coldStartsCompleted = input.coldStartsCompleted;
  }
  return receipt;
}

/**
 * @param {{ coldStarts: number, platform?: string, arch?: string }} input
 */
export function buildFinalSmokeReceipt(input) {
  const coldStarts = input.coldStarts;
  if (coldStarts !== COLD_START_ROUNDS) {
    throw new Error(`Final receipt requires exactly ${COLD_START_ROUNDS} cold starts.`);
  }
  return {
    schemaVersion: 1,
    platform: input.platform ?? "win32",
    arch: input.arch ?? "x64",
    coldStarts,
    checks: buildFinalSmokeChecks({ coldStarts }),
  };
}

/**
 * @param {unknown} value
 * @returns {value is {
 *   schemaVersion: number,
 *   smokeMarker: string,
 *   encryptedBootstrap: string,
 *   electron: ProcessIdentity | null,
 *   postgres: ProcessIdentity | null,
 *   server: ProcessIdentity | null,
 *   coldStartsCompleted: number,
 *   bootstrapComplete: boolean,
 * }}
 */
export function isColdStartState(value) {
  if (!value || typeof value !== "object") return false;
  const state = /** @type {Record<string, unknown>} */ (value);
  const identityOrNull = (entry) => entry === null || isProcessIdentity(entry);
  return (
    state.schemaVersion === STATE_SCHEMA_VERSION &&
    typeof state.smokeMarker === "string" &&
    typeof state.encryptedBootstrap === "string" &&
    state.encryptedBootstrap.length > 0 &&
    identityOrNull(state.electron) &&
    identityOrNull(state.postgres) &&
    identityOrNull(state.server) &&
    Number.isInteger(state.coldStartsCompleted) &&
    typeof state.bootstrapComplete === "boolean"
  );
}

/**
 * @param {Partial<{
 *   smokeMarker: string,
 *   encryptedBootstrap: string,
 *   electron: ProcessIdentity | null,
 *   postgres: ProcessIdentity | null,
 *   server: ProcessIdentity | null,
 *   coldStartsCompleted: number,
 *   bootstrapComplete: boolean,
 * }>} fields
 */
export function createColdStartState(fields) {
  const state = {
    schemaVersion: STATE_SCHEMA_VERSION,
    smokeMarker: fields.smokeMarker ?? SMOKE_ROW_VALUE,
    encryptedBootstrap: fields.encryptedBootstrap ?? "",
    electron: fields.electron ?? null,
    postgres: fields.postgres ?? null,
    server: fields.server ?? null,
    coldStartsCompleted: fields.coldStartsCompleted ?? 0,
    bootstrapComplete: fields.bootstrapComplete ?? false,
  };
  if (!isColdStartState(state) || state.encryptedBootstrap.length === 0) {
    throw new Error("Refusing to create an incomplete cold-start state.");
  }
  return state;
}

/**
 * @param {unknown} value
 * @returns {value is {
 *   electron: ProcessIdentity | null,
 *   postgres: ProcessIdentity | null,
 *   server: ProcessIdentity | null,
 * }}
 */
export function isLiveHarnessProcesses(value) {
  if (!value || typeof value !== "object") return false;
  const live = /** @type {Record<string, unknown>} */ (value);
  const identityOrNull = (entry) => entry === null || isProcessIdentity(entry);
  return (
    identityOrNull(live.electron) && identityOrNull(live.postgres) && identityOrNull(live.server)
  );
}

/**
 * @param {Partial<{
 *   electron: ProcessIdentity | null,
 *   postgres: ProcessIdentity | null,
 *   server: ProcessIdentity | null,
 * }>} fields
 */
export function createLiveHarnessProcesses(fields) {
  const live = {
    electron: fields.electron ?? null,
    postgres: fields.postgres ?? null,
    server: fields.server ?? null,
  };
  if (!isLiveHarnessProcesses(live)) {
    throw new Error("Refusing to create incomplete live harness process records.");
  }
  return live;
}
