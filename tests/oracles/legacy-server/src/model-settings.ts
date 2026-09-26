import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";
import { modelProviderBaseUrl, modelProviderIds, modelProviderPreset } from "@openbot/domain";
import {
  createWindowsSecretAcl,
  ensureProtectedSecretDirectory,
  protectSecretFile,
  verifySecretFileAccess,
  type WindowsSecretAcl,
} from "@openbot/windows-secret-acl";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";

export const modelSettingsInputSchema = z
  .object({
    provider: z.enum(modelProviderIds),
    baseUrl: z.string().max(512).optional(),
    model: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:@+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:@+-]*)?$/u),
    apiKey: z
      .string()
      .min(16)
      .max(512)
      .regex(/^[\x21-\x7e]+$/u),
    revision: z.string().uuid().nullable(),
    agentEnabled: z.boolean().default(false),
  })
  .strict()
  .refine(
    (value) =>
      value.provider === "openrouter"
        ? value.model.includes("/")
        : ["openai", "anthropic", "moonshot", "deepseek"].includes(value.provider)
          ? !value.model.includes("/")
          : true,
    {
      message: "OpenRouter requires an author/model slug; direct providers use a model ID.",
      path: ["model"],
    },
  )
  .refine(
    (value) => {
      try {
        modelProviderBaseUrl(value.provider, value.baseUrl);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Endpoint must belong to the selected provider.", path: ["baseUrl"] },
  );
export const modelDiscoveryInputSchema = z
  .object({
    provider: z.enum(modelProviderIds),
    baseUrl: z.string().max(512).optional(),
    apiKey: z
      .string()
      .min(16)
      .max(512)
      .regex(/^[\x21-\x7e]+$/u),
  })
  .strict()
  .refine(
    (value) => {
      try {
        modelProviderBaseUrl(value.provider, value.baseUrl);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Unapproved endpoint.", path: ["baseUrl"] },
  );
type ModelInput = z.infer<typeof modelSettingsInputSchema>;
const retainedSchema = modelSettingsInputSchema.safeExtend({
  revision: z.string().uuid(),
  agentEnabledAt: z.string().datetime().nullable().default(null),
});
export type AgentModelSettings = z.infer<typeof retainedSchema>;
export type ModelSettingsSummary =
  | { status: "unconfigured"; revision: null }
  | {
      status: "configured";
      provider: ModelInput["provider"];
      model: string;
      baseUrl: string;
      verification: "metadata" | "not_checked";
      revision: string;
      agentEnabled: boolean;
    };
export class ModelSettingsError extends Error {
  constructor(
    readonly code:
      | "busy"
      | "conflict"
      | "invalid_credentials"
      | "model_unavailable"
      | "provider_unavailable"
      | "storage_unavailable",
  ) {
    super(code);
  }
}

/** Owner-only Server storage. Neither keys nor provider response bodies leave this boundary. */
export class ModelSettingsService {
  #busy = false;
  readonly #listeners = new Set<() => void>();
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  /** Internal inference boundary; never serialize this credential-bearing value to clients. */
  async agentSettings(): Promise<AgentModelSettings | undefined> {
    const current = await this.#read();
    return current?.agentEnabled && current.agentEnabledAt ? current : undefined;
  }
  readonly #key: Buffer;
  readonly #platform: NodeJS.Platform;
  /** Long-lived helper so Owner SID can be reused; ACL results are still re-verified each load/save. */
  readonly #windowsAcl: WindowsSecretAcl;
  readonly #windowsTrustRoot: string | undefined;
  constructor(
    readonly path: string,
    key: string,
    readonly fetcher: typeof fetch = fetch,
    options: {
      platform?: NodeJS.Platform;
      windowsAcl?: WindowsSecretAcl;
      windowsTrustRoot?: string;
    } = {},
  ) {
    if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error("Model encryption key must be 32 bytes.");
    this.#key = Buffer.from(key, "hex");
    this.#platform = options.platform ?? process.platform;
    this.#windowsAcl = options.windowsAcl ?? createWindowsSecretAcl();
    this.#windowsTrustRoot = options.windowsTrustRoot;
  }
  async summary(): Promise<ModelSettingsSummary> {
    const current = await this.#read();
    return current
      ? {
          status: "configured",
          provider: current.provider,
          model: current.model,
          baseUrl: modelProviderBaseUrl(current.provider, current.baseUrl),
          verification: modelProviderPreset(current.provider).discovery
            ? "metadata"
            : "not_checked",
          revision: current.revision,
          agentEnabled: current.agentEnabled,
        }
      : { status: "unconfigured", revision: null };
  }
  async save(value: z.input<typeof modelSettingsInputSchema>): Promise<ModelSettingsSummary> {
    const input = modelSettingsInputSchema.parse(value);
    if (this.#busy) throw new ModelSettingsError("busy");
    this.#busy = true;
    try {
      const current = await this.#read();
      if ((current?.revision ?? null) !== input.revision) throw new ModelSettingsError("conflict");
      await this.#verify(input);
      const stored = {
        ...input,
        revision: randomUUID(),
        agentEnabledAt: input.agentEnabled
          ? ((current?.agentEnabled ? current.agentEnabledAt : null) ?? new Date().toISOString())
          : null,
      };
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
      cipher.setAAD(Buffer.from("openbot.model-settings/v1"));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(stored)), cipher.final()]);
      const envelope = JSON.stringify({
        version: 1,
        nonce: nonce.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      });
      try {
        await ensureProtectedSecretDirectory(dirname(this.path), {
          platform: this.#platform,
          acl: this.#windowsAcl,
          ...(this.#windowsTrustRoot === undefined ? {} : { trustRoot: this.#windowsTrustRoot }),
        });
        await writeFileAtomic(this.path, envelope, { mode: 0o600 });
        await protectSecretFile(this.path, {
          platform: this.#platform,
          acl: this.#windowsAcl,
        });
        for (const listener of this.#listeners) listener();
        return await this.summary();
      } catch (error) {
        if (error instanceof ModelSettingsError) throw error;
        throw new ModelSettingsError("storage_unavailable");
      }
    } finally {
      this.#busy = false;
    }
  }
  async #read(): Promise<z.infer<typeof retainedSchema> | undefined> {
    try {
      const stat = await lstat(this.path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 8192 ||
        (this.#platform !== "win32" && (stat.mode & 0o077) !== 0)
      )
        throw new Error("Unsafe model file.");
      await verifySecretFileAccess(this.path, {
        platform: this.#platform,
        acl: this.#windowsAcl,
        ...(this.#windowsTrustRoot === undefined ? {} : { trustRoot: this.#windowsTrustRoot }),
      });
      const handle = await open(
        this.path,
        constants.O_RDONLY | (this.#platform === "win32" ? 0 : constants.O_NOFOLLOW),
      );
      let text: string;
      try {
        const opened = await handle.stat();
        if (
          opened.ino !== stat.ino ||
          opened.dev !== stat.dev ||
          opened.size > 8192 ||
          (this.#platform !== "win32" && (opened.mode & 0o077) !== 0)
        )
          throw new Error("Model file changed.");
        const buffer = Buffer.alloc(8193);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 8192) throw new Error("Model file grew.");
        text = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
      const envelope = z
        .object({
          version: z.literal(1),
          nonce: z.string().max(24),
          tag: z.string().max(24),
          ciphertext: z.string().max(4096),
        })
        .strict()
        .parse(JSON.parse(text));
      const nonce = Buffer.from(envelope.nonce, "base64"),
        tag = Buffer.from(envelope.tag, "base64");
      if (nonce.length !== 12 || tag.length !== 16) throw new Error("Invalid cipher parameters.");
      const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce);
      decipher.setAAD(Buffer.from("openbot.model-settings/v1"));
      decipher.setAuthTag(tag);
      return retainedSchema.parse(
        JSON.parse(
          Buffer.concat([
            decipher.update(Buffer.from(envelope.ciphertext, "base64")),
            decipher.final(),
          ]).toString("utf8"),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new ModelSettingsError("storage_unavailable");
    }
  }
  async #verifyRouter(input: ModelInput): Promise<void> {
    const headers = { Accept: "application/json", Authorization: `Bearer ${input.apiKey}` };
    const key = z
      .object({
        data: z.object({
          is_management_key: z.literal(false),
          is_provisioning_key: z.literal(false).optional(),
        }),
      })
      .safeParse(
        await requestModelMetadata(
          this.fetcher,
          "https://openrouter.ai/api/v1/key",
          headers,
          32 * 1024,
        ),
      );
    if (!key.success) throw new ModelSettingsError("invalid_credentials");
    const path = input.model.split("/").map(encodeURIComponent).join("/");
    const metadata = z
      .object({
        data: z.object({
          id: z.string(),
          endpoints: z
            .array(z.object({ supported_parameters: z.array(z.string()).optional() }))
            .max(1000),
        }),
      })
      .safeParse(
        await requestModelMetadata(
          this.fetcher,
          `https://openrouter.ai/api/v1/models/${path}/endpoints`,
          headers,
          256 * 1024,
        ),
      );
    if (
      !metadata.success ||
      metadata.data.data.id !== input.model ||
      !metadata.data.data.endpoints.length ||
      (input.agentEnabled &&
        !metadata.data.data.endpoints.some((endpoint) =>
          endpoint.supported_parameters?.includes("tools"),
        ))
    )
      throw new ModelSettingsError("model_unavailable");
  }
  async #verify(input: ModelInput): Promise<void> {
    if (input.provider === "openrouter") return this.#verifyRouter(input);
    const preset = modelProviderPreset(input.provider);
    if (!preset.discovery) return;
    if (input.provider !== "openai" && input.provider !== "anthropic") {
      const models = await this.discover({
        provider: input.provider,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
      });
      if (!models.includes(input.model)) throw new ModelSettingsError("model_unavailable");
      return;
    }
    const baseUrl = modelProviderBaseUrl(input.provider, input.baseUrl);
    const headers = modelHeaders(input.provider, input.apiKey);
    const body = await requestModelMetadata(
      this.fetcher,
      `${baseUrl}${input.provider === "anthropic" ? "/v1" : ""}/models/${encodeURIComponent(input.model)}`,
      headers,
      32 * 1024,
    );
    if (!body || typeof body !== "object" || !("id" in body) || body.id !== input.model)
      throw new ModelSettingsError("model_unavailable");
  }

  async discover(value: z.input<typeof modelDiscoveryInputSchema>): Promise<string[]> {
    const input = modelDiscoveryInputSchema.parse(value);
    const preset = modelProviderPreset(input.provider);
    if (!preset.discovery) throw new ModelSettingsError("model_unavailable");
    const baseUrl = modelProviderBaseUrl(input.provider, input.baseUrl);
    const query =
      input.provider === "openrouter"
        ? "?output_modalities=text"
        : input.provider === "siliconflow"
          ? "?type=text&sub_type=chat"
          : "";
    const body = await requestModelMetadata(
      this.fetcher,
      `${baseUrl}${input.provider === "anthropic" ? "/v1" : ""}/models${query}`,
      modelHeaders(input.provider, input.apiKey),
      2 * 1024 * 1024,
    );
    const parsed = z
      .object({ data: z.array(z.object({ id: z.string().max(128) })) })
      .safeParse(body);
    if (!parsed.success) throw new ModelSettingsError("provider_unavailable");
    return [
      ...new Set(
        parsed.data.data
          .map((entry) => entry.id)
          .filter((id) =>
            /^[A-Za-z0-9][A-Za-z0-9._:@+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:@+-]*)?$/u.test(id),
          ),
      ),
    ].slice(0, 256);
  }
}

/** Fixed metadata-only URLs are selected by Server code; no key is sent to a renderer-chosen host. */
async function requestModelMetadata(
  fetcher: typeof fetch,
  url: string,
  headers: Record<string, string>,
  maximumBytes: number,
): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const signal = AbortSignal.timeout(8000);
    const response = await fetcher(url, { headers, redirect: "manual", signal });
    reader = response.body?.getReader();
    if (response.status === 401 || response.status === 403)
      throw new ModelSettingsError("invalid_credentials");
    if (response.status === 404) throw new ModelSettingsError("model_unavailable");
    if (
      !response.ok ||
      !response.headers.get("content-type")?.includes("application/json") ||
      !reader
    )
      throw new ModelSettingsError("provider_unavailable");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximumBytes) throw new ModelSettingsError("provider_unavailable");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof ModelSettingsError) throw error;
    throw new ModelSettingsError("provider_unavailable");
  } finally {
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
}

function modelHeaders(provider: string, apiKey: string): Record<string, string> {
  return provider === "anthropic"
    ? { Accept: "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
    : { Accept: "application/json", Authorization: `Bearer ${apiKey}` };
}
