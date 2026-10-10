/** Disposable native product fixture limits; product signature verification remains in Host. */
import { createPrivateKey, createPublicKey } from "node:crypto";
import { lstatSync, unlinkSync, openSync, closeSync, fstatSync, constants } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { z } from "zod";
import { exclusiveLock } from "../../apps/server/dist/posix-files.js";
import { strictCommandJson } from "../../apps/server/dist/work-command-values.js";
import { commandPreparationBindingSchema } from "../../packages/protocol/dist/index.js";
import {
  commandRouteSchema,
  timingPolicySchema,
} from "../../apps/server/dist/work-command-contract.js";
import { nativeClock } from "../linux-execution/kernel-facts.ts";
import {
  directory,
  exclusive,
  fsyncDirectory,
  readBytes,
  readRecord,
  requireFact,
} from "../linux-execution/protected-io.ts";
import type { NativeHost } from "../linux-execution/protected-host.ts";
export const UID = 62425,
  RUNNER_MS = 150000,
  RESERVE_MS = 70000,
  SESSION_MS = 80000;
const identity = commandPreparationBindingSchema.shape.taskId;
const publicSchema = z
  .object({
    version: z.literal(1),
    route: commandRouteSchema,
    timing: timingPolicySchema,
    controlIssuer: identity,
    controlKid: identity,
    enforcementIssuer: identity,
    controlPublicPem: z.string().max(4096),
    nodeBundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
    serverPort: z.number().int().min(1024).max(65535),
  })
  .strict();
