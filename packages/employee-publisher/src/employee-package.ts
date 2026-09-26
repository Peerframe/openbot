import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  randomUUID,
  sign as signBytes,
  verify as verifyBytes,
  type KeyLike,
} from "node:crypto";
import type {
  EmployeeExportFinding,
  EmployeeExportPreview,
  EmployeeImportIssue,
  EmployeeImportPreview,
  EmployeeProfile,
  ExecutionNode,
} from "@openbot/domain";
import { dsse } from "@sigstore/core";
import { windowsReservedNameRegex } from "filename-reserved-regex";
import {
  dsseEnvelopeSchema,
  employeeTemplateDssePayloadType,
  employeeTemplateV2DssePayloadType,
  employeeTemplatePackageSchema,
  employeeTemplatePayloadSchema,
  type DsseEnvelope,
  type EmployeeTemplatePackage,
  type EmployeeTemplatePayload,
} from "@openbot/protocol";
import { portableSkillContent, skillContentProblem } from "./employee-package-content.js";
import { requirementsForExecutionProfile } from "./execution-routing.js";
import { scanSensitiveText } from "./sensitive-content.js";

interface EmployeeTemplateBuildOptions {
  includeSkillContent?: boolean;
  generatedAt?: string;
  packageId?: string;
  publisherKeyId?: string;
}

export interface EmployeeTemplateBuild {
  document: EmployeeTemplatePackage;
  preview: Omit<EmployeeExportPreview, "downloadReviewToken">;
}

export interface PreparedEmployeeTemplateExport extends EmployeeTemplateBuild {
  body: string;
  preview: EmployeeExportPreview;
}

export interface EmployeeTemplateExportPublisher {
  keyId: string;
  sign(document: EmployeeTemplatePackage): DsseEnvelope;
  verify(input: unknown): EmployeeTemplateEnvelopeVerification;
}

export interface EmployeeTemplateSigningKey {
  keyid: string;
  privateKey: KeyLike;
}

export interface EmployeeTemplateTrustedKey {
  keyid: string;
  publicKey: KeyLike;
}

export type EmployeeTemplateEnvelopeVerification =
  | {
      status: "verified";
      trustedKeyId: string;
      document: EmployeeTemplatePackage;
    }
  | {
      status: "rejected";
      code:
        | "invalid-envelope"
        | "invalid-trust-store"
        | "no-trusted-signature"
        | "unsupported-payload-type"
        | "invalid-payload"
        | "checksum-mismatch"
        | "signature-metadata-mismatch";
      message: string;
    };

/**
 * Builds the safe, identity-free v1 template. The generated package is checksum protected but is
 * deliberately marked unsigned until OpenBot has an owner key lifecycle.
 */
