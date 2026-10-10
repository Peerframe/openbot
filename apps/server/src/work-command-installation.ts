/** Validates explicit command routes, reviewed timing policy and locally pinned signing keys. */
import { createPublicKey } from "node:crypto";
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
import { readWorkInstallationFile } from "./work-installation.js";

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
/** Explicit, owned configuration only. No environment key lookup, route discovery or fallback. */
export function loadWorkCommandConfiguration(path: string): WorkCommandConfiguration {
  try {
    const value = schema.parse(strictCommandJson(readWorkInstallationFile(path, true, 16384)));
    if (
      value.route.enforcementKeyId !== value.enforcement.keyId ||
      value.control.issuer === value.enforcement.issuer ||
      value.timing.runtimeMaxMs > 50000 ||
      value.timing.stopAllowanceMs !== 5000
    )
      throw new Error();
    checkCommandBudget(value.timing, 1, 300001, value.policy.limits.wallSeconds);
    const privatePem = readWorkInstallationFile(value.control.privateKeyPath, true, 4096).toString(
        "utf8",
      ),
      enforcementPublicPem = readWorkInstallationFile(
        value.enforcement.publicKeyPath,
        false,
        4096,
      ).toString("utf8");
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
