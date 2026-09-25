import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import type { EmployeeProfile } from "@openbot/domain";
import { dsse } from "@sigstore/core";
import { employeeTemplateDssePayloadType, employeeTemplatePackageSchema } from "@openbot/protocol";
import { describe, expect, it } from "vitest";
import {
  buildEmployeeTemplate,
  employeeTemplatePayloadChecksum,
  inspectEmployeeTemplate,
  prepareEmployeeTemplateExport,
  serializeEmployeeTemplate,
  signEmployeeTemplateEnvelope,
  verifyEmployeeTemplateEnvelope,
  verifyEmployeeTemplateChecksum,
} from "./employee-package.js";

const timestamp = "2026-09-04T00:00:00.000Z";
const packageId = "00000000-0000-4000-8000-000000000099";

describe("employee template package", () => {
  it("exports a new-identity template without memory, history, evidence ids, or authority", () => {
    const result = buildEmployeeTemplate(createProfile(), { generatedAt: timestamp, packageId });
    const parsed = employeeTemplatePackageSchema.parse(result.document);
    const serialized = serializeEmployeeTemplate(parsed);

    expect(parsed.payload.skills).toEqual([
      expect.objectContaining({ slug: "browse-web", dependencySlugs: [] }),
    ]);
    expect(parsed.payload.skills).toHaveLength(1);
    expect(parsed.payload.employee.description).toBe(
      "Navigate approved sites and return evidence-backed outcomes.",
    );
    expect(parsed.payload.portability).toEqual({
      identity: "new-on-import",
      authority: "none",
      memories: "none",
      importedSkillState: "disabled-pending-review",
    });
    expect(parsed.payload.signature.status).toBe("unsigned");
    expect(result.preview).toMatchObject({
      blocked: false,
      employeeName: "Ops",
      employee: {
        name: "Ops",
        role: "Browser operations",
        description: "Navigate approved sites and return evidence-backed outcomes.",
      },
      skills: [
        {
          slug: "browse-web",
          name: "Browse web",
          description: "Navigate approved websites.",
          version: "1.0.0",
          requiredCapabilities: ["browser"],
          dependencySlugs: [],
        },
      ],
      hostAuthority: "none",
      identityOnImport: "new",
      includedMemoryCount: 0,
      verifiedSkillCount: 1,
    });
    expect(serialized).not.toContain("source-bot-id");
    expect(serialized).not.toContain("private-memory");
    expect(serialized).not.toContain("approval-id");
    expect(serialized).not.toContain("skill-evidence-id");
    expect(verifyEmployeeTemplateChecksum(parsed)).toBe(true);
  });

  it("detects secret-like free text and blocks export before download", () => {
    const profile = createProfile();
    profile.employee.role = "Use api_key=super-secret-value for operations";

    const result = buildEmployeeTemplate(profile, { generatedAt: timestamp, packageId });

    expect(result.preview.blocked).toBe(true);
    expect(result.preview.findings).toEqual([
      expect.objectContaining({
        code: "credential-like-content",
        location: "employee.role",
      }),
    ]);
  });

  it.each([
    ["CON", "con-employee.openbot-employee.json"],
    ["nul", "nul-employee.openbot-employee.json"],
    ["COM1", "com1-employee.openbot-employee.json"],
    ["LPT9", "lpt9-employee.openbot-employee.json"],
    ["研究员", "employee.openbot-employee.json"],
  ])("creates a portable filename for Employee name %s", (name, expectedFileName) => {
    const profile = createProfile();
    profile.employee.name = name;

    const result = buildEmployeeTemplate(profile, { generatedAt: timestamp, packageId });

    expect(result.preview.fileName).toBe(expectedFileName);
  });

  it("removes path, header, and executable-suffix input from the advisory filename", () => {
    const profile = createProfile();
    profile.employee.name = '../Release\r\nX-File: "run.exe"';

    const result = buildEmployeeTemplate(profile, { generatedAt: timestamp, packageId });
    const fileStem = result.preview.fileName.slice(0, -".openbot-employee.json".length);

    expect(result.preview.fileName).toMatch(/^[a-z0-9-]+\.openbot-employee\.json$/);
    expect(result.preview.fileName.length).toBeLessThanOrEqual(70);
    expect(fileStem).not.toMatch(/[\\/\r\n".;]/);
    expect(result.preview.fileName).not.toContain(".exe");
  });

  it("scans the portable profile biography before export", () => {
    const profile = createProfile();
    profile.details.description = "Use api_key=super-secret-value for this workflow";

    const result = buildEmployeeTemplate(profile, { generatedAt: timestamp, packageId });

    expect(result.preview.blocked).toBe(true);
    expect(result.preview.findings).toEqual([
      expect.objectContaining({
        code: "credential-like-content",
        location: "employee.description",
      }),
    ]);
  });

  it("returns blocking findings without invoking a configured publisher", () => {
    const profile = createProfile();
    profile.employee.role = "Use api_key=super-secret-value for operations";

    const result = prepareEmployeeTemplateExport(profile, {
      generatedAt: timestamp,
      packageId,
      publisher: {
        keyId: "owner-key-1",
        sign() {
          throw new Error("A blocked package must not be signed.");
        },
        verify() {
          throw new Error("A blocked package must not be verified.");
        },
      },
    });

    expect(result.preview.blocked).toBe(true);
    expect(result.preview.signatureStatus).toBe("dsse");
    expect(result.preview.findings).toEqual([
      expect.objectContaining({ code: "credential-like-content", location: "employee.role" }),
    ]);
  });

  it("blocks export when a verified skill depends on a skill outside the verified package", () => {
    const profile = createProfile();
    const verifiedSkill = profile.skills.find((skill) => skill.slug === "browse-web");
    if (verifiedSkill === undefined) throw new Error("Expected verified skill fixture.");
    verifiedSkill.dependencyIds = ["candidate-skill-id", "missing-skill-id"];

    const result = buildEmployeeTemplate(profile, { generatedAt: timestamp, packageId });

    expect(result.preview.blocked).toBe(true);
    expect(result.preview.findings).toEqual([
      {
        code: "excluded-skill-dependency",
        location: "skills[0].dependencySlugs",
        message: 'Verified skill "browse-web" depends on a skill that is not verified for export.',
      },
    ]);
    expect(result.document.payload.skills[0]?.dependencySlugs).toEqual([]);
  });

  it("invalidates the checksum when portable content changes", () => {
    const { document } = buildEmployeeTemplate(createProfile(), {
      generatedAt: timestamp,
      packageId,
    });
    document.payload.employee.role = "Changed after export";

    expect(verifyEmployeeTemplateChecksum(document)).toBe(false);
  });

  it("previews a compatible package in quarantine without activating it", () => {
    const { document } = buildEmployeeTemplate(createProfile(), {
      generatedAt: timestamp,
      packageId,
    });
    const preview = inspectEmployeeTemplate(document, [
      {
        id: "node-1",
        name: "Linux worker",
        platform: "linux",
        osVersion: "6.8",
        architecture: "x64",
        deviceClass: "server",
        isolation: "container",
        trustTier: "development",
        capabilities: ["browser", "screenshot"],
        capabilityManifest: [],
        activeRunIds: [],
        maxConcurrentRuns: 1,
        connectedAt: timestamp,
        lastSeenAt: timestamp,
      },
    ]);

    expect(preview.blocked).toBe(false);
    expect(preview.employee.description).toBe(
      "Navigate approved sites and return evidence-backed outcomes.",
    );
    expect(preview.skills).toEqual([
      expect.objectContaining({
        slug: "browse-web",
        description: "Navigate approved websites.",
        dependencySlugs: [],
        requiredCapabilities: ["browser"],
      }),
    ]);
    expect(preview.compatibility.compatibleHosts).toEqual([
      expect.objectContaining({ id: "node-1", platform: "linux" }),
    ]);
    expect(preview.integrity.valid).toBe(true);
    expect(preview.signature).toEqual({ status: "unsigned", trusted: false });
    expect(preview.quarantine).toEqual({
      active: true,
      createsNewIdentity: true,
      importedSkillState: "disabled-pending-review",
      hostAuthority: "none",
      memoryCount: 0,
      canActivate: true,
    });
  });

  it("preserves the reviewed profile and skill inventory across export and import", () => {
    const profile = createProfile();
    profile.skills.push({
      id: "verified-dependent-skill-id",
      slug: "summarize-page",
      name: "Summarize page",
      description: "Summarize evidence collected from an approved page.",
      version: "2.1.0",
      source: "learned",
      state: "verified",
      confidence: 0.9,
      requiredCapabilities: ["screenshot", "browser"],
      dependencyIds: ["verified-skill-id"],
      evidence: [{ kind: "manual", id: "summary-review" }],
      acquiredAt: timestamp,
      updatedAt: timestamp,
    });

    const exported = buildEmployeeTemplate(profile, { generatedAt: timestamp, packageId });
    const imported = inspectEmployeeTemplate(exported.document, [
      {
        id: "node-1",
        name: "Linux worker",
        platform: "linux",
        osVersion: "6.8",
        architecture: "x64",
        deviceClass: "server",
        isolation: "container",
        trustTier: "development",
        capabilities: ["browser", "screenshot"],
        capabilityManifest: [],
        activeRunIds: [],
        maxConcurrentRuns: 1,
        connectedAt: timestamp,
        lastSeenAt: timestamp,
      },
    ]);

    expect(imported.employee).toEqual(exported.preview.employee);
    expect(imported.skills).toEqual(exported.preview.skills);
    expect(imported.requestedCapabilities).toEqual(exported.preview.requestedCapabilities);
    expect(imported.skills).toEqual([
      expect.objectContaining({ slug: "browse-web", dependencySlugs: [] }),
      expect.objectContaining({
        slug: "summarize-page",
        requiredCapabilities: ["browser", "screenshot"],
        dependencySlugs: ["browse-web"],
      }),
    ]);
  });

  it("keeps older v1 packages without a biography reviewable", () => {
    const { document } = buildEmployeeTemplate(createProfile(), {
      generatedAt: timestamp,
      packageId,
    });
    delete document.payload.employee.description;
    document.integrity.digest = employeeTemplatePayloadChecksum(document.payload);

    const preview = inspectEmployeeTemplate(document, []);

    expect(preview.employee.description).toBeUndefined();
    expect(preview.issues.map((issue) => issue.code)).not.toContain("checksum-mismatch");
  });

  it("blocks a tampered or incompatible package while still returning a review projection", () => {
    const { document } = buildEmployeeTemplate(createProfile(), {
      generatedAt: timestamp,
      packageId,
    });
    document.payload.employee.role = "Changed after checksum";
    const preview = inspectEmployeeTemplate(document, []);

    expect(preview.blocked).toBe(true);
    expect(preview.integrity.valid).toBe(false);
    expect(preview.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["checksum-mismatch", "missing-capability", "no-compatible-host"]),
    );
  });
});

describe("signed employee template envelope", () => {
  it("signs exact employee-package bytes and verifies them against an explicit trust store", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { document } = buildEmployeeTemplate(createProfile(), {
      generatedAt: timestamp,
      packageId,
    });

    const envelope = signEmployeeTemplateEnvelope(document, {
      keyid: "owner-key-1",
      privateKey,
    });
    const verification = verifyEmployeeTemplateEnvelope(envelope, [
      { keyid: "owner-key-1", publicKey },
    ]);

    expect(document.payload.signature).toEqual({ status: "unsigned" });
    expect(envelope.payloadType).toBe(employeeTemplateDssePayloadType);
    expect(verification).toMatchObject({
      status: "verified",
      trustedKeyId: "owner-key-1",
      document: {
        payload: {
          packageId,
          signature: { status: "dsse", algorithm: "ed25519", keyid: "owner-key-1" },
        },
      },
    });
  });

  it("does not treat the unauthenticated envelope key id as a trust decision", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { document } = buildEmployeeTemplate(createProfile(), {
      generatedAt: timestamp,
      packageId,
    });
    const envelope = signEmployeeTemplateEnvelope(document, {
      keyid: "owner-key-1",
      privateKey,
    });
    envelope.signatures[0] = { ...envelope.signatures[0], keyid: "attacker-controlled-hint" };

    expect(
      verifyEmployeeTemplateEnvelope(envelope, [{ keyid: "owner-key-1", publicKey }]),
    ).toMatchObject({ status: "verified", trustedKeyId: "owner-key-1" });
  });

  it("refuses to sign a package that the export scanner has blocked", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const profile = createProfile();
    profile.employee.role = "Use api_key=super-secret-value for operations";
    const { document } = buildEmployeeTemplate(profile, { generatedAt: timestamp, packageId });

    expect(() =>
      signEmployeeTemplateEnvelope(document, { keyid: "owner-key-1", privateKey }),
    ).toThrow("sensitive-looking content");
  });

  it("rejects changed payload bytes and signatures from an untrusted key", () => {
    const trusted = generateKeyPairSync("ed25519");
    const attacker = generateKeyPairSync("ed25519");
    const { document } = buildEmployeeTemplate(createProfile(), {
      generatedAt: timestamp,
      packageId,
    });
    const envelope = signEmployeeTemplateEnvelope(document, {
      keyid: "attacker-key",
      privateKey: attacker.privateKey,
    });

    expect(
      verifyEmployeeTemplateEnvelope(envelope, [
        { keyid: "trusted-key", publicKey: trusted.publicKey },
      ]),
    ).toMatchObject({ status: "rejected", code: "no-trusted-signature" });

    const payloadBytes = Buffer.from(envelope.payload, "base64");
    const changedByteIndex = payloadBytes.length - 2;
    const originalByte = payloadBytes[changedByteIndex];
    if (originalByte === undefined) throw new Error("Expected a non-empty signed payload fixture.");
    payloadBytes[changedByteIndex] = originalByte ^ 1;
    envelope.payload = payloadBytes.toString("base64");
    expect(
      verifyEmployeeTemplateEnvelope(envelope, [
        { keyid: "attacker-key", publicKey: attacker.publicKey },
      ]),
    ).toMatchObject({ status: "rejected", code: "no-trusted-signature" });
  });

  it("separately rejects a valid signature over a package with a stale checksum", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { document } = buildEmployeeTemplate(createProfile(), {
      generatedAt: timestamp,
      packageId,
    });
    const envelope = signEmployeeTemplateEnvelope(document, {
      keyid: "owner-key-1",
      privateKey,
    });
    const signedDocument = employeeTemplatePackageSchema.parse(
      JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")),
    );
    signedDocument.payload.employee.role = "Changed and re-signed without updating integrity";
    const changedBytes = Buffer.from(serializeEmployeeTemplate(signedDocument), "utf8");
    const signature = signBytes(
      null,
      dsse.preAuthEncoding(employeeTemplateDssePayloadType, changedBytes),
      privateKey,
    );
    const changedEnvelope = {
      payload: changedBytes.toString("base64"),
      payloadType: employeeTemplateDssePayloadType,
      signatures: [{ keyid: "owner-key-1", sig: signature.toString("base64") }],
    };

    expect(
      verifyEmployeeTemplateEnvelope(changedEnvelope, [{ keyid: "owner-key-1", publicKey }]),
    ).toMatchObject({ status: "rejected", code: "checksum-mismatch" });
  });

  it("rejects authenticated package metadata that names a different trusted key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { document } = buildEmployeeTemplate(createProfile(), {
      generatedAt: timestamp,
      packageId,
    });
    const envelope = signEmployeeTemplateEnvelope(document, {
      keyid: "different-key",
      privateKey,
    });

    expect(
      verifyEmployeeTemplateEnvelope(envelope, [{ keyid: "owner-key-1", publicKey }]),
    ).toMatchObject({ status: "rejected", code: "signature-metadata-mismatch" });
  });

  it("rejects a valid signature when its authenticated payload type is unsupported", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { document } = buildEmployeeTemplate(createProfile(), {
      generatedAt: timestamp,
      packageId,
    });
    const signed = signEmployeeTemplateEnvelope(document, {
      keyid: "owner-key-1",
      privateKey,
    });
    const unsupportedType = "application/vnd.example.employee+json";
    const payloadBytes = Buffer.from(signed.payload, "base64");
    const signature = signBytes(
      null,
      dsse.preAuthEncoding(unsupportedType, payloadBytes),
      privateKey,
    );

    expect(
      verifyEmployeeTemplateEnvelope(
        {
          payload: signed.payload,
          payloadType: unsupportedType,
          signatures: [{ keyid: "owner-key-1", sig: signature.toString("base64") }],
        },
        [{ keyid: "owner-key-1", publicKey }],
      ),
    ).toMatchObject({ status: "rejected", code: "unsupported-payload-type" });
  });

  it("fails closed when the configured trust store has duplicate key ids", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { document } = buildEmployeeTemplate(createProfile(), {
      generatedAt: timestamp,
      packageId,
    });
    const envelope = signEmployeeTemplateEnvelope(document, {
      keyid: "owner-key-1",
      privateKey,
    });

    expect(
      verifyEmployeeTemplateEnvelope(envelope, [
        { keyid: "owner-key-1", publicKey },
        { keyid: "owner-key-1", publicKey },
      ]),
    ).toMatchObject({ status: "rejected", code: "invalid-trust-store" });
  });
});

