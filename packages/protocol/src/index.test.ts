import { describe, expect, it } from "vitest";
import {
  activateEmployeeImportInputSchema,
  createBotInputSchema,
  createChannelInputSchema,
  createEmployeeMemoryInputSchema,
  createEmployeeSkillInputSchema,
  createMessageInputSchema,
  createNodeEnrollmentTokenInputSchema,
  deleteEmployeeMemoryInputSchema,
  dsseEnvelopeSchema,
  employeeTemplateDssePayloadType,
  employeeTemplatePackageSchema,
  loginInputSchema,
  nodeEnrollmentResultSchema,
  nodeMessageSchema,
  protocolVersion,
  quickCreateBotInputSchema,
  providerConformanceReportSchema,
  runEventSchema,
  runOfferSchema,
  serverMessageSchema,
  unsignedEmployeeTemplatePackageSchema,
  updateEmployeeMemoryInputSchema,
  updateEmployeeProfileDetailsInputSchema,
  updateEmployeeSkillStateInputSchema,
} from "./index.js";

const nodeCredential = `obn_${"a".repeat(43)}`;

describe("node protocol", () => {
  it("accepts a versioned hello message", () => {
    const result = nodeMessageSchema.safeParse({
      type: "node.hello",
      protocolVersion,
      nodeId: "node-1",
      name: "Windows worker",
      platform: "windows",
      osVersion: "10.0.26100",
      architecture: "arm64",
      deviceClass: "desktop",
      isolation: "dedicated-host",
      trustTier: "dedicated",
      capabilities: ["browser", "shell", "screenshot"],
      capabilityManifest: [
        {
          id: "browser.observe",
          version: 1,
          providerId: "playwright",
          constraints: { engine: "chromium", displays: 1 },
        },
      ],
      maxConcurrentRuns: 1,
      credential: nodeCredential,
      sentAt: new Date().toISOString(),
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      platform: "windows",
      architecture: "arm64",
      deviceClass: "desktop",
      trustTier: "dedicated",
    });
  });

  it("rejects malformed versioned capability claims", () => {
    const result = nodeMessageSchema.safeParse({
      type: "node.hello",
      protocolVersion,
      nodeId: "node-1",
      name: "Unsafe worker",
      platform: "windows",
      capabilities: ["browser"],
      capabilityManifest: [
        { id: "desktop.superuser", version: 0, providerId: "unsafe", constraints: {} },
      ],
      maxConcurrentRuns: 1,
      credential: nodeCredential,
      sentAt: new Date().toISOString(),
    });

    expect(result.success).toBe(false);
  });

  it("rejects unknown capabilities", () => {
    const result = nodeMessageSchema.safeParse({
      type: "node.hello",
      protocolVersion,
      nodeId: "node-1",
      name: "Unsafe worker",
      platform: "linux",
      capabilities: ["root-access"],
      maxConcurrentRuns: 1,
      credential: nodeCredential,
      sentAt: new Date().toISOString(),
    });

    expect(result.success).toBe(false);
  });

  it("rejects ambiguous or unbounded Node envelopes", () => {
    const hello = {
      type: "node.hello",
      protocolVersion,
      nodeId: "node-1",
      name: "Linux worker",
      platform: "linux",
      capabilities: ["browser"],
      maxConcurrentRuns: 1,
      credential: nodeCredential,
      sentAt: new Date().toISOString(),
    };

    expect(nodeMessageSchema.safeParse({ ...hello, unexpectedAuthority: true }).success).toBe(
      false,
    );
    expect(nodeMessageSchema.safeParse({ ...hello, nodeId: "node id" }).success).toBe(false);
    expect(nodeMessageSchema.safeParse({ ...hello, name: "x".repeat(161) }).success).toBe(false);
    expect(
      nodeMessageSchema.safeParse({ ...hello, capabilities: ["browser", "browser"] }).success,
    ).toBe(false);
    expect(nodeMessageSchema.safeParse({ ...hello, credential: "too-short" }).success).toBe(false);
  });

  it("bounds one-time Node enrollment inputs and issued credentials", () => {
    expect(createNodeEnrollmentTokenInputSchema.parse({ nodeId: "linux-node" })).toEqual({
      nodeId: "linux-node",
      expiresInSeconds: 600,
    });
    expect(
      createNodeEnrollmentTokenInputSchema.safeParse({
        nodeId: "linux-node",
        expiresInSeconds: 3601,
      }).success,
    ).toBe(false);
    expect(
      nodeEnrollmentResultSchema.safeParse({
        format: "openbot.node-identity/v1",
        nodeId: "linux-node",
        credential: nodeCredential,
        enrolledAt: new Date().toISOString(),
      }).success,
    ).toBe(true);
  });

  it("bounds approval before-state evidence", () => {
    const approval = {
      type: "approval.request",
      protocolVersion,
      nodeId: "node-1",
      runId: "00000000-0000-4000-8000-000000000001",
      requestId: "00000000-0000-4000-8000-000000000002",
      action: "form.submit",
      target: "https://example.test/form",
      summary: "Submit the form",
      risk: "write",
      beforeState: { fields: 3 },
      expiresInSeconds: 300,
      requestedAt: new Date().toISOString(),
    };

    expect(nodeMessageSchema.safeParse(approval).success).toBe(true);
    expect(
      nodeMessageSchema.safeParse({
        ...approval,
        beforeState: { content: "x".repeat(4097) },
      }).success,
    ).toBe(false);
    expect(
      nodeMessageSchema.safeParse({
        ...approval,
        beforeState: { deep: [[[[[[{}]]]]]] },
      }).success,
    ).toBe(false);
    expect(nodeMessageSchema.safeParse({ ...approval, ignored: true }).success).toBe(false);
  });

  it("bounds public Run failure classifications and defaults legacy messages safely", () => {
    const failure = {
      type: "run.failed",
      protocolVersion,
      nodeId: "node-1",
      runId: "00000000-0000-4000-8000-000000000001",
      error: "Provider execution failed.",
      failedAt: new Date().toISOString(),
    };

    expect(nodeMessageSchema.parse(failure)).toMatchObject({
      code: "provider_execution_failed",
    });
    expect(nodeMessageSchema.safeParse({ ...failure, code: "raw_exception" }).success).toBe(false);
  });

  it("validates the two-phase run assignment messages", () => {
    const offer = {
      type: "run.offer",
      protocolVersion,
      offerId: "00000000-0000-4000-8000-000000000001",
      runId: "00000000-0000-4000-8000-000000000002",
      channelId: "00000000-0000-4000-8000-000000000003",
      botId: "00000000-0000-4000-8000-000000000004",
      title: "打开测试页并截图",
      instruction: "打开 https://example.test 并截图",
      executionProfile: "docker-linux",
      requiredCapabilities: ["browser", "screenshot"],
      requiredCapabilityManifest: [
        { id: "browser.observe", version: 1 },
        { id: "screen.capture", version: 1 },
      ],
      sentAt: new Date().toISOString(),
    };

    expect(runOfferSchema.safeParse(offer).success).toBe(true);
    expect(serverMessageSchema.safeParse(offer).success).toBe(true);
    expect(
      nodeMessageSchema.safeParse({
        type: "run.accept",
        protocolVersion,
        nodeId: "linux-node",
        offerId: offer.offerId,
        runId: offer.runId,
        acceptedAt: new Date().toISOString(),
      }).success,
    ).toBe(true);
    expect(
      runOfferSchema.safeParse({ ...offer, requiredCapabilities: ["root-access"] }).success,
    ).toBe(false);
    expect(
      runOfferSchema.safeParse({
        ...offer,
        requiredCapabilityManifest: [{ id: "desktop.superuser", version: 1 }],
      }).success,
    ).toBe(false);
    expect(
      nodeMessageSchema.safeParse({
        type: "run.frame",
        protocolVersion,
        nodeId: "linux-node",
        runId: offer.runId,
        mediaType: "image/png",
        base64: "iVBORw0KGgo=",
        width: 1280,
        height: 800,
        capturedAt: new Date().toISOString(),
      }).success,
    ).toBe(true);
    expect(
      nodeMessageSchema.safeParse({
        type: "run.frame",
        protocolVersion,
        nodeId: "linux-node",
        runId: offer.runId,
        mediaType: "image/png",
        base64: "a".repeat(2_800_001),
        capturedAt: new Date().toISOString(),
      }).success,
    ).toBe(false);
    expect(
      nodeMessageSchema.safeParse({
        type: "run.completed",
        protocolVersion,
        nodeId: "linux-node",
        runId: offer.runId,
        summary: "已完成截图",
        artifacts: [
          {
            name: "result.png",
            mediaType: "image/png",
            base64: "iVBORw0KGgo=",
          },
        ],
        completedAt: new Date().toISOString(),
      }).success,
    ).toBe(true);
    expect(
      nodeMessageSchema.safeParse({
        type: "run.completed",
        protocolVersion,
        nodeId: "linux-node",
        runId: offer.runId,
        summary: "伪造截图",
        artifacts: [
          {
            name: "result.png",
            mediaType: "image/png",
            base64: "not base64!!!",
            metadata: { secret: "unbounded metadata is not accepted" },
          },
        ],
        completedAt: new Date().toISOString(),
      }).success,
    ).toBe(false);
  });
});

