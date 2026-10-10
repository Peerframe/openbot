/** Complete signed flows with synthetic native execution; real kernel/runsc qualification is separate. */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer, connect, type Socket } from "node:net";
import koffi from "koffi";
import { UnixService } from "./host-service.ts";
import { send, receive } from "./protected-io.ts";
import { peerUid } from "./kernel-facts.ts";
import { commandNodeFrameSchema } from "../../packages/protocol/dist/index.js";
import { test, type TestContext } from "node:test";
import {
  CommandSigner,
  CommandVerifier,
  unverifiedCommandPayload,
} from "../../apps/server/dist/work-command-crypto.js";
import {
  commandFingerprint,
  type CommandOperation,
  type CommandBindingV2,
  type CommandClaims,
} from "../../apps/server/dist/work-command-contract.js";
import { commandValue, commandTokenDigest } from "../../apps/server/dist/work-command-values.js";
import compatibility from "../../scripts/integration/fixtures/command-compatibility.json" with {
  type: "json",
};
import {
  Host,
  type NativeHost,
  type NativeRecord,
  type HostConfiguration,
} from "./protected-host.ts";
import { Inputs } from "./host-inputs.ts";
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
async function key(issuer: string, kid: string, role: "control" | "enforcement") {
  const pair = generateKeyPairSync("ed25519"),
    privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    signer: await CommandSigner.create({ issuer, kid, role, privatePem }),
    pin: { issuer, kid, role, publicPem },
  };
}
async function fixture(t: TestContext, input = Buffer.alloc(0)) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "obh-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state"),
    work = join(root, "native");
  mkdirSync(state);
  mkdirSync(work);
  const cp = await key("control", "control-1", "control"),
    ep = await key("enforcer", "enforcement-key", "enforcement"),
    clock = {
      now: 100000000,
      boot: randomUUID(),
      step(ms: number) {
        this.now += ms * 1000;
      },
    },
    sample = () => [clock.now, clock.now, clock.boot] as const;
  const policy = {
    prepareBudgetMs: 30000,
    challengeBudgetMs: 5000,
    runtimeMaxMs: 50000,
    stopAllowanceMs: 5000,
    clockRateErrorPpm: 1000,
    clockQuantizationMs: 100,
    policyDigest: "e".repeat(64),
  };
  const operation = structuredClone(
    compatibility.fingerprints.positive[0]!.operation,
  ) as CommandOperation;
  operation.command.argv = ["/bin/cp", "/input/input.csv", "/output/result.csv"];
  operation.command.inputManifest = input.length
    ? [{ path: "input.csv", size: input.length, sha256: hash(input) }]
    : [];
  operation.command.inputDigest = "sha256:" + hash(commandValue(operation.command.inputManifest));
  const binding = {
    taskId: operation.taskId,
    runId: operation.runId,
    actionId: operation.actionId,
    preparationId: randomUUID(),
    connectionId: randomUUID(),
    originalEpoch: operation.originalEpoch,
    authorityGeneration: operation.authorityGeneration,
    profileDigest: operation.profileDigest,
    intentDigest: operation.intentDigest,
    operationFingerprint: await commandFingerprint(operation),
    ...operation.route,
  };
  const calls: string[] = [],
    nativeState = { data: Buffer.from("x,y\n"), failExecute: false };
  const native: NativeHost = {
    async reserve(b, _a, instance) {
      calls.push("reserve");
      const root = join(work, b.preparationId);
      mkdirSync(root);
      mkdirSync(join(root, "input"));
      mkdirSync(join(root, "output"));
      return {
        root,
        input: join(root, "input"),
        output: join(root, "output"),
        binding: b,
        instance,
      };
    },
    async prepare() {
      calls.push("prepare");
      clock.step(10);
    },
    async checkAlive() {
      return true;
    },
    async readiness(record) {
      calls.push("readiness");
      const b = record.binding as typeof binding,
        unit = `openbot-command-${b.preparationId.replaceAll("-", "")}.service`;
      return {
        bootId: clock.boot,
        enforcerInstanceId: record.instance as string,
        unitName: unit,
        invocationId: "1".repeat(32),
        cgroupPath: "/system.slice/" + unit,
        cgroupInode: 25,
        activeMonotonicUs: 100000001,
        runtimeMaxUs: 50000000,
        observedMonotonicUs: clock.now,
        observedBoottimeUs: clock.now,
        runtimeIdentityDigest: "e".repeat(64),
        runtimeShapeDigest: "f".repeat(64),
        timingPolicyDigest: policy.policyDigest,
        startAttempts: 0,
      };
    },
    async execute() {
      calls.push("execute");
      if (nativeState.failExecute) throw new Error("native_command_unknown");
    },
    async lookup(_r, op, include) {
      calls.push("lookup");
      const data = include ? nativeState.data : null,
        o = op.command.output;
      return {
        data,
        observation: {
          phase: "exited",
          containerId: "d".repeat(64),
          startAttempts: 1,
          exitCode: 0,
          sequence: 1,
          runtimeShapeDigest: "f".repeat(64),
          outputs: data
            ? [{ name: o.name, mediaType: o.mediaType, sizeBytes: data.length, sha256: hash(data) }]
            : [],
          truncated: false,
        },
      };
    },
    async stop() {
      calls.push("stop");
    },
  };
  const verifier = await CommandVerifier.create([cp.pin, ep.pin]),
    config: HostConfiguration = {
      state,
      socketPath: join(root, "s"),
      nodeUid: process.getuid!(),
      nodeGid: process.getgid!(),
      route: operation.route,
      policy,
      controlIssuer: "control",
      enforcementIssuer: "enforcer",
      signer: ep.signer,
      verifier,
    };
  let host = new Host(config, native, sample);
  let handle: (value: unknown) => Promise<Awaited<ReturnType<Host["handle"]>>> = (value) =>
    host.handle(value);
  t.after(() => host.close());
  let ready = "",
    ticket = "",
    challenge = "",
    dispatchBinding: CommandBindingV2,
    consume: Record<string, unknown>;
  const frame = (kind: string, payload: unknown, request: string = binding.preparationId) => ({
    type: "work.command." + kind,
    protocolVersion: "0.10.0",
    nodeId: binding.nodeId,
    preparationId: binding.preparationId,
    requestId: request,
    payload,
  });
  const token = (results: Awaited<ReturnType<Host["handle"]>>, index = 0) => {
    const payload = results[index]!.payload;
    assert("token" in payload);
    return payload.token;
  };
  return {
    root,
    config,
    native,
    nativeState,
    calls,
    clock,
    policy,
    binding,
    operation,
    frame,
    token,
    verifier,
    get host() {
      return host;
    },
    get dispatchBinding() {
      return dispatchBinding;
    },
    setTransport(value: typeof handle) {
      handle = value;
    },
    restart() {
      host.close();
      host = new Host(config, native, sample);
    },
    async authorize(mutate?: (v: CommandClaims<"work_command_prepare_authorize">) => void) {
      const results = await handle(frame("prepare_open", binding)),
        ch = token(results),
        payload = unverifiedCommandPayload(ch);
      const { argv: _argv, ...staging } = operation.command;
      const grant = {
        ...binding,
        version: 2 as const,
        purpose: "work_command_prepare_authorize" as const,
        iss: "control",
        aud: "enforcer",
        jti: randomUUID(),
        requestId: binding.preparationId,
        nonce: payload.nonce as string,
        challengeDigest: commandTokenDigest(ch),
        issuedAtMs: 1800000000000,
        rootDeadlineMs: 1800000300000,
        timing: policy,
        staging,
      };
      mutate?.(grant);
      const response = await handle(
        frame("prepare_authorize", {
          token: await cp.signer.sign("work_command_prepare_authorize", grant),
        }),
      );
      if (response.length) ready = token(response, response.length - 1);
      return response;
    },
    async input(bytes: Buffer, offset: number) {
      const result = await handle(
        frame("input_chunk", { fileIndex: 0, offset, data: bytes.toString("base64") }),
      );
      if (result.length === 2) ready = token(result, 1);
      return result;
    },
    async dispatch() {
      const stamp = 1800000000100;
      dispatchBinding = {
        ...binding,
        version: 2,
        dispatchId: randomUUID(),
        readinessDigest: commandTokenDigest(ready),
        hardDeadlineMs: 1800000055000,
      };
      const claims = {
        ...dispatchBinding,
        purpose: "work_command_dispatch",
        iss: "control",
        aud: "enforcer",
        jti: randomUUID(),
        iat: Math.floor(stamp / 1000),
        nbf: Math.floor(stamp / 1000),
        exp: Math.floor(stamp / 1000) + 25,
        anchors: {
          admittedAtMs: stamp,
          rootDeadlineMs: 1800000300000,
          nativeDeadlineMs: dispatchBinding.hardDeadlineMs,
          hardDeadlineMs: dispatchBinding.hardDeadlineMs,
          wallSeconds: 60,
          deadlineProfileVersion: 2,
        },
      };
      ticket = await cp.signer.sign("work_command_dispatch", claims, stamp);
      const result = await handle(
        frame("dispatch", { ticket, operation }, dispatchBinding.dispatchId),
      );
      challenge = token(result);
      consume = unverifiedCommandPayload(challenge);
      return result;
    },
    async permit() {
      const stamp = 1800000000200;
      const value = {
        ...dispatchBinding,
        purpose: "work_command_permit",
        iss: "control",
        aud: "enforcer",
        jti: randomUUID(),
        iat: Math.floor(stamp / 1000),
        nbf: Math.floor(stamp / 1000),
        exp: Math.floor((stamp + 5000) / 1000),
        requestId: consume.requestId,
        nonce: consume.nonce,
        requestDigest: commandTokenDigest(challenge),
        consumedAtMs: stamp,
        launchDeadlineMs: stamp + 5000,
      };
      const permit = await cp.signer.sign("work_command_permit", value, stamp);
      return handle(
        frame("consume_result", { status: "consumed", permit }, consume.requestId as string),
      );
    },
    async control(operation: "lookup" | "stop" = "lookup", output = true, delay = 0) {
      const request = randomUUID(),
        ch = token(await handle(frame("control_open", { binding, operation }, request))),
        payload = unverifiedCommandPayload(ch);
      const value = {
        ...binding,
        version: 2,
        purpose: "work_command_control_request",
        iss: "control",
        aud: "enforcer",
        jti: randomUUID(),
        operation,
        requestId: request,
        nonce: payload.nonce,
        challengeDigest: commandTokenDigest(ch),
        issuedAtMs: 1800000000300,
        expiresAtMs: 1800000010300,
        dispatch: dispatchBinding,
        ...(operation === "lookup" ? { includeOutput: output } : { reason: "cancel" }),
      };
      const signedControl = await cp.signer.sign("work_command_control_request", value);
      clock.step(delay);
      return {
        request,
        nonce: payload.nonce as string,
        results: await handle(frame(operation, { token: signedControl }, request)),
      };
    },
  };
}
async function execute(h: Awaited<ReturnType<typeof fixture>>) {
  await h.authorize();
  await h.dispatch();
  await h.permit();
}
test("complete signed flow retains original identity and exactly one execution", async (t) => {
  const h = await fixture(t);
  await execute(h);
  const { request, nonce, results } = await h.control();
  assert.deepEqual(
    results.map((r) => r.type),
    ["work.command.lookup_result", "work.command.output_chunk"],
  );
  assert("data" in results[1]!.payload);
  assert.deepEqual(Buffer.from(results[1]!.payload.data, "base64"), h.nativeState.data);
  const receipt = await h.verifier.verify(h.token(results), {
    purpose: "work_command_receipt",
    issuer: "enforcer",
    audience: "control",
    binding: h.dispatchBinding,
    request: { requestId: request, nonce },
    nowMs: 1800000000300,
  });
  assert.equal(receipt.originalEpoch, h.binding.originalEpoch);
  assert.equal(receipt.observation.exitCode, 0);
  await assert.rejects(h.permit());
  assert.equal(h.calls.filter((c) => c === "execute").length, 1);
});
for (const output of [false, true])
  test(`70 completed lookups release live slots and keep tombstones (output=${output})`, async (t) => {
    const h = await fixture(t);
    await execute(h);
    let first = "";
    for (let i = 0; i < 70; i++) {
      const { request } = await h.control("lookup", output);
      first ||= request;
      if (output)
        await h.host.handle(
          h.frame("output_ack", { fileIndex: 0, nextOffset: h.nativeState.data.length }, request),
        );
      assert(!h.host.controls.has(request));
      assert(h.host.book.finished.has(request));
      assert.equal(h.host.book.pending.size, 1);
    }
    assert.equal(h.host.book.finished.size, 70);
    await assert.rejects(
      h.host.handle(h.frame("control_open", { binding: h.binding, operation: "lookup" }, first)),
    );
    assert.equal(h.calls.filter((c) => c === "execute").length, 1);
  });
