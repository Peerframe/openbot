/** Actual files, Ed25519 and flock preserve the former product Host fixture refusal coverage. */
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { exclusiveLock } from "../../apps/server/dist/posix-files.js";
import { exclusive, readBytes, readRecord } from "../linux-execution/protected-io.ts";
import type { NativeHost } from "../linux-execution/protected-host.ts";
import {
  cleanupUnusedKey,
  enrollmentInput,
  oneActionNative,
  recordPrerunFailure,
  requireUnreserved,
  reserveOne,
  reserveRun,
  validateListeners,
  validatePublic,
  RUNNER_MS,
} from "./product-host-boundary.ts";
const uid = process.geteuid!();
const binding = () => ({
  taskId: "task",
  runId: "run",
  actionId: "action",
  preparationId: randomUUID(),
  connectionId: randomUUID(),
  originalEpoch: 1,
  authorityGeneration: 1,
  profileDigest: "1".repeat(64),
  intentDigest: "2".repeat(64),
  operationFingerprint: "3".repeat(64),
  nodeId: "node",
  providerId: "command",
  enforcementKeyId: "enforcer",
  ledgerId: randomUUID(),
});
const route = (b = binding()) => ({
  nodeId: b.nodeId,
  providerId: b.providerId,
  enforcementKeyId: b.enforcementKeyId,
  ledgerId: b.ledgerId,
});
const keys = () =>
  generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
function publicValue() {
  return {
    version: 1 as const,
    route: route(),
    timing: {
      prepareBudgetMs: 30000,
      challengeBudgetMs: 5000,
      runtimeMaxMs: 50000,
      stopAllowanceMs: 5000,
      clockRateErrorPpm: 1000,
      clockQuantizationMs: 100,
      policyDigest: "e".repeat(64),
    },
    controlIssuer: "control",
    controlKid: "control-key",
    enforcementIssuer: "enforcement",
    controlPublicPem: keys().publicKey,
    nodeBundleSha256: "b".repeat(64),
    serverPort: 39195,
  };
}
function root(t: TestContext) {
  const p = realpathSync(mkdtempSync(join(tmpdir(), "ob-host-")));
  t.after(() => rmSync(p, { recursive: true, force: true }));
  return p;
}
function staged(t: TestContext) {
  const path = root(t),
    value = publicValue();
  for (const name of ["secrets", "evidence"]) mkdirSync(join(path, name), { mode: 0o700 });
  const stage = { version: 1, route: value.route };
  exclusive(join(path, "stage-reserved.json"), stage);
  exclusive(join(path, "public.json"), value);
  const write = (name: string, bytes: string) =>
    writeFileSync(join(path, "secrets", name), bytes, { mode: 0o600 });
  const pair = keys();
  write("control.pub", value.controlPublicPem);
  write("enforcer.pem", pair.privateKey);
  write("enforcer.pub", pair.publicKey);
  const io = {
    directory: (p: string) => {
      assert(p === path || p.startsWith(path + "/"));
      assert.equal(lstatSync(p).mode & 0o777, 0o700);
      return p;
    },
    readRecord: (p: string) => readRecord(p, uid),
    readBytes: (p: string, max: number) => readBytes(p, max, { uid }),
    requirePeerFree: () => {},
  };
  const runIO = { read: io.readRecord, write: exclusive, now: () => [100, "boot"] as const };
  const cleanup = (v: unknown) => cleanupUnusedKey(path, v, io);
  return { path, value, stage, write, io, runIO, cleanup, key: join(path, "secrets/enforcer.pem") };
}
const refuse = async () => {
  throw new Error("synthetic_preflight_failure");
};
test("first native reservation precedes dispatch; failure and restart never rearm it", async (t) => {
  const path = join(root(t), "once.json"),
    b = binding(),
    calls: unknown[] = [];
  const inner: NativeHost = {
    reserve: async (...args) => {
      calls.push(args);
      assert(existsSync(path));
      throw new Error("synthetic failure");
    },
    prepare: async () => {},
    checkAlive: async () => {},
    readiness: async () => {
      throw new Error("unused");
    },
    execute: async () => {},
    lookup: async () => {
      throw new Error("unused");
    },
    stop: async () => {},
  };
  const wrapper = () =>
    oneActionNative(inner, route(b), { bootId: "boot", startedBoottimeMs: 100 }, path, () => [
      200,
      "boot",
    ]);
  const host = wrapper();
  host.instancePath = "original";
  assert.equal(inner.instancePath, "original");
  assert.equal(host.instancePath, "original");
  await assert.rejects(host.reserve(b, {} as never, "instance"), /synthetic failure/);
  await assert.rejects(host.reserve(b, {} as never, "instance"), { code: "EEXIST" });
  await assert.rejects(wrapper().reserve(b, {} as never, "replacement"), { code: "EEXIST" });
  assert.equal(calls.length, 1);
});
for (const field of ["nodeId", "providerId", "enforcementKeyId", "ledgerId"] as const)
  test("changed route refused before reservation: " + field, (t) => {
    const path = join(root(t), "never"),
      b = binding();
    assert.throws(
      () =>
        reserveOne(
          path,
          { ...b, [field]: randomUUID() },
          route(b),
          { bootId: "boot", startedBoottimeMs: 100 },
          () => [200, "boot"],
        ),
      /fixture_route_changed/,
    );
    assert(!existsSync(path));
  });
