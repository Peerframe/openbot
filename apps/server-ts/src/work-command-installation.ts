import { createPublicKey } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { commandPreparationBindingSchema } from "@openbot/protocol";
import { z } from "zod";
import {
  checkCommandBudget,
  commandRouteSchema,
  timingPolicySchema,
  workCommandSchema,
} from "./work-command-contract.js";
import { CommandSigner, CommandVerifier } from "./work-command-crypto.js";
import type { CommandInbox } from "./work-command-inbox.js";
import type { WorkCommandProfiles } from "./work-command-profiles.js";
import { strictCommandJson } from "./work-command-values.js";

const identity = commandPreparationBindingSchema.shape.nodeId,
  pathSchema = z.string().min(1).max(4096);
const schema = z
  .object({
    version: z.literal(1),
    route: commandRouteSchema,
    policy: z
      .object({
        id: identity,
        image: workCommandSchema.shape.image,
        limits: workCommandSchema.shape.limits,
      })
      .strict(),
    timing: timingPolicySchema,
    control: z.object({ issuer: identity, keyId: identity, privateKeyPath: pathSchema }).strict(),
    enforcement: z
      .object({ issuer: identity, keyId: identity, publicKeyPath: pathSchema })
      .strict(),
  })
  .strict();
export type WorkCommandConfiguration = Readonly<
  z.infer<typeof schema> & {
    privatePem: string;
    controlPublicPem: string;
    enforcementPublicPem: string;
  }
>;
export type WorkCommandSetup = {
  profiles: WorkCommandProfiles;
  inbox: CommandInbox;
  configuration: WorkCommandConfiguration;
};
function owned(path: string, privateFile: boolean, maximum: number) {
  if (!isAbsolute(path) || realpathSync(path) !== path)
    throw new Error("command_installation_invalid");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.geteuid?.() ||
      stat.nlink !== 1 ||
      stat.size < 1 ||
      stat.size > maximum ||
      stat.mode & (privateFile ? 0o077 : 0o022)
    )
      throw new Error("command_installation_invalid");
    const bytes = readFileSync(fd);
    if (bytes.length !== stat.size || fstatSync(fd).size !== stat.size)
      throw new Error("command_installation_invalid");
    return bytes;
  } finally {
    closeSync(fd);
  }
}
/** Explicit, owned configuration only. No environment key lookup, route discovery or fallback. */
export function loadWorkCommandConfiguration(path: string): WorkCommandConfiguration {
  try {
    const value = schema.parse(strictCommandJson(owned(path, true, 16384)));
    if (
      value.route.enforcementKeyId !== value.enforcement.keyId ||
      value.control.issuer === value.enforcement.issuer ||
      value.timing.runtimeMaxMs > 50000 ||
      value.timing.stopAllowanceMs !== 5000
    )
      throw new Error();
    checkCommandBudget(value.timing, 1, 300001, value.policy.limits.wallSeconds);
    const privatePem = owned(value.control.privateKeyPath, true, 4096).toString("utf8"),
      enforcementPublicPem = owned(value.enforcement.publicKeyPath, false, 4096).toString("utf8");
    const key = createPublicKey(privatePem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error();
    return {
      ...value,
      privatePem,
      enforcementPublicPem,
      controlPublicPem: key.export({ type: "spki", format: "pem" }).toString(),
    };
  } catch {
    throw new Error("command_installation_invalid");
  }
}
export async function workCommandKeys(config: WorkCommandConfiguration) {
  try {
    const signer = await CommandSigner.create({
      issuer: config.control.issuer,
      kid: config.control.keyId,
      role: "control",
      privatePem: config.privatePem,
    });
    const verifier = await CommandVerifier.create([
      {
        issuer: config.control.issuer,
        kid: config.control.keyId,
        role: "control",
        publicPem: config.controlPublicPem,
      },
      {
        issuer: config.enforcement.issuer,
        kid: config.enforcement.keyId,
        role: "enforcement",
        publicPem: config.enforcementPublicPem,
      },
    ]);
    return { signer, verifier };
  } catch {
    throw new Error("command_installation_invalid");
  }
}