describe("run events", () => {
  it("requires structured event payloads", () => {
    expect(
      runEventSchema.safeParse({
        id: "event-1",
        type: "RUN_CREATED",
        runId: "run-1",
        channelId: "channel-1",
        botId: "bot-1",
        createdAt: new Date().toISOString(),
        payload: { title: "Fill a test form" },
      }).success,
    ).toBe(true);
  });
});

describe("control plane inputs", () => {
  it("trims Bot fields and validates its computer profile", () => {
    expect(
      createBotInputSchema.parse({
        name: "  Ops  ",
        role: "  Browser operations  ",
        computerProfile: "docker-linux",
      }),
    ).toEqual({
      name: "Ops",
      role: "Browser operations",
      computerProfile: "docker-linux",
    });
  });

  it("quick creation accepts only a complete appearance and cannot override Server defaults", () => {
    const appearance = {
      head: "round",
      body: "classic",
      mobility: "feet",
      accessory: "none",
      accent: "green",
    };
    expect(quickCreateBotInputSchema.parse({ appearance })).toEqual({ appearance });
    for (const input of [
      {},
      { appearance: null },
      { appearance: { head: "round" } },
      { appearance, name: "override" },
      { appearance, computerProfile: "docker-linux" },
      { appearance: { ...appearance, grant: "admin" } },
    ])
      expect(quickCreateBotInputSchema.safeParse(input).success).toBe(false);
  });

  it("validates the five composable Bot appearance layers", () => {
    const appearance = {
      head: "cat",
      body: "cape",
      mobility: "hover",
      accessory: "headphones",
      accent: "red",
    } as const;
    expect(
      createBotInputSchema.parse({
        name: "Scout",
        role: "Research",
        computerProfile: "docker-linux",
        appearance,
      }).appearance,
    ).toEqual(appearance);
    expect(
      createBotInputSchema.safeParse({
        name: "Scout",
        role: "Research",
        appearance: { ...appearance, mobility: "teleport" },
      }).success,
    ).toBe(false);
  });

  it("deduplicates a channel roster", () => {
    const botId = "00000000-0000-4000-8000-000000000001";
    expect(
      createChannelInputSchema.parse({
        name: "Operations",
        description: "",
        botIds: [botId, botId],
      }).botIds,
    ).toEqual([botId]);
  });

  it("trims local messages and rejects empty content", () => {
    expect(createMessageInputSchema.parse({ content: "  继续检查表单  " })).toEqual({
      content: "继续检查表单",
    });
    expect(createMessageInputSchema.safeParse({ content: "   " }).success).toBe(false);
  });

  it("accepts an optional Bot assignment for a channel task", () => {
    const botId = "00000000-0000-4000-8000-000000000001";
    const replyToMessageId = "00000000-0000-4000-8000-000000000002";
    expect(
      createMessageInputSchema.parse({ content: "  执行任务  ", botId, replyToMessageId }),
    ).toEqual({
      content: "执行任务",
      botId,
      replyToMessageId,
    });
    expect(
      createMessageInputSchema.safeParse({ content: "执行任务", botId: "not-an-id" }).success,
    ).toBe(false);
  });

  it("bounds login input without normalizing the password", () => {
    expect(loginInputSchema.parse({ password: "  keep spaces  " })).toEqual({
      password: "  keep spaces  ",
    });
    expect(loginInputSchema.safeParse({ password: "" }).success).toBe(false);
    expect(loginInputSchema.safeParse({ password: "x".repeat(1025) }).success).toBe(false);
  });
});

