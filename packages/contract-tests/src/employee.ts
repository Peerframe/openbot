import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  controlHttpErrorSchema,
  employeeProfileResponseSchema,
  employeeProfileMutationSchema,
  botAppearanceResultSchema,
  employeeMemoryMutationSchema,
  employeeMemoryDeletionSchema,
  employeeSkillMutationSchema,
  knowledgeProposalsResponseSchema,
  knowledgeProposalReviewResponseSchema,
  auditPageSchema,
} from "@openbot/protocol";
import { contractClient, type RequestOptions } from "./client.ts";
import {
  contractTargetSchema,
  employeeScenarioSchema,
  type ContractTarget,
  type EmployeeScenario,
} from "./target.ts";

/** Published proposal sources are synthetic; every Owner transaction uses the real HTTP entry. */
export async function runEmployeeContracts(input: ContractTarget, scenario: EmployeeScenario) {
  const target = contractTargetSchema.parse(input),
    seeded = employeeScenarioSchema.parse(scenario);
  const client = contractClient(target),
    { request } = client;
  const base = `/api/v1/bots/${seeded.botId}`,
    passed: string[] = [];
  const check = async (name: string, action: () => Promise<void>) => {
    await action();
    passed.push(name);
  };
  const error = async (path: string, status: number, options: RequestOptions = {}) => {
    const result = await request(path, options);
    assert.equal(result.response.status, status);
    controlHttpErrorSchema.parse(result.body);
    return result;
  };
  const profile = async () => {
    const result = await request(`${base}/profile`);
    assert.equal(result.response.status, 200);
    return employeeProfileResponseSchema.parse(result.body).profile;
  };
  const proposals = async () => {
    const result = await request(`${base}/knowledge-proposals`);
    assert.equal(result.response.status, 200);
    return knowledgeProposalsResponseSchema.parse(result.body).proposals;
  };
  for (const [path, method] of [
    ["/profile", "GET"],
    ["/profile", "PATCH"],
    ["/appearance", "PATCH"],
    ["/skills", "POST"],
    ["/skills/import", "POST"],
    [`/skills/${randomUUID()}/state`, "POST"],
    ["/memories", "POST"],
    [`/memories/${randomUUID()}`, "PATCH"],
    [`/memories/${randomUUID()}`, "DELETE"],
    ["/knowledge-proposals", "GET"],
    [`/knowledge-proposals/${seeded.proposals.accept}/review`, "POST"],
  ] as const)
    await check(`Owner authentication ${method} ${path}`, () =>
      error(`${base}${path}`, 401, {
        method,
        cookie: false,
        ...(method !== "GET" ? { rawBody: "invalid" } : {}),
      }).then(() => {}),
    );
  await check("Origin authorization precedes profile, appearance and memory parsing", async () => {
    for (const [path, method] of [
      ["/profile", "PATCH"],
      ["/appearance", "PATCH"],
      ["/memories", "POST"],
    ] as const)
      await error(`${base}${path}`, 403, {
        method,
        origin: "https://foreign.invalid",
        rawBody: "invalid",
      });
  });
  const privateContent = `Synthetic private memory ${randomUUID()}`;
  await check(
    "aggregate profile projects bounded persisted records and descriptive configuration",
    async () => {
      const data = await profile();
      assert.equal(data.employee.id, seeded.botId);
      assert.equal(data.details.revision, 1);
      assert.equal(data.configuration.executionProfile, "none");
      assert.equal(data.configuration.portabilityFormat, "openbot.employee/v1");
      assert.equal(data.memories.length, 0);
      assert.equal(data.skills.length, 0);
      assert.equal(data.statistics.totalRuns, data.records.runs.length);
      assert.equal(
        data.statistics.completedRuns,
        data.records.runs.filter((run) => run.status === "completed").length,
      );
    },
  );
  await check(
    "profile trim, mathematical integer revision, conflict and unchanged rejection",
    async () => {
      const initial = await profile();
      const body = {
        role: " Reviewed role ",
        description: " Synthetic biography ",
        expectedRevision: initial.details.revision,
      };
      await error(`${base}/profile`, 422, { method: "PATCH", body: { ...body, extra: true } });
      const updated = await request(`${base}/profile`, {
        method: "PATCH",
        rawBody: JSON.stringify(body).replace(/"expectedRevision":1/, '"expectedRevision":1.0'),
      });
      assert.equal(updated.response.status, 200);
      const data = employeeProfileMutationSchema.parse(updated.body);
      assert.equal(data.employee.role, "Reviewed role");
      assert.equal(data.details.description, "Synthetic biography");
      assert.equal(data.details.revision, initial.details.revision + 1);
      assert.equal(data.evolution.type, "role_changed");
      assert.deepEqual(data.evolution.evidence, []);
      await error(`${base}/profile`, 409, { method: "PATCH", body });
      await error(`${base}/profile`, 422, {
        method: "PATCH",
        body: { ...body, expectedRevision: data.details.revision },
      });
    },
  );
  await check("concurrent profile writers commit one revision and one evolution", async () => {
    const before = await profile();
    const results = await Promise.all(
      ["Writer A", "Writer B"].map((description) =>
        request(`${base}/profile`, {
          method: "PATCH",
          body: {
            role: before.employee.role,
            description,
            expectedRevision: before.details.revision,
          },
        }),
      ),
    );
    assert.deepEqual(results.map((result) => result.response.status).sort(), [200, 409]);
    const after = await profile();
    assert.equal(after.details.revision, before.details.revision + 1);
    assert.equal(after.evolution.length, before.evolution.length + 1);
    assert.equal(after.evolution[0]?.type, "configuration_changed");
  });
  const appearanceAudit = async () => {
    const result = await request("/api/v1/audit?category=bots&limit=100");
    assert.equal(result.response.status, 200);
    return auditPageSchema
      .parse(result.body)
      .events.filter(
        (event) => event.botId === seeded.botId && event.type === "EMPLOYEE_APPEARANCE_UPDATED",
      );
  };
  await check(
    "appearance requires a complete strict shape and bounded integer revision/body",
    async () => {
      const before = await profile();
      const appearance = {
        head: "round",
        body: "classic",
        mobility: "feet",
        accessory: "none",
        accent: "slate",
      };
      const body = { expectedRevision: before.details.revision, appearance };
      for (const invalid of [
        { ...body, extra: true },
        { ...body, appearance: null },
        { ...body, appearance: { ...appearance, extra: true } },
        { ...body, appearance: { head: "round" } },
        { ...body, appearance: { ...appearance, accent: "orange" } },
        ...[true, "1", 0, 1.5, Number.MAX_SAFE_INTEGER + 1].map((expectedRevision) => ({
          ...body,
          expectedRevision,
        })),
      ])
        await error(`${base}/appearance`, 422, { method: "PATCH", body: invalid });
      await error(`${base}/appearance`, 413, {
        method: "PATCH",
        rawBody: JSON.stringify({ ...body, extra: "x".repeat(2049) }),
      });
      assert.deepEqual(await profile(), before);
    },
  );
  await check(
    "appearance changes share the profile revision; no-op adds no audit or evolution",
    async () => {
      const before = await profile();
      const auditBefore = await appearanceAudit();
      const appearance = {
        head: "cat",
        body: "classic",
        mobility: "feet",
        accessory: "none",
        accent: before.employee.appearance?.accent === "slate" ? "blue" : "slate",
      };
      const body = { expectedRevision: before.details.revision, appearance };
      const response = await request(`${base}/appearance`, { method: "PATCH", body });
      assert.equal(response.response.status, 200);
      const result = botAppearanceResultSchema.parse(response.body);
      assert.equal(result.revision, before.details.revision + 1);
      assert.deepEqual(result.bot.appearance, appearance);
      assert.equal(result.bot.computerProfile, before.employee.computerProfile);
      assert.deepEqual(result.bot.model, before.employee.model);
      const after = await profile();
      assert.equal(after.details.revision, result.revision);
      assert.deepEqual(after.evolution, before.evolution);
      assert.deepEqual(after.skills, before.skills);
      const audit = await appearanceAudit();
      assert.equal(audit.length, auditBefore.length + 1);
      assert.deepEqual(audit[0]?.details, { actor: "owner", revision: result.revision });
      const noOpBody = JSON.stringify({ ...body, expectedRevision: result.revision }).replace(
        `"expectedRevision":${result.revision}`,
        `"expectedRevision":${result.revision}.0`,
      );
      const noOp = await request(`${base}/appearance`, { method: "PATCH", rawBody: noOpBody });
      assert.equal(noOp.response.status, 200);
      assert.deepEqual(botAppearanceResultSchema.parse(noOp.body), result);
      await error(`${base}/appearance`, 409, { method: "PATCH", body });
      await error(`/api/v1/bots/${randomUUID()}/appearance`, 404, {
        method: "PATCH",
        body: { ...body, expectedRevision: result.revision },
      });
      assert.deepEqual(await profile(), after);
      assert.deepEqual(await appearanceAudit(), audit);
    },
  );
  await check(
    "concurrent appearance/profile writers commit exactly one shared revision",
    async () => {
      const before = await profile();
      const auditBefore = await appearanceAudit();
      assert(before.employee.appearance);
      const responses = await Promise.all([
        request(`${base}/appearance`, {
          method: "PATCH",
          body: {
            expectedRevision: before.details.revision,
            appearance: {
              ...before.employee.appearance,
              accent: before.employee.appearance.accent === "pink" ? "teal" : "pink",
            },
          },
        }),
        request(`${base}/profile`, {
          method: "PATCH",
          body: {
            expectedRevision: before.details.revision,
            role: before.employee.role,
            description: `Concurrent biography ${randomUUID()}`,
          },
        }),
      ]);
      assert.deepEqual(responses.map((result) => result.response.status).sort(), [200, 409]);
      const appearanceWon = responses[0]?.response.status === 200;
      if (appearanceWon) botAppearanceResultSchema.parse(responses[0]?.body);
      else employeeProfileMutationSchema.parse(responses[1]?.body);
      const after = await profile();
      assert.equal(after.details.revision, before.details.revision + 1);
      assert.equal(after.evolution.length, before.evolution.length + (appearanceWon ? 0 : 1));
      assert.equal((await appearanceAudit()).length, auditBefore.length + (appearanceWon ? 1 : 0));
      assert.equal(after.employee.computerProfile, before.employee.computerProfile);
      assert.deepEqual(after.employee.model, before.employee.model);
    },
  );
  const memoryInput = {
    kind: "semantic",
    title: " Checked fact ",
    content: ` ${privateContent} `,
    sensitivity: "internal",
    portability: "never",
  };
  let memoryId = "",
    revision = 0;
  await check(
    "memory creation trims text and defaults model use off with Owner provenance",
    async () => {
      const result = await request(`${base}/memories`, { method: "POST", body: memoryInput });
      assert.equal(result.response.status, 201);
      const data = employeeMemoryMutationSchema.parse(result.body);
      memoryId = data.memory.id;
      revision = data.memory.revision;
      assert.equal(data.memory.title, "Checked fact");
      assert.equal(data.memory.content, privateContent);
      assert.equal(data.memory.modelUseEnabled, false);
      assert.equal(revision, 1);
      assert.deepEqual(data.memory.provenance, { source: "owner", actor: "owner" });
      assert.equal(data.event.action, "created");
      assert(!data.event.changedFields.includes("modelUseEnabled"));
    },
  );
  await check(
    "memory UTF-16, NUL, secret scanning, null and body bounds fail before mutation",
    async () => {
      const before = await profile();
      for (const changes of [
        { title: "😀".repeat(81) },
        { content: "a\0b" },
        { content: "api_key = synthetic-private-secret" },
        { modelUseEnabled: null },
        { extra: true },
      ])
        await error(`${base}/memories`, 422, {
          method: "POST",
          body: { ...memoryInput, ...changes },
        });
      await error(`${base}/memories`, 413, {
        method: "POST",
        body: { ...memoryInput, content: "x".repeat(32769) },
      });
      // Reject malformed Unicode before storage, without changing the Employee.
      await error(`${base}/memories`, 422, {
        method: "POST",
        body: { ...memoryInput, content: "\ud800" },
      });
      const boundary = await request(`${base}/memories`, {
        method: "POST",
        body: { ...memoryInput, title: "😀".repeat(80) },
      });
      assert.equal(boundary.response.status, 201);
      const temporary = employeeMemoryMutationSchema.parse(boundary.body).memory;
      await request(`${base}/memories/${temporary.id}`, {
        method: "DELETE",
        body: { expectedRevision: temporary.revision, ownerReviewed: true },
      }).then((result) => assert.equal(result.response.status, 200));
      assert.equal((await profile()).memories.length, before.memories.length);
    },
  );
  await check(
    "memory CAS, scoped identity and no-op preserve history on rejected writes",
    async () => {
      const before = await profile();
      await error(`${base}/memories/${memoryId}`, 409, {
        method: "PATCH",
        body: { expectedRevision: revision + 1, title: "Stale" },
      });
      await error(`${base}/memories/${memoryId}`, 422, {
        method: "PATCH",
        body: { expectedRevision: revision, title: "Checked fact" },
      });
      await error(`/api/v1/bots/${target.botId}/memories/${memoryId}`, 404, {
        method: "PATCH",
        body: { expectedRevision: revision, title: "Wrong identity" },
      });
      assert.equal((await profile()).memoryEvents.length, before.memoryEvents.length);
      const result = await request(`${base}/memories/${memoryId}`, {
        method: "PATCH",
        body: {
          expectedRevision: revision,
          content: "Corrected safe evidence",
          modelUseEnabled: true,
        },
      });
      assert.equal(result.response.status, 200);
      const data = employeeMemoryMutationSchema.parse(result.body);
      assert.equal(data.memory.modelUseEnabled, true);
      assert.deepEqual(data.event.changedFields, ["content", "modelUseEnabled"]);
      revision = data.memory.revision;
      assert.equal(revision, 2);
    },
  );
  await check("merged memory sensitivity cannot silently retain model-use authority", async () => {
    await error(`${base}/memories/${memoryId}`, 422, {
      method: "PATCH",
      body: { expectedRevision: revision, sensitivity: "confidential" },
    });
    assert.equal(
      (await profile()).memories.find((memory) => memory.id === memoryId)?.revision,
      revision,
    );
    const result = await request(`${base}/memories/${memoryId}`, {
      method: "PATCH",
      body: { expectedRevision: revision, sensitivity: "confidential", modelUseEnabled: false },
    });
    assert.equal(result.response.status, 200);
    const data = employeeMemoryMutationSchema.parse(result.body);
    assert.equal(data.memory.modelUseEnabled, false);
    revision = data.memory.revision;
  });
  await check(
    "reviewed memory deletion is revision-bound and retains content-free metadata",
    async () => {
      await error(`${base}/memories/${memoryId}`, 422, {
        method: "DELETE",
        body: { expectedRevision: revision, ownerReviewed: false },
      });
      await error(`${base}/memories/${memoryId}`, 409, {
        method: "DELETE",
        body: { expectedRevision: revision - 1, ownerReviewed: true },
      });
      const result = await request(`${base}/memories/${memoryId}`, {
        method: "DELETE",
        body: { expectedRevision: revision, ownerReviewed: true },
      });
      assert.equal(result.response.status, 200);
      const data = employeeMemoryDeletionSchema.parse(result.body);
      assert.equal(data.memoryId, memoryId);
      assert.equal(data.event.revision, revision + 1);
      assert.deepEqual(data.event.changedFields, []);
      await error(`${base}/memories/${memoryId}`, 404, {
        method: "DELETE",
        body: { expectedRevision: revision, ownerReviewed: true },
      });
      assert(!(await profile()).memories.some((memory) => memory.id === memoryId));
    },
  );
  const slug = `evidence-${randomUUID()}`,
    skillInput = {
      slug,
      name: " Evidence skill ",
      description: " Read evidence ",
      version: "1.0.0",
      source: "manual",
      reason: "Owner added candidate",
      requiredCapabilities: ["shell", "browser", "shell"],
    };
  let skillId = "",
    dependentId = "";
  await check(
    "descriptive skills begin as candidates with deduplicated capabilities and no grants",
    async () => {
      const result = await request(`${base}/skills`, { method: "POST", body: skillInput });
      assert.equal(result.response.status, 201);
      const data = employeeSkillMutationSchema.parse(result.body);
      skillId = data.skill.id;
      assert.equal(data.skill.state, "candidate");
      assert.equal(data.skill.confidence, 0);
      assert.deepEqual(data.skill.requiredCapabilities, ["browser", "shell"]);
      assert.deepEqual(data.skill.dependencyIds, []);
      assert(!("skillMarkdown" in data.skill) && !("modelUseEnabled" in data.skill));
      assert.equal(data.evolution.type, "skill_discovered");
      assert.equal((await profile()).configuration.executionProfile, "none");
    },
  );
  await check(
    "skill admission refuses unadmitted capabilities, duplicate assignment and unverified dependencies",
    async () => {
      await error(`${base}/skills`, 422, {
        method: "POST",
        body: {
          ...skillInput,
          slug: `invalid-${randomUUID()}`,
          requiredCapabilities: ["browser.session"],
        },
      });
      await error(`${base}/skills`, 422, {
        method: "POST",
        body: { ...skillInput, slug: `dependent-${randomUUID()}`, dependencySkillIds: [skillId] },
      });
      await error(`${base}/skills`, 409, { method: "POST", body: skillInput });
      await error(`${base}/skills`, 409, {
        method: "POST",
        body: { ...skillInput, name: "Conflicting definition" },
      });
      assert.equal(
        (await profile()).skills.find((skill) => skill.id === skillId)?.name,
        "Evidence skill",
      );
    },
  );
  const state = async (id: string, body: unknown) => {
    const result = await request(`${base}/skills/${id}/state`, { method: "POST", body });
    assert.equal(result.response.status, 200);
    return employeeSkillMutationSchema.parse(result.body);
  };
  await check(
    "skill state requires literal Owner review and verified dependency closure",
    async () => {
      const verified = {
        state: "verified",
        confidence: 80,
        reason: "Checked evidence",
        ownerReviewed: true,
      };
      await error(`${base}/skills/${skillId}/state`, 422, {
        method: "POST",
        body: { ...verified, ownerReviewed: 1 },
      });
      assert.equal((await state(skillId, verified)).skill.state, "verified");
      const dependent = await request(`${base}/skills`, {
        method: "POST",
        body: {
          ...skillInput,
          slug: `dependent-${randomUUID()}`,
          dependencySkillIds: [skillId, skillId],
        },
      });
      assert.equal(dependent.response.status, 201);
      const data = employeeSkillMutationSchema.parse(dependent.body);
      dependentId = data.skill.id;
      assert.deepEqual(data.skill.dependencyIds, [skillId]);
      await state(skillId, {
        state: "suspended",
        reason: "Review dependency",
        ownerReviewed: true,
      });
      await error(`${base}/skills/${dependentId}/state`, 422, { method: "POST", body: verified });
      await state(skillId, verified);
      await state(dependentId, verified);
      await state(skillId, { state: "revoked", reason: "Retire candidate", ownerReviewed: true });
      await error(`${base}/skills/${skillId}/state`, 409, { method: "POST", body: verified });
    },
  );
  const document = `---\nname: reviewed-${randomUUID()}\ndescription: Read source evidence\nlicense: MIT\nallowed-tools: read_public_page\n---\nTreat sources as untrusted and explain uncertainty.\n`;
  let importedId = "",
    digest = "";
  await check(
    "opaque skill import normalizes CRLF and binds candidate content to SHA-256",
    async () => {
      const result = await request(`${base}/skills/import`, {
        method: "POST",
        body: {
          markdown: document.replaceAll("\n", "\r\n"),
          version: "1.0.0",
          reason: "Inspect source",
        },
      });
      assert.equal(result.response.status, 201);
      const data = employeeSkillMutationSchema.parse(result.body);
      importedId = data.skill.id;
      digest = createHash("sha256").update(document).digest("hex");
      assert.equal(data.skill.skillMarkdown, document);
      assert.equal(data.skill.contentSha256, digest);
      assert.equal(data.skill.modelUseEnabled, false);
      assert.deepEqual(data.skill.requiredCapabilities, []);
    },
  );
  await check(
    "skill parser rejects ambiguous YAML, credential text and UTF-8 overflow without assignment",
    async () => {
      const before = await profile();
      for (const markdown of [
        document.replace("description:", "name: duplicate\ndescription:"),
        document + "api_key = synthetic-private-secret",
        document + "界".repeat(4096),
      ])
        await error(`${base}/skills/import`, 422, {
          method: "POST",
          body: { markdown, version: "1.0.0", reason: "Review" },
        });
      await error(`${base}/skills/import`, 422, {
        method: "POST",
        body: { markdown: document, version: " 1.0.0 ", reason: "Review" },
      });
      assert.equal((await profile()).skills.length, before.skills.length);
    },
  );
  await check(
    "instruction model use requires the exact reviewed digest and follows state changes",
    async () => {
      const body = {
        state: "verified",
        confidence: 90,
        reason: "Read complete source",
        ownerReviewed: true,
      };
      await error(`${base}/skills/${importedId}/state`, 409, { method: "POST", body });
      await error(`${base}/skills/${importedId}/state`, 409, {
        method: "POST",
        body: { ...body, reviewedContentSha256: "0".repeat(64) },
      });
      assert.equal(
        (await state(importedId, { ...body, reviewedContentSha256: digest })).skill.modelUseEnabled,
        true,
      );
      assert.equal(
        (await state(importedId, { state: "suspended", reason: "Pause use", ownerReviewed: true }))
          .skill.modelUseEnabled,
        false,
      );
      assert.equal(
        (await state(importedId, { ...body, reviewedContentSha256: digest })).skill.modelUseEnabled,
        true,
      );
      assert.equal(
        (
          await state(importedId, {
            state: "revoked",
            reason: "Retire instructions",
            ownerReviewed: true,
          })
        ).skill.modelUseEnabled,
        false,
      );
    },
  );
  await check(
    "pending proposals preserve distinct legacy Run and native Work source identities",
    async () => {
      const values = await proposals();
      assert.equal(values.length, 4);
      const legacy = values.find((proposal) => proposal.id === seeded.proposals.accept);
      assert(legacy && "sourceRunId" in legacy);
      assert.equal(legacy.sourceRunId, seeded.sourceRunId);
      const native = values.find((proposal) => proposal.id === seeded.proposals.native);
      assert(native && "source" in native);
      assert.deepEqual(native.source, {
        kind: "task",
        taskId: seeded.sourceTaskId,
        runId: seeded.sourceWorkRunId,
      });
      assert.equal((await profile()).memories.length, 0);
    },
  );
  const review = (id: string, body: unknown) =>
    request(`${base}/knowledge-proposals/${id}/review`, { method: "POST", body });
  const accepted = {
    decision: "accept",
    ownerReviewed: true,
    title: "Owner corrected fact",
    content: "Owner checked source evidence",
    modelUseEnabled: false,
  };
  await check(
    "Owner review and safe content are mandatory before legacy proposal activation",
    async () => {
      await error(`${base}/knowledge-proposals/${seeded.proposals.accept}/review`, 422, {
        method: "POST",
        body: { ...accepted, ownerReviewed: false },
      });
      await error(`${base}/knowledge-proposals/${seeded.proposals.accept}/review`, 422, {
        method: "POST",
        body: { ...accepted, content: "api_key = synthetic-private-secret" },
      });
      await error(
        `/api/v1/bots/${target.botId}/knowledge-proposals/${seeded.proposals.accept}/review`,
        404,
        { method: "POST", body: accepted },
      );
      assert.equal((await proposals()).length, 4);
      assert.equal((await profile()).memories.length, 0);
      const result = await review(seeded.proposals.accept, accepted);
      assert.equal(result.response.status, 200);
      const data = knowledgeProposalReviewResponseSchema.parse(result.body);
      assert(data.memoryId);
      const memory = (await profile()).memories.find((item) => item.id === data.memoryId);
      assert(memory);
      assert.equal(memory.title, accepted.title);
      assert.equal(memory.content, accepted.content);
      assert.equal(memory.modelUseEnabled, false);
      assert.equal(memory.portability, "never");
      assert.equal(memory.sensitivity, "internal");
      assert.deepEqual(memory.provenance, {
        source: "reviewed-agent-proposal",
        actor: "owner",
        proposalId: seeded.proposals.accept,
        sourceRunId: seeded.sourceRunId,
      });
      await error(`${base}/knowledge-proposals/${seeded.proposals.accept}/review`, 409, {
        method: "POST",
        body: accepted,
      });
    },
  );
  await check("rejection retains explicit null and never creates memory", async () => {
    const before = (await profile()).memories.length;
    const result = await review(seeded.proposals.reject, {
      decision: "reject",
      ownerReviewed: true,
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(knowledgeProposalReviewResponseSchema.parse(result.body), {
      proposalId: seeded.proposals.reject,
      decision: "reject",
      memoryId: null,
    });
    assert.equal((await profile()).memories.length, before);
  });
  await check(
    "native proposal review refuses incomplete publication and serializes concurrent acceptance",
    async () => {
      for (const body of [accepted, { decision: "reject", ownerReviewed: true }])
        await error(`${base}/knowledge-proposals/${seeded.proposals.incomplete}/review`, 409, {
          method: "POST",
          body,
        });
      const results = await Promise.all([
        review(seeded.proposals.native, { ...accepted, modelUseEnabled: true }),
        review(seeded.proposals.native, { ...accepted, modelUseEnabled: true }),
      ]);
      assert.deepEqual(results.map((result) => result.response.status).sort(), [200, 409]);
      const success = results.find((result) => result.response.status === 200);
      assert(success);
      const data = knowledgeProposalReviewResponseSchema.parse(success.body);
      assert(data.memoryId);
      const memory = (await profile()).memories.find((item) => item.id === data.memoryId);
      assert(memory);
      assert.equal(memory.modelUseEnabled, true);
      assert.deepEqual(memory.provenance, {
        source: "reviewed-work-proposal",
        actor: "owner",
        proposalId: seeded.proposals.native,
        sourceTaskId: seeded.sourceTaskId,
        sourceWorkRunId: seeded.sourceWorkRunId,
      });
      assert.deepEqual(
        (await proposals()).map((proposal) => proposal.id),
        [seeded.proposals.incomplete],
      );
    },
  );
  await check(
    "profile history and audit keep rejected or deleted private text out of metadata",
    async () => {
      const data = await profile();
      assert.equal(data.memories.length, 2);
      assert.equal(
        data.statistics.verifiedSkills,
        data.skills.filter((skill) => skill.state === "verified").length,
      );
      assert.equal(data.configuration.executionProfile, "none");
      for (const event of data.memoryEvents) assert(!("content" in event) && !("title" in event));
      const result = await request("/api/v1/audit?limit=100");
      assert.equal(result.response.status, 200);
      const events = auditPageSchema.parse(result.body);
      assert(!JSON.stringify(events).includes(privateContent));
      assert(!JSON.stringify(data.memoryEvents).includes(privateContent));
    },
  );
  return { count: passed.length, passed };
}
