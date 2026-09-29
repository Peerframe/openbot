// Copyright (c) Peerframe/openbot contributors.
// SPDX-License-Identifier: MIT
// Derived from the MIT-licensed Peerframe/openbot Windows native smoke gate at
// commit 1dacf4e814bba0947ea0ce54e5c3db45bb21b1b3. Copyright and license notices
// of the original source are retained.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isProcessIdentity, type ProcessIdentity } from "./smoke-process-identity.ts";
const RESULT_SCHEMA_VERSION = 1;
const STATE_SCHEMA_VERSION = 1;
export const STATE_FILE_NAME = "remote-desktop-state.json";
export const LIVE_PROCESSES_FILE_NAME = "harness-live-processes.json";
export const SYNTHETIC_FIXTURE = "openbot-remote-smoke-synthetic-v1";
const STATE_MARKER = "openbot-remote-desktop-smoke";
export const FIRST_CHECKS = Object.freeze([
  "safe-storage-available",
  "encrypt",
  "decrypt",
  "state-persisted",
  "no-plaintext-secret",
] as const);
export const RESTART_CHECKS = Object.freeze([
  "safe-storage-available",
  "decrypt-after-restart",
  "ciphertext-stable",
  "no-plaintext-secret",
] as const);
export type SmokeMode = "first" | "restart";
export type RemoteSmokeState = {
  readonly schemaVersion: 1;
  readonly marker: typeof STATE_MARKER;
  readonly ciphertext: string;
  readonly ciphertextDigest: string;
  readonly electron: ProcessIdentity | null;
  readonly lifetimesCompleted: number;
  readonly firstLifetimeComplete: boolean;
};
type RemoteSmokeReceipt = {
  readonly schemaVersion: 1;
  readonly platform: string;
  readonly arch: string;
  readonly mode: SmokeMode;
  readonly ciphertextDigest: string;
  readonly electron: ProcessIdentity;
  readonly checks: readonly string[];
};
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const isSmokeMode = (value: unknown): value is SmokeMode =>
  value === "first" || value === "restart";
export function digestCiphertext(ciphertext: unknown): string {
  if (typeof ciphertext !== "string" || ciphertext.length === 0)
    throw new Error("ciphertext digest requires non-empty ciphertext.");
  return createHash("sha256").update(ciphertext, "utf8").digest("hex");
}
export function isRemoteSmokeState(value: unknown): value is RemoteSmokeState {
  if (!isRecord(value)) return false;
  const {
    schemaVersion,
    marker,
    ciphertext,
    ciphertextDigest,
    electron,
    lifetimesCompleted,
    firstLifetimeComplete,
  } = value;
  return (
    schemaVersion === STATE_SCHEMA_VERSION &&
    marker === STATE_MARKER &&
    typeof ciphertext === "string" &&
    ciphertext.length > 0 &&
    typeof ciphertextDigest === "string" &&
    SHA256_HEX.test(ciphertextDigest) &&
    (electron === null || isProcessIdentity(electron)) &&
    typeof lifetimesCompleted === "number" &&
    Number.isInteger(lifetimesCompleted) &&
    lifetimesCompleted >= 1 &&
    typeof firstLifetimeComplete === "boolean"
  );
}
export function parseState(text: string): RemoteSmokeState {
  const raw: unknown = JSON.parse(text);
  if (!isRemoteSmokeState(raw)) throw new Error("remote smoke state is incomplete");
  return raw;
}
export function createFirstState(ciphertext: string, electron: ProcessIdentity): RemoteSmokeState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    marker: STATE_MARKER,
    ciphertext,
    ciphertextDigest: digestCiphertext(ciphertext),
    electron,
    lifetimesCompleted: 1,
    firstLifetimeComplete: true,
  };
}
export function serializeState(state: unknown): string {
  if (!isRemoteSmokeState(state)) throw new Error("refusing to persist incomplete state");
  return `${JSON.stringify(state, null, 2)}\n`;
}
export function assertNoPlaintextSecret(text: string, label: string): void {
  if (text.includes(SYNTHETIC_FIXTURE))
    throw new Error(`${label} must not contain the plaintext fixture string`);
}
export function assertReceiptHasNoRawSecrets(receiptText: string): void {
  if (/"ciphertext"\s*:/u.test(receiptText))
    throw new Error("receipt must not contain a raw ciphertext field");
  if (/"(?:password|plaintext|secret)"\s*:/iu.test(receiptText))
    throw new Error("receipt must not contain password/plaintext/secret fields");
  assertNoPlaintextSecret(receiptText, "receipt");
}
/** Verifies the stored digest belongs to the stored ciphertext; the state itself is never repaired. */
export function assertStateDigest(state: RemoteSmokeState): void {
  if (digestCiphertext(state.ciphertext) !== state.ciphertextDigest)
    throw new Error("ciphertext digest must survive restart unchanged");
}
type ReceiptFields = {
  readonly mode: SmokeMode;
  readonly ciphertextDigest: string;
  readonly electron: unknown;
  readonly checks: readonly string[];
  readonly platform: string;
  readonly arch: string;
};
/** Builds the receipt and returns the exact text to create; raw secret leakage is refused here. */
export function renderReceipt(fields: ReceiptFields): string {
  if (!SHA256_HEX.test(fields.ciphertextDigest))
    throw new Error("ciphertextDigest must be sha256 hex");
  if (!isProcessIdentity(fields.electron)) throw new Error("electron identity is required");
  const expected: readonly string[] = fields.mode === "first" ? FIRST_CHECKS : RESTART_CHECKS;
  assert.deepEqual(
    fields.checks,
    [...expected],
    `${fields.mode} lifetime checks must match the gate`,
  );
  const receipt: RemoteSmokeReceipt = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    platform: fields.platform,
    arch: fields.arch,
    mode: fields.mode,
    ciphertextDigest: fields.ciphertextDigest,
    electron: fields.electron,
    checks: [...fields.checks],
  };
  const text = `${JSON.stringify(receipt, null, 2)}\n`;
  assertReceiptHasNoRawSecrets(text);
  return text;
}