describe("portable employee format", () => {
  const employeePackage = {
    payload: {
      format: "openbot.employee/v1",
      kind: "template",
      packageId: "00000000-0000-4000-8000-000000000099",
      generatedAt: "2026-09-04T00:00:00.000Z",
      employee: { name: "Ops", role: "Browser operations" },
      configuration: { recommendedExecutionProfile: "docker-linux" },
      skills: [],
      requestedCapabilities: [],
      portability: {
        identity: "new-on-import",
        authority: "none",
        memories: "none",
        importedSkillState: "disabled-pending-review",
      },
      signature: { status: "unsigned" },
    },
    integrity: {
      algorithm: "sha256",
      canonicalization: "openbot-json-v1",
      digest: "a".repeat(64),
    },
  };

  it("accepts the bounded identity-free template", () => {
    expect(employeeTemplatePackageSchema.safeParse(employeePackage).success).toBe(true);
    expect(unsignedEmployeeTemplatePackageSchema.safeParse(employeePackage).success).toBe(true);
  });

  it("rejects undeclared authority and credential fields at every level", () => {
    expect(
      employeeTemplatePackageSchema.safeParse({
        ...employeePackage,
        payload: { ...employeePackage.payload, credentials: { token: "hidden" } },
      }).success,
    ).toBe(false);
    expect(
      employeeTemplatePackageSchema.safeParse({
        ...employeePackage,
        payload: {
          ...employeePackage.payload,
          employee: { ...employeePackage.payload.employee, sourceEmployeeId: "source-id" },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts forward-compatible DSSE metadata and rejects malformed base64", () => {
    expect(
      dsseEnvelopeSchema.safeParse({
        payload: Buffer.from(JSON.stringify(employeePackage)).toString("base64"),
        payloadType: employeeTemplateDssePayloadType,
        signatures: [{ keyid: "owner-key", sig: Buffer.from("signature").toString("base64") }],
        futureEnvelopeField: true,
      }).success,
    ).toBe(true);

    expect(
      dsseEnvelopeSchema.safeParse({
        payload: "not base64!",
        payloadType: employeeTemplateDssePayloadType,
        signatures: [{ sig: "also not base64!" }],
      }).success,
    ).toBe(false);
  });

  it("requires signed package metadata to arrive inside a verified DSSE envelope", () => {
    expect(
      unsignedEmployeeTemplatePackageSchema.safeParse({
        ...employeePackage,
        payload: {
          ...employeePackage.payload,
          signature: { status: "dsse", algorithm: "ed25519", keyid: "owner-key" },
        },
      }).success,
    ).toBe(false);
  });

  it("binds activation to explicit Owner review, digest, and idempotency", () => {
    const input = {
      package: employeePackage,
      expectedPackageId: employeePackage.payload.packageId,
      expectedDigest: "b".repeat(64),
      ownerReviewed: true,
      allowUnsigned: true,
      idempotencyKey: "00000000-0000-4000-8000-000000000700",
      employeeName: "Ops Copy",
    };
    expect(activateEmployeeImportInputSchema.safeParse(input).success).toBe(true);
    expect(
      activateEmployeeImportInputSchema.safeParse({ ...input, ownerReviewed: false }).success,
    ).toBe(false);
    expect(
      activateEmployeeImportInputSchema.safeParse({ ...input, unexpectedAuthority: true }).success,
    ).toBe(false);
  });
});

describe("employee skill commands", () => {
  it("normalizes a candidate skill without allowing direct verification", () => {
    expect(
      createEmployeeSkillInputSchema.parse({
        slug: "browser-observe",
        name: "Observe browser",
        description: "Observe public webpages without interacting with them.",
        version: "1.0.0",
        source: "manual",
        requiredCapabilities: ["browser.observe", "browser.observe"],
        reason: "Prepare a candidate for Owner review.",
      }),
    ).toMatchObject({
      slug: "browser-observe",
      requiredCapabilities: ["browser.observe"],
      dependencySkillIds: [],
      evidence: [],
    });
    expect(
      createEmployeeSkillInputSchema.safeParse({
        slug: "Unsafe Skill",
        name: "Unsafe",
        description: "Attempts to bypass review.",
        version: "latest",
        source: "manual",
        state: "verified",
        reason: "Bypass review",
      }).success,
    ).toBe(false);
  });

  it("requires explicit Owner review and bounded confidence for verification", () => {
    expect(
      updateEmployeeSkillStateInputSchema.safeParse({
        state: "verified",
        confidence: 90,
        reason: "Passed the deterministic fixture.",
        ownerReviewed: true,
      }).success,
    ).toBe(true);
    expect(
      updateEmployeeSkillStateInputSchema.safeParse({
        state: "verified",
        confidence: 90,
        reason: "No explicit review",
      }).success,
    ).toBe(false);
    expect(
      updateEmployeeSkillStateInputSchema.safeParse({
        state: "verified",
        confidence: 101,
        reason: "Invalid confidence",
        ownerReviewed: true,
      }).success,
    ).toBe(false);
  });
});

describe("employee memory commands", () => {
  const memory = {
    kind: "semantic",
    title: "Preferred report format",
    content: "Use a short summary before the evidence table.",
    sensitivity: "internal",
    portability: "owner-selectable",
  } as const;

  it("accepts bounded Owner memory fields and excludes direct package inclusion", () => {
    expect(createEmployeeMemoryInputSchema.parse(memory)).toEqual(memory);
    expect(
      createEmployeeMemoryInputSchema.safeParse({ ...memory, portability: "included" }).success,
    ).toBe(false);
    expect(
      createEmployeeMemoryInputSchema.safeParse({ ...memory, content: "x".repeat(8001) }).success,
    ).toBe(false);
  });

  it("requires the restricted, never-portable policy for secret references", () => {
    expect(
      createEmployeeMemoryInputSchema.safeParse({
        ...memory,
        kind: "secret-reference",
        sensitivity: "restricted",
        portability: "never",
      }).success,
    ).toBe(true);
    expect(
      createEmployeeMemoryInputSchema.safeParse({ ...memory, kind: "secret-reference" }).success,
    ).toBe(false);
  });

  it("requires an optimistic revision, a real change, and explicit delete review", () => {
    expect(
      updateEmployeeMemoryInputSchema.safeParse({ expectedRevision: 2, title: "New title" })
        .success,
    ).toBe(true);
    expect(updateEmployeeMemoryInputSchema.safeParse({ expectedRevision: 2 }).success).toBe(false);
    expect(
      deleteEmployeeMemoryInputSchema.safeParse({ expectedRevision: 2, ownerReviewed: true })
        .success,
    ).toBe(true);
    expect(
      deleteEmployeeMemoryInputSchema.safeParse({ expectedRevision: 2, ownerReviewed: false })
        .success,
    ).toBe(false);
  });
});

describe("Employee profile details commands", () => {
  const input = {
    role: "Evidence reviewer",
    description: "Review evidence and document limitations.",
    expectedRevision: 2,
  };

  it("accepts only bounded descriptive fields with an optimistic revision", () => {
    expect(updateEmployeeProfileDetailsInputSchema.parse(input)).toEqual(input);
    expect(
      updateEmployeeProfileDetailsInputSchema.safeParse({
        ...input,
        computerProfile: "macos-cua",
      }).success,
    ).toBe(false);
    expect(updateEmployeeProfileDetailsInputSchema.safeParse({ ...input, role: " " }).success).toBe(
      false,
    );
    expect(
      updateEmployeeProfileDetailsInputSchema.safeParse({
        ...input,
        description: "x".repeat(2001),
      }).success,
    ).toBe(false);
  });
});

describe("Provider conformance reports", () => {
  const report = {
    format: "openbot.provider-conformance/v1",
    generatedAt: "2026-09-04T00:00:00.000Z",
    protocolVersion,
    suite: { name: "openbot-provider", version: "1.0.0", stage: "declaration" },
    provider: {
      id: "browser-driver",
      displayName: "Browser driver",
      version: "0.1.0",
      executionStatus: "declaration-only",
    },
    target: {
      platform: "linux",
      architecture: "x64",
      osVersion: "6.8.0",
      evidenceLevel: "simulated",
    },
    checks: [
      {
        id: "provider.declaration",
        name: "Provider declaration",
        description: "Static metadata is valid.",
        status: "success",
        severity: "required",
        timestamp: "2026-09-04T00:00:00.000Z",
        references: [],
        evidence: [],
      },
      {
        id: "provider.target-platform",
        name: "Target platform declaration",
        description: "The Provider declares the target platform.",
        status: "success",
        severity: "required",
        timestamp: "2026-09-04T00:00:00.000Z",
        references: [],
        evidence: [],
      },
    ],
    baseline: { expectedFailures: [], unexpectedFailures: [], staleEntries: [] },
    summary: {
      success: 2,
      failure: 0,
      warning: 0,
      skipped: 0,
      info: 0,
      total: 2,
      expectedFailureEntries: 0,
      conformant: true,
      baselineCurrent: true,
    },
  } as const;

  it("accepts a self-consistent bounded report", () => {
    expect(providerConformanceReportSchema.safeParse(report).success).toBe(true);
  });

  it("rejects edited summaries and required checks hidden as skipped", () => {
    expect(
      providerConformanceReportSchema.safeParse({
        ...report,
        summary: { ...report.summary, failure: 1, conformant: false },
      }).success,
    ).toBe(false);
    expect(
      providerConformanceReportSchema.safeParse({
        ...report,
        checks: [{ ...report.checks[0], status: "skipped" }],
        summary: {
          ...report.summary,
          success: 0,
          skipped: 1,
          conformant: false,
          baselineCurrent: false,
        },
        baseline: {
          expectedFailures: [],
          unexpectedFailures: ["provider.declaration"],
          staleEntries: [],
        },
      }).success,
    ).toBe(false);
    expect(providerConformanceReportSchema.safeParse({ ...report, supported: true }).success).toBe(
      false,
    );
  });

  it("rejects real-device reports without reproducible target metadata and generated checks", () => {
    expect(
      providerConformanceReportSchema.safeParse({
        ...report,
        suite: { ...report.suite, stage: "real-device" },
        target: { ...report.target, evidenceLevel: "real-device" },
      }).success,
    ).toBe(false);
  });
});

describe("multiple channel recipients", () => {
  const first = "00000000-0000-4000-8000-000000000001";
  const second = "00000000-0000-4000-8000-000000000002";
  it("accepts exact unique recipients without a legacy botId", () => {
    expect(createMessageInputSchema.parse({ content: "Review", botIds: [second, first] })).toEqual({
      content: "Review",
      botIds: [second, first],
    });
  });
  it.each([
    { botIds: [] },
    { botIds: [first, first] },
    { botIds: ["invalid"] },
    { botIds: [first], botId: second },
    { botIds: Array.from({ length: 7 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`) },
  ])("rejects invalid recipient shape %j", (input) => {
    expect(createMessageInputSchema.safeParse({ content: "Review", ...input }).success).toBe(false);
  });
});
