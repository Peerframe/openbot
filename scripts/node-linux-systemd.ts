import {
  type BoundedCommandRequest,
  type BoundedCommandRunner,
  isSuccessfulCommandResult,
  runBoundedCommand,
  type SuccessfulCommandResult,
} from "./node-linux-provenance.ts";

export interface LinuxSystemdServiceAdapterOptions {
  readonly commandRunner?: BoundedCommandRunner | undefined;
}

export interface LinuxSystemdServiceAdapter {
  readonly isActive: (signal?: AbortSignal) => Promise<boolean>;
  readonly restartSelected: (signal?: AbortSignal) => Promise<void>;
}

export const LINUX_SYSTEMD_SERVICE = Object.freeze({
  executable: "/usr/bin/systemctl",
  unit: "openbot-node.service",
  upstreamVersion: "255",
});

const maximumOutputBytes = 4 * 1024;
const commandTimeoutMs = 15_000;

/**
 * System-profile adapter only. User services require a separately reviewed login-session boundary
 * so a privileged installer cannot synthesize a D-Bus or Secret Service environment.
 */
export function createLinuxSystemdServiceAdapter(
  options: LinuxSystemdServiceAdapterOptions = {},
): LinuxSystemdServiceAdapter {
  if (!isRecord(options)) throw new Error("Linux systemd adapter options are malformed.");
  const runner = options.commandRunner ?? runBoundedCommand;
  if (typeof runner !== "function") throw new Error("Linux systemd adapter requires a runner.");
  let versionVerified = false;

  const environment: Readonly<Record<string, string>> = {
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    SYSTEMD_COLORS: "0",
    SYSTEMD_PAGER: "cat",
  };

  const ensureVersion = async (signal: AbortSignal | undefined): Promise<void> => {
    if (versionVerified) return;
    const result = await runChecked(runner, {
      executable: LINUX_SYSTEMD_SERVICE.executable,
      arguments: ["--version"],
      environment,
      maximumBytes: maximumOutputBytes,
      signal,
      timeoutMs: 5_000,
    });
    const firstLine = result.stdout.toString("utf8").split(/\r?\n/u)[0];
    if (!/^systemd 255 \(255\.4-1ubuntu8\.[0-9]+\)$/u.test(`${firstLine}`)) {
      throw new Error("Linux systemd version is outside the reviewed Ubuntu 24.04 line.");
    }
    versionVerified = true;
  };

  return {
    async isActive(signal?: AbortSignal): Promise<boolean> {
      await ensureVersion(signal);
      const result = await runChecked(runner, {
        executable: LINUX_SYSTEMD_SERVICE.executable,
        arguments: [
          "--no-pager",
          "show",
          "--property=LoadState",
          "--property=ActiveState",
          LINUX_SYSTEMD_SERVICE.unit,
        ],
        environment,
        maximumBytes: maximumOutputBytes,
        signal,
        timeoutMs: commandTimeoutMs,
      });
      return parseSystemdState(result.stdout);
    },

    async restartSelected(signal?: AbortSignal): Promise<void> {
      await ensureVersion(signal);
      await runChecked(
        runner,
        {
          executable: LINUX_SYSTEMD_SERVICE.executable,
          arguments: ["--no-pager", "restart", LINUX_SYSTEMD_SERVICE.unit],
          environment,
          maximumBytes: maximumOutputBytes,
          signal,
          timeoutMs: commandTimeoutMs,
        },
        true,
      );
    },
  };
}

export function parseSystemdState(output: unknown): boolean {
  if (!Buffer.isBuffer(output) || output.length < 1 || !output.toString("utf8").endsWith("\n")) {
    throw new Error("Linux systemd state output is malformed.");
  }
  const properties = new Map<string, string>();
  for (const line of output.toString("utf8").slice(0, -1).split("\n")) {
    const match = /^(LoadState|ActiveState)=([a-z-]{1,32})$/u.exec(line);
    const key = match?.[1];
    const value = match?.[2];
    if (key === undefined || value === undefined || properties.has(key)) {
      throw new Error("Linux systemd state output is malformed.");
    }
    properties.set(key, value);
  }
  if (properties.size !== 2 || properties.get("LoadState") !== "loaded") {
    throw new Error("Linux systemd service is not loaded exactly once.");
  }
  const activeState = properties.get("ActiveState");
  if (activeState === "active") return true;
  if (activeState === "inactive") return false;
  throw new Error("Linux systemd service is failed or in a transitional state.");
}

async function runChecked(
  runner: BoundedCommandRunner,
  request: BoundedCommandRequest,
  requireEmptyOutput = false,
): Promise<SuccessfulCommandResult> {
  let result: unknown;
  try {
    result = await runner(request);
  } catch {
    throw new Error("Linux systemd command failed.");
  }
  if (
    !isSuccessfulCommandResult(result) ||
    result.stdout.length > request.maximumBytes ||
    result.stderr.length > request.maximumBytes ||
    result.stderr.length !== 0 ||
    (requireEmptyOutput && result.stdout.length !== 0)
  ) {
    throw new Error("Linux systemd command failed.");
  }
  return result;
}

/** Generic so that narrowing a typed options object keeps its declared optional members. */
function isRecord<T>(value: T): value is T & Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
