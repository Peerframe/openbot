import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
  CONTROL_POLL_MS,
  type ControlRequest,
  parseBrowserProbeInput,
  parseCommandNodeInput,
  parseProbeClientConfig,
  parseRemoteBrowserInput,
  readOptionalJson,
  readStdinJson,
  readStdinText,
  startControlLoop,
  takeControlRequest,
} from "./probe-inputs.ts";

const credential = `obn_${"a".repeat(43)}`;
// Shape written by product_browser_probe.py for local modes (remote=None there).
const browserInput = {
  nodeId: "browser-product-0a1b2c3d4e",
  botId: "4f1c2a8e-6f3b-4c1d-9a2e-1b2c3d4e5f60",
  serverUrl: "ws://127.0.0.1:43123/ws/nodes",
  credential,
  directory: "/tmp/openbot-browser-product/node",
  upstream: "/tmp/openbot-browser-upstream",
  recovery: true,
  nodeProcess: true,
  responseLoss: false,
  profileRestart: false,
  remote: null,
};
// Shape written by product_command_probe.py to the local CommonJS Node bundle.
const route = {
  nodeId: "command-product-0a1b2c3d4e5f",
  providerId: "linux-command",
  enforcementKeyId: "product-enforcer-key",
  ledgerId: "9d2f5b1e-3c4a-4e6f-8a7b-0c1d2e3f4a5b",
};
const commandInput = {
  version: 1,
  nodeId: route.nodeId,
  serverUrl: "ws://127.0.0.1:43124/ws/nodes",
  socketPath: "/tmp/openbot-command-product-1/host/enforcer.sock",
  selection: route,
  enrollmentToken: `obenr_${"b".repeat(43)}`,
};
const IDENTITY = /Explicit fixture identity required/;

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "openbot-probe-inputs-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Mirrors the Python writer: stage privately, then atomically replace the request. */
async function stage(directory: string, value: unknown): Promise<void> {
  const staged = join(directory, "control-request.next");
  await writeFile(staged, JSON.stringify(value));
  await rename(staged, join(directory, "control-request.json"));
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("stdin text keeps a UTF-8 sequence split across chunks", async () => {
  const chunks = [Buffer.from([0xe4, 0xbd]), Buffer.from([0xa0, 0x7b, 0x7d])];
  assert.equal(await readStdinText(Readable.from(chunks)), "你{}");
});

test("the command stdin bound accepts 8192 bytes and refuses one more", async () => {
  const exact = Readable.from([Buffer.alloc(8191, 0x20), Buffer.from("x")]);
  assert.equal((await readStdinText(exact, 8192)).length, 8192);
  const over = Readable.from([Buffer.alloc(8192, 0x20), Buffer.from("x")]);
  await assert.rejects(readStdinText(over, 8192), /Oversized fixture input/);
});

test("browser stdin stays unbounded, and malformed or non-byte input is refused", async () => {
  assert.equal((await readStdinText(Readable.from([Buffer.alloc(65536, 0x20)]))).length, 65536);
  await assert.rejects(readStdinJson(Readable.from([Buffer.from("{")])), SyntaxError);
  await assert.rejects(readStdinText(Readable.from([{ chunk: 1 }])), TypeError);
});

test("optional JSON treats only a missing file as not yet written", async () => {
  await withDirectory(async (directory) => {
    assert.equal(await readOptionalJson(join(directory, "missing.json")), undefined);
    await assert.rejects(readOptionalJson(directory), { code: "EISDIR" });
    await writeFile(join(directory, "partial.json"), "{");
    await assert.rejects(readOptionalJson(join(directory, "partial.json")), SyntaxError);
  });
});

test("browser input accepts the Python payload and refuses non-boolean modes", () => {
  const parsed = parseBrowserProbeInput(JSON.parse(JSON.stringify(browserInput)));
  assert.equal(parsed.recovery, true);
  assert.equal(parsed.nodeProcess, true);
  assert.equal(parsed.upstream, browserInput.upstream);
  assert.equal("remote" in parsed, false);
  assert.throws(() => parseBrowserProbeInput({ ...browserInput, recovery: "true" }), /recovery/);
  assert.throws(() => parseBrowserProbeInput({ ...browserInput, upstream: null }), /upstream/);
  assert.throws(() => parseBrowserProbeInput([browserInput]), /browser input/);
});

test("remote input leaves the remote document to the remote entry's own checks", () => {
  const remote = {
    sshTarget: "root@example.invalid",
    token: "synthetic-linux-composition-fixture-only",
  };
  assert.deepEqual(parseRemoteBrowserInput({ ...browserInput, remote }).remote, remote);
  assert.throws(
    () => parseRemoteBrowserInput({ ...browserInput, credential: 7, remote }),
    /credential/,
  );
});

test("the Node child configuration round-trips and refuses a non-string token", () => {
  const config = {
    nodeId: browserInput.nodeId,
    serverUrl: browserInput.serverUrl,
    credential,
    directory: browserInput.directory,
    computerUrl: "http://127.0.0.1:43125",
    token: "c".repeat(64),
    targetUrl: "http://127.0.0.1:43126",
  };
  assert.deepEqual(parseProbeClientConfig(JSON.parse(JSON.stringify(config))), config);
  assert.throws(() => parseProbeClientConfig({ ...config, token: 1 }), /token/);
});

test("command input keeps the explicit identity checks", () => {
  const parsed = parseCommandNodeInput(JSON.parse(JSON.stringify(commandInput)));
  assert.deepEqual(parsed.selection, route);
  assert.throws(() => parseCommandNodeInput({ ...commandInput, version: "1" }), IDENTITY);
  assert.throws(() => parseCommandNodeInput({ ...commandInput, version: 2 }), IDENTITY);
  const other = { ...route, nodeId: "command-product-other" };
  assert.throws(() => parseCommandNodeInput({ ...commandInput, selection: other }), IDENTITY);
  const partial = { nodeId: route.nodeId, providerId: route.providerId, enforcementKeyId: "k" };
  assert.throws(() => parseCommandNodeInput({ ...commandInput, selection: partial }), /ledgerId/);
  assert.throws(
    () => parseCommandNodeInput({ ...commandInput, enrollmentToken: null }),
    /enrollmentToken/,
  );
});

test("an out-of-range control id is refused before the request is consumed", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "control-request.json");
    assert.equal(await takeControlRequest(directory, 8, "Invalid fixture control id"), undefined);
    assert.equal(existsSync(path), false);
    for (const id of [0, 9, 1.5, "1", null]) {
      await stage(directory, { id, operation: "connect" });
      await assert.rejects(
        takeControlRequest(directory, 8, "Invalid fixture control id"),
        /Invalid fixture control id/,
      );
      assert.equal(existsSync(path), true);
    }
    await stage(directory, { id: 3, operation: "browser-restart" });
    await assert.rejects(
      takeControlRequest(directory, 2, "Fixed replacement sequence required"),
      /Fixed replacement sequence required/,
    );
    assert.equal(existsSync(path), true);
  });
});

