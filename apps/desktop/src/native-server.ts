import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import postgresClient from "postgres";
import { startDarwinPostgres, type DarwinPostgresProcess } from "./darwin-postgres.js";
import { LocalSessionRecovery } from "./local-session-recovery.js";
import { RestrictedJsonFile } from "./restricted-json-file.js";
import type { NativeServerState } from "./runtime-contract.js";
import {
  verifyWindowsPrivateDirectory,
  windowsNativeEnvironment,
} from "./windows-native-security.js";
import { startWindowsPostgres, type WindowsPostgresProcess } from "./windows-postgres.js";

const startupDiagnostics = channel("openbot.desktop.native-startup");

class NativeCredentialError extends Error {}

interface BootstrapSecrets {
  databasePassword: string;
  ownerPassword: string;
  modelKey: string;
}
export interface ManagedServerProcess {
  stop(): Promise<void>;
  isAlive(): boolean;
}
export interface NativeServerOptions {
  runtimeRoot: string;
  dataRoot: string;
  platform: string;
  localServiceSupported?: boolean;
  encrypt(value: string): string | Promise<string>;
  decrypt(value: string): string | Promise<string>;
  launchServer(env: Record<string, string>): Promise<ManagedServerProcess>;
  connect(serverUrl: string, ownerPassword: string): Promise<void>;
  authenticate(serverUrl: string, ownerPassword: string): Promise<void>;
}

/** Owns only this app's cluster and child process. Renderer input cannot name paths or commands. */
export class NativeServerController {
  readonly #options: NativeServerOptions;
  #state: NativeServerState = { status: "idle" };
  #pending: Promise<NativeServerState> | undefined;
  #darwinPostgres: DarwinPostgresProcess | undefined;
  #windowsPostgres: WindowsPostgresProcess | undefined;
  #server: ManagedServerProcess | undefined;
  #stopping = false;
  #ownedUrl: string | undefined;
  readonly #sessionRecovery = new LocalSessionRecovery();

