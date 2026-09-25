import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import { convert } from "html-to-text";
import ipaddr from "ipaddr.js";

const MAX_PAGE_BYTES = 512 * 1024;
const MAX_TEXT_BYTES = 6000;
export interface PublicSource {
  url: string;
  text: string;
  truncated: boolean;
  fetchedAt: string;
}
export interface SourceAddress {
  address: string;
  family: number;
}
export interface SourceResponse {
  status: number;
  contentType: string;
  contentEncoding?: string | undefined;
  body: Buffer;
}
export interface SourceTransport {
  resolve(hostname: string): Promise<SourceAddress[]>;
  read(url: URL, address: SourceAddress, signal: AbortSignal): Promise<SourceResponse>;
}

export function normalizeSourceUrl(value: string): URL {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject URL control characters before parsing.
  if (value.length > 2048 || /[\u0000-\u0020\u007f]/u.test(value))
    throw new Error("Invalid source URL.");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  ) {
    throw new Error("Sources must be credential-free HTTPS URLs on the standard port.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  if (!hostname.includes(".") && !isIP(hostname)) throw new Error("Source hostname is not public.");
  if (
    /\.(?:localhost|local|internal|test|invalid|onion)$/iu.test(hostname) ||
    hostname === "localhost"
  ) {
    throw new Error("Source hostname is not public.");
  }
  url.hash = "";
  return url;
}

/** Authority is the current task's explicit URLs, never URLs found in model output or web content. */
export function taskSourceUrls(instruction: string): string[] {
  const urls: string[] = [];
  for (const match of instruction.matchAll(/https:\/\/[^\s<>"'`，。；！？（）]+/giu)) {
    try {
      const url = normalizeSourceUrl(match[0].replace(/[),.;!?，。；！？）]+$/u, "")).href;
      if (!urls.includes(url)) urls.push(url);
      if (urls.length === 3) break;
    } catch {
      // Invalid links do not become callable targets merely because the user pasted them.
    }
  }
  return urls;
}

export function isPublicSourceAddress(value: string): boolean {
  if (isIP(value) === 0 || value.includes("%")) return false;
  const address = ipaddr.parse(value);
  if (address.range() !== "unicast") return false;
  // ipaddr's current tables do not classify every IPv4-compatible IPv6 form (upstream #203).
  // Only global IPv6 unicast can enter this reader; transition/translation ranges fail above.
  return (
    address.kind() === "ipv4" || (address as ipaddr.IPv6).match(ipaddr.IPv6.parse("2000::"), 3)
  );
}

const transport: SourceTransport = {
  resolve: (hostname) => lookup(hostname, { all: true, verbatim: true }),
  read: (url, address, signal) =>
    new Promise((resolve, reject) => {
      const hostname = url.hostname.replace(/^\[|\]$/gu, "");
      const req = request(
        url,
        {
          method: "GET",
          // A numeric connection address prevents a second DNS resolution after policy validation.
          // Host and TLS certificate identity stay bound to the original user-provided hostname.
          hostname: address.address,
          family: address.family,
          servername: isIP(hostname) ? "" : hostname,
          checkServerIdentity: (_name, cert) => checkServerIdentity(hostname, cert),
          rejectUnauthorized: true,
          agent: false,
          signal,
          headers: {
            Host: url.host,
            Accept: "text/html, text/plain;q=0.9",
            "Accept-Encoding": "identity",
            "User-Agent": "OpenBot-SourceReader/1.0",
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          const contentType = response.headers["content-type"] ?? "";
          const contentEncoding = response.headers["content-encoding"];
          if (
            response.statusCode !== 200 ||
            !isTextType(contentType) ||
            (contentEncoding && contentEncoding !== "identity") ||
            Number(response.headers["content-length"] ?? 0) > MAX_PAGE_BYTES
          ) {
            response.destroy();
            reject(new Error("Source response is not bounded public text."));
            return;
          }
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.byteLength;
            if (bytes > MAX_PAGE_BYTES) {
              response.destroy(new Error("Source response is too large."));
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              contentType,
              contentEncoding,
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    }),
};

function isTextType(value: string): boolean {
  return /^(?:text\/html|text\/plain)(?:\s*;|$)/iu.test(value);
}

export async function readPublicSource(
  value: string,
  parentSignal: AbortSignal,
  io: SourceTransport = transport,
): Promise<PublicSource> {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(15_000)]);
  signal.throwIfAborted();
  const url = normalizeSourceUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await abortable(io.resolve(hostname), signal);
  if (
    addresses.length === 0 ||
    addresses.length > 32 ||
    addresses.some(
      (entry) => !isPublicSourceAddress(entry.address) || entry.family !== isIP(entry.address),
    )
  ) {
    throw new Error("Source address is not exclusively public.");
  }
  signal.throwIfAborted();
  const response = await abortable(io.read(url, addresses[0] as SourceAddress, signal), signal);
  if (
    response.status !== 200 ||
    !isTextType(response.contentType) ||
    (response.contentEncoding && response.contentEncoding !== "identity") ||
    response.body.byteLength > MAX_PAGE_BYTES
  )
    throw new Error("Source response is not bounded public text.");
  const input = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
  const text = (
    response.contentType.toLowerCase().startsWith("text/html")
      ? convert(input, {
          wordwrap: false,
          limits: {
            maxInputLength: MAX_PAGE_BYTES,
            maxDepth: 40,
            maxChildNodes: 1000,
            maxBaseElements: 1,
          },
          selectors: [
            { selector: "script", format: "skip" },
            { selector: "style", format: "skip" },
            { selector: "iframe", format: "skip" },
            { selector: "noscript", format: "skip" },
            { selector: "img", format: "skip" },
            { selector: "a", options: { ignoreHref: true } },
          ],
        })
      : input
  )
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Remove untrusted controls while retaining tabs and line breaks.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .trim();
  signal.throwIfAborted();
  if (!text) throw new Error("The source contains no readable text.");
  const bytes = Buffer.from(text);
  return {
    url: url.href,
    text: bytes
      .subarray(0, MAX_TEXT_BYTES)
      .toString("utf8")
      .replace(/\ufffd$/u, ""),
    truncated: bytes.byteLength > MAX_TEXT_BYTES,
    fetchedAt: new Date().toISOString(),
  };
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let aborted: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        aborted = () => reject(new Error("Source read cancelled or timed out."));
        signal.addEventListener("abort", aborted, { once: true });
      }),
    ]);
  } finally {
    if (aborted) signal.removeEventListener("abort", aborted);
  }
}
