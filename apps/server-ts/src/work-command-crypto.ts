import { createPublicKey } from "node:crypto";
import { commandPreparationBindingSchema } from "@openbot/protocol";
import { CompactSign, compactVerify, importPKCS8, importSPKI, jwtVerify } from "jose";
import { z } from "zod";
import {
  type CommandClaims,
  type CommandPurpose,
  commandBindingV2Schema,
  commandRoles,
  commandTokenType,
  executionPurpose,
  parseCommandClaims,
  validateCommandTime,
} from "./work-command-contract.js";
import { commandTokenDigest, commandValue, strictCommandJson } from "./work-command-values.js";

const invalid = () => new Error("invalid_command_token");
const identity = commandPreparationBindingSchema.shape.nodeId;
const headerSchema = z
  .object({ alg: z.literal("Ed25519"), typ: z.string(), kid: identity })
  .strict();
const requestSchema = z
  .object({
    requestId: commandPreparationBindingSchema.shape.preparationId,
    nonce: z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
  })
  .strict();
type Role = "control" | "enforcement";
export type CommandVerificationPin = Readonly<{
  issuer: string;
  kid: string;
  role: Role;
  publicPem: string;
}>;
function pem(value: string) {
  if (typeof value !== "string" || Buffer.byteLength(value) < 32 || Buffer.byteLength(value) > 4096)
    throw invalid();
  return value;
}
function segment(value: string, maximum: number) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  const raw = Buffer.from(value, "base64url");
  if (raw.length > maximum || raw.toString("base64url") !== value) throw invalid();
  return raw;
}
function parts(token: string) {
  if (
    typeof token !== "string" ||
    token.length > 8192 ||
    [...token].some((character) => character.charCodeAt(0) > 127)
  )
    throw invalid();
  const values = token.split(".");
  if (values.length !== 3 || segment(values[2]!, 64).length !== 64) throw invalid();
  const payloadBytes = segment(values[1]!, 8192);
  return {
    header: headerSchema.parse(strictCommandJson(segment(values[0]!, 512), 512)),
    payload: strictCommandJson(payloadBytes, 8192),
    payloadBytes,
  };
}
/** Correlation only. Callers must verify the pinned signature before trusting any field. */
export function unverifiedCommandPayload(token: string): Record<string, unknown> {
  try {
    const value = parts(token).payload;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
    return value as Record<string, unknown>;
  } catch {
    throw invalid();
  }
}
/** The retained JOSE adapter uses fixed local keys, a pinned algorithm and exact role/purpose types.
 * A verified signature remains input to the SQL authority checks, never permission to execute. */
