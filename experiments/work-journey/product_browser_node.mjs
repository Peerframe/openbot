import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { nodeEnvSchema } from "../../packages/config/src/index.ts";
import { createSilentLogger } from "../../packages/logging/src/index.ts";
import { OpenBotNodeClient } from "../../apps/node/src/client.ts";
import { configuredProviders } from "../../apps/node/src/providers.ts";
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
let stopped = false;
async function stop() {
  if (stopped) return;
  stopped = true;
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
  const env = nodeEnvSchema.parse({
    OPENBOT_NODE_ID: c.nodeId,
    OPENBOT_NODE_NAME: "Synthetic Browser Host",
    OPENBOT_NODE_SERVER_URL: c.serverUrl,
    OPENBOT_DOCKER_COMPUTER_URL: computerUrl,
    OPENBOT_DOCKER_COMPUTER_TOKEN: token,
    OPENBOT_DOCKER_ALLOW_PRIVATE_HOSTS: "true",
    OPENBOT_DOCKER_INPUT_ORIGINS: targetUrl,
    OPENBOT_DOCKER_BROWSER_SESSIONS: "true",
    OPENBOT_DOCKER_BROWSER_TASKS: "true",
  });
  const providers = configuredProviders(env);
  const calls = {};
  for (const provider of providers) {
    if (provider.browserTask) {
      const run = provider.browserTask;
      provider.browserTask = async (...args) => {
        const kind = args[0].action.operation.kind;
        calls[kind] = (calls[kind] || 0) + 1;
        await writeFile(c.directory + "/browser-counts.json", JSON.stringify(calls));
        return run(...args);
      };
    }
  }
  client = new OpenBotNodeClient(
    env,
    providers,
    {
      load: async () => ({
        format: "openbot.node-identity/v1",
        nodeId: c.nodeId,
        credential: c.credential,
        enrolledAt: new Date().toISOString(),
      }),
      save: async () => {},
    },
    createSilentLogger(),
  );
  await client.start();
  process.stdout.write(JSON.stringify({ started: true, targetUrl }) + "\n");
} catch (e) {
  await stop();
  throw e;
}
