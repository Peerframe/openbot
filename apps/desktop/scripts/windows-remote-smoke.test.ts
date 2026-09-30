import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFirstState, serializeState, SYNTHETIC_FIXTURE } from "./remote-smoke-state.ts";

// Exercise the actual entry's file/lifecycle ownership. Native DPAPI and held-process
// conformance remain separate Windows gates; this test never calls credential storage.
const native = vi.hoisted(() => ({
  app: {
    setPath: vi.fn(),
    whenReady: vi.fn<() => Promise<void>>(),
    quit: vi.fn(),
    exit: vi.fn(),
  },
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(),
    encryptStringAsync: vi.fn(),
    decryptStringAsync: vi.fn(),
  },
  observeProcessIdentity: vi.fn(),
  assertPreviousProcessEnded: vi.fn(),
}));
vi.mock("electron", () => ({ app: native.app, safeStorage: native.safeStorage }));
vi.mock("./smoke-process-identity.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./smoke-process-identity.ts")>()),
  observeProcessIdentity: native.observeProcessIdentity,
  assertPreviousProcessEnded: native.assertPreviousProcessEnded,
}));
const identity = {
  pid: 4242,
  startTimeUtc: "synthetic-start",
  executablePath: "C:\\fixture\\electron.exe",
};
const ciphertextBytes = Buffer.from("synthetic-ciphertext");
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalArch = Object.getOwnPropertyDescriptor(process, "arch");
const originalArgv = process.argv;
let parent: string;
let root: string;
let receipt: string;
let ready: () => void;
let finished: Promise<number>;

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  parent = await mkdtemp(join(tmpdir(), "openbot-remote-entry-"));
  root = join(parent, "fixture");
  receipt = join(parent, "receipt.json");
  Object.defineProperty(process, "platform", { value: "win32" });
  Object.defineProperty(process, "arch", { value: "x64" });
  const readyPromise = new Promise<void>((resolve) => {
    ready = resolve;
  });
  native.app.whenReady.mockReturnValue(readyPromise);
  finished = new Promise<number>((resolve) => {
    native.app.quit.mockImplementation(() => resolve(0));
    native.app.exit.mockImplementation((code: number) => resolve(code));
  });
  native.safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(true);
  native.safeStorage.encryptStringAsync.mockResolvedValue(ciphertextBytes);
  native.safeStorage.decryptStringAsync.mockResolvedValue({ result: SYNTHETIC_FIXTURE });
  native.observeProcessIdentity.mockReturnValue(identity);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
  if (originalArch) Object.defineProperty(process, "arch", originalArch);
  process.argv = originalArgv;
  vi.restoreAllMocks();
  await rm(parent, { recursive: true, force: true });
});
async function load(mode = "first") {
  process.argv = [process.execPath, "windows-remote-smoke.ts", root, receipt, mode];
  await import("./windows-remote-smoke.ts");
}
async function complete() {
  ready();
  return finished;
}
async function persistFirstState() {
  await mkdir(root);
  const text = serializeState(createFirstState(ciphertextBytes.toString("base64"), identity));
  await writeFile(join(root, "remote-desktop-state.json"), text);
  return text;
}

it("isolates both profile paths and records identity before ready, then writes the first receipt", async () => {
  await load();
  expect(native.app.setPath.mock.calls).toEqual([
    ["userData", join(root, "electron-user-data")],
    ["sessionData", join(root, "electron-session-data")],
  ]);
  expect(JSON.parse(await readFile(join(root, "harness-live-processes.json"), "utf8"))).toEqual({
    electron: identity,
  });
  expect(native.app.setPath.mock.invocationCallOrder.at(-1)).toBeLessThan(
    native.app.whenReady.mock.invocationCallOrder[0] ?? 0,
  );
  expect(native.safeStorage.encryptStringAsync).not.toHaveBeenCalled();
  expect(await complete()).toBe(0);
  expect(native.safeStorage.encryptStringAsync).toHaveBeenCalledWith(SYNTHETIC_FIXTURE);
  const stateText = await readFile(join(root, "remote-desktop-state.json"), "utf8");
  expect(stateText).not.toContain(SYNTHETIC_FIXTURE);
  expect(JSON.parse(stateText).ciphertext).toBe(ciphertextBytes.toString("base64"));
  const result = await readFile(receipt, "utf8");
  expect(JSON.parse(result).checks).toEqual([
    "safe-storage-available",
    "encrypt",
    "decrypt",
    "state-persisted",
    "no-plaintext-secret",
  ]);
  expect(result).not.toContain(ciphertextBytes.toString("base64"));
});

