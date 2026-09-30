/** Bounded DOM/render/PNG/diagnostic evidence and the fail-closed final record for A1. */
import { createHash } from "node:crypto";
import { crc32, inflateSync } from "node:zlib";
import { fail, isJsonObject, LIMITS } from "./probe-contract.ts";

const WIDTH = 1280;
const HEIGHT = 800;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CANONICAL_BASE64 = /^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const RESULT_ELEMENT = /<pre id="result">([^<]+)<\/pre>/;
const hash = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** The fixed synthetic page's self-reported result; checked in place, never rebuilt. */
export interface RenderProof {
  readonly synthetic: true;
  readonly sum: 25;
  readonly text: "a.b 你好";
  readonly previous: boolean;
  readonly cookiePrevious: boolean;
}
export interface DomEvidence {
  readonly text: string;
  readonly bytes: number;
  readonly sha256: string;
}
export interface PngEvidence {
  readonly base64: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
}
/** Per-target evidence retained immediately, including after a later failure. */
export interface ArtifactSlot {
  domAttempted?: boolean;
  pngAttempted?: boolean;
  dom?: DomEvidence;
  png?: PngEvidence;
}
/** Minimal shape serialize needs; artifact bodies are dropped structurally on overflow. */
export interface SerializableRecord {
  readonly origin?: number;
  readonly accepted?: unknown;
  readonly runs?: readonly { readonly artifacts?: object }[];
}

function isRenderProof(value: unknown): value is RenderProof {
  return (
    isJsonObject(value) &&
    value.synthetic === true &&
    value.sum === 25 &&
    value.text === "a.b 你好" &&
    typeof value.previous === "boolean" &&
    typeof value.cookiePrevious === "boolean"
  );
}

export function proof(dom: string): RenderProof {
  const value: unknown = JSON.parse(RESULT_ELEMENT.exec(dom)?.[1] ?? "null");
  if (!isRenderProof(value)) throw fail("render-proof-missing");
  return value;
}

export function domEvidence(text: unknown): DomEvidence {
  if (typeof text !== "string" || Buffer.byteLength(text) > LIMITS.dom) throw fail("dom-bound");
  return { text, bytes: Buffer.byteLength(text), sha256: hash(text) };
}

/** Walk every chunk with CRC; require one leading 8-bit RGB/RGBA IHDR and a final IEND. */
function pngChunks(b: Buffer): { readonly channels: number; readonly idat: Buffer[] } {
  let offset = 8;
  let channels = 0;
  let ended = false;
  const idat: Buffer[] = [];
  while (offset < b.length) {
    if (offset + 12 > b.length) throw fail("png-chunk");
    const size = b.readUInt32BE(offset);
    const end = offset + 12 + size;
    if (end > b.length) throw fail("png-chunk");
    const type = b.toString("ascii", offset + 4, offset + 8);
    const payload = b.subarray(offset + 8, end - 4);
    if (crc32(b.subarray(offset + 4, end - 4)) !== b.readUInt32BE(end - 4)) throw fail("png-crc");
    if (offset === 8) {
      if (
        type !== "IHDR" ||
        size !== 13 ||
        payload.readUInt8(8) !== 8 ||
        (payload.readUInt8(9) !== 2 && payload.readUInt8(9) !== 6) ||
        payload.readUInt8(10) ||
        payload.readUInt8(11) ||
        payload.readUInt8(12)
      )
        throw fail("png-format");
      channels = payload.readUInt8(9) === 6 ? 4 : 3;
    } else if (type === "IHDR") throw fail("png-chunk");
    if (type === "IDAT") idat.push(payload);
    if (type === "IEND") {
      if (size !== 0 || end !== b.length) throw fail("png-chunk");
      ended = true;
    }
    offset = end;
  }
  if (!ended || !idat.length) throw fail("png-chunk");
  return { channels, idat };
}

/** Bounded exact decompression: the output cap equals the only valid pixel size. */
function verifyPixels(compressed: Buffer, channels: number): void {
  const row = 1 + WIDTH * channels;
  const raw = inflateSync(compressed, { maxOutputLength: HEIGHT * row });
  if (raw.length !== HEIGHT * row) throw fail("png-pixels");
  for (let y = 0; y < HEIGHT; y++) if (raw.readUInt8(y * row) > 4) throw fail("png-filter");
}

export function pngEvidence(data: unknown): PngEvidence {
  if (
    typeof data !== "string" ||
    data.length > Math.ceil(LIMITS.png / 3) * 4 ||
    !CANONICAL_BASE64.test(data)
  )
    throw fail("png-bound");
  const b = Buffer.from(data, "base64");
  if (
    b.toString("base64") !== data ||
    b.length < 24 ||
    b.length > LIMITS.png ||
    !b.subarray(0, 8).equals(PNG_SIGNATURE) ||
    b.readUInt32BE(16) !== WIDTH ||
    b.readUInt32BE(20) !== HEIGHT
  )
    throw fail("screenshot-proof-missing");
  const { channels, idat } = pngChunks(b);
  verifyPixels(Buffer.concat(idat), channels);
  return { base64: data, bytes: b.length, sha256: hash(b), width: WIDTH, height: HEIGHT };
}

/** Chromium's own inner-sandbox diagnostic; inherited process seccomp alone is insufficient. */
export function sandboxProof(text: string): string {
  const clean = text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 6000);
  if (
    !/Seccomp-BPF sandbox\s+Yes/i.test(clean) ||
    !/Layer 1 Sandbox\s+Namespace/i.test(clean) ||
    !/PID namespaces\s+Yes/i.test(clean) ||
    !/Network namespaces\s+Yes/i.test(clean)
  )
    throw fail("internal-sandbox-diagnostic-not-confirmed");
  return clean;
}

function dropBody(evidence: unknown, body: string): void {
  if (typeof evidence === "object" && evidence !== null) Reflect.deleteProperty(evidence, body);
}

/** Overflow drops artifact bodies, keeps their metadata and refuses acceptance. */
export function serialize(record: SerializableRecord): string {
  const value: Record<string, unknown> = { ...record };
  delete value.origin;
  let result = JSON.stringify(value);
  if (Buffer.byteLength(result) > LIMITS.result) {
    value.accepted = false;
    value.failure = "record-bound";
    for (const run of record.runs ?? []) {
      const artifacts: readonly unknown[] = Object.values(run.artifacts ?? {});
      for (const artifact of artifacts)
        if (isJsonObject(artifact)) {
          dropBody(artifact.dom, "text");
          dropBody(artifact.png, "base64");
        }
    }
    result = JSON.stringify(value);
    if (Buffer.byteLength(result) > LIMITS.result) throw fail("record-bound");
  }
  return result;
}
