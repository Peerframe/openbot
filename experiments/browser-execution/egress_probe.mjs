// Actual Squid fixture, invoked only by qualify_egress.py in an owned network-none container.
// All synthetic addresses, including public-shaped canaries, belong to its loopback namespace.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";

assert.equal(process.env.OPENBOT_EGRESS_FIXTURE, "network-none-v1");
assert.ok(existsSync("/.dockerenv"));
const interfaces = JSON.parse(execFileSync("ip", ["-json", "addr", "show"], { encoding: "utf8" }));
// Linux may materialize dormant default tunnel devices even in network=none.
// None may be UP or hold an address; the runner separately inspects Docker's network mode.
assert.ok(interfaces.some((item) => item.ifname === "lo"));
assert.ok(
  interfaces.every(
    (item) => item.ifname === "lo" || (!item.flags.includes("UP") && item.addr_info.length === 0),
  ),
);
const addresses = [
  "10.77.0.1",
  "10.77.0.2",
  "10.77.0.3",
  "10.77.0.4",
  "169.254.169.254",
  "93.184.216.34",
  "93.184.216.35",
  "2606:4700:4700::1001",
  "fd77::1",
];
for (const address of addresses) {
  execFileSync("ip", [
    "addr",
    "add",
    `${address}/${address.includes(":") ? 128 : 32}`,
    "dev",
    "lo",
  ]);
}
appendFileSync(
  "/etc/hosts",
  "\n" +
    [
      "93.184.216.34 alpha.example beta.example sub.alpha.example unknown.example",
      "93.184.216.35 control.example",
      "10.77.0.4 private.example",
      "169.254.169.254 metadata.example",
      "2606:4700:4700::1001 ipv6.example",
      "fd77::1 private6.example",
    ].join("\n") +
    "\n",
);

const binary = "/usr/sbin/squid";
const config = "/input/squid.conf";
const result = {
  format: "openbot-real-squid-egress",
  version: 1,
  accepted: false,
  network: "none",
  sourceVersion: "7.7",
  sourceCommit: "173863d3ec547d7fc5227ddbb5d8093c88b4842f",
  cases: [],
  hostPacketBoundaryQualified: false,
  tlsInspectionQualified: false,
};
assert.equal(
  execFileSync("dpkg-query", ["-W", "-f=${Version}", "squid"], { encoding: "utf8" }),
  "7.7-1",
);
result.debianPackage = "7.7-1";
result.binarySha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
let proxy;
let stderr = "";
const servers = [];
const hits = [];
const sockets = new Set();
const deadline = setTimeout(() => {
  proxy?.kill("SIGKILL");
  process.exit(124);
}, 120_000);

function request(
  payload,
  { address = "10.77.0.1", port = 3128, source = "10.77.0.2", tunnel = false } = {},
) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port, localAddress: source });
    socket.setTimeout(4000, () => socket.destroy(new Error("fixture request timeout")));
    let text = "",
      tunneled = false;
    socket.on("connect", () => socket.write(payload));
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      text += chunk.toString("latin1");
      if (text.length > 65536) return socket.destroy(new Error("fixture response overflow"));
      if (tunnel && !tunneled && /^HTTP\/1\.[01] 200 /.test(text) && text.includes("\r\n\r\n")) {
        tunneled = true;
        socket.write("GET /tunnel HTTP/1.1\r\nHost: beta.example\r\nConnection: close\r\n\r\n");
      }
    });
    socket.on("end", () => resolve(text));
  });
}
const get = (host, port = 18080, scheme = "http") =>
  `GET ${scheme}://${host}:${port}/probe HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`;
const connect = (host, port) =>
  `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`;

