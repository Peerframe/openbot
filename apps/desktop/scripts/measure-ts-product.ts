import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configureNativeWorkFixture, runNativeWorkFixture } from "./native-work-fixture.ts";
import { confirmProcessesStopped, loadDesktopModules } from "./python-product-probe.ts";

const desktopDist = fileURLToPath(new URL("../dist/", import.meta.url));
const serverDist = fileURLToPath(new URL("../../server-ts/dist/", import.meta.url));
type Mode = "python-direct" | "ts-forwarding";
type Start = "fresh-profile" | "restart";
type Rss = ReturnType<typeof ownedRss>;

/** The installed user's processes are outside this observer's descendant tree. */
export function ownedRss(table: string, parentPid: number, productIds: readonly number[]) {
  const rows = table
    .trim()
    .split("\n")
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u);
      return match
        ? [
            {
              pid: Number(match[1]),
              ppid: Number(match[2]),
              rss: Number(match[3]),
              name: match[4]?.split("/").at(-1),
            },
          ]
        : [];
    });
  const owned = new Set([parentPid]);
  for (let pass = 0; pass < rows.length; pass++) {
    const count = owned.size;
    for (const row of rows) if (owned.has(row.ppid)) owned.add(row.pid);
    if (owned.size === count) break;
  }
  const controller = rows.find((row) => row.pid === parentPid);
  assert(controller, "Measurement controller is missing from the process table.");
  const children = rows.filter(
    (row) => row.pid !== parentPid && owned.has(row.pid) && row.name !== "ps",
  );
  assert(
    productIds.every((pid) => children.some((row) => row.pid === pid)),
    "An owned product process is missing from the RSS sample.",
  );
  return {
    nativeChildrenRssKiB: children.reduce((total, row) => total + row.rss, 0),
    pythonRssKiB: children
      .filter((row) => row.pid === productIds[0])
      .reduce((total, row) => total + row.rss, 0),
    tsRssKiB: children
      .filter((row) => row.pid === productIds[1])
      .reduce((total, row) => total + row.rss, 0),
    controllerRssKiB: controller.rss,
    childCount: children.length,
  };
}

function rss(ids: readonly number[] = []) {
  return ownedRss(
    execFileSync("/bin/ps", ["-axo", "pid=,ppid=,rss=,comm="], { encoding: "utf8", timeout: 3000 }),
    process.pid,
    ids,
  );
}

function statistics(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  assert(sorted.length > 0);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return {
    median: Math.round(median * 1000) / 1000,
    p95: Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1]! * 1000) / 1000,
  };
}

async function sampleRequests(
  base: string,
  cookie: string,
  target: "health" | "channels",
  phase: string,
) {
  const samplesMs: number[] = [];
  const batchDeadline = AbortSignal.timeout(60_000);
  for (let index = 0; index < 110; index++) {
    const started = performance.now();
    const response = await fetch(`${base}${target === "health" ? "/health" : "/api/v1/channels"}`, {
      headers: { Cookie: cookie },
      redirect: "error",
      signal: AbortSignal.any([batchDeadline, AbortSignal.timeout(5000)]),
    });
    assert.equal(response.status, 200, "Measured request did not succeed.");
    const value = (await response.json()) as { phase?: unknown; channels?: unknown };
    assert(
      target === "health" ? value.phase === phase : Array.isArray(value.channels),
      "Measured response has an unexpected shape.",
    );
    if (index >= 10) samplesMs.push(Math.round((performance.now() - started) * 1000) / 1000);
  }
  return { warmupRequests: 10, samplesMs, ...statistics(samplesMs) };
}

