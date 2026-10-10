/** Disposable native browser composition: one PID1 lifetime, actual proxy/kernel/TLS checks and original cleanup. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { readKernelText } from "../linux-execution/output-capacity.ts";
import { verifyEnteredNamespaces } from "../linux-execution/namespace-command.ts";
import { compileEgressPolicy } from "../browser-execution/egress-policy.ts";
import {
  BrowserLifetime,
  browserBase,
  browserPacket,
  browserProgram,
  browserNode,
  browserNow,
  browserRead,
  browserWait,
  type BrowserArmed,
} from "./native-browser-lifetime.ts";
import {
  browserConfigurations,
  browserSocketPaths,
  browserSystemdArguments,
  loadedBrowserImage,
  validateBrowserRuntime,
  validateBrowserSocketPaths,
  validateBrowserUnit,
} from "./native-browser-contract.ts";
import {
  browserCommon,
  createCompositionBrowser,
  replaceCompositionBrowser,
} from "./native-browser-container.ts";
import {
  browserNativeEnvironment,
  nativeBrowserCompanion,
  requireBrowserIsolation,
} from "./native-browser-companion.ts";
import { openBrowserCanary } from "./native-browser-canary.ts";
import { snapshotHost } from "./native-host-baseline.ts";
import { nativeBrowserStages } from "./native-browser-protocol.ts";
function stage(name: string) {
  assert(nativeBrowserStages.some((value) => value === name));
  process.stderr.write("native-browser-stage:" + name + "\n");
}
async function daemon(c: BrowserLifetime) {
  requireBrowserIsolation(c.root);
  const companion = spawn(browserNode, [browserProgram, "companion", "--root", c.root], {
    env: browserNativeEnvironment,
    stdio: "inherit",
  });
  let companionClosed = false;
  companion.once("error", () => {
    companionClosed = true;
  });
  companion.once("exit", () => {
    companionClosed = true;
  });
  await browserWait(
    () => {
      assert(!companionClosed, "Owned companion failed");
      return existsSync(c.root + "/companion-ready.json") || undefined;
    },
    browserNow() + 8,
    "owned companion",
  );
  const group = "/sys/fs/cgroup/system.slice/" + c.unit;
  assert.equal(readKernelText(group + "/cgroup.procs").trim(), "");
  const controllers = ["cpu", "memory", "pids", "io", "cpuset"],
    available = readKernelText(group + "/cgroup.controllers").split(/\s+/);
  assert(controllers.every((v) => available.includes(v)));
  writeFileSync(
    group + "/cgroup.subtree_control",
    controllers
      .sort()
      .map((v) => "+" + v)
      .join(" "),
  );
  const producer = (name: string, args: string[]) => {
    const child = spawn(browserBase + "/bin/" + name, args, {
      env: browserNativeEnvironment,
      stdio: "inherit",
    });
    let closed = false;
    const done = new Promise<void>((resolve) => {
      child.once("error", () => {
        closed = true;
        resolve();
      });
      child.once("exit", () => {
        closed = true;
        resolve();
      });
    });
    return { child, done, alive: () => !closed };
  };
  const containerd = producer("containerd", ["--config", c.root + "/config/containerd.toml"]);
  c.receipt("containerd-pid.json", { pid: containerd.child.pid });
  await browserWait(
    () => {
      assert(containerd.alive());
      return existsSync(c.root + "/containerd.sock") || undefined;
    },
    browserNow() + 8,
    "private containerd",
  );
  const docker = producer("dockerd", ["--config-file=" + c.root + "/config/daemon.json"]);
  // PID1 retains this wrapper and every child. The original companion anchors end at 595s;
  // their late exit must not replace the declared 600s unit timeout with an early wrapper exit.
  await Promise.race([containerd.done, docker.done]);
  throw new Error("Private daemon exited before PID1 expiry");
}
async function canaries() {
  const targets = [
    "93.184.216.34",
    "2606:4700:4700:ffee::2",
    "10.77.12.2",
    "fd77:12::2",
    "169.254.169.254",
    "93.184.216.35",
    "10.77.10.1",
  ];
  for (const target of targets) {
    const response = await fetch(
      "http://" + (target.includes(":") ? "[" + target + "]" : target) + ":18080/hits",
      { signal: AbortSignal.timeout(3000), redirect: "error" },
    );
    assert.equal(response.status, 200);
    const body = await response.text();
    assert(Buffer.byteLength(body) <= 1024);
    assert(Number.isSafeInteger(JSON.parse(body).requests));
  }
  return targets;
}
async function run(c: BrowserLifetime) {
  stage("packet");
  const manifest = c.verifyFiles();
  assert.equal((await c.show()).LoadState, "not-found");
  validateBrowserSocketPaths(browserSocketPaths(c.root));
  stage("allocate");
  mkdirSync(c.root, { mode: 0o700 });
  for (const name of ["docker-config", "config", "profiles", "commands"])
    mkdirSync(c.root + "/" + name, { mode: 0o700 });
  c.receipt("ownership.json", {
    root: c.root,
    unit: c.unit,
    runtimeSeconds: 600,
    case: "browser-composition",
  });
  c.receipt("packet-manifest.json", manifest);
  const snapshot = () =>
      snapshotHost(c.run, browserBase + "/bin/docker", c.root + "/docker-config"),
    before = await snapshot();
  c.receipt("before.json", before);
  const { daemon, containerd } = browserConfigurations(c.root, browserBase + "/bin");
  c.receipt("config/daemon.json", daemon);
  writeFileSync(c.root + "/config/containerd.toml", containerd, { flag: "wx", mode: 0o600 });
  const policy = {
    listen_address: "10.77.11.2",
    listen_port: 3128,
    client_address: "10.77.10.2",
    origins: [
      ...[
        "example.com",
        "ipv6.example",
        "private.example",
        "metadata.example",
        "control.example",
      ].map((host) => ({ scheme: "http", host, port: 18080 })),
      ...[
        ["example.com", 18443],
        ["wrong.example", 18443],
        ["example.com", 18444],
      ].map(([host, port]) => ({ scheme: "https", host, port })),
    ],
    forbidden_networks: ["93.184.216.35/32"],
  };
  writeFileSync(c.root + "/config/squid.conf", compileEgressPolicy(policy), {
    flag: "wx",
    mode: 0o444,
  });
  chmodSync(c.root + "/config/squid.conf", 0o444);
  const result: Record<string, unknown> = {
    format: "openbot-linux-browser-composition",
    version: 1,
    accepted: false,
    nativeDeadlineSeconds: 600,
    publicInternetQualified: false,
  };
  let armed: BrowserArmed | undefined;
  try {
    stage("unit");
    const argv = browserSystemdArguments(c.root, true, browserNode, browserProgram);
    c.receipt("start-reserved.json", { arguments: argv });
    await c.run(argv);
    const value: Record<string, string> = { ...(await c.show()), ...(await c.stopHooks()) };
    c.receipt("unit.json", value);
    const deadline = validateBrowserUnit(c.root, value, true),
      group = "/sys/fs/cgroup" + value.ControlGroup,
      pid = Number(value.MainPID);
    assert(Number.isSafeInteger(pid) && pid > 0);
    armed = {
      unit: c.unit,
      invocation: value.InvocationID!,
      deadline,
      group: value.ControlGroup!,
      inode: lstatSync(group).ino,
      pid,
      namespaces: {
        net: readlinkSync(`/proc/${pid}/ns/net`),
        mnt: readlinkSync(`/proc/${pid}/ns/mnt`),
      },
    };
    c.receipt("native.json", armed);
    stage("daemon");
    const info = await browserWait(
      async () => {
        try {
          return JSON.parse(await c.docker(["info", "--format", "{{json .}}"], 2000));
        } catch {
          return undefined;
        }
      },
      Math.min(deadline - 450, browserNow() + 20),
      "private Docker",
    );
    assert.equal(info.DockerRootDir, c.root + "/docker-data");
    assert.equal(info.Containerd.Address, c.root + "/containerd.sock");
    assert.equal(info.ServerVersion, "29.8.1");
    assert.equal(String(info.CgroupVersion), "2");
    validateBrowserRuntime(info, browserBase + "/bin");
    stage("images");
    for (const [name, archive] of [
      ["chromium", browserBase + "/downloads/playwright-1.62.1-linux-amd64.tar"],
      ["squid", browserPacket + "/squid-image.tar"],
    ] as const) {
      c.receipt(name + "-load-reserved.json", { path: archive });
      await c.docker(["load", "--input", archive], 110000);
    }
    const chromium = await loadedBrowserImage((id) => c.image(id));
    c.receipt("browser-image.json", chromium);
    await c.docker([
      "image",
      "tag",
      c.plan.squid.manifest,
      "openbot-squid77-debian-fixture:20260926",
    ]);
    const squid = JSON.parse(
      await c.docker(["image", "inspect", "openbot-squid77-debian-fixture:20260926"]),
    )[0];
    assert(
      [c.plan.squid.config, c.plan.squid.manifest].includes(squid.Id) &&
        squid.Architecture === "amd64",
    );
    stage("networks");
    for (const [role, subnet, gateway, v6, gw6] of [
      ["client", "10.77.10.0/30", "10.77.10.1", "fd77:10::/64", "fd77:10::1"],
      ["proxy", "10.77.11.0/30", "10.77.11.1", "fd77:11::/64", "fd77:11::1"],
    ] as const)
      await c.docker([
        "network",
        "create",
        "--driver",
        "bridge",
        "--ipv6",
        "--subnet",
        subnet,
        "--gateway",
        gateway,
        "--subnet",
        v6,
        "--gateway",
        gw6,
        "--opt",
        "com.docker.network.bridge.name=ob_" + role,
        "--opt",
        "com.docker.network.bridge.enable_ip_masquerade=false",
        "composition-" + role,
      ]);
    stage("canaries");
    c.receipt("canary-readiness.json", {
      reachable: JSON.parse(
        await c.inside([browserNode, browserProgram, "canaries", "--root", c.root]),
      ),
    });
    await c.inside(["/usr/sbin/nft", "--check", "--file", browserPacket + "/fixture.nft"]);
    await c.inside(["/usr/sbin/nft", "--file", browserPacket + "/fixture.nft"]);
    c.receipt("network.json", {
      rules: await c.inside(["/usr/sbin/nft", "--json", "list", "ruleset"]),
      routes: await c.inside(["/usr/sbin/ip", "-json", "route", "show"]),
    });
    stage("proxy");
    const proxy = [
      ...browserCommon("composition-proxy", "composition-proxy", "10.77.11.2", "256m"),
      "--ip6",
      "fd77:11::2",
      "--user",
      "13:13",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=32m,uid=13,gid=13,mode=700",
      "--mount",
      "type=bind,src=" + c.root + "/config/squid.conf,dst=/squid.conf,readonly",
    ];
    for (const [host, address] of [
      ["example.com", "93.184.216.34"],
      ["wrong.example", "93.184.216.34"],
      ["ipv6.example", "2606:4700:4700:ffee::2"],
      ["private.example", "10.77.12.2"],
      ["metadata.example", "169.254.169.254"],
      ["control.example", "93.184.216.35"],
    ])
      proxy.push("--add-host", host + ":" + address);
    proxy.push("--entrypoint", "/usr/sbin/squid", squid.Id, "-NYCd1", "-f", "/squid.conf");
    c.receipt("proxy-create-reserved.json", { image: squid.Id });
    const proxyId = await c.docker(proxy);
    assert(/^[a-f0-9]{64}$/.test(proxyId));
    c.receipt("proxy-start-reserved.json", { id: proxyId });
    await c.docker(["start", proxyId]);
    stage("browser");
    const browserId = await createCompositionBrowser(c, 1),
      sockets = JSON.parse(
        await c.docker(["exec", browserId, "/usr/bin/node", "/socket_probe.mjs"], 25000),
      );
    assert.equal(sockets.accepted, true);
    c.receipt("socket-result.json", sockets);
    stage("tls");
    const tls = [];
    for (const [label, url, expected] of [
      ["trusted", "https://example.com:18443/", 200],
      ["wrong-host", "https://wrong.example:18443/", 502],
      ["unknown-ca", "https://example.com:18444/", 502],
    ] as const) {
      const { status, body } = await c.relay("control", "/navigate", { url });
      c.receipt("tls-" + label + ".json", { status, response: body });
      assert.equal(status, expected, "Chromium TLS policy: " + label);
      if (expected === 502) assert(JSON.stringify(body).includes("ERR_CERT_"));
      tls.push({ case: label, status });
    }
    assert.equal((await c.relay("control", "/computers/stop", {})).status, 200);
    c.receipt("tls-result.json", { accepted: true, cases: tls, certificateErrorsIgnored: false });
    const health = await c.relay("control", "/health");
    assert.equal(health.status, 200);
    c.receipt("ready.json", { browserId, proxyId, health: health.body, nativeDeadline: deadline });
    stage("product");
    while (!existsSync(c.root + "/finish.json")) {
      await c.original();
      await delay(500);
    }
    assert.deepEqual(browserRead(c.root + "/finish.json"), { productAccepted: true });
    stage("revoke");
    const active = (await c.inspect("composition-browser-2")).Id;
    assert(typeof active === "string" && /^[a-f0-9]{64}$/.test(active));
    await c.docker(["exec", "--detach", active, "/usr/bin/node", "/tunnel_probe.mjs"]);
    const guest = async (name: string) => {
      assert(["tunnel-ready.json", "tunnel-result.json"].includes(name));
      try {
        return JSON.parse(
          await c.docker(
            [
              "exec",
              active,
              "/usr/bin/node",
              "-e",
              "process.stdout.write(require('node:fs').readFileSync('/tmp/" + name + "','utf8'))",
            ],
            2000,
          ),
        );
      } catch {
        return undefined;
      }
    };
    const tunnel = await browserWait(
      () => guest("tunnel-ready.json"),
      browserNow() + 8,
      "verified open TLS tunnel",
    );
    assert.deepEqual(tunnel, { verifiedTLS: true, baseline: true });
    const hits = (await c.relay("target", "/hits")).body;
    await c.inside(["/usr/sbin/nft", "flush", "chain", "inet", "openbot_composition", "admitted"]);
    await c.docker([
      "exec",
      active,
      "/usr/bin/node",
      "-e",
      "require('node:fs').writeFileSync('/tmp/tunnel-revoked','closed')",
    ]);
    const revoked = await browserWait(
      () => guest("tunnel-result.json"),
      browserNow() + 8,
      "existing tunnel revocation",
    );
    assert.equal(revoked.accepted, true);
    assert.deepEqual((await c.relay("target", "/hits")).body, hits);
    c.receipt("revoked.json", revoked);
    Object.assign(result, {
      accepted: true,
      actualSquid: true,
      actualRunsc: true,
      actualProductJourney: true,
      kernelSocketCases: sockets.cases,
    });
  } catch (error) {
    result.failureType = error instanceof Error ? error.name : "UnknownError";
    result.failure = error instanceof Error ? error.message : "Unknown failure";
    c.receipt("failure.json", result);
  } finally {
    if (armed)
      try {
        stage("expiry");
        await c.closeOriginal(armed, result.accepted === true);
        result[result.accepted ? "originalNativeExpiryVerified" : "failedOriginalUnitClosed"] =
          true;
        stage("cleanup");
        for (const name of ["docker-data", "docker-exec", "containerd-data", "containerd-state"]) {
          const path = c.root + "/" + name;
          if (existsSync(path)) {
            assert(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink());
            rmSync(path, { recursive: true });
          }
        }
        if (result.accepted) await c.run(["/usr/bin/systemctl", "reset-failed", c.unit]);
        const after = await snapshot();
        c.receipt("after.json", after);
        assert.deepEqual(after, before, "Production state changed");
        Object.assign(result, {
          productionUnchanged: true,
          existingContainerCount: before.containers.length,
          ownedRuntimeRemoved: true,
        });
      } catch (error) {
        result.cleanupFailure = error instanceof Error ? error.message : "Unknown cleanup failure";
        result.accepted = false;
      }
    else {
      result.accepted = false;
      result.cleanupFailure = "Native identity unconfirmed";
    }
    c.receipt("result.json", result);
  }
  return result.accepted === true ? 0 : 2;
}
async function main() {
  process.umask(0o077);
  stage("entry");
  const c = new BrowserLifetime(),
    args = process.argv.slice(2),
    operation = args[0];
  assert(
    ["run", "daemon", "companion", "target", "canaries", "restart", "finish", "abort"].includes(
      operation!,
    ),
  );
  assert(args.length === 1 || (args.length === 3 && args[1] === "--root" && args[2] === c.root));
  if (operation === "run") return await run(c);
  if (operation === "daemon") await daemon(c);
  else if (operation === "companion") await nativeBrowserCompanion(c.root, browserProgram);
  else if (operation === "target") {
    requireBrowserIsolation(c.root);
    verifyEnteredNamespaces({
      mnt: readlinkSync("/proc/self/ns/mnt"),
      net: readlinkSync("/proc/self/ns/net"),
    });
    await openBrowserCanary({ tlsDirectory: browserPacket + "/tls" });
  } else if (operation === "canaries") {
    await c.original();
    assert.equal(readlinkSync("/proc/self/ns/net"), (await c.original()).namespaces.net);
    verifyEnteredNamespaces({
      mnt: readlinkSync("/proc/self/ns/mnt"),
      net: readlinkSync("/proc/self/ns/net"),
    });
    console.log(JSON.stringify(await canaries()));
  } else if (operation === "restart")
    console.log(JSON.stringify(await replaceCompositionBrowser(c)));
  else {
    await c.original();
    c.receipt("finish.json", { productAccepted: operation === "finish" });
  }
  return 0;
}
if (process.argv[1]?.endsWith("/browser-native.cjs"))
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(
        "native-browser-failed:" + (error instanceof Error ? error.name : "UnknownError") + "\n",
      );
      process.exitCode = 1;
    },
  );
