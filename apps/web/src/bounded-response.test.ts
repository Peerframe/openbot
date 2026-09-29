import { describe, expect, it } from "vitest";
import { type BoundedResponseMessages, readBoundedResponse } from "./bounded-response";

const messages: BoundedResponseMessages = {
  missingBody: "附件未返回有效内容。",
  tooLarge: "附件响应超过允许大小。",
};
type CancelBehavior = (reason: unknown) => void | PromiseLike<void>;
interface ProbeStream {
  readonly stream: ReadableStream<Uint8Array>;
  readonly cancelReasons: unknown[];
  pulls(): number;
}
function chunkedStream(
  chunks: readonly (readonly number[])[],
  cancel?: CancelBehavior,
): ProbeStream {
  const cancelReasons: unknown[] = [];
  let index = 0;
  let pullCount = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pullCount += 1;
        const next = chunks[index];
        index += 1;
        if (next === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(Uint8Array.from(next));
      },
      cancel(reason) {
        cancelReasons.push(reason);
        return cancel?.(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, cancelReasons, pulls: () => pullCount };
}
function erroringStream(error: unknown, before: readonly (readonly number[])[] = []): ProbeStream {
  const cancelReasons: unknown[] = [];
  let index = 0;
  let pullCount = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pullCount += 1;
        const next = before[index];
        index += 1;
        if (next === undefined) {
          controller.error(error);
          return;
        }
        controller.enqueue(Uint8Array.from(next));
      },
      cancel(reason) {
        cancelReasons.push(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, cancelReasons, pulls: () => pullCount };
}
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the promise to reject.");
}
async function settlesWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("readBoundedResponse did not settle.")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
function expectMessage(error: unknown, message: string): void {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(message);
}

