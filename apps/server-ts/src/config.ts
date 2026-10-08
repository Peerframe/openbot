import { scalarText } from "./owner-auth-crypto.js";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";

export interface EntryOptions {
  upstream: string;
  publicOrigin: string;
  host: "127.0.0.1" | "0.0.0.0";
  port: number;
  tls?: { certificatePath: string; privateKeyPath: string };
  product?: { databaseUrl: string; allowedOrigins?: readonly string[] };
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
  if (!["none", "identity"].includes(productGroup)) throw new Error("Unknown TS product group.");
  if (productGroup === "identity" && !environment.OPENBOT_TS_DATABASE_URL)
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
    ...(productGroup === "identity"
      ? {
          product: {
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
