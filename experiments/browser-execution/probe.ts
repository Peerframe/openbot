/**
 * Fixed-image CDP qualification only; no Server authority or general browser executor.
 * The NUL-framed CDP transport, which narrowly adapts Playwright v1.62.1 pipeTransport.ts
 * (Copyright 2018 Google Inc. Modifications copyright Microsoft Corporation. Apache-2.0),
 * is in probe-transport.ts with its notice; see accompanying LICENSE/NOTICE.
 * This entry owns only the launch lifecycle, the closed page sequence and budgets.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  type ArtifactSlot,
  domEvidence,
  type PngEvidence,
  pngEvidence,
  proof,
  type RenderProof,
  sandboxProof,
  serialize,
} from "./probe-artifacts.ts";
import {
  errorCode,
  fail,
  isJsonObject,
  type JsonObject,
  LIMITS,
  protocolCode,
} from "./probe-contract.ts";
import { CDPPipe, type CdpCaller, type CdpLifecycle, type CdpMethod } from "./probe-transport.ts";

export type { ArtifactSlot };
// Stable entry: the qualification tests keep importing every public name from probe.ts.
export { CDPPipe, domEvidence, LIMITS, pngEvidence, proof, sandboxProof, serialize };

export const BINARY = "/ms-playwright/chromium-1234/chrome-linux64/chrome";
export const FORBIDDEN: readonly string[] = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-namespace-sandbox",
  "--disable-seccomp-filter-sandbox",
  "--disable-gpu-sandbox",
  "--single-process",
  "--no-zygote",
];
const FIXTURE_URL = "http://127.0.0.1:4197/";
const FIXTURE_PORT = 4197;
const PROFILE = "/profiles/fixture";
const HTML = `<!doctype html><meta charset="utf-8"><title>OpenBot synthetic compatibility</title><body><h1>Synthetic browser proof</h1><pre id="result">pending</pre><script>
const previous=localStorage.getItem('fixture')==='retained';
const cookiePrevious=document.cookie.split('; ').includes('fixture=retained');
localStorage.setItem('fixture','retained');document.cookie='fixture=retained; Max-Age=3600; SameSite=Strict; Path=/';
document.getElementById('result').textContent=JSON.stringify({synthetic:true,sum:12+8+5,text:'a.b 你好',previous,cookiePrevious});
</script>`;
const BROWSER_VERSION = /^HeadlessChrome\/151\.0\.7922\.34$|^Chrome\/151\.0\.7922\.34$/;
const DOM_EXPRESSION =
  "({url:location.href,dom:document.documentElement.outerHTML.slice(0,16000)})";
const DOM_ORIGINS: ReadonlySet<string> = new Set([
  FIXTURE_URL,
  "chrome://sandbox/",
  "chrome://sandbox",
  "about:blank",
]);
const TIMEOUT_FAILURES: ReadonlySet<string> = new Set([
  "cdp-timeout",
  "navigation-event-timeout",
  "budget-exhausted",
]);
const CHILD_OUTPUT_BYTES = 128 * 1024;
const STDERR_TAIL_BYTES = 8192;
const CMDLINE_BYTES = 16384;
const PROCESS_SCAN = 1024;
const PROCESS_ROWS = 64;
const SAMPLE_MS = 250;
const REOPEN_MINIMUM_MS = 10000;

export interface StageRow {
  readonly name: string;
  readonly startedMs: number;
  status: "started" | "ok" | "failed";
  error?: string;
  protocolCode?: number;
  elapsedMs?: number;
}
export interface StageRecord {
  readonly origin: number;
  readonly stages: StageRow[];
}
export interface CdpBrowser {
  readonly cdp: CdpCaller;
}
export interface CdpPageBrowser {
  readonly cdp: CdpCaller & CdpLifecycle;
}
export interface EvaluatedDom extends JsonObject {
  readonly url: string;
  readonly dom: string;
}

/** Bounded role/NNP/seccomp/prohibited-switch observation, never full argv. */
interface ProcessObservation {
  readonly pid: number;
  readonly role: string;
  readonly noNewPrivs: string | undefined;
  readonly seccomp: string | undefined;
  readonly forbiddenSandboxArguments: string[];
}
interface ExitResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: "spawn-error";
}
interface RunArtifacts {
  page?: ArtifactSlot;
  sandbox?: ArtifactSlot;
}
interface RunRow {
  readonly index: 0 | 1;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  oversize: boolean;
  processes: ProcessObservation[];
  readonly artifacts: RunArtifacts;
  browserVersion?: string;
  render?: RenderProof;
  forcedTermination?: boolean;
  stderr?: string;
  stderrSha256?: string;
  outputBytes?: number;
  pipeBytes?: number;
  eventCounts?: Record<string, number>;
  gracefulClose?: boolean;
}
/** One launched browser; finish is idempotent and owns every child resource. */
interface BrowserRun {
  readonly row: RunRow;
  readonly cdp: CDPPipe;
  finish(graceful: boolean): Promise<void>;
  kill(): void;
}
interface ScreenshotMetadata {
  readonly bytes: number;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
}
interface ProbeRecord extends StageRecord {
  readonly kind: "openbot-browser-runsc-compatibility-CDP";
  readonly version: 1;
  readonly node: string;
  readonly uid: number;
  readonly gid: number;
  readonly binary: string;
  readonly sandboxRequestedByDefault: true;
  readonly externalSites: 0;
  readonly modelCalls: 0;
  readonly agentComputerStarted: false;
  readonly runs: RunRow[];
  accepted: boolean;
  readonly guestBudgetMs: number;
  guestTimedOut?: true;
  screenshot?: ScreenshotMetadata;
  sandboxText?: string;
  failure?: string;
  protocolCode?: number;
  elapsedMs?: number;
}
interface ChildPipes {
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly commands: Writable;
  readonly replies: Readable;
}

