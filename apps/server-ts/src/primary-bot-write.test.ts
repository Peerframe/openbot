import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import { describe, it } from "vitest";
import { entryOptions } from "./config.js";
import { WriteFailure } from "./primary-bot-write.js";
import { boundedJson, primaryBotJson } from "./write-input.js";

describe("explicit primary Bot ownership", () => {
  const base = {
    OPENBOT_TS_PYTHON_ORIGIN: "http://127.0.0.1:3102",
    OPENBOT_TS_PUBLIC_ORIGIN: "http://127.0.0.1:3101",
  };
  it("defaults to Python and requires an explicit bounded SQL/origin selection", () => {
    assert.equal(entryOptions(base).primaryBotWrite, undefined);
    for (const overrides of [
      { OPENBOT_TS_WRITE_GROUP: "all" },
      {
        OPENBOT_TS_WRITE_GROUP: "primary-bot",
        OPENBOT_TS_READ_GROUP: "transcription",
        OPENBOT_TS_DATABASE_URL: "postgres://127.0.0.1/disposable",
        OPENBOT_TS_WRITE_ALLOWED_ORIGINS: "null",
      },
      { OPENBOT_TS_WRITE_GROUP: "primary-bot" },
      { OPENBOT_TS_WRITE_GROUP: "primary-bot", OPENBOT_TS_DATABASE_URL: "https://database.test" },
      {
        OPENBOT_TS_WRITE_GROUP: "primary-bot",
        OPENBOT_TS_DATABASE_URL: "postgres://127.0.0.1/disposable",
        OPENBOT_TS_WRITE_ALLOWED_ORIGINS: "*",
      },
    ])
      assert.throws(() => entryOptions({ ...base, ...overrides }));
    assert.deepEqual(
      entryOptions({
        ...base,
        OPENBOT_TS_WRITE_GROUP: "primary-bot",
        OPENBOT_TS_DATABASE_URL: "postgres://127.0.0.1/disposable",
      }).primaryBotWrite,
      { databaseUrl: "postgres://127.0.0.1/disposable" },
    );
  });
});
describe("bounded retained JSON input", () => {
  const read = (body: Buffer, type = "application/json", length?: string) =>
    primaryBotJson(Readable.from([body]), type, length, new AbortController().signal);
  it("keeps duplicate-key/mathematical-integer spelling and exact content-type behavior", async () => {
    assert.deepEqual(
      await read(Buffer.from('{"botId":"old","botId":null,"expectedRevision":1.0}')),
      { botId: null, expectedRevision: 1 },
    );
    assert.equal(await read(Buffer.from("{}"), "APPLICATION/JSON"), null);
    await assert.rejects(
      read(Buffer.from("{}"), "application/jsonish"),
      (e: unknown) => e instanceof WriteFailure && e.body.error === "Request requires JSON.",
    );
  });
  it("refuses oversized bytes, invalid UTF8/BOM/non-standard JSON without replacement decoding", async () => {
    for (const [body, status] of [
      [Buffer.alloc(1025, 32), 413],
      [Buffer.from([0xc0, 0xaf]), 422],
      [Buffer.from("\ufeff{}"), 422],
      [Buffer.from('{"x":NaN}'), 422],
    ] as const)
      await assert.rejects(
        read(body),
        (e: unknown) => e instanceof WriteFailure && e.status === status,
      );
    await assert.rejects(
      read(Buffer.from("{}"), "application/json", "00002"),
      (e: unknown) => e instanceof WriteFailure && e.status === 413,
    );
  });
  it("finishes a bounded rejected upload before returning its 413 envelope", async () => {
    for (const declared of [true, false]) {
      const payload = new PassThrough();
      const maximum = 2 * 1024 * 1024;
      let settled = false;
      const result = boundedJson(
        payload,
        "application/json",
        declared ? String(maximum + 13) : undefined,
        new AbortController().signal,
        maximum,
      ).catch((error: unknown) => {
        settled = true;
        return error;
      });
      payload.write(Buffer.alloc(maximum));
      payload.write(Buffer.alloc(13));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        settled,
        false,
        "A bounded upload must finish before closing its response socket.",
      );
      payload.end();
      const failure = await result;
      assert(failure instanceof WriteFailure && failure.status === 413);
      assert.equal(payload.readableEnded, true);
      assert.equal(payload.listenerCount("data"), 0);
    }
  });
  it("bounds rejected upload discards and releases them on cancellation", async () => {
    const payload = new PassThrough();
    const abort = new AbortController();
    const result = boundedJson(payload, "application/json", "1025", abort.signal, 1024);
    abort.abort();
    await assert.rejects(
      result,
      (error: unknown) => error instanceof WriteFailure && error.status === 503,
    );
    assert.equal(payload.listenerCount("data"), 0);
    payload.destroy();
    const unbounded = new PassThrough();
    const refused = boundedJson(
      unbounded,
      "application/json",
      undefined,
      new AbortController().signal,
      1024,
    );
    unbounded.write(Buffer.alloc(1024 + 65536 + 1));
    await assert.rejects(
      refused,
      (error: unknown) => error instanceof WriteFailure && error.status === 413,
    );
    assert.equal(unbounded.listenerCount("data"), 0);
    unbounded.destroy();
  });
  it("releases stream listeners on an already-aborted body", async () => {
    const payload = new PassThrough();
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(primaryBotJson(payload, "application/json", undefined, abort.signal));
    assert.equal(payload.listenerCount("data"), 0);
    assert.equal(payload.listenerCount("end"), 0);
    assert.equal(payload.listenerCount("close"), 0);
    payload.destroy();
  });
});
