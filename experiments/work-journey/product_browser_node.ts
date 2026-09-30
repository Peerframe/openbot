import {
  type ChildProcess,
  type ChildProcessByStdio,
  execFile,
  type SpawnOptions,
  spawn,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type ResponseLossRelay, responseLossRelay } from "./browser_response_loss.ts";
import { startProbeClient } from "./product_browser_client.ts";
import {
  type BrowserProbeInput,
  type ControlLoop,
  type ControlRequest,
  hasErrorCode,
  jsonRecord,
  type ProbeClientConfig,
  parseBrowserProbeInput,
  readStdinJson,
  startControlLoop,
} from "./probe-inputs.ts";

type TargetState = { submitted: unknown } & Record<string, unknown>;
type NodeProcessEvent =
  | { pid: number | undefined; event: "start" }
  | { pid: number | undefined; event: "exit"; signal: NodeJS.Signals | null };
interface Stoppable {
  stop(): Promise<void>;
}

const CLIENT_ENTRY = fileURLToPath(new URL("./product_browser_client.ts", import.meta.url));
const CONTROL_MAXIMUM_ID = 8;
const SERVICE_STOP_MS = 10000;
const NODE_STOP_MS = 5000;
const NODE_READY_MS = 10000;
const HEALTH_ATTEMPTS = 100;
const HEALTH_TIMEOUT_MS = 100;
const HEALTH_INTERVAL_MS = 50;
const PS_OPTIONS = { timeout: 3000, maxBuffer: 1024 * 1024 };
const execute = promisify(execFile);

const BASE_PAGE = `<!doctype html><meta charset="utf-8"><title>Owned browser task fixture</title><style>body{font:24px system-ui;margin:40px;background:#eef7f1}input{position:absolute;left:40px;top:140px;width:520px;height:45px;font:24px system-ui}button{position:absolute;left:40px;top:220px;height:50px}#result{position:absolute;top:300px}#bottom{margin-top:1500px}</style><h1>OpenBot browser task</h1><form><input aria-label="Fixture text"><button>Save synthetic entry</button></form><p id="result">Waiting for input</p><p id="bottom">Scroll target</p><script>const f=document.querySelector('input');f.value=localStorage.getItem('entry')||'';function report(){fetch('/event',{method:'POST',body:JSON.stringify({text:f.value,submitted:Number(document.body.dataset.count||0),scroll:scrollY,stored:localStorage.getItem('entry')||''})})}f.oninput=report;onscroll=report;document.querySelector('form').onsubmit=e=>{e.preventDefault();document.body.dataset.count=Number(document.body.dataset.count||0)+1;localStorage.setItem('entry',f.value);document.querySelector('#result').textContent='Saved: '+f.value;report()};report();</script>`;
const PROFILE_REPORT = "stored:localStorage.getItem('entry')||''";
const PROFILE_REPORT_FIELDS =
  "stored:localStorage.getItem('entry')||'',persistentCookie:document.cookie.includes('fixture_expiry=retained'),sessionCookie:document.cookie.includes('fixture_session=temporary'),indexedDB:window.persistedValue||''";
const PROFILE_SCRIPT = `<script>const opening=indexedDB.open('profile-fixture',1);opening.onupgradeneeded=()=>opening.result.createObjectStore('entries');opening.onsuccess=()=>{const db=opening.result;const read=db.transaction('entries').objectStore('entries').get('saved');read.onsuccess=()=>{window.persistedValue=read.result||'';report()};document.querySelector('form').addEventListener('submit',()=>{document.cookie='fixture_expiry=retained;Max-Age=86400;SameSite=Strict;Path=/';document.cookie='fixture_session=temporary;SameSite=Strict;Path=/';const tx=db.transaction('entries','readwrite');tx.objectStore('entries').put('synthetic-indexed-value','saved');tx.oncomplete=()=>{window.persistedValue='synthetic-indexed-value';report()}})};</script>`;

function targetPage(profileRestart: boolean): string {
  if (!profileRestart) return BASE_PAGE;
  return BASE_PAGE.replace(PROFILE_REPORT, PROFILE_REPORT_FIELDS) + PROFILE_SCRIPT;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function listenLoopback(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Owned loopback listener has no port");
  return address.port;
}

/** Independent synthetic page; Python reads /state to verify submissions and profile data. */
async function startTarget(
  page: string,
  state: TargetState,
): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    if (req.url === "/state") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(state));
      return;
    }
    if (req.url === "/event") {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      const event: unknown = JSON.parse(body);
      if (typeof event === "object" && event !== null) Object.assign(state, event);
      res.end("ok");
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(page);
  });
  return { server, url: `http://127.0.0.1:${await listenLoopback(server)}` };
}