test("a control request is consumed once and keeps its optional credential", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "control-request.json");
    await stage(directory, { id: 2, operation: "connect", credential });
    assert.deepEqual(await takeControlRequest(directory, 8, "refused"), {
      id: 2,
      operation: "connect",
      credential,
    });
    assert.equal(existsSync(path), false);
    assert.equal(await takeControlRequest(directory, 8, "refused"), undefined);
    await stage(directory, { id: 1, operation: 7 });
    assert.deepEqual(await takeControlRequest(directory, 8, "refused"), {
      id: 1,
      operation: undefined,
      credential: undefined,
    });
    await stage(directory, { id: 1, operation: "connect", credential: 5 });
    await assert.rejects(takeControlRequest(directory, 8, "refused"), /credential/);
    assert.equal(existsSync(path), false);
  });
});

test("the control loop handles one staged request and records its completion", async () => {
  await withDirectory(async (directory) => {
    const handled: ControlRequest[] = [];
    let stops = 0;
    const loop = startControlLoop({
      directory,
      maximumId: 8,
      refusal: "Invalid fixture control id",
      isStopped: () => false,
      handle: async (request) => {
        handled.push(request);
      },
      stop: async () => {
        stops++;
      },
    });
    try {
      await stage(directory, { id: 1, operation: "disconnect" });
      await waitFor(() => existsSync(join(directory, "control-1.json")));
      const done: unknown = JSON.parse(await readFile(join(directory, "control-1.json"), "utf8"));
      assert.deepEqual(done, { done: true });
      assert.deepEqual(handled, [{ id: 1, operation: "disconnect", credential: undefined }]);
      assert.equal(stops, 0);
    } finally {
      loop.close();
    }
  });
});

test("a refused control transition stops the fixture without completing", async () => {
  const previousExitCode = process.exitCode;
  await withDirectory(async (directory) => {
    let stops = 0;
    const loop = startControlLoop({
      directory,
      maximumId: 8,
      refusal: "Invalid fixture control id",
      isStopped: () => false,
      handle: async () => {
        throw new Error("Invalid fixture lifecycle transition");
      },
      stop: async () => {
        stops++;
      },
    });
    try {
      await stage(directory, { id: 1, operation: "connect" });
      await waitFor(() => stops === 1);
      assert.equal(process.exitCode, 1);
      assert.equal(existsSync(join(directory, "control-1.json")), false);
    } finally {
      loop.close();
      process.exitCode = previousExitCode;
    }
  });
});

test("a stopped control loop leaves later requests untouched", async () => {
  await withDirectory(async (directory) => {
    const handled: ControlRequest[] = [];
    const loop = startControlLoop({
      directory,
      maximumId: 8,
      refusal: "Invalid fixture control id",
      isStopped: () => true,
      handle: async (request) => {
        handled.push(request);
      },
      stop: async () => {},
    });
    await stage(directory, { id: 1, operation: "connect" });
    await new Promise((resolve) => setTimeout(resolve, CONTROL_POLL_MS * 3));
    loop.close();
    assert.equal(existsSync(join(directory, "control-request.json")), true);
    assert.deepEqual(handled, []);
  });
});