async function sha256(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export async function measureTsProduct(runtimeRoot: string) {
  assert(
    process.platform === "darwin" && process.arch === "arm64",
    "Measurement is qualified only on macOS arm64.",
  );
  assert(
    !process.env.OPENBOT_DESKTOP_TAVILY_API_KEY && !process.env.OPENBOT_PLUGIN_LOCAL_ENDPOINTS,
    "Measurement refuses configured external Desktop transports.",
  );
  const { selectsTsProduct } = (await import(
    pathToFileURL(join(desktopDist, "ts-server.js")).href
  )) as typeof import("../src/ts-server.ts");
  assert(await selectsTsProduct(runtimeRoot), "Measurement requires a marked TS/Python candidate.");
  const sourceDigests: Record<string, string> = {};
  for (const name of [
    "app.js",
    "tls.js",
    "config.js",
    "worker-tunnel.js",
    "lifetime.js",
    "desktop-entry.js",
  ]) {
    const expected = await sha256(join(serverDist, name));
    assert.equal(
      await sha256(join(runtimeRoot, "apps/server-ts/dist", name)),
      expected,
      "Candidate TS code differs from current compiled source.",
    );
    sourceDigests[`server-ts/${name}`] = expected;
  }
  for (const name of [
    "main.js",
    "native-server.js",
    "python-server.js",
    "ts-server.js",
    "ts-product-manifest.js",
  ])
    sourceDigests[`desktop/${name}`] = await sha256(join(desktopDist, name));
  sourceDigests["python/serve.py"] = await sha256(
    join(runtimeRoot, "apps/server-python/scripts/serve.py"),
  );
  sourceDigests["python/requirements-product.lock"] = await sha256(
    join(runtimeRoot, "apps/server-python/requirements-product.lock"),
  );
  sourceDigests["measurement"] = await sha256(fileURLToPath(import.meta.url));
  const { NativeServerController, launchDesktopProductServer, launchPythonProductServer } =
    await loadDesktopModules(desktopDist);
  const root = await realpath(await mkdtemp(join(tmpdir(), "openbot-p2-overhead-")));
  const results: {
    trial: number;
    composition: Mode;
    start: Start;
    readyMs: number;
    serverMs: number;
    samples: Rss[];
    requests: {
      health: Awaited<ReturnType<typeof sampleRequests>>;
      channels: Awaited<ReturnType<typeof sampleRequests>>;
    };
  }[] = [];
  try {
    for (let trial = 1; trial <= 3; trial++) {
      // Alternate order to reduce cache/order bias. Every composition gets its own new data root.
      const modes: Mode[] =
        trial % 2 ? ["python-direct", "ts-forwarding"] : ["ts-forwarding", "python-direct"];
      for (const composition of modes) {
        let serverMs = 0;
        let ids: readonly number[] = [];
        let base = "";
        let cookie = "";
        const phase =
          composition === "python-direct"
            ? "python-product-candidate"
            : "typescript-product-candidate";
        const login = async (url: string, password: string) => {
          const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
          assert.equal(((await health.json()) as { phase: unknown }).phase, phase);
          const response = await fetch(`${url}/api/v1/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: url },
            body: JSON.stringify({ password }),
            signal: AbortSignal.timeout(5000),
          });
          assert.equal(response.status, 200);
          cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
          assert(cookie.startsWith("openbot_session="));
          await response.arrayBuffer();
          base = url;
        };
        const dataRoot = join(root, `${trial}-${composition}`);
        await configureNativeWorkFixture(dataRoot);
        const controller = new NativeServerController({
          runtimeRoot,
          dataRoot,
          platform: process.platform,
          // Synthetic callbacks only; the engine is real. This does not measure Electron or Keychain.
          encrypt: (value) => Buffer.from(value).toString("base64"),
          decrypt: (value) => Buffer.from(value, "base64").toString(),
          launchServer: async (environment) => {
            const started = performance.now();
            const product = await (composition === "python-direct"
              ? launchPythonProductServer
              : launchDesktopProductServer)(runtimeRoot, environment);
            serverMs = performance.now() - started;
            ids = product.processIds;
            assert.equal(ids.length, composition === "python-direct" ? 1 : 2);
            return product;
          },
          connect: login,
          authenticate: login,
        });
        try {
          for (const start of ["fresh-profile", "restart"] as const) {
            const started = performance.now();
            assert.equal(
              (await controller.start()).status,
              "ready",
              "Native measurement startup failed.",
            );
            const readyMs = performance.now() - started;
            const postgresId = Number(
              (await readFile(join(dataRoot, "postgres/postmaster.pid"), "utf8")).split("\n")[0],
            );
            await delay(2000);
            const samples: Rss[] = [];
            for (let index = 0; index < 3; index++) {
              samples.push(rss(ids));
              await delay(500);
            }
            const requests = {
              health: await sampleRequests(base, cookie, "health", phase),
              channels: await sampleRequests(base, cookie, "channels", phase),
            };
            results.push({
              trial,
              composition,
              start,
              readyMs: Math.round(readyMs),
              serverMs: Math.round(serverMs),
              samples,
              requests,
            });
            console.error(
              JSON.stringify({ trial, composition, start, readyMs: Math.round(readyMs) }),
            );
            await controller.stop();
            await confirmProcessesStopped([...ids, postgresId]);
            await assert.rejects(fetch(`${base}/health`, { signal: AbortSignal.timeout(500) }));
            assert.equal(
              rss().childCount,
              0,
              "Owned native descendants survived measurement stop.",
            );
          }
        } finally {
          await controller.stop();
        }
      }
    }
    const summary = (["python-direct", "ts-forwarding"] as const).map((composition) => ({
      composition,
      freshReadyMs: statistics(
        results
          .filter((r) => r.composition === composition && r.start === "fresh-profile")
          .map((r) => r.readyMs),
      ),
      restartReadyMs: statistics(
        results
          .filter((r) => r.composition === composition && r.start === "restart")
          .map((r) => r.readyMs),
      ),
      nativeChildrenRssKiB: statistics(
        results
          .filter((r) => r.composition === composition)
          .flatMap((r) => r.samples.map((s) => s.nativeChildrenRssKiB)),
      ),
      tsRssKiB: statistics(
        results
          .filter((r) => r.composition === composition)
          .flatMap((r) => r.samples.map((s) => s.tsRssKiB)),
      ),
      healthMs: statistics(
        results
          .filter((r) => r.composition === composition)
          .flatMap((r) => r.requests.health.samplesMs),
      ),
      channelsMs: statistics(
        results
          .filter((r) => r.composition === composition)
          .flatMap((r) => r.requests.channels.samplesMs),
      ),
    }));
    return {
      kind: "same-source-native-idle-work-overhead",
      date: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      sourceHead: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
        timeout: 3000,
      }).trim(),
      sourceDirty:
        execFileSync("git", ["status", "--porcelain"], {
          encoding: "utf8",
          timeout: 3000,
        }).trim().length > 0,
      sourceDigests,
      method: {
        trialsPerComposition: 3,
        startsPerTrial: ["fresh-profile", "restart"],
        order: "alternating",
        sameRuntimePayload: true,
        settleMs: 2000,
        rssSamplesPerStart: 3,
        rssIntervalMs: 500,
        requestConcurrency: 1,
        requestsPerTargetPerStart: 100,
        warmupPerTargetPerStart: 10,
        latencyScope: "fetch through consumed JSON body over loopback HTTP",
        rssScope: "controller descendants, excluding ps",
        syntheticEncryption: true,
        liveModelCalls: 0,
        engine: "Temporal1.32.0/SQLite/mTLS",
        workerConnected: true,
      },
      summary,
      results,
      ownedProcessesStopped: true,
      disposableDataRemoved: true,
      unqualified: [
        "Electron renderer/Keychain timing",
        "public TLS/network throughput",
        "in-flight Work execution cost",
        "hosted platforms",
      ],
    };
  } finally {
    assert.equal(rss().childCount, 0, "Refusing to remove a fixture with live owned descendants.");
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 || !process.argv[2])
    throw new Error("Usage: measure-ts-product <candidate-native-runtime>");
  if (!(await runNativeWorkFixture("measure", resolve(process.argv[2]))))
    console.log(JSON.stringify(await measureTsProduct(resolve(process.argv[2])), null, 2));
}
