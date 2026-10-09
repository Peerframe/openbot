import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  type CommandPurpose,
  commandFingerprint,
} from "../apps/server-ts/dist/work-command-contract.js";
import {
  CommandSigner,
  type CommandVerificationPin,
  CommandVerifier,
} from "../apps/server-ts/dist/work-command-crypto.js";

type Vector = {
  value: Record<string, unknown>;
  token: string;
  options: {
    purpose: CommandPurpose;
    issuer: string;
    audience: string;
    binding: unknown;
    request?: { requestId: string; nonce: string };
    nowMs: number;
  };
  tsToken?: string;
};
/** Actual Python/TS cryptographic interoperability, using fresh synthetic keys and native-proof DTOs. */
export async function qualifyCommandInterop(python: string) {
  const script = fileURLToPath(
    new URL("../apps/server-python/tests/command_control_vectors.py", import.meta.url),
  );
  const processOptions = { encoding: "utf8" as const, timeout: 30000, maxBuffer: 2 * 1024 * 1024 };
  const data = JSON.parse(execFileSync(python, ["-I", script, "generate"], processOptions)) as {
    keys: (CommandVerificationPin & { privatePem: string })[];
    vectors: Vector[];
  };
  const verifier = await CommandVerifier.create(data.keys);
  const signers = new Map(
    await Promise.all(
      data.keys.map(async (k) => [k.issuer, await CommandSigner.create(k)] as const),
    ),
  );
  for (const vector of data.vectors) {
    assert.deepEqual(await verifier.verify(vector.token, vector.options), vector.value);
    vector.tsToken = await signers
      .get(vector.options.issuer)!
      .sign(vector.options.purpose, vector.value, vector.options.nowMs);
  }
  assert.deepEqual(
    JSON.parse(
      execFileSync(python, ["-I", script, "verify"], {
        ...processOptions,
        input: JSON.stringify(data),
      }),
    ),
    { verified: data.vectors.length },
  );
  const frozen = JSON.parse(
    await readFile(
      new URL("../apps/server-python/tests/fixtures/work_command_vectors.json", import.meta.url),
      "utf8",
    ),
  );
  for (const vector of frozen.positive)
    assert.equal(await commandFingerprint(vector.operation), vector.fingerprint);
  console.log(
    `[openbot-work] Command Python/TS v2 interoperability: ${data.vectors.length} signed records and ${frozen.positive.length} operation fingerprints passed (synthetic records, no native execution).`,
  );
}
