import assert from "node:assert/strict";
import test from "node:test";
import type { BoundedCommandRequest } from "./node-linux-provenance.ts";
import {
  createLinuxSystemdServiceAdapter,
  LINUX_SYSTEMD_SERVICE,
  parseSystemdState,
} from "./node-linux-systemd.ts";

test("queries and restarts only the fixed loaded system service", async () => {
  const requests: BoundedCommandRequest[] = [];
  const states = [state("active"), state("inactive")];
  const adapter = createLinuxSystemdServiceAdapter({
    commandRunner: async (request) => {
      requests.push(request);
      if (request.arguments[0] === "--version") {
        return success(Buffer.from("systemd 255 (255.4-1ubuntu8.12)\n+PAM +AUDIT\n"));
      }
      if (request.arguments[1] === "show") return success(states.shift());
      return success();
    },
  });

  assert.equal(await adapter.isActive(new AbortController().signal), true);
  await adapter.restartSelected(new AbortController().signal);
  assert.equal(await adapter.isActive(new AbortController().signal), false);

  assert.equal(requests.length, 4);
  assert.deepEqual(
    requests.map((request) => request.arguments),
    [
      ["--version"],
      [
        "--no-pager",
        "show",
        "--property=LoadState",
        "--property=ActiveState",
        "openbot-node.service",
      ],
      ["--no-pager", "restart", "openbot-node.service"],
      [
        "--no-pager",
        "show",
        "--property=LoadState",
        "--property=ActiveState",
        "openbot-node.service",
      ],
    ],
  );
  for (const request of requests) {
    assert.equal(request.executable, "/usr/bin/systemctl");
    assert.equal(request.environment.SYSTEMD_PAGER, "cat");
    assert.equal(request.environment.SYSTEMD_COLORS, "0");
    assert.equal(request.maximumBytes, 4 * 1024);
    assert.ok(request.signal);
  }
  assert.deepEqual(LINUX_SYSTEMD_SERVICE, {
    executable: "/usr/bin/systemctl",
    unit: "openbot-node.service",
    upstreamVersion: "255",
  });
});

test("accepts only loaded and exactly active or inactive machine state", () => {
  assert.equal(parseSystemdState(state("active")), true);
  assert.equal(parseSystemdState(Buffer.from("ActiveState=inactive\nLoadState=loaded\n")), false);

  for (const output of [
    Buffer.from("LoadState=not-found\nActiveState=inactive\n"),
    Buffer.from("LoadState=masked\nActiveState=inactive\n"),
    state("failed"),
    state("activating"),
    Buffer.from("LoadState=loaded\n"),
    Buffer.from("LoadState=loaded\nActiveState=active\nActiveState=active\n"),
    Buffer.from("LoadState=loaded\nActiveState=active\nSubState=running\n"),
    Buffer.from("LoadState=loaded\nActiveState=active"),
    Buffer.from(""),
  ]) {
    assert.throws(() => parseSystemdState(output), /Linux systemd/u);
  }
});

test("rejects version drift, failed commands, and untrusted diagnostics", async () => {
  const wrongVersion = createLinuxSystemdServiceAdapter({
    commandRunner: async () => success(Buffer.from("systemd 256 (256.1)\n")),
  });
  await assert.rejects(
    wrongVersion.isActive(new AbortController().signal),
    /outside the reviewed Ubuntu 24.04 line/,
  );

  const failed = createLinuxSystemdServiceAdapter({
    commandRunner: async (request) => {
      if (request.arguments[0] === "--version") {
        return success(Buffer.from("systemd 255 (255.4-1ubuntu8.1)\n"));
      }
      return {
        exitCode: 1,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("credential=untrusted-secret"),
      };
    },
  });
  await assert.rejects(failed.restartSelected(new AbortController().signal), (error: Error) => {
    assert.equal(error.message, "Linux systemd command failed.");
    assert.doesNotMatch(error.message, /credential|secret/u);
    return true;
  });
});

function state(activeState: string): Buffer {
  return Buffer.from(`LoadState=loaded\nActiveState=${activeState}\n`);
}

function success(stdout: Buffer = Buffer.alloc(0)) {
  return { exitCode: 0, signal: null, stdout, stderr: Buffer.alloc(0) };
}
