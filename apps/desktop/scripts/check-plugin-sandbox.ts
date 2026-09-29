import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// Use Chromium's actual file-document CSP and sandbox enforcement, not a DOM emulator.
// The browser and Electron fragments are generated from this one typed source into a
// private temporary fixture and executed by the real Electron binary.
const PASS_MARKER = "OPENBOT_PLUGIN_SANDBOX_PASS";
const ELECTRON_TIMEOUT_MS = 30_000;
const ELECTRON_OUTPUT_BYTES = 64 * 1024;
const RESULT_POLLS = 100;
const RESULT_POLL_MS = 100;
/** Every boundary the hostile view must find closed; the Electron check requires each one. */
const BOUNDARIES = ["dom", "proxy", "cookies", "network"] as const;

const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const renderer = new URL("../dist/renderer/", import.meta.url);

/** Loopback listener that a sandboxed view must never reach; it owns only its server. */
interface NetworkProbe {
  listen(): Promise<string>;
  requests(): number;
  close(): Promise<void>;
}

function networkProbe(): NetworkProbe {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { "Access-Control-Allow-Origin": "*" }).end("probe");
  });
  return {
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      assert(address && typeof address === "object");
      return `http://127.0.0.1:${address.port}/isolation-probe`;
    },
    requests: () => requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function readHostCsp(): Promise<string> {
  const index = await readFile(new URL("index.html", renderer), "utf8");
  const csp = index.match(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/u)?.[0];
  assert(csp, "Built renderer CSP is required");
  assert(csp.includes("script-src 'self'"), "Do not loosen the host's script policy");
  return csp;
}

/** Host document carrying the built renderer's CSP unchanged. */
function hostDocument(csp: string): string {
  return `<!doctype html><html><head>${csp}</head><body><p id="result">pending</p><iframe id="proxy" src="./plugin-sandbox.html" sandbox="allow-scripts"></iframe><script src="./probe.js"></script></body></html>`;
}

/** Untrusted plugin view: records each boundary as a boolean and reports through the proxy. */
function hostileView(endpoint: string): string {
  return `<script>
    const result = {};
    try { void window.top.document.body; result.dom = false; } catch { result.dom = true; }
    try { void document.cookie; result.cookies = false; } catch { result.cookies = true; }
    try { void window.parent.document.body; result.proxy = false; } catch { result.proxy = true; }
    fetch(${JSON.stringify(endpoint)}).then(
      () => { result.network = false; send(); },
      () => { result.network = true; send(); },
    );
    function send() { parent.postMessage({jsonrpc:'2.0',id:'boundary',result}, '*'); }
  </script>`;
}

/** Host-side probe: completes the sandbox proxy handshake and exposes the reported result. */
function probeScript(view: string): string {
  return `const frame = document.getElementById('proxy');
    const html = ${JSON.stringify(view)};
    window.addEventListener('message', event => {
      if (event.source !== frame.contentWindow) return;
      if (event.data.method === 'ui/notifications/sandbox-proxy-ready') {
        frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/sandbox-resource-ready',params:{html}}, '*');
      }
      if (event.data.id === 'boundary') document.getElementById('result').textContent = JSON.stringify(event.data.result);
    });`;
}

/** Electron main process with a fixed private profile beside the fixture. */
function electronMain(): string {
  return `const {app, BrowserWindow} = require('electron');
    const path = require('node:path');
    const boundaries = ${JSON.stringify(BOUNDARIES)};
    app.setPath('userData', path.join(__dirname, 'profile'));
    app.whenReady().then(async () => {
      const window = new BrowserWindow({show:false, webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
      try {
        await window.loadFile(path.join(__dirname, 'index.html'));
        let result = 'pending';
        for (let i = 0; i < ${RESULT_POLLS} && result === 'pending'; i++) {
          result = await window.webContents.executeJavaScript('document.getElementById("result").textContent');
          if (result === 'pending') await new Promise(resolve => setTimeout(resolve, ${RESULT_POLL_MS}));
        }
        const value = JSON.parse(result);
        if (value === null || typeof value !== 'object' || !boundaries.every(key => value[key] === true)) throw new Error('Sandbox boundary failed');
        console.log(${JSON.stringify(PASS_MARKER)});
        app.exit(0);
      } catch (error) { console.error(error.message); app.exit(1); }
    });`;
}

async function writeFixture(directory: string, csp: string, endpoint: string): Promise<void> {
  await copyFile(new URL("plugin-sandbox.html", renderer), join(directory, "plugin-sandbox.html"));
  await writeFile(join(directory, "index.html"), hostDocument(csp));
  await writeFile(join(directory, "probe.js"), probeScript(hostileView(endpoint)));
  await writeFile(join(directory, "main.cjs"), electronMain());
}

function electronBinary(): string {
  const binary: unknown = require("electron");
  assert(typeof binary === "string", "The electron package must resolve to its executable path");
  return binary;
}

async function runElectron(directory: string): Promise<string> {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const { stdout } = await execute(electronBinary(), [join(directory, "main.cjs")], {
    encoding: "utf8",
    env: environment,
    timeout: ELECTRON_TIMEOUT_MS,
    maxBuffer: ELECTRON_OUTPUT_BYTES,
    windowsHide: true,
  });
  return stdout;
}

const fixture = await mkdtemp(join(tmpdir(), "openbot-plugin-sandbox-"));
const network = networkProbe();
try {
  const endpoint = await network.listen();
  await writeFixture(fixture, await readHostCsp(), endpoint);
  const stdout = await runElectron(fixture);
  assert(stdout.includes(PASS_MARKER), "Native browser evidence is required");
  assert.equal(
    network.requests(),
    0,
    "A blocked fetch must never reach the listening test server",
  );
  console.info(
    "Native plugin sandbox passed: strict host CSP, initialized proxy, isolated DOM and cookies, no direct network.",
  );
} finally {
  await network.close();
  await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
