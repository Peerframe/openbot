import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { ByteProviderTransport, ModelTransport } from "./model-network.js";
import { scalarText } from "./owner-auth-crypto.js";
import { loadWorkInstallation } from "./work-installation.js";
import { validateWorkOptions, type WorkOptions } from "./work-service.js";
import type { WorkerRuntimeOptions } from "./worker-runtime.js";

export interface EntryOptions {
  upstream: string;
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

function origin(value: string): URL {
  if (!/^[\x21-\x7e]+$/.test(value) || value.includes("\\")) {
    throw new Error("An exact HTTP origin is required.");
  }
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== value || url.port === "0") {
    throw new Error("An exact HTTP origin is required.");
  }
  return url;
}

export function validateOptions(options: EntryOptions): EntryOptions {
  if (options.product) {
    if (options.product.workerRuntime && (!options.product.work || !options.product.controlReads))
      throw new Error("The sole Worker registry requires the complete Work/product composition.");
    if (options.product.work) {
      if (!options.product.models) throw new Error("Work requires model connection composition.");
      validateWorkOptions(options.product.work);
    }
    if (
      options.product.publisher &&
      Object.values(options.product.publisher).some(
        (path) => !isAbsolute(path) || path.includes("\0") || path.length > 4096,
      )
    )
      throw new Error("Explicit protected publisher paths required.");
    if (
      options.product.plugins &&
      ([options.product.plugins.storePath, options.product.plugins.catalogPath]
        .filter((p) => p !== undefined)
        .some((p) => !isAbsolute(p) || p.includes("\0") || p.length > 4096) ||
        !Array.isArray(options.product.plugins.localEndpoints) ||
        options.product.plugins.localEndpoints.length > 16 ||
        options.product.plugins.localEndpoints.some(
          (p) => typeof p !== "string" || p.length > 2048,
        ))
    )
      throw new Error("Explicit bounded plugin composition required.");
    if (
      options.product.files &&
      [options.product.files.objectRoot, options.product.files.artifactRoot]
        .filter((path) => path !== undefined)
        .some((path) => !isAbsolute(path) || path.includes("\0") || path.length > 4096)
    )
      throw new Error("Explicit protected storage roots required.");
    if (
      options.product.models &&
      (!isAbsolute(options.product.models.keyPath) ||
        options.product.models.keyPath.length > 4096 ||
        options.product.models.keyPath.includes("\0"))
    )
      throw new Error("Model credentials require an explicit absolute key path.");
    const database = new URL(options.product.databaseUrl);
    if (!["postgres:", "postgresql:"].includes(database.protocol) || !database.hostname)
      throw new Error("Product routes require explicit PostgreSQL configuration.");
    for (const value of options.product.allowedOrigins ?? [options.publicOrigin]) origin(value);
  }
  if (options.channelRead) {
    try {
      const database = new URL(options.channelRead.databaseUrl);
      if (!["postgres:", "postgresql:"].includes(database.protocol) || !database.hostname)
        throw new Error();
      for (const value of options.channelRead.allowedOrigins ?? [options.publicOrigin])
        origin(value);
    } catch {
      throw new Error("Channel reads require explicit valid PostgreSQL and origin configuration.");
    }
  }
  if (options.transcriptionRead) {
    try {
      for (const value of options.transcriptionRead.allowedOrigins ?? [options.publicOrigin])
        origin(value);
      const database = new URL(options.transcriptionRead.databaseUrl);
      if (!["postgres:", "postgresql:"].includes(database.protocol) || !database.hostname)
        throw new Error();
    } catch {
      throw new Error("The transcription read group requires an explicit PostgreSQL URL.");
    }
  }
  if (options.primaryBotWrite) {
    try {
      for (const value of options.primaryBotWrite.allowedOrigins ?? [options.publicOrigin])
        origin(value);
      const database = new URL(options.primaryBotWrite.databaseUrl);
      if (!["postgres:", "postgresql:"].includes(database.protocol) || !database.hostname)
        throw new Error();
    } catch {
      throw new Error("The primary Bot write group requires an explicit PostgreSQL URL.");
    }
  }
  if (options.ownerAuth) {
    const auth = options.ownerAuth;
    try {
      const database = new URL(auth.databaseUrl);
      if (!["postgres:", "postgresql:"].includes(database.protocol) || !database.hostname)
        throw new Error();
      const origins = auth.allowedOrigins ?? [options.publicOrigin];
      if (!origins.length) throw new Error();
      for (const value of origins) origin(value);
      if (
        typeof auth.password !== "string" ||
        !scalarText(auth.password) ||
        [...auth.password].length < 15 ||
        [...auth.password].length > 1024 ||
        auth.password === "replace-with-a-long-random-owner-password" ||
        typeof auth.ownerName !== "string" ||
        !auth.ownerName.trim() ||
        [...auth.ownerName].length > 80 ||
        !Number.isInteger(auth.ttlHours) ||
        auth.ttlHours < 1 ||
        auth.ttlHours > 168
      )
        throw new Error();
    } catch {
      throw new Error(
        "Owner authentication requires explicit valid database, credentials, identity, TTL and origins.",
      );
    }
  }
  const databases = [
    options.transcriptionRead,
    options.primaryBotWrite,
    options.ownerAuth,
    options.channelRead,
    options.product,
  ]
    .filter((group) => group !== undefined)
    .map((group) => group.databaseUrl);
  if (new Set(databases).size > 1)
    throw new Error("Selected TS groups require the same explicit PostgreSQL URL.");
  const upstream = origin(options.upstream);
  if (upstream.protocol !== "http:" || upstream.hostname !== "127.0.0.1") {
    throw new Error("The fixed Python upstream must be numeric IPv4 loopback HTTP.");
  }
  const publicOrigin = origin(options.publicOrigin);
  if (
    (publicOrigin.protocol === "https:") !== (options.tls !== undefined) ||
    (options.host === "0.0.0.0" && !options.tls) ||
    (options.tls &&
      [options.tls.certificatePath, options.tls.privateKeyPath].some(
        (path) =>
          typeof path !== "string" ||
          !isAbsolute(path) ||
          path.length > 4096 ||
          path.includes("\0"),
      ))
  )
    throw new Error(
      "HTTPS requires explicit certificate/key paths; public plaintext listeners are refused.",
    );
  if (
    !["127.0.0.1", "0.0.0.0"].includes(options.host) ||
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535 ||
    options.upstream === options.publicOrigin ||
    Number(upstream.port || "80") === options.port
  ) {
    throw new Error("Invalid TS listener or recursive upstream.");
  }
  return { ...options };
}

