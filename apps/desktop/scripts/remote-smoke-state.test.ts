// Copyright (c) Peerframe/openbot contributors.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import type { ProcessIdentity } from "./smoke-process-identity.ts";
import {
  FIRST_CHECKS,
  RESTART_CHECKS,
  SYNTHETIC_FIXTURE,
  assertStateDigest,
  createFirstState,
  digestCiphertext,
  parseState,
  renderReceipt,
  serializeState,
} from "./remote-smoke-state.ts";
// Synthetic fixture data only; no Electron, DPAPI or real process involved.
const identity: ProcessIdentity = {
  pid: 4242,
  startTimeUtc: "2026-01-01T00:00:00.0000000Z",
  executablePath: "C:\\x\\electron.exe",
};
const ciphertext = Buffer.from("synthetic-ciphertext-bytes").toString("base64");
const state = createFirstState(ciphertext, identity);
const stateText = serializeState(state);
const receiptFields = (over: Partial<Parameters<typeof renderReceipt>[0]> = {}) => ({
  mode: "first" as const,
  ciphertextDigest: state.ciphertextDigest,
  electron: identity,
  checks: [...FIRST_CHECKS],
  platform: "win32",
  arch: "x64",
  ...over,
});
describe("remote smoke state codec", () => {
  it("round-trips a valid first state byte-for-byte", () => {
    expect(serializeState(parseState(stateText))).toBe(stateText);
    expect(state.ciphertextDigest).toBe(digestCiphertext(ciphertext));
  });
  it.each([
    ["not json", "{"],
    ["array", "[]"],
    ["wrong schema", JSON.stringify({ ...state, schemaVersion: 2 })],
    ["wrong marker", JSON.stringify({ ...state, marker: "other" })],
    ["empty ciphertext", JSON.stringify({ ...state, ciphertext: "" })],
    ["short digest", JSON.stringify({ ...state, ciphertextDigest: "abc" })],
    [
      "uppercase digest",
      JSON.stringify({ ...state, ciphertextDigest: state.ciphertextDigest.toUpperCase() }),
    ],
    [
      "bad identity",
      JSON.stringify({ ...state, electron: { pid: 0, startTimeUtc: null, executablePath: null } }),
    ],
    ["zero lifetimes", JSON.stringify({ ...state, lifetimesCompleted: 0 })],
    ["fractional lifetimes", JSON.stringify({ ...state, lifetimesCompleted: 1.5 })],
    ["string flag", JSON.stringify({ ...state, firstLifetimeComplete: "true" })],
  ])("rejects malformed state: %s", (_label, text) => {
    expect(() => parseState(text)).toThrow();
  });
  it("refuses to serialize incomplete state and empty digests", () => {
    expect(() => serializeState({ ...state, ciphertext: "" })).toThrow(
      "refusing to persist incomplete state",
    );
    expect(() => digestCiphertext("")).toThrow("non-empty ciphertext");
    expect(() => digestCiphertext(undefined)).toThrow("non-empty ciphertext");
  });
  it("detects a digest that does not belong to the ciphertext", () => {
    const wrong = parseState(JSON.stringify({ ...state, ciphertextDigest: "0".repeat(64) }));
    expect(() => assertStateDigest(wrong)).toThrow(
      "ciphertext digest must survive restart unchanged",
    );
    expect(() => assertStateDigest(parseState(stateText))).not.toThrow();
  });
  it("does not mutate parsed state or caller inputs", () => {
    const parsed = parseState(stateText);
    const before = structuredClone(parsed);
    serializeState(parsed);
    assertStateDigest(parsed);
    const checks = [...RESTART_CHECKS];
    renderReceipt(receiptFields({ mode: "restart", checks }));
    expect(parsed).toEqual(before);
    expect(checks).toEqual([...RESTART_CHECKS]);
    expect(stateText).toBe(serializeState(parseState(stateText)));
  });
});
describe("remote smoke receipt", () => {
  it("renders the exact receipt shape without ciphertext or plaintext", () => {
    const text = renderReceipt(receiptFields());
    const parsed: unknown = JSON.parse(text);
    expect(parsed).toEqual({
      schemaVersion: 1,
      platform: "win32",
      arch: "x64",
      mode: "first",
      ciphertextDigest: state.ciphertextDigest,
      electron: identity,
      checks: [...FIRST_CHECKS],
    });
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toContain(ciphertext);
    expect(text).not.toContain(SYNTHETIC_FIXTURE);
  });
  it("refuses plaintext leaking through any string field", () => {
    expect(() => renderReceipt(receiptFields({ platform: SYNTHETIC_FIXTURE }))).toThrow(
      "plaintext fixture",
    );
    const leakyIdentity = { ...identity, executablePath: `C:\\${SYNTHETIC_FIXTURE}.exe` };
    expect(() => renderReceipt(receiptFields({ electron: leakyIdentity }))).toThrow(
      "plaintext fixture",
    );
  });
  it("refuses wrong digests, missing identity and gate drift", () => {
    expect(() => renderReceipt(receiptFields({ ciphertextDigest: "nothex" }))).toThrow(
      "sha256 hex",
    );
    expect(() => renderReceipt(receiptFields({ electron: null }))).toThrow(
      "electron identity is required",
    );
    expect(() => renderReceipt(receiptFields({ checks: [...RESTART_CHECKS] }))).toThrow(
      "first lifetime checks",
    );
    expect(() => renderReceipt(receiptFields({ mode: "restart" }))).toThrow(
      "restart lifetime checks",
    );
    expect(() => renderReceipt(receiptFields({ checks: [...FIRST_CHECKS].reverse() }))).toThrow(
      "first lifetime checks",
    );
  });
});

it("refuses sparse or decorated check arrays as the original strict comparison did", () => {
  expect(() =>
    renderReceipt(receiptFields({ checks: Array<string>(FIRST_CHECKS.length) })),
  ).toThrow("first lifetime checks");
  const checks = Object.assign([...FIRST_CHECKS], { unexpected: true });
  expect(() => renderReceipt(receiptFields({ checks }))).toThrow("first lifetime checks");
});
