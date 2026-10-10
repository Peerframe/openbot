// Actual Squid fixture, invoked only by qualify-egress.ts in an owned network-none container.
// All synthetic addresses, including public-shaped canaries, belong to its loopback namespace.
import assert from "node:assert/strict";
import { type ChildProcessByStdio, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect as openSocket, type Socket } from "node:net";
import type { Readable } from "node:stream";

const SQUID = "/usr/sbin/squid";
const CONFIG = "/input/squid.conf";
const PROXY_ADDRESS = "10.77.0.1";
const PROXY_PORT = 3128;
const CLIENT_ADDRESS = "10.77.0.2";
const CANARY_PORTS = [18080, 18081, 18443] as const;
const CANARY_BODY = "owned-egress-canary";
const CANARY_REPLY = /owned-egress-canary/;
const FIXTURE_DEADLINE_MS = 120_000;
const REQUEST_TIMEOUT_MS = 4000;
const RESPONSE_CHARS = 65536;
const PARSE_TIMEOUT_MS = 10000;
const PARSE_LOG_CHARS = 32768;
const STDERR_TAIL_CHARS = 16384;
const READY_ATTEMPTS = 50;
const READY_INTERVAL_MS = 100;
const PARSE_DIAGNOSTICS = /ERROR:|WARNING:|FATAL:|SECURITY NOTICE:/;
const LOOPBACK_ADDRESSES = [
  "10.77.0.1",
  "10.77.0.2",
  "10.77.0.3",
  "10.77.0.4",
  "169.254.169.254",
  "93.184.216.34",
  "93.184.216.35",
  "2606:4700:4700::1001",
  "fd77::1",
] as const;
const HOSTS = [
  "93.184.216.34 alpha.example beta.example sub.alpha.example unknown.example",
  "93.184.216.35 control.example",
  "10.77.0.4 private.example",
  "169.254.169.254 metadata.example",
  "2606:4700:4700::1001 ipv6.example",
  "fd77::1 private6.example",
] as const;
/** Targets that must answer directly first, so a later denial cannot pass by absence. */
const DIRECT_TARGETS = [
  "10.77.0.4",
  "169.254.169.254",
  "93.184.216.35",
  "fd77::1",
  "2606:4700:4700::1001",
] as const;

type SquidChild = ChildProcessByStdio<null, null, Readable>;

interface RequestRoute {
  readonly address?: string;
  readonly port?: number;
  readonly source?: string;
  readonly tunnel?: boolean;
}
type ProbeCase = readonly [name: string, payload: string, options?: RequestRoute];
interface CaseResult {
  readonly name: string;
  readonly status: number;
  readonly targetRequests: number;
}
interface EgressResult {
  readonly format: "openbot-real-squid-egress";
  readonly version: 1;
  accepted: boolean;
  readonly network: "none";
  readonly sourceVersion: "7.7";
  readonly sourceCommit: string;
  readonly cases: CaseResult[];
  readonly hostPacketBoundaryQualified: false;
  readonly tlsInspectionQualified: false;
  debianPackage?: string;
  binarySha256?: string;
  configurationParsed?: true;
  directCanariesReachable?: true;
  proxyCleanExit?: true;
  failure?: { readonly name: unknown; readonly message: unknown };
}
interface LinkFacts {
  readonly ifname: unknown;
  readonly flags: unknown;
  readonly addresses: unknown;
}
interface TargetHit {
  readonly address: string | undefined;
  readonly port: number;
  readonly path: string | undefined;
}

function links(value: unknown): LinkFacts[] {
  assert.ok(Array.isArray(value), "ip -json must list interfaces");
  const items: readonly unknown[] = value;
  return items.map((item) => {
    assert.ok(typeof item === "object" && item !== null, "ip -json interface must be an object");
    return {
      ifname: Reflect.get(item, "ifname"),
      flags: Reflect.get(item, "flags"),
      addresses: Reflect.get(item, "addr_info"),
    };
  });
}

