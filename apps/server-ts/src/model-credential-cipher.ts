import {
  createCipheriv,
  createDecipheriv,
  createSecretKey,
  type KeyObject,
  randomBytes,
} from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  readSync,
  writeSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { scalarText } from "./owner-auth-crypto.js";
import { exclusiveLock, linkAt, openAt, openDirectory, unlinkAt } from "./posix-files.js";
import { WriteFailure } from "./primary-bot-write.js";

type Context = { id: string; presetId: string; baseUrl: string };
const unavailable = () => new WriteFailure(503, { error: "model_credential_unavailable" });
const aad = ({ id, presetId, baseUrl }: Context) => {
  if (![id, presetId, baseUrl].every((value) => typeof value === "string" && scalarText(value)))
    throw unavailable();
  return Buffer.from(JSON.stringify({ id, presetId, baseUrl }), "utf8");
};
const pythonWhitespace = new Set([
  ...Array.from({ length: 5 }, (_, i) => i + 9),
  ...Array.from({ length: 5 }, (_, i) => i + 28),
  0x85,
  0xa0,
  0x1680,
  ...Array.from({ length: 11 }, (_, i) => i + 0x2000),
  0x2028,
  0x2029,
  0x202f,
  0x205f,
  0x3000,
]);
const blank = (value: string) =>
  [...value].every((character) => pythonWhitespace.has(character.codePointAt(0)!));
function decode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw unavailable();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw unavailable();
  return bytes;
}
function readKey(directory: number, name: string): Buffer | undefined {
  let fd: number;
  try {
    fd = openAt(directory, name, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.size !== 32n ||
      (before.mode & 0o7777n) !== 0o600n ||
      before.uid !== BigInt(process.getuid!())
    )
      throw unavailable();
    const bytes = Buffer.alloc(33);
    if (readSync(fd, bytes, 0, 33, null) !== 32) throw unavailable();
    const after = fstatSync(fd, { bigint: true });
    const namedFd = openAt(directory, name, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const named = fstatSync(namedFd, { bigint: true });
      if (
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs ||
        named.dev !== before.dev ||
        named.ino !== before.ino
      )
        throw unavailable();
    } finally {
      closeSync(namedFd);
    }
    return bytes.subarray(0, 32);
  } finally {
    closeSync(fd);
  }
}
export class ModelCredentialCipher {
  readonly #key: KeyObject;
  constructor(key: Buffer) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw unavailable();
    this.#key = createSecretKey(key);
  }
  static async load(
    path: string,
    allowCreate: boolean,
    signal?: AbortSignal,
  ): Promise<ModelCredentialCipher> {
    let directory: number | undefined;
    try {
      if (typeof allowCreate !== "boolean" || typeof path !== "string" || path.includes("\0"))
        throw unavailable();
      path = resolve(path);
      directory = openDirectory(dirname(path), allowCreate);
      await exclusiveLock(directory, 3000, signal);
      let key = readKey(directory, basename(path));
      if (!key) {
        if (!allowCreate) throw unavailable();
        const name = ".model-key-" + randomBytes(12).toString("hex") + ".tmp";
        const file = openAt(
          directory,
          name,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        );
        try {
          fchmodSync(file, 0o600);
          if (writeSync(file, randomBytes(32)) !== 32) throw unavailable();
          fsyncSync(file);
          try {
            linkAt(directory, name, basename(path));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
          fsyncSync(directory);
        } finally {
          closeSync(file);
          unlinkAt(directory, name);
        }
        key = readKey(directory, basename(path));
      }
      if (!key) throw unavailable();
      return new ModelCredentialCipher(key);
    } catch {
      throw unavailable();
    } finally {
      if (directory !== undefined) closeSync(directory);
    }
  }
  encrypt(value: string, context: Context): string {
    try {
      if (typeof value !== "string" || !scalarText(value) || blank(value)) throw unavailable();
      const bytes = Buffer.from(value, "utf8");
      if (bytes.length > 4096) throw unavailable();
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
      cipher.setAAD(aad(context));
      const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return [
        "v1",
        nonce.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        encrypted.toString("base64url"),
      ].join(".");
    } catch {
      throw unavailable();
    }
  }
  decrypt(value: string, context: Context): string {
    try {
      if (typeof value !== "string" || value.length > 5600) throw unavailable();
      const parts = value.split(".");
      if (parts.length !== 4 || parts[0] !== "v1") throw unavailable();
      const [nonce, tag, encrypted] = parts.slice(1).map(decode) as [Buffer, Buffer, Buffer];
      if (nonce.length !== 12 || tag.length !== 16 || encrypted.length > 4096) throw unavailable();
      const cipher = createDecipheriv("aes-256-gcm", this.#key, nonce);
      cipher.setAAD(aad(context));
      cipher.setAuthTag(tag);
      const clear = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        Buffer.concat([cipher.update(encrypted), cipher.final()]),
      );
      if (blank(clear)) throw unavailable();
      return clear;
    } catch {
      throw unavailable();
    }
  }
}
