/**
 * Fixed-image CDP qualification only; no Server authority or general browser executor.
 * NUL framing narrowly adapts Playwright v1.62.1 pipeTransport.ts behavior.
 * Copyright 2018 Google Inc. Modifications copyright Microsoft Corporation.
 * Licensed under Apache-2.0; see accompanying LICENSE/NOTICE. OpenBot adds bounds.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { crc32, inflateSync } from "node:zlib";
import { pathToFileURL } from "node:url";

export const LIMITS = Object.freeze({
  frame: 384 * 1024,
  wire: 2 * 1024 * 1024,
  dom: 16 * 1024,
  png: 192 * 1024,
  result: 512 * 1024,
  workMs: 58000,
  evidenceMs: 62000,
  totalMs: 65000,
});
export const BINARY = "/ms-playwright/chromium-1234/chrome-linux64/chrome";
export const FORBIDDEN = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-namespace-sandbox",
  "--disable-seccomp-filter-sandbox",
  "--disable-gpu-sandbox",
  "--single-process",
  "--no-zygote",
];
const URL = "http://127.0.0.1:4197/";
const HTML = `<!doctype html><meta charset="utf-8"><title>OpenBot synthetic compatibility</title><body><h1>Synthetic browser proof</h1><pre id="result">pending</pre><script>
const previous=localStorage.getItem('fixture')==='retained';
const cookiePrevious=document.cookie.split('; ').includes('fixture=retained');
localStorage.setItem('fixture','retained');document.cookie='fixture=retained; Max-Age=3600; SameSite=Strict; Path=/';
document.getElementById('result').textContent=JSON.stringify({synthetic:true,sum:12+8+5,text:'a.b 你好',previous,cookiePrevious});
</script>`;
const hash = (b) => createHash("sha256").update(b).digest("hex");
const fail = (code) => Object.assign(new Error(code), { code });
const left = (deadline, cap) => {
  const n = Math.min(cap, deadline - performance.now());
  if (n <= 0) throw fail("budget-exhausted");
  return n;
};
export function proof(dom) {
  const value = JSON.parse(/<pre id="result">([^<]+)<\/pre>/.exec(dom)?.[1] ?? "null");
  if (
    value?.synthetic !== true ||
    value.sum !== 25 ||
    value.text !== "a.b 你好" ||
    typeof value.previous !== "boolean" ||
    typeof value.cookiePrevious !== "boolean"
  )
    throw fail("render-proof-missing");
  return value;
}
export function domEvidence(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > LIMITS.dom) throw fail("dom-bound");
  return { text, bytes: Buffer.byteLength(text), sha256: hash(text) };
}
export function pngEvidence(data) {
  if (
    typeof data !== "string" ||
    data.length > Math.ceil(LIMITS.png / 3) * 4 ||
    !/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
  )
    throw fail("png-bound");
  const b = Buffer.from(data, "base64");
  if (
    b.toString("base64") !== data ||
    b.length < 24 ||
    b.length > LIMITS.png ||
    !b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    b.readUInt32BE(16) !== 1280 ||
    b.readUInt32BE(20) !== 800
  )
    throw fail("screenshot-proof-missing");
  let offset = 8,
    channels = 0,
    ended = false;
  const idat = [];
  while (offset < b.length) {
    if (offset + 12 > b.length) throw fail("png-chunk");
    const size = b.readUInt32BE(offset),
      end = offset + 12 + size;
    if (end > b.length) throw fail("png-chunk");
    const type = b.toString("ascii", offset + 4, offset + 8),
      payload = b.subarray(offset + 8, end - 4);
    if (crc32(b.subarray(offset + 4, end - 4)) !== b.readUInt32BE(end - 4)) throw fail("png-crc");
    if (offset === 8) {
      if (
        type !== "IHDR" ||
        size !== 13 ||
        payload[8] !== 8 ||
        ![2, 6].includes(payload[9]) ||
        payload[10] ||
        payload[11] ||
        payload[12]
      )
        throw fail("png-format");
      channels = payload[9] === 6 ? 4 : 3;
    } else if (type === "IHDR") throw fail("png-chunk");
    if (type === "IDAT") idat.push(payload);
    if (type === "IEND") {
      if (size !== 0 || end !== b.length) throw fail("png-chunk");
      ended = true;
    }
    offset = end;
  }
  if (!ended || !idat.length) throw fail("png-chunk");
  const row = 1 + 1280 * channels,
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: 800 * row });
  if (raw.length !== 800 * row) throw fail("png-pixels");
  for (let y = 0; y < 800; y++) if (raw[y * row] > 4) throw fail("png-filter");
  return { base64: data, bytes: b.length, sha256: hash(b), width: 1280, height: 800 };
}
export function chromeArgs(profile) {
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
const METHODS = new Set([
  "Browser.getVersion",
  "Browser.close",
  "Target.createTarget",
  "Target.attachToTarget",
  "Page.enable",
  "Page.setLifecycleEventsEnabled",
  "Page.navigate",
  "Runtime.evaluate",
  "Emulation.setDeviceMetricsOverride",
  "Page.captureScreenshot",
]);
export class CDPPipe {
  constructor(write, read) {
    this.write = write;
    this.read = read;
    this.pending = new Map();
    this.waiters = new Set();
    this.events = [];
    this.nextId = 0;
    this.buffer = Buffer.alloc(0);
    this.bytes = 0;
    this.closed = false;
    this.eventCounts = {};
    read.on("data", (b) => this.receive(b));
    read.on("end", () => this.close("pipe-ended"));
    read.on("close", () => this.close("pipe-closed"));
    read.on("error", () => this.close("pipe-read-error"));
    write.on("error", () => this.close("pipe-write-error"));
  }
  close(reason = "pipe-closed") {
    if (this.closed) return;
    this.closed = true;
    this.reason = reason;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(fail(reason));
    }
    this.pending.clear();
    for (const p of this.waiters) {
      clearTimeout(p.timer);
      p.reject(fail(reason));
    }
    this.waiters.clear();
    this.buffer = Buffer.alloc(0);
  }
  receive(chunk) {
    if (this.closed) return;
    try {
      this.bytes += chunk.length;
      if (this.bytes > LIMITS.wire) throw fail("pipe-total-bound");
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const end = this.buffer.indexOf(0);
        if (end < 0) {
          if (this.buffer.length > LIMITS.frame) throw fail("pipe-frame-bound");
          break;
        }
        if (end > LIMITS.frame) throw fail("pipe-frame-bound");
        const v = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(this.buffer.subarray(0, end)),
        );
        this.buffer = this.buffer.subarray(end + 1);
        if (!v || typeof v !== "object" || Array.isArray(v)) throw fail("pipe-json-shape");
        if (Object.hasOwn(v, "id")) {
          if (!Number.isSafeInteger(v.id) || v.id <= 0) throw fail("pipe-response-id");
          const p = this.pending.get(v.id);
          if (!p) continue;
          if ((v.sessionId ?? "") !== p.session) throw fail("pipe-session-mismatch");
          clearTimeout(p.timer);
          this.pending.delete(v.id);
          if (v.error) {
            const error = fail("cdp-protocol-error");
            if (Number.isSafeInteger(v.error.code)) error.protocolCode = v.error.code;
            p.reject(error);
          } else if (!v.result || typeof v.result !== "object" || Array.isArray(v.result))
            p.reject(fail("pipe-result-shape"));
          else p.resolve(v.result);
        } else if (
          ["Page.lifecycleEvent", "Inspector.targetCrashed", "Target.targetCrashed"].includes(
            v.method,
          )
        ) {
          this.eventCounts[v.method] = (this.eventCounts[v.method] ?? 0) + 1;
          this.events.push(v);
          if (this.events.length > 128) this.events.shift();
          for (const p of [...this.waiters])
            if (p.matches(v)) {
              clearTimeout(p.timer);
              this.waiters.delete(p);
              p.resolve(v.params);
            }
        }
      }
    } catch (error) {
      this.close(error.code ?? "pipe-malformed-json");
    }
  }
  call(method, params = {}, session = "", timeout = 1000) {
    if (this.closed) return Promise.reject(fail(this.reason));
    if (!METHODS.has(method) || this.pending.size >= 16 || ++this.nextId > 96 || !(timeout > 0))
      return Promise.reject(fail("request-bound"));
    const id = this.nextId,
      message = { id, method, params, ...(session ? { sessionId: session } : {}) };
    const bytes = Buffer.from(JSON.stringify(message) + "\0");
    if (bytes.length > 32768) return Promise.reject(fail("request-bound"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(fail("cdp-timeout"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, session });
      this.write.write(bytes, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(fail("pipe-write-error"));
        }
      });
    });
  }
  loaded(session, frameId, loaderId, timeout) {
    const matches = (v) =>
      v.method === "Page.lifecycleEvent" &&
      v.sessionId === session &&
      v.params?.frameId === frameId &&
      v.params?.loaderId === loaderId &&
      v.params?.name === "DOMContentLoaded";
    const found = this.events.find(matches);
    if (found) return Promise.resolve(found.params);
    if (this.closed) return Promise.reject(fail(this.reason));
    return new Promise((resolve, reject) => {
      const p = { resolve, reject, matches };
      p.timer = setTimeout(() => {
        this.waiters.delete(p);
        reject(fail("navigation-event-timeout"));
      }, timeout);
      this.waiters.add(p);
    });
  }
}
async function processes() {
  const rows = [];
  for (const name of (await readdir("/proc")).filter((x) => /^\d+$/.test(x)).slice(0, 1024)) {
    try {
      const raw = await readFile("/proc/" + name + "/cmdline");
      if (raw.length > 16384) continue;
      const args = raw.toString().split("\0").filter(Boolean);
      if (!args[0]?.startsWith("/ms-playwright/")) continue;
      const status = await readFile("/proc/" + name + "/status", "utf8");
      const type = args.find((x) => x.startsWith("--type="))?.slice(7) ?? "browser";
      rows.push({
        pid: Number(name),
        role: ["browser", "zygote", "renderer", "gpu-process", "utility"].includes(type)
          ? type
          : "other",
        noNewPrivs: /^NoNewPrivs:\s+(\d+)/m.exec(status)?.[1],
        seccomp: /^Seccomp:\s+(\d+)/m.exec(status)?.[1],
        forbiddenSandboxArguments: args
          .filter((arg) => FORBIDDEN.some((f) => arg === f || arg.startsWith(f + "=")))
          .map((arg) => arg.split("=")[0]),
      });
    } catch {}
  }
  return rows.slice(0, 64);
}
export async function stage(record, name, operation) {
  const started = performance.now(),
    row = { name, startedMs: Math.round(started - record.origin), status: "started" };
  record.stages.push(row);
  try {
    const value = await operation();
    row.status = "ok";
    return value;
  } catch (e) {
    row.status = "failed";
    row.error = e.code ?? "operation-failed";
    if (Number.isSafeInteger(e.protocolCode)) row.protocolCode = e.protocolCode;
    throw e;
  } finally {
    row.elapsedMs = Math.round(performance.now() - started);
  }
}
async function launch(record, index, deadline) {
  const row = {
    index,
    code: null,
    signal: null,
    timedOut: false,
    oversize: false,
    processes: [],
    artifacts: {},
  };
  record.runs.push(row);
  const child = spawn(BINARY, chromeArgs("/profiles/fixture"), {
    env: { PATH: "/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8" },
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    detached: true,
  });
  const cdp = new CDPPipe(child.stdio[3], child.stdio[4]);
  let output = 0,
    tail = Buffer.alloc(0),
    busy = false;
  const stderrHash = createHash("sha256"),
    seen = new Map();
  const kill = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
    cdp.close("browser-stopped");
  };
  const exited = new Promise((resolve) => {
    child.once("error", () => {
      cdp.close("spawn-error");
      resolve({ code: null, signal: null, error: "spawn-error" });
    });
    child.once("close", (code, signal) => {
      row.code = code;
      row.signal = signal;
      cdp.close();
      resolve({ code, signal });
    });
  });
  for (const [stream, isError] of [
    [child.stdout, false],
    [child.stderr, true],
  ])
    stream.on("data", (b) => {
      output += b.length;
      if (isError) {
        stderrHash.update(b);
        tail = Buffer.concat([tail, b]).subarray(-8192);
      }
      if (output > 128 * 1024) {
        row.oversize = true;
        kill();
      }
    });
  const sample = setInterval(() => {
    if (busy) return;
    busy = true;
    void processes()
      .then((rows) => {
        for (const r of rows) if (seen.size < 64 || seen.has(r.pid)) seen.set(r.pid, r);
      })
      .catch(() => {})
      .finally(() => (busy = false));
  }, 250);
  let terminated = false;
  async function finish(graceful) {
    if (terminated) return;
    terminated = true;
    if (graceful && !cdp.closed) {
      await cdp
        .call("Browser.close", {}, "", Math.max(1, Math.min(1500, deadline - performance.now())))
        .catch(() => {});
    }
    const result = await Promise.race([
      exited,
      new Promise((r) => {
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
      await Promise.race([exited, new Promise((r) => setTimeout(r, 1000))]);
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
    child.stdio[3].destroy();
    child.stdio[4].destroy();
    kill();
  }
  return { row, cdp, finish, kill };
}
export async function page(record, browser, label, url, deadline, onSession = () => {}) {
  const call = (m, p = {}, s = "", cap = 3000) => browser.cdp.call(m, p, s, left(deadline, cap));
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
  if (nav.errorText || typeof nav.frameId !== "string" || typeof nav.loaderId !== "string")
    throw fail("navigation-refused");
  await stage(record, label + ".domcontentloaded", () =>
    browser.cdp.loaded(session, nav.frameId, nav.loaderId, left(deadline, 8000)),
  );
  return session;
}
const DOM_EXPRESSION =
  "({url:location.href,dom:document.documentElement.outerHTML.slice(0,16000)})";
export async function captureDOM(browser, session, artifact, deadline) {
  artifact.domAttempted = true;
  const value = await browser.cdp.call(
    "Runtime.evaluate",
    { expression: DOM_EXPRESSION, returnByValue: true, timeout: 1500 },
    session,
    left(deadline, 2000),
  );
  if (
    value.exceptionDetails ||
    !value.result?.value ||
    ![URL, "chrome://sandbox/", "chrome://sandbox", "about:blank"].includes(value.result.value.url)
  )
    throw fail("dom-origin-or-evaluation");
  artifact.dom = domEvidence(value.result.value.dom);
  return value.result.value;
}
export async function capturePNG(browser, session, artifact, deadline) {
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
  artifact.png = pngEvidence(value.data);
  return artifact.png;
}
export function sandboxProof(text) {
  const clean = text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 6000);
  if (
    !/Seccomp-BPF sandbox\s+Yes/i.test(clean) ||
    !/Layer 1 Sandbox\s+Namespace/i.test(clean) ||
    !/PID namespaces\s+Yes/i.test(clean) ||
    !/Network namespaces\s+Yes/i.test(clean)
  )
    throw fail("internal-sandbox-diagnostic-not-confirmed");
  return clean;
}
export function serialize(record) {
  const value = { ...record };
  delete value.origin;
  let result = JSON.stringify(value);
  if (Buffer.byteLength(result) > LIMITS.result) {
    value.accepted = false;
    value.failure = "record-bound";
    for (const run of value.runs ?? [])
      for (const artifact of Object.values(run.artifacts ?? {})) {
        if (artifact.dom) delete artifact.dom.text;
        if (artifact.png) delete artifact.png.base64;
      }
    result = JSON.stringify(value);
    if (Buffer.byteLength(result) > LIMITS.result) throw fail("record-bound");
  }
  return result;
}
async function main() {
  if (process.platform !== "linux" || process.arch !== "x64" || process.getuid() === 0)
    throw fail("linux-amd64-nonroot-required");
  const origin = performance.now(),
    workEnd = origin + LIMITS.workMs,
    evidenceEnd = origin + LIMITS.evidenceMs,
    totalEnd = origin + LIMITS.totalMs;
  const record = {
    kind: "openbot-browser-runsc-compatibility-CDP",
    version: 1,
    origin,
    node: process.versions.node,
    uid: process.getuid(),
    gid: process.getgid(),
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
  let current = null,
    currentSession = null,
    currentArtifact = null;
  const watchdog = setTimeout(() => {
    record.guestTimedOut = true;
    current?.kill();
  }, LIMITS.totalMs);
  const server = createServer((request, response) => {
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
  try {
    await mkdir("/profiles/fixture", { recursive: true });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(4197, "127.0.0.1", resolve);
    });
    for (const index of [0, 1]) {
      if (index === 1 && workEnd - performance.now() < 10000)
        throw fail("reopen-budget-unavailable");
      current = await launch(record, index, totalEnd);
      currentSession = null;
      currentArtifact = current.row.artifacts.page = {};
      const version = await stage(record, "run" + index + ".browser-ready", () =>
        current.cdp.call("Browser.getVersion", {}, "", left(workEnd, index === 0 ? 30000 : 15000)),
      );
      if (
        !/^HeadlessChrome\/151\.0\.7922\.34$|^Chrome\/151\.0\.7922\.34$/.test(version.product ?? "")
      )
        throw fail("browser-version-mismatch");
      current.row.browserVersion = version.product;
      currentSession = await page(
        record,
        current,
        "run" + index,
        URL,
        workEnd,
        (session) => (currentSession = session),
      );
      const dom = await stage(record, "run" + index + ".dom", () =>
        captureDOM(current, currentSession, currentArtifact, workEnd),
      );
      if (dom.url !== URL) throw fail("synthetic-origin-mismatch");
      current.row.render = proof(dom.dom);
      if (
        current.row.render.previous !== (index === 1) ||
        current.row.render.cookiePrevious !== (index === 1)
      )
        throw fail("profile-reopen-proof-failed");
      if (index === 0) {
        const screenshot = await stage(record, "run0.png", () =>
          capturePNG(current, currentSession, currentArtifact, workEnd),
        );
        record.screenshot = {
          bytes: screenshot.bytes,
          sha256: screenshot.sha256,
          width: screenshot.width,
          height: screenshot.height,
        };
        // The diagnostic is an additional target in this same browser, not another launch.
        const diagnostic = {};
        current.row.artifacts.sandbox = diagnostic;
        currentArtifact = diagnostic;
        currentSession = null;
        const diagnosticSession = await page(
          record,
          current,
          "sandbox",
          "chrome://sandbox",
          workEnd,
          (session) => (currentSession = session),
        );
        const result = await stage(record, "sandbox.dom", () =>
          captureDOM(current, diagnosticSession, diagnostic, workEnd),
        );
        if (!/^chrome:\/\/sandbox\/?$/.test(result.url)) throw fail("sandbox-origin-mismatch");
        record.sandboxText = sandboxProof(result.dom);
      }
      await stage(record, "run" + index + ".close", () => current.finish(true));
      if (!current.row.gracefulClose) throw fail("graceful-close-unconfirmed");
      if (
        !current.row.processes.length ||
        current.row.processes.some(
          (p) => p.noNewPrivs !== "1" || p.seccomp !== "2" || p.forbiddenSandboxArguments.length,
        )
      )
        throw fail("process-sandbox-observation-failed");
      current = null;
    }
    record.accepted = true;
  } catch (error) {
    record.failure = error.code ?? "operation-failed";
    if (Number.isSafeInteger(error.protocolCode)) record.protocolCode = error.protocolCode;
    if (
      current &&
      ["cdp-timeout", "navigation-event-timeout", "budget-exhausted"].includes(record.failure)
    )
      current.row.timedOut = true;
    if (
      current &&
      currentSession &&
      currentArtifact &&
      !current.cdp.closed &&
      performance.now() < evidenceEnd
    ) {
      if (!currentArtifact.domAttempted)
        await stage(record, "failure.dom", () =>
          captureDOM(current, currentSession, currentArtifact, evidenceEnd),
        ).catch(() => {});
      if (!currentArtifact.pngAttempted && performance.now() < evidenceEnd)
        await stage(record, "failure.png", () =>
          capturePNG(current, currentSession, currentArtifact, evidenceEnd),
        ).catch(() => {});
    }
  } finally {
    if (current) await current.finish(false);
    clearTimeout(watchdog);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    record.elapsedMs = Math.round(performance.now() - origin);
    if (record.guestTimedOut) record.accepted = false;
    const output = serialize(record);
    console.log(output);
    process.exitCode = JSON.parse(output).accepted ? 0 : 2;
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((error) => {
    console.log(
      JSON.stringify({
        accepted: false,
        phase: "preflight",
        reason: error.code ?? "preflight-failed",
      }),
    );
    process.exitCode = 2;
  });
