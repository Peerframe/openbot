// Test-only interoperability probe. It neither consumes permission nor contacts an executor.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { JWTHeaderParameters, JWTPayload } from "jose";

const FINGERPRINT_PREFIX = "openbot:work-command:operation:v1\0";
const JOSE_EXPORTS = ["importSPKI", "importPKCS8", "jwtVerify", "SignJWT"] as const;

/** The released jose API this probe uses; the Python test may select the module file at run time. */
type JoseApi = Pick<typeof import("jose"), (typeof JOSE_EXPORTS)[number]>;
type Canonicalize = (value: unknown) => string | undefined;
interface CanonicalizeModule {
  readonly default: Canonicalize;
}

type InteropHeader = JWTHeaderParameters;

interface JcsRequest {
  readonly mode: "jcs";
  readonly operation: unknown;
}

interface InteropRequest {
  readonly mode: "interop";
  readonly publicPem: string;
  readonly privatePem: string;
  readonly token: string;
  readonly claims: JWTPayload;
  readonly header: InteropHeader;
  readonly nowMs: number;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJoseApi(value: unknown): value is JoseApi {
  return (
    value !== null &&
    typeof value === "object" &&
    JOSE_EXPORTS.every((name) => typeof Reflect.get(value, name) === "function")
  );
}

function isCanonicalizeModule(value: unknown): value is CanonicalizeModule {
  return (
    value !== null && typeof value === "object" && typeof Reflect.get(value, "default") === "function"
  );
}

/** An explicitly supplied module file, otherwise the workspace's installed package. */
function moduleSpecifier(variable: string, fallback: string): string {
  const path = process.env[variable];
  return path ? pathToFileURL(path).href : fallback;
}

async function loadJose(): Promise<JoseApi> {
  const loaded: unknown = await import(moduleSpecifier("OPENBOT_COMMAND_JOSE_MODULE", "jose"));
  if (!isJoseApi(loaded)) throw new Error("jose module does not provide the expected API");
  return loaded;
}

async function loadCanonicalize(): Promise<Canonicalize> {
  const loaded: unknown = await import(
    moduleSpecifier("OPENBOT_COMMAND_JCS_MODULE", "canonicalize")
  );
  if (!isCanonicalizeModule(loaded)) throw new Error("canonicalize module has no default export");
  return loaded.default;
}

/** Preserve extra claims and headers; jose remains the authority for their JWT semantics. */
function interopClaims(value: unknown): JWTPayload {
  if (!isRecord(value)) throw new Error("invalid interop claims");
  const { iss, aud } = value;
  if (iss !== undefined && typeof iss !== "string") throw new Error("invalid interop issuer");
  if (aud !== undefined && typeof aud !== "string" &&
      !(Array.isArray(aud) && aud.every((entry: unknown) => typeof entry === "string"))) {
    throw new Error("invalid interop audience");
  }
  const claims: JWTPayload = {};
  for (const [key, entry] of Object.entries(value)) claims[key] = entry;
  return claims;
}

function interopHeader(value: unknown): InteropHeader {
  if (!isRecord(value)) throw new Error("invalid interop header");
  const { alg, typ } = value;
  if (typeof alg !== "string" || (typ !== undefined && typeof typ !== "string")) {
    throw new Error("invalid interop header");
  }
  return { ...value, alg, ...(typ === undefined ? {} : { typ }) };
}

function parseRequest(value: unknown): JcsRequest | InteropRequest {
  if (!isRecord(value)) throw new Error("unsupported test mode");
  if (value.mode === "jcs") return { mode: "jcs", operation: value.operation };
  if (value.mode !== "interop") throw new Error("unsupported test mode");
  const { publicPem, privatePem, token, nowMs } = value;
  if (
    typeof publicPem !== "string" ||
    typeof privatePem !== "string" ||
    typeof token !== "string" ||
    typeof nowMs !== "number" ||
    !Number.isFinite(nowMs)
  ) {
    throw new Error("invalid interop input");
  }
  return {
    mode: "interop",
    publicPem,
    privatePem,
    token,
    claims: interopClaims(value.claims),
    header: interopHeader(value.header),
    nowMs,
  };
}

function fingerprint(canonicalize: Canonicalize, operation: unknown) {
  const canonical = canonicalize(operation);
  if (canonical === undefined) throw new Error("operation has no JSON canonical form");
  const digest = createHash("sha256").update(FINGERPRINT_PREFIX).update(canonical).digest("hex");
  return { canonical, fingerprint: digest };
}

/** Verify the Python-issued token, then re-sign the same claims and header for the reverse check. */
async function interoperate(jose: JoseApi, request: InteropRequest) {
  const publicKey = await jose.importSPKI(request.publicPem, "Ed25519");
  const privateKey = await jose.importPKCS8(request.privatePem, "Ed25519");
  const verified = await jose.jwtVerify(request.token, publicKey, {
    algorithms: ["Ed25519"],
    ...(request.claims.iss === undefined ? {} : { issuer: request.claims.iss }),
    ...(request.claims.aud === undefined ? {} : { audience: request.claims.aud }),
    ...(request.header.typ === undefined ? {} : { typ: request.header.typ }),
    currentDate: new Date(request.nowMs),
    clockTolerance: 0,
    requiredClaims: Object.keys(request.claims),
  });
  const token = await new jose.SignJWT(request.claims)
    .setProtectedHeader(request.header)
    .sign(privateKey);
  return { payload: verified.payload, header: verified.protectedHeader, token };
}

const jose = await loadJose();
const canonicalize = await loadCanonicalize();
const request = parseRequest(JSON.parse(readFileSync(0, "utf8")));
const output =
  request.mode === "jcs"
    ? fingerprint(canonicalize, request.operation)
    : await interoperate(jose, request);
process.stdout.write(JSON.stringify(output));