try {
  // Squid can exit zero after coercing invalid ACLs. Treat parse diagnostics as failures too.
  const parse = spawn(binary, ["-k", "parse", "-f", config], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let parseLog = "";
  parse.stderr.on("data", (chunk) => {
    parseLog += chunk.toString();
    if (parseLog.length > 32768) parse.kill("SIGKILL");
  });
  const [parsedCode] = await once(parse, "exit", { signal: AbortSignal.timeout(10000) });
  assert.equal(parsedCode, 0);
  assert.doesNotMatch(parseLog, /ERROR:|WARNING:|FATAL:|SECURITY NOTICE:/);
  result.configurationParsed = true;
  for (const port of [18080, 18081, 18443]) {
    const server = http.createServer((req, res) => {
      hits.push({ address: req.socket.localAddress, port, path: req.url });
      res.writeHead(200, { "content-type": "text/plain", connection: "close" });
      res.end("owned-egress-canary");
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.listen({ host: "::", port, ipv6Only: false });
    await once(server, "listening");
    servers.push(server);
  }
  // Prove private/metadata/control/IPv6 targets are reachable without the proxy.
  // A later denial cannot pass merely because a target was absent.
  for (const address of [
    "10.77.0.4",
    "169.254.169.254",
    "93.184.216.35",
    "fd77::1",
    "2606:4700:4700::1001",
  ]) {
    const reply = await request(
      "GET /direct HTTP/1.1\r\nHost: canary\r\nConnection: close\r\n\r\n",
      { address, port: 18080, source: address.includes(":") ? "::1" : "10.77.0.2" },
    );
    assert.match(reply, /owned-egress-canary/);
  }
  result.directCanariesReachable = true;
  proxy = spawn(binary, ["-N", "-f", config], { stdio: ["ignore", "ignore", "pipe"] });
  proxy.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-16384);
  });
  const exit = once(proxy, "exit");
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (proxy.exitCode !== null) throw new Error("proxy exited before ready");
    try {
      await request(get("unknown.example"));
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.ok(ready, "proxy listener did not become ready");

  async function check(name, payload, allowed, options = {}) {
    const before = hits.length;
    const reply = await request(payload, options);
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(reply)?.[1]);
    const targetRequests = hits.length - before;
    if (allowed) {
      assert.equal(status, 200, name);
      assert.match(reply, /owned-egress-canary/, name);
      assert.equal(targetRequests, 1, name);
    } else {
      assert.equal(status, 403, name);
      assert.equal(targetRequests, 0, name);
    }
    result.cases.push({ name, status, targetRequests });
  }
  await check("allowed-http-ipv4", get("alpha.example"), true);
  await check("allowed-connect", connect("beta.example", 18443), true, { tunnel: true });
  await check("allowed-http-ipv6", get("ipv6.example"), true);
  for (const [name, payload, options] of [
    ["foreign-client", get("alpha.example"), { source: "10.77.0.3" }],
    ["unknown-host", get("unknown.example")],
    ["subdomain", get("sub.alpha.example")],
    ["http-wrong-port", get("alpha.example", 18081)],
    ["cross-origin-port", get("alpha.example", 18443)],
    ["connect-to-http-only", connect("alpha.example", 18080)],
    ["http-to-connect-only", get("beta.example", 18443)],
    ["ftp-to-http-origin", get("alpha.example", 18080, "ftp")],
    ["numeric-public", get("93.184.216.34")],
    ["numeric-mapped-public", get("[::ffff:93.184.216.34]")],
    ["numeric-private", get("10.77.0.4")],
    ["private-dns", get("private.example")],
    ["numeric-integer", get("1572395042")],
    ["numeric-hex", get("0x5db8d822")],
    ["metadata-dns", get("metadata.example")],
    ["management-dns", get("control.example")],
    ["private-ipv6-dns", get("private6.example")],
  ])
    await check(name, payload, false, options);

  proxy.kill("SIGTERM");
  await exit;
  assert.equal(proxy.exitCode, 0, "Squid did not shut down cleanly");
  result.proxyCleanExit = true;
  result.accepted = true;
} catch (error) {
  result.failure = { name: error.name, message: error.message };
  writeFileSync("/output/squid-stderr.log", stderr);
  process.exitCode = 1;
} finally {
  if (proxy && proxy.exitCode === null) {
    proxy.kill("SIGKILL");
    await once(proxy, "exit");
  }
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  clearTimeout(deadline);
  writeFileSync("/output/RESULT.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
}
