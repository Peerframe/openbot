/**
 * Local command protocol peer: actual pinned signatures, Unix framing and one-shot state.
 * Native execution and peer identity remain synthetic, as in the previous macOS fixture.
 * The Linux protected Host/runsc qualification remains an independent external gate.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import {
  commandNodeFrameSchema, commandProtocolVersion, commandServerFrameSchema,
  commandPreparationBindingSchema,
} from "../../packages/protocol/dist/index.js";
import { attachJsonTransport } from "../../apps/node/dist/bounded-json-transport.js";
import { CommandSigner, CommandVerifier, unverifiedCommandPayload } from "../../apps/server/dist/work-command-crypto.js";
import {
  commandPreparationBinding, commandExecutionBinding, commandFingerprint,
  type CommandClaims, type CommandOperation, type TimingPolicy,
} from "../../apps/server/dist/work-command-contract.js";
import { commandTokenDigest } from "../../apps/server/dist/work-command-values.js";
import { z } from "zod";
import { HostClock } from "./command-host-clock.ts";

type CommandPreparationBinding = z.infer<typeof commandPreparationBindingSchema>;
type RecordOf<P extends Parameters<CommandSigner["sign"]>[0]> = { value: CommandClaims<P>; digest: string };
export const commandCsv = Buffer.from("label,value\nalpha,12\nbeta,8\ngamma,5\n");
export const commandArguments = {
  argv: ["/bin/cp", "/input/input-01", "/output/result.csv"],
  output: { name: "result.csv", mediaType: "text/csv", maxBytes: 65536 },
};
export async function startCommandHost(options: {
  directory: string; route: { nodeId: string; providerId: string; enforcementKeyId: string; ledgerId: string };
  timing: TimingPolicy; controlPublic: string; enforcerPrivate: string; lost?: boolean;
}) {
  const signer = await CommandSigner.create({ issuer: "product-enforcer", kid: options.route.enforcementKeyId, role: "enforcement", privatePem: options.enforcerPrivate });
  const verifier = await CommandVerifier.create([{ issuer: "product-control", kid: "product-control-key", role: "control", publicPem: options.controlPublic }]);
  const boot = randomUUID(), instance = randomUUID();
  const clock = () => { const stamp = Number(process.hrtime.bigint() / 1000n); return [stamp, stamp, boot] as const; };
  const newClock = (request?: string) => new HostClock(options.timing, clock, request);
  const calls: string[] = [];
  let error: string | null = null, connection: Socket | undefined;
  let binding: CommandPreparationBinding | undefined, prepare: HostClock | undefined;
  let challengeDigest: string | undefined, readinessDigest: string | undefined;
  let authorization: RecordOf<"work_command_prepare_authorize"> | undefined;
  let dispatch: RecordOf<"work_command_dispatch"> | undefined, operation: CommandOperation | undefined;
  let consume: HostClock | undefined, consumeDigest: string | undefined, permitDigest: string | undefined;
  let input = Buffer.alloc(0), outputOffset: number | undefined, sequence = 0;
  const controls = new Map<string, { clock: HostClock; digest: string; operation: "lookup" | "stop"; value?: CommandClaims<"work_command_control_request"> }>();
  const finished = new Set<string>();
  const exclusive = async (name: string, value: unknown) => writeFile(join(options.directory, name), JSON.stringify(value), { flag: "wx", mode: 0o600 });
  const base = (b: CommandPreparationBinding, c: HostClock) => ({ ...b, version: 2, iss: signer.issuer, aud: "product-control", jti: randomUUID(), requestId: c.requestId, nonce: c.nonce });
  const challenge = async (b: CommandPreparationBinding, c: HostClock, kind: "prepare" | "lookup" | "stop") => {
    const purpose = kind === "prepare" ? "work_command_prepare_challenge" : "work_command_control_challenge";
    return signer.sign(purpose, { ...base(b, c), purpose, bootId: boot, enforcerInstanceId: instance, createdBoottimeUs: c.start[1], expiresBoottimeUs: c.start[1] + options.timing.challengeBudgetMs * 1000, ...(kind === "prepare" ? {} : { operation: kind }) });
  };
  await mkdir(options.directory, { recursive: false, mode: 0o700 });
  const socketPath = join(options.directory, "command.sock");
  const server = createServer((socket) => {
    if (connection) { socket.destroy(); return; }
    connection = socket;
    socket.setTimeout(60000, () => socket.destroy());
    const transport = attachJsonTransport(socket, {
      async onMessage(raw) {
        try {
          const f = await commandServerFrameSchema.parseAsync(raw);
          assert.equal(f.nodeId, options.route.nodeId);
          const send = async (type: string, payload: unknown, requestId = f.requestId) => {
            await transport.send(await commandNodeFrameSchema.parseAsync({ type, payload, requestId, nodeId: f.nodeId, preparationId: f.preparationId, protocolVersion: commandProtocolVersion }));
          };
          const correlate = (b: CommandPreparationBinding) => {
            assert.equal(f.nodeId, b.nodeId); assert.equal(f.preparationId, b.preparationId);
            for (const [key, value] of Object.entries(options.route)) assert.equal(Reflect.get(b, key), value);
          };
          const finish = () => { controls.delete(f.requestId); finished.add(f.requestId); };
          const ready = async () => {
            assert(binding && prepare && authorization);
            if (input.length !== authorization.value.staging.inputManifest.reduce((n, e) => n + e.size, 0)) return;
            assert.deepEqual(input, commandCsv);
            assert.equal(createHash("sha256").update(input).digest("hex"), authorization.value.staging.inputManifest[0]?.sha256);
            await writeFile(join(options.directory, "input-01"), input, { flag: "wx", mode: 0o400 });
            const now = clock(), unit = `openbot-command-${binding.preparationId.replaceAll("-", "")}.service`;
            const token = await signer.sign("work_command_ready", {
              ...base(binding, prepare), purpose: "work_command_ready", authorizationDigest: authorization.digest,
              inputDigest: authorization.value.staging.inputDigest,
              proof: { bootId: boot, enforcerInstanceId: instance, unitName: unit, invocationId: "1".repeat(32), cgroupPath: `/system.slice/${unit}`, cgroupInode: 25, activeMonotonicUs: prepare.start[0], runtimeMaxUs: options.timing.runtimeMaxMs * 1000, observedMonotonicUs: now[0], observedBoottimeUs: now[1], runtimeIdentityDigest: "e".repeat(64), runtimeShapeDigest: "f".repeat(64), timingPolicyDigest: options.timing.policyDigest, startAttempts: 0 },
            });
            readinessDigest = commandTokenDigest(token); calls.push("readiness");
            await send("work.command.ready", { token }, binding.preparationId);
          };
          if (f.type === "work.command.prepare_open") {
            assert(!binding, "original already reserved"); binding = f.payload; correlate(binding);
            prepare = newClock(binding.preparationId);
            const token = await challenge(binding, prepare, "prepare"); challengeDigest = commandTokenDigest(token);
            await send("work.command.prepare_challenge", { token }); return;
          }
          assert(binding, "no original preparation"); correlate(binding);
          if (f.type === "work.command.control_open") {
            assert.deepEqual(f.payload.binding, binding);
            assert(!controls.has(f.requestId) && !finished.has(f.requestId) && finished.size + controls.size < 4096, "control replayed");
            const c = newClock(f.requestId), token = await challenge(binding, c, f.payload.operation);
            controls.set(f.requestId, { clock: c, digest: commandTokenDigest(token), operation: f.payload.operation });
            await send("work.command.control_challenge", { token }); return;
          }
          if (f.type === "work.command.lookup" || f.type === "work.command.stop") {
            const control = controls.get(f.requestId); assert(control && !control.value);
            const record = await verifier.verifyRecord(f.payload.token, { purpose: "work_command_control_request", issuer: "product-control", audience: signer.issuer, binding, request: { requestId: control.clock.requestId, nonce: control.clock.nonce } });
            assert.equal(record.value.challengeDigest, control.digest); assert.equal(record.value.operation, control.operation);
            control.clock.accept(record.value.issuedAtMs, true); control.value = record.value;
            assert(control.clock.interval().upper < record.value.expiresAtMs);
            if (record.value.operation === "stop") { assert.equal(f.type, "work.command.stop"); calls.push("stop"); finish(); return; }
            assert.equal(f.type, "work.command.lookup"); assert(dispatch && operation && permitDigest);
            assert.deepEqual(record.value.dispatch, commandExecutionBinding(dispatch.value));
            assert.equal(calls.filter((c) => c === "execute").length, 1);
            if (options.lost) { calls.push("lookup_lost"); error = "EOFError"; transport.close(); return; }
            calls.push("lookup"); sequence++;
            const include = record.value.includeOutput, now = control.clock.interval(), iat = Math.floor(now.lower / 1000);
            const value = { ...commandExecutionBinding(dispatch.value), ...base(binding, control.clock), purpose: "work_command_receipt", iat, nbf: iat, exp: Math.min(iat + 30, Math.floor(record.value.expiresAtMs / 1000)), permitDigest,
              observation: { phase: "exited", containerId: "d".repeat(64), startAttempts: 1, exitCode: 0, sequence, runtimeShapeDigest: "f".repeat(64), outputs: include ? [{ name: operation.command.output.name, mediaType: operation.command.output.mediaType, sizeBytes: commandCsv.length, sha256: createHash("sha256").update(commandCsv).digest("hex") }] : [], truncated: false } };
            const token = await signer.sign("work_command_receipt", value, now.lower);
            const verified = await import("../../apps/server/dist/work-command-contract.js").then((m) => m.parseCommandClaims("work_command_receipt", value)); control.clock.check(verified);
            await send("work.command.lookup_result", { token });
            if (include) { assert(outputOffset === undefined); outputOffset = commandCsv.length; await send("work.command.output_chunk", { fileIndex: 0, offset: 0, data: commandCsv.toString("base64") }); }
            else finish(); return;
          }
          if (f.type === "work.command.output_ack") {
            const c = controls.get(f.requestId); assert(c?.value?.operation === "lookup" && c.value.includeOutput);
            assert(c.clock.interval().upper < c.value.expiresAtMs); assert.equal(f.payload.nextOffset, outputOffset); outputOffset = undefined; finish(); return;
          }
          assert(prepare);
          if (f.type === "work.command.prepare_authorize") {
            assert(!authorization);
            authorization = await verifier.verifyRecord(f.payload.token, { purpose: "work_command_prepare_authorize", issuer: "product-control", audience: signer.issuer, binding, request: { requestId: prepare.requestId, nonce: prepare.nonce } });
            assert.equal(authorization.value.challengeDigest, challengeDigest); assert.deepEqual(authorization.value.timing, options.timing);
            prepare.accept(authorization.value.issuedAtMs, true);
            assert.equal(authorization.value.staging.inputManifest.length, 1); assert.equal(authorization.value.staging.inputManifest[0]?.path, "input-01");
            await exclusive("original.json", { binding, authorizationDigest: authorization.digest }); calls.push("reserve", "prepare"); await ready(); return;
          }
          if (f.type === "work.command.input_chunk") {
            assert(authorization && !readinessDigest); prepare.interval(); assert.equal(f.requestId, binding.preparationId); assert.equal(f.payload.fileIndex, 0); assert.equal(f.payload.offset, input.length);
            const data = Buffer.from(f.payload.data, "base64"); assert(data.length > 0 && data.length <= 16384);
            assert(input.length + data.length <= authorization.value.staging.inputManifest[0]!.size);
            input = Buffer.concat([input, data]); await send("work.command.input_ack", { fileIndex: 0, nextOffset: input.length }); await ready(); return;
          }
          if (f.type === "work.command.dispatch") {
            assert(authorization && readinessDigest && !dispatch);
            const untrusted = unverifiedCommandPayload(f.payload.ticket);
            const candidateBinding = commandExecutionBinding(untrusted as unknown as CommandClaims<"work_command_dispatch">);
            // The caller's timestamp only selects a JWT check instant. Signature verification and
            // exact causal binding precede adoption as an interval anchor and any native effect.
            const anchors = untrusted.anchors as { admittedAtMs: number };
            dispatch = await verifier.verifyRecord(f.payload.ticket, { purpose: "work_command_dispatch", issuer: "product-control", audience: signer.issuer, binding: candidateBinding, nowMs: anchors.admittedAtMs });
            assert.deepEqual(commandPreparationBinding(dispatch.value), binding); assert.equal(dispatch.value.readinessDigest, readinessDigest); assert.equal(dispatch.value.anchors.rootDeadlineMs, authorization.value.rootDeadlineMs); assert.equal(f.requestId, dispatch.value.dispatchId);
            const launchClock = new HostClock(options.timing, clock, undefined, prepare.start);
            // Re-use the original challenge origin; response arrival is measured by the live clock.
            launchClock.accept(dispatch.value.anchors.admittedAtMs); launchClock.check(dispatch.value);
            operation = f.payload.operation; assert.equal(await commandFingerprint(operation), binding.operationFingerprint);
            assert.deepEqual(operation.command, { ...authorization.value.staging, argv: commandArguments.argv });
            await exclusive("dispatch.json", { binding: candidateBinding, operation, digest: dispatch.digest });
            consume = newClock(); const interval = launchClock.interval(), iat = Math.floor(interval.lower / 1000);
            const token = await signer.sign("work_command_consume", { ...candidateBinding, ...base(binding, consume), purpose: "work_command_consume", iat, nbf: iat, exp: Math.min(iat + 30, Math.floor(candidateBinding.hardDeadlineMs / 1000)), ticketDigest: dispatch.digest }, interval.lower);
            consumeDigest = commandTokenDigest(token); await send("work.command.consume", { token }, consume.requestId); return;
          }
          if (f.type === "work.command.consume_result") {
            assert(consume && dispatch && operation && !permitDigest && f.payload.status === "consumed"); assert.equal(f.requestId, consume.requestId);
            const untrusted = unverifiedCommandPayload(f.payload.permit);
            const permit = await verifier.verifyRecord(f.payload.permit, { purpose: "work_command_permit", issuer: "product-control", audience: signer.issuer, binding: commandExecutionBinding(dispatch.value), request: { requestId: consume.requestId, nonce: consume.nonce }, nowMs: untrusted.consumedAtMs as number });
            assert.equal(permit.value.requestDigest, consumeDigest); consume.accept(permit.value.consumedAtMs); consume.check(permit.value);
            assert.deepEqual(await readFile(join(options.directory, "input-01")), commandCsv); assert(!calls.includes("execute"));
            await exclusive("permit.json", { digest: permit.digest }); permitDigest = permit.digest; calls.push("execute"); return;
          }
          throw new Error("unsupported frame");
        } catch (failure) { error = failure instanceof Error ? failure.message : "Host refused"; throw failure; }
      },
    });
  });
  server.listen(socketPath); await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  return { socketPath, state: () => ({ calls: [...calls], error }), async close() { connection?.destroy(); await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); } };
}
