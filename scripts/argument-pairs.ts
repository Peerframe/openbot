export function parseArgumentPairs(
  arguments_: readonly string[],
  malformedMessage: string,
): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !key?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--") ||
      values.has(key)
    ) {
      throw new Error(malformedMessage);
    }
    values.set(key, value);
  }
  return values;
}