function dormant(link: LinkFacts): boolean {
  const { flags, addresses } = link;
  if (!Array.isArray(flags) || !Array.isArray(addresses)) return false;
  const words: readonly unknown[] = flags;
  return !words.includes("UP") && addresses.length === 0;
}

/** Refuse anything but the owned network-none guest, then add only loopback canaries. */
function prepareNamespace(): void {
  assert.equal(process.env.OPENBOT_EGRESS_FIXTURE, "network-none-v1");
  assert.ok(existsSync("/.dockerenv"));
  const interfaces = links(
    JSON.parse(execFileSync("ip", ["-json", "addr", "show"], { encoding: "utf8" })),
  );
  // Linux may materialize dormant default tunnel devices even in network=none.
  // None may be UP or hold an address; the runner separately inspects Docker's network mode.
  assert.ok(interfaces.some((item) => item.ifname === "lo"));
  assert.ok(interfaces.every((item) => item.ifname === "lo" || dormant(item)));
  for (const address of LOOPBACK_ADDRESSES) {
    execFileSync("ip", [
      "addr",
      "add",
      `${address}/${address.includes(":") ? 128 : 32}`,
      "dev",
      "lo",
    ]);
  }
  appendFileSync("/etc/hosts", "\n" + HOSTS.join("\n") + "\n");
}

function request(
  payload: string,
  {
    address = PROXY_ADDRESS,
    port = PROXY_PORT,
    source = CLIENT_ADDRESS,
    tunnel = false,
  }: RequestRoute = {},
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = openSocket({ host: address, port, localAddress: source });
    socket.setTimeout(REQUEST_TIMEOUT_MS, () =>
      socket.destroy(new Error("fixture request timeout")),
    );
    let text = "";
    let tunneled = false;
    socket.on("connect", () => socket.write(payload));
    socket.on("error", reject);
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("latin1");
      if (text.length > RESPONSE_CHARS) {
        socket.destroy(new Error("fixture response overflow"));
        return;
      }
      if (tunnel && !tunneled && /^HTTP\/1\.[01] 200 /.test(text) && text.includes("\r\n\r\n")) {
        tunneled = true;
        socket.write("GET /tunnel HTTP/1.1\r\nHost: beta.example\r\nConnection: close\r\n\r\n");
      }
    });
    socket.on("end", () => resolve(text));
  });
}
const get = (host: string, port = 18080, scheme = "http"): string =>
  `GET ${scheme}://${host}:${port}/probe HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`;
const connect = (host: string, port: number): string =>
  `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`;

const ALLOWED: readonly ProbeCase[] = [
  ["allowed-http-ipv4", get("alpha.example")],
  ["allowed-connect", connect("beta.example", 18443), { tunnel: true }],
  ["allowed-http-ipv6", get("ipv6.example")],
];
const REFUSED: readonly ProbeCase[] = [
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
];

/** Owns the three canary listeners, their accepted sockets and the received-request log. */
function canaryTargets() {
  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  const hits: TargetHit[] = [];
  return {
    count: (): number => hits.length,
    async listen(): Promise<void> {
      for (const port of CANARY_PORTS) {
        const server = createServer((req, res) => {
          hits.push({ address: req.socket.localAddress, port, path: req.url });
          res.writeHead(200, { "content-type": "text/plain", connection: "close" });
          res.end(CANARY_BODY);
        });
        server.on("connection", (socket: Socket) => {
          sockets.add(socket);
          socket.once("close", () => sockets.delete(socket));
        });
        server.listen({ host: "::", port, ipv6Only: false });
        await once(server, "listening");
        servers.push(server);
      }
    },
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
    },
  };
}

