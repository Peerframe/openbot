/** Validates explicit configuration before composing the sole public Server authority. */
import { z } from "zod";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { ByteProviderTransport, ModelTransport } from "./model-network.js";
import { scalarText } from "./owner-auth-crypto.js";
import { loadWorkInstallation } from "./work-installation.js";
import { validateWorkOptions, type WorkOptions } from "./work-service.js";
import { workerRuntimeConfiguration, type WorkerRuntimeOptions } from "./worker-runtime-contracts.js";

export interface EntryOptions {
  webRoot?: string;
  publicOrigin: string;
  host: "127.0.0.1" | "0.0.0.0";
  port: number;
  tls?: { certificatePath: string; privateKeyPath: string };
  product?: {
    databaseUrl: string;
    work?: WorkOptions;
    workerRuntime?: WorkerRuntimeOptions;
    allowedOrigins?: readonly string[];
    models?: { keyPath: string; customBaseUrls: readonly string[] };
    modelTransport?: ModelTransport;
    attachmentTransport?: ByteProviderTransport;
    controlReads?: boolean;
    publisher?: { directory: string; passphraseFile: string };
    plugins?: { storePath: string; localEndpoints: readonly string[]; catalogPath?: string };
    files?: {
      objectRoot: string;
      artifactRoot?: string;
      parser?: { worker: string; modules: string };
    };
  };
  channelRead?: { databaseUrl: string; allowedOrigins?: readonly string[] };
  transcriptionRead?: { databaseUrl: string; allowedOrigins?: readonly string[] };
  ownerAuth?: {
    databaseUrl: string;
    allowedOrigins?: readonly string[];
    password: string;
    ownerName: string;
    ttlHours: number;
  };
  primaryBotWrite?: { databaseUrl: string; allowedOrigins?: readonly string[] };
}

const absolutePath = z.string().min(1).max(4096).refine((value) => isAbsolute(value) && !value.includes("\0"));
const exactOrigin = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return /^[\x21-\x7e]+$/.test(value) && !value.includes("\\") &&
      ["http:", "https:"].includes(url.protocol) && url.origin === value && url.port !== "0";
  } catch { return false; }
});
const databaseUrl = z.string().min(1).max(8192).refine((value) => {
  try { const url = new URL(value); return ["postgres:", "postgresql:"].includes(url.protocol) && !!url.hostname; }
  catch { return false; }
});
const origins = z.array(exactOrigin).min(1).max(32);
const database = z.strictObject({ databaseUrl, allowedOrigins: origins.optional() });
const password = z.string().refine((value) => scalarText(value) && [...value].length >= 15 &&
  [...value].length <= 1024 && value !== "replace-with-a-long-random-owner-password");
const ownerName = z.string().refine((value) => scalarText(value) && !!value.trim() && [...value].length <= 80);
const work = z.custom<WorkOptions>((value) => {
  try { validateWorkOptions(value as WorkOptions); return true; } catch { return false; }
});
const entrySchema = z.strictObject({
  publicOrigin: exactOrigin, host: z.enum(["127.0.0.1", "0.0.0.0"]),
  port: z.number().int().min(1).max(65535), webRoot: absolutePath.optional(),
  tls: z.strictObject({ certificatePath: absolutePath, privateKeyPath: absolutePath }).optional(),
  transcriptionRead: database.optional(), primaryBotWrite: database.optional(), channelRead: database.optional(),
  ownerAuth: database.extend({ password, ownerName, ttlHours: z.number().int().min(1).max(168) }).optional(),
  product: database.extend({
    work: work.optional(), workerRuntime: workerRuntimeConfiguration.optional(),
    controlReads: z.boolean().optional(),
    models: z.strictObject({ keyPath: absolutePath, customBaseUrls: z.array(z.string().max(2048)).max(32) }).optional(),
    modelTransport: z.custom<ModelTransport>((value) => typeof value === "function").optional(),
    attachmentTransport: z.custom<ByteProviderTransport>((value) => typeof value === "function").optional(),
    publisher: z.strictObject({ directory: absolutePath, passphraseFile: absolutePath }).optional(),
    plugins: z.strictObject({ storePath: absolutePath, localEndpoints: z.array(z.string().max(2048)).max(16), catalogPath: absolutePath.optional() }).optional(),
    files: z.strictObject({ objectRoot: absolutePath, artifactRoot: absolutePath.optional(),
      parser: z.strictObject({ worker: absolutePath, modules: absolutePath }).optional(),
    }).optional(),
  }).optional(),
}).superRefine((value, context) => {
  const reject = (message: string) => context.addIssue({ code: "custom", message });
  if ((new URL(value.publicOrigin).protocol === "https:") !== !!value.tls || (value.host === "0.0.0.0" && !value.tls))
    reject("Public listeners require matching TLS configuration.");
  const databases = [value.transcriptionRead, value.primaryBotWrite, value.ownerAuth, value.channelRead, value.product]
    .flatMap((v) => v ? [v.databaseUrl] : []);
  if (new Set(databases).size > 1) reject("Server components must share one explicit PostgreSQL database.");
  if (value.product?.workerRuntime && (!value.product.work || !value.product.controlReads))
    reject("The Worker registry requires the complete Work composition.");
  if (value.product?.work && !value.product.models) reject("Work requires model connection composition.");
});