export function buildEmployeeTemplate(
  profile: EmployeeProfile,
  options: EmployeeTemplateBuildOptions = {},
): EmployeeTemplateBuild {
  const exportedSkills = profile.skills
    .filter((skill) => skill.state === "verified")
    .sort((left, right) => left.slug.localeCompare(right.slug));
  const exportedSkillSlugs = new Map(exportedSkills.map((skill) => [skill.id, skill.slug]));
  const requestedCapabilities = Array.from(
    new Set(exportedSkills.flatMap((skill) => skill.requiredCapabilities)),
  ).sort();

  const contentFindings: EmployeeExportFinding[] = [];
  const payload = employeeTemplatePayloadSchema.parse({
    format: options.includeSkillContent ? "openbot.employee/v2" : "openbot.employee/v1",
    kind: "template",
    packageId: options.packageId ?? randomUUID(),
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    employee: {
      name: profile.employee.name,
      role: profile.employee.role,
      description: profile.details.description,
      ...(profile.employee.appearance ? { appearance: profile.employee.appearance } : {}),
    },
    configuration: {
      recommendedExecutionProfile: profile.configuration.executionProfile,
    },
    skills: exportedSkills.map((skill) => ({
      ...(options.includeSkillContent
        ? { content: portableSkillContent(skill, contentFindings) }
        : {}),
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      requiredCapabilities: [...new Set(skill.requiredCapabilities)].sort(),
      dependencySlugs: skill.dependencyIds
        .flatMap((dependencyId) => {
          const slug = exportedSkillSlugs.get(dependencyId);
          return slug === undefined ? [] : [slug];
        })
        .sort(),
    })),
    requestedCapabilities,
    portability: {
      identity: "new-on-import",
      authority: "none",
      memories: "none",
      importedSkillState: "disabled-pending-review",
    },
    signature: { status: "unsigned" },
  });

  const checksum = employeeTemplatePayloadChecksum(payload);
  const findings = [
    ...contentFindings,
    ...exportDependencyClosureFindings(exportedSkills, exportedSkillSlugs),
    ...scanPortableFields(payload),
  ];
  const workHistoryCount =
    profile.evolution.length +
    profile.records.runs.length +
    profile.records.approvals.length +
    profile.records.artifacts.length +
    profile.records.decisions.length;
  const document: EmployeeTemplatePackage = {
    payload,
    integrity: {
      algorithm: "sha256",
      canonicalization: "openbot-json-v1",
      digest: checksum,
    },
  };
  // Reserve space for the publisher identity and base64 DSSE envelope (1.5M characters).
  // The actual import routes allow 2 MiB, independently of the general 64 KiB API limit.
  if (Buffer.byteLength(serializeEmployeeTemplate(document)) > 1024 * 1024)
    findings.push({
      code: "package-too-large",
      location: "skills",
      message:
        "The selected Bot exceeds the 1 MiB portable content limit. Reduce included instructions or share metadata only.",
    });

  return {
    document,
    preview: {
      format: payload.format,
      kind: payload.kind,
      packageId: payload.packageId,
      fileName: `${portableFileStem(profile.employee.name)}.openbot-employee${options.publisherKeyId === undefined ? "" : ".dsse"}.json`,
      generatedAt: payload.generatedAt,
      employee: portableEmployeeSummary(payload.employee),
      skills: payload.skills.map(portableSkillSummary),
      employeeName: payload.employee.name,
      verifiedSkillCount: payload.skills.length,
      requestedCapabilities,
      includedMemoryCount: 0,
      exclusions: [
        {
          category: "identity",
          count: 1,
          reason: "The source employee id and ownership are never included in a template.",
        },
        {
          category: "authority",
          count: 1,
          reason:
            "Host bindings, approvals, credentials, sessions, and capability grants are absent.",
        },
        {
          category: "memory",
          count: profile.memories.length,
          reason: "The v1 default template exports no memory records.",
        },
        {
          category: "work-history",
          count: workHistoryCount,
          reason:
            "Runs, decisions, artifacts, approvals, and evolution history stay on the source Server.",
        },
      ],
      findings,
      blocked: findings.length > 0,
      checksum,
      signatureStatus: options.publisherKeyId === undefined ? "unsigned" : "dsse",
      ...(options.publisherKeyId === undefined ? {} : { publisherKeyId: options.publisherKeyId }),
      identityOnImport: "new",
      hostAuthority: "none",
    },
  };
}

/**
 * Prepares the exact bytes exposed by preview and download. Rebuilding with the returned package
 * identity is deliberate: a later request can prove that profile and publisher state still
 * serialize to the reviewed representation without storing a second source of truth.
 */
export function prepareEmployeeTemplateExport(
  profile: EmployeeProfile,
  options: {
    includeSkillContent?: boolean;
    generatedAt?: string;
    packageId?: string;
    publisher?: EmployeeTemplateExportPublisher;
  } = {},
): PreparedEmployeeTemplateExport {
  const built = buildEmployeeTemplate(profile, {
    ...(options.includeSkillContent === undefined
      ? {}
      : { includeSkillContent: options.includeSkillContent }),
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
    ...(options.packageId === undefined ? {} : { packageId: options.packageId }),
    ...(options.publisher === undefined ? {} : { publisherKeyId: options.publisher.keyId }),
  });
  const publisher = built.preview.blocked ? undefined : options.publisher;
  const exportedDocument = publisher?.sign(built.document) ?? built.document;
  let downloadableDocument = built.document;
  let checksum = built.preview.checksum;
  if (publisher !== undefined) {
    const verification = publisher.verify(exportedDocument);
    if (verification.status === "rejected") {
      const reason = `${verification.code}: ${verification.message}`;
      throw new Error(`Employee publisher could not verify its export: ${reason}.`);
    }
    const { signature: _unsignedSignature, ...expectedContent } = built.document.payload;
    const { signature, ...verifiedContent } = verification.document.payload;
    if (
      verification.trustedKeyId !== publisher.keyId ||
      signature.status !== "dsse" ||
      signature.keyid !== publisher.keyId ||
      canonicalJson(verifiedContent) !== canonicalJson(expectedContent)
    ) {
      throw new Error(
        "Employee publisher could not verify its export: verified payload does not match the prepared Employee package.",
      );
    }
    downloadableDocument = verification.document;
    checksum = verification.document.integrity.digest;
  }
  const body = `${JSON.stringify(exportedDocument, null, 2)}\n`;

  return {
    ...built,
    document: downloadableDocument,
    body,
    preview: {
      ...built.preview,
      checksum,
      downloadReviewToken: createHash("sha256").update(body).digest("hex"),
    },
  };
}

