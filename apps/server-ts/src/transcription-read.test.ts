import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { entryOptions } from "./config.js";
import { ownerCookie } from "./transcription-read.js";

const token = "a".repeat(43);
describe("retained Owner cookie wire contract", () => {
  it("accepts only the selected secure/loopback name and bounded ASCII token", () => {
    assert.equal(ownerCookie(`openbot_session=${token}`, false), token);
    assert.equal(ownerCookie(`openbot_session=${token}`, true), undefined);
    assert.equal(ownerCookie(`__Host-openbot_session=${token}`, true), token);
    for (const value of [
      undefined,
      "",
      `openbot_session=${"a".repeat(42)}`,
      `openbot_session=%61${token.slice(1)}`,
    ])
      assert.equal(ownerCookie(value, false), undefined);
  });
  it("retains last duplicate, quoted escapes, whitespace and first equals", () => {
    assert.equal(ownerCookie(`openbot_session=bad; openbot_session = "${token}"`, false), token);
    assert.equal(ownerCookie(`openbot_session=${token}; openbot_session=bad`, false), undefined);
    assert.equal(ownerCookie(`openbot_session="\\141${token.slice(1)}"`, false), token);
    assert.equal(ownerCookie(`openbot_session="\\a${token.slice(1)}"`, false), token);
    assert.equal(ownerCookie(`openbot_session=${token}=`, false), undefined);
  });
});
describe("explicit read ownership", () => {
  const base = {
    OPENBOT_TS_PYTHON_ORIGIN: "http://127.0.0.1:3102",
    OPENBOT_TS_PUBLIC_ORIGIN: "http://127.0.0.1:3101",
  };
  it("defaults to forwarding and refuses unknown groups or missing/invalid database configuration", () => {
    assert.equal(entryOptions(base).transcriptionRead, undefined);
    for (const values of [
      { OPENBOT_TS_READ_GROUP: "all" },
      { OPENBOT_TS_READ_GROUP: "transcription" },
      {
        OPENBOT_TS_READ_GROUP: "transcription",
        OPENBOT_TS_DATABASE_URL: "https://db.test",
      },
    ])
      assert.throws(() => entryOptions({ ...base, ...values }));
    assert.deepEqual(
      entryOptions({
        ...base,
        OPENBOT_TS_READ_GROUP: "transcription",
        OPENBOT_TS_DATABASE_URL: "postgres://127.0.0.1:5432/disposable",
      }).transcriptionRead,
      { databaseUrl: "postgres://127.0.0.1:5432/disposable" },
    );
  });
  it("retains explicit CORS origins and rejects malformed or wildcard origins", () => {
    const group = {
      ...base,
      OPENBOT_TS_READ_GROUP: "transcription",
      OPENBOT_TS_DATABASE_URL: "postgres://127.0.0.1:5432/disposable",
    };
    assert.deepEqual(
      entryOptions({
        ...group,
        OPENBOT_TS_READ_ALLOWED_ORIGINS: `${base.OPENBOT_TS_PUBLIC_ORIGIN},https://secondary.example.test`,
      }).transcriptionRead?.allowedOrigins,
      [base.OPENBOT_TS_PUBLIC_ORIGIN, "https://secondary.example.test"],
    );
    for (const value of ["*", "null", "", "https://secondary.example.test/path"])
      assert.throws(() => entryOptions({ ...group, OPENBOT_TS_READ_ALLOWED_ORIGINS: value }));
  });
});
