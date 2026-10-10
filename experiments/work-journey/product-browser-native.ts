/** Connects the TS journey to the existing fixed root-private composition and its original expiry. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { strictCommandJson } from "../../apps/server/dist/work-command-values.js";
import { jsonFile, privateJson, record } from "./browser-product-fixture.ts";
import { qualifyBrowser, remoteBrowserConfiguration } from "./product-browser-probe.ts";

const MAXIMUM = 96 * 1024;
export const nativeBrowserAcceptance = z
  .object({
    accepted: z.literal(true),
    actualRunsc: z.literal(true),
    actualSquid: z.literal(true),
    actualProductJourney: z.literal(true),
    originalNativeExpiryVerified: z.literal(true),
    productionUnchanged: z.literal(true),
    ownedRuntimeRemoved: z.literal(true),
    nativeDeadlineSeconds: z.literal(600),
  })
  .passthrough();
async function deadline<T>(promise: Promise<T>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Original browser fixture deadline expired")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function qualifyNativeBrowser(
  options: {
    directory: string;
    upstream: string;
    browsers: string;
  },
  productJourney: typeof qualifyBrowser = qualifyBrowser,
) {
  assert.equal(process.platform, "linux");
  process.umask(0o077);
  await assert.rejects(
    lstat(options.directory),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    "Use a fresh owned browser output",
  );
  // This root entry remains the existing disposable packet until its composition migration lands.
  // It never searches for a Host, accepts a remote target, or renews a native unit.
  const child = spawn(
    "/usr/bin/sudo",
    ["-n", "/usr/bin/python3", "-B", "/opt/obp4/browser_launcher.py", "--root"],
    { stdio: "pipe" },
  );
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  exit.catch(() => {});
  child.stdin.on("error", () => {});
  let stderr = Buffer.alloc(0),
    exceeded = false;
  child.stderr.on("data", (bytes: Buffer) => {
    if (stderr.length + bytes.length <= MAXIMUM) stderr = Buffer.concat([stderr, bytes]);
    else exceeded = true;
  });
  async function* lines() {
    let bytes = Buffer.alloc(0),
      total = 0;
    for await (const part of child.stdout) {
      total += part.length;
      assert(total <= MAXIMUM, "Native browser capture bound");
      bytes = Buffer.concat([bytes, part]);
      let at = bytes.indexOf(10);
      while (at >= 0) {
        yield strictCommandJson(bytes.subarray(0, at), 32768);
        bytes = bytes.subarray(at + 1);
        at = bytes.indexOf(10);
      }
    }
    assert.equal(bytes.length, 0, "Native browser incomplete response");
  }
  const output = lines();
  let accepted = false,
    phase = "readiness",
    candidate: unknown,
    failure: unknown,
    product: Record<string, unknown> | undefined;
  try {
    const first = await deadline(output.next(), 160000);
    assert(!first.done, "Native browser readiness missing");
    candidate = first.value;
    const remote = remoteBrowserConfiguration.parse(first.value);
    phase = "product";
    await productJourney({ ...options, recovery: "linux-replacement", remote });
    child.stdin.end('{"productAccepted":true}\n');
    phase = "expiry";
    const finished = await deadline(output.next(), 620000);
    assert(!finished.done, "Original browser result missing");
    candidate = finished.value;
    const native = nativeBrowserAcceptance.parse(finished.value);
    assert.equal(await deadline(exit, 10000), 0);
    assert(!exceeded, "Native stderr bound exceeded");
    assert((await output.next()).done, "Unexpected native browser response");
    product = record.parse(await jsonFile(join(options.directory, "RESULT.json")));
    assert(
      product.accepted === true &&
        product.ownedFixturesClosed === true &&
        product.isolatedLinuxBrowserProduct === true,
    );
    Object.assign(product, {
      remoteNativeCleanupPending: false,
      nativeAcceptance: native,
      nativeCleanupComplete: true,
    });
    accepted = true;
  } catch (error) {
    failure = error;
  }
  if (!accepted && child.exitCode === null && child.signalCode === null) {
    if (!child.stdin.writableEnded) child.stdin.end('{"productAccepted":false}\n');
    try {
      await deadline(exit, 45000);
    } catch (error) {
      child.kill("SIGTERM");
      try {
        await deadline(exit, 10000);
      } catch (killError) {
        failure = new AggregateError(
          [failure, error, killError],
          "Original browser cleanup unconfirmed",
        );
      }
    }
  }
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  await writeFile(join(options.directory, "native.stderr-private"), stderr, { mode: 0o600 });
  if (!accepted) {
    try {
      product = record.parse(await jsonFile(join(options.directory, "RESULT.json")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (product)
      Object.assign(product, {
        accepted: false,
        nativeCleanupComplete: false,
        nativeFailure: nativeBrowserFailure(phase, candidate).nativeBrowserFailure,
      });
  }
  if (product) await privateJson(join(options.directory, "RESULT.json"), product);
  if (failure) {
    console.log(JSON.stringify(nativeBrowserFailure(phase, candidate)));
    throw failure;
  }
  console.log(JSON.stringify(product));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
      upstream: { type: "string" },
      browsers: { type: "string" },
    },
    strict: true,
  });
  assert(values.output && values.upstream && values.browsers);
  await qualifyNativeBrowser({
    directory: resolve(values.output),
    upstream: resolve(values.upstream),
    browsers: resolve(values.browsers),
  });
}

/** Fixed public diagnostics; raw root errors, subprocess streams and configuration remain private. */
export function nativeBrowserFailure(phase: string, value: unknown) {
  const phases = ["readiness", "product", "finish", "expiry"];
  assert(phases.includes(phase), "Native failure phase changed");
  const object = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const outer = object(value),
    item = object(outer.nativeBrowserFailure),
    flags = object(item.nativeFlags ?? value);
  const codes = [
    "verified_tls_tunnel_missing",
    "tunnel_revocation_missing",
    "tunnel_revocation_failed",
    "native_timeout_changed",
    "native_cgroup_not_empty",
    "native_host_state_changed",
    "image_name_missing",
    "image_digest_missing",
    "native_acceptance_failed",
    "fixture_failed",
  ];
  const result: Record<string, unknown> = {
    phase: typeof item.phase === "string" && phases.includes(item.phase) ? item.phase : phase,
    code: typeof item.code === "string" && codes.includes(item.code) ? item.code : "fixture_failed",
    nativeFlags: Object.fromEntries(
      [
        "accepted",
        "actualRunsc",
        "actualSquid",
        "actualProductJourney",
        "originalNativeExpiryVerified",
        "failedOriginalUnitClosed",
        "productionUnchanged",
        "ownedRuntimeRemoved",
      ]
        .filter((k) => typeof flags[k] === "boolean")
        .map((k) => [k, flags[k]]),
    ),
  };
  for (const name of ["nativeDeadlineSeconds", "existingContainerCount"]) {
    const n = item[name] ?? outer[name];
    if (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 65535) result[name] = n;
  }
  for (const name of ["failureCode", "cleanupFailureCode"])
    if (typeof item[name] === "string" && codes.includes(item[name])) result[name] = item[name];
  return { nativeBrowserFailure: result };
}
