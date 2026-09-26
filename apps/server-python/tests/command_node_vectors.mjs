// Test-only interoperability probe. It neither consumes permission nor contacts an executor.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const jose = await import(
  process.env.OPENBOT_COMMAND_JOSE_MODULE
    ? pathToFileURL(process.env.OPENBOT_COMMAND_JOSE_MODULE).href
    : "jose"
);
const { default: canonicalize } = await import(
  process.env.OPENBOT_COMMAND_JCS_MODULE
    ? pathToFileURL(process.env.OPENBOT_COMMAND_JCS_MODULE).href
    : "canonicalize"
);
const input = JSON.parse(readFileSync(0, "utf8"));
if (input.mode === "jcs") {
  const canonical = canonicalize(input.operation);
  const fingerprint = createHash("sha256")
    .update("openbot:work-command:operation:v1\0")
    .update(canonical)
    .digest("hex");
  process.stdout.write(JSON.stringify({ canonical, fingerprint }));
} else if (input.mode === "interop") {
  const publicKey = await jose.importSPKI(input.publicPem, "Ed25519");
  const privateKey = await jose.importPKCS8(input.privatePem, "Ed25519");
  const verified = await jose.jwtVerify(input.token, publicKey, {
    algorithms: ["Ed25519"],
    issuer: input.claims.iss,
    audience: input.claims.aud,
    typ: input.header.typ,
    currentDate: new Date(input.nowMs),
    clockTolerance: 0,
    requiredClaims: Object.keys(input.claims),
  });
  const token = await new jose.SignJWT(input.claims)
    .setProtectedHeader(input.header)
    .sign(privateKey);
  process.stdout.write(
    JSON.stringify({ payload: verified.payload, header: verified.protectedHeader, token }),
  );
} else {
  throw new Error("unsupported test mode");
}
