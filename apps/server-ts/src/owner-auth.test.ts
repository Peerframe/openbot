import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "vitest";
import { entryOptions } from "./config.js";
import { boundedAdmission, clientDigest, digest, ownerCrypto } from "./owner-auth-crypto.js";
import { WriteFailure } from "./primary-bot-write.js";
import { boundedJson } from "./write-input.js";

describe("Owner authentication boundary", () => {
  const base = {
    OPENBOT_TS_PYTHON_ORIGIN: "http://127.0.0.1:3102",
    OPENBOT_TS_PUBLIC_ORIGIN: "http://127.0.0.1:3101",
  };
  const selected = {
    ...base,
    OPENBOT_TS_AUTH_GROUP: "owner",
    OPENBOT_TS_DATABASE_URL: "postgres://127.0.0.1/disposable",
    OPENBOT_TS_OWNER_PASSWORD: "synthetic-owner-password",
  };
  it("requires explicit selection and refuses invalid credential/configuration bounds", () => {
    assert.equal(entryOptions(base).ownerAuth, undefined);
    assert.equal(entryOptions(selected).ownerAuth?.ttlHours, 12);
    for (const override of [
      { OPENBOT_TS_AUTH_GROUP: "all" },
      { OPENBOT_TS_DATABASE_URL: "" },
      { OPENBOT_TS_OWNER_PASSWORD: "short" },
      { OPENBOT_TS_OWNER_PASSWORD: "x".repeat(1025) },
      { OPENBOT_TS_OWNER_PASSWORD: "replace-with-a-long-random-owner-password" },
      { OPENBOT_TS_OWNER_PASSWORD: "x".repeat(15) + "\ud800" },
      { OPENBOT_TS_AUTH_ALLOWED_ORIGINS: "" },
      { OPENBOT_TS_AUTH_ALLOWED_ORIGINS: "*" },
      { OPENBOT_TS_SESSION_TTL_HOURS: "169" },
      { OPENBOT_TS_SESSION_TTL_HOURS: "1.5" },
      { OPENBOT_OWNER_NAME: " " },
      { OPENBOT_OWNER_NAME: "😀".repeat(81) },
    ])
      assert.throws(() => entryOptions({ ...selected, ...override }));
    assert(entryOptions({ ...selected, OPENBOT_TS_OWNER_PASSWORD: "😀".repeat(1024) }).ownerAuth);
  });
  it("canonicalizes direct IPv4/IPv6 including mapped addresses without accepting zones", () => {
    assert.equal(
      clientDigest(" ::FFFF:127.0.0.1 "),
      digest("openbot:client-network:v1\0::ffff:7f00:1"),
    );
    assert.equal(clientDigest("2001:DB8:0:0:0:0:0:1"), clientDigest("2001:db8::1"));
    for (const address of [undefined, "host.test", "127.1", "fe80::1%en0", "127.0.0.01"])
      assert.throws(() => clientDigest(address));
  });
  it("keeps admission occupied after client abort until the underlying work settles", async () => {
    const admit = boundedAdmission(1),
      abort = new AbortController();
    let finish!: () => void;
    const work = admit(
      abort.signal,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    abort.abort();
    await assert.rejects(work);
    await assert.rejects(admit(new AbortController().signal, async () => undefined));
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await admit(new AbortController().signal, async () => 7), 7);
  });
  it("settles SQL work before returning an aborted file-owning transaction", async () => {
    const admit = boundedAdmission(1, true),
      abort = new AbortController();
    let finish!: () => void,
      returned = false;
    const work = admit(
      abort.signal,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const result = work.catch(() => {
      returned = true;
    });
    await Promise.resolve();
    abort.abort();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(returned, false);
    await assert.rejects(admit(new AbortController().signal, async () => undefined));
    finish();
    await result;
    assert.equal(returned, true);
  });
  it("uses 8192-byte auth JSON with retained MIME, UTF8, JSON and cancellation semantics", async () => {
    const read = (body: Buffer, type = "APPLICATION/JSON") =>
      boundedJson(Readable.from([body]), type, undefined, new AbortController().signal);
    assert.deepEqual(await read(Buffer.from('{"password":"x"}')), { password: "x" });
    for (const [body, status] of [
      [Buffer.alloc(8193), 413],
      [Buffer.from("\ufeff{}"), 422],
      [Buffer.from([0xc0, 0xaf]), 422],
      [Buffer.from('{"x":NaN}'), 422],
    ] as const)
      await assert.rejects(
        read(body),
        (e: unknown) => e instanceof WriteFailure && e.status === status,
      );
    await assert.rejects(read(Buffer.from("{}"), "text/plain"));
  });
  it("preserves Python-compatible salted fixed-cost scrypt and rejects parameter injection", async () => {
    const crypto = ownerCrypto(),
      signal = new AbortController().signal,
      password = "synthetic-owner-😀-password";
    const one = await crypto.hash(password, signal),
      two = await crypto.hash(password, signal);
    assert.notEqual(one, two);
    assert(await crypto.verify(password, one, digest("unused"), signal));
    assert.equal(await crypto.verify(password + " ", one, digest("unused"), signal), false);
    assert(await crypto.verify(password, undefined, digest(password), signal));
    for (const invalid of [one.replace("32768", "9999999999"), one.toUpperCase(), ""])
      await assert.rejects(crypto.verify(password, invalid, digest(password), signal));
    // CPython3.12 hashlib.scrypt vector; the real HTTP gate also rotates across both implementations.
    assert(
      await crypto.verify(
        password,
        "scrypt$32768$8$3$000102030405060708090a0b0c0d0e0f$a32998ce7ac4e4086830c0245fd0f95738469fab90b67636d3dd96154d9c4b37",
        digest("unused"),
        signal,
      ),
    );
  });
});
