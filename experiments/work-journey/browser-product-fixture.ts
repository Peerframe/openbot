/** Owned HTTP/PostgreSQL/mTLS/process lifetime for the migrated browser qualification. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@temporalio/client";
import proto from "@temporalio/proto";
import { createDatabase } from "@openbot/db";
import { z } from "zod";
import { Profile } from "../../deploy/temporal/maintain.ts";
import { DevProcessOwner } from "../../scripts/dev-processes.ts";
import {
  allowlistedEnvironment,
  OwnedDockerFixture,
  startControlPostgres,
} from "../../scripts/acceptance-fixture.ts";
import { startTemporalFixture } from "../../scripts/temporal-fixture.ts";
import { reserveLoopbackPort } from "./product-native-controller.ts";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const privateJson = (path: string, value: unknown) =>
  writeFile(path, JSON.stringify(value), { mode: 0o600 });
export const jsonFile = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8"));
export const record = z.record(z.string(), z.unknown());
export const nestedId = (value: unknown, key: string) =>
  z.object({ id: z.string() }).parse(record.parse(value)[key]).id;
export class BrowserHttpFailure extends Error {
  readonly status: number;
  readonly payload: unknown;
  constructor(status: number, payload: unknown) {
    super("Owned browser product HTTP refused");
    this.status = status;
    this.payload = payload;
  }
}
export class BrowserProductFixture {
  readonly environment = allowlistedEnvironment([
    "PATH",
    "HOME",
    "TMPDIR",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
  ]);
  readonly docker = new OwnedDockerFixture(ROOT, this.environment);
  readonly logs: number[] = [];
  readonly processes = new DevProcessOwner({
    cwd: ROOT,
    createChild: (command, args, options) => {
      const log = openSync(join(this.directory, `process-${this.logs.length}.log`), "wx", 0o600);
      this.logs.push(log);
      return spawn(command, [...args], { ...options, stdio: ["pipe", log, log] });
    },
  });
  database: ReturnType<typeof createDatabase> | undefined;
  engine: Awaited<ReturnType<typeof startTemporalFixture>> | undefined;
  server: ChildProcess | undefined;
  node: ChildProcess | undefined;
  nodeOwner: DevProcessOwner | undefined;
  reservation: Awaited<ReturnType<typeof reserveLoopbackPort>> | undefined;
  readonly password = randomBytes(24).toString("hex");
  environmentForServer: NodeJS.ProcessEnv = {};
  origin = "";
  cookie = "";
  migrations = 0;
  unavailableReads = 0;
  readonly directory: string;
  readonly signal: AbortSignal;
  readonly requestTimeout: number;
  constructor(directory: string, signal: AbortSignal, requestTimeout = 5000) {
    this.directory = directory;
    this.signal = signal;
    this.requestTimeout = requestTimeout;
  }
  async initialize() {
    await mkdir(this.directory, { mode: 0o700 });
    for (const name of ["artifacts", "objects", "provider", "node", "work-files"])
      await mkdir(join(this.directory, name), { mode: 0o700 });
    const dsn = await startControlPostgres(
      this.docker,
      "openbot-browser-" + randomUUID(),
      randomBytes(24).toString("hex"),
    );
    this.database = createDatabase(dsn);
    await this.database.migrate();
    const [row] = await this.database
      .client`SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations`;
    this.migrations = z.number().parse(row?.count);
    this.engine = await startTemporalFixture({
      signal: this.signal,
      createProfile: async (env, project) => {
        const profile = new Profile(env, project, true),
          command = profile.command;
        profile.command = (args, input) =>
          command(
            [
              "--file",
              join(ROOT, "experiments/work-journey/terminal-recovery/resources.yaml"),
              ...args,
            ],
            input,
          );
        return { profile, close: () => profile.command(["down", "--volumes", "--remove-orphans"]) };
      },
    });
    this.reservation = await reserveLoopbackPort();
    this.origin = `http://127.0.0.1:${this.reservation.port}`;
    const enginePath = join(this.directory, "engine.json"),
      providerPath = join(this.directory, "provider.json");
    await privateJson(enginePath, {
      temporal_address: this.engine.settings.address,
      namespace: "default",
      queue: "browser-" + randomBytes(6).toString("hex"),
      tls: this.engine.settings.tls,
      interval_seconds: 1,
      execution_timeout_seconds: 600,
    });
    await privateJson(providerPath, { directory: join(this.directory, "provider") });
    this.environmentForServer = {
      ...this.environment,
      OPENBOT_CONTROL_DATABASE_URL: dsn,
      OPENBOT_CONTROL_PORT: String(this.reservation.port),
      OPENBOT_CONTROL_OWNER_PASSWORD: this.password,
      OPENBOT_CONTROL_AUTHORITY: "product",
      OPENBOT_CONTROL_WORK_TOKEN_LIMIT: "1000000",
      OPENBOT_CONTROL_OBJECT_ROOT: join(this.directory, "objects"),
      OPENBOT_CONTROL_ARTIFACT_ROOT: join(this.directory, "artifacts"),
      OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH: enginePath,
      OPENBOT_BROWSER_PROBE_CONFIG: providerPath,
    };
    await this.reservation.close();
    this.reservation = undefined;
    await this.start();
  }
  async api(path: string, body?: unknown, expected = 200, raw = false): Promise<unknown> {
    const response = await fetch(this.origin + path, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(this.requestTimeout)]),
      headers: { Origin: this.origin, Cookie: this.cookie, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (response.status !== expected) {
      const payload: unknown = JSON.parse(bytes.toString());
      throw new BrowserHttpFailure(response.status, payload);
    }
    if (path === "/api/v1/auth/login") {
      this.cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
      assert(this.cookie);
    }
    if (raw) {
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert(response.headers.get("content-disposition")?.startsWith("attachment;"));
      return bytes;
    }
    return bytes.length ? JSON.parse(bytes.toString()) : undefined;
  }
  async until<T>(read: () => Promise<T | false | undefined>, seconds = 60): Promise<T> {
    const deadline = performance.now() + seconds * 1000;
    while (performance.now() < deadline) {
      this.signal.throwIfAborted();
      assert(
        this.server && this.server.exitCode === null && this.server.signalCode === null,
        "Browser product Server exited; private log retained.",
      );
      const value = await read();
      if (value !== undefined && value !== false) return value;
      await delay(150, undefined, { signal: this.signal });
    }
    throw new Error("Browser product checkpoint timed out; private evidence retained.");
  }
  async snapshot(task: string) {
    try {
      return await this.api("/api/v1/tasks/" + task);
    } catch (error) {
      if (
        error instanceof BrowserHttpFailure &&
        error.status === 503 &&
        JSON.stringify(error.payload) === '{"error":"Control-plane storage is unavailable."}'
      ) {
        this.unavailableReads++;
        return false;
      }
      throw error;
    }
  }
  async start() {
    this.server = this.processes.start(
      process.execPath,
      ["--import", "tsx", "experiments/work-journey/product_browser_ts_server.ts"],
      this.environmentForServer,
    );
    await this.until(async () => {
      try {
        return record.parse(await this.api("/health")).ok === true;
      } catch (error) {
        if (
          error instanceof TypeError &&
          (error.cause as NodeJS.ErrnoException)?.code === "ECONNREFUSED"
        )
          return false;
        throw error;
      }
    });
    await this.api("/api/v1/auth/login", { password: this.password });
  }
  async restart() {
    const server = this.server;
    assert(server);
    server.kill("SIGKILL");
    await new Promise<void>((resolve) => server.once("exit", () => resolve()));
    await this.start();
  }
  async startNode(entry: string, config: unknown, browsers: string): Promise<string> {
    const log = openSync(join(this.directory, "node.log"), "wx", 0o600);
    this.logs.push(log);
    this.nodeOwner = new DevProcessOwner({
      cwd: ROOT,
      createChild: (command, args, options) =>
        spawn(command, [...args], { ...options, stdio: ["pipe", "pipe", log] }),
    });
    const node = this.nodeOwner.start(process.execPath, ["--import", "tsx", entry], {
      ...this.environment,
      PLAYWRIGHT_BROWSERS_PATH: browsers,
    });
    this.node = node;
    assert(node.stdin && node.stdout);
    node.stdin.on("error", () => {});
    node.stdin.end(JSON.stringify(config));
    const stdout = node.stdout;
    return new Promise((resolve, reject) => {
      let bytes = Buffer.alloc(0);
      const timer = setTimeout(() => finish(new Error("Browser Node readiness timed out")), 20000);
      const onExit = () => finish(new Error("Browser Node exited before readiness"));
      const onData = (part: Buffer) => {
        bytes = Buffer.concat([bytes, part]);
        if (bytes.length > 32768) return finish(new Error("Browser readiness exceeded bound"));
        const newline = bytes.indexOf(10);
        if (newline < 0) return;
        try {
          const value = z
            .object({ targetUrl: z.url() })
            .parse(JSON.parse(bytes.subarray(0, newline).toString()));
          finish(undefined, value.targetUrl);
        } catch (error) {
          finish(error);
        }
      };
      const finish = (error?: unknown, target?: string) => {
        clearTimeout(timer);
        node.off("exit", onExit);
        stdout.off("data", onData);
        stdout.resume();
        if (error) reject(error);
        else {
          assert(target);
          resolve(target);
        }
      };
      node.once("exit", onExit);
      node.once("error", finish);
      stdout.on("data", onData);
    });
  }
  handle(run: string) {
    assert(this.engine);
    return new Client({
      connection: this.engine.connection,
      namespace: "default",
    }).workflow.getHandle("openbot-work-ts-v1-" + run);
  }
  async replay(run: string) {
    const history = await this.handle(run).fetchHistory(),
      path = join(this.directory, "history.bin");
    await writeFile(path, proto.temporal.api.history.v1.History.encode(history).finish(), {
      mode: 0o600,
    });
    const replay = this.processes.start(
      process.execPath,
      [
        "--import",
        "tsx",
        "experiments/work-journey/product_browser_ts_server.ts",
        "--replay",
        path,
      ],
      this.environment,
    );
    const timer = setTimeout(() => replay.kill("SIGKILL"), 30000);
    try {
      await this.processes.waitSuccess(replay);
    } finally {
      clearTimeout(timer);
    }
  }
  async close() {
    const failures: unknown[] = [];
    for (const action of [
      async () => {
        await this.nodeOwner?.stop();
        if (this.node) assert.equal(this.node.exitCode, 0, "Browser Node cleanup failed");
      },
      () => this.processes.stop(),
      () => this.database?.close(),
      () => this.engine?.close(),
      async () => this.docker.cleanup(),
      () => this.reservation?.close(),
    ]) {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    }
    for (const fd of this.logs) closeSync(fd);
    if (failures.length) throw new AggregateError(failures, "Owned browser cleanup failed");
  }
}
