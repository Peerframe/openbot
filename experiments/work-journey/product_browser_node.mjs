import { once } from "node:events";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startProbeClient } from "./product_browser_client.mjs";
import { responseLossRelay } from "./browser_response_loss.mjs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
let input = "";
for await (const c of process.stdin) input += c;
const c = JSON.parse(input);
const state = { text: "", submitted: 0, scroll: 0, stored: "" };
let page = `<!doctype html><meta charset="utf-8"><title>Owned browser task fixture</title><style>body{font:24px system-ui;margin:40px;background:#eef7f1}input{position:absolute;left:40px;top:140px;width:520px;height:45px;font:24px system-ui}button{position:absolute;left:40px;top:220px;height:50px}#result{position:absolute;top:300px}#bottom{margin-top:1500px}</style><h1>OpenBot browser task</h1><form><input aria-label="Fixture text"><button>Save synthetic entry</button></form><p id="result">Waiting for input</p><p id="bottom">Scroll target</p><script>const f=document.querySelector('input');f.value=localStorage.getItem('entry')||'';function report(){fetch('/event',{method:'POST',body:JSON.stringify({text:f.value,submitted:Number(document.body.dataset.count||0),scroll:scrollY,stored:localStorage.getItem('entry')||''})})}f.oninput=report;onscroll=report;document.querySelector('form').onsubmit=e=>{e.preventDefault();document.body.dataset.count=Number(document.body.dataset.count||0)+1;localStorage.setItem('entry',f.value);document.querySelector('#result').textContent='Saved: '+f.value;report()};report();</script>`;
if (c.profileRestart) {
  page = page.replace("stored:localStorage.getItem('entry')||''", "stored:localStorage.getItem('entry')||'',persistentCookie:document.cookie.includes('fixture_expiry=retained'),sessionCookie:document.cookie.includes('fixture_session=temporary'),indexedDB:window.persistedValue||''");
  page += `<script>const opening=indexedDB.open('profile-fixture',1);opening.onupgradeneeded=()=>opening.result.createObjectStore('entries');opening.onsuccess=()=>{const db=opening.result;const read=db.transaction('entries').objectStore('entries').get('saved');read.onsuccess=()=>{window.persistedValue=read.result||'';report()};document.querySelector('form').addEventListener('submit',()=>{document.cookie='fixture_expiry=retained;Max-Age=86400;SameSite=Strict;Path=/';document.cookie='fixture_session=temporary;SameSite=Strict;Path=/';const tx=db.transaction('entries','readwrite');tx.objectStore('entries').put('synthetic-indexed-value','saved');tx.oncomplete=()=>{window.persistedValue='synthetic-indexed-value';report()}})};</script>`;
}
const target = createServer(async (req, res) => {
  if (req.url === "/state") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(state));
    return;
  }
  if (req.url === "/event") {
    let b = "";
    for await (const x of req) b += x;
    Object.assign(state, JSON.parse(b));
    res.end("ok");
    return;
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(page);
});
target.listen(0, "127.0.0.1");
await once(target, "listening");
const portServer = createServer();
portServer.listen(0, "127.0.0.1");
await once(portServer, "listening");
const port = portServer.address().port;
await new Promise((r) => portServer.close(r));
const token = randomBytes(32).toString("hex");
await mkdir(c.directory + "/profiles", { recursive: true, mode: 0o700 });
await mkdir(c.directory + "/workspace", { recursive: true, mode: 0o700 });
const upstreamOptions = {
  cwd: c.upstream,
  env: {
    ...process.env,
    PORT: String(port),
    COMPUTER_TOKEN: token,
    PROFILES_DIR: c.directory + "/profiles",
    WORKSPACE_DIR: c.directory + "/workspace",
    COMPUTER_MAX_BROWSERS: "2",
    NAVIGATION_TIMEOUT_MS: "5000",
    ACTION_TIMEOUT_MS: "3000",
  },
  stdio: ["ignore", "ignore", "inherit"],
};
let upstream = spawn("bun", ["src/index.ts"], upstreamOptions);
const computerUrl = `http://127.0.0.1:${port}`,
  targetUrl = `http://127.0.0.1:${target.address().port}`;
