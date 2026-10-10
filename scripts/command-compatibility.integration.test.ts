/** Frozen synthetic records preserve legacy command signatures without running the retired interpreter. */
import assert from "node:assert/strict";
import { it } from "vitest";
import { CommandSigner, CommandVerifier } from "../apps/server/dist/work-command-crypto.js";
import { commandFingerprint, type CommandPurpose } from "../apps/server/dist/work-command-contract.js";
import fixture from "./integration/fixtures/command-compatibility.json" with { type: "json" };

it("preserves eleven independently verified command records and operation fingerprints", async () => {
  const keys = fixture.keys.map((key) => ({ ...key, role: key.role as "control" | "enforcement" }));
  const verifier = await CommandVerifier.create(keys);
  const signers = new Map(await Promise.all(keys.map(async (key) => [key.issuer, await CommandSigner.create(key)] as const)));
  assert.equal(fixture.provenance.legacyVerifiedTsRecords, fixture.vectors.length);
  for (const vector of fixture.vectors) {
    const options = { ...vector.options, purpose: vector.options.purpose as CommandPurpose };
    assert.deepEqual(await verifier.verify(vector.token, options), vector.value);
    // Ed25519 and the reviewed canonical serializer are deterministic. Exact bytes retain
    // the legacy verifier's recorded acceptance rather than trusting a same-runtime roundtrip.
    assert.equal(await signers.get(options.issuer)!.sign(options.purpose, vector.value, options.nowMs), vector.tsToken);
    await assert.rejects(verifier.verify(vector.token, { ...options, audience: "untrusted" }));
  }
  for (const vector of fixture.fingerprints.positive)
    assert.equal(await commandFingerprint(vector.operation), vector.fingerprint);
});
