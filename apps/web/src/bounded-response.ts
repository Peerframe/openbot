export interface BoundedResponseMessages {
  readonly missingBody: string;
  readonly tooLarge: string;
}

/** Byte/reader lifetime only; callers own HTTP status, decoding, schema and file identity. */
export async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
  messages: BoundedResponseMessages,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    throw new RangeError("maximumBytes must be a non-negative safe integer.");
  const body = response.body;
  if (body === null) throw new Error(messages.missingBody);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let complete = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        complete = true;
        break;
      }
      length += next.value.byteLength;
      if (length > maximumBytes) throw new Error(messages.tooLarge);
      chunks.push(next.value);
    }
  } finally {
    if (!complete) {
      // Failed or stuck cancellation cannot replace the read error or delay releasing the lock.
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        /* Preserve the primary error. */
      }
    }
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