export function serializeEmployeeTemplate(document: EmployeeTemplatePackage): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function verifyEmployeeTemplateChecksum(document: EmployeeTemplatePackage): boolean {
  const actual = employeeTemplatePayloadChecksum(document.payload);
  return actual === document.integrity.digest;
}

/** Canonical checksum stored inside an Employee package and recomputed during quarantine. */
export function employeeTemplatePayloadChecksum(payload: EmployeeTemplatePayload): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/** Stable digest of the complete validated package used to bind preview and activation. */
export function employeeTemplatePackageDigest(document: EmployeeTemplatePackage): string {
  return createHash("sha256").update(canonicalJson(document)).digest("hex");
}

/**
 * Wraps the exact serialized employee package bytes in a DSSE v1 envelope. This primitive does not
 * create or persist owner keys; callers must obtain an Ed25519 signing key from a separate key
 * lifecycle and must never place private key material in the employee package.
 */
export function signEmployeeTemplateEnvelope(
  document: EmployeeTemplatePackage,
  signer: EmployeeTemplateSigningKey,
): DsseEnvelope {
  const source = employeeTemplatePackageSchema.parse(document);
  if (!verifyEmployeeTemplateChecksum(source)) {
    throw new Error("Refusing to sign an employee package with an invalid checksum.");
  }
  if (source.payload.signature.status !== "unsigned") {
    throw new Error("Refusing to sign an employee package that is already marked as signed.");
  }
  if (scanPortableFields(source.payload).length > 0) {
    throw new Error("Refusing to sign an employee package containing sensitive-looking content.");
  }

  const privateKey = asEd25519PrivateKey(signer.privateKey);
  const signedPayload = employeeTemplatePayloadSchema.parse({
    ...source.payload,
    signature: {
      status: "dsse",
      algorithm: "ed25519",
      keyid: signer.keyid,
    },
  });
  const signedDocument = employeeTemplatePackageSchema.parse({
    payload: signedPayload,
    integrity: {
      algorithm: "sha256",
      canonicalization: "openbot-json-v1",
      digest: createHash("sha256").update(canonicalJson(signedPayload)).digest("hex"),
    },
  });
  const payloadBytes = Buffer.from(serializeEmployeeTemplate(signedDocument), "utf8");
  const payloadType =
    signedPayload.format === "openbot.employee/v2"
      ? employeeTemplateV2DssePayloadType
      : employeeTemplateDssePayloadType;
  const pae = dsse.preAuthEncoding(payloadType, payloadBytes);
  const signature = signBytes(null, pae, privateKey);
  if (signedPayload.signature.status !== "dsse") {
    throw new Error("Employee package signature metadata did not normalize to DSSE.");
  }

  return dsseEnvelopeSchema.parse({
    payload: payloadBytes.toString("base64"),
    payloadType,
    signatures: [{ keyid: signedPayload.signature.keyid, sig: signature.toString("base64") }],
  });
}

/**
 * Verifies DSSE over the same bytes that are parsed as the employee package. Envelope key ids are
 * treated only as hints: every signature is checked against configured trusted public keys, and
 * the authenticated key id inside the package must identify a key that actually verified.
 */
