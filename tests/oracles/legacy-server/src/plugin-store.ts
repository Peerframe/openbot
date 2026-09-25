import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { lstat, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createWindowsSecretAcl,
  ensureProtectedSecretDirectory,
  protectSecretFile,
  verifySecretFileAccess,
  type WindowsSecretAcl,
} from "@openbot/windows-secret-acl";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import {
  boundedJson,
  type InstalledPlugin,
  PluginError,
  pluginPromptSchema,
  pluginResourceSchema,
  pluginToolGrantSchema,
  pluginToolSchema,
} from "./plugin-types.js";

export interface PluginRecord extends InstalledPlugin {
  token?: string | undefined;
}
export interface PluginAudit {
  at: string;
  phase: string;
  pluginId: string;
  botId?: string | undefined;
  runId?: string | undefined;
  callId?: string | undefined;
  toolName?: string | undefined;
}
export interface PluginState {
  plugins: PluginRecord[];
  audit: PluginAudit[];
}
const stateSchema = z
  .object({
    plugins: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            name: z.string().max(80),
            endpoint: z.string().max(2048),
            digest: z.string().regex(/^[a-f0-9]{64}$/u),
            revision: z.string().uuid(),
            enabled: z.boolean(),
            createdAt: z.string(),
            token: z.string().max(2048).optional(),
            tools: z.array(pluginToolSchema).max(32),
            resources: z.array(pluginResourceSchema).max(32).optional(),
            prompts: z.array(pluginPromptSchema).max(32).optional(),
            grants: z
              .array(
                z
                  .object({
                    botId: z.string().max(128),
                    tools: z.array(pluginToolGrantSchema).max(32),
                    resources: z.array(z.string().max(2048)).max(32).optional(),
                    prompts: z.array(z.string().max(64)).max(32).optional(),
                  })
                  .strict(),
              )
              .max(128),
          })
          .strict(),
      )
      .max(16),
    audit: z
      .array(
        z
          .object({
            at: z.string(),
            phase: z.string().max(64),
            pluginId: z.string(),
            botId: z.string().optional(),
            runId: z.string().optional(),
            callId: z.string().optional(),
            toolName: z.string().optional(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

/** One Server owns this file. The queue covers compare-and-write and call dispatch admission. */
export class FilePluginStore {
  #tail: Promise<unknown> = Promise.resolve();
  #key: Buffer | undefined;
  readonly #platform: NodeJS.Platform;
  /** Long-lived helper so Owner SID can be reused; ACL results are still re-verified each load/save. */
  readonly #windowsAcl: WindowsSecretAcl;
  readonly #windowsTrustRoot: string | undefined;
  constructor(
    readonly path: string,
    options: {
      platform?: NodeJS.Platform;
      windowsAcl?: WindowsSecretAcl;
      windowsTrustRoot?: string;
    } = {},
  ) {
    this.#platform = options.platform ?? process.platform;
    this.#windowsAcl = options.windowsAcl ?? createWindowsSecretAcl();
    this.#windowsTrustRoot = options.windowsTrustRoot;
  }

  async read(): Promise<PluginState> {
    return this.serial(async () => structuredClone(await this.#load()));
  }
  async transaction<T>(change: (state: PluginState) => T | Promise<T>): Promise<T> {
    return this.serial(async () => {
      const state = await this.#load();
      const result = await change(state);
      const checked = stateSchema.parse(state);
      const key = await this.#encryptionKey();
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from("openbot.plugins/v1"));
      const ciphertext = Buffer.concat([
        cipher.update(boundedJson(checked, 2 * 1024 * 1024)),
        cipher.final(),
      ]);
      await ensureProtectedSecretDirectory(dirname(this.path), {
        platform: this.#platform,
        acl: this.#windowsAcl,
        ...(this.#windowsTrustRoot === undefined ? {} : { trustRoot: this.#windowsTrustRoot }),
      });
      await writeFileAtomic(
        this.path,
        JSON.stringify({
          version: 1,
          nonce: nonce.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
          ciphertext: ciphertext.toString("base64"),
        }),
        { mode: 0o600 },
      );
      await protectSecretFile(this.path, {
        platform: this.#platform,
        acl: this.#windowsAcl,
      });
      return result;
    });
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(operation, operation);
    this.#tail = next.catch(() => {});
    return next;
  }
  async #encryptionKey(): Promise<Buffer> {
    if (this.#key) return this.#key;
    const keyPath = `${this.path}.key`;
    await ensureProtectedSecretDirectory(dirname(this.path), {
      platform: this.#platform,
      acl: this.#windowsAcl,
      ...(this.#windowsTrustRoot === undefined ? {} : { trustRoot: this.#windowsTrustRoot }),
    });
    try {
      await this.#assertSafeSecretFile(keyPath);
      await verifySecretFileAccess(keyPath, {
        platform: this.#platform,
        acl: this.#windowsAcl,
        ...(this.#windowsTrustRoot === undefined ? {} : { trustRoot: this.#windowsTrustRoot }),
      });
      const value = await readFile(keyPath);
      if (value.byteLength !== 32) throw new Error("Invalid plugin encryption key.");
      this.#key = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await stat(this.path);
        throw new Error("Plugin encryption key is missing.");
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing;
      }
      const value = randomBytes(32);
      await writeFile(keyPath, value, { flag: "wx", mode: 0o600 });
      await protectSecretFile(keyPath, {
        platform: this.#platform,
        acl: this.#windowsAcl,
      });
      this.#key = value;
    }
    return this.#key;
  }

  async #assertSafeSecretFile(path: string): Promise<void> {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("Plugin secret path must be a regular file.");
    }
    if (this.#platform !== "win32" && (entry.mode & 0o077) !== 0) {
      throw new Error("Plugin secret file must not be accessible by group or other users.");
    }
  }
  async #load(): Promise<PluginState> {
    try {
      await this.#assertSafeSecretFile(this.path);
      if ((await stat(this.path)).size > 3 * 1024 * 1024)
        throw new Error("Plugin store too large.");
      await verifySecretFileAccess(this.path, {
        platform: this.#platform,
        acl: this.#windowsAcl,
        ...(this.#windowsTrustRoot === undefined ? {} : { trustRoot: this.#windowsTrustRoot }),
      });
      const envelope = z
        .object({
          version: z.literal(1),
          nonce: z.string(),
          tag: z.string(),
          ciphertext: z.string(),
        })
        .strict()
        .parse(JSON.parse(await readFile(this.path, "utf8")));
      const decipher = createDecipheriv(
        "aes-256-gcm",
        await this.#encryptionKey(),
        Buffer.from(envelope.nonce, "base64"),
      );
      decipher.setAAD(Buffer.from("openbot.plugins/v1"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const text = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]);
      return stateSchema.parse(JSON.parse(text.toString("utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { plugins: [], audit: [] };
      throw new PluginError("unavailable", "插件存储无法读取，请检查数据文件与对应密钥。");
    }
  }
}

export function recordPluginAudit(state: PluginState, event: Omit<PluginAudit, "at">): void {
  state.audit.push({ ...event, at: new Date().toISOString() });
  state.audit = state.audit.slice(-500);
}
export function publicPlugin(record: PluginRecord): InstalledPlugin {
  const { token: _token, ...plugin } = record;
  return structuredClone(plugin);
}
