/** Original browser PID1 lifetime, private packet and bounded CLI observations; never creates a replacement deadline. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { request } from "node:http";
import { DockerCli } from "../linux-execution/docker-cli.ts";
import { command, type NativeCommand } from "../linux-execution/native-unit.ts";
import { unitShow } from "../linux-execution/native-facts.ts";
import { nativeClock } from "../linux-execution/kernel-facts.ts";
import { directory, digest, fsyncDirectory, readBytes } from "../linux-execution/protected-io.ts";
import { readKernelText } from "../linux-execution/output-capacity.ts";
import { namespaceCommand } from "../linux-execution/namespace-command.ts";
import { SubprocessCommander } from "../linux-execution/subprocess.ts";
import { browserUnit } from "./native-browser-contract.ts";
import { browserNativeEnvironment } from "./native-browser-companion.ts";
import { browserMembers } from "./native-browser-observer.ts";
export const browserBase = "/opt/obp4",
  browserPacket = browserBase + "/composition-20260926-a1",
  browserNode = browserBase + "/node",
  browserProgram = browserBase + "/browser-native.cjs";
export const browserToken = "synthetic-linux-composition-fixture-only";
export const browserNow = () => nativeClock()[0] / 1000000;
export function browserRead<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(
    new TextDecoder("utf8", { fatal: true }).decode(readBytes(path, 2 * 1024 * 1024)),
  );
}
export function browserRecord(path: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  assert(bytes.length <= 2 * 1024 * 1024, "Native receipt bound");
  directory(dirname(path));
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
    0o600,
  );
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset);
      assert(count > 0);
      offset += count;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path));
}
export type BrowserPlan = {
  nativeRoot: string;
  browserProgram: string;
  browserProgramSha256: string;
  browserNodeSha256: string;
  browserModules: { path: string; bytes: number; sha256: string }[];
  bunSha256: string;
  chromium: { archiveSha256: string; archiveBytes: number };
  squid: { archiveSha256: string; config: string; manifest: string };
};
export type BrowserArmed = {
  unit: string;
  invocation: string;
  deadline: number;
  group: string;
  inode: number;
  pid: number;
  namespaces: { net: string; mnt: string };
};
export async function browserWait<T>(
  predicate: () => T | undefined | Promise<T | undefined>,
  deadline: number,
  name: string,
): Promise<T> {
  while (browserNow() < deadline) {
    const value = await predicate();
    if (value !== undefined && value !== null && value !== false) return value;
    await delay(50);
  }
  throw new Error("Original browser wait expired: " + name);
}
export class BrowserLifetime {
  readonly root: string;
  readonly unit: string;
  readonly plan: BrowserPlan;
  readonly run: NativeCommand = command(browserNativeEnvironment);
  constructor() {
    assert(
      process.platform === "linux" && process.arch === "x64" && process.geteuid?.() === 0,
      "Native Linux amd64 root required",
    );
    directory(browserBase);
    directory(browserPacket);
    this.plan = browserRead<BrowserPlan>(browserBase + "/PLAN.json");
    assert(/^\/opt\/obp4\/units\/deadline-a1-p4[a-f0-9]{6}$/.test(this.plan.nativeRoot));
    assert.equal(this.plan.browserProgram, browserProgram);
    assert.equal(digest(browserProgram), this.plan.browserProgramSha256);
    assert.equal(digest(browserNode), this.plan.browserNodeSha256);
    directory(browserBase + "/node_modules");
    assert(
      Array.isArray(this.plan.browserModules) &&
        this.plan.browserModules.length > 0 &&
        this.plan.browserModules.length <= 1000,
    );
    for (const entry of this.plan.browserModules) {
      assert(
        entry.path === posix.normalize(entry.path) &&
          !entry.path.startsWith("/") &&
          !entry.path.startsWith("../"),
      );
      const path = browserBase + "/node_modules/" + entry.path,
        info = lstatSync(path);
      assert(info.isFile() && info.uid === 0 && !(info.mode & 0o022) && info.size === entry.bytes);
      assert.equal(digest(path), entry.sha256);
    }
    this.root = this.plan.nativeRoot;
    this.unit = browserUnit(this.root);
  }
  receipt(name: string, value: unknown) {
    assert(
      /^[a-zA-Z0-9_./-]+$/.test(name) &&
        !name.split("/").some((v) => v === ".." || v === "." || v === ""),
    );
    browserRecord(join(this.root, name), value);
  }
  async show() {
    const result = await new SubprocessCommander({
      binary: "/usr/bin/systemctl",
      environment: browserNativeEnvironment,
      captureLimit: 65536,
    }).run(["show", this.unit, "--all", "--no-pager", "--property=" + unitShow.join(",")], 3000);
    const value: Record<string, string> = {};
    for (const line of result.stdout.trim().split("\n")) {
      const index = line.indexOf("=");
      if (index < 0) continue;
      const name = line.slice(0, index);
      assert(!Object.hasOwn(value, name));
      value[name] = line.slice(index + 1);
    }
    assert(
      !result.uncertain && (result.ok || (result.status === 1 && value.LoadState === "not-found")),
      "Original systemd observation unknown",
    );
    return value;
  }
  async stopHooks() {
    const service = "org.freedesktop.systemd1",
      found = JSON.parse(
        await this.run([
          "/usr/bin/busctl",
          "--json=short",
          "call",
          service,
          "/org/freedesktop/systemd1",
          service + ".Manager",
          "GetUnit",
          "s",
          this.unit,
        ]),
      );
    assert(
      found.type === "o" &&
        Array.isArray(found.data) &&
        found.data.length === 1 &&
        /^\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]+$/.test(found.data[0]),
    );
    const lines = (
      await this.run([
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
    assert.equal(lines.length, 2);
    for (const line of lines)
      assert.deepEqual(JSON.parse(line), { type: "a(sasbttttuii)", data: [] });
    return { ExecStop: "", ExecStopPost: "" };
  }
  async original() {
    directory(this.root);
    const armed = browserRead<BrowserArmed>(this.root + "/native.json"),
      value = await this.show();
    assert.equal(armed.unit, this.unit);
    assert.equal(armed.group, "/system.slice/" + this.unit);
    assert(
      value.InvocationID === armed.invocation &&
        value.ActiveState === "active" &&
        value.NRestarts === "0",
      "Original native lifetime closed",
    );
    assert(browserNow() < armed.deadline - 10, "Native lifetime exhausted");
    assert.equal(Number(value.MainPID), armed.pid);
    assert.equal(lstatSync("/sys/fs/cgroup" + armed.group).ino, armed.inode);
    for (const kind of ["net", "mnt"] as const) {
      assert.equal(
        readlinkSync(`/proc/${armed.pid}/ns/${kind}`),
        armed.namespaces[kind],
        "Original namespace changed",
      );
      assert.notEqual(
        armed.namespaces[kind],
        readlinkSync(`/proc/1/ns/${kind}`),
        "Host namespace forbidden",
      );
    }
    return armed;
  }
  async inside(argv: string[], timeoutMs = 8000) {
    const armed = await this.original();
    const result = await namespaceCommand({
      pid: armed.pid,
      namespaces: armed.namespaces,
      argv,
      environment: browserNativeEnvironment,
      timeoutMs,
    });
    assert(result.ok, "Original private namespace command failed");
    return result.stdout.trim();
  }
  async docker(args: string[], timeoutMs = 15000) {
    await this.original();
    const result = await new SubprocessCommander({
      binary: browserBase + "/bin/docker",
      environment: browserNativeEnvironment,
      captureLimit: 2 * 1024 * 1024,
      arguments: [
        "--config",
        this.root + "/docker-config",
        "--host",
        "unix://" + this.root + "/docker.sock",
      ],
    }).run(args, timeoutMs);
    this.receipt("commands/" + randomUUID() + ".json", { arguments: args, result });
    assert(result.ok, "Private Docker command failed: " + args.slice(0, 2).join(" "));
    return result.stdout.trim();
  }
  async image(id: string) {
    await this.original();
    const cli = new DockerCli(
      new SubprocessCommander({
        binary: browserBase + "/bin/docker",
        environment: browserNativeEnvironment,
        captureLimit: 2 * 1024 * 1024,
        arguments: [
          "--config",
          this.root + "/docker-config",
          "--host",
          "unix://" + this.root + "/docker.sock",
        ],
      }),
      15000,
    );
    return await cli.imageInspect(id);
  }
  async inspect(id: string) {
    return JSON.parse(await this.docker(["inspect", id]))[0] as Record<string, unknown>;
  }
  async relay(name: "control" | "target", path: string, body?: unknown) {
    await this.original();
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return await new Promise<{ status: number; body: Record<string, unknown> }>(
      (resolve, reject) => {
        const req = request(
          {
            socketPath: this.root + "/" + name + ".sock",
            path,
            method: bytes ? "POST" : "GET",
            headers: {
              Authorization: "Bearer " + browserToken,
              "x-openbot-bot-id": "qualification-check",
              ...(bytes
                ? { "content-type": "application/json", "content-length": bytes.length }
                : {}),
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            let length = 0;
            response.on("data", (raw: Buffer) => {
              length += raw.length;
              if (length > 1024 * 1024) {
                req.destroy(new Error("Bounded browser response exceeded"));
                return;
              }
              chunks.push(raw);
            });
            response.once("error", reject);
            response.once("end", () => {
              try {
                resolve({
                  status: response.statusCode!,
                  body: JSON.parse(Buffer.concat(chunks).toString()),
                });
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        const timer = setTimeout(() => req.destroy(new Error("Browser relay deadline")), 30000);
        req.once("close", () => clearTimeout(timer));
        req.once("error", reject);
        req.end(bytes);
      },
    );
  }
  async closeOriginal(armed: BrowserArmed, accepted: boolean) {
    const group = "/sys/fs/cgroup" + armed.group;
    const checkGroup = () => {
      assert.equal(armed.group, "/system.slice/" + this.unit);
      assert(
        !existsSync(group) || lstatSync(group).ino === armed.inode,
        "Original cgroup replaced",
      );
    };
    if (!accepted) {
      const value = await this.show();
      assert.equal(value.InvocationID, armed.invocation);
      assert.equal(value.NRestarts, "0");
      checkGroup();
      this.receipt("failed-unit-before-stop.json", value);
      await this.run(["/usr/bin/systemctl", "stop", this.unit], 12000);
    }
    const terminal = await browserWait(
      async () => {
        checkGroup();
        if (
          existsSync(group) &&
          readKernelText(group + "/cgroup.events")
            .split("\n")
            .includes("populated 1")
        )
          return undefined;
        const value = await this.show();
        assert.equal(value.InvocationID, armed.invocation);
        return ["inactive", "failed"].includes(value.ActiveState!) ? value : undefined;
      },
      accepted ? armed.deadline + 5 : browserNow() + 8,
      "original cgroup exit",
    );
    assert.equal(terminal.NRestarts, "0");
    assert.equal(browserMembers(group).length, 0);
    if (accepted) {
      assert.equal(terminal.Result, "timeout", "Not original native timeout");
      this.receipt("native-terminal-readback.json", terminal);
      this.receipt("native-expiry.json", {
        unit: terminal,
        cgroupEmpty: true,
        observedStopLatencySeconds: browserNow() - armed.deadline,
      });
    } else
      this.receipt("failed-unit-closed.json", {
        originalUnitStopped: true,
        cgroupEmpty: true,
        nativeTimeoutClaimed: false,
      });
  }
  verifyFiles() {
    const files = browserRead<{ path: string; bytes: number; sha256: string }[]>(
      browserPacket + "/FILES.json",
    );
    assert(Array.isArray(files) && files.length <= 20000);
    for (const entry of files) {
      assert(
        typeof entry.path === "string" &&
          entry.path === posix.normalize(entry.path) &&
          !entry.path.startsWith("/") &&
          !entry.path.startsWith("../"),
      );
      const file = join(browserPacket, entry.path),
        info = lstatSync(file);
      assert(info.isFile() && info.uid === 0 && !(info.mode & 0o022) && info.size === entry.bytes);
      assert.equal(digest(file), entry.sha256, "Packet file changed");
    }
    assert.equal(
      digest(browserBase + "/downloads/playwright-1.62.1-linux-amd64.tar"),
      this.plan.chromium.archiveSha256,
    );
    assert.equal(
      lstatSync(browserBase + "/downloads/playwright-1.62.1-linux-amd64.tar").size,
      this.plan.chromium.archiveBytes,
    );
    assert.equal(digest(browserPacket + "/squid-image.tar"), this.plan.squid.archiveSha256);
    assert.equal(digest(browserPacket + "/bun"), this.plan.bunSha256);
    assert.equal(
      digest(browserPacket + "/seccomp_profile.json"),
      "d00ad84f5a67031fe2bb64de8d77a5ad9c06adb82935ebdb3c18b5f7ba60a5d0",
    );
    return files;
  }
}