for (const now of [
  [99, "boot"],
  [70100, "boot"],
  [70101, "boot"],
  [200, "changed"],
] as const)
  test("admission cutoff or reboot refuses " + now.join("/"), (t) => {
    const path = join(root(t), "never"),
      b = binding();
    assert.throws(
      () => reserveOne(path, b, route(b), { bootId: "boot", startedBoottimeMs: 100 }, () => now),
      /fixture_admission_closed/,
    );
    assert(!existsSync(path));
  });
const table = (address: string) => `header\n0: ${address}:991B 00000000:0000 0A rest\n`;
test("single actual IPv4 loopback listener", () =>
  validateListeners(table("0100007F"), "header\n", 39195));
for (const [v4, v6] of [
  [table("00000000"), "header\n"],
  ["header\n", table("0".repeat(32))],
  ["header\n", "header\n"],
  [table("0100007F") + table("0100007F").split("\n")[1] + "\n", "header\n"],
] as const)
  test(
    "missing/wildcard/duplicate/IPv6 listener refuses " + v4.slice(10, 18) + v6.slice(10, 18),
    () => assert.throws(() => validateListeners(v4!, v6!, 39195)),
  );
test("public stage admits the fixed timing and public pin only", () =>
  assert.deepEqual(validatePublic(publicValue()).timing.runtimeMaxMs, 50000));
for (const change of [
  "private",
  "extra_dsn",
  "extra_cookie",
  "bool_port",
  "low_port",
  "bad_hash",
  "long_runtime",
  "roles",
  "rsa",
])
  test("stage input refuses " + change, () => {
    const v: Record<string, unknown> = publicValue();
    if (change === "private") v.controlPublicPem = keys().privateKey;
    if (change.startsWith("extra")) v[change] = "untrusted";
    if (change === "bool_port") v.serverPort = true;
    if (change === "low_port") v.serverPort = 80;
    if (change === "bad_hash") v.nodeBundleSha256 = "wrong";
    if (change === "long_runtime") v.timing = { ...(v.timing as object), runtimeMaxMs: 60000 };
    if (change === "roles") v.enforcementIssuer = v.controlIssuer;
    if (change === "rsa")
      v.controlPublicPem = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      }).publicKey;
    assert.throws(() => validatePublic(v));
  });
test("real locked preflight refusal records failure then removes only proven unused key", async (t) => {
  const f = staged(t);
  await assert.rejects(
    reserveRun(f.path, refuse, f.cleanup, f.runIO),
    /synthetic_preflight_failure/,
  );
  const status = f.io.readRecord(join(f.path, "evidence/pre-run-cleanup.json")) as {
    keyCleanupVerified: boolean;
    errorRecorded: boolean;
  };
  assert(status.keyCleanupVerified && status.errorRecorded);
  assert(!existsSync(f.key));
  assert(!existsSync(join(f.path, "run-reserved.json")));
});
test("failed diagnostic write cannot skip independent key cleanup", (t) => {
  const f = staged(t);
  const value = recordPrerunFailure(f.path, f.stage, new Error("failure"), f.cleanup, () => {
    throw new Error("storage_failed");
  });
  assert(!value.errorRecorded);
  assert(value.keyCleanupVerified);
  assert(!existsSync(f.key));
});
for (const drift of ["route", "control", "pair", "private_mode", "peer", "missing_public"])
  test("unprovable cleanup retains key: " + drift, async (t) => {
    const f = staged(t);
    if (drift === "route")
      writeFileSync(
        join(f.path, "public.json"),
        JSON.stringify({ ...f.value, route: { ...f.value.route, nodeId: "other" } }),
      );
    if (drift === "control") f.write("control.pub", "changed");
    if (drift === "pair") f.write("enforcer.pub", keys().publicKey);
    if (drift === "private_mode") chmodSync(f.key, 0o644);
    if (drift === "peer")
      f.io.requirePeerFree = () => {
        throw new Error("fixture_uid_occupied");
      };
    if (drift === "missing_public") unlinkSync(join(f.path, "public.json"));
    await assert.rejects(reserveRun(f.path, refuse, f.cleanup, f.runIO));
    assert(existsSync(f.key));
    const status = f.io.readRecord(join(f.path, "evidence/pre-run-cleanup.json")) as {
      keyCleanupVerified: boolean;
      cleanupUncertain: boolean;
    };
    assert(!status.keyCleanupVerified && status.cleanupUncertain);
  });
