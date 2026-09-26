import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface ModelCredentialContext {
  id: string;
  presetId: string;
  baseUrl: string;
}

const keyFileError =
  "Model credential key is unavailable or unsafe. Restore the original protected key file.";
const credentialError = "Model credential could not be encrypted or authenticated.";
const maximumCredentialBytes = 4096;

/** Only ciphertext crosses the database boundary; AAD prevents moving keys between connections. */
export class ModelCredentialCipher {
  readonly #key: Buffer;

  private constructor(key: Uint8Array) {
    if (key.byteLength !== 32) throw new Error(keyFileError);
    this.#key = Buffer.from(key);
  }

  static fromKey(key: Uint8Array): ModelCredentialCipher {
    return new ModelCredentialCipher(key);
  }

  static async load(
    path: string,
    options: { allowCreate: boolean },
  ): Promise<ModelCredentialCipher> {
    try {
      let key: Buffer;
      try {
        key = await readKey(path);
      } catch (error) {
        if (!options.allowCreate || !hasCode(error, "ENOENT")) throw error;
        await initializeKey(path);
        key = await readKey(path);
      }
      return new ModelCredentialCipher(key);
    } catch {
      // Filesystem errors can contain sensitive deployment paths; expose one controlled message.
      throw new Error(keyFileError);
    }
  }

  encrypt(apiKey: string, context: ModelCredentialContext): string {
    try {
      const plaintext = Buffer.from(apiKey, "utf8");
      if (!apiKey.trim() || plaintext.byteLength > maximumCredentialBytes) throw new Error();
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.#key, nonce, { authTagLength: 16 });
      cipher.setAAD(associatedData(context));
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return [
        "v1",
        nonce.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        encrypted.toString("base64url"),
      ].join(".");
    } catch {
      throw new Error(credentialError);
    }
  }

  decrypt(value: string, context: ModelCredentialContext): string {
    try {
      if (value.length > 5600) throw new Error();
      const [version, encodedNonce, encodedTag, encodedCiphertext, extra] = value.split(".");
      if (version !== "v1" || extra !== undefined) throw new Error();
      const nonce = decodePart(encodedNonce);
      const tag = decodePart(encodedTag);
      const ciphertext = decodePart(encodedCiphertext);
      if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length > maximumCredentialBytes)
        throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce, { authTagLength: 16 });
      decipher.setAAD(associatedData(context));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const apiKey = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      if (!apiKey.trim()) throw new Error();
      return apiKey;
    } catch {
      throw new Error(credentialError);
    }
  }
}

function associatedData(context: ModelCredentialContext): Buffer {
  return Buffer.from(
    JSON.stringify({ id: context.id, presetId: context.presetId, baseUrl: context.baseUrl }),
  );
}

function decodePart(value: string | undefined): Buffer {
  if (value === undefined || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error();
  return decoded;
}

async function readKey(path: string): Promise<Buffer> {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error();
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.ino !== entry.ino ||
      metadata.dev !== entry.dev ||
      metadata.size !== 32 ||
      (metadata.mode & 0o777) !== 0o600 ||
      (process.getuid !== undefined && metadata.uid !== process.getuid())
    )
      throw new Error();
    const buffer = Buffer.alloc(33);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== 32) throw new Error();
    return buffer.subarray(0, 32);
  } finally {
    await handle.close();
  }
}

async function initializeKey(path: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error();
  const temporaryPath = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  const handle = await open(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.chmod(0o600);
    await handle.writeFile(randomBytes(32));
    await handle.sync();
    await handle.close();
    try {
      // A hard link publishes the fully written inode without ever replacing an existing key.
      // Concurrent initializers either publish once or read the winner's complete key.
      await link(temporaryPath, path);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      // Persist the directory entry before allowing credentials to be committed under this key.
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await handle.close();
    await unlink(temporaryPath);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