async function reservePort(): Promise<number> {
  const server = createServer();
  const port = await listenLoopback(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** The exact owned Bun browser service; Chromium is matched only among its direct children. */
class OwnedBrowserService {
  readonly #options: SpawnOptions;
  readonly #profileArgument: string;
  #child: ChildProcess;

  constructor(options: SpawnOptions, profileArgument: string) {
    this.#options = options;
    this.#profileArgument = profileArgument;
    this.#child = spawn("bun", ["src/index.ts"], options);
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  replace(): void {
    this.#child = spawn("bun", ["src/index.ts"], this.#options);
  }

  async ready(computerUrl: string): Promise<void> {
    for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt++) {
      if (this.#child.exitCode !== null) throw new Error("Upstream exited");
      try {
        const signal = AbortSignal.timeout(HEALTH_TIMEOUT_MS);
        if ((await fetch(`${computerUrl}/health`, { signal })).ok) return;
      } catch {
        // Not listening yet; the bounded attempt count decides failure.
      }
      await delay(HEALTH_INTERVAL_MS);
    }
    throw new Error("Upstream timeout");
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit", { signal: AbortSignal.timeout(SERVICE_STOP_MS) });
    child.kill("SIGTERM");
    try {
      await exited;
    } catch {
      child.kill("SIGKILL");
      await once(child, "exit");
      throw new Error("Owned browser service did not close gracefully");
    }
    if (child.exitCode !== 0) throw new Error("Owned browser service failed while closing");
  }

  async browserPid(): Promise<number> {
    // Headless shell does not create SingletonLock. Read only PID/parent ids globally, then
    // inspect arguments of exact children of this owned service; never collect other argv.
    const servicePid = this.#child.pid;
    const { stdout } = await execute("/bin/ps", ["-A", "-o", "pid=,ppid="], PS_OPTIONS);
    const children = stdout
      .trim()
      .split("\n")
      .map((row) => row.trim().split(/\s+/u).map(Number))
      .filter((row) => row.length === 2 && row[1] === servicePid);
    const matches: number[] = [];
    for (const row of children) {
      const pid = row[0];
      if (pid === undefined) continue;
      const listed = await execute("/bin/ps", ["-p", String(pid), "-o", "args="], PS_OPTIONS);
      if (listed.stdout.trim().split(/\s+/u).includes(this.#profileArgument)) matches.push(pid);
    }
    const [owned] = matches;
    if (matches.length !== 1 || owned === undefined)
      throw new Error("Expected exactly one owned Chromium process");
    return owned;
  }
}

/** Owns the in-process client or the exact Node child for the current credential. */
class ProbeNode {
  readonly #nodeProcess: boolean;
  readonly #directory: string;
  readonly #config: (credential: string) => ProbeClientConfig;
  readonly #events: NodeProcessEvent[] = [];
  #client: Stoppable | undefined;
  #child: ChildProcessByStdio<Writable, Readable, null> | undefined;

  constructor(input: BrowserProbeInput, config: (credential: string) => ProbeClientConfig) {
    this.#nodeProcess = input.nodeProcess;
    this.#directory = input.directory;
    this.#config = config;
  }

  async start(credential: string): Promise<void> {
    const config = this.#config(credential);
    if (!this.#nodeProcess) {
      this.#client = await startProbeClient(config);
      return;
    }
    const child = spawn(process.execPath, ["--import", "tsx", CLIENT_ENTRY], {
      env: process.env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.#child = child;
    const ready = once(child.stdout, "data", { signal: AbortSignal.timeout(NODE_READY_MS) });
    child.stdin.end(JSON.stringify(config));
    this.#client = { stop: () => this.stopChild() };
    const [line]: unknown[] = await ready;
    const started: unknown = JSON.parse(String(line));
    if (
      typeof started !== "object" ||
      started === null ||
      !("started" in started) ||
      started.started !== true
    )
      throw new Error("Node child failed");
    await this.#record({ pid: child.pid, event: "start" });
  }

  async stopChild(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const child = this.#child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit", { signal: AbortSignal.timeout(NODE_STOP_MS) });
    child.kill(signal);
    try {
      await exited;
    } catch {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    await this.#record({ pid: child.pid, event: "exit", signal: child.signalCode });
  }

  /** A child is killed abruptly; the in-process client closes through its own lifecycle. */
  async disconnect(): Promise<void> {
    if (this.#nodeProcess) await this.stopChild("SIGKILL");
    else await this.#client?.stop();
  }

  async stop(): Promise<void> {
    await this.#client?.stop();
  }

  async #record(event: NodeProcessEvent): Promise<void> {
    this.#events.push(event);
    await writeFile(`${this.#directory}/node-processes.json`, JSON.stringify(this.#events));
  }
}

async function restartBrowserService(
  service: OwnedBrowserService,
  directory: string,
  computerUrl: string,
): Promise<void> {
  const oldService = service.pid;
  const oldBrowser = await service.browserPid();
  await service.stop();
  let gone = false;
  try {
    process.kill(oldBrowser, 0);
  } catch (error) {
    if (!hasErrorCode(error, "ESRCH")) throw error;
    gone = true;
  }
  if (!gone) throw new Error("Original Chromium survived graceful service shutdown");
  service.replace();
  if (service.pid === oldService) throw new Error("Service PID was reused");
  await service.ready(computerUrl);
  await writeFile(
    `${directory}/browser-processes.json`,
    JSON.stringify({ oldService, oldBrowser, newService: service.pid, oldBrowserExited: true }),
  );
}

async function readBackBrowser(service: OwnedBrowserService, directory: string): Promise<void> {
  const path = `${directory}/browser-processes.json`;
  const evidence = jsonRecord(JSON.parse(await readFile(path, "utf8")), "browser evidence");
  const newBrowser = await service.browserPid();
  if (newBrowser === evidence.oldBrowser) throw new Error("Chromium PID was reused");
  await writeFile(path, JSON.stringify({ ...evidence, newBrowser }));
}

const input = parseBrowserProbeInput(await readStdinJson(process.stdin));
const state: TargetState = { text: "", submitted: 0, scroll: 0, stored: "" };
const target = await startTarget(targetPage(input.profileRestart), state);
const port = await reservePort();
const token = randomBytes(32).toString("hex");
await mkdir(`${input.directory}/profiles`, { recursive: true, mode: 0o700 });
await mkdir(`${input.directory}/workspace`, { recursive: true, mode: 0o700 });
const service = new OwnedBrowserService(
  {
    cwd: input.upstream,
    env: {
      ...process.env,
      PORT: String(port),
      COMPUTER_TOKEN: token,
      PROFILES_DIR: `${input.directory}/profiles`,
      WORKSPACE_DIR: `${input.directory}/workspace`,
      COMPUTER_MAX_BROWSERS: "2",
      NAVIGATION_TIMEOUT_MS: "5000",
      ACTION_TIMEOUT_MS: "3000",
    },
    stdio: ["ignore", "ignore", "inherit"],
  },
  `--user-data-dir=${input.directory}/profiles/${input.botId}`,
);
const computerUrl = `http://127.0.0.1:${port}`;
let relay: ResponseLossRelay | undefined;
let controlLoop: ControlLoop | undefined;
let stopped = false;
const node = new ProbeNode(input, (credential) => ({
  nodeId: input.nodeId,
  serverUrl: input.serverUrl,
  credential,
  directory: input.directory,
  computerUrl: relay?.url ?? computerUrl,
  token,
  targetUrl: target.url,
}));

async function stop(): Promise<void> {
  if (stopped) return;
  stopped = true;
  controlLoop?.close();
  try {
    await node.stop();
  } finally {
    relay?.close();
    try {
      await service.stop();
    } finally {
      target.server.closeAllConnections();
      target.server.close();
    }
  }
}

async function applyControl(request: ControlRequest, connected: boolean): Promise<boolean> {
  if (request.operation === "disconnect" && connected) {
    await node.disconnect();
    return false;
  }
  if (request.operation === "connect" && !connected) {
    await node.start(request.credential ?? input.credential);
    return true;
  }
  if (request.operation === "browser-restart" && connected) {
    await restartBrowserService(service, input.directory, computerUrl);
    return true;
  }
  if (request.operation === "browser-readback" && connected) {
    await readBackBrowser(service, input.directory);
    return true;
  }
  throw new Error("Invalid fixture lifecycle transition");
}

process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
try {
  await service.ready(computerUrl);
  if (input.responseLoss) {
    relay = await responseLossRelay(computerUrl, state, async (value) => {
      await writeFile(`${input.directory}/response-loss.json`, JSON.stringify(value));
    });
  }
  await node.start(input.credential);
  if (input.recovery) {
    // Private fixture controls call the real Node lifecycle; no production transport hook.
    let connected = true;
    controlLoop = startControlLoop({
      directory: input.directory,
      maximumId: CONTROL_MAXIMUM_ID,
      refusal: "Invalid fixture control id",
      isStopped: () => stopped,
      stop,
      handle: async (request) => {
        connected = await applyControl(request, connected);
      },
    });
  }
  process.stdout.write(`${JSON.stringify({ started: true, targetUrl: target.url })}\n`);
} catch (error) {
  await stop();
  throw error;
}
