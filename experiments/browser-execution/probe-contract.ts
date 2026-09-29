/** Fixed bounds and failure shape shared by the A1 CDP qualification probe modules. */
export const LIMITS = Object.freeze({
  frame: 384 * 1024,
  wire: 2 * 1024 * 1024,
  dom: 16 * 1024,
  png: 192 * 1024,
  result: 512 * 1024,
  workMs: 58000,
  evidenceMs: 62000,
  totalMs: 65000,
});

/** Parsed untrusted JSON object; every member stays unknown until a caller narrows it. */
export type JsonObject = Readonly<Record<string, unknown>>;

/** Fixed failure code; protocolCode carries only a numeric CDP error code. */
export type ProbeFailure = Error & { readonly code: string; protocolCode?: number };

export function fail(code: string): ProbeFailure {
  return Object.assign(new Error(code), { code });
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** String code of a thrown probe failure or Node system error, when present. */
export function errorCode(error: unknown): string | undefined {
  const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  return typeof code === "string" ? code : undefined;
}

export function protocolCode(error: unknown): number | undefined {
  const code =
    typeof error === "object" && error !== null ? Reflect.get(error, "protocolCode") : undefined;
  return typeof code === "number" && Number.isSafeInteger(code) ? code : undefined;
}
