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
  isProcessIdentity,
  processIdentitiesEqual,
  isProcessAlive,
  observeProcessIdentity,
  digestCiphertext,
} from "./windows-native-smoke-harness.mjs";

const RESULT_SCHEMA_VERSION = 1;
const STATE_SCHEMA_VERSION = 1;
const STATE_FILE_NAME = "remote-desktop-state.json";
const LIVE_PROCESSES_FILE_NAME = "harness-live-processes.json";

// Synthetic, non-secret fixture. It is deliberately a fixed literal so both
// lifetimes can assert byte-for-byte equality without reading a real secret.
const SYNTHETIC_FIXTURE = "openbot-remote-smoke-synthetic-v1";
const STATE_MARKER = "openbot-remote-desktop-smoke";

const FIRST_CHECKS = Object.freeze([
  "safe-storage-available",
  "encrypt",
  "decrypt",
  "state-persisted",
  "no-plaintext-secret",
]);
const RESTART_CHECKS = Object.freeze([
  "safe-storage-available",
  "decrypt-after-restart",
  "ciphertext-stable",
  "no-plaintext-secret",
]);

/**
 * @typedef {{
 *   pid: number,
 *   startTimeUtc: string | null,
 *   executablePath: string | null,
 * }} ProcessIdentity
 */

/**
 * @param {unknown} value
 * @returns {value is ProcessIdentity}
 */
function requireObservedIdentity(pid) {
  const observed = observeProcessIdentity(pid);
  assert.ok(
    observed?.startTimeUtc && observed?.executablePath,
    `complete process identity missing for pid ${pid}`,
  );
  return observed;
}

/**
 * Fail closed if the previous Electron lifetime is still running under the same
 * identity. A reused PID with a different start time/path is a different process.
 * @param {ProcessIdentity | null | undefined} previous
 */
function assertPreviousLifetimeEnded(previous) {
  if (previous == null) return;
  if (!isProcessIdentity(previous)) throw new Error("Previous Electron identity is invalid.");
  if (!isProcessAlive(previous.pid)) return;
  if (previous.startTimeUtc == null || previous.executablePath == null) {
    throw new Error(`Previous Electron lifetime ${previous.pid} is alive without a full identity.`);
  }
  const current = observeProcessIdentity(previous.pid);
  if (current == null || processIdentitiesEqual(previous, current)) {
    throw new Error(`Previous Electron lifetime ${previous.pid} is still alive.`);
  }
}

/**
 * SHA-256 hex digest of ciphertext (never log raw ciphertext).
 * @param {string} ciphertext
 */
function isRemoteSmokeState(value) {
  if (!value || typeof value !== "object") return false;
  const state = /** @type {Record<string, unknown>} */ (value);
  return (
    state.schemaVersion === STATE_SCHEMA_VERSION &&
    state.marker === STATE_MARKER &&
    typeof state.ciphertext === "string" &&
    state.ciphertext.length > 0 &&
    typeof state.ciphertextDigest === "string" &&
    /^[0-9a-f]{64}$/u.test(state.ciphertextDigest) &&
    (state.electron === null || isProcessIdentity(state.electron)) &&
    Number.isInteger(state.lifetimesCompleted) &&
    /** @type {number} */ (state.lifetimesCompleted) >= 1 &&
    typeof state.firstLifetimeComplete === "boolean"
  );
}

async function readState() {
  const raw = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(isRemoteSmokeState(raw), true, "remote smoke state is incomplete");
  return raw;
}

/**
 * @param {ReturnType<typeof buildState>} state
 */
