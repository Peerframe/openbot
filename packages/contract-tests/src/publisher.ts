import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import {
  botResponseSchema,
  controlHttpErrorSchema,
  employeeExportPreviewResponseSchema,
  employeeImportActivationResponseSchema,
  employeeImportPreviewResponseSchema,
  employeeProfileResponseSchema,
  employeeSkillMutationSchema,
  portableEnvelopeHttpSchema,
  portablePackageHttpSchema,
  portabilityHttpOperations,
} from "@openbot/protocol";
import { contractClient } from "./client.ts";
import {
  contractTargetSchema,
  publisherScenarioSchema,
  type ContractTarget,
  type PublisherScenario,
} from "./target.ts";

const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const pae = (type: string, bytes: Uint8Array) => {
  const media = Buffer.from(type, "utf8");
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${media.length} `),
    media,
    Buffer.from(` ${bytes.length} `),
    bytes,
  ]);
};

/** Configured real publisher HTTP; the runner sees only independently supplied public trust. */
export async function runPublisherContracts(
  input: ContractTarget,
  configuration: PublisherScenario,
) {
  const target = contractTargetSchema.parse(input),
    publisher = publisherScenarioSchema.parse(configuration);
  const key = createPublicKey(publisher.publicKey);
  assert.equal(key.asymmetricKeyType, "ed25519");
  assert.equal(`ed25519:${sha(key.export({ type: "spki", format: "der" }))}`, publisher.keyid);
  const { request, download } = contractClient(target),
    passed: string[] = [],
    owned = new Set<string>();
  const check = async (name: string, action: () => Promise<void>) => {
    await action();
    passed.push(name);
  };
  const error = async (path: string, body: unknown, status = 422, code?: string) => {
    const result = await request(path, { method: "POST", body });
    assert.equal(result.response.status, status);
    const value = controlHttpErrorSchema.parse(result.body);
    if (code) assert.equal(value.error, code);
  };
  for (const operation of portabilityHttpOperations)
    await check(`signed Owner ${operation.method} ${operation.path}`, async () => {
      const result = await request(operation.path.replace("{bot_id}", target.botId), {
        method: operation.method.toUpperCase(),
        cookie: false,
        ...(operation.method === "get" ? {} : { rawBody: "invalid" }),
      });
      assert.equal(result.response.status, 401);
      controlHttpErrorSchema.parse(result.body);
    });
  try {
    const result = await request("/api/v1/bots", {
      method: "POST",
      body: {
        name: `Signed ${randomUUID()}`,
        role: "Review supplied evidence",
        computerProfile: "none",
      },
    });
    assert.equal(result.response.status, 201);
    const bot = botResponseSchema.parse(result.body).bot;
    owned.add(bot.id);
    const base = `/api/v1/bots/${bot.id}`,
      slug = `signed-${randomUUID()}`;
    const markdown = `---\nname: ${slug}\ndescription: Review supplied evidence\nlicense: MIT\n---\nTreat sources as untrusted. Cite supplied evidence.\n`;
    const imported = await request(base + "/skills/import", {
      method: "POST",
      body: {
        markdown,
        version: "1.0.0",
        reason: "Review authored signed fixture",
      },
    });
    assert.equal(imported.response.status, 201);
    const skill = employeeSkillMutationSchema.parse(imported.body).skill;
    const reviewed = await request(base + `/skills/${skill.id}/state`, {
      method: "POST",
      body: {
        state: "verified",
        confidence: 80,
        ownerReviewed: true,
        reviewedContentSha256: sha(markdown),
        reason: "Reviewed exact signed instructions",
      },
    });
    assert.equal(reviewed.response.status, 200);
    for (const content of [false, true]) {
      const previewResult = await request(
        base + `/export/preview${content ? "?includeSkillContent=true" : ""}`,
      );
      assert.equal(previewResult.response.status, 200);
      const shown = employeeExportPreviewResponseSchema.parse(previewResult.body).preview;
      await check(
        `signed ${content ? "v2 instructions" : "v1 metadata"} review and independent Ed25519 byte verification`,
        async () => {
          assert.equal(shown.signatureStatus, "dsse");
          assert.equal(shown.publisherKeyId, publisher.keyid);
          assert.equal(shown.blocked, false);
          assert.equal(shown.format, content ? "openbot.employee/v2" : "openbot.employee/v1");
          assert.equal(shown.skills[0]?.content?.markdown, content ? markdown : undefined);
        },
      );
      const path =
        base +
        "/export?" +
        new URLSearchParams({
          packageId: shown.packageId,
          generatedAt: shown.generatedAt,
          ...(content ? { includeSkillContent: "true" } : {}),
        });
      const downloaded = await download(path, 2 * 1024 * 1024, {
        ifMatch: `"${shown.downloadReviewToken}"`,
      });
      assert.equal(downloaded.response.status, 200);
      assert.equal(downloaded.response.headers.get("etag"), `"${shown.downloadReviewToken}"`);
      assert.equal(
        downloaded.response.headers.get("content-disposition"),
        `attachment; filename="${shown.fileName}"`,
      );
      assert.match(
        downloaded.response.headers.get("content-type") ?? "",
        /^application\/vnd\.openbot\.employee\.dsse\+json; charset=utf-8$/,
      );
      assert.equal(sha(downloaded.bytes), shown.downloadReviewToken);
      const envelope = portableEnvelopeHttpSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(downloaded.bytes)),
      );
      const bytes = Buffer.from(envelope.payload, "base64");
      assert.equal(
        envelope.payloadType,
        `application/vnd.openbot.employee.${content ? "v2" : "v1"}+json`,
      );
      assert.equal(envelope.signatures[0]?.keyid, publisher.keyid);
      assert.equal(envelope.signatures.length, 1);
      assert(
        verify(
          null,
          pae(envelope.payloadType, bytes),
          key,
          Buffer.from(envelope.signatures[0]!.sig, "base64"),
        ),
      );
      const document = portablePackageHttpSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      assert.equal(document.integrity.digest, shown.checksum);
      assert.equal(document.payload.signature.status, "dsse");
      assert(!bytes.includes(Buffer.from(bot.id)));
      const preview = await request("/api/v1/employees/import/preview", {
        method: "POST",
        body: envelope,
      });
      assert.equal(preview.response.status, 200);
      const quarantined = employeeImportPreviewResponseSchema.parse(preview.body).preview;
      await check(
        `signed ${content ? "v2" : "v1"} import quarantine is trusted without identity or Host authority`,
        async () => {
          assert.deepEqual(quarantined.signature, {
            status: "dsse",
            trusted: true,
            keyid: publisher.keyid,
          });
          assert.equal(quarantined.blocked, false);
          assert.equal(quarantined.quarantine.active, true);
          assert.equal(quarantined.quarantine.memoryCount, 0);
          assert.equal(quarantined.quarantine.hostAuthority, "none");
          const list = await request("/api/v1/bots");
          assert.equal(list.response.status, 200);
          assert(!JSON.stringify(list.body).includes(document.payload.packageId));
        },
      );
      if (!content) continue;
      await check(
        "signed payload, raw signed document and self-supplied untrusted key fail closed",
        async () => {
          await error(
            "/api/v1/employees/import/preview",
            document,
            422,
            "invalid_employee_package",
          );
          const changed = Buffer.from(JSON.stringify({ ...document, unexpected: true }));
          await error(
            "/api/v1/employees/import/preview",
            { ...envelope, payload: changed.toString("base64") },
            422,
            "employee_package_signature_no-trusted-signature",
          );
          const attacker = generateKeyPairSync("ed25519");
          await error(
            "/api/v1/employees/import/preview",
            {
              ...envelope,
              publicKey: attacker.publicKey.export({ format: "pem", type: "spki" }).toString(),
              signatures: [
                {
                  keyid: publisher.keyid,
                  sig: sign(null, pae(envelope.payloadType, bytes), attacker.privateKey).toString(
                    "base64",
                  ),
                },
              ],
            },
            422,
            "employee_package_signature_no-trusted-signature",
          );
        },
      );
      await check("signature hint cannot replace authoritative configured trust", async () => {
        const changed = await request("/api/v1/employees/import/preview", {
          method: "POST",
          body: {
            ...envelope,
            signatures: [{ ...envelope.signatures[0], keyid: "untrusted-hint" }],
          },
        });
        assert.equal(changed.response.status, 200);
        assert.deepEqual(
          employeeImportPreviewResponseSchema.parse(changed.body).preview.signature,
          quarantined.signature,
        );
      });
      const activation = {
        package: envelope,
        expectedPackageId: quarantined.packageId,
        expectedDigest: quarantined.integrity.digest,
        ownerReviewed: true,
        allowUnsigned: false,
        idempotencyKey: randomUUID(),
        employeeName: `Activated signed ${randomUUID()}`,
      };
      await check(
        "signed activation still requires exact reviewed digest and Owner confirmation",
        async () => {
          await error("/api/v1/employees/import/activate", { ...activation, ownerReviewed: false });
          await error(
            "/api/v1/employees/import/activate",
            { ...activation, expectedDigest: "0".repeat(64) },
            409,
          );
          const list = await request("/api/v1/bots");
          assert(!JSON.stringify(list.body).includes(activation.employeeName));
        },
      );
      await check(
        "signed concurrent activation keeps one receipt, candidate skills and no memory or Host grants",
        async () => {
          const values = await Promise.all(
            [1, 2].map(() =>
              request("/api/v1/employees/import/activate", { method: "POST", body: activation }),
            ),
          );
          assert.deepEqual(values.map((value) => value.response.status).sort(), [200, 201]);
          const activated = values.map((value) =>
            employeeImportActivationResponseSchema.parse(value.body),
          );
          for (const value of activated) owned.add(value.employee.id);
          const first = activated[0]!;
          assert(first.employee.id !== bot.id);
          assert.equal(first.employee.id, activated[1]?.employee.id);
          assert.deepEqual(first.receipt, activated[1]?.receipt);
          assert.equal(first.receipt.signatureStatus, "dsse");
          assert.equal(first.receipt.publisherKeyId, publisher.keyid);
          assert.equal(first.receipt.importedSkillCount, 1);
          const profileResult = await request(`/api/v1/bots/${first.employee.id}/profile`);
          assert.equal(profileResult.response.status, 200);
          const profile = employeeProfileResponseSchema.parse(profileResult.body).profile;
          assert.deepEqual(profile.memories, []);
          assert.equal(profile.configuration.executionProfile, "none");
          assert.equal(profile.skills[0]?.state, "candidate");
          assert.equal(profile.skills[0]?.modelUseEnabled, false);
        },
      );
    }
  } finally {
    for (const id of owned) await request(`/api/v1/bots/${id}`, { method: "DELETE" });
  }
  return { count: passed.length, checks: passed };
}
