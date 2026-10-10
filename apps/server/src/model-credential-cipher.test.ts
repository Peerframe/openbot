/** Verifies private model-key lifecycle and frozen legacy ciphertext compatibility. */
import { legacy } from "../tests/legacy-fixtures.js";
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelCredentialCipher } from "./model-credential-cipher.js";
import { exclusiveLock, openAt, openDirectory } from "./posix-files.js";

const directories: string[] = [];
const temporary = () => {
  const path = mkdtempSync(join(realpathSync(tmpdir()), "openbot-key-"));
  directories.push(path);
  return path;
};
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const context = {
  id: "synthetic-connection",
  presetId: "custom",
  baseUrl: "https://model.example.test/v1",
};
function child(command: string, args: string[], input = "") {
  return new Promise<string>((resolve, reject) => {
    const process = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "",
      error = "";
    process.stdout.on("data", (chunk) => {
      out += chunk;
    });
    process.stderr.on("data", (chunk) => {
      error += chunk;
    });
    const timer = setTimeout(() => {
      process.kill("SIGKILL");
      reject(new Error("Child deadline."));
    }, 10000);
    process.on("error", reject);
    process.on("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(error));
    });
    process.stdin.end(input);
  });
}
describe.skipIf(!["darwin", "linux"].includes(process.platform))("protected model key", () => {
  it("creates one private key and reads the same ciphertext after reopening", async () => {
    const path = join(temporary(), "nested", "key");
    const first = await ModelCredentialCipher.load(path, true);
    const bytes = readFileSync(path);
    const second = await ModelCredentialCipher.load(path, false);
    expect(second.decrypt(first.encrypt("synthetic secret", context), context)).toBe(
      "synthetic secret",
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path)).toEqual(bytes);
    expect(readdirSync(join(path, "..")).filter((x) => x.endsWith(".tmp"))).toEqual([]);
  });
  it("refuses missing keys, insecure permissions, non-regular files and symlinks at every depth", async () => {
    const directory = temporary(),
      path = join(directory, "key");
    await expect(ModelCredentialCipher.load(path, false)).rejects.toMatchObject({ status: 503 });
    mkdirSync(path);
    await expect(ModelCredentialCipher.load(path, true)).rejects.toMatchObject({ status: 503 });
    rmSync(path, { recursive: true });
    writeFileSync(path, Buffer.alloc(32), { mode: 0o644 });
    await expect(ModelCredentialCipher.load(path, true)).rejects.toMatchObject({ status: 503 });
    chmodSync(path, 0o600);
    for (const size of [0, 31, 33]) {
      writeFileSync(path, Buffer.alloc(size));
      await expect(ModelCredentialCipher.load(path, true)).rejects.toMatchObject({ status: 503 });
    }
    writeFileSync(path, Buffer.alloc(32));
    const linked = join(directory, "link");
    symlinkSync(path, linked);
    await expect(ModelCredentialCipher.load(linked, false)).rejects.toMatchObject({ status: 503 });
    const parentLink = join(directory, "parent");
    symlinkSync(directory, parentLink);
    await expect(ModelCredentialCipher.load(join(parentLink, "key"), false)).rejects.toMatchObject({
      status: 503,
    });
  });
  it("pins the directory descriptor across a path replacement while waiting on its lock", async () => {
    const base = temporary(),
      directory = join(base, "original");
    mkdirSync(directory);
    const old = await ModelCredentialCipher.load(join(directory, "key"), true);
    const fd = openDirectory(directory, false);
    await exclusiveLock(fd, 100);
    const waiting = ModelCredentialCipher.load(join(directory, "key"), false);
    renameSync(directory, join(base, "moved"));
    mkdirSync(directory);
    const replacement = await ModelCredentialCipher.load(join(directory, "key"), true);
    closeSync(fd);
    const actual = await waiting;
    const encrypted = old.encrypt("original", context);
    expect(actual.decrypt(encrypted, context)).toBe("original");
    expect(() => replacement.decrypt(encrypted, context)).toThrow();
  });
  it("bounds contention and cancellation without changing an existing inode", async () => {
    const directory = temporary();
    const fd = openDirectory(directory, false);
    await exclusiveLock(fd, 100);
    const other = openDirectory(directory, false);
    try {
      const started = performance.now();
      await expect(exclusiveLock(other, 35)).rejects.toThrow();
      expect(performance.now() - started).toBeLessThan(500);
      await expect(exclusiveLock(other, 100, AbortSignal.abort())).rejects.toThrow();
    } finally {
      closeSync(other);
      closeSync(fd);
    }
    const parent = openDirectory(directory, false);
    try {
      const opened = openAt(
        parent,
        "leaf",
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      );
      closeSync(opened);
    } finally {
      closeSync(parent);
    }
  });
  it("decrypts authenticated legacy ciphertext and rejects a changed identity", () => {
    const { key, context: identity, clear, encrypted } = legacy.cipher;
    const cipher = new ModelCredentialCipher(Buffer.from(key, "base64"));
    expect(cipher.decrypt(encrypted, identity)).toBe(clear);
    expect(() => cipher.decrypt(encrypted, { ...identity, id: "other" })).toThrow();
  });
  it("publishes one key across twelve independent Server process initializers", async () => {
    const path = join(temporary(), "key");
    const module = new URL("../dist/model-credential-cipher.js", import.meta.url).href;
    const input = JSON.stringify({ path, context });
    const results = await Promise.all(Array.from({ length: 12 }, () => child(process.execPath, [
      "--input-type=module", "-e",
      `import {ModelCredentialCipher} from ${JSON.stringify(module)}; let raw='';for await(const b of process.stdin)raw+=b;const v=JSON.parse(raw);const c=await ModelCredentialCipher.load(v.path,true);console.log(c.encrypt('same key',v.context));`,
    ], input)));
    const cipher = await ModelCredentialCipher.load(path, false);
    for (const value of results) expect(cipher.decrypt(value.trim(), context)).toBe("same key");
  }, 15000);
});
it("refuses tampered context, noncanonical envelopes and malformed plaintext", () => {
  const cipher = new ModelCredentialCipher(Buffer.alloc(32, 7));
  const encrypted = cipher.encrypt("interop", context);
  for (const value of [
    encrypted + "=",
    encrypted + ".extra",
    encrypted.replace("v1", "v2"),
    "A".repeat(5601),
  ])
    expect(() => cipher.decrypt(value, context)).toThrow();
  for (const key of Object.keys(context))
    expect(() => cipher.decrypt(encrypted, { ...context, [key]: "changed" })).toThrow();
  for (const value of [" ", "x".repeat(4097), "\ud800"])
    expect(() => cipher.encrypt(value, context)).toThrow();
});