function createProfile(): EmployeeProfile {
  return {
    employee: {
      id: "source-bot-id",
      name: "Ops",
      role: "Browser operations",
      status: "idle",
      computerProfile: "docker-linux",
      appearance: {
        head: "round",
        body: "classic",
        mobility: "feet",
        accessory: "none",
        accent: "green",
      },
      createdAt: timestamp,
    },
    details: {
      description: "Navigate approved sites and return evidence-backed outcomes.",
      revision: 1,
      updatedAt: timestamp,
    },
    evolution: [
      {
        id: "evolution-id",
        botId: "source-bot-id",
        type: "skill_verified",
        title: "Skill verified",
        summary: "Evidence stayed on the source Server.",
        source: "manual",
        evidence: [{ kind: "manual", id: "skill-evidence-id" }],
        createdAt: timestamp,
      },
    ],
    skills: [
      {
        id: "verified-skill-id",
        slug: "browse-web",
        name: "Browse web",
        description: "Navigate approved websites.",
        version: "1.0.0",
        source: "built-in",
        state: "verified",
        confidence: 1,
        requiredCapabilities: ["browser"],
        dependencyIds: [],
        evidence: [{ kind: "manual", id: "skill-evidence-id" }],
        acquiredAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "candidate-skill-id",
        slug: "unverified-action",
        name: "Unverified action",
        description: "Must not be exported by default.",
        version: "0.1.0",
        source: "learned",
        state: "candidate",
        confidence: 0.4,
        requiredCapabilities: ["host.gui"],
        dependencyIds: [],
        evidence: [],
        acquiredAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    memories: [
      {
        id: "private-memory",
        botId: "source-bot-id",
        kind: "secret-reference",
        title: "Never export",
        content: "password=private-memory-value",
        sensitivity: "restricted",
        portability: "never",
        provenance: { localPath: "/Users/owner/private.txt" },
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    memoryEvents: [],
    records: {
      runs: [],
      approvals: [
        {
          id: "approval-id",
          runId: "run-id",
          channelId: "channel-id",
          botId: "source-bot-id",
          nodeId: "node-id",
          action: "submit",
          target: "example.com",
          summary: "Submit form",
          risk: "write",
          targetFingerprint: "fingerprint",
          beforeState: {},
          status: "approved",
          expiresAt: timestamp,
          createdAt: timestamp,
        },
      ],
      artifacts: [],
      decisions: [],
    },
    statistics: {
      totalRuns: 0,
      completedRuns: 0,
      failedRuns: 0,
      verifiedSkills: 1,
    },
    configuration: {
      executionProfile: "docker-linux",
      portabilityFormat: "openbot.employee/v1",
    },
  };
}

describe("portable v2 instruction content", () => {
  it("exports multiple substantial skills and rejects content beyond the signed transport budget", () => {
    const profile = withInstructions();
    const base = profile.skills[0];
    if (!base) throw new Error("Missing skill fixture.");
    profile.skills = Array.from({ length: 110 }, (_, index) => {
      const slug = `summarize-${index}`;
      const markdown = `---\nname: ${slug}\ndescription: Summarize supplied notes.\nlicense: MIT\n---\n${"Summarize the supplied notes. ".repeat(360)}\n`;
      return {
        ...base,
        id: `skill-${index}`,
        slug,
        skillMarkdown: markdown,
        contentSha256: createHash("sha256").update(markdown).digest("hex"),
      };
    });
    const oversized = buildEmployeeTemplate(profile, { includeSkillContent: true });
    expect(oversized.preview.blocked).toBe(true);
    expect(oversized.preview.findings).toContainEqual(
      expect.objectContaining({ code: "package-too-large" }),
    );
    profile.skills = profile.skills.slice(0, 6);
    const exported = buildEmployeeTemplate(profile, { includeSkillContent: true });
    expect(Buffer.byteLength(serializeEmployeeTemplate(exported.document))).toBeGreaterThan(
      64 * 1024,
    );
    expect(exported.preview.blocked).toBe(false);
    const keys = generateKeyPairSync("ed25519");
    const envelope = signEmployeeTemplateEnvelope(exported.document, {
      keyid: "fixture",
      privateKey: keys.privateKey,
    });
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThan(2 * 1024 * 1024);
    expect(
      verifyEmployeeTemplateEnvelope(envelope, [{ keyid: "fixture", publicKey: keys.publicKey }])
        .status,
    ).toBe("verified");
  });
  function withInstructions(license = "MIT") {
    const profile = createProfile();
    profile.configuration.executionProfile = "none";
    const markdown = `---\nname: summarize\ndescription: Summarize supplied notes.\nlicense: ${license}\nmetadata:\n  author: OpenBot test fixture\n---\nReturn three concise bullets based only on the supplied notes.\n`;
    profile.skills = [
      {
        ...profile.skills[0]!,
        slug: "summarize",
        name: "Summarize",
        description: "Summarize supplied notes.",
        requiredCapabilities: [],
        dependencyIds: [],
        skillMarkdown: markdown,
        contentSha256: createHash("sha256").update(markdown).digest("hex"),
        modelUseEnabled: true,
      },
    ];
    return profile;
  }
  it("keeps v1 metadata compatibility and includes exact reviewed instructions only by selection", () => {
    const profile = withInstructions();
    expect(buildEmployeeTemplate(profile).document.payload.skills[0]?.content).toBeUndefined();
    const exported = buildEmployeeTemplate(profile, { includeSkillContent: true });
    expect(exported.preview.blocked).toBe(false);
    expect(exported.document.payload.format).toBe("openbot.employee/v2");
    expect(exported.preview.skills[0]?.content?.markdown).toBe(profile.skills[0]?.skillMarkdown);
    expect(inspectEmployeeTemplate(exported.document, []).quarantine).toMatchObject({
      canActivate: true,
      createsNewIdentity: true,
      importedSkillState: "disabled-pending-review",
      hostAuthority: "none",
    });
  });
  it("blocks changed content even after an attacker recalculates the package checksum", () => {
    const exported = buildEmployeeTemplate(withInstructions(), { includeSkillContent: true });
    exported.document.payload.skills[0]!.content!.markdown += "Changed instructions.";
    exported.document.integrity.digest = employeeTemplatePayloadChecksum(exported.document.payload);
    expect(inspectEmployeeTemplate(exported.document, []).issues).toContainEqual(
      expect.objectContaining({ code: "invalid-skill-content" }),
    );
  });
  it("blocks unreviewed content and unsupported distribution licenses", () => {
    const profile = withInstructions("Proprietary");
    expect(buildEmployeeTemplate(profile, { includeSkillContent: true }).preview.blocked).toBe(
      true,
    );
    profile.skills[0]!.modelUseEnabled = false;
    expect(buildEmployeeTemplate(profile, { includeSkillContent: true }).preview.blocked).toBe(
      true,
    );
  });
  it("binds v2 instruction packages to their v2 DSSE media type", () => {
    const exported = buildEmployeeTemplate(withInstructions(), { includeSkillContent: true });
    const keys = generateKeyPairSync("ed25519");
    const envelope = signEmployeeTemplateEnvelope(exported.document, {
      keyid: "fixture",
      privateKey: keys.privateKey,
    });
    expect(envelope.payloadType).toBe("application/vnd.openbot.employee.v2+json");
    expect(
      verifyEmployeeTemplateEnvelope(envelope, [{ keyid: "fixture", publicKey: keys.publicKey }])
        .status,
    ).toBe("verified");
    const bytes = Buffer.from(envelope.payload, "base64");
    envelope.payloadType = employeeTemplateDssePayloadType;
    envelope.signatures[0]!.sig = signBytes(
      null,
      dsse.preAuthEncoding(envelope.payloadType, bytes),
      keys.privateKey,
    ).toString("base64");
    expect(
      verifyEmployeeTemplateEnvelope(envelope, [{ keyid: "fixture", publicKey: keys.publicKey }]),
    ).toMatchObject({ status: "rejected", code: "unsupported-payload-type" });
  });
});