async function writeState(state) {
  assert.equal(isRemoteSmokeState(state), true, "refusing to persist incomplete state");
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Plaintext fixture bytes must never reach a persisted file or log line. The
 * state file is allowed to hold ciphertext; only the receipt must reduce it to a
 * digest, which writeReceipt enforces separately.
 * @param {string} text
 * @param {string} label
 */
function assertNoPlaintextSecret(text, label) {
  assert.equal(
    text.includes(SYNTHETIC_FIXTURE),
    false,
    `${label} must not contain the plaintext fixture string`,
  );
}

/**
 * The receipt surface must never carry raw ciphertext or password fields — only
 * the sha256 digest of the ciphertext.
 * @param {string} receiptText
 */
function assertReceiptHasNoRawSecrets(receiptText) {
  assert.equal(
    /"ciphertext"\s*:/u.test(receiptText),
    false,
    "receipt must not contain a raw ciphertext field",
  );
  assert.equal(
    /"(?:password|plaintext|secret)"\s*:/iu.test(receiptText),
    false,
    "receipt must not contain password/plaintext/secret fields",
  );
  assertNoPlaintextSecret(receiptText, "receipt");
}

/**
 * @param {{ mode: "first" | "restart", ciphertextDigest: string, electron: ProcessIdentity, checks: readonly string[] }} fields
 */
function buildReceipt(fields) {
  assert.match(fields.ciphertextDigest, /^[0-9a-f]{64}$/u, "ciphertextDigest must be sha256 hex");
  assert.equal(isProcessIdentity(fields.electron), true, "electron identity is required");
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    platform: process.platform,
    arch: process.arch,
    mode: fields.mode,
    ciphertextDigest: fields.ciphertextDigest,
    electron: fields.electron,
    checks: [...fields.checks],
  };
}

/**
 * @param {ReturnType<typeof buildReceipt>} receipt
 * @param {string} receiptText
 */
async function writeReceipt(receipt, receiptText) {
  assertReceiptHasNoRawSecrets(receiptText);
  await writeFile(resultPath, receiptText, { flag: "wx" });
}

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("This remote Desktop smoke gate requires native Windows x64.");
}
if (!process.argv[2]) throw new Error("A fresh isolated fixture root is required.");
if (!process.argv[3]) throw new Error("A fresh remote smoke result path is required.");
const harnessRoot = resolve(process.argv[2]);
const resultPath = resolve(process.argv[3]);
const mode = process.argv[4] ?? "first";
if (mode !== "first" && mode !== "restart") {
  throw new Error('Remote smoke mode must be "first" or "restart".');
}

const statePath = join(harnessRoot, STATE_FILE_NAME);
const liveProcessesPath = join(harnessRoot, LIVE_PROCESSES_FILE_NAME);
const electronUserData = join(harnessRoot, "electron-user-data");
const electronSessionData = join(harnessRoot, "electron-session-data");

// The orchestrator owns the fixture root. On the first lifetime it must be
// fresh; only the second lifetime may reuse it (and only then may state exist).
if (mode === "first") {
  if (existsSync(harnessRoot)) {
    throw new Error("The first lifetime requires a fresh, nonexistent fixture root.");
  }
  mkdirSync(harnessRoot, { recursive: true });
} else {
  if (!existsSync(harnessRoot)) {
    throw new Error(
      "The restart lifetime requires the fixture root created by the first lifetime.",
    );
  }
  if (!existsSync(statePath)) {
    throw new Error("The restart lifetime requires state persisted by the first lifetime.");
  }
}
// Create isolated profile dirs BEFORE setPath: Electron may touch them immediately.
mkdirSync(electronUserData, { recursive: true });
mkdirSync(electronSessionData, { recursive: true });

// Keep both Electron profile paths inside the disposable fixture. The real
// per-user OpenBot profile is never read or modified.
app.setPath("userData", electronUserData);
app.setPath("sessionData", electronSessionData);

// Record this lifetime's identity before any assertion so the orchestrator can
// clean up a verified process even if the smoke fails before writing state.
const liveElectron = requireObservedIdentity(process.pid);
writeFileSync(liveProcessesPath, `${JSON.stringify({ electron: liveElectron }, null, 2)}\n`);

/**
 * @param {{ ciphertext: string, ciphertextDigest: string, electron: ProcessIdentity }} fields
 */
function buildState(fields) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    marker: STATE_MARKER,
    ciphertext: fields.ciphertext,
    ciphertextDigest: fields.ciphertextDigest,
    electron: fields.electron,
    lifetimesCompleted: 1,
    firstLifetimeComplete: true,
  };
}

