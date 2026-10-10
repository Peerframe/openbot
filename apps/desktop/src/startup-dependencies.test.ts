/** Checks dependency hints, bounded read-only Docker probes and outage-only startup continuation. */

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TemporalUnavailableError } from "./server-bootstrap.js";
import {
  dockerAvailable,
  usesLocalDocker,
  waitForProductDependencies,
} from "./startup-dependencies.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function directory() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ob-deps-")));
  dirs.push(dir);
  return dir;
}
it.skipIf(process.platform === "win32")(
  "only hints Docker for the retained local Compose installation",
  async () => {
    const root = await directory(),
      data = join(root, "local-server"),
      compose = join(root, "services/temporal/profile");
    await mkdir(data, { mode: 0o700 });
    const config = join(data, "temporal.json");
    await writeFile(config, JSON.stringify({ temporal_address: "127.0.0.1:7233" }), {
      mode: 0o600,
    });
    expect(await usesLocalDocker(config)).toBe(false);
    await mkdir(compose, { recursive: true });
    await writeFile(join(compose, "compose.yaml"), "fixture");
    expect(await usesLocalDocker(config)).toBe(true);
    await writeFile(config, JSON.stringify({ temporal_address: "remote.example:7233" }));
    expect(await usesLocalDocker(config)).toBe(false);
  },
);
it.skipIf(process.platform === "win32")(
  "uses only GET /_ping and rejects bad, oversized and stalled responses",
  async () => {
    const dir = await directory(),
      socket = join(dir, "docker.sock");
    let body = "OK",
      status = 200;
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (body === "stall") return;
      response.writeHead(status);
      response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      const signal = new AbortController().signal;
      expect(await dockerAvailable(signal, [socket])).toBe(true);
      status = 503;
      expect(await dockerAvailable(signal, [socket])).toBe(false);
      status = 200;
      body = "x".repeat(10000);
      expect(await dockerAvailable(signal, [socket])).toBe(false);
      body = "stall";
      expect(await dockerAvailable(signal, [socket])).toBe(false);
      const cancelled = new AbortController();
      cancelled.abort();
      expect(await dockerAvailable(cancelled.signal, [socket])).toBe(false);
      expect(await dockerAvailable(signal, [join(dir, "absent.sock")])).toBe(false);
      expect(requests).toEqual(Array(4).fill("GET /_ping"));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
it("automatically continues after an outage and never retries unknown failures", async () => {
  const operation = vi
    .fn()
    .mockRejectedValueOnce(new TemporalUnavailableError())
    .mockResolvedValue("ready");
  const context = {
    signal: new AbortController().signal,
    waiting: vi.fn(),
    waitForRetry: vi.fn(async () => {}),
  };
  expect(await waitForProductDependencies(operation, "/absent/temporal.json", context)).toBe(
    "ready",
  );
  expect(operation).toHaveBeenCalledTimes(2);
  expect(context.waiting).toHaveBeenCalledExactlyOnceWith("temporal_unavailable", false);
  expect(context.waitForRetry).toHaveBeenCalledOnce();
  const failure = vi.fn().mockRejectedValue(new Error("Temporal unavailable but unclassified"));
  await expect(
    waitForProductDependencies(failure, "/absent/temporal.json", context),
  ).rejects.toThrow("unclassified");
  expect(failure).toHaveBeenCalledOnce();
});
it("cancels waiting before any further launch and keeps noninteractive callers bounded", async () => {
  const abort = new AbortController(),
    operation = vi.fn().mockRejectedValue(new TemporalUnavailableError());
  await expect(
    waitForProductDependencies(operation, "/absent/temporal.json", {
      signal: abort.signal,
      waiting: vi.fn(),
      waitForRetry: async () => {
        abort.abort();
      },
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(operation).toHaveBeenCalledOnce();
  await expect(
    waitForProductDependencies(operation, "/absent/temporal.json"),
  ).rejects.toBeInstanceOf(TemporalUnavailableError);
  expect(operation).toHaveBeenCalledTimes(2);
});

it("waits for Docker without rerunning preflight, then waits for the actual Temporal launch", async () => {
  const launch = vi
    .fn()
    .mockRejectedValueOnce(new TemporalUnavailableError())
    .mockResolvedValue("ready");
  const context = {
    signal: new AbortController().signal,
    waiting: vi.fn(),
    waitForRetry: vi.fn(async () => {}),
  };
  const probes = {
    usesLocalDocker: vi.fn(async () => true),
    dockerAvailable: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
  };
  expect(await waitForProductDependencies(launch, "/fixture/temporal.json", context, probes)).toBe(
    "ready",
  );
  expect(context.waiting.mock.calls).toEqual([
    ["docker_unavailable", true],
    ["temporal_unavailable", true],
  ]);
  expect(launch).toHaveBeenCalledTimes(2);
  expect(context.waitForRetry).toHaveBeenCalledTimes(2);
});
