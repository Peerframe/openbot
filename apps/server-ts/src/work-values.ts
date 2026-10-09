import { createHash } from "node:crypto";
import type { WorkJsonValue } from "@openbot/protocol";
import { WorkConflict } from "@openbot/work";

export function workText(value: unknown, maximum: number): string {
  const blank = (s: string) =>
    [...s].every((character) => {
      const point = character.codePointAt(0)!;
      return (
        (point >= 9 && point <= 13) ||
        (point >= 28 && point <= 32) ||
        /^[\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u.test(character)
      );
    });
  if (
    typeof value !== "string" ||
    blank(value) ||
    value.includes("\0") ||
    /[\ud800-\udfff]/u.test(value) ||
    Buffer.byteLength(value) > maximum
  )
    throw new WorkConflict("invalid_work_input");
  return value;
}
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
/** Closed control records retain Python's sorted Unicode-key, compact UTF-8 encoding. */
export function workCanonical(value: unknown, maximum = 16384): { wire: string; digest: string } {
  let nodes = 0;
  const encode = (v: unknown, depth: number): string => {
    if (++nodes > 4096 || depth > 12) throw new WorkConflict("work_json_limit");
    if (v === null || typeof v === "boolean") return JSON.stringify(v);
    if (typeof v === "string") {
      if (v.includes("\0") || /[\ud800-\udfff]/u.test(v))
        throw new WorkConflict("invalid_work_json");
      return JSON.stringify(v);
    }
    if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER)
      return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map((x) => encode(x, depth + 1)).join(",") + "]";
    if (typeof v === "object" && v && Object.getPrototypeOf(v) === Object.prototype) {
      const keys = Object.keys(v).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      return (
        "{" +
        keys
          .map((k) => {
            if (Buffer.byteLength(k) > 128) throw new WorkConflict("work_json_key_limit");
            return encode(k, depth + 1) + ":" + encode(Reflect.get(v, k), depth + 1);
          })
          .join(",") +
        "}"
      );
    }
    throw new WorkConflict("invalid_work_json");
  };
  const wire = encode(value, 0);
  if (Buffer.byteLength(wire) > maximum) throw new WorkConflict("work_json_limit");
  return { wire, digest: sha256(wire) };
}
export type WorkJson = WorkJsonValue;
export function artifactName(value: unknown): string {
  const name = workText(value, 255);
  if (
    [".", ".."].includes(name) ||
    [...name].some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === "/" || c === "\\",
    )
  )
    throw new WorkConflict("invalid_artifact_name");
  return name;
}
