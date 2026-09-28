/** Bounded UTF-8 reader for Desktop Server health, session and enrollment responses. */
export async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes) {
      throw new Error("Response length is invalid.");
    }
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximumBytes) throw new Error("Response exceeds its byte limit.");
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function isJsonContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}