export function validatePublic(value: unknown) {
  const v = publicSchema.parse(value);
  requireFact(
    v.timing.runtimeMaxMs === 50000 &&
      v.timing.stopAllowanceMs === 5000 &&
      v.timing.challengeBudgetMs === 5000,
    "unqualified_timing",
  );
  requireFact(v.controlIssuer !== v.enforcementIssuer, "roles_not_distinct");
  requireFact(
    v.controlPublicPem.startsWith("-----BEGIN PUBLIC KEY-----\n") &&
      createPublicKey(v.controlPublicPem).asymmetricKeyType === "ed25519",
    "invalid_public_pin",
  );
  return v;
}
export type PublicFixture = ReturnType<typeof validatePublic>;
export type Guard = { bootId: string; startedBoottimeMs: number };
export function clock(): readonly [number, string] {
  const [, boot, id] = nativeClock();
  return [Math.floor(boot / 1000), id];
}
export function reserveOne(
  path: string,
  value: unknown,
  route: PublicFixture["route"],
  guard: Guard,
  now: () => readonly [number, string] = clock,
) {
  const binding = commandPreparationBindingSchema.parse(value),
    [time, boot] = now();
  requireFact(
    Object.entries(route).every(([k, v]) => binding[k as keyof typeof binding] === v),
    "fixture_route_changed",
  );
  requireFact(
    boot === guard.bootId &&
      time >= guard.startedBoottimeMs &&
      time < guard.startedBoottimeMs + RESERVE_MS,
    "fixture_admission_closed",
  );
  exclusive(path, { binding, bootId: boot, reservedBoottimeMs: time });
  return binding;
}
export function oneActionNative(
  native: NativeHost,
  route: PublicFixture["route"],
  guard: Guard,
  path: string,
  now: () => readonly [number, string] = clock,
): NativeHost {
  return {
    get instancePath() {
      requireFact(typeof native.instancePath === "string", "missing_host_instance");
      return native.instancePath;
    },
    set instancePath(value) {
      native.instancePath = value;
    },
    reserve: async (binding, authorization, instance) => {
      reserveOne(path, binding, route, guard, now);
      return native.reserve(binding, authorization, instance);
    },
    prepare: native.prepare.bind(native),
    checkAlive: native.checkAlive.bind(native),
    readiness: native.readiness.bind(native),
    execute: native.execute.bind(native),
    lookup: native.lookup.bind(native),
    stop: native.stop.bind(native),
  };
}
export function validateListeners(tcp: string, tcp6: string, port: number) {
  const found: [number, string][] = [];
  for (const [family, table] of [
    [4, tcp],
    [6, tcp6],
  ] as const) {
    requireFact(Buffer.byteLength(table) <= 4 * 1024 * 1024, "listener_read_bound");
    for (const line of table.trimEnd().split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      requireFact(
        fields.length >= 4 && /^[A-Fa-f0-9]+:[A-Fa-f0-9]{4}$/.test(fields[1]!),
        "invalid_listener_readback",
      );
      const [address, text] = fields[1]!.split(":");
      if (fields[3] === "0A" && parseInt(text!, 16) === port) found.push([family, address!]);
    }
  }
  requireFact(same(found, [[4, "0100007F"]]), "forward_not_loopback_only");
}
export function requireUnreserved(root: string) {
  for (const name of ["run-reserved.json", "single-action.json"]) {
    try {
      lstatSync(join(root, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error("run_or_action_already_reserved");
  }
}
const keyIO = {
  directory,
  readRecord,
  readBytes,
  requirePeerFree: (): void => {
    throw new Error("peer_check_required");
  },
};
/** Called under the original stage inode lock, before any run reservation attempt. */
export function cleanupUnusedKey(root: string, stage: unknown, io: typeof keyIO) {
  io.directory(root);
  io.directory(join(root, "secrets"));
  requireUnreserved(root);
  const value = validatePublic(io.readRecord(join(root, "public.json")));
  requireFact(same(stage, { version: 1, route: value.route }), "stage_route_changed");
  requireFact(
    io
      .readBytes(join(root, "secrets/control.pub"), 4096)
      .equals(Buffer.from(value.controlPublicPem)),
    "stage_control_changed",
  );
  const path = join(root, "secrets/enforcer.pem"),
    before = lstatSync(path, { bigint: true });
  const key = createPrivateKey(io.readBytes(path, 4096)),
    publicKey = createPublicKey(io.readBytes(join(root, "secrets/enforcer.pub"), 4096));
  requireFact(
    key.asymmetricKeyType === "ed25519" && publicKey.asymmetricKeyType === "ed25519",
    "stage_key_type_changed",
  );
  requireFact(
    createPublicKey(key)
      .export({ format: "der", type: "spki" })
      .equals(publicKey.export({ format: "der", type: "spki" })),
    "stage_key_pair_changed",
  );
  io.requirePeerFree();
  requireUnreserved(root);
  const after = lstatSync(path, { bigint: true });
  requireFact(
    ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(
      (k) => before[k as keyof typeof before] === after[k as keyof typeof after],
    ),
    "stage_key_changed",
  );
  unlinkSync(path);
  fsyncDirectory(join(root, "secrets"));
}
export function safeCode(error: unknown) {
  return error instanceof Error && /^[a-z_]{1,80}$/.test(error.message)
    ? error.message
    : "fixture_failed";
}
/** Independent cleanup still runs if diagnostic persistence fails. Never serialize raw errors. */
export function recordPrerunFailure(
  root: string,
  stage: unknown,
  error: unknown,
  cleanup: (stage: unknown) => void,
  write = exclusive,
) {
  const status = {
    version: 1,
    preRunFailure: true,
    code: safeCode(error),
    errorRecorded: false,
    keyCleanupVerified: false,
    cleanupUncertain: true,
    recordCode: "",
    cleanupCode: "",
    outcomeRecordCode: "",
  };
  try {
    write(join(root, "evidence/pre-run-error.json"), {
      version: 1,
      preRunFailure: true,
      code: status.code,
    });
    status.errorRecorded = true;
  } catch (failure) {
    status.recordCode = safeCode(failure);
  }
  try {
    cleanup(stage);
    status.keyCleanupVerified = true;
    status.cleanupUncertain = false;
  } catch (failure) {
    status.cleanupCode = safeCode(failure);
  }
  try {
    write(join(root, "evidence/pre-run-cleanup.json"), status);
  } catch (failure) {
    status.outcomeRecordCode = safeCode(failure);
  }
  return status;
}

export function enrollmentInput(bytes: Buffer) {
  return z
    .object({
      version: z.literal(1),
      enrollmentToken: z.string().regex(/^obenr_[A-Za-z0-9_-]{43}$/),
    })
    .strict()
    .parse(strictCommandJson(bytes, 512));
}
/** The original immutable stage inode serializes both run admission and unused-key cleanup. */
export async function withStageLock<T>(
  root: string,
  action: (stage: unknown) => Promise<T> | T,
  read = readRecord,
) {
  const path = join(root, "stage-reserved.json"),
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    await exclusiveLock(fd, 0);
    const stage = read(path),
      opened = fstatSync(fd),
      named = lstatSync(path);
    requireFact(opened.dev === named.dev && opened.ino === named.ino, "stage_inode_changed");
    z.object({ version: z.literal(1), route: commandRouteSchema })
      .strict()
      .parse(stage);
    return await action(stage);
  } finally {
    closeSync(fd);
  }
}
/** An attempted reservation is never eligible for unused-key cleanup. */
export async function reserveRun<T>(
  root: string,
  prepare: () => Promise<T>,
  cleanup: (stage: unknown) => void,
  io = { read: readRecord, write: exclusive, now: clock },
) {
  return withStageLock(
    root,
    async (stage) => {
      requireUnreserved(root);
      let prepared: T;
      try {
        prepared = await prepare();
      } catch (error) {
        recordPrerunFailure(root, stage, error, cleanup, io.write);
        throw new Error(safeCode(error));
      }
      const [startedBoottimeMs, bootId] = io.now(),
        guard = { startedBoottimeMs, bootId, maximumMs: RUNNER_MS };
      io.write(join(root, "run-reserved.json"), guard);
      return { prepared, guard };
    },
    io.read,
  );
}
