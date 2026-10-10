/** Fixed four-namespace kernel qualification: the original 150-second lifetime, canaries and revoke. */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
  namespaceCommand,
  openNamespace,
  verifyEnteredNamespaces,
} from "../../linux-execution/namespace-command.ts";
import { SubprocessCommander } from "../../linux-execution/subprocess.ts";
import { snapshotHost } from "../../work-journey/native-host-baseline.ts";

const ROOT = "/opt/openbot-qualification-20260925-c8b2/network-20260926-a2";
const UNIT = "openbot-browser-network-20260926-a2.service";
const ENV = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" };
const PROGRAM = ROOT + "/network-qualification.cjs";
const NODE = ROOT + "/node";
const GROUP = "/system.slice/" + UNIT;
let phase = "entry",
  rootChecked = false;
let failedCommand: { binary: string; status: number | null; timedOut: boolean } | undefined;
function diagnostic(error: unknown) {
  const value = error instanceof Error ? error : undefined;
  const code = value && "code" in value && typeof value.code === "string" ? value.code : "";
  const line = value?.stack?.match(/network-qualification\.cjs:(\d+):\d+/)?.[1];
  return {
    phase,
    command: failedCommand,
    code: /^(?:ERR_ASSERTION|ENOENT|ESRCH|EPERM|EACCES|EPIPE|ECONNREFUSED|ETIMEDOUT|EADDRINUSE)$/.test(
      code,
    )
      ? code
      : null,
    line: line ? Number(line) : null,
  };
}
const roles = {
  client: ["10.77.10.1/30", "10.77.10.2/30", "fd77:10::1/64", "fd77:10::2/64"],
  proxy: ["10.77.11.1/30", "10.77.11.2/30", "fd77:11::1/64", "fd77:11::2/64"],
  public: [
    "93.184.216.33/29",
    "93.184.216.34/29",
    "2606:4700:4700:ffee::1/64",
    "2606:4700:4700:ffee::2/64",
  ],
  private: ["10.77.12.1/30", "10.77.12.2/30", "fd77:12::1/64", "fd77:12::2/64"],
} as const;
const hosts = new Set<string>([
  ...Object.values(roles)
    .flat()
    .map((v) => v.split("/")[0]!),
  "169.254.169.254",
  "93.184.216.35",
]);
const ports = [3128, 3129, 18080, 18443, 53, 443];
const targets = [
  ["public-v4", "public", "93.184.216.34", 18080, "tcp"],
  ["public-v6", "public", "2606:4700:4700:ffee::2", 18080, "tcp"],
  ["private-v4", "private", "10.77.12.2", 18080, "tcp"],
  ["private-v6", "private", "fd77:12::2", 18080, "tcp"],
  ["metadata", "private", "169.254.169.254", 18080, "tcp"],
  ["gateway", "host", "10.77.10.1", 18080, "tcp"],
  ["gateway-v6", "host", "fd77:10::1", 18080, "tcp"],
  ["management", "host", "93.184.216.35", 18080, "tcp"],
  ["dns-tcp", "public", "93.184.216.34", 53, "tcp"],
  ["dns-udp", "public", "93.184.216.34", 53, "udp"],
  ["quic-udp", "public", "93.184.216.34", 443, "udp"],
  ["wrong-proxy-port", "proxy", "10.77.11.2", 3129, "tcp"],
] as const;
const namespace = () => readlinkSync("/proc/self/ns/net");
function rootOnly() {
  assert.equal(process.platform, "linux");
  assert.equal(process.geteuid?.(), 0);
  const info = lstatSync(ROOT);
  assert(info.isDirectory() && info.uid === 0 && (info.mode & 0o077) === 0);
  assert.equal(realpathSync(ROOT), ROOT);
  for (const path of [NODE, PROGRAM, ROOT + "/fixture.nft"]) {
    const file = lstatSync(path);
    assert(file.isFile() && file.uid === 0 && (file.mode & 0o022) === 0);
  }
  assert.equal(realpathSync(process.execPath), NODE);
  rootChecked = true;
}
function isolated() {
  rootOnly();
  assert.equal(readFileSync("/proc/self/cgroup", "utf8").trim(), "0::" + GROUP);
  assert.notEqual(namespace(), readlinkSync("/proc/1/ns/net"));
}
async function command(argv: readonly string[], timeout = 8000) {
  const runner = new SubprocessCommander({
    binary: argv[0]!,
    environment: ENV,
    captureLimit: 2 * 1024 ** 2,
  });
  const result = await runner.run(argv.slice(1), timeout);
  failedCommand = result.ok
    ? undefined
    : { binary: argv[0]!.split("/").at(-1)!, status: result.status, timedOut: result.timedOut };
  assert.equal(result.ok, true, "fixed fixture command failed");
  return result.stdout.trim();
}
async function wait(predicate: () => boolean | Promise<boolean>, seconds = 3) {
  const end = performance.now() + seconds * 1000;
  while (performance.now() < end) {
    if (await predicate()) return;
    await delay(30);
  }
  throw new Error("fixture readiness timed out");
}
export function ipv6Ready(raw: string) {
  return (JSON.parse(raw) as { addr_info?: Record<string, unknown>[] }[]).every((link) =>
    (link.addr_info ?? []).every(
      (a) =>
        !a.tentative &&
        !a.dadfailed &&
        !((a.flags ?? []) as string[]).some((f) => f === "tentative" || f === "dadfailed"),
    ),
  );
}
export function checkedRequest(
  value: unknown,
): { op: "tcp" | "udp"; address: string; port: number } | { op: "counts" | "hold" | "pulse" } {
  assert(value && typeof value === "object" && !Array.isArray(value));
  const v = value as Record<string, unknown>;
  if (["counts", "hold", "pulse"].includes(String(v.op))) {
    assert.deepEqual(Object.keys(v), ["op"]);
    return v as { op: "counts" | "hold" | "pulse" };
  }
  assert.deepEqual(Object.keys(v).sort(), ["address", "op", "port"]);
  assert(
    (v.op === "tcp" || v.op === "udp") &&
      typeof v.address === "string" &&
      hosts.has(v.address) &&
      ports.includes(v.port as number),
  );
  return v as { op: "tcp" | "udp"; address: string; port: number };
}
function tcpPulse(socket: Socket, bytes: string, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.off("data", data);
      socket.off("error", error);
      socket.off("close", error);
      resolve(ok);
    };
    const data = (bytes: Buffer) => finish(bytes.equals(Buffer.from("owned-canary")));
    const error = () => finish(false);
    const timer = setTimeout(() => finish(false), timeout);
    socket.once("data", data);
    socket.once("error", error);
    socket.once("close", error);
    socket.write(bytes, (error) => {
      if (error) finish(false);
    });
  });
}
/** The services are synthetic echo targets only; all ports and RPC destinations are fixed. */
export async function services(role: string) {
  assert(["host", ...Object.keys(roles)].includes(role));
  const counts = { tcp: 0, udp: 0 },
    sockets = new Set<Socket>();
  const closes: (() => Promise<void>)[] = [];
  let persistent: Socket | undefined;
  async function exchange(raw: unknown): Promise<unknown> {
    const value = checkedRequest(raw);
    if (value.op === "counts") return { ...counts };
    if (value.op === "hold") {
      assert(!persistent);
      persistent = createConnection({ host: "10.77.11.2", port: 3128 });
      persistent.on("error", () => {});
    }
    if (value.op === "hold" || value.op === "pulse") {
      assert(persistent);
      return { ok: await tcpPulse(persistent, "fixture-pulse", 350) };
    }
    assert("address" in value);
    if (value.op === "tcp") {
      const socket = createConnection({ host: value.address, port: value.port });
      socket.on("error", () => {});
      try {
        return { ok: await tcpPulse(socket, "fixture-request", 350) };
      } finally {
        socket.destroy();
      }
    }
    const socket = createSocket(value.address.includes(":") ? "udp6" : "udp4");
    try {
      return {
        ok: await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 350);
          socket.once("error", () => {
            clearTimeout(timer);
            resolve(false);
          });
          socket.once("message", (bytes) => {
            clearTimeout(timer);
            resolve(bytes.equals(Buffer.from("owned-canary")));
          });
          socket.send("fixture-datagram", value.port, value.address);
        }),
      };
    } finally {
      socket.close();
    }
  }
  try {
    for (const port of ports) {
      const tcp = createServer((socket) => {
        if (sockets.size >= 128) {
          socket.destroy();
          return;
        }
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => {});
        socket.setTimeout(3000, () => socket.destroy());
        socket.on("data", (bytes: Buffer) => {
          if (bytes.length > 64) socket.destroy();
          else {
            counts.tcp++;
            socket.write("owned-canary");
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        tcp.once("error", reject);
        tcp.listen(port, "::", () => {
          tcp.off("error", reject);
          resolve();
        });
      });
      closes.push(() => new Promise((resolve) => tcp.close(() => resolve())));
      const udp = createSocket("udp6");
      udp.on("message", (bytes, peer) => {
        if (bytes.length <= 64) {
          counts.udp++;
          udp.send("owned-canary", peer.port, peer.address);
        }
      });
      await new Promise<void>((resolve, reject) => {
        udp.once("error", reject);
        udp.bind(port, "::", () => {
          udp.off("error", reject);
          resolve();
        });
      });
      closes.push(() => new Promise((resolve) => udp.close(resolve)));
    }
    const rpc = createServer((socket) => {
      if (sockets.size >= 128) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      socket.setTimeout(2000, () => socket.destroy());
      let buffer = Buffer.alloc(0),
        consumed = false;
      socket.on("data", (chunk: Buffer) => {
        if (consumed) {
          socket.destroy();
          return;
        }
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 2048) {
          socket.destroy();
          return;
        }
        if (!buffer.includes(10)) return;
        consumed = true;
        if (buffer.indexOf(10) !== buffer.length - 1) {
          socket.destroy();
          return;
        }
        void Promise.resolve()
          .then(() => exchange(JSON.parse(buffer.toString("utf8"))))
          .then((answer) => socket.end(JSON.stringify(answer) + "\n"))
          .catch(() => socket.destroy());
      });
    });
    await new Promise<void>((resolve, reject) => {
      rpc.once("error", reject);
      rpc.listen(ROOT + "/" + role + ".sock", () => {
        rpc.off("error", reject);
        resolve();
      });
    });
    closes.push(() => new Promise((resolve) => rpc.close(() => resolve())));
  } catch (error) {
    persistent?.destroy();
    for (const socket of sockets) socket.destroy();
    await Promise.allSettled(closes.map((close) => close()));
    throw error;
  }
  return async () => {
    persistent?.destroy();
    for (const socket of sockets) socket.destroy();
    await Promise.all(closes.map((close) => close()));
  };
}
async function rpc(
  role: string,
  value: unknown,
): Promise<{ ok: boolean; tcp: number; udp: number }> {
  assert(["host", ...Object.keys(roles)].includes(role));
  checkedRequest(value);
  return new Promise((resolve, reject) => {
    const socket = createConnection(ROOT + "/" + role + ".sock");
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("fixture RPC timeout"));
    }, 2000);
    const finish = () => {
      clearTimeout(timer);
      socket.destroy();
    };
    socket.once("error", (error) => {
      finish();
      reject(error);
    });
    socket.once("connect", () => socket.write(JSON.stringify(value) + "\n"));
    socket.on("data", (bytes: Buffer) => {
      buffer = Buffer.concat([buffer, bytes]);
      if (buffer.length > 2048) {
        finish();
        reject(new Error("fixture RPC oversized"));
      } else if (buffer.includes(10)) {
        finish();
        try {
          assert.equal(buffer.indexOf(10), buffer.length - 1);
          resolve(JSON.parse(buffer.toString("utf8")));
        } catch (error) {
          reject(error);
        }
      }
    });
  });
}
function save(name: string, value: unknown) {
  writeFileSync(ROOT + "/" + name, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
}
async function reap(children: ChildProcess[]) {
  for (const child of [...children].reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await wait(() => child.exitCode !== null || child.signalCode !== null);
    }
  }
}
async function run() {
  phase = "run-preflight";
  isolated();
  assert(!existsSync(ROOT + "/RESULT.json"));
  const original = namespace();
  const show = await command([
    "/usr/bin/systemctl",
    "show",
    UNIT,
    "--property=PrivateNetwork,RuntimeMaxUSec,KillMode,Restart,MemoryMax,CPUQuotaPerSecUSec",
  ]);
  for (const value of [
    "PrivateNetwork=yes",
    "RuntimeMaxUSec=2min 30s",
    "KillMode=control-group",
    "Restart=no",
    "MemoryMax=268435456",
    "CPUQuotaPerSecUSec=1s",
  ])
    assert(show.split("\n").includes(value));
  assert.deepEqual(JSON.parse(await command(["/usr/sbin/ip", "-json", "route", "show"])), []);
  assert(!(await command(["/usr/sbin/nft", "list", "ruleset"])).includes("table "));
  const children: ChildProcess[] = [],
    anchors: { child: ChildProcess; namespaces: { mnt: string; net: string } }[] = [];
  const result = {
    format: "openbot-native-kernel-egress",
    version: 1,
    accepted: false,
    stage: "topology",
    nativeDeadlineSeconds: 150,
    noExternalRoute: true,
    cases: [] as unknown[],
    squidCompositionQualified: false,
    browserRunscQualified: false,
    productAuthorityQualified: false,
    allCanariesInitiallyReachable: false,
    rulesInstalledInOriginalPrivateNamespace: false,
    originalConnectionRevoked: false,
    ownedChildrenReaped: false,
  };
  const ip = async (...args: string[]) => {
    isolated();
    assert.equal(namespace(), original);
    return command(["/usr/sbin/ip", ...args]);
  };
  const inNs = async (anchor: (typeof anchors)[number], args: string[]) => {
    assert(anchor.child.exitCode === null && anchor.child.signalCode === null && anchor.child.pid);
    const value = await namespaceCommand({
      pid: anchor.child.pid,
      namespaces: anchor.namespaces,
      argv: args,
      environment: ENV,
      timeoutMs: 8000,
    });
    assert.equal(value.ok, true);
    return value.stdout;
  };
  let close: undefined | (() => Promise<void>), failure: unknown;
  try {
    phase = "topology-host";
    writeFileSync("/proc/sys/net/ipv4/ip_forward", "1");
    writeFileSync("/proc/sys/net/ipv6/conf/all/forwarding", "1");
    await ip("addr", "add", "93.184.216.35/32", "dev", "lo");
    close = await services("host");
    for (const [role, [gateway4, address4, gateway6, address6]] of Object.entries(roles)) {
      phase = "topology-" + role;
      const child = spawn("/usr/bin/unshare", ["--net", "/usr/bin/sleep", "145"], {
        env: ENV,
        stdio: "ignore",
      });
      children.push(child);
      await wait(
        () =>
          !!child.pid &&
          child.exitCode === null &&
          child.signalCode === null &&
          readlinkSync(`/proc/${child.pid}/ns/net`) !== original,
      );
      const anchor = {
        child,
        namespaces: {
          mnt: readlinkSync(`/proc/${child.pid}/ns/mnt`),
          net: readlinkSync(`/proc/${child.pid}/ns/net`),
        },
      };
      anchors.push(anchor);
      const host = "ob_" + role,
        peer = "peer_" + role;
      await ip("link", "add", host, "type", "veth", "peer", "name", peer);
      await ip("link", "set", peer, "netns", String(child.pid));
      for (const addr of [gateway4, gateway6])
        await ip("addr", "add", addr, "dev", host, ...(addr.includes(":") ? ["nodad"] : []));
      await ip("link", "set", host, "up");
      await inNs(anchor, ["/usr/sbin/ip", "link", "set", "lo", "up"]);
      await inNs(anchor, ["/usr/sbin/ip", "link", "set", peer, "name", "eth0"]);
      for (const addr of [address4, address6])
        await inNs(anchor, [
          "/usr/sbin/ip",
          "addr",
          "add",
          addr,
          "dev",
          "eth0",
          ...(addr.includes(":") ? ["nodad"] : []),
        ]);
      await inNs(anchor, ["/usr/sbin/ip", "link", "set", "eth0", "up"]);
      await inNs(anchor, [
        "/usr/sbin/ip",
        "route",
        "add",
        "default",
        "via",
        gateway4.split("/")[0]!,
      ]);
      await inNs(anchor, [
        "/usr/sbin/ip",
        "-6",
        "route",
        "add",
        "default",
        "via",
        gateway6.split("/")[0]!,
      ]);
      if (role === "private") {
        await inNs(anchor, ["/usr/sbin/ip", "addr", "add", "169.254.169.254/32", "dev", "lo"]);
        await ip("route", "add", "169.254.169.254/32", "via", "10.77.12.2");
      }
      const fds: number[] = [];
      let service: ChildProcess;
      try {
        fds.push(openNamespace(child.pid!, "mnt", anchor.namespaces.mnt));
        fds.push(openNamespace(child.pid!, "net", anchor.namespaces.net));
        service = spawn(
          "/usr/bin/nsenter",
          [
            "--mount=/proc/self/fd/3",
            "--net=/proc/self/fd/4",
            "--",
            NODE,
            PROGRAM,
            "service",
            role,
            anchor.namespaces.mnt,
            anchor.namespaces.net,
          ],
          { env: ENV, stdio: ["ignore", "ignore", "inherit", fds[0]!, fds[1]!] },
        );
        children.push(service);
      } finally {
        for (const fd of fds) closeSync(fd);
      }
      await wait(
        () =>
          service.exitCode === null &&
          service.signalCode === null &&
          existsSync(ROOT + "/" + role + ".sock"),
      );
    }
    await wait(async () => ipv6Ready(await ip("-6", "-json", "addr", "show")));
    for (const anchor of anchors)
      await wait(async () =>
        ipv6Ready(await inNs(anchor, ["/usr/sbin/ip", "-6", "-json", "addr", "show"])),
      );
    phase = result.stage = "canaries";
    for (const source of ["client", "proxy"])
      for (const [name, , address, port, op] of targets)
        assert(
          (await rpc(source, { op, address, port })).ok,
          source + "/" + name + " unavailable before policy",
        );
    result.allCanariesInitiallyReachable = true;
    phase = result.stage = "policy";
    isolated();
    await command(["/usr/sbin/nft", "--check", "--file", ROOT + "/fixture.nft"]);
    await command(["/usr/sbin/nft", "--file", ROOT + "/fixture.nft"]);
    result.rulesInstalledInOriginalPrivateNamespace = namespace() === original;
    for (const source of ["client", "proxy"])
      for (const [name, target, address, port, op] of targets) {
        if (source === "proxy" && target === "proxy") continue;
        const before = (await rpc(target, { op: "counts" }))[op];
        const answer = (await rpc(source, { op, address, port })).ok;
        const allowed = source === "proxy" && (name === "public-v4" || name === "public-v6");
        const after = (await rpc(target, { op: "counts" }))[op];
        assert.equal(answer, allowed, source + "/" + name);
        assert.equal(after - before, Number(allowed));
        result.cases.push({ source, target: name, allowed, targetRequests: after - before });
      }
    phase = result.stage = "revoke";
    assert((await rpc("client", { op: "hold" })).ok);
    const before = (await rpc("proxy", { op: "counts" })).tcp;
    isolated();
    await command(["/usr/sbin/nft", "flush", "chain", "inet", "openbot_fixture", "admitted"]);
    assert(!(await rpc("client", { op: "pulse" })).ok);
    assert.equal((await rpc("proxy", { op: "counts" })).tcp, before);
    result.originalConnectionRevoked = true;
    result.accepted = true;
    phase = result.stage = "cleanup";
  } catch (error) {
    failure = error;
    Object.assign(result, { failure: diagnostic(error) });
  } finally {
    await reap(children);
    await close?.();
    result.ownedChildrenReaped = children.every(
      (c) => c.exitCode !== null || c.signalCode !== null,
    );
    save("RESULT.json", result);
  }
  if (failure) throw failure;
  assert(result.accepted && result.ownedChildrenReaped);
}
function groupEmpty(path: string, count = { value: 0 }): boolean {
  if (!existsSync(path)) return true;
  assert(++count.value <= 4096);
  assert(lstatSync(path).isDirectory());
  if (readFileSync(path + "/cgroup.procs", "utf8").trim()) return false;
  return readdirSync(path, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .every((e) => groupEmpty(path + "/" + e.name, count));
}
async function launch() {
  phase = "launch-preflight";
  rootOnly();
  assert.equal(namespace(), readlinkSync("/proc/1/ns/net"));
  assert(!existsSync(ROOT + "/STARTED"));
  assert.equal(
    await command(["/usr/bin/systemctl", "show", UNIT, "--property=LoadState", "--value"]),
    "not-found",
  );
  mkdirSync(ROOT + "/docker-config", { mode: 0o700 });
  phase = "host-before";
  const before = await snapshotHost(command, "/usr/bin/docker", ROOT + "/docker-config");
  save("STARTED", { singleUse: true });
  const properties = {
    PrivateNetwork: "yes",
    PrivateMounts: "yes",
    RuntimeMaxSec: "150",
    RuntimeRandomizedExtraSec: "0",
    TimeoutStopSec: "1",
    KillMode: "control-group",
    KillSignal: "SIGKILL",
    FinalKillSignal: "SIGKILL",
    SendSIGKILL: "yes",
    Restart: "no",
    MemoryMax: "256M",
    MemorySwapMax: "0",
    CPUQuota: "100%",
    TasksMax: "160",
  };
  let successful = false;
  let unitExit: { status: number | null; timedOut: boolean; result: string | null } | undefined;
  phase = "unit-run";
  try {
    const runner = new SubprocessCommander({
      binary: "/usr/bin/systemd-run",
      environment: ENV,
      captureLimit: 2 * 1024 ** 2,
    });
    const completed = await runner.run(
      [
        "--unit=" + UNIT,
        "--service-type=exec",
        "--wait",
        "--pipe",
        ...Object.entries(properties).map(([key, value]) => "--property=" + key + "=" + value),
        NODE,
        PROGRAM,
        "run",
      ],
      165000,
    );
    writeFileSync(ROOT + "/RUN.log", completed.stdout + completed.stderr, {
      flag: "wx",
      mode: 0o600,
    });
    successful = completed.ok;
    unitExit = {
      status: completed.status,
      timedOut: completed.timedOut,
      result:
        (completed.stdout + completed.stderr).match(
          /(?:result|Result): (success|exit-code|oom-kill|timeout|signal|core-dump)\b/,
        )?.[1] ?? null,
    };
  } catch {
    /* Fixed public flags never include captured fixture output. */
  } finally {
    phase = "unit-stop";
    // --wait may already have unloaded the transient unit. A failed stop alone does not mean
    // processes survived; the original unit/cgroup and unchanged-host checks below decide that.
    await new SubprocessCommander({
      binary: "/usr/bin/systemctl",
      environment: ENV,
      captureLimit: 16384,
    }).run(["stop", UNIT], 10000);
  }
  phase = "unit-readback";
  const state = await command([
    "/usr/bin/systemctl",
    "show",
    UNIT,
    "--property=ActiveState,MainPID",
  ]);
  assert(
    !state.split("\n").includes("ActiveState=active") && state.split("\n").includes("MainPID=0"),
  );
  phase = "cgroup-empty";
  assert(groupEmpty("/sys/fs/cgroup" + GROUP));
  phase = "host-after";
  assert.deepEqual(await snapshotHost(command, "/usr/bin/docker", ROOT + "/docker-config"), before);
  phase = "result";
  const result = existsSync(ROOT + "/RESULT.json")
    ? JSON.parse(readFileSync(ROOT + "/RESULT.json", "utf8"))
    : { accepted: false };
  Object.assign(result, {
    accepted: result.accepted === true && successful,
    nativeUnitClosed: true,
    productionUnchanged: true,
    existingContainerCount: before.containers.length,
    launcherExit: successful ? 0 : 1,
    unitExit,
    sourceSha256: Object.fromEntries(
      ["network-qualification.cjs", "fixture.nft"].map((name) => [
        name,
        createHash("sha256")
          .update(readFileSync(ROOT + "/" + name))
          .digest("hex"),
      ]),
    ),
  });
  save("FINAL_RESULT.json", result);
  console.log(JSON.stringify(result));
  assert(result.accepted);
}
export async function main(args: string[]) {
  const [mode, role, mnt, net] = args;
  if (mode === "service") {
    assert.equal(args.length, 4);
    assert(role && mnt && net);
    verifyEnteredNamespaces({ mnt, net });
    isolated();
    await services(role);
    return;
  }
  assert.equal(args.length, 1);
  if (mode === "run") await run();
  else {
    assert.equal(mode, "launch");
    await launch();
  }
}
if (process.argv[1]?.endsWith("/network-qualification.cjs"))
  void main(process.argv.slice(2)).catch((error: unknown) => {
    // Only fixed phases, executable basenames, exit facts and a bundled line number are public.
    // Never expose captured service output, RPC bodies, credentials or arbitrary error messages.
    const failure = { accepted: false, failure: diagnostic(error) };
    if (process.argv[2] === "launch" && rootChecked && !existsSync(ROOT + "/FINAL_RESULT.json")) {
      try {
        save("FINAL_RESULT.json", failure);
      } catch {
        /* Preserve the original failure. */
      }
    }
    process.stderr.write("native-kernel-qualification-failed " + JSON.stringify(failure) + "\n");
    process.exitCode = 1;
  });