test("empty output releases without an impossible chunk acknowledgement", async (t) => {
  const h = await fixture(t);
  h.nativeState.data = Buffer.alloc(0);
  await execute(h);
  const { request, results } = await h.control();
  assert.equal(results.length, 1);
  assert(!h.host.controls.has(request));
  assert(h.host.book.finished.has(request));
  assert.equal(h.host.output.size, 0);
});
test("unknown execution never retries and restart permits only original lookup", async (t) => {
  const h = await fixture(t);
  await h.authorize();
  await h.dispatch();
  h.nativeState.failExecute = true;
  await assert.rejects(h.permit(), /native_command_unknown/);
  await assert.rejects(h.permit(), { code: "EEXIST" });
  h.restart();
  await assert.rejects(
    h.host.handle(h.frame("prepare_open", h.binding)),
    /original_already_reserved/,
  );
  assert.equal((await h.control("lookup", false)).results.length, 1);
  assert.equal(h.calls.filter((c) => c === "execute").length, 1);
  assert.equal(h.calls.filter((c) => c === "prepare").length, 1);
});
for (const change of ["nodeId", "providerId", "ledgerId"] as const)
  test(`changed ${change} refused`, async (t) => {
    const h = await fixture(t);
    h.binding[change] = randomUUID();
    await assert.rejects(h.authorize());
    assert.equal(h.calls.length, 0);
  });