it("decrypts the prior lifetime without encrypting or modifying any persisted state byte", async () => {
  const before = await persistFirstState();
  await load("restart");
  expect(await complete()).toBe(0);
  expect(native.assertPreviousProcessEnded).toHaveBeenCalledWith(identity);
  expect(native.safeStorage.encryptStringAsync).not.toHaveBeenCalled();
  expect(native.safeStorage.decryptStringAsync).toHaveBeenCalledWith(ciphertextBytes);
  expect(await readFile(join(root, "remote-desktop-state.json"), "utf8")).toBe(before);
  expect(JSON.parse(await readFile(receipt, "utf8")).checks).toEqual([
    "safe-storage-available",
    "decrypt-after-restart",
    "ciphertext-stable",
    "no-plaintext-secret",
  ]);
});

it("refuses a foreign platform before creating the fixture or touching profile paths", async () => {
  Object.defineProperty(process, "platform", { value: "linux" });
  await expect(load()).rejects.toThrow("requires native Windows x64");
  expect(existsSync(root)).toBe(false);
  expect(native.app.setPath).not.toHaveBeenCalled();
});

it.each(["invalid", "missing-root", "missing-state", "existing-first"])(
  "refuses invalid lifecycle setup: %s",
  async (kind) => {
    if (kind === "existing-first" || kind === "missing-state") await mkdir(root);
    const mode = kind === "invalid" ? "unknown" : kind === "existing-first" ? "first" : "restart";
    await expect(load(mode)).rejects.toThrow();
    expect(native.app.setPath).not.toHaveBeenCalled();
    expect(native.safeStorage.isAsyncEncryptionAvailable).not.toHaveBeenCalled();
    expect(existsSync(receipt)).toBe(false);
  },
);

it.each([
  "ciphertext-string",
  "empty-ciphertext",
  "unavailable",
  "wrong-decryption",
  "existing-receipt",
])("refuses failed first-lifetime evidence: %s", async (kind) => {
  if (kind === "ciphertext-string")
    native.safeStorage.encryptStringAsync.mockResolvedValue("not bytes");
  if (kind === "empty-ciphertext")
    native.safeStorage.encryptStringAsync.mockResolvedValue(Buffer.alloc(0));
  if (kind === "unavailable")
    native.safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(false);
  if (kind === "wrong-decryption")
    native.safeStorage.decryptStringAsync.mockResolvedValue({ result: "wrong" });
  if (kind === "existing-receipt") await writeFile(receipt, "existing evidence");
  await load();
  expect(await complete()).toBe(1);
  if (kind === "existing-receipt")
    expect(await readFile(receipt, "utf8")).toBe("existing evidence");
  else expect(existsSync(receipt)).toBe(false);
});

it.each(["digest", "state-mutation", "previous-alive", "incomplete-first"])(
  "refuses failed restart evidence: %s",
  async (kind) => {
    await persistFirstState();
    const statePath = join(root, "remote-desktop-state.json");
    if (kind === "digest" || kind === "incomplete-first") {
      const value = JSON.parse(await readFile(statePath, "utf8"));
      if (kind === "digest") value.ciphertextDigest = "0".repeat(64);
      else value.firstLifetimeComplete = false;
      await writeFile(statePath, JSON.stringify(value));
    }
    if (kind === "previous-alive")
      native.assertPreviousProcessEnded.mockImplementation(() => {
        throw new Error("still alive");
      });
    if (kind === "state-mutation")
      native.safeStorage.decryptStringAsync.mockImplementation(async () => {
        await writeFile(statePath, `${await readFile(statePath, "utf8")} `);
        return { result: SYNTHETIC_FIXTURE };
      });
    await load("restart");
    expect(await complete()).toBe(1);
    expect(existsSync(receipt)).toBe(false);
    expect(native.safeStorage.encryptStringAsync).not.toHaveBeenCalled();
  },
);
