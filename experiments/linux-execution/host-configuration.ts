/** Loads only root-private Host configuration and local pinned keys; no wire path resolution. */
import { lstatSync } from "node:fs";
import { basename, dirname, isAbsolute, relative } from "node:path";
import { z } from "zod";
import {
  commandRouteSchema,
  timingPolicySchema,
} from "../../apps/server/dist/work-command-contract.js";
import { CommandSigner, CommandVerifier } from "../../apps/server/dist/work-command-crypto.js";
import { directory, readBytes, readRecord, requireFact } from "./protected-io.ts";
import type { HostConfiguration } from "./protected-host.ts";
import type { NativeConfiguration } from "./native-config.ts";
const path = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => isAbsolute(p) && !/[\0\r\n]/.test(p));
export const hostConfigurationSchema = z
  .object({
    state: path,
    socket: path,
    nodeUid: z.number().int().positive().max(2147483647),
    nodeGid: z.number().int().positive().max(2147483647),
    route: commandRouteSchema,
    policy: timingPolicySchema,
    controlIssuer: z.string().min(1).max(128),
    enforcementIssuer: z.string().min(1).max(128),
    native: z.record(z.string(), z.unknown()),
    privateKey: path,
    controlPins: z
      .array(z.object({ kid: z.string().min(1).max(128), path }).strict())
      .min(1)
      .max(8),
  })
  .strict();
export async function loadHostConfiguration(
  file: string,
): Promise<HostConfiguration & { native: NativeConfiguration }> {
  requireFact(process.platform === "linux" && process.geteuid?.() === 0, "linux_root_required");
  directory(dirname(file));
  const v = await hostConfigurationSchema.parseAsync(readRecord(file));
  directory(v.state);
  directory(dirname(v.socket), 0, false);
  const socketDirectory = lstatSync(dirname(v.socket));
  requireFact(
    socketDirectory.gid === v.nodeGid &&
      (socketDirectory.mode & 0o777) === 0o750 &&
      basename(v.socket) === "command.sock" &&
      Buffer.byteLength(v.socket) <= 107,
    "unsafe_socket_directory",
  );
  try {
    lstatSync(v.socket);
    throw new Error("socket_exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  directory(dirname(v.privateKey));
  const separation = relative(dirname(v.privateKey), v.state);
  requireFact(
    dirname(v.privateKey) === v.native.secretsDirectory &&
      (separation === ".." || separation.startsWith("../") || isAbsolute(separation)),
    "unsafe_secret_scope",
  );
  requireFact(
    v.policy.runtimeMaxMs <= 50000 && v.policy.stopAllowanceMs === 5000,
    "unqualified_timing",
  );
  const pins = v.controlPins.map((pin) => {
    directory(dirname(pin.path));
    return {
      issuer: v.controlIssuer,
      kid: pin.kid,
      role: "control" as const,
      publicPem: new TextDecoder("utf8", { fatal: true }).decode(readBytes(pin.path, 16384)),
    };
  });
  const signer = await CommandSigner.create({
      issuer: v.enforcementIssuer,
      kid: v.route.enforcementKeyId,
      role: "enforcement",
      privatePem: new TextDecoder("utf8", { fatal: true }).decode(readBytes(v.privateKey, 16384)),
    }),
    verifier = await CommandVerifier.create(pins);
  return {
    state: v.state,
    socketPath: v.socket,
    nodeUid: v.nodeUid,
    nodeGid: v.nodeGid,
    route: v.route,
    policy: v.policy,
    controlIssuer: v.controlIssuer,
    enforcementIssuer: v.enforcementIssuer,
    native: v.native as NativeConfiguration,
    signer,
    verifier,
  };
}