export function verifyEmployeeTemplateEnvelope(
  input: unknown,
  trustedKeys: readonly EmployeeTemplateTrustedKey[],
): EmployeeTemplateEnvelopeVerification {
  const parsedEnvelope = dsseEnvelopeSchema.safeParse(input);
  if (!parsedEnvelope.success) {
    return {
      status: "rejected",
      code: "invalid-envelope",
      message: "The DSSE envelope is malformed or exceeds the supported bounds.",
    };
  }

  let payloadBytes: Buffer;
  try {
    payloadBytes = decodeDsseBase64(parsedEnvelope.data.payload);
  } catch {
    return {
      status: "rejected",
      code: "invalid-envelope",
      message: "The DSSE envelope payload is not valid base64.",
    };
  }

  let trustedPublicKeys: Array<{ keyid: string; publicKey: KeyObject }>;
  try {
    trustedPublicKeys = normalizeTrustedKeys(trustedKeys);
  } catch (error) {
    return {
      status: "rejected",
      code: "invalid-trust-store",
      message: error instanceof Error ? error.message : "The trusted key configuration is invalid.",
    };
  }

  const pae = dsse.preAuthEncoding(parsedEnvelope.data.payloadType, payloadBytes);
  const verifiedKeyIds = new Set<string>();
  for (const signature of parsedEnvelope.data.signatures) {
    let signatureBytes: Buffer;
    try {
      signatureBytes = decodeDsseBase64(signature.sig);
    } catch {
      continue;
    }
    for (const trustedKey of trustedPublicKeys) {
      try {
        if (verifyBytes(null, pae, trustedKey.publicKey, signatureBytes)) {
          verifiedKeyIds.add(trustedKey.keyid);
        }
      } catch {
        // A malformed signature is untrusted input; another signature may still verify.
      }
    }
  }

  if (verifiedKeyIds.size === 0) {
    return {
      status: "rejected",
      code: "no-trusted-signature",
      message: "No signature was produced by a configured trusted public key.",
    };
  }
  if (
    ![employeeTemplateDssePayloadType, employeeTemplateV2DssePayloadType].includes(
      parsedEnvelope.data.payloadType as typeof employeeTemplateDssePayloadType,
    )
  ) {
    return {
      status: "rejected",
      code: "unsupported-payload-type",
      message: `Unsupported DSSE payload type: ${parsedEnvelope.data.payloadType}`,
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
  } catch {
    return {
      status: "rejected",
      code: "invalid-payload",
      message: "The verified payload is not valid UTF-8 JSON.",
    };
  }
  const parsedDocument = employeeTemplatePackageSchema.safeParse(payload);
  if (!parsedDocument.success) {
    return {
      status: "rejected",
      code: "invalid-payload",
      message: "The verified payload is not a supported OpenBot employee package.",
    };
  }
  const expectedType =
    parsedDocument.data.payload.format === "openbot.employee/v2"
      ? employeeTemplateV2DssePayloadType
      : employeeTemplateDssePayloadType;
  if (parsedEnvelope.data.payloadType !== expectedType)
    return {
      status: "rejected",
      code: "unsupported-payload-type",
      message: "Package version does not match the signed payload type.",
    };
  if (!verifyEmployeeTemplateChecksum(parsedDocument.data)) {
    return {
      status: "rejected",
      code: "checksum-mismatch",
      message: "The signed employee package checksum does not match its payload.",
    };
  }

  const signatureMetadata = parsedDocument.data.payload.signature;
  if (
    signatureMetadata.status !== "dsse" ||
    signatureMetadata.algorithm !== "ed25519" ||
    !verifiedKeyIds.has(signatureMetadata.keyid)
  ) {
    return {
      status: "rejected",
      code: "signature-metadata-mismatch",
      message: "The authenticated package metadata does not identify a signature that verified.",
    };
  }

  return {
    status: "verified",
    trustedKeyId: signatureMetadata.keyid,
    document: parsedDocument.data,
  };
}

/**
 * Inspects a schema-valid package in quarantine. This function never persists or activates data.
 */
export function inspectEmployeeTemplate(
  document: EmployeeTemplatePackage,
  nodes: ExecutionNode[],
  options: { trustedKeyId?: string } = {},
): EmployeeImportPreview {
  const { payload } = document;
  if (payload.signature.status === "dsse" && options.trustedKeyId !== payload.signature.keyid) {
    throw new TypeError(
      "Signed Employee packages must be inspected only after trusted verification.",
    );
  }
  if (payload.signature.status === "unsigned" && options.trustedKeyId !== undefined) {
    throw new TypeError("Unsigned Employee packages cannot have a trusted publisher key.");
  }
  const issues: EmployeeImportIssue[] = [];
  for (const skill of payload.skills) {
    const problem = skillContentProblem(skill);
    if (problem)
      issues.push({
        code: "invalid-skill-content",
        message: problem,
        locations: [`skills.${skill.slug}.content`],
      });
  }
  const skillSlugs = payload.skills.map((skill) => skill.slug);
  const uniqueSkillSlugs = new Set(skillSlugs);
  const duplicateSkillSlugs = Array.from(
    new Set(skillSlugs.filter((slug, index) => skillSlugs.indexOf(slug) !== index)),
  ).sort();
  if (duplicateSkillSlugs.length > 0) {
    issues.push({
      code: "duplicate-skill",
      message: "The package contains duplicate skill slugs.",
      locations: duplicateSkillSlugs,
    });
  }

  const missingDependencies = payload.skills.flatMap((skill) =>
    skill.dependencySlugs
      .filter((dependencySlug) => !uniqueSkillSlugs.has(dependencySlug))
      .map((dependencySlug) => `${skill.slug} -> ${dependencySlug}`),
  );
  if (missingDependencies.length > 0) {
    issues.push({
      code: "missing-skill-dependency",
      message: "One or more skill dependencies are absent from the package.",
      locations: [...new Set(missingDependencies)].sort(),
    });
  }

  const skillCapabilities = Array.from(
    new Set(payload.skills.flatMap((skill) => skill.requiredCapabilities)),
  ).sort();
  const declaredCapabilities = [...new Set(payload.requestedCapabilities)].sort();
  if (skillCapabilities.join("\n") !== declaredCapabilities.join("\n")) {
    issues.push({
      code: "capability-set-mismatch",
      message: "The declared capability set does not match the included skills.",
      locations: Array.from(new Set([...skillCapabilities, ...declaredCapabilities])).sort(),
    });
  }

  if (!verifyEmployeeTemplateChecksum(document)) {
    issues.push({
      code: "checksum-mismatch",
      message: "The package checksum does not match its payload.",
      locations: ["integrity.digest"],
    });
  }

  const sensitiveFindings = scanPortableFields(payload);
  if (sensitiveFindings.length > 0) {
    issues.push({
      code: "sensitive-content",
      message: "The package contains credential-like text or a machine-local path.",
      locations: sensitiveFindings.map((finding) => finding.location),
    });
  }

  const executionRequirements = requirementsForExecutionProfile(
    payload.configuration.recommendedExecutionProfile,
  );
  const requiredForCompatibility = Array.from(
    new Set([
      ...skillCapabilities,
      ...declaredCapabilities,
      ...(executionRequirements?.capabilities ?? []),
    ]),
  ).sort();
  const hostRequired =
    payload.configuration.recommendedExecutionProfile !== "none" ||
    requiredForCompatibility.length > 0;
  const availableCapabilities = new Set(
    nodes.flatMap((node) => [
      ...node.capabilities,
      ...node.capabilityManifest.map((capability) => capability.id),
    ]),
  );
  const missingCapabilities = requiredForCompatibility.filter(
    (capability) => !availableCapabilities.has(capability),
  );
  const compatibleHosts = hostRequired
    ? nodes
        .filter((node) => {
          if (
            executionRequirements?.platform !== undefined &&
            node.platform !== executionRequirements.platform
          ) {
            return false;
          }
          const nodeCapabilities = new Set([
            ...node.capabilities,
            ...node.capabilityManifest.map((capability) => capability.id),
          ]);
          return requiredForCompatibility.every((capability) => nodeCapabilities.has(capability));
        })
        .map(({ id, name, platform, architecture, deviceClass }) => ({
          id,
          name,
          platform,
          architecture,
          deviceClass,
        }))
        .sort((left, right) => left.id.localeCompare(right.id))
    : [];

  if (missingCapabilities.length > 0) {
    issues.push({
      code: "missing-capability",
      message: "No connected Worker Host currently advertises one or more required capabilities.",
      locations: missingCapabilities,
    });
  }
  if (hostRequired && compatibleHosts.length === 0) {
    issues.push({
      code: "no-compatible-host",
      message: "No connected Worker Host satisfies the complete package requirement set.",
      locations: [payload.configuration.recommendedExecutionProfile],
    });
  }

  return {
    format: payload.format,
    packageId: payload.packageId,
    generatedAt: payload.generatedAt,
    employee: portableEmployeeSummary(payload.employee),
    recommendedExecutionProfile: payload.configuration.recommendedExecutionProfile,
    skills: payload.skills.map(portableSkillSummary),
    requestedCapabilities: declaredCapabilities,
    integrity: {
      algorithm: "sha256",
      valid: verifyEmployeeTemplateChecksum(document),
      digest: employeeTemplatePackageDigest(document),
    },
    signature:
      payload.signature.status === "dsse"
        ? { status: "dsse", trusted: true, keyid: payload.signature.keyid }
        : { status: "unsigned", trusted: false },
    compatibility: {
      hostRequired,
      compatibleHosts,
      missingCapabilities,
    },
    quarantine: {
      active: true,
      createsNewIdentity: true,
      importedSkillState: "disabled-pending-review",
      hostAuthority: "none",
      memoryCount: 0,
      canActivate: issues.length === 0,
    },
    issues,
    blocked: issues.length > 0,
  };
}

function exportDependencyClosureFindings(
  exportedSkills: EmployeeProfile["skills"],
  exportedSkillSlugs: ReadonlyMap<string, string>,
): EmployeeExportFinding[] {
  return exportedSkills.flatMap((skill, index) =>
    skill.dependencyIds.some((dependencyId) => !exportedSkillSlugs.has(dependencyId))
      ? [
          {
            code: "excluded-skill-dependency" as const,
            location: `skills[${index}].dependencySlugs`,
            message: `Verified skill "${skill.slug}" depends on a skill that is not verified for export.`,
          },
        ]
      : [],
  );
}

function scanPortableFields(payload: EmployeeTemplatePayload): EmployeeExportFinding[] {
  const fields = [
    { location: "employee.name", value: payload.employee.name },
    { location: "employee.role", value: payload.employee.role },
    ...(payload.employee.description === undefined
      ? []
      : [{ location: "employee.description", value: payload.employee.description }]),
    ...payload.skills.flatMap((skill, index) => [
      ...(skill.content
        ? [{ location: `skills[${index}].content.markdown`, value: skill.content.markdown }]
        : []),
      { location: `skills[${index}].slug`, value: skill.slug },
      { location: `skills[${index}].name`, value: skill.name },
      { location: `skills[${index}].description`, value: skill.description },
      { location: `skills[${index}].version`, value: skill.version },
      ...skill.requiredCapabilities.map((value, capabilityIndex) => ({
        location: `skills[${index}].requiredCapabilities[${capabilityIndex}]`,
        value,
      })),
      ...skill.dependencySlugs.map((value, dependencyIndex) => ({
        location: `skills[${index}].dependencySlugs[${dependencyIndex}]`,
        value,
      })),
    ]),
  ];
  const findings: EmployeeExportFinding[] = [];
  for (const field of fields) {
    findings.push(...scanSensitiveText(field.value, field.location, { portable: true }));
  }
  return findings;
}

function portableFileStem(name: string): string {
  const stem = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  if (stem.length === 0) return "employee";
  return windowsReservedNameRegex().test(stem) ? `${stem}-employee` : stem;
}

function asEd25519PrivateKey(key: KeyLike): KeyObject {
  const privateKey = key instanceof KeyObject ? key : createPrivateKey(key);
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("Employee package signing requires an Ed25519 private key.");
  }
  return privateKey;
}