/** Remaining monotonic budget, capped per operation; an exhausted budget never renews. */
function left(deadline: number, cap: number): number {
  const n = Math.min(cap, deadline - performance.now());
  if (n <= 0) throw fail("budget-exhausted");
  return n;
}

export function chromeArgs(profile: string): string[] {
  return [
    "--headless",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--user-data-dir=" + profile,
    "--window-size=1280,800",
    "--remote-debugging-pipe",
    "about:blank",
  ];
}

function isForbidden(arg: string): boolean {
  return FORBIDDEN.some((f) => arg === f || arg.startsWith(f + "="));
}

function switchName(arg: string): string {
  const separator = arg.indexOf("=");
  return separator < 0 ? arg : arg.slice(0, separator);
}

async function processes(): Promise<ProcessObservation[]> {
  const rows: ProcessObservation[] = [];
  const names = (await readdir("/proc")).filter((x) => /^\d+$/.test(x)).slice(0, PROCESS_SCAN);
  for (const name of names) {
    try {
      const raw = await readFile("/proc/" + name + "/cmdline");
      if (raw.length > CMDLINE_BYTES) continue;
      const args = raw.toString().split("\0").filter(Boolean);
      if (!args[0]?.startsWith("/ms-playwright/")) continue;
      const status = await readFile("/proc/" + name + "/status", "utf8");
      const type = args.find((x) => x.startsWith("--type="))?.slice(7) ?? "browser";
      rows.push({
        pid: Number(name),
        role: type,
        noNewPrivs: /^NoNewPrivs:\s+(\d+)/m.exec(status)?.[1],
        seccomp: /^Seccomp:\s+(\d+)/m.exec(status)?.[1],
        forbiddenSandboxArguments: args.filter(isForbidden).map(switchName),
      });
    } catch {}
  }
  return rows.slice(0, PROCESS_ROWS);
}

export async function stage<T>(
  record: StageRecord,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  const row: StageRow = { name, startedMs: Math.round(started - record.origin), status: "started" };
  record.stages.push(row);
  try {
    const value = await operation();
    row.status = "ok";
    return value;
  } catch (e) {
    row.status = "failed";
    row.error = errorCode(e) ?? "operation-failed";
    const code = protocolCode(e);
    if (code !== undefined) row.protocolCode = code;
    throw e;
  } finally {
    row.elapsedMs = Math.round(performance.now() - started);
  }
}

