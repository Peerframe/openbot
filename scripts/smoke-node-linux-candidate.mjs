import { parseArgumentPairs } from "./argument-pairs.ts";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nodeMessageSchema, protocolVersion } from "@openbot/protocol";
import { WebSocketServer } from "ws";
import { validatePackagedNodeHello, verifyCandidateDirectory } from "./node-linux-release.mjs";

if (process.platform !== "linux") {
  throw new Error("Packaged Linux runtime smoke tests can only run on Linux.");
}

const options = parseArguments(process.argv.slice(2));
if (process.arch !== options.architecture) {
  throw new Error("Packaged Linux runtime smoke test requires a matching host architecture.");
}
const candidate = path.resolve(options.candidate);
const manifest = await verifyCandidateDirectory(candidate);
if (manifest.architecture !== options.architecture) {
  throw new Error("Release candidate architecture does not match the smoke-test host.");
}

const executable = path.join(candidate, "bin/node");
const entryPoint = path.join(candidate, "app/index.js");
for (const filePath of [executable, entryPoint]) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Packaged runtime entry files must be regular files.");
  }
}
await access(executable, constants.X_OK);

const scratch = await mkdtemp(path.join(tmpdir(), "openbot-node-linux-smoke-"));
await mkdir(path.join(scratch, "home"));
await mkdir(path.join(scratch, "work"));
const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await waitForListening(gateway);
const address = gateway.address();
if (address === null || typeof address === "string") {
  throw new Error("Packaged runtime smoke gateway did not bind a TCP port.");
}

const nodeId = `release-smoke-${options.architecture}`;
const credential = `obn_${"s".repeat(43)}`;
const child = spawn(executable, [entryPoint], {
  cwd: scratch,
  env: {
    HOME: path.join(scratch, "home"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    OPENBOT_LOG_LEVEL: "error",
    OPENBOT_NODE_CREDENTIAL: credential,
    OPENBOT_NODE_ALLOW_ENV_CREDENTIAL: "true",
    OPENBOT_NODE_CREDENTIAL_STORE: "file",
    OPENBOT_NODE_ID: nodeId,
    OPENBOT_NODE_MAX_CONCURRENT_RUNS: "1",
    OPENBOT_NODE_SERVER_URL: `ws://127.0.0.1:${address.port}`,
    OPENBOT_NODE_WORK_DIRECTORY: path.join(scratch, "work"),
    PATH: "/usr/bin:/bin",
    TMPDIR: scratch,
    TZ: "UTC",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  await observeHelloAndStop({
    gateway,
    child,
    expected: { architecture: options.architecture, credential, nodeId, protocolVersion },
  });
  process.stdout.write(
    `${JSON.stringify({ architecture: options.architecture, candidate, handshake: "passed" }, null, 2)}\n`,
  );
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const socket of gateway.clients) socket.terminate();
  await closeGateway(gateway);
  await rm(scratch, { recursive: true, force: true });
}

function observeHelloAndStop({ gateway, child, expected }) {
  return new Promise((resolve, reject) => {
    let outputBytes = 0;
    let helloAccepted = false;
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Packaged Node hello or shutdown exceeded the 15-second deadline."));
    }, 15_000);

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error === undefined) resolve();
      else reject(error);
    };
    const capture = (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 64 * 1024) {
        child.kill("SIGKILL");
        finish(new Error("Packaged Node smoke output exceeded the 64 KiB bound."));
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", (error) =>
      finish(new Error("Packaged Node could not start.", { cause: error })),
    );
    child.once("exit", (code, signal) => {
      if (!helloAccepted) {
        finish(new Error("Packaged Node exited before a valid hello."));
        return;
      }
      if (code !== 0 || signal !== null) {
        finish(new Error("Packaged Node did not terminate cleanly after SIGTERM."));
        return;
      }
      finish();
    });
    gateway.once("connection", (socket) => {
      socket.once("message", (raw) => {
        if (raw.byteLength > 64 * 1024) {
          finish(new Error("Packaged Node hello exceeded the 64 KiB bound."));
          child.kill("SIGKILL");
          return;
        }
        let decoded;
        try {
          decoded = JSON.parse(raw.toString());
        } catch {
          finish(new Error("Packaged Node hello was not valid JSON."));
          child.kill("SIGKILL");
          return;
        }
        const parsed = nodeMessageSchema.safeParse(decoded);
        if (!parsed.success) {
          finish(new Error("Packaged Node hello did not match the protocol schema."));
          child.kill("SIGKILL");
          return;
        }
        try {
          validatePackagedNodeHello(parsed.data, expected);
        } catch (error) {
          finish(error);
          child.kill("SIGKILL");
          return;
        }
        helloAccepted = true;
        socket.send(
          JSON.stringify({
            type: "server.ack",
            protocolVersion,
            accepted: true,
            receivedAt: new Date().toISOString(),
          }),
          (error) => {
            if (error != null) {
              finish(new Error("Smoke gateway could not acknowledge the packaged Node."));
              child.kill("SIGKILL");
              return;
            }
            child.kill("SIGTERM");
          },
        );
      });
    });
  });
}

function waitForListening(gateway) {
  return new Promise((resolve, reject) => {
    gateway.once("listening", resolve);
    gateway.once("error", reject);
  });
}

function closeGateway(gateway) {
  return new Promise((resolve) => gateway.close(resolve));
}

function parseArguments(arguments_) {
  const values = parseArgumentPairs(
    arguments_,
    "Smoke arguments must be unique --name value pairs.",
  );
  for (const key of values.keys()) {
    if (key !== "--arch" && key !== "--candidate") {
      throw new Error(`Unknown smoke argument: ${key}.`);
    }
  }
  const architecture = values.get("--arch");
  const candidate = values.get("--candidate");
  if (architecture !== "x64" && architecture !== "arm64") {
    throw new Error("Smoke architecture must be x64 or arm64.");
  }
  if (candidate === undefined || !path.isAbsolute(candidate)) {
    throw new Error("Smoke candidate path must be absolute.");
  }
  return { architecture, candidate };
}
