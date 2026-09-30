import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { win32 } from "node:path";

export type ProcessIdentity = {
  readonly pid: number;
  readonly startTimeUtc: string | null;
  readonly executablePath: string | null;
};
export type ProcessIdentityFields = {
  readonly pid: number;
  readonly startTimeUtc?: string | null | undefined;
  readonly executablePath?: string | null | undefined;
};
export type ProcessObserver = (pid: number) => ProcessIdentity | null;
export type ProcessEndHooks = { readonly observe?: ProcessObserver };

const MAX_PID = 2_147_483_647;
const isValidPid = (pid: unknown): pid is number =>
  typeof pid === "number" && Number.isInteger(pid) && pid > 0 && pid <= MAX_PID;
const errorCode = (error: unknown): unknown =>
  error !== null && typeof error === "object" && "code" in error ? error.code : undefined;

export function isProcessAlive(pid: unknown): boolean {
  if (!isValidPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = errorCode(error);
    // Only ESRCH proves exit. EPERM means the process exists but is inaccessible.
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function normalizeExecutablePath(path: string | null | undefined): string | null {
  if (path == null || path === "") return null;
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export function processIdentitiesEqual(
  a: ProcessIdentityFields | null | undefined,
  b: ProcessIdentityFields | null | undefined,
): boolean {
  if (a == null || b == null) return false;
  if (!Number.isInteger(a.pid) || !Number.isInteger(b.pid) || a.pid !== b.pid) return false;
  const aStart = a.startTimeUtc ?? null;
  const bStart = b.startTimeUtc ?? null;
  const aPath = normalizeExecutablePath(a.executablePath);
  const bPath = normalizeExecutablePath(b.executablePath);
  // PIDs alone cannot authorize a kill or establish a process lifetime.
  if (!aStart || !bStart || aPath == null || bPath == null) return false;
  return aStart === bStart && aPath === bPath;
}

export function isProcessIdentity(value: unknown): value is ProcessIdentity {
  if (value === null || typeof value !== "object") return false;
  const { pid, startTimeUtc, executablePath } = value as Record<string, unknown>;
  return (
    isValidPid(pid) &&
    (startTimeUtc === null || typeof startTimeUtc === "string") &&
    (executablePath === null || typeof executablePath === "string")
  );
}

export function createProcessIdentity(fields: ProcessIdentityFields): ProcessIdentity {
  const identity = {
    pid: fields.pid,
    startTimeUtc: fields.startTimeUtc ?? null,
    executablePath: fields.executablePath ?? null,
  };
  if (!isProcessIdentity(identity)) throw new Error("Process identity is incomplete.");
  return identity;
}

/** Linux /proc/<pid>/stat field 22, after the final ')' of a possibly spaced comm. */
export function readLinuxProcStartTimeToken(statContents: string): string | null {
  const rparen = statContents.lastIndexOf(")");
  if (rparen < 0) return null;
  const starttime = statContents
    .slice(rparen + 2)
    .trim()
    .split(/\s+/u)[19];
  if (!starttime || !/^\d+$/u.test(starttime)) return null;
  return `linux-ticks:${starttime}`;
}

function observeLinux(pid: number): ProcessIdentity | null {
  try {
    const startTimeUtc = readLinuxProcStartTimeToken(readFileSync(`/proc/${pid}/stat`, "utf8"));
    let executablePath: string | null = null;
    try {
      executablePath = readlinkSync(`/proc/${pid}/exe`);
    } catch (error) {
      if (errorCode(error) === "ESRCH") return null;
      // An inaccessible exe remains incomplete; callers must fail closed.
    }
    if (startTimeUtc == null) return null;
    return createProcessIdentity({ pid, startTimeUtc, executablePath });
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH" || code === "ENOENT") return null;
    throw error;
  }
}

function observeDarwin(pid: number): ProcessIdentity | null {
  try {
    const options = { encoding: "utf8", timeout: 5_000 } as const;
    const lstart = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], options).trim();
    if (!lstart) return null;
    // Preserve spaces in comm. lstart is an opaque equality token, never a parsed Date.
    const executablePath = execFileSync(
      "ps",
      ["-ww", "-p", String(pid), "-o", "comm="],
      options,
    ).trim();
    if (!executablePath) return null;
    return createProcessIdentity({ pid, startTimeUtc: `darwin-lstart:${lstart}`, executablePath });
  } catch {
    return null;
  }
}

const windowsObserverScript = (pid: number): string => `
$ErrorActionPreference = 'Stop'
$p = [Diagnostics.Process]::GetProcessById(${pid})
try {
  $null = $p.Handle
  [Console]::Out.WriteLine($p.Id)
  [Console]::Out.WriteLine($p.StartTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture))
  [Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p.MainModule.FileName)))
} finally { $p.Dispose() }
`;

function observeWindows(pid: number): ProcessIdentity | null {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !/^[A-Za-z]:\\[^\0\r\n]*$/u.test(systemRoot)) {
    throw new Error("Windows system directory is unavailable.");
  }
  try {
    // Keep the native observer boundary: absolute WinPS, no cmdlet autoload/stdin protocol.
    const raw = execFileSync(
      win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(windowsObserverScript(pid), "utf16le").toString("base64"),
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
    const [idField, startField, pathField] = fields;
    if (fields.length !== 3 || Number(idField) !== pid || !startField || !pathField) {
      throw new Error("Windows process observer returned incomplete identity fields.");
    }
    return createProcessIdentity({
      pid,
      startTimeUtc: startField,
      executablePath: Buffer.from(pathField, "base64").toString("utf8"),
    });
  } catch (error) {
    if (!isProcessAlive(pid)) return null;
    throw error;
  }
}

export function observeProcessIdentity(pid: number): ProcessIdentity | null {
  if (!isValidPid(pid)) return null;
  if (process.platform === "linux") return observeLinux(pid);
  if (process.platform === "darwin") return observeDarwin(pid);
  if (process.platform === "win32") return observeWindows(pid);
  return null;
}

/** Only exit or a fully observed different lifetime proves that the previous one ended. */
export function assertPreviousProcessEnded(previous: unknown, hooks: ProcessEndHooks = {}): void {
  if (previous == null) return;
  if (!isProcessIdentity(previous)) throw new Error("Previous process identity is invalid.");
  const { pid } = previous;
  if (!isProcessAlive(pid)) return;
  if (!previous.startTimeUtc || !previous.executablePath) {
    throw new Error(`Previous process ${pid} is alive without a full identity.`);
  }
  let current: unknown;
  try {
    current = (hooks.observe ?? observeProcessIdentity)(pid);
  } catch (error) {
    if (errorCode(error) === "EPERM") {
      throw new Error(`Previous process ${pid} is still alive.`, { cause: error });
    }
    throw error;
  }
  if (
    !isProcessIdentity(current) ||
    !current.startTimeUtc ||
    !current.executablePath ||
    current.pid !== pid ||
    processIdentitiesEqual(previous, current)
  ) {
    throw new Error(`Previous process ${pid} is still alive.`);
  }
}