function childPipes(child: ChildProcess): ChildPipes | undefined {
  const [, stdout, stderr, commands, replies] = child.stdio;
  if (
    !(stdout instanceof Readable) ||
    !(stderr instanceof Readable) ||
    !(commands instanceof Writable) ||
    !(replies instanceof Readable)
  )
    return undefined;
  return { stdout, stderr, commands, replies };
}

function killGroup(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  } catch {}
}

async function launch(record: ProbeRecord, index: 0 | 1, deadline: number): Promise<BrowserRun> {
  const row: RunRow = {
    index,
    code: null,
    signal: null,
    timedOut: false,
    oversize: false,
    processes: [],
    artifacts: {},
  };
  record.runs.push(row);
  const child = spawn(BINARY, chromeArgs(PROFILE), {
    env: { PATH: "/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8" },
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    detached: true,
  });
  const pipes = childPipes(child);
  if (!pipes) {
    killGroup(child);
    throw fail("cdp-pipe-unavailable");
  }
  const { stdout, stderr, commands, replies } = pipes;
  const cdp = new CDPPipe(commands, replies);
  let output = 0;
  let tail: Buffer = Buffer.alloc(0);
  let busy = false;
  const stderrHash = createHash("sha256");
  const seen = new Map<number, ProcessObservation>();
  const kill = (): void => {
    killGroup(child);
    cdp.close("browser-stopped");
  };
  const exited = new Promise<ExitResult>((resolve) => {
    child.once("error", () => {
      cdp.close("spawn-error");
      resolve({ code: null, signal: null, error: "spawn-error" });
    });
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      row.code = code;
      row.signal = signal;
      cdp.close();
      resolve({ code, signal });
    });
  });
  const observe = (stream: Readable, isError: boolean): void => {
    stream.on("data", (b: Buffer) => {
      output += b.length;
      if (isError) {
        stderrHash.update(b);
        tail = Buffer.concat([tail, b]).subarray(-STDERR_TAIL_BYTES);
      }
      if (output > CHILD_OUTPUT_BYTES) {
        row.oversize = true;
        kill();
      }
    });
  };
  observe(stdout, false);
  observe(stderr, true);
  const sample = setInterval(() => {
    if (busy) return;
    busy = true;
    void processes()
      .then((rows) => {
        for (const r of rows) if (seen.size < PROCESS_ROWS || seen.has(r.pid)) seen.set(r.pid, r);
      })
      .catch(() => {})
      .finally(() => {
        busy = false;
      });
  }, SAMPLE_MS);
  let terminated = false;
  async function finish(graceful: boolean): Promise<void> {
    if (terminated) return;
    terminated = true;
    if (graceful && !cdp.closed) {
      await cdp
        .call("Browser.close", {}, "", Math.max(1, Math.min(1500, deadline - performance.now())))
        .catch(() => {});
    }
    const result = await Promise.race([
      exited,
      new Promise<null>((r) => {
        const t = setTimeout(
          () => r(null),
          Math.max(1, Math.min(2000, deadline - performance.now())),
        );
        t.unref();
      }),
    ]);
    if (!result) {
      row.forcedTermination = true;
      kill();
      await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 1000))]);
    }
    clearInterval(sample);
    row.processes = [...seen.values()];
    row.stderr = tail.toString();
    row.stderrSha256 = stderrHash.digest("hex");
    row.outputBytes = output;
    row.pipeBytes = cdp.bytes;
    row.eventCounts = cdp.eventCounts;
    row.gracefulClose = graceful && result?.code === 0 && !result?.signal && !row.forcedTermination;
    cdp.close();
    commands.destroy();
    replies.destroy();
    kill();
  }
  return { row, cdp, finish, kill };
}

