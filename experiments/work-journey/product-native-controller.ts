/** One-shot controller of the fixed, root-owned CI Host; no discovery, SSH, upload or retries. */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { strictCommandJson } from "../../apps/server/dist/work-command-values.js";
import type { TimingPolicy } from "../../apps/server/dist/work-command-contract.js";
import {
  finishedEvidence,
  nativeControllerConfiguration,
  readyEvidence,
  stagedPin,
  type PreparationBinding,
  type Route,
} from "./product-native-protocol.ts";

const MAXIMUM = 96 * 1024;
const parse = (value: Buffer) => strictCommandJson(value, 32768);
export async function reserveLoopbackPort(port = 0) {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    server,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
export class NativeProductController {
  readonly #entry: string[];
  readonly #directory: string;
  #route: Route | undefined;
  #port: number | undefined;
  #reservation: Awaited<ReturnType<typeof reserveLoopbackPort>> | undefined;
  #process: ChildProcessWithoutNullStreams | undefined;
  #monitor: Promise<unknown> | undefined;
  #finished = false;
  #started = false;
  private constructor(configuration: unknown, directory: string) {
    const config = nativeControllerConfiguration.parse(configuration);
    assert.equal(process.platform, "linux", "linux_required");
    this.#entry = [config.node, config.program];
    this.#directory = directory;
  }
  static async open(path: string, directory: string) {
    return new NativeProductController(parse(await readFile(path)), directory);
  }
  #spawn(operation: "stage" | "run" | "check" | "cleanup", payload: unknown) {
    const child = spawn("/usr/bin/sudo", ["-n", ...this.#entry, operation], { stdio: "pipe" });
    // An early closed stdin must not become an unhandled stream error. The exit/response decides success.
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
    return child;
  }
  async #once(operation: "stage" | "check" | "cleanup", payload: unknown): Promise<unknown> {
    const child = this.#spawn(operation, payload),
      stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let size = 0,
      exceeded = false;
    const capture = (target: Buffer[]) => (bytes: Buffer) => {
      size += bytes.length;
      if (size <= MAXIMUM) target.push(bytes);
      else exceeded = true;
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      await writeFile(
        join(this.#directory, `native-${operation}.stderr-private`),
        Buffer.concat(stderr),
        { mode: 0o600 },
      );
      assert(!exceeded, "native_capture_bound");
      assert.equal(code, 0, `native_${operation}_failed`);
      return parse(Buffer.concat(stdout));
    } finally {
      clearTimeout(timer);
    }
  }
  async stage(
    route: Route,
    timing: TimingPolicy,
    controlPublic: string,
    bundle: string,
    reservation: Awaited<ReturnType<typeof reserveLoopbackPort>>,
  ) {
    assert(!this.#route && !this.#started, "native_stage_already_attempted");
    this.#route = route;
    this.#port = reservation.port;
    this.#reservation = reservation;
    const value = await this.#once("stage", {
      version: 1,
      route,
      timing,
      controlIssuer: "product-control",
      controlKid: "product-control-key",
      controlPublicPem: controlPublic,
      enforcementIssuer: "product-enforcer",
      nodeBundleSha256: createHash("sha256")
        .update(await readFile(bundle))
        .digest("hex"),
      serverPort: reservation.port,
    });
    return stagedPin(value, route, reservation.port);
  }
  async releaseServerPort() {
    assert(this.#reservation, "native_server_port_not_reserved");
    await this.#reservation.close();
    this.#reservation = undefined;
  }
  async start(enrollment: string, port: number) {
    assert(/^obenr_[A-Za-z0-9_-]{43}$/.test(enrollment), "one_time_enrollment_required");
    assert(
      this.#route && !this.#reservation && this.#port === port && !this.#started,
      "native_server_port_changed",
    );
    this.#started = true;
    const child = this.#spawn("run", { version: 1, enrollmentToken: enrollment });
    this.#process = child;
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0),
      sawReady = false,
      exceeded = false;
    let readyResolve!: () => void, readyReject!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const readyTimer = setTimeout(() => readyReject(new Error("native_ready_deadline")), 20000);
    const captureTimer = setTimeout(() => child.kill("SIGKILL"), 170000);
    child.stdout.on("data", (bytes: Buffer) => {
      if (stdout.length + bytes.length > MAXIMUM) {
        exceeded = true;
        return;
      }
      stdout = Buffer.concat([stdout, bytes]);
      if (!sawReady) {
        const newline = stdout.indexOf(10);
        if (newline >= 0) {
          sawReady = true;
          clearTimeout(readyTimer);
          try {
            readyEvidence(parse(stdout.subarray(0, newline)));
            readyResolve();
          } catch (error) {
            readyReject(error);
          }
          stdout = stdout.subarray(newline + 1);
        }
      }
    });
    child.stderr.on("data", (bytes: Buffer) => {
      if (stderr.length + bytes.length > MAXIMUM) exceeded = true;
      else stderr = Buffer.concat([stderr, bytes]);
    });
    this.#monitor = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    })
      .then(async (code) => {
        await writeFile(
          join(this.#directory, "native-run.stderr-private"),
          stderr.toString("utf8").replace(/obenr_[A-Za-z0-9_-]{0,43}/g, "[redacted-enrollment]"),
          { mode: 0o600 },
        );
        assert(!exceeded, "native_capture_bound");
        const result = parse(stdout);
        await writeFile(
          join(this.#directory, "native-run.result-private.json"),
          JSON.stringify(result),
          { mode: 0o600 },
        );
        assert.equal(code, 0, "native_run_failed");
        assert(sawReady, "native_ready_missing");
        return result;
      })
      .finally(() => {
        this.#finished = true;
        clearTimeout(readyTimer);
        clearTimeout(captureTimer);
        readyReject(new Error("native_runner_closed_before_ready"));
      });
    // Keep the original runner alive through its own deadline even when readiness fails.
    this.#monitor.catch(() => {});
    try {
      await ready;
    } catch (error) {
      await this.#monitor.catch(() => {});
      throw error;
    }
  }
  async assertUnprepared() {
    assert(this.#monitor && !this.#finished, "original_native_run_required");
    assert.deepEqual(
      await this.#once("check", {}),
      { version: 1, singleActionAbsent: true, runnerReserved: true, route: this.#route },
      "native_action_already_reserved",
    );
  }
  async finish(binding: PreparationBinding) {
    assert(this.#monitor, "original_native_run_required");
    return {
      ...finishedEvidence(await this.#monitor, binding),
      fixtureEnvironment: "disposable-github-linux",
      actualNativeHost: true,
      actualPeerUid: 62425,
    };
  }
  async close() {
    try {
      if (this.#monitor) await this.#monitor;
      else if (this.#route && !this.#process) await this.#once("cleanup", {});
      else if (this.#process) throw new Error("native_original_cleanup_unconfirmed");
    } finally {
      if (this.#reservation) {
        await this.#reservation.close();
        this.#reservation = undefined;
      }
    }
  }
}
