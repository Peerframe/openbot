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

  return new TextDecoder("utf-8", { fatal: true }).decode(
    await readBoundedBytes(response.body, maximumBytes, "Response exceeds its byte limit."),
  );
}

/** Callers retain their media, identity and byte-limit policy; this owns only the reader. */
export async function readBoundedBytes(
  body: ReadableStream<Uint8Array>,
  maximumBytes: number,
  overflowMessage: string,
): Promise<Buffer<ArrayBuffer>> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    throw new RangeError("maximumBytes must be a non-negative safe integer.");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let complete = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        complete = true;
        return Buffer.concat(chunks, length);
      }
      length += result.value.byteLength;
      if (length > maximumBytes) throw new Error(overflowMessage);
      chunks.push(result.value);
    }
  } finally {
    // Untrusted cancellation must not hold a rejected operation or its reader lock open.
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function discardBody(body: ReadableStream<Uint8Array> | null | undefined): void {
  if (body) void body.cancel().catch(() => undefined);
}

export function isJsonContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}
