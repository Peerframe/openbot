import assert from "node:assert/strict";
import { describe, it } from "vitest";
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
