import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { channelReader } from "./channel-read.js";
import {
  botProjection,
  channelProjection,
  runProjection,
  decodeCursor,
  encodeCursor,
  messagePagination,
  boundedProjection,
} from "./channel-read-projection.js";

const encode = (raw: string) => Buffer.from(raw).toString("base64url");
const cursor = { v: 1, c: "频道😀", t: "2026-01-02T03:04:05.123456Z", i: "消息😀" };
describe("selected channel reads", () => {
  it("owns exactly four inventory reads", async () => {
    const reader = channelReader(
      { databaseUrl: "postgres://127.0.0.1/disposable" },
      "http://127.0.0.1:3101",
      false,
    );
    for (const path of [
      "/api/v1/bots",
      "/api/v1/channels",
      "/api/v1/channels/one/messages",
      "/api/v1/channels/one/runs",
    ]) {
      assert(reader.owns("GET", path));
      assert(!reader.owns("POST", path));
      assert(!reader.owns("HEAD", path));
    }
    assert(!reader.owns("GET", "/api/v1/workspace"));
    assert(!reader.owns("GET", "/api/v1/channels/a/b/messages"));
    await reader.close();
  });
  it("retains Unicode and exact microseconds in channel-bound canonical cursors", () => {
    const value = encodeCursor(cursor.c, { id: cursor.i, cursor_time: cursor.t });
    assert.equal(value, encode(JSON.stringify(cursor)));
    assert.deepEqual(decodeCursor(value, cursor.c), { time: cursor.t, id: cursor.i });
    const spaced = '{ "i" : "消息😀", "t":"2026-01-02T03:04:05.123456Z", "c":"频道😀", "v":1 }';
    assert.deepEqual(decodeCursor(encode(spaced), cursor.c), { time: cursor.t, id: cursor.i });
  });
  it("reads the retained Python byte-JSON UTF-16/32 cursor encodings", () => {
    const raw = JSON.stringify(cursor),
      utf16 = Buffer.from(raw, "utf16le");
    const utf32 = Buffer.alloc([...raw].length * 4);
    [...raw].forEach((character, index) => {
      utf32.writeUInt32LE(character.codePointAt(0)!, index * 4);
    });
    for (const bytes of [
      utf16,
      Buffer.from(utf16).swap16(),
      Buffer.concat([Buffer.from([255, 254]), utf16]),
      utf32,
      Buffer.from(utf32).swap32(),
    ])
      assert.deepEqual(decodeCursor(bytes.toString("base64url"), cursor.c), {
        time: cursor.t,
        id: cursor.i,
      });
  });
  it("rejects duplicate and escaped keys, float version, invalid date and extra fields", () => {
    const raw = JSON.stringify(cursor);
    for (const value of [
      raw.replace('"v":1', '"v":1,"v":1'),
      raw.replace('"v":1', '"v":1,"\\u0076":1'),
      raw.replace('"v":1', '"v":1.0'),
      raw.replace('"v":1', '"v":1e0'),
      raw.replace('"v":1', '"v":true'),
      raw.replace("2026-01-02", "2026-02-30"),
      raw.replace(".123456Z", ".123Z"),
      raw.replace('"v":1', '"v":1,"extra":0'),
      raw.replace("消息😀", "x".repeat(129)),
      raw.replace("频道😀", "other"),
      "\u00a0" + raw,
    ])
      assert.throws(() => decodeCursor(encode(value), cursor.c));
    assert.throws(() => decodeCursor(encode(raw) + "=", cursor.c));
    assert.throws(() => decodeCursor("_w", cursor.c));
  });
  it("keeps strict query key/limit admission", () => {
    assert.deepEqual(messagePagination("", "one"), { limit: 100, boundary: undefined });
    for (const raw of ["limit=1&limit=2", "other=1", "limit=01", "limit=0", "limit=101", "before="])
      assert.throws(() => messagePagination(raw, "one"));
  });
  it("projects only public config, omits malformed appearance and preserves code-point previews", () => {
    const date = new Date("2026-01-02T03:04:05.123Z");
    const bot = botProjection({
      id: "b",
      name: "Bot",
      role: "test",
      status: "idle",
      computer_profile: "none",
      configuration: { private: "never public", appearance: { head: "unknown" } },
      created_at: date,
    });
    assert.equal(bot.appearance, undefined);
    assert(!JSON.stringify(bot).includes("never public"));
    assert.equal(
      channelProjection([
        {
          id: "c",
          name: "Channel",
          description: "",
          created_at: date,
          bot_id: "b",
          latest_message_id: "m",
          latest_author_type: "system",
          latest_preview: "😀".repeat(160),
          latest_message_at: date,
        },
      ])[0]!.latestMessage!.preview.length,
      320,
    );
    const run = runProjection({
      id: "r",
      channel_id: "c",
      bot_id: "b",
      execution_profile: "none",
      title: "fallback",
      status: "completed",
      created_at: date,
      updated_at: date,
      model_usage: { private: true },
      result_summary: "",
    });
    assert.equal(run.instruction, "fallback");
    assert.equal(run.modelUsage, undefined);
    assert.equal(run.resultSummary, "");
  });
  it("counts UTF-8 bytes and Python JSON separators at the response limit", () => {
    assert.doesNotThrow(() => boundedProjection({ v: "x".repeat(4194304 - 9) }));
    assert.throws(() => boundedProjection({ v: "x".repeat(4194304 - 8) }));
  });
});
