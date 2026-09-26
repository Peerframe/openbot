import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startProbeClient } from "./product_browser_client.mjs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
let input = "";
for await (const c of process.stdin) input += c;
const c = JSON.parse(input);
const state = { text: "", submitted: 0, scroll: 0, stored: "" };
const page = `<!doctype html><meta charset="utf-8"><title>Owned browser task fixture</title><style>body{font:24px system-ui;margin:40px;background:#eef7f1}input{position:absolute;left:40px;top:140px;width:520px;height:45px;font:24px system-ui}button{position:absolute;left:40px;top:220px;height:50px}#result{position:absolute;top:300px}#bottom{margin-top:1500px}</style><h1>OpenBot browser task</h1><form><input aria-label="Fixture text"><button>Save synthetic entry</button></form><p id="result">Waiting for input</p><p id="bottom">Scroll target</p><script>const f=document.querySelector('input');f.value=localStorage.getItem('entry')||'';function report(){fetch('/event',{method:'POST',body:JSON.stringify({text:f.value,submitted:Number(document.body.dataset.count||0),scroll:scrollY,stored:localStorage.getItem('entry')||''})})}f.oninput=report;onscroll=report;document.querySelector('form').onsubmit=e=>{e.preventDefault();document.body.dataset.count=Number(document.body.dataset.count||0)+1;localStorage.setItem('entry',f.value);document.querySelector('#result').textContent='Saved: '+f.value;report()};report();</script>`;
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
const upstream = spawn("bun", ["src/index.ts"], {
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
});
const computerUrl = `http://127.0.0.1:${port}`,
  targetUrl = `http://127.0.0.1:${target.address().port}`;
let client;
let nodeChild;
const nodeProcesses = [];
let controlTimer;
let stopped = false;
async function stop() {
  if (stopped) return;
  stopped = true;
  clearInterval(controlTimer);
  await client?.stop();
  upstream.kill("SIGTERM");
  await Promise.race([once(upstream, "exit"), new Promise((r) => setTimeout(r, 8000))]);
  if (upstream.exitCode === null) upstream.kill("SIGKILL");
  target.closeAllConnections();
  target.close();
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (upstream.exitCode !== null) throw Error("Upstream exited");
    try {
      if (
        (
          await fetch(computerUrl + "/health", {
            headers: { "x-openbot-computer-token": token },
            signal: AbortSignal.timeout(100),
          })
        ).ok
      ) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!ready) throw Error("Upstream timeout");
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
    const config = { ...c, credential, computerUrl, token, targetUrl };
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