export function entryOptions(environment: NodeJS.ProcessEnv): EntryOptions {
  const productGroup = environment.OPENBOT_TS_PRODUCT_GROUP ?? "none";
  const workGroup = environment.OPENBOT_TS_WORK_GROUP ?? "none";
  if (
    workGroup !== "none" &&
    !/^[0-9]{1,10}$/.test(environment.OPENBOT_CONTROL_WORK_TOKEN_LIMIT ?? "100000")
  )
    throw new Error("Product Work token limit must be an explicit bounded integer.");
  if (
    !["none", "reports", "p4"].includes(workGroup) ||
    (workGroup !== "none" && productGroup !== "p3")
  )
    throw new Error("Unknown or incomplete TS Work composition.");
  if (!["none", "identity", "identity-models", "p3"].includes(productGroup))
    throw new Error("Unknown TS product group.");
  if (productGroup !== "none" && !environment.OPENBOT_TS_DATABASE_URL)
    throw new Error("Product routes require an explicit PostgreSQL URL.");
  const channelGroup = environment.OPENBOT_TS_CHANNEL_READ_GROUP ?? "none";
  if (!["none", "channels"].includes(channelGroup))
    throw new Error("Unknown TS channel read group.");
  if (channelGroup === "channels" && !environment.OPENBOT_TS_DATABASE_URL)
    throw new Error("Channel reads require an explicit PostgreSQL URL.");
  const group = environment.OPENBOT_TS_READ_GROUP ?? "none";
  if (!["none", "transcription"].includes(group)) throw new Error("Unknown TS read group.");
  if (group === "transcription" && !environment.OPENBOT_TS_DATABASE_URL)
    throw new Error("The transcription read group requires an explicit PostgreSQL URL.");
  const writeGroup = environment.OPENBOT_TS_WRITE_GROUP ?? "none";
  if (!["none", "primary-bot"].includes(writeGroup)) throw new Error("Unknown TS write group.");
  if (writeGroup === "primary-bot" && !environment.OPENBOT_TS_DATABASE_URL)
    throw new Error("The primary Bot write group requires an explicit PostgreSQL URL.");
  const authGroup = environment.OPENBOT_TS_AUTH_GROUP ?? "none";
  if (!["none", "owner"].includes(authGroup)) throw new Error("Unknown TS auth group.");
  if (
    workGroup === "p4" &&
    (authGroup !== "owner" ||
      channelGroup !== "channels" ||
      group !== "transcription" ||
      writeGroup !== "primary-bot")
  )
    throw new Error("P4 requires all accepted product groups and the sole TS Owner authority.");
  const installedWork =
    workGroup === "p4"
      ? loadWorkInstallation({
          temporal: environment.OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH ?? "",
          fileRoot: environment.OPENBOT_TS_WORK_FILE_ROOT ?? "",
          tokenLimit: Number(environment.OPENBOT_CONTROL_WORK_TOKEN_LIMIT ?? "100000"),
          ...(environment.OPENBOT_CONTROL_BROWSER_CONFIG_PATH === undefined
            ? {}
            : { browser: environment.OPENBOT_CONTROL_BROWSER_CONFIG_PATH }),
          ...(environment.OPENBOT_CONTROL_COMMAND_CONFIG_PATH === undefined
            ? {}
            : { command: environment.OPENBOT_CONTROL_COMMAND_CONFIG_PATH }),
        })
      : undefined;
  const ttl = environment.OPENBOT_TS_SESSION_TTL_HOURS ?? "12";
  if (authGroup === "owner" && !/^[0-9]{1,3}$/.test(ttl))
    throw new Error("Invalid Owner session TTL.");
  const port = environment.OPENBOT_TS_PORT ?? "3101";
  if (!/^[0-9]{1,5}$/.test(port)) throw new Error("Invalid TS listener port.");
  const certificatePath = environment.OPENBOT_TS_TLS_CERT_PATH;
  const privateKeyPath = environment.OPENBOT_TS_TLS_KEY_PATH;
  if ((certificatePath === undefined) !== (privateKeyPath === undefined))
    throw new Error("TLS certificate and private key must be configured together.");
  return validateOptions({
    ...(productGroup !== "none"
      ? {
          product: {
            ...(installedWork
              ? {
                  workerRuntime: installedWork.workerRuntime,
                  work: {
                    ...installedWork.work,
                    ...(environment.TAVILY_API_KEY === undefined
                      ? {}
                      : { web: { tavilyKey: environment.TAVILY_API_KEY } }),
                  },
                }
              : {}),
            ...(workGroup === "reports"
              ? {
                  work: {
                    address: environment.OPENBOT_TS_TEMPORAL_ADDRESS ?? "",
                    namespace: environment.OPENBOT_TS_TEMPORAL_NAMESPACE ?? "default",
                    taskQueue:
                      environment.OPENBOT_TS_TEMPORAL_QUEUE ?? "openbot-work-ts-v1-product",
                    executionTimeoutMs: 3600000,
                    tokenLimit: Number(environment.OPENBOT_CONTROL_WORK_TOKEN_LIMIT ?? "100000"),
                    fileRoot: environment.OPENBOT_TS_WORK_FILE_ROOT ?? "",
                    ...(environment.TAVILY_API_KEY !== undefined
                      ? { web: { tavilyKey: environment.TAVILY_API_KEY } }
                      : {}),
                    tls: {
                      ca: environment.OPENBOT_TS_TEMPORAL_CA ?? "",
                      certificate: environment.OPENBOT_TS_TEMPORAL_CERT ?? "",
                      key: environment.OPENBOT_TS_TEMPORAL_KEY ?? "",
                      serverName: environment.OPENBOT_TS_TEMPORAL_SERVER_NAME ?? "",
                    },
                  },
                }
              : {}),
            ...(productGroup === "p3"
              ? {
                  controlReads: true,
                  ...(environment.OPENBOT_CONTROL_PUBLISHER_DIRECTORY ||
                  environment.OPENBOT_CONTROL_PUBLISHER_PASSPHRASE_FILE
                    ? {
                        publisher: {
                          directory: environment.OPENBOT_CONTROL_PUBLISHER_DIRECTORY ?? "",
                          passphraseFile:
                            environment.OPENBOT_CONTROL_PUBLISHER_PASSPHRASE_FILE ?? "",
                        },
                      }
                    : {}),
                  plugins: {
                    storePath:
                      environment.OPENBOT_TS_PLUGIN_STORE_PATH ??
                      (environment.OPENBOT_TS_OBJECT_ROOT ?? "") + "/plugins/state.json",
                    localEndpoints: JSON.parse(
                      environment.OPENBOT_TS_PLUGIN_LOCAL_ENDPOINTS ?? "[]",
                    ),
                    ...(environment.OPENBOT_PLUGIN_CATALOG_PATH
                      ? { catalogPath: environment.OPENBOT_PLUGIN_CATALOG_PATH }
                      : {}),
                  },
                  files: {
                    objectRoot: environment.OPENBOT_TS_OBJECT_ROOT ?? "",
                    parser: {
                      worker:
                        environment.OPENBOT_TS_PARSER_WORKER_PATH ??
                        fileURLToPath(
                          new URL(
                            "../../server-python/src/openbot_server/parser_worker.ts",
                            import.meta.url,
                          ),
                        ),
                      modules:
                        environment.OPENBOT_TS_NODE_MODULE_ROOT ??
                        fileURLToPath(new URL("../../../node_modules", import.meta.url)),
                    },
                    ...(environment.OPENBOT_TS_ARTIFACT_ROOT
                      ? { artifactRoot: environment.OPENBOT_TS_ARTIFACT_ROOT }
                      : {}),
                  },
                }
              : {}),
            ...(productGroup === "identity-models" || productGroup === "p3"
              ? {
                  models: {
                    keyPath: environment.OPENBOT_TS_MODEL_CONNECTION_KEY_PATH ?? "",
                    customBaseUrls: JSON.parse(
                      environment.OPENBOT_TS_MODEL_CUSTOM_BASE_URLS ?? "[]",
                    ) as string[],
                  },
                }
              : {}),
            databaseUrl: environment.OPENBOT_TS_DATABASE_URL!,
            ...(environment.OPENBOT_TS_READ_ALLOWED_ORIGINS !== undefined
              ? {
                  allowedOrigins: environment.OPENBOT_TS_READ_ALLOWED_ORIGINS.split(",").map(
                    (value) => value.trim(),
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...(channelGroup === "channels"
      ? {
          channelRead: {
            databaseUrl: environment.OPENBOT_TS_DATABASE_URL!,
            ...(environment.OPENBOT_TS_READ_ALLOWED_ORIGINS !== undefined
              ? {
                  allowedOrigins: environment.OPENBOT_TS_READ_ALLOWED_ORIGINS.split(",").map(
                    (value) => value.trim(),
                  ),
                }
              : {}),
          },
        }
      : {}),
    upstream: environment.OPENBOT_TS_PYTHON_ORIGIN ?? "",
    publicOrigin: environment.OPENBOT_TS_PUBLIC_ORIGIN ?? "",
    host: (environment.OPENBOT_TS_HOST ?? "127.0.0.1") as EntryOptions["host"],
    port: Number(port),
    ...(authGroup === "owner"
      ? {
          ownerAuth: {
            databaseUrl: environment.OPENBOT_TS_DATABASE_URL ?? "",
            password: environment.OPENBOT_TS_OWNER_PASSWORD ?? "",
            ownerName: environment.OPENBOT_OWNER_NAME ?? "Owner",
            ttlHours: Number(ttl),
            ...(environment.OPENBOT_TS_AUTH_ALLOWED_ORIGINS !== undefined
              ? {
                  allowedOrigins: environment.OPENBOT_TS_AUTH_ALLOWED_ORIGINS.split(",").map(
                    (value) => value.trim(),
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...(group === "transcription"
      ? {
          transcriptionRead: {
            databaseUrl: environment.OPENBOT_TS_DATABASE_URL!,
            ...(environment.OPENBOT_TS_READ_ALLOWED_ORIGINS !== undefined
              ? {
                  allowedOrigins: environment.OPENBOT_TS_READ_ALLOWED_ORIGINS.split(",").map(
                    (value) => value.trim(),
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...(writeGroup === "primary-bot"
      ? {
          primaryBotWrite: {
            databaseUrl: environment.OPENBOT_TS_DATABASE_URL!,
            ...(environment.OPENBOT_TS_WRITE_ALLOWED_ORIGINS !== undefined
              ? {
                  allowedOrigins: environment.OPENBOT_TS_WRITE_ALLOWED_ORIGINS.split(",").map(
                    (value) => value.trim(),
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...(certificatePath !== undefined && privateKeyPath !== undefined
      ? { tls: { certificatePath, privateKeyPath } }
      : {}),
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

export function peerForwarded(address: string | undefined): string {
  const version = address && isIP(address);
  if (!version) throw new Error("A numeric direct client address is required.");
  return version === 6 ? `for="[${address}]"` : `for=${address}`;
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