export async function page(
  record: StageRecord,
  browser: CdpPageBrowser,
  label: string,
  url: string,
  deadline: number,
  onSession: (session: string) => void = () => {},
): Promise<string> {
  const call = (method: CdpMethod, params: JsonObject = {}, session = "", cap = 3000) =>
    browser.cdp.call(method, params, session, left(deadline, cap));
  const target = await stage(record, label + ".create", () =>
    call("Target.createTarget", { url: "about:blank" }),
  );
  const attached = await stage(record, label + ".attach", () =>
    call("Target.attachToTarget", { targetId: target.targetId, flatten: true }),
  );
  const session = attached.sessionId;
  if (typeof session !== "string" || session.length > 256) throw fail("session-shape");
  onSession(session);
  await stage(record, label + ".page-enable", () => call("Page.enable", {}, session));
  await stage(record, label + ".lifecycle-enable", () =>
    call("Page.setLifecycleEventsEnabled", { enabled: true }, session),
  );
  await stage(record, label + ".viewport", () =>
    call(
      "Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
      session,
    ),
  );
  const nav = await stage(record, label + ".navigate", () =>
    call("Page.navigate", { url }, session, 8000),
  );
  const { errorText, frameId, loaderId } = nav;
  if (errorText || typeof frameId !== "string" || typeof loaderId !== "string")
    throw fail("navigation-refused");
  await stage(record, label + ".domcontentloaded", () =>
    browser.cdp.loaded(session, frameId, loaderId, left(deadline, 8000)),
  );
  return session;
}

export async function captureDOM(
  browser: CdpBrowser,
  session: string,
  artifact: ArtifactSlot,
  deadline: number,
): Promise<EvaluatedDom> {
  artifact.domAttempted = true;
  const value = await browser.cdp.call(
    "Runtime.evaluate",
    { expression: DOM_EXPRESSION, returnByValue: true, timeout: 1500 },
    session,
    left(deadline, 2000),
  );
  const evaluated = isJsonObject(value.result) ? value.result.value : undefined;
  if (value.exceptionDetails || !isJsonObject(evaluated)) throw fail("dom-origin-or-evaluation");
  const { url, dom } = evaluated;
  if (typeof url !== "string" || !DOM_ORIGINS.has(url)) throw fail("dom-origin-or-evaluation");
  const evidence = domEvidence(dom);
  artifact.dom = evidence;
  // The existing origin and DOM checks establish these fields; preserve opaque library fields.
  return evaluated as EvaluatedDom;
}

export async function capturePNG(
  browser: CdpBrowser,
  session: string,
  artifact: ArtifactSlot,
  deadline: number,
): Promise<PngEvidence> {
  artifact.pngAttempted = true;
  const value = await browser.cdp.call(
    "Page.captureScreenshot",
    {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: 1280, height: 800, scale: 1 },
    },
    session,
    left(deadline, 4000),
  );
  const evidence = pngEvidence(value.data);
  artifact.png = evidence;
  return evidence;
}

function nonrootIdentity(): { readonly uid: number; readonly gid: number } {
  const uid =
    process.platform === "linux" && process.arch === "x64" ? process.getuid?.() : undefined;
  const gid = process.getgid?.();
  if (uid === undefined || uid === 0 || gid === undefined)
    throw fail("linux-amd64-nonroot-required");
  return { uid, gid };
}

function fixtureServer() {
  return createServer((request, response) => {
    if (request.url === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url !== "/") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(HTML);
  });
}

function acceptedOutput(output: string): boolean {
  const parsed: unknown = JSON.parse(output);
  return isJsonObject(parsed) && Boolean(parsed.accepted);
}