let client;
let relay;
let nodeChild;
const nodeProcesses = [];
let controlTimer;
let stopped = false;
async function stopUpstream() {
  if (upstream.exitCode !== null || upstream.signalCode !== null) return;
  const exited = once(upstream, "exit", { signal: AbortSignal.timeout(10000) });
  upstream.kill("SIGTERM");
  try {
    await exited;
  } catch {
    upstream.kill("SIGKILL");
    await once(upstream, "exit");
    throw Error("Owned browser service did not close gracefully");
  }
  if (upstream.exitCode !== 0) throw Error("Owned browser service failed while closing");
}
async function readyUpstream() {
  for (let i = 0; i < 100; i++) {
    if (upstream.exitCode !== null) throw Error("Upstream exited");
    try {
      if ((await fetch(computerUrl + "/health", { signal: AbortSignal.timeout(100) })).ok)
        return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error("Upstream timeout");
}
async function browserPid() {
  // Headless shell does not create SingletonLock. Read only PID/parent ids globally, then
  // inspect arguments of exact children of this owned service; never collect other argv.
  const execute = promisify(execFile);
  const options = { timeout: 3000, maxBuffer: 1024 * 1024 };
  const { stdout } = await execute("/bin/ps", ["-A", "-o", "pid=,ppid="], options);
  const children = stdout.trim().split("\n").map((row) => row.trim().split(/\s+/u).map(Number))
    .filter((row) => row.length === 2 && row[1] === upstream.pid);
  const matches = [];
  const profile = `--user-data-dir=${c.directory}/profiles/${c.botId}`;
  for (const [pid] of children) {
    const command = (await execute("/bin/ps", ["-p", String(pid), "-o", "args="], options)).stdout;
    if (command.trim().split(/\s+/u).includes(profile)) matches.push(pid);
  }
  if (matches.length !== 1) throw Error("Expected exactly one owned Chromium process");
  return matches[0];
}
async function stop() {
  if (stopped) return;
  stopped = true;
  clearInterval(controlTimer);
  try {
    await client?.stop();
  } finally {
    relay?.close();
    try {
      await stopUpstream();
    } finally {
      target.closeAllConnections();
      target.close();
    }
  }
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
try {
  await readyUpstream();
  if (c.responseLoss) {
    relay = await responseLossRelay(computerUrl, state, async (value) => {
      await writeFile(c.directory + "/response-loss.json", JSON.stringify(value));
    });
  }
  async function stopNode(signal = "SIGTERM") {
    if (!nodeChild || nodeChild.exitCode !== null || nodeChild.signalCode !== null) return;
    const child = nodeChild;
    const exited = once(child, "exit", { signal: AbortSignal.timeout(5000) });
    child.kill(signal);
    try {
      await exited;
    } catch {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    nodeProcesses.push({ pid: child.pid, event: "exit", signal: child.signalCode });
    await writeFile(c.directory + "/node-processes.json", JSON.stringify(nodeProcesses));
  }
  async function startNode(credential) {
    const config = { ...c, credential, computerUrl: relay?.url ?? computerUrl, token, targetUrl };
    if (!c.nodeProcess) {
      client = await startProbeClient(config);
      return;
    }
    nodeChild = spawn(
      process.execPath,
      ["--import", "tsx", fileURLToPath(new URL("./product_browser_client.mjs", import.meta.url))],
      { env: process.env, stdio: ["pipe", "pipe", "inherit"] },
    );
    const ready = once(nodeChild.stdout, "data", { signal: AbortSignal.timeout(10000) });
    nodeChild.stdin.end(JSON.stringify(config));
    client = { stop: () => stopNode() };
    if (JSON.parse(String((await ready)[0])).started !== true) throw Error("Node child failed");
    nodeProcesses.push({ pid: nodeChild.pid, event: "start" });
    await writeFile(c.directory + "/node-processes.json", JSON.stringify(nodeProcesses));
  }
  await startNode(c.credential);
  if (c.recovery === true) {
    // Private fixture controls call the real Node lifecycle; no production transport hook.
    let busy = false;
    let connected = true;
    controlTimer = setInterval(async () => {
      if (busy || stopped) return;
      busy = true;
      try {
        const path = c.directory + "/control-request.json";
        let request;
        try {
          request = JSON.parse(await readFile(path, "utf8"));
        } catch (error) {
          if (error.code === "ENOENT") return;
          throw error;
        }
        if (!Number.isSafeInteger(request.id) || request.id < 1 || request.id > 8)
          throw Error("Invalid fixture control id");
        await unlink(path);
        if (request.operation === "disconnect" && connected) {
          if (c.nodeProcess) await stopNode("SIGKILL");
          else await client.stop();
          connected = false;
        } else if (request.operation === "connect" && !connected) {
          await startNode(request.credential ?? c.credential);
          connected = true;
        } else if (request.operation === "browser-restart" && connected) {
          const oldService = upstream.pid;
          const oldBrowser = await browserPid();
          await stopUpstream();
          let gone = false;
          try { process.kill(oldBrowser, 0); } catch (error) {
            if (error.code !== "ESRCH") throw error;
            gone = true;
          }
          if (!gone) throw Error("Original Chromium survived graceful service shutdown");
          upstream = spawn("bun", ["src/index.ts"], upstreamOptions);
          if (upstream.pid === oldService) throw Error("Service PID was reused");
          await readyUpstream();
          await writeFile(c.directory + "/browser-processes.json",
            JSON.stringify({ oldService, oldBrowser, newService: upstream.pid, oldBrowserExited: true }));
        } else if (request.operation === "browser-readback" && connected) {
          const evidence = JSON.parse(await readFile(c.directory + "/browser-processes.json", "utf8"));
          evidence.newBrowser = await browserPid();
          if (evidence.newBrowser === evidence.oldBrowser) throw Error("Chromium PID was reused");
          await writeFile(c.directory + "/browser-processes.json", JSON.stringify(evidence));
        } else throw Error("Invalid fixture lifecycle transition");
        await writeFile(
          c.directory + `/control-${request.id}.json`,
          JSON.stringify({ done: true }),
        );
      } catch (error) {
        process.stderr.write(String(error) + "\n");
        await stop();
        process.exitCode = 1;
      } finally {
        busy = false;
      }
    }, 100);
  }
  process.stdout.write(JSON.stringify({ started: true, targetUrl }) + "\n");
} catch (e) {
  await stop();
  throw e;
}
