// Local real Node + SSH-loopback browser; no Control/Node credentials are sent to the VPS.
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { startProbeClient } from "./product_browser_client.ts";
import {
  type ControlLoop,
  type ControlRequest,
  jsonRecord,
  parseRemoteBrowserInput,
  readStdinJson,
  startControlLoop,
} from "./probe-inputs.ts";

const SSH_TARGET = /^root@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const FIXED_TARGET_URL = "https://example.com:18443";
const FIXED_TOKEN = "synthetic-linux-composition-fixture-only";
const REMOTE_RESTART =
  "exec /usr/bin/python3 -B /opt/openbot-qualification-20260925-c8b2/composition-20260926-a1/run.py restart";
// No config file, control socket, TTY, agent or X11 forwarding; pinned host keys only.
const SSH_ARGUMENTS = [
  "-F",
  "none",
  "-S",
  "none",
  "-T",
  "-a",
  "-x",
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "ConnectTimeout=15",
  "-o",
  "ForwardAgent=no",
  "-o",
  "ForwardX11=no",
] as const;
const SSH_TIMEOUT_MS = 60000;
const SSH_OUTPUT_BYTES = 16384;
const CONTROL_MAXIMUM_ID = 2;

interface RemoteFixture {
  readonly sshTarget: string;
  readonly computerUrl: string;
  readonly stateUrl: string;
  readonly targetUrl: typeof FIXED_TARGET_URL;
  readonly token: typeof FIXED_TOKEN;
}

function loopbackRelay(value: unknown): string {
  if (typeof value !== "string") throw new Error("Explicit loopback relay required");
  const u = new URL(value);
  if (
    u.protocol !== "http:" ||
    u.hostname !== "127.0.0.1" ||
    !u.port ||
    u.username ||
    u.password ||
    u.pathname !== "/"
  )
    throw new Error("Explicit loopback relay required");
  return value;
}

// The operator supplies the authorized test host; a checkout never selects a personal VPS.
function remoteFixture(value: unknown): RemoteFixture {
  const remote = jsonRecord(value, "remote configuration");
  const { sshTarget, targetUrl, token } = remote;
  if (typeof sshTarget !== "string" || !SSH_TARGET.test(sshTarget))
    throw new Error("Explicit root SSH fixture target required");
  const computerUrl = loopbackRelay(remote.computerUrl);
  const stateUrl = loopbackRelay(remote.stateUrl);
  if (targetUrl !== FIXED_TARGET_URL || token !== FIXED_TOKEN)
    throw new Error("Fixed synthetic target required");
  return { sshTarget, computerUrl, stateUrl, targetUrl: FIXED_TARGET_URL, token: FIXED_TOKEN };
}

const input = parseRemoteBrowserInput(await readStdinJson(process.stdin));
const remote = remoteFixture(input.remote);
const client = await startProbeClient({
  nodeId: input.nodeId,
  serverUrl: input.serverUrl,
  credential: input.credential,
  directory: input.directory,
  computerUrl: remote.computerUrl.replace(/\/$/, ""),
  token: remote.token,
  targetUrl: remote.targetUrl,
});
let controlLoop: ControlLoop | undefined;
let stopped = false;
async function stop(): Promise<void> {
  if (stopped) return;
  stopped = true;
  controlLoop?.close();
  await client.stop();
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
const execute = promisify(execFile);

async function applyNativeControl(request: ControlRequest): Promise<void> {
  if (request.operation === "browser-restart" && request.id === 1) {
    const { stdout } = await execute(
      "/usr/bin/ssh",
      [...SSH_ARGUMENTS, remote.sshTarget, REMOTE_RESTART],
      {
        timeout: SSH_TIMEOUT_MS,
        maxBuffer: SSH_OUTPUT_BYTES,
      },
    );
    const result = jsonRecord(JSON.parse(stdout), "native replacement result");
    if (
      !result.oldContainerExited ||
      result.oldExitCode !== 0 ||
      !result.newContainer ||
      !result.samePrivateProfile
    )
      throw new Error("Native replacement not accepted");
    await writeFile(`${input.directory}/browser-processes.json`, JSON.stringify(result));
  } else if (request.operation !== "browser-readback" || request.id !== 2)
    throw new Error("Unexpected native control operation");
}

controlLoop = startControlLoop({
  directory: input.directory,
  maximumId: CONTROL_MAXIMUM_ID,
  refusal: "Fixed replacement sequence required",
  isStopped: () => stopped,
  stop,
  handle: applyNativeControl,
});
process.stdout.write(`${JSON.stringify({ targetUrl: remote.targetUrl })}\n`);
