/** Root-only disposable browser relay; the original composition owns all native authority and expiry. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, lstatSync, openSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Readable } from "node:stream";
import { strictCommandJson } from "../../apps/server/dist/work-command-values.js";
import { directory, digest, readBytes } from "../linux-execution/protected-io.ts";
import { nativeBrowserFailure } from "./native-browser-protocol.ts";
import { openNativeRelay } from "./native-browser-relay.ts";
const BASE = "/opt/obp4",
  PROGRAM = BASE + "/composition-20260926-a1/run.py",
  LAUNCHER = BASE + "/browser-launcher.cjs";
const environment = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" };
async function bounded<T>(promise: Promise<T>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Original native browser wait expired")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function productAcceptance(input: Readable) {
  const read = async () => {
    let bytes = Buffer.alloc(0);
    for await (const part of input) {
      bytes = Buffer.concat([bytes, Buffer.from(part)]);
      assert(bytes.length <= 1024, "Product acceptance bound");
      if (bytes.includes(10)) {
        assert(
          bytes.at(-1) === 10 && bytes.indexOf(10) === bytes.length - 1,
          "One acceptance line required",
        );
        const value = strictCommandJson(bytes.subarray(0, -1), 8192) as Record<string, unknown>;
        assert(
          value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            Object.keys(value).length === 1 &&
            typeof value.productAccepted === "boolean",
          "Product acceptance changed",
        );
        return value.productAccepted;
      }
    }
    throw new Error("Product acceptance missing");
  };
  try {
    return await bounded(read(), 360000);
  } finally {
    input.destroy();
  }
}
function privateJson(path: string) {
  return JSON.parse(
    new TextDecoder("utf8", { fatal: true }).decode(readBytes(path, 96 * 1024)),
  ) as Record<string, unknown>;
}

function exit(child: ChildProcess) {
  const done = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  done.catch(() => {});
  return done;
}
async function operation(name: "finish" | "abort") {
  // The reviewed composition is retained until its TS native replacement passes; never search PATH.
  const child = spawn("/usr/bin/python3", ["-B", PROGRAM, name], {
    env: environment,
    stdio: "ignore",
  });
  const done = exit(child);
  try {
    assert.equal(await bounded(done, 10000), 0, "Original composition refused operation");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await bounded(done, 5000);
    }
  }
}
export async function launchNativeBrowser() {
  assert(
    process.platform === "linux" &&
      process.geteuid?.() === 0 &&
      process.argv[1] &&
      realpathSync(process.argv[1]) === LAUNCHER,
    "Root CI packet required",
  );
  process.umask(0o077);
  for (const path of ["/opt", BASE]) {
    const info = lstatSync(path);
    assert(
      info.isDirectory() && info.uid === 0 && !(info.mode & 0o022),
      "Root-owned packet ancestor required",
    );
  }
  directory(BASE);
  const plan = privateJson(BASE + "/PLAN.json");
  for (const [path, expected] of [
    [LAUNCHER, plan.browserLauncherSha256],
    [BASE + "/node", plan.browserNodeSha256],
  ] as const) {
    const info = lstatSync(path);
    assert(
      info.isFile() && info.uid === 0 && info.nlink === 1 && !(info.mode & 0o022),
      "Native launcher file changed",
    );
    assert.equal(digest(path), expected, "Native launcher pin changed");
  }
  assert(
    typeof plan.nativeRoot === "string" &&
      /^\/opt\/obp4\/units\/deadline-a1-p4[a-f0-9]{6}$/.test(plan.nativeRoot),
    "Original native root changed",
  );
  const root = plan.nativeRoot;
  assert(!existsSync(root), "Fresh native root required");
  const relays: Awaited<ReturnType<typeof openNativeRelay>>[] = [];
  let child: ChildProcess | undefined,
    done: Promise<number | null> | undefined,
    result: unknown,
    failure: unknown,
    phase = "readiness";
  const log = openSync(BASE + "/browser-private.log", "wx", 0o600);
  try {
    child = spawn("/usr/bin/python3", ["-B", PROGRAM, "run"], {
      env: environment,
      stdio: ["ignore", log, log],
    });
    done = exit(child);
    let closed = false;
    void done
      .finally(() => {
        closed = true;
      })
      .catch(() => {});
    const end = performance.now() + 150000;
    while (!existsSync(join(root, "ready.json"))) {
      assert(!closed, "Native browser before readiness failed");
      assert(performance.now() < end, "Native browser readiness unknown");
      await delay(100);
    }
    const urls: Record<string, string> = {};
    for (const name of ["control", "target"]) {
      const relay = await openNativeRelay(
        { host: "127.0.0.1", port: 0 },
        { path: join(root, name + ".sock") },
      );
      relays.push(relay);
      const address = relay.address();
      assert(typeof address === "object");
      urls[name] = "http://127.0.0.1:" + address.port;
    }
    console.log(
      JSON.stringify({
        fixtureEnvironment: "disposable-github-linux",
        computerUrl: urls.control,
        stateUrl: urls.target,
        targetUrl: "https://example.com:18443",
        token: "synthetic-linux-composition-fixture-only",
      }),
    );
    phase = "product";
    const accepted = await productAcceptance(process.stdin);
    phase = "finish";
    await operation(accepted ? "finish" : "abort");
    phase = "expiry";
    const code = await bounded(done, 620000);
    result = privateJson(join(root, "result.json"));
    const value = result as Record<string, unknown>;
    assert(
      code === 0 &&
        accepted &&
        [
          "accepted",
          "actualRunsc",
          "actualSquid",
          "actualProductJourney",
          "originalNativeExpiryVerified",
          "productionUnchanged",
          "ownedRuntimeRemoved",
        ].every((key) => value[key] === true) &&
        value.nativeDeadlineSeconds === 600,
      "Original native acceptance failed",
    );
  } catch (error) {
    failure = error;
  } finally {
    if (child && done && child.exitCode === null && child.signalCode === null) {
      try {
        await operation("abort");
      } catch (error) {
        failure ??= error;
      }
      try {
        await bounded(done, 30000);
      } catch (error) {
        failure ??= error;
        child.kill("SIGTERM");
        try {
          await bounded(done, 5000);
        } catch (error) {
          failure ??= error;
          child.kill("SIGKILL");
          try {
            await bounded(done, 5000);
          } catch (error) {
            failure ??= error;
          }
        }
      }
    }
    const cleanup = await Promise.allSettled(relays.map((relay) => relay.close()));
    for (const value of cleanup) if (value.status === "rejected") failure ??= value.reason;
    closeSync(log);
  }
  if (failure) {
    if (result === undefined && existsSync(join(root, "result.json"))) {
      try {
        result = privateJson(join(root, "result.json"));
      } catch {
        /* Only bounded validated flags enter the public diagnostic. */
      }
    }
    console.log(JSON.stringify(nativeBrowserFailure(phase, result)));
    return 1;
  }
  console.log(JSON.stringify(result));
  return 0;
}
if (process.argv[1]?.endsWith("/browser-launcher.cjs")) {
  assert.deepEqual(process.argv.slice(2), ["--root"], "Explicit root browser operation required");
  launchNativeBrowser().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      console.log(JSON.stringify(nativeBrowserFailure("readiness", undefined)));
      process.exitCode = 1;
    },
  );
}