// Squid can exit zero after coercing invalid ACLs. Treat parse diagnostics as failures too.
async function parseConfiguration(): Promise<void> {
  const parse = spawn(SQUID, ["-k", "parse", "-f", CONFIG], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let parseLog = "";
  parse.stderr.on("data", (chunk: Buffer) => {
    parseLog += chunk.toString();
    if (parseLog.length > PARSE_LOG_CHARS) parse.kill("SIGKILL");
  });
  const [parsedCode]: unknown[] = await once(parse, "exit", {
    signal: AbortSignal.timeout(PARSE_TIMEOUT_MS),
  });
  assert.equal(parsedCode, 0);
  assert.doesNotMatch(parseLog, PARSE_DIAGNOSTICS);
}

/** Owns the single long-lived Squid process and its bounded stderr tail. */
function squidProxy() {
  let child: SquidChild | undefined;
  let stderr = "";
  return {
    stderr: (): string => stderr,
    start(): Promise<unknown[]> {
      const started = spawn(SQUID, ["-N", "-f", CONFIG], { stdio: ["ignore", "ignore", "pipe"] });
      child = started;
      started.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_CHARS);
      });
      return once(started, "exit");
    },
    async waitReady(): Promise<void> {
      let ready = false;
      for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
        if (child?.exitCode !== null) throw new Error("proxy exited before ready");
        try {
          await request(get("unknown.example"));
          ready = true;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, READY_INTERVAL_MS));
        }
      }
      assert.ok(ready, "proxy listener did not become ready");
    },
    async shutdown(exit: Promise<unknown[]>): Promise<void> {
      child?.kill("SIGTERM");
      await exit;
      assert.equal(child?.exitCode, 0, "Squid did not shut down cleanly");
    },
    kill(): void {
      child?.kill("SIGKILL");
    },
    async release(): Promise<void> {
      if (child && child.exitCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    },
  };
}

function failureOf(error: unknown): { readonly name: unknown; readonly message: unknown } {
  return typeof error === "object" && error !== null
    ? { name: Reflect.get(error, "name"), message: Reflect.get(error, "message") }
    : { name: undefined, message: undefined };
}

prepareNamespace();
const result: EgressResult = {
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
result.binarySha256 = createHash("sha256").update(readFileSync(SQUID)).digest("hex");
const targets = canaryTargets();
const proxy = squidProxy();
const deadline = setTimeout(() => {
  proxy.kill();
  process.exit(124);
}, FIXTURE_DEADLINE_MS);

async function check(
  name: string,
  payload: string,
  allowed: boolean,
  options: RequestRoute = {},
): Promise<void> {
  const before = targets.count();
  const reply = await request(payload, options);
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(reply)?.[1]);
  const targetRequests = targets.count() - before;
  if (allowed) {
    assert.equal(status, 200, name);
    assert.match(reply, CANARY_REPLY, name);
    assert.equal(targetRequests, 1, name);
  } else {
    assert.equal(status, 403, name);
    assert.equal(targetRequests, 0, name);
  }
  result.cases.push({ name, status, targetRequests });
}

try {
  await parseConfiguration();
  result.configurationParsed = true;
  await targets.listen();
  for (const address of DIRECT_TARGETS) {
    const reply = await request(
      "GET /direct HTTP/1.1\r\nHost: canary\r\nConnection: close\r\n\r\n",
      { address, port: 18080, source: address.includes(":") ? "::1" : CLIENT_ADDRESS },
    );
    assert.match(reply, CANARY_REPLY);
  }
  result.directCanariesReachable = true;
  const exit = proxy.start();
  await proxy.waitReady();
  for (const [name, payload, options] of ALLOWED) await check(name, payload, true, options);
  for (const [name, payload, options] of REFUSED) await check(name, payload, false, options);
  await proxy.shutdown(exit);
  result.proxyCleanExit = true;
  result.accepted = true;
} catch (error) {
  result.failure = failureOf(error);
  writeFileSync("/output/squid-stderr.log", proxy.stderr());
  process.exitCode = 1;
} finally {
  await proxy.release();
  await targets.close();
  clearTimeout(deadline);
  writeFileSync("/output/GUEST_RESULT.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
}
