/** Implements plugin store behavior for the Server. */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { hasIntegerTokens, parseJsonInput } from "./json-input.js";
import { readFileAt, removeFileAt, writeFileAt } from "./owner-files.js";
import {
  type PluginState,
  pluginBytes,
  pluginError,
  pluginParse,
  pluginStateSchema,
} from "./plugin-values.js";
import { exclusiveLock, openAt, openDirectory } from "./posix-files.js";
import { HttpFailure } from "./http-errors.js";

const limit = 3 * 1024 * 1024,
  aad = Buffer.from("openbot.plugins/v1");
function parse(bytes: Buffer) {
  return parseJsonInput(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as any;
}
function base64(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    return pluginError("unavailable");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) return pluginError("unavailable");
  return bytes;
}
export class PluginStore {
  #key?: Buffer;
  #identity?: string;
  readonly name: string;
  readonly directory: string;
  constructor(path: string) {
    if (!isAbsolute(path) || resolve(path) !== path) pluginError("unavailable");
    this.name = basename(path);
    this.directory = dirname(path);
  }
  #read(root: number, name: string, maximum: number) {
    try {
      return readFileAt(root, name, maximum, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async #lease<T>(
    operation: (root: number) => Promise<T>,
    signal?: AbortSignal,
    create = false,
  ): Promise<T> {
    let root: number | undefined, lock: number | undefined;
    try {
      root = openDirectory(this.directory, create);
      const info = fstatSync(root, { bigint: true }),
        identity = `${info.dev}:${info.ino}`;
      if (
        info.uid !== BigInt(process.geteuid!()) ||
        (info.mode & 0o077n) !== 0n ||
        (this.#identity && this.#identity !== identity)
      )
        pluginError("unavailable");
      this.#identity = identity;
      lock = openAt(
        root,
        `.${this.name}.lock`,
        constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK,
      );
      const li = fstatSync(lock, { bigint: true });
      if (
        !li.isFile() ||
        li.uid !== info.uid ||
        li.nlink !== 1n ||
        (li.mode & 0o077n) !== 0n ||
        li.size !== 0n
      )
        pluginError("unavailable");
      await exclusiveLock(lock, 3000, signal);
      const named = openAt(root, `.${this.name}.lock`, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const ni = fstatSync(named, { bigint: true });
        if (ni.dev !== li.dev || ni.ino !== li.ino) pluginError("unavailable");
      } finally {
        closeSync(named);
      }
      return await operation(root);
    } catch (error) {
      if (error instanceof HttpFailure) throw error;
      return pluginError("unavailable");
    } finally {
      if (lock !== undefined) closeSync(lock);
      if (root !== undefined) closeSync(root);
    }
  }
  #decrypt(encoded: Buffer): PluginState {
    const v = parse(encoded);
    if (
      !v ||
      Object.keys(v).sort().join() !== "ciphertext,nonce,tag,version" ||
      v.version !== 1 ||
      !hasIntegerTokens(v, ["version"])
    )
      pluginError("unavailable");
    const nonce = base64(v.nonce),
      tag = base64(v.tag),
      ciphertext = base64(v.ciphertext);
    if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length > 2 * 1024 * 1024)
      pluginError("unavailable");
    const decipher = createDecipheriv("aes-256-gcm", this.#key!, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return pluginParse(
      pluginStateSchema,
      parse(Buffer.concat([decipher.update(ciphertext), decipher.final()])),
      2 * 1024 * 1024,
    );
  }
  #encrypt(state: PluginState): Buffer {
    const plain = pluginBytes(
        pluginParse(pluginStateSchema, state, 2 * 1024 * 1024),
        2 * 1024 * 1024,
      ),
      nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key!, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return pluginBytes(
      {
        version: 1,
        nonce: nonce.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      },
      limit,
    );
  }
  #restore(root: number, previous?: Buffer) {
    if (previous) writeFileAt(root, this.name, previous);
    else removeFileAt(root, this.name);
    removeFileAt(root, `.${this.name}.pending`);
    fsyncSync(root);
  }
  #recover(root: number) {
    const raw = this.#read(root, `.${this.name}.pending`, 5 * 1024 * 1024);
    if (!raw) return;
    const journal = parse(raw);
    if (
      !journal ||
      Object.keys(journal).sort().join() !== "previous,version" ||
      journal.version !== 1
    )
      pluginError("unavailable");
    const previous = journal.previous === null ? undefined : base64(journal.previous);
    if (previous) {
      if (previous.length > limit) pluginError("unavailable");
      this.#decrypt(previous);
    }
    this.#read(root, this.name, limit);
    this.#restore(root, previous);
  }
  #load(root: number): PluginState {
    const key = this.#read(root, this.name + ".key", 32);
    if (!key || !this.#key || key.length !== 32 || !timingSafeEqual(key, this.#key))
      pluginError("unavailable");
    const raw = this.#read(root, this.name, limit);
    return raw ? this.#decrypt(raw) : { plugins: [], audit: [] };
  }
  async verify() {
    await this.#lease(
      async (root) => {
        let key = this.#read(root, this.name + ".key", 32);
        if (!key) {
          if (
            this.#read(root, this.name, limit) ||
            this.#read(root, `.${this.name}.pending`, 5 * 1024 * 1024)
          )
            pluginError("unavailable");
          key = randomBytes(32);
          writeFileAt(root, this.name + ".key", key);
        }
        if (key.length !== 32) pluginError("unavailable");
        this.#key = key;
        this.#recover(root);
        this.#load(root);
      },
      undefined,
      true,
    );
  }
  // Work holds this read lease before its Task transaction; never across network I/O.
  async withRead<T>(
    operation: (state: PluginState) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const outcome = await this.#lease(async (root) => {
      this.#recover(root);
      const state = this.#load(root);
      // Storage failures stay redacted by the lease. The trusted caller's control refusal
      // must survive outside it so corrections, stale fences and explicit denials keep meaning.
      try {
        return { ok: true as const, value: await operation(state) };
      } catch (error) {
        return { ok: false as const, error };
      }
    }, signal);
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
  async read(signal?: AbortSignal) {
    return this.#lease(async (root) => {
      this.#recover(root);
      return this.#load(root);
    }, signal);
  }
  // Lease precedes Owner SQL. Publish only while the same lease survives its final commit/expiry.
  async transaction<T>(
    authority: (publish: () => Promise<T>) => Promise<T>,
    change: (state: PluginState) => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.#lease(async (root) => {
      this.#recover(root);
      let written = false,
        previous: Buffer | undefined;
      try {
        const result = await authority(async () => {
          const state = this.#load(root),
            value = await change(state),
            encoded = this.#encrypt(state);
          signal?.throwIfAborted();
          previous = this.#read(root, this.name, limit);
          writeFileAt(
            root,
            `.${this.name}.pending`,
            pluginBytes(
              { version: 1, previous: previous?.toString("base64") ?? null },
              5 * 1024 * 1024,
            ),
          );
          written = true;
          writeFileAt(root, this.name, encoded);
          return structuredClone(value);
        });
        removeFileAt(root, `.${this.name}.pending`);
        written = false;
        return result;
      } catch (error) {
        if (written) this.#restore(root, previous);
        throw error;
      }
    }, signal);
  }
}