for (const name of ["run-reserved.json", "single-action.json"])
  for (const link of [false, true])
    test("existing run/action refuses before cleanup: " + name + link, async (t) => {
      const f = staged(t);
      if (link) symlinkSync(join(f.path, "missing"), join(f.path, name));
      else exclusive(join(f.path, name), {});
      let calls = 0;
      await assert.rejects(
        reserveRun(
          f.path,
          async () => calls++,
          () => {
            calls++;
          },
          f.runIO,
        ),
        /already_reserved/,
      );
      assert.equal(calls, 0);
      assert(existsSync(f.key));
      assert.deepEqual(readdirSync(join(f.path, "evidence")), []);
    });
for (const written of [false, true])
  test("uncertain reservation attempt never triggers unused-key cleanup: " + written, async (t) => {
    const f = staged(t);
    let cleaned = false;
    await assert.rejects(
      reserveRun(
        f.path,
        async () => "ready",
        () => {
          cleaned = true;
        },
        {
          ...f.runIO,
          write: (path, value) => {
            if (written) exclusive(path, value);
            throw new Error("uncertain_write");
          },
        },
      ),
      /uncertain_write/,
    );
    assert(!cleaned);
    assert(existsSync(f.key));
    assert.equal(existsSync(join(f.path, "run-reserved.json")), written);
    assert.deepEqual(readdirSync(join(f.path, "evidence")), []);
  });
test("real lock conflict is nonblocking and never cleans another attempt", async (t) => {
  const f = staged(t),
    fd = openSync(join(f.path, "stage-reserved.json"), "r");
  try {
    await exclusiveLock(fd, 0);
    let calls = 0;
    await assert.rejects(
      reserveRun(
        f.path,
        async () => calls++,
        () => {
          calls++;
        },
        f.runIO,
      ),
      /lock unavailable/,
    );
    assert.equal(calls, 0);
    assert(existsSync(f.key));
  } finally {
    closeSync(fd);
  }
});
test("real lock remains held through cleanup and releases afterward", async (t) => {
  const f = staged(t);
  let proof: Promise<void> | undefined;
  f.io.requirePeerFree = () => {
    const fd = openSync(join(f.path, "stage-reserved.json"), "r");
    proof = assert.rejects(exclusiveLock(fd, 0), /lock unavailable/).finally(() => closeSync(fd));
  };
  await assert.rejects(reserveRun(f.path, refuse, f.cleanup, f.runIO));
  await proof;
  const fd = openSync(join(f.path, "stage-reserved.json"), "r");
  try {
    await exclusiveLock(fd, 0);
  } finally {
    closeSync(fd);
  }
  assert(!existsSync(f.key));
});
test("raw enrollment and key text never enter failure records", async (t) => {
  const f = staged(t),
    secret = "obenr_" + "A".repeat(43);
  await assert.rejects(
    reserveRun(
      f.path,
      async () => {
        throw new Error(secret + " -----BEGIN PRIVATE KEY-----");
      },
      f.cleanup,
      f.runIO,
    ),
    /^Error: fixture_failed$/,
  );
  const records = readdirSync(join(f.path, "evidence"))
    .map((n) => readFileSync(join(f.path, "evidence", n), "utf8"))
    .join("");
  assert(!records.includes(secret));
  assert(!records.includes("PRIVATE KEY"));
});
for (const mode of ["valid", "bound", "oversize", "duplicate", "malformed", "token"])
  test("bounded enrollment stdin: " + mode, () => {
    const token = "obenr_" + "A".repeat(43);
    let text = JSON.stringify({ version: 1, enrollmentToken: token });
    if (mode === "bound" || mode === "oversize")
      text = text.padEnd(mode === "bound" ? 512 : 513, " ");
    if (mode === "duplicate") text = text.replace("{", '{"version":1,');
    if (mode === "malformed") text = text.slice(0, -1);
    if (mode === "token") text = text.replace(token, "invalid");
    if (mode === "valid" || mode === "bound")
      assert.equal(enrollmentInput(Buffer.from(text)).enrollmentToken, token);
    else assert.throws(() => enrollmentInput(Buffer.from(text)));
  });
test("successful preflight consumes one bounded original runner", async (t) => {
  const f = staged(t),
    result = await reserveRun(f.path, async () => "ready", f.cleanup, f.runIO);
  assert.equal(result.prepared, "ready");
  assert.equal(result.guard.maximumMs, RUNNER_MS);
  assert.throws(() => requireUnreserved(f.path));
  assert(existsSync(f.key));
});