async function runFirstLifetime() {
  const checks = [];
  const available = await safeStorage.isAsyncEncryptionAvailable();
  assert.equal(available, true, "system async safeStorage (DPAPI) must be available");
  checks.push("safe-storage-available");

  const encrypted = await safeStorage.encryptStringAsync(SYNTHETIC_FIXTURE);
  assert.ok(
    (Buffer.isBuffer(encrypted) || encrypted instanceof Uint8Array) && encrypted.length > 0,
    "safeStorage must return non-empty ciphertext bytes",
  );
  const ciphertext = Buffer.from(encrypted).toString("base64");
  assert.ok(ciphertext.length > 0, "safeStorage ciphertext must encode to non-empty base64");
  checks.push("encrypt");

  const decrypted = (await safeStorage.decryptStringAsync(Buffer.from(ciphertext, "base64")))
    .result;
  assert.equal(decrypted, SYNTHETIC_FIXTURE, "safeStorage decrypt must round-trip the fixture");
  checks.push("decrypt");

  const electron = requireObservedIdentity(process.pid);
  const ciphertextDigest = digestCiphertext(ciphertext);
  await writeState(buildState({ ciphertext, ciphertextDigest, electron }));
  checks.push("state-persisted");

  assertNoPlaintextSecret(await readFile(statePath, "utf8"), "state file");
  checks.push("no-plaintext-secret");
  assert.deepEqual(checks, [...FIRST_CHECKS], "first lifetime checks must match the gate");

  const receipt = buildReceipt({ mode: "first", ciphertextDigest, electron, checks });
  await writeReceipt(receipt, `${JSON.stringify(receipt, null, 2)}\n`);
  console.info(
    `Windows remote smoke first lifetime passed (electronPid=${process.pid}, ciphertextDigest=${ciphertextDigest}).`,
  );
}

async function runRestartLifetime() {
  const previous = await readState();
  assert.equal(previous.firstLifetimeComplete, true, "restart requires a completed first lifetime");
  // Fail closed if the first Electron lifetime somehow survived the orchestrator.
  assertPreviousLifetimeEnded(previous.electron);

  const checks = [];
  const available = await safeStorage.isAsyncEncryptionAvailable();
  assert.equal(available, true, "system async safeStorage (DPAPI) must be available");
  checks.push("safe-storage-available");

  const stateRawBefore = await readFile(statePath, "utf8");
  const ciphertextBytes = Buffer.from(previous.ciphertext, "base64");
  assert.ok(ciphertextBytes.length > 0, "persisted ciphertext must be non-empty");
  const decrypted = (await safeStorage.decryptStringAsync(ciphertextBytes)).result;
  assert.equal(
    decrypted,
    SYNTHETIC_FIXTURE,
    "restart must decrypt the ciphertext persisted by the first lifetime",
  );
  checks.push("decrypt-after-restart");

  // The persisted ciphertext and its digest must be unchanged by the restart.
  const stateRawAfter = await readFile(statePath, "utf8");
  assert.equal(stateRawBefore, stateRawAfter, "state file must not change during restart");
  const reread = await readState();
  assert.equal(reread.ciphertext, previous.ciphertext, "ciphertext must survive restart unchanged");
  assert.equal(
    digestCiphertext(reread.ciphertext),
    previous.ciphertextDigest,
    "ciphertext digest must survive restart unchanged",
  );
  checks.push("ciphertext-stable");

  assertNoPlaintextSecret(stateRawAfter, "state file");
  checks.push("no-plaintext-secret");
  assert.deepEqual(checks, [...RESTART_CHECKS], "restart lifetime checks must match the gate");

  const electron = requireObservedIdentity(process.pid);
  const receipt = buildReceipt({
    mode: "restart",
    ciphertextDigest: previous.ciphertextDigest,
    electron,
    checks,
  });
  await writeReceipt(receipt, `${JSON.stringify(receipt, null, 2)}\n`);
  console.info(
    `Windows remote smoke restart lifetime passed (electronPid=${process.pid}, ciphertextDigest=${previous.ciphertextDigest}).`,
  );
}

// Electron emits ready after ESM evaluation; awaiting it at module scope deadlocks.
void app
  .whenReady()
  .then(async () => {
    try {
      if (mode === "first") await runFirstLifetime();
      else await runRestartLifetime();
      app.quit();
    } catch (error) {
      console.error(
        JSON.stringify({
          summary:
            "Windows remote Desktop smoke failed; the orchestrator will clean up verified harness processes.",
          mode,
          electronPid: process.pid,
          harnessRoot,
        }),
      );
      console.error("Windows remote Desktop smoke failure:", error);
      app.exit(1);
    }
  })
  .catch((error) => {
    console.error("Windows remote Desktop smoke failed before ready:", error);
    app.exit(1);
  });