async function main(): Promise<void> {
  const { uid, gid } = nonrootIdentity();
  const origin = performance.now();
  const workEnd = origin + LIMITS.workMs;
  const evidenceEnd = origin + LIMITS.evidenceMs;
  const totalEnd = origin + LIMITS.totalMs;
  const record: ProbeRecord = {
    kind: "openbot-browser-runsc-compatibility-CDP",
    version: 1,
    origin,
    node: process.versions.node,
    uid,
    gid,
    binary: BINARY,
    sandboxRequestedByDefault: true,
    externalSites: 0,
    modelCalls: 0,
    agentComputerStarted: false,
    runs: [],
    stages: [],
    accepted: false,
    guestBudgetMs: LIMITS.totalMs,
  };
  let current: BrowserRun | null = null;
  let currentSession: string | null = null;
  let currentArtifact: ArtifactSlot | null = null;
  const watchdog = setTimeout(() => {
    record.guestTimedOut = true;
    current?.kill();
  }, LIMITS.totalMs);
  const server = fixtureServer();
  try {
    await mkdir(PROFILE, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(FIXTURE_PORT, "127.0.0.1", () => resolve());
    });
    for (const index of [0, 1] as const) {
      if (index === 1 && workEnd - performance.now() < REOPEN_MINIMUM_MS)
        throw fail("reopen-budget-unavailable");
      const browser = await launch(record, index, totalEnd);
      current = browser;
      currentSession = null;
      const pageArtifact: ArtifactSlot = {};
      browser.row.artifacts.page = pageArtifact;
      currentArtifact = pageArtifact;
      const version = await stage(record, `run${index}.browser-ready`, () =>
        browser.cdp.call("Browser.getVersion", {}, "", left(workEnd, index === 0 ? 30000 : 15000)),
      );
      const product = version.product;
      if (typeof product !== "string" || !BROWSER_VERSION.test(product))
        throw fail("browser-version-mismatch");
      browser.row.browserVersion = product;
      const session = await page(record, browser, `run${index}`, FIXTURE_URL, workEnd, (s) => {
        currentSession = s;
      });
      currentSession = session;
      const dom = await stage(record, `run${index}.dom`, () =>
        captureDOM(browser, session, pageArtifact, workEnd),
      );
      if (dom.url !== FIXTURE_URL) throw fail("synthetic-origin-mismatch");
      const render = proof(dom.dom);
      browser.row.render = render;
      if (render.previous !== (index === 1) || render.cookiePrevious !== (index === 1))
        throw fail("profile-reopen-proof-failed");
      if (index === 0) {
        const screenshot = await stage(record, "run0.png", () =>
          capturePNG(browser, session, pageArtifact, workEnd),
        );
        record.screenshot = {
          bytes: screenshot.bytes,
          sha256: screenshot.sha256,
          width: screenshot.width,
          height: screenshot.height,
        };
        // The diagnostic is an additional target in this same browser, not another launch.
        const diagnostic: ArtifactSlot = {};
        browser.row.artifacts.sandbox = diagnostic;
        currentArtifact = diagnostic;
        currentSession = null;
        const diagnosticSession = await page(
          record,
          browser,
          "sandbox",
          "chrome://sandbox",
          workEnd,
          (s) => {
            currentSession = s;
          },
        );
        const result = await stage(record, "sandbox.dom", () =>
          captureDOM(browser, diagnosticSession, diagnostic, workEnd),
        );
        if (!/^chrome:\/\/sandbox\/?$/.test(result.url)) throw fail("sandbox-origin-mismatch");
        record.sandboxText = sandboxProof(result.dom);
      }
      await stage(record, `run${index}.close`, () => browser.finish(true));
      if (!browser.row.gracefulClose) throw fail("graceful-close-unconfirmed");
      if (
        !browser.row.processes.length ||
        browser.row.processes.some(
          (p) => p.noNewPrivs !== "1" || p.seccomp !== "2" || p.forbiddenSandboxArguments.length,
        )
      )
        throw fail("process-sandbox-observation-failed");
      current = null;
    }
    record.accepted = true;
  } catch (error) {
    const failure = errorCode(error) ?? "operation-failed";
    record.failure = failure;
    const code = protocolCode(error);
    if (code !== undefined) record.protocolCode = code;
    const browser = current;
    const session = currentSession;
    const artifact = currentArtifact;
    if (browser && TIMEOUT_FAILURES.has(failure)) browser.row.timedOut = true;
    if (browser && session && artifact && !browser.cdp.closed && performance.now() < evidenceEnd) {
      if (!artifact.domAttempted)
        await stage(record, "failure.dom", () =>
          captureDOM(browser, session, artifact, evidenceEnd),
        ).catch(() => {});
      if (!artifact.pngAttempted && performance.now() < evidenceEnd)
        await stage(record, "failure.png", () =>
          capturePNG(browser, session, artifact, evidenceEnd),
        ).catch(() => {});
    }
  } finally {
    if (current) await current.finish(false);
    clearTimeout(watchdog);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    record.elapsedMs = Math.round(performance.now() - origin);
    if (record.guestTimedOut) record.accepted = false;
    const output = serialize(record);
    console.log(output);
    process.exitCode = acceptedOutput(output) ? 0 : 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((error: unknown) => {
    console.log(
      JSON.stringify({
        accepted: false,
        phase: "preflight",
        reason: errorCode(error) ?? "preflight-failed",
      }),
    );
    process.exitCode = 2;
  });
