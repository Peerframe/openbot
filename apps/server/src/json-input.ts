// Retain JSON token shape only for contracts that explicitly require Python's strict int.
// Other DTOs intentionally accept mathematical integers, including 1.0.
const nonIntegerTokens = new WeakMap<object, Set<string>>();
export function parseJsonInput(source: string): unknown {
  return JSON.parse(
    source,
    function (this: object, key: string, value: unknown, context?: { source?: string }) {
      if (
        typeof value === "number" &&
        context?.source &&
        !/^-?(?:0|[1-9][0-9]*)$/.test(context.source)
      ) {
        const keys = nonIntegerTokens.get(this) ?? new Set<string>();
        keys.add(key);
        nonIntegerTokens.set(this, keys);
      }
      return value;
    },
  );
}
export function hasIntegerTokens(value: unknown, keys: readonly string[]): boolean {
  return (
    typeof value !== "object" ||
    value === null ||
    !keys.some((key) => nonIntegerTokens.get(value)?.has(key))
  );
}
