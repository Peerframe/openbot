/** Fixed canaries and relays inside the original private browser unit; no host routing changes. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { command } from "../linux-execution/native-unit.ts";
import { namespaceCommand, openNamespace } from "../linux-execution/namespace-command.ts";
import { exclusive } from "../linux-execution/protected-io.ts";
import { browserUnit } from "./native-browser-contract.ts";
import { openNativeRelay } from "./native-browser-relay.ts";
import { openBrowserCanary } from "./native-browser-canary.ts";
export const browserNativeEnvironment = {
  PATH: "/opt/obp4/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C",
  LC_ALL: "C",
};
export function requireBrowserIsolation(root: string) {
  assert(
    process.platform === "linux" &&
      process.geteuid?.() === 0 &&
      /^\/opt\/obp4\/units\/deadline-a1-p4[a-f0-9]{6}$/.test(root),
  );
  const value = lstatSync(root);
  assert(
    realpathSync(root) === root && value.isDirectory() && value.uid === 0 && !(value.mode & 0o077),
  );
  assert.equal(
    readFileSync("/proc/self/cgroup", "utf8").trim(),
    "0::/system.slice/" + browserUnit(root) + "/supervisor",
  );
  assert.notEqual(
    readlinkSync("/proc/self/ns/net"),
    readlinkSync("/proc/1/ns/net"),
    "Host namespace forbidden",
  );
}
export async function nativeBrowserCompanion(root: string, program: string) {
  requireBrowserIsolation(root);
  const run = command(browserNativeEnvironment),
    children: ChildProcess[] = [],
    relays: Awaited<ReturnType<typeof openNativeRelay>>[] = [];
  let canary: Awaited<ReturnType<typeof openBrowserCanary>> | undefined;
  assert.deepEqual(JSON.parse(await run(["/usr/sbin/ip", "-json", "route", "show"], 8000)), []);
  assert(!(await run(["/usr/sbin/nft", "list", "ruleset"], 8000)).includes("table "));
  await run(
    [
      "/usr/bin/mount",
      "-t",
      "tmpfs",
      "-o",
      "size=256m,nodev,nosuid,noexec,uid=1001,gid=1001,mode=700",
      "tmpfs",
      root + "/profiles",
    ],
    8000,
  );
  writeFileSync("/proc/sys/net/ipv4/ip_forward", "1");
  writeFileSync("/proc/sys/net/ipv6/conf/all/forwarding", "1");
  const ended = new Map<ChildProcess, Promise<void>>();
  const own = (child: ChildProcess) => {
    children.push(child);
    const done = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    done.catch(() => {});
    ended.set(child, done);
    return child;
  };
  const failures: unknown[] = [];
  try {
    for (const [role, gateway4, address4, gateway6, address6] of [
      [
        "public",
        "93.184.216.33/29",
        "93.184.216.34/29",
        "2606:4700:4700:ffee::1/64",
        "2606:4700:4700:ffee::2/64",
      ],
      ["private", "10.77.12.1/30", "10.77.12.2/30", "fd77:12::1/64", "fd77:12::2/64"],
    ] as const) {
      const anchor = own(
        spawn("/usr/bin/unshare", ["--net", "/usr/bin/sleep", "595"], {
          env: browserNativeEnvironment,
          stdio: "ignore",
        }),
      );
      assert(anchor.pid);
      const deadline = performance.now() + 3000;
      while (readlinkSync(`/proc/${anchor.pid}/ns/net`) === readlinkSync("/proc/self/ns/net")) {
        assert(
          anchor.exitCode === null && anchor.signalCode === null && performance.now() < deadline,
          "Namespace readiness unknown",
        );
        await delay(20);
      }
      const namespaces = {
        mnt: readlinkSync(`/proc/${anchor.pid}/ns/mnt`),
        net: readlinkSync(`/proc/${anchor.pid}/ns/net`),
      };
      const child = async (...argv: string[]) => {
        assert(anchor.exitCode === null && anchor.signalCode === null);
        requireBrowserIsolation(root);
        const result = await namespaceCommand({
          pid: anchor.pid!,
          namespaces,
          argv,
          environment: browserNativeEnvironment,
          timeoutMs: 8000,
        });
        assert(result.ok, "Owned namespace command failed");
        return result.stdout;
      };
      const face = "ob_" + role,
        peer = "peer_" + role;
      await run(["/usr/sbin/ip", "link", "add", face, "type", "veth", "peer", "name", peer], 8000);
      await run(["/usr/sbin/ip", "link", "set", peer, "netns", String(anchor.pid)], 8000);
      for (const address of [gateway4, gateway6])
        await run(
          [
            "/usr/sbin/ip",
            "addr",
            "add",
            address,
            "dev",
            face,
            ...(address.includes(":") ? ["nodad"] : []),
          ],
          8000,
        );
      await run(["/usr/sbin/ip", "link", "set", face, "up"], 8000);
      await child("/usr/sbin/ip", "link", "set", "lo", "up");
      await child("/usr/sbin/ip", "link", "set", peer, "name", "eth0");
      for (const address of [address4, address6])
        await child(
          "/usr/sbin/ip",
          "addr",
          "add",
          address,
          "dev",
          "eth0",
          ...(address.includes(":") ? ["nodad"] : []),
        );
      await child("/usr/sbin/ip", "link", "set", "eth0", "up");
      await child("/usr/sbin/ip", "route", "add", "default", "via", gateway4.split("/")[0]!);
      await child("/usr/sbin/ip", "-6", "route", "add", "default", "via", gateway6.split("/")[0]!);
      if (role === "private") {
        await child("/usr/sbin/ip", "addr", "add", "169.254.169.254/32", "dev", "lo");
        await run(
          ["/usr/sbin/ip", "route", "add", "169.254.169.254/32", "via", "10.77.12.2"],
          8000,
        );
      }
      const descriptors: number[] = [];
      try {
        descriptors.push(openNamespace(anchor.pid, "mnt", namespaces.mnt));
        descriptors.push(openNamespace(anchor.pid, "net", namespaces.net));
        own(
          spawn(
            "/usr/bin/nsenter",
            [
              "--mount=/proc/self/fd/3",
              "--net=/proc/self/fd/4",
              "--",
              "/opt/obp4/node",
              program,
              "target",
              "--root",
              root,
            ],
            {
              env: browserNativeEnvironment,
              stdio: ["ignore", "inherit", "inherit", descriptors[0]!, descriptors[1]!],
            },
          ),
        );
      } finally {
        for (const fd of descriptors) closeSync(fd);
      }
    }
    await run(["/usr/sbin/ip", "addr", "add", "93.184.216.35/32", "dev", "lo"], 8000);
    canary = await openBrowserCanary();
    for (const [name, host, port] of [
      ["control", "10.77.10.2", 4100],
      ["target", "93.184.216.34", 18080],
    ] as const) {
      const path = root + "/" + name + ".sock";
      assert(!existsSync(path));
      relays.push(await openNativeRelay({ path }, { host, port }));
    }
    exclusive(root + "/companion-ready.json", {
      ready: true,
      netns: readlinkSync("/proc/self/ns/net"),
    });
    while (children.every((child) => child.exitCode === null && child.signalCode === null))
      await delay(200);
    throw new Error("Owned canary exited");
  } catch (error) {
    failures.push(error);
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    const results = await Promise.allSettled([
      ...[...ended.values()].map(async (done) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            done,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Canary child cleanup unknown")), 3000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }),
      ...relays.map((relay) => relay.close()),
      ...(canary ? [canary.close()] : []),
    ]);
    for (const result of results) if (result.status === "rejected") failures.push(result.reason);
  }
  if (failures.length) throw new AggregateError(failures, "Owned companion closed");
}
