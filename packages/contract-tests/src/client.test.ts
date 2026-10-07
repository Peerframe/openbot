import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { contractClient } from "./client.ts";

const target = {
  baseUrl: "http://127.0.0.1:3001",
  origin: "https://fixture.invalid",
  cookie: "openbot_session=synthetic",
  botId: "abcdefab-1234-4234-8234-000000000001",
};
// Synthetic response chunks qualify only runner framing; product transport has separate real HTTP tests.
function response(t: TestContext, chunks: Uint8Array[]) {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
            "X-Accel-Buffering": "no",
            "Access-Control-Allow-Origin": target.origin,
            "Access-Control-Allow-Credentials": "true",
          },
        },
      ),
  );
}
test("SSE runner preserves split UTF-8, multiple frames and complete EOF", async (t) => {
  const first = 'event: fixture\ndata: {"text":"🧪"}\n\n';
  const second = "event: heartbeat\ndata: alive\n\n";
  const bytes = Buffer.from(first + second);
  const offset = bytes.indexOf(Buffer.from("🧪")) + 2;
  response(t, [
    bytes.subarray(0, offset),
    bytes.subarray(offset, offset + 1),
    bytes.subarray(offset + 1),
  ]);
  const stream = await contractClient(target).stream("/fixture");
  try {
    assert.equal(await stream.next(), first);
    assert.equal(await stream.next(), second);
    assert.equal(await stream.next(), null);
  } finally {
    await stream.close();
  }
});
test("SSE runner refuses a truncated frame instead of treating it as clean closure", async (t) => {
  response(t, [Buffer.from('event: fixture\ndata: {"partial":true}')]);
  const stream = await contractClient(target).stream("/fixture");
  try {
    await assert.rejects(stream.next(), /incomplete frame/);
  } finally {
    await stream.close();
  }
});
test("SSE runner refuses an incomplete UTF-8 sequence at EOF", async (t) => {
  response(t, [Buffer.from("event: fixture\ndata: "), Uint8Array.from([0xf0, 0x9f])]);
  const stream = await contractClient(target).stream("/fixture");
  try {
    await assert.rejects(stream.next(), /encoded data|UTF-8/);
  } finally {
    await stream.close();
  }
});
test("SSE runner bounds actual UTF-8 bytes when character count would admit an oversized frame", async (t) => {
  response(t, [Buffer.from("data: " + "🧪".repeat(1024 * 1024) + "\n\n")]);
  const stream = await contractClient(target).stream("/fixture");
  try {
    await assert.rejects(stream.next(), /unbounded/);
  } finally {
    await stream.close();
  }
});
