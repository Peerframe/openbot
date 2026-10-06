import { isIP } from "node:net";
import { isAbsolute } from "node:path";

export interface EntryOptions {
  upstream: string;
  publicOrigin: string;
  host: "127.0.0.1" | "0.0.0.0";
  port: number;
  tls?: { certificatePath: string; privateKeyPath: string };
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
  const port = environment.OPENBOT_TS_PORT ?? "3101";
  if (!/^[0-9]{1,5}$/.test(port)) throw new Error("Invalid TS listener port.");
  const certificatePath = environment.OPENBOT_TS_TLS_CERT_PATH;
  const privateKeyPath = environment.OPENBOT_TS_TLS_KEY_PATH;
  if ((certificatePath === undefined) !== (privateKeyPath === undefined))
    throw new Error("TLS certificate and private key must be configured together.");
  return validateOptions({
    upstream: environment.OPENBOT_TS_PYTHON_ORIGIN ?? "",
    publicOrigin: environment.OPENBOT_TS_PUBLIC_ORIGIN ?? "",
    host: (environment.OPENBOT_TS_HOST ?? "127.0.0.1") as EntryOptions["host"],
    port: Number(port),
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