/** Internal tests may construct a scoped entry; the production environment always composes every owner. */
export function validateOptions(options: EntryOptions): EntryOptions {
  if (!entrySchema.safeParse(options).success) throw new Error("Invalid explicit Server configuration.");
  return { ...options };
}
const csvOrigins = z.string().max(65536).transform((value) => value.split(",").map((v) => v.trim())).pipe(origins);
const jsonStrings = z.string().max(65536).transform((value, context) => {
  try { return JSON.parse(value) as unknown; }
  catch { context.addIssue({ code: "custom", message: "Expected a JSON list." }); return z.NEVER; }
}).pipe(z.array(z.string().max(2048)).max(16));
const integer = (maximum: number) => z.string().regex(/^[0-9]{1,10}$/).transform(Number).pipe(z.number().int().min(1).max(maximum));
const environmentSchema = z.object({
  OPENBOT_TS_PUBLIC_ORIGIN: exactOrigin,
  OPENBOT_TS_HOST: z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1"),
  OPENBOT_TS_PORT: integer(65535).default(3101),
  OPENBOT_TS_DATABASE_URL: databaseUrl,
  OPENBOT_TS_OWNER_PASSWORD: password,
  OPENBOT_OWNER_NAME: ownerName.default("Owner"),
  OPENBOT_TS_SESSION_TTL_HOURS: integer(168).default(12),
  OPENBOT_TS_AUTH_ALLOWED_ORIGINS: csvOrigins.optional(),
  OPENBOT_TS_READ_ALLOWED_ORIGINS: csvOrigins.optional(),
  OPENBOT_TS_WRITE_ALLOWED_ORIGINS: csvOrigins.optional(),
  OPENBOT_TS_TLS_CERT_PATH: absolutePath.optional(),
  OPENBOT_TS_TLS_KEY_PATH: absolutePath.optional(),
  OPENBOT_CONTROL_WEB_ROOT: absolutePath.optional(),
  OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH: absolutePath,
  OPENBOT_CONTROL_BROWSER_CONFIG_PATH: absolutePath.optional(),
  OPENBOT_CONTROL_COMMAND_CONFIG_PATH: absolutePath.optional(),
  OPENBOT_CONTROL_WORK_TOKEN_LIMIT: z.string().regex(/^[0-9]{1,10}$/).transform(Number).pipe(z.number().int().min(0).max(1000000000)).default(100000),
  OPENBOT_TS_WORK_FILE_ROOT: absolutePath,
  OPENBOT_TS_OBJECT_ROOT: absolutePath,
  OPENBOT_TS_ARTIFACT_ROOT: absolutePath.optional(),
  OPENBOT_TS_MODEL_CONNECTION_KEY_PATH: absolutePath,
  OPENBOT_TS_MODEL_CUSTOM_BASE_URLS: jsonStrings.default([]),
  OPENBOT_TS_PLUGIN_STORE_PATH: absolutePath.optional(),
  OPENBOT_TS_PLUGIN_LOCAL_ENDPOINTS: jsonStrings.default([]),
  OPENBOT_PLUGIN_CATALOG_PATH: absolutePath.optional(),
  OPENBOT_TS_PARSER_WORKER_PATH: absolutePath.optional(),
  OPENBOT_TS_NODE_MODULE_ROOT: absolutePath.optional(),
  OPENBOT_CONTROL_PUBLISHER_DIRECTORY: absolutePath.optional(),
  OPENBOT_CONTROL_PUBLISHER_PASSPHRASE_FILE: absolutePath.optional(),
  TAVILY_API_KEY: z.string().min(1).max(4096).optional(),
}).superRefine((value, context) => {
  for (const [left, right] of [[value.OPENBOT_TS_TLS_CERT_PATH, value.OPENBOT_TS_TLS_KEY_PATH],
    [value.OPENBOT_CONTROL_PUBLISHER_DIRECTORY, value.OPENBOT_CONTROL_PUBLISHER_PASSPHRASE_FILE]])
    if ((left === undefined) !== (right === undefined)) context.addIssue({ code: "custom", message: "Paired configuration required." });
});

