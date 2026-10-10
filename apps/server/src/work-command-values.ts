/** Encodes strict bounded command values and stable token digests. */
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

export const invalidCommand = () => new Error("invalid_command_contract");
export type CommandValueLimit = 512 | 8192 | 16384 | 32768;
const validText = (s: string) => !s.includes("\0") && !/[\uD800-\uDFFF]/u.test(s);
/** Validate the retained integer-only JSON domain before invoking the reviewed RFC 8785 library. */
export function commandValue(value: unknown, maximum: CommandValueLimit = 16384): Buffer {
  let remaining = 4096;
  const parents = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (--remaining < 0 || depth > 12) throw invalidCommand();
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isSafeInteger(item)) return;
    if (typeof item === "string" && validText(item)) return;
    if (typeof item !== "object" || !item || parents.has(item)) throw invalidCommand();
    const array = Array.isArray(item);
    if (
      !array &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw invalidCommand();
    parents.add(item);
    const keys = Reflect.ownKeys(item);
    if (array && keys.length !== item.length + 1) throw invalidCommand();
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string" || !key || !validText(key) || Buffer.byteLength(key) > 128)
        throw invalidCommand();
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) throw invalidCommand();
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))
        throw invalidCommand();
      visit(descriptor.value, depth + 1);
    }
    parents.delete(item);
  };
  try {
    visit(value, 0);
    const canonical = canonicalize(value);
    if (canonical === undefined) throw invalidCommand();
    const bytes = Buffer.from(canonical);
    if (bytes.length > maximum) throw invalidCommand();
    return bytes;
  } catch {
    throw invalidCommand();
  }
}
/** JSON.parse owns grammar. This lexical pass additionally rejects duplicate (including escaped)
 * object keys and float/exponent number tokens, which JSON.parse would otherwise erase. */
export function strictCommandJson(bytes: Uint8Array, maximum: CommandValueLimit = 16384): unknown {
  try {
    if (!bytes.length || bytes.length > maximum) throw invalidCommand();
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const value: unknown = JSON.parse(source);
    const stack: (Set<string> | null)[] = [];
    const tokens = source.matchAll(
      /"(?:[^"\\]|\\[\s\S])*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|[{}[\]:,]|true|false|null/g,
    );
    for (const match of tokens) {
      const token = match[0];
      if (token === "{") stack.push(new Set());
      else if (token === "[") stack.push(null);
      else if (token === "}" || token === "]") stack.pop();
      else if (token.startsWith('"')) {
        if (/^\s*:/.test(source.slice(match.index + token.length))) {
          const keys = stack.at(-1),
            key: string = JSON.parse(token);
          if (!keys || keys.has(key)) throw invalidCommand();
          keys.add(key);
        }
      } else if (/^[0-9-]/.test(token) && !/^-?(?:0|[1-9][0-9]*)$/.test(token))
        throw invalidCommand();
      if (stack.length > 13) throw invalidCommand();
    }
    commandValue(value, maximum);
    return value;
  } catch {
    throw invalidCommand();
  }
}
export const commandDigest = (value: unknown, maximum: CommandValueLimit = 16384) =>
  createHash("sha256").update(commandValue(value, maximum)).digest("hex");
export function commandTokenDigest(token: string) {
  if (
    typeof token !== "string" ||
    token.length > 8192 ||
    [...token].some((character) => character.charCodeAt(0) > 127)
  )
    throw invalidCommand();
  return createHash("sha256").update(token, "ascii").digest("hex");
}