test("second connection cannot reserve another original", async (t) => {
  const h = await fixture(t);
  await h.host.handle(h.frame("prepare_open", h.binding));
  const b = {
    ...h.binding,
    preparationId: randomUUID(),
    connectionId: randomUUID(),
    actionId: "other",
  };
  await assert.rejects(
    h.host.handle({
      ...h.frame("prepare_open", b, b.preparationId),
      preparationId: b.preparationId,
    }),
    /connection_changed/,
  );
});
for (const change of ["operation", "epoch"])
  test(`changed ${change} refuses dispatch`, async (t) => {
    const h = await fixture(t);
    await h.authorize();
    if (change === "operation") h.operation.command.argv = ["echo", "different"];
    else h.operation.originalEpoch++;
    await assert.rejects(h.dispatch());
    assert(!h.calls.includes("execute"));
  });
for (const delay of [5000, 30000])
  test(`late first lookup ${delay} never reads output`, async (t) => {
    const h = await fixture(t);
    await execute(h);
    await assert.rejects(h.control("lookup", true, delay));
    assert(!h.calls.includes("lookup"));
  });
test("each output chunk requires same unexpired lookup", async (t) => {
  const h = await fixture(t);
  await execute(h);
  h.nativeState.data = Buffer.alloc(40000, 120);
  const { request, results } = await h.control();
  assert("data" in results[1]!.payload);
  assert.equal(Buffer.from(results[1]!.payload.data, "base64").length, 16384);
  h.clock.step(10000);
  await assert.rejects(
    h.host.handle(h.frame("output_ack", { fileIndex: 0, nextOffset: 16384 }, request)),
    /scope_or_expiry/,
  );
});
test("stop cannot grant output and completed controls cannot replay", async (t) => {
  const h = await fixture(t);
  await execute(h);
  await h.control("stop");
  assert.equal(h.calls.at(-1), "stop");
  const { request, results } = await h.control("lookup", false);
  assert.equal(results.length, 1);
  await assert.rejects(
    h.host.handle(h.frame("output_ack", { fileIndex: 0, nextOffset: 1 }, request)),
  );
});
test("input chunks finish immutable manifest before readiness and launch", async (t) => {
  const bytes = Buffer.alloc(20000, 120),
    h = await fixture(t, bytes);
  assert.deepEqual(await h.authorize(), []);
  assert.equal((await h.input(bytes.subarray(0, 16384), 0)).length, 1);
  assert.equal((await h.input(bytes.subarray(16384), 16384)).length, 2);
  const file = join(h.root, "native", h.binding.preparationId, "input/input.csv");
  assert.deepEqual(readFileSync(file), bytes);
  assert.equal(statSync(file).mode & 0o777, 0o444);
  await assert.rejects(h.input(Buffer.from("x"), 0));
  await h.dispatch();
  await h.permit();
  assert.equal(h.calls.filter((c) => c === "execute").length, 1);
});
test("observation sequence survives protected Host restart", async (t) => {
  const h = await fixture(t);
  await execute(h);
  const first = await h.control("lookup", false);
  assert.equal(
    (unverifiedCommandPayload(h.token(first.results)).observation as { sequence: number }).sequence,
    1,
  );
  h.restart();
  const second = await h.control("lookup", false);
  assert.equal(
    (unverifiedCommandPayload(h.token(second.results)).observation as { sequence: number })
      .sequence,
    2,
  );
});
test("64 live original slots are not evicted", async (t) => {
  const h = await fixture(t);
  for (let i = 0; i < 64; i++) {
    const b = { ...h.binding, actionId: "action" + i, preparationId: randomUUID() };
    await h.host.handle({
      ...h.frame("prepare_open", b, b.preparationId),
      preparationId: b.preparationId,
    });
  }
  await assert.rejects(h.host.handle(h.frame("prepare_open", h.binding)));
  assert.equal(h.host.active.size, 64);
  assert.equal(h.calls.length, 0);
});
for (const change of ["offset", "size", "index", "hash"])
  test(`manifest corruption ${change} refused`, async (t) => {
    const h = await fixture(t),
      path = join(h.root, "inputs");
    mkdirSync(path);
    const input = new Inputs(path, [{ path: "input.csv", size: 4, sha256: hash("abcd") }]);
    try {
      const payload = {
        fileIndex: change === "index" ? 1 : 0,
        offset: change === "offset" ? 1 : 0,
        data: Buffer.from(
          change === "size" ? "abcde" : change === "hash" ? "zzzz" : "abcd",
        ).toString("base64"),
      };
      assert.throws(() => input.append(payload));
    } finally {
      input.close();
    }
  });