describe("readBoundedResponse", () => {
  it("rejects a null body with the caller missing-body message", async () => {
    const response = new Response(null);
    expect(response.body).toBeNull();
    expectMessage(
      await rejection(readBoundedResponse(response, 16, messages)),
      messages.missingBody,
    );
  });
  it("rejects invalid limits before locking the body", async () => {
    for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const probe = chunkedStream([[1]]);
      const response = new Response(probe.stream);
      const error = await rejection(readBoundedResponse(response, limit, messages));
      expect(error).toBeInstanceOf(RangeError);
      expect(response.body?.locked).toBe(false);
      expect(probe.pulls()).toBe(0);
    }
  });
  it("accepts an empty present stream", async () => {
    const probe = chunkedStream([]);
    const response = new Response(probe.stream);
    const bytes = await readBoundedResponse(response, 0, messages);
    expect(bytes.byteLength).toBe(0);
    expect(bytes.buffer).toBeInstanceOf(ArrayBuffer);
    expect(probe.cancelReasons).toEqual([]);
    expect(response.body?.locked).toBe(false);
  });
  it("concatenates binary chunks including split and invalid UTF-8 bytes", async () => {
    const probe = chunkedStream([[0xe2], [0x82, 0xac, 0xff], [], [0x00, 0xc3]]);
    const response = new Response(probe.stream);
    const bytes = await readBoundedResponse(response, 64, messages);
    expect(Array.from(bytes)).toEqual([0xe2, 0x82, 0xac, 0xff, 0x00, 0xc3]);
    expect(bytes.buffer).toBeInstanceOf(ArrayBuffer);
    expect(bytes.byteOffset).toBe(0);
    expect(bytes.buffer.byteLength).toBe(6);
    expect(probe.cancelReasons).toEqual([]);
    expect(response.body?.locked).toBe(false);
  });
  it("accepts exactly the limit across chunks", async () => {
    const probe = chunkedStream([
      [1, 2, 3],
      [4, 5],
      [6, 7, 8],
    ]);
    const response = new Response(probe.stream);
    const bytes = await readBoundedResponse(response, 8, messages);
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(probe.cancelReasons).toEqual([]);
  });
  it("rejects one chunk of limit plus one and cancels the stream", async () => {
    const probe = chunkedStream([[1, 2, 3, 4, 5, 6, 7, 8, 9], [10]]);
    const response = new Response(probe.stream);
    expectMessage(await rejection(readBoundedResponse(response, 8, messages)), messages.tooLarge);
    expect(probe.cancelReasons).toHaveLength(1);
    expect(probe.pulls()).toBe(1);
    expect(response.body?.locked).toBe(false);
  });
  it("rejects when the cumulative size reaches limit plus one", async () => {
    const probe = chunkedStream([[1, 2, 3, 4], [5, 6, 7, 8], [9], [10]]);
    const response = new Response(probe.stream);
    expectMessage(await rejection(readBoundedResponse(response, 8, messages)), messages.tooLarge);
    expect(probe.cancelReasons).toHaveLength(1);
    expect(probe.pulls()).toBe(3);
    expect(response.body?.locked).toBe(false);
  });
  it("propagates the original read error and releases the lock", async () => {
    const original = new Error("network reset");
    const probe = erroringStream(original, [[1, 2]]);
    const response = new Response(probe.stream);
    expect(await rejection(readBoundedResponse(response, 64, messages))).toBe(original);
    expect(response.body?.locked).toBe(false);
  });
  it("does not use a lying Content-Length header", async () => {
    const small = new Response(chunkedStream([[1, 2, 3, 4, 5]]).stream, {
      headers: { "content-length": "1" },
    });
    expect(Array.from(await readBoundedResponse(small, 5, messages))).toEqual([1, 2, 3, 4, 5]);
    const large = new Response(chunkedStream([[1, 2, 3, 4, 5, 6]]).stream, {
      headers: { "content-length": "2" },
    });
    expectMessage(await rejection(readBoundedResponse(large, 5, messages)), messages.tooLarge);
    const overstated = new Response(chunkedStream([[7]]).stream, {
      headers: { "content-length": "999999999" },
    });
    expect(Array.from(await readBoundedResponse(overstated, 1, messages))).toEqual([7]);
  });
  it("does not decide the response status", async () => {
    for (const status of [200, 404, 500]) {
      const response = new Response(chunkedStream([[status % 256]]).stream, { status });
      expect(Array.from(await readBoundedResponse(response, 4, messages))).toEqual([status % 256]);
    }
  });
  it("keeps the overflow error when underlying cancel rejects", async () => {
    const probe = chunkedStream([[1, 2, 3]], () => Promise.reject(new Error("cancel failed")));
    const response = new Response(probe.stream);
    const error = await settlesWithin(rejection(readBoundedResponse(response, 2, messages)), 1000);
    expectMessage(error, messages.tooLarge);
    expect(probe.cancelReasons).toHaveLength(1);
    expect(response.body?.locked).toBe(false);
  });
  it("keeps the overflow error when underlying cancel throws synchronously", async () => {
    const probe = chunkedStream([[1, 2, 3]], () => {
      throw new Error("cleanup failed");
    });
    const response = new Response(probe.stream);
    const error = await settlesWithin(rejection(readBoundedResponse(response, 2, messages)), 1000);
    expectMessage(error, messages.tooLarge);
    expect(probe.cancelReasons).toHaveLength(1);
    expect(response.body?.locked).toBe(false);
  });
  it("does not hang when underlying cancel never settles", async () => {
    const probe = chunkedStream([[1, 2, 3]], () => new Promise<void>(() => undefined));
    const response = new Response(probe.stream);
    const error = await settlesWithin(rejection(readBoundedResponse(response, 2, messages)), 1000);
    expectMessage(error, messages.tooLarge);
    expect(probe.cancelReasons).toHaveLength(1);
    expect(response.body?.locked).toBe(false);
  });
  it("does not cancel a successfully completed stream", async () => {
    const probe = chunkedStream([[1], [2]], () => {
      throw new Error("cancel must not run");
    });
    const response = new Response(probe.stream);
    expect(Array.from(await readBoundedResponse(response, 2, messages))).toEqual([1, 2]);
    expect(probe.cancelReasons).toEqual([]);
    expect(response.body?.locked).toBe(false);
  });
});
