// Copyright (c) Peerframe/openbot contributors.
// SPDX-License-Identifier: MIT
//
// Windows remote-only Desktop smoke harness.
// Derived from the MIT-licensed Peerframe/openbot Windows native smoke gate at
// commit 1dacf4e814bba0947ea0ce54e5c3db45bb21b1b3. Copyright and license notices
// of the original source are retained.
//
// The local TypeScript business Server and its PostgreSQL/native-runtime
// lifecycle have been retired, so this harness no longer starts or talks to a
// server. It runs as the pinned Electron main process and exercises the system
// safeStorage backend (DPAPI on Windows) across exactly two independent Electron
// lifetimes over one synthetic, non-secret fixture string:
//
//   first   - require a fresh isolated profile, encrypt + decrypt the fixture,
//             persist only the ciphertext and its sha256 digest.
//   restart - reuse that same isolated profile, decrypt the persisted ciphertext
//             and prove the ciphertext/digest is unchanged.
//
// The harness never reads or writes a real OpenBot profile: userData and
// sessionData are redirected into the disposable fixture root before ready.
// It performs no network access and prints no plaintext fixture bytes.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { app, safeStorage } from "electron";
import {
  assertPreviousProcessEnded,
  observeProcessIdentity,
  type ProcessIdentity,
} from "./smoke-process-identity.ts";
import {
  LIVE_PROCESSES_FILE_NAME,
  STATE_FILE_NAME,
  SYNTHETIC_FIXTURE,
  assertNoPlaintextSecret,
  assertStateDigest,
  createFirstState,
  isSmokeMode,
  parseState,
  renderReceipt,
  serializeState,
  type SmokeMode,
} from "./remote-smoke-state.ts";
type Paths = { readonly root: string; readonly result: string; readonly state: string };
function requireObservedIdentity(pid: number): ProcessIdentity {
  const observed = observeProcessIdentity(pid);
  if (!observed || !observed.startTimeUtc || !observed.executablePath)
    throw new Error(`complete process identity missing for pid ${pid}`);
  return observed;
}
function parseArguments(argv: readonly string[]): { mode: SmokeMode; paths: Paths } {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("This remote Desktop smoke gate requires native Windows x64.");
  const [, , rootArg, resultArg, modeArg = "first"] = argv;
  if (!rootArg) throw new Error("A fresh isolated fixture root is required.");
  if (!resultArg) throw new Error("A fresh remote smoke result path is required.");
  if (!isSmokeMode(modeArg)) throw new Error('Remote smoke mode must be "first" or "restart".');
  const root = resolve(rootArg);
  return {
    mode: modeArg,
    paths: { root, result: resolve(resultArg), state: join(root, STATE_FILE_NAME) },
  };
}
async function writeReceipt(paths: Paths, text: string): Promise<void> {
  await writeFile(paths.result, text, { flag: "wx" });
}
/** Synchronous pre-ready setup: root policy, userData/sessionData redirect, live identity record. */
function prepareLifetime(mode: SmokeMode, paths: Paths): void {
  if (mode === "first") {
    if (existsSync(paths.root))
      throw new Error("The first lifetime requires a fresh, nonexistent fixture root.");
    mkdirSync(paths.root, { recursive: true });
  } else {
    if (!existsSync(paths.root))
      throw new Error(
        "The restart lifetime requires the fixture root created by the first lifetime.",
      );
    if (!existsSync(paths.state))
      throw new Error("The restart lifetime requires state persisted by the first lifetime.");
  }
  const userData = join(paths.root, "electron-user-data");
  const sessionData = join(paths.root, "electron-session-data");
  mkdirSync(userData, { recursive: true });
  mkdirSync(sessionData, { recursive: true });
  app.setPath("userData", userData);
  app.setPath("sessionData", sessionData);
  const electron = requireObservedIdentity(process.pid);
  writeFileSync(
    join(paths.root, LIVE_PROCESSES_FILE_NAME),
    `${JSON.stringify({ electron }, null, 2)}\n`,
  );
}
async function requireSafeStorage(checks: string[]): Promise<void> {
  assert.equal(
    await safeStorage.isAsyncEncryptionAvailable(),
    true,
    "system async safeStorage (DPAPI) must be available",
  );
  checks.push("safe-storage-available");
}
async function runFirstLifetime(paths: Paths): Promise<void> {
  const checks: string[] = [];
  await requireSafeStorage(checks);
  const encrypted: unknown = await safeStorage.encryptStringAsync(SYNTHETIC_FIXTURE);
  assert.ok(
    (Buffer.isBuffer(encrypted) || encrypted instanceof Uint8Array) && encrypted.length > 0,
    "safeStorage must return non-empty ciphertext bytes",
  );
  const ciphertext = Buffer.from(encrypted).toString("base64");
  assert.ok(ciphertext.length > 0, "safeStorage ciphertext must encode to non-empty base64");
  checks.push("encrypt");
  const { result } = await safeStorage.decryptStringAsync(Buffer.from(ciphertext, "base64"));
  assert.equal(result, SYNTHETIC_FIXTURE, "safeStorage decrypt must round-trip the fixture");
  checks.push("decrypt");
  const electron = requireObservedIdentity(process.pid);
  const state = createFirstState(ciphertext, electron);
  await writeFile(paths.state, serializeState(state));
  checks.push("state-persisted");
  assertNoPlaintextSecret(await readFile(paths.state, "utf8"), "state file");
  checks.push("no-plaintext-secret");
  const digest = state.ciphertextDigest;
  await writeReceipt(
    paths,
    renderReceipt({
      mode: "first",
      ciphertextDigest: digest,
      electron,
      checks,
      platform: process.platform,
      arch: process.arch,
    }),
  );
  console.info(
    `Windows remote smoke first lifetime passed (electronPid=${process.pid}, ciphertextDigest=${digest}).`,
  );
}
async function runRestartLifetime(paths: Paths): Promise<void> {
  const stateRawBefore = await readFile(paths.state, "utf8");
  const previous = parseState(stateRawBefore);
  assert.equal(previous.firstLifetimeComplete, true, "restart requires a completed first lifetime");
  assertPreviousProcessEnded(previous.electron);
  const checks: string[] = [];
  await requireSafeStorage(checks);
  const ciphertextBytes = Buffer.from(previous.ciphertext, "base64");
  assert.ok(ciphertextBytes.length > 0, "persisted ciphertext must be non-empty");
  const { result } = await safeStorage.decryptStringAsync(ciphertextBytes);
  assert.equal(
    result,
    SYNTHETIC_FIXTURE,
    "restart must decrypt the ciphertext persisted by the first lifetime",
  );
  checks.push("decrypt-after-restart");
  const stateRawAfter = await readFile(paths.state, "utf8");
  assert.equal(stateRawBefore, stateRawAfter, "state file must not change during restart");
  const reread = parseState(stateRawAfter);
  assert.equal(reread.ciphertext, previous.ciphertext, "ciphertext must survive restart unchanged");
  assertStateDigest(reread);
  checks.push("ciphertext-stable");
  assertNoPlaintextSecret(stateRawAfter, "state file");
  checks.push("no-plaintext-secret");
  const electron = requireObservedIdentity(process.pid);
  const digest = previous.ciphertextDigest;
  await writeReceipt(
    paths,
    renderReceipt({
      mode: "restart",
      ciphertextDigest: digest,
      electron,
      checks,
      platform: process.platform,
      arch: process.arch,
    }),
  );
  console.info(
    `Windows remote smoke restart lifetime passed (electronPid=${process.pid}, ciphertextDigest=${digest}).`,
  );
}
const { mode, paths } = parseArguments(process.argv);
prepareLifetime(mode, paths);
// Electron emits ready after ESM evaluation; awaiting it at module scope deadlocks.
void app
  .whenReady()
  .then(async () => {
    try {
      if (mode === "first") await runFirstLifetime(paths);
      else await runRestartLifetime(paths);
      app.quit();
    } catch (error) {
      console.error(
        JSON.stringify({
          summary:
            "Windows remote Desktop smoke failed; the orchestrator will clean up verified harness processes.",
          mode,
          electronPid: process.pid,
          harnessRoot: paths.root,
        }),
      );
      console.error("Windows remote Desktop smoke failure:", error);
      app.exit(1);
    }
  })
  .catch((error: unknown) => {
    console.error("Windows remote Desktop smoke failed before ready:", error);
    app.exit(1);
  });