  constructor(options: NativeServerOptions) {
    this.#options = options;
  }
  getState(): NativeServerState {
    if (this.#state.status === "ready" && !this.#server?.isAlive()) {
      this.#state = { status: "failed", code: "service_stopped" };
    }
    if (
      this.#state.status === "idle" &&
      existsSync(join(this.#options.dataRoot, "bootstrap.json")) &&
      existsSync(join(this.#options.dataRoot, "postgres", "PG_VERSION"))
    )
      return Object.freeze({ ...this.#state, initialized: true });
    return Object.freeze({ ...this.#state });
  }
  owns(url: string): boolean {
    return this.#ownedUrl === url && this.#server?.isAlive() === true;
  }

  restoreSession(serverUrl: string) {
    return this.#sessionRecovery.restore(serverUrl);
  }

  start(): Promise<NativeServerState> {
    if (this.#stopping) return Promise.resolve({ status: "failed", code: "stopping" });
    if (this.#pending) return this.#pending;
    if (this.#state.status === "ready" && this.#server?.isAlive())
      return Promise.resolve(this.getState());
    this.#pending = this.#start()
      .catch(async (error: unknown) => {
        // Trusted main-process diagnostics never cross the renderer state/IPC boundary.
        if (startupDiagnostics.hasSubscribers)
          startupDiagnostics.publish({ state: this.#state, error });
        await this.#stopChildren();
        this.#state = {
          status: "failed",
          code:
            error instanceof NativeCredentialError
              ? "credential_unavailable"
              : "installation_failed",
        };
        return this.getState();
      })
      .finally(() => {
        this.#pending = undefined;
      });
    return this.#pending;
  }

  async #start(): Promise<NativeServerState> {
    if (
      this.#options.localServiceSupported === false ||
      !["darwin", "win32"].includes(this.#options.platform)
    ) {
      this.#state = { status: "failed", code: "unsupported_platform" };
      return this.getState();
    }
    await this.#stopChildren();
    const mode = existsSync(join(this.#options.dataRoot, "postgres", "PG_VERSION"))
      ? "resume"
      : "initialize";
    this.#state = { status: "installing", mode, step: "checking" };
    const { runtimeRoot, dataRoot } = this.#options;
    const bin = join(runtimeRoot, "postgres/bin");
    const windows = this.#options.platform === "win32";
    const executable = (name: string) => join(bin, windows ? `${name}.exe` : name);
    for (const name of ["initdb", "postgres", ...(windows ? ["pg_ctl"] : [])]) {
      const file = await lstat(executable(name));
      if (!file.isFile() || file.isSymbolicLink()) throw new Error("Native executable missing.");
    }
    if (!windows) {
      const helper = await lstat(join(runtimeRoot, "postgres-supervisor"));
      if (!helper.isFile() || helper.isSymbolicLink())
        throw new Error("Native database supervisor missing.");
    }
    await privateDirectory(dataRoot, this.#options.platform);
    const secretFile = new RestrictedJsonFile<string>(join(dataRoot, "bootstrap.json"), {
      label: "Encrypted local bootstrap",
      maximumBytes: 8192,
      parse: (input) => {
        const value: unknown = JSON.parse(input);
        if (typeof value !== "string" || !/^[A-Za-z0-9+/=]{32,8000}$/u.test(value))
          throw new Error("Invalid encrypted bootstrap.");
        return value;
      },
    });
    const retained = await secretFile.load();
    const cluster = join(dataRoot, "postgres");
    const clusterExists = await exists(cluster);
    if (!retained && clusterExists) throw new Error("Existing cluster has no bootstrap identity.");
    this.#state = { status: "installing", mode, step: "credentials" };
    const secrets = retained
      ? await decryptBootstrap(this.#options, retained)
      : {
          databasePassword: randomBytes(32).toString("hex"),
          ownerPassword: randomBytes(32).toString("hex"),
          modelKey: randomBytes(32).toString("hex"),
        };
    if (!retained) {
      let encrypted: string;
      try {
        encrypted = await this.#options.encrypt(JSON.stringify(secrets));
      } catch {
        throw new NativeCredentialError("OS secret storage is unavailable.");
      }
      await secretFile.save(encrypted);
    }
    this.#state = { status: "installing", mode, step: "database" };
    if (!clusterExists) {
      const staging = await mkdtemp(join(dataRoot, ".initializing-"));
      try {
        const passwordFile = join(staging, "initdb-password");
        if (windows) {
          await verifyWindowsPrivateDirectory(staging, true);
          await writeFile(passwordFile, `${secrets.databasePassword}\n`, {
            flag: "wx",
            mode: 0o600,
          });
        }
        await runBounded(
          executable("initdb"),
          [
            "-D",
            join(staging, "postgres"),
            "-U",
            "openbot",
            "--auth=scram-sha-256",
            "--encoding=UTF8",
            "--locale=C",
            windows ? `--pwfile=${passwordFile}` : "--pwfile=/dev/stdin",
          ],
          windows ? undefined : `${secrets.databasePassword}\n`,
        );
        if (windows) await verifyWindowsPrivateDirectory(join(staging, "postgres"), true);
        await rename(join(staging, "postgres"), cluster);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    } else {
      await privateDirectory(cluster, this.#options.platform);
      if ((await readFile(join(cluster, "PG_VERSION"), "utf8")).trim() !== "17")
        throw new Error("Cluster requires an explicit upgrade.");
    }
    if (this.#stopping) throw new Error("Stopping.");
    const dbPort = await availablePort();
    const databaseExited = () => {
      if (!this.#stopping && this.#state.status === "ready") {
        this.#state = { status: "failed", code: "service_stopped" };
        void this.#stopChildren();
      }
    };
    if (windows) {
      this.#windowsPostgres = await startWindowsPostgres(
        runtimeRoot,
        dataRoot,
        dbPort,
        databaseExited,
      );
    } else {
      this.#darwinPostgres = await startDarwinPostgres(
        runtimeRoot,
        dataRoot,
        dbPort,
        databaseExited,
      );
    }
    const darwinPostgres = this.#darwinPostgres;
    const windowsPostgres = this.#windowsPostgres;
    const databaseUrl = `postgres://openbot:${secrets.databasePassword}@127.0.0.1:${dbPort}/postgres`;
    await waitUntil(async () => {
      if (
        (darwinPostgres && !darwinPostgres.isAlive()) ||
        (windowsPostgres && !windowsPostgres.isAlive()) ||
        this.#stopping
      )
        throw new Error("Postgres stopped.");
      const connection = postgresClient(databaseUrl, {
        max: 1,
        connect_timeout: 2,
        idle_timeout: 1,
      });
      try {
        await connection`select 1`;
        return true;
      } catch {
        return false;
      } finally {
        await connection.end({ timeout: 1 });
      }
    });
    this.#state = { status: "installing", mode, step: "server" };
    const port = await availablePort();
    const url = `http://127.0.0.1:${port}`;
    this.#server = await this.#options.launchServer({
      ...nativeEnvironment(),
      OPENBOT_HOST: "127.0.0.1",
      OPENBOT_PORT: String(port),
      OPENBOT_DATABASE_URL: databaseUrl,
      OPENBOT_OWNER_PASSWORD: secrets.ownerPassword,
      OPENBOT_ALLOWED_ORIGINS: url,
      OPENBOT_OBJECT_STORE_PATH: join(dataRoot, "objects"),
      OPENBOT_MODEL_SETTINGS_PATH: join(dataRoot, "model-settings.json"),
      OPENBOT_MODEL_ENCRYPTION_KEY: secrets.modelKey,
      ...(process.env.OPENBOT_PLUGIN_LOCAL_ENDPOINTS
        ? { OPENBOT_PLUGIN_LOCAL_ENDPOINTS: process.env.OPENBOT_PLUGIN_LOCAL_ENDPOINTS }
        : {}),
      ...desktopSearchEnvironment(),
      OPENBOT_LOG_LEVEL: "error",
    });
    this.#ownedUrl = url;
    this.#state = { status: "installing", mode, step: "connecting" };
    await waitUntil(async () => {
      if (this.#stopping || !this.#server?.isAlive()) throw new Error("Server stopped.");
      try {
        await this.#options.connect(url, secrets.ownerPassword);
        return true;
      } catch {
        return false;
      }
    });
    const server = this.#server;
    this.#sessionRecovery.bind(
      url,
      () => this.#options.authenticate(url, secrets.ownerPassword),
      () => !this.#stopping && this.#server === server && this.owns(url),
    );
    this.#state = { status: "ready", serverUrl: url };
    return this.getState();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    await this.#pending;
    await this.#stopChildren();
    this.#state = { status: "idle" };
    this.#stopping = false;
  }
  async #stopChildren(): Promise<void> {
    this.#sessionRecovery.clear();
    this.#ownedUrl = undefined;
    const server = this.#server;
    this.#server = undefined;
    await server?.stop().catch(() => undefined);
    const darwinPostgres = this.#darwinPostgres;
    this.#darwinPostgres = undefined;
    const windowsPostgres = this.#windowsPostgres;
    this.#windowsPostgres = undefined;
    if (windowsPostgres) await windowsPostgres.stop();
    if (darwinPostgres) await darwinPostgres.stop();
  }
}

function parseSecrets(value: string): BootstrapSecrets {
  const parsed = JSON.parse(value) as BootstrapSecrets;
  if (
    Object.keys(parsed).sort().join() !== "databasePassword,modelKey,ownerPassword" ||
    !Object.values(parsed).every((item) => typeof item === "string" && /^[a-f0-9]{64}$/u.test(item))
  )
    throw new Error("Invalid local bootstrap.");
  return parsed;
}
async function privateDirectory(path: string, platform: string): Promise<void> {
  const created = !(await exists(path));
  await mkdir(path, { recursive: true, mode: 0o700 });
  const entry = await lstat(path);
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    (platform !== "win32" && ((entry.mode & 0o077) !== 0 || entry.uid !== process.getuid?.()))
  )
    throw new Error("Unsafe local data directory.");
  if (platform === "win32") await verifyWindowsPrivateDirectory(path, created);
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
/** A generic search key in the launching shell does not select an account for Desktop. */
export function desktopSearchEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const key = source.OPENBOT_DESKTOP_TAVILY_API_KEY?.trim();
  return key ? { TAVILY_API_KEY: key } : {};
}

function nativeEnvironment(): Record<string, string> {
  return process.platform === "win32"
    ? windowsNativeEnvironment()
    : { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
}
export async function availablePort(): Promise<number> {
  const listener = createServer();
  return new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close();
        reject(new Error("No local port."));
        return;
      }
      listener.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
export function runBounded(
  executable: string,
  args: string[],
  input?: string,
  timeout = 30_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const captureDiagnostics = startupDiagnostics.hasSubscribers;
    let diagnosticBytes = 0;
    const diagnosticChunks: Buffer[] = [];
    const child = spawn(executable, args, {
      env: nativeEnvironment(),
      stdio: ["pipe", "ignore", captureDiagnostics ? "pipe" : "ignore"],
      shell: false,
      windowsHide: true,
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const bounded = chunk.subarray(0, Math.max(0, 16_384 - diagnosticBytes));
      diagnosticBytes += bounded.length;
      if (bounded.length) diagnosticChunks.push(bounded);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdin?.on("error", () => undefined);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Native operation failed."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && captureDiagnostics) {
        startupDiagnostics.publish({
          operation: basename(executable),
          code,
          stderr: Buffer.concat(diagnosticChunks).toString("utf8"),
        });
      }
      code === 0 ? resolve() : reject(new Error("Native operation failed."));
    });
    child.stdin?.end(input);
  });
}
async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(250);
  }
  throw new Error("Native startup timed out.");
}
async function decryptBootstrap(
  options: NativeServerOptions,
  retained: string,
): Promise<BootstrapSecrets> {
  let decrypted: string;
  try {
    decrypted = await options.decrypt(retained);
  } catch {
    throw new NativeCredentialError("OS secret storage is unavailable.");
  }
  return parseSecrets(decrypted);
}