export class CommandSigner {
  private constructor(
    readonly issuer: string,
    readonly kid: string,
    readonly role: Role,
    private readonly key: CryptoKey,
  ) {}
  static async create(options: { issuer: string; kid: string; role: Role; privatePem: string }) {
    try {
      const issuer = identity.parse(options.issuer),
        kid = identity.parse(options.kid);
      if (!["control", "enforcement"].includes(options.role)) throw invalid();
      const key = await importPKCS8(pem(options.privatePem), "Ed25519");
      if (key.type !== "private" || key.algorithm.name !== "Ed25519") throw invalid();
      return new CommandSigner(issuer, kid, options.role, key);
    } catch {
      throw invalid();
    }
  }
  async sign<P extends CommandPurpose>(purpose: P, value: unknown, nowMs?: number) {
    try {
      if (commandRoles[purpose] !== this.role) throw invalid();
      const claims = await parseCommandClaims(purpose, value);
      if (executionPurpose(purpose)) validateCommandTime(claims, nowMs!);
      if (
        claims.iss !== this.issuer ||
        (this.role === "enforcement" && claims.enforcementKeyId !== this.kid)
      )
        throw invalid();
      const token = await new CompactSign(commandValue(claims, 8192))
        .setProtectedHeader({ alg: "Ed25519", typ: commandTokenType(purpose), kid: this.kid })
        .sign(this.key);
      parts(token);
      return token;
    } catch {
      throw invalid();
    }
  }
}
type LoadedPin = Readonly<{ issuer: string; kid: string; role: Role; key: CryptoKey }>;
export class CommandVerifier {
  private constructor(private readonly pins: ReadonlyMap<string, LoadedPin>) {}
  static async create(input: readonly CommandVerificationPin[]) {
    try {
      if (!Array.isArray(input) || input.length < 1 || input.length > 16) throw invalid();
      const pins = new Map<string, LoadedPin>(),
        roles = new Map<string, Role>();
      for (const value of input) {
        const issuer = identity.parse(value.issuer),
          kid = identity.parse(value.kid),
          role = value.role;
        const name = JSON.stringify([issuer, kid]);
        if (!["control", "enforcement"].includes(role) || pins.has(name)) throw invalid();
        const publicPem = pem(value.publicPem),
          key = await importSPKI(publicPem, "Ed25519");
        if (key.type !== "public" || key.algorithm.name !== "Ed25519") throw invalid();
        const keyIdentity = createPublicKey(publicPem)
          .export({ type: "spki", format: "der" })
          .toString("hex");
        if (roles.has(keyIdentity) && roles.get(keyIdentity) !== role) throw invalid();
        roles.set(keyIdentity, role);
        pins.set(name, Object.freeze({ issuer, kid, role, key }));
      }
      return new CommandVerifier(pins);
    } catch {
      throw invalid();
    }
  }
  async verify<P extends CommandPurpose>(
    token: string,
    options: {
      purpose: P;
      issuer: string;
      audience: string;
      binding: unknown;
      request?: { requestId: string; nonce: string };
      nowMs?: number;
    },
  ): Promise<CommandClaims<P>> {
    return (await this.verifyRecord(token, options)).value;
  }
  async verifyRecord<P extends CommandPurpose>(
    token: string,
    options: {
      purpose: P;
      issuer: string;
      audience: string;
      binding: unknown;
      request?: { requestId: string; nonce: string };
      nowMs?: number;
    },
  ): Promise<{ value: CommandClaims<P>; digest: string }> {
    try {
      const { purpose } = options,
        issuer = identity.parse(options.issuer),
        audience = identity.parse(options.audience);
      const binding = (
        executionPurpose(purpose) ? commandBindingV2Schema : commandPreparationBindingSchema
      ).parse(options.binding);
      const { header, payload, payloadBytes } = parts(token);
      if (header.typ !== commandTokenType(purpose)) throw invalid();
      const pin = this.pins.get(JSON.stringify([issuer, header.kid]));
      if (!pin || pin.role !== commandRoles[purpose]) throw invalid();
      // JOSE validates the signature (and registered JWT claims for execution messages). No
      // resolver, JWK endpoint, KeySet or key obtained from an incoming frame reaches this call.
      if (executionPurpose(purpose)) {
        if (!Number.isSafeInteger(options.nowMs)) throw invalid();
        await jwtVerify(token, pin.key, {
          algorithms: ["Ed25519"],
          issuer,
          audience,
          typ: header.typ,
          currentDate: new Date(options.nowMs!),
          clockTolerance: 0,
          requiredClaims: ["iss", "aud", "jti", "iat", "nbf", "exp"],
        });
      } else {
        const result = await compactVerify(token, pin.key, { algorithms: ["Ed25519"] });
        if (!Buffer.from(result.payload).equals(payloadBytes)) throw invalid();
      }
      const claims = await parseCommandClaims(purpose, payload);
      if (
        claims.iss !== issuer ||
        claims.aud !== audience ||
        (pin.role === "enforcement" && claims.enforcementKeyId !== pin.kid)
      )
        throw invalid();
      if (Object.entries(binding).some(([key, value]) => Reflect.get(claims, key) !== value))
        throw invalid();
      if (purpose === "work_command_dispatch") {
        if (options.request !== undefined) throw invalid();
      } else {
        const request = requestSchema.parse(options.request);
        if (
          !("requestId" in claims) ||
          claims.requestId !== request.requestId ||
          claims.nonce !== request.nonce
        )
          throw invalid();
      }
      if (executionPurpose(purpose)) validateCommandTime(claims, options.nowMs!);
      return { value: claims, digest: commandTokenDigest(token) };
    } catch {
      throw invalid();
    }
  }
}
