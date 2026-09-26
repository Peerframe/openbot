import { createHash } from "node:crypto";
import { isIP } from "node:net";

export type ClientIdentitySource = "direct" | "forwarded";

export interface ClientIdentity {
  digest: string;
  source: ClientIdentitySource;
}

export interface ResolveClientIdentityInput {
  remoteAddress: string | undefined;
  forwarded: string | undefined;
  trustedProxyAddress?: string | undefined;
}

export class ClientIdentityError extends Error {}

/**
 * Resolves one network source without retaining its raw address. Forwarding metadata is accepted
 * only from one exact configured proxy and only for one unambiguous RFC 7239 element.
 */
export function resolveClientIdentity(input: ResolveClientIdentityInput): ClientIdentity {
  const directAddress = canonicalIpAddress(input.remoteAddress);
  if (directAddress === undefined) {
    throw new ClientIdentityError("A canonical direct client address is required.");
  }

  const trustedProxy =
    input.trustedProxyAddress === undefined
      ? undefined
      : canonicalIpAddress(input.trustedProxyAddress);
  if (input.trustedProxyAddress !== undefined && trustedProxy === undefined) {
    throw new ClientIdentityError("The trusted proxy address is invalid.");
  }

  if (trustedProxy !== undefined && directAddress === trustedProxy) {
    const forwardedAddress = parseSingleForwardedAddress(input.forwarded);
    return { digest: digestClientAddress(forwardedAddress), source: "forwarded" };
  }

  return { digest: digestClientAddress(directAddress), source: "direct" };
}

export function canonicalIpAddress(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const version = isIP(trimmed);
  if (version === 4) return trimmed;
  if (version !== 6 || trimmed.includes("%")) return undefined;
  const hostname = new URL(`http://[${trimmed}]/`).hostname;
  return hostname.slice(1, -1).toLowerCase();
}

function parseSingleForwardedAddress(header: string | undefined): string {
  if (header === undefined || header.trim().length === 0 || header.includes(",")) {
    throw new ClientIdentityError("A single Forwarded element is required from the trusted proxy.");
  }

  let forwardedFor: string | undefined;
  for (const rawParameter of header.split(";")) {
    const separator = rawParameter.indexOf("=");
    if (separator <= 0) throw new ClientIdentityError("Forwarded metadata is malformed.");
    const name = rawParameter.slice(0, separator).trim().toLowerCase();
    const rawValue = rawParameter.slice(separator + 1).trim();
    if (name !== "for") continue;
    if (forwardedFor !== undefined) {
      throw new ClientIdentityError("Forwarded metadata contains multiple client addresses.");
    }
    forwardedFor = unquoteForwardedValue(rawValue);
  }

  if (forwardedFor === undefined) {
    throw new ClientIdentityError("Forwarded metadata does not identify a client address.");
  }
  const unbracketed =
    forwardedFor.startsWith("[") && forwardedFor.endsWith("]")
      ? forwardedFor.slice(1, -1)
      : forwardedFor;
  const address = canonicalIpAddress(unbracketed);
  if (address === undefined) {
    throw new ClientIdentityError(
      "Forwarded client identity must be an IP address without a port.",
    );
  }
  return address;
}

function unquoteForwardedValue(value: string): string {
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"') || value.length < 2 || value.slice(1, -1).includes("\\")) {
    throw new ClientIdentityError("Forwarded client identity has invalid quoting.");
  }
  return value.slice(1, -1);
}

function digestClientAddress(address: string): string {
  return createHash("sha256").update("openbot:client-network:v1\0").update(address).digest("hex");
}