test("input symlink never follows or changes outside bytes", async (t) => {
  const h = await fixture(t),
    secret = join(h.root, "secret"),
    path = join(h.root, "inputs");
  mkdirSync(path);
  writeFileSync(secret, "unchanged");
  symlinkSync(secret, join(path, "input.csv"));
  assert.throws(() => new Inputs(path, [{ path: "input.csv", size: 1, sha256: "0".repeat(64) }]), {
    code: "EEXIST",
  });
  assert.equal(readFileSync(secret, "utf8"), "unchanged");
});

// Darwin uses its real local credentials for tests only; it is not a qualified product Host.
function actualLocalPeer(socket: Socket) {
  if (process.platform === "linux") return peerUid(socket);
  assert.equal(process.platform, "darwin");
  const fd = (socket as Socket & { _handle: { fd: number } })._handle.fd,
    uid = new Uint32Array(1),
    gid = new Uint32Array(1),
    get = koffi.load(null).func("int getpeereid(int, _Out_ uint32_t *, _Out_ uint32_t *)");
  assert.equal(get(fd, uid, gid), 0);
  return uid[0]!;
}
test("actual Unix transport carries entire signed flow then closes Host", async (t) => {
  const h = await fixture(t),
    path = join(h.root, "s"),
    service = new UnixService(h.host, actualLocalPeer);
  let complete!: () => void, failure: unknown;
  const done = new Promise<void>((resolve) => (complete = resolve));
  const server = createServer((socket) => {
    void service
      .connection(socket)
      .catch((error) => {
        failure = error;
      })
      .finally(complete);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  const client = connect(path);
  try {
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });
    assert.equal(actualLocalPeer(client), process.getuid!());
    const incoming = receive(client)[Symbol.asyncIterator]();
    h.setTransport(async (value) => {
      const frame = value as { type: string };
      await send(client, value);
      const count =
        frame.type === "work.command.consume_result"
          ? 0
          : frame.type === "work.command.lookup"
            ? 2
            : 1;
      const results: Awaited<ReturnType<Host["handle"]>> = [];
      for (let i = 0; i < count; i++) {
        const next = await incoming.next();
        assert(!next.done);
        results.push(await commandNodeFrameSchema.parseAsync(next.value));
      }
      return results;
    });
    await execute(h);
    const { results } = await h.control();
    assert.equal(results[0]!.type, "work.command.lookup_result");
    assert.equal(results[1]!.type, "work.command.output_chunk");
    assert.equal(h.calls.filter((c) => c === "execute").length, 1);
  } finally {
    client.end();
    await done;
    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.equal(failure, undefined);
  assert(h.host.closed);
});
test("wrong peer is refused before any request", async (t) => {
  const h = await fixture(t),
    socket = new (await import("node:net")).Socket();
  await assert.rejects(
    new UnixService(h.host, () => h.config.nodeUid + 1).connection(socket),
    /peer_refused/,
  );
  assert.equal(h.calls.length, 0);
  assert(h.host.closed);
});
test("uncertain durable reservation blocks all native preparation", async (t) => {
  const h = await fixture(t);
  const original = fs.fsyncSync;
  t.mock.method(fs, "fsyncSync", () => {
    throw new Error("synthetic fsync failure");
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(h.authorize(), /synthetic fsync failure/);
    assert(!h.calls.includes("prepare"));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.equal(fs.fsyncSync, original);
  }
});