export function entryOptions(environment: NodeJS.ProcessEnv): EntryOptions {
  // Old partial deployments must fail visibly rather than silently selecting a different authority.
  if (Object.keys(environment).some((key) => key.startsWith("OPENBOT_TS_") && (key.endsWith("_GROUP") || key === "OPENBOT_TS_PYTHON_ORIGIN")))
    throw new Error("Retired partial Server configuration; use the complete Server entry.");
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) throw new Error("Invalid explicit Server environment configuration.");
  const e = parsed.data;
  const installed = loadWorkInstallation({ temporal: e.OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH,
    fileRoot: e.OPENBOT_TS_WORK_FILE_ROOT, tokenLimit: e.OPENBOT_CONTROL_WORK_TOKEN_LIMIT,
    ...(e.OPENBOT_CONTROL_BROWSER_CONFIG_PATH ? { browser: e.OPENBOT_CONTROL_BROWSER_CONFIG_PATH } : {}),
    ...(e.OPENBOT_CONTROL_COMMAND_CONFIG_PATH ? { command: e.OPENBOT_CONTROL_COMMAND_CONFIG_PATH } : {}),
  });
  const shared = { databaseUrl: e.OPENBOT_TS_DATABASE_URL };
  const reads = { ...shared, ...(e.OPENBOT_TS_READ_ALLOWED_ORIGINS ? { allowedOrigins: e.OPENBOT_TS_READ_ALLOWED_ORIGINS } : {}) };
  return validateOptions({
    publicOrigin: e.OPENBOT_TS_PUBLIC_ORIGIN, host: e.OPENBOT_TS_HOST, port: e.OPENBOT_TS_PORT,
    ...(e.OPENBOT_CONTROL_WEB_ROOT ? { webRoot: e.OPENBOT_CONTROL_WEB_ROOT } : {}),
    ...(e.OPENBOT_TS_TLS_CERT_PATH && e.OPENBOT_TS_TLS_KEY_PATH ? { tls: { certificatePath: e.OPENBOT_TS_TLS_CERT_PATH, privateKeyPath: e.OPENBOT_TS_TLS_KEY_PATH } } : {}),
    transcriptionRead: reads, channelRead: reads,
    primaryBotWrite: { ...shared, ...(e.OPENBOT_TS_WRITE_ALLOWED_ORIGINS ? { allowedOrigins: e.OPENBOT_TS_WRITE_ALLOWED_ORIGINS } : {}) },
    ownerAuth: { ...shared, password: e.OPENBOT_TS_OWNER_PASSWORD, ownerName: e.OPENBOT_OWNER_NAME,
      ttlHours: e.OPENBOT_TS_SESSION_TTL_HOURS, ...(e.OPENBOT_TS_AUTH_ALLOWED_ORIGINS ? { allowedOrigins: e.OPENBOT_TS_AUTH_ALLOWED_ORIGINS } : {}) },
    product: { ...reads, controlReads: true, workerRuntime: installed.workerRuntime,
      work: { ...installed.work, ...(e.TAVILY_API_KEY ? { web: { tavilyKey: e.TAVILY_API_KEY } } : {}) },
      models: { keyPath: e.OPENBOT_TS_MODEL_CONNECTION_KEY_PATH, customBaseUrls: e.OPENBOT_TS_MODEL_CUSTOM_BASE_URLS },
      plugins: { storePath: e.OPENBOT_TS_PLUGIN_STORE_PATH ?? e.OPENBOT_TS_OBJECT_ROOT + "/plugins/state.json",
        localEndpoints: e.OPENBOT_TS_PLUGIN_LOCAL_ENDPOINTS,
        ...(e.OPENBOT_PLUGIN_CATALOG_PATH ? { catalogPath: e.OPENBOT_PLUGIN_CATALOG_PATH } : {}),
      },
      files: { objectRoot: e.OPENBOT_TS_OBJECT_ROOT,
        ...(e.OPENBOT_TS_ARTIFACT_ROOT ? { artifactRoot: e.OPENBOT_TS_ARTIFACT_ROOT } : {}),
        parser: { worker: e.OPENBOT_TS_PARSER_WORKER_PATH ?? fileURLToPath(new URL("./parser-worker.js", import.meta.url)),
          modules: e.OPENBOT_TS_NODE_MODULE_ROOT ?? fileURLToPath(new URL("../../../node_modules", import.meta.url)) },
      },
      ...(e.OPENBOT_CONTROL_PUBLISHER_DIRECTORY && e.OPENBOT_CONTROL_PUBLISHER_PASSPHRASE_FILE ? {
        publisher: { directory: e.OPENBOT_CONTROL_PUBLISHER_DIRECTORY, passphraseFile: e.OPENBOT_CONTROL_PUBLISHER_PASSPHRASE_FILE },
      } : {}),
    },
  });
}

export function safeRequestTarget(value: string | undefined): value is string {
  if (
    !value ||
    value.length > 8192 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    forbiddenTargetCharacters(value, true) ||
    value.includes("#")
  )
    return false;
  try {
    const path = decodeURIComponent(value.split("?")[0] ?? "");
    return (
      !forbiddenTargetCharacters(path, false) &&
      !path.split("/").some((segment) => segment === "." || segment === "..")
    );
  } catch {
    return false;
  }
}

function forbiddenTargetCharacters(value: string, raw: boolean): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < (raw ? 33 : 32) || code === 127 || character === "\\";
  });
}

export function forbiddenHeader(name: string): boolean {
  return (
    name === "forwarded" ||
    name.startsWith("x-forwarded-") ||
    name === "x-real-ip" ||
    name.startsWith("x-openbot-identity") ||
    name === "x-openbot-owner" ||
    name === "x-openbot-client"
  );
}