function normalizeTrustedKeys(
  trustedKeys: readonly EmployeeTemplateTrustedKey[],
): Array<{ keyid: string; publicKey: KeyObject }> {
  if (trustedKeys.length > 256) {
    throw new TypeError("Employee package trust stores may contain at most 256 public keys.");
  }
  const seenKeyIds = new Set<string>();
  return trustedKeys.map((trustedKey) => {
    const keyid = trustedKey.keyid.trim();
    if (keyid.length === 0 || keyid.length > 256) {
      throw new TypeError("Every trusted employee-package key needs a 1-256 character key id.");
    }
    if (seenKeyIds.has(keyid)) {
      throw new TypeError(`Duplicate trusted employee-package key id: ${keyid}`);
    }
    seenKeyIds.add(keyid);

    const publicKey =
      trustedKey.publicKey instanceof KeyObject
        ? trustedKey.publicKey
        : createPublicKey(trustedKey.publicKey);
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
      throw new TypeError(`Trusted employee-package key ${keyid} is not an Ed25519 public key.`);
    }
    return { keyid, publicKey };
  });
}

function decodeDsseBase64(value: string): Buffer {
  const unpadded = value.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  if (unpadded.length % 4 === 1) {
    throw new TypeError("Invalid DSSE base64 length.");
  }
  const padded = unpadded.padEnd(unpadded.length + ((4 - (unpadded.length % 4)) % 4), "=");
  const decoded = Buffer.from(padded, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== unpadded) {
    throw new TypeError("Invalid DSSE base64 encoding.");
  }
  return decoded;
}

function portableEmployeeSummary(employee: EmployeeTemplatePayload["employee"]) {
  return {
    name: employee.name,
    role: employee.role,
    ...(employee.description === undefined ? {} : { description: employee.description }),
    ...(employee.appearance === undefined ? {} : { appearance: employee.appearance }),
  };
}

function portableSkillSummary(skill: EmployeeTemplatePayload["skills"][number]) {
  return {
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    requiredCapabilities: skill.requiredCapabilities,
    dependencySlugs: skill.dependencySlugs,
    ...(skill.content ? { content: skill.content } : {}),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
