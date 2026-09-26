import { randomUUID } from "node:crypto";

const databaseUrl = process.env.OPENBOT_DATABASE_URL;
if (databaseUrl === undefined) throw new Error("OPENBOT_DATABASE_URL is required.");

const parsedUrl = new URL(databaseUrl);
const databaseName = parsedUrl.pathname.slice(1);
if (!databaseName.endsWith("_test")) {
  throw new Error("Database verification refuses to run unless the database name ends with _test.");
}

const { createDatabase } = await import("../packages/db/dist/index.js");
const { NodeIdentityService } = await import(
  "../tests/oracles/legacy-server/dist/node-identity.js"
);
const { PostgresNodeIdentityStore } = await import(
  "../tests/oracles/legacy-server/dist/postgres-node-identity-store.js"
);
const { PostgresRequestThrottleStore } = await import(
  "../tests/oracles/legacy-server/dist/postgres-request-throttle-store.js"
);
const { RequestThrottle } = await import("../tests/oracles/legacy-server/dist/request-throttle.js");
const { PostgresControlPlaneStore } = await import(
  "../tests/oracles/legacy-server/dist/postgres-store.js"
);
const { buildEmployeeTemplate, employeeTemplatePackageDigest } = await import(
  "../tests/oracles/legacy-server/dist/employee-package.js"
);
const first = createDatabase(databaseUrl);
const second = createDatabase(databaseUrl);
const verificationNodeId = `db-verification-${randomUUID()}`;
const employeeVerificationId = randomUUID();
const verificationClientIdentity = { digest: "a".repeat(64), source: "direct" };
const verificationThrottleDigest = "b".repeat(64);
let sourceEmployeeId;
let importedEmployeeId;
let verificationSkillId;
let verificationChannelId;
let verificationRunId;
try {
  // Separate startup attempts must serialize migration ownership and converge on one complete plan.
  await Promise.all([first.migrate(), second.migrate()]);
  await first.migrate();
  const [result] = await first.client`
    select count(*)::text as migrations
    from drizzle.__drizzle_migrations
  `;
  if (result === undefined || Number(result.migrations) === 0) {
    throw new Error("Database verification found no applied migrations.");
  }
  const identity = new NodeIdentityService(new PostgresNodeIdentityStore(first.db));
  // Concurrent Owner requests serialize per Node: both calls complete, and only the later active
  // token can be consumed.
  const issuedTokens = await Promise.all([
    identity.issueEnrollmentToken({ nodeId: verificationNodeId, expiresInSeconds: 60 }),
    identity.issueEnrollmentToken({ nodeId: verificationNodeId, expiresInSeconds: 60 }),
  ]);
  const exchanges = await Promise.allSettled([
    ...issuedTokens.map((issued) =>
      identity.enroll(
        { nodeId: verificationNodeId, token: issued.token },
        verificationClientIdentity,
      ),
    ),
    ...issuedTokens.map((issued) =>
      identity.enroll(
        { nodeId: verificationNodeId, token: issued.token },
        verificationClientIdentity,
      ),
    ),
  ]);
  const successful = exchanges.filter((item) => item.status === "fulfilled");
  if (successful.length !== 1) {
    throw new Error("Concurrent Node enrollment did not consume its token exactly once.");
  }
  const enrolled = successful[0].value;
  const [enrollmentAudit] = await first.client`
    select details
    from node_identity_events
    where node_id = ${verificationNodeId} and type = 'enrolled'
    order by created_at desc
    limit 1
  `;
  if (
    enrollmentAudit?.details?.clientIdentityDigest !== verificationClientIdentity.digest ||
    enrollmentAudit?.details?.clientIdentitySource !== "direct"
  ) {
    throw new Error("Node enrollment did not persist its pseudonymous client audit fields.");
  }
  if (!(await identity.authenticate(verificationNodeId, enrolled.credential))) {
    throw new Error("Issued Node credential did not authenticate.");
  }
  const listed = (await identity.list()).find((item) => item.nodeId === verificationNodeId);
  if (listed === undefined || listed.revokedAt !== null || listed.lastAuthenticatedAt === null) {
    throw new Error("Enrolled Node metadata was not projected from PostgreSQL.");
  }
  await identity.revoke(verificationNodeId);
  if (await identity.authenticate(verificationNodeId, enrolled.credential)) {
    throw new Error("Revoked Node credential still authenticated.");
  }
  const revoked = (await identity.list()).find((item) => item.nodeId === verificationNodeId);
  if (revoked?.revokedAt === null || revoked?.revokedAt === undefined) {
    throw new Error("Revoked Node metadata was not projected from PostgreSQL.");
  }

  const requestThrottle = new RequestThrottle(new PostgresRequestThrottleStore(first.db));
  const concurrentAttempts = await Promise.all(
    Array.from({ length: 6 }, () =>
      requestThrottle.reserve("owner-login", verificationThrottleDigest),
    ),
  );
  if (
    concurrentAttempts.filter((attempt) => attempt.allowed).length !== 5 ||
    concurrentAttempts.filter((attempt) => !attempt.allowed).length !== 1
  ) {
    throw new Error("Concurrent durable login throttling did not admit exactly five attempts.");
  }
  await requestThrottle.clear("owner-login", verificationThrottleDigest);
  if (!(await requestThrottle.reserve("owner-login", verificationThrottleDigest)).allowed) {
    throw new Error("A cleared durable login throttle did not admit a fresh attempt.");
  }

  const store = new PostgresControlPlaneStore(first.db);
  const source = await store.createBot({
    name: `Import source ${employeeVerificationId}`,
    role: "Database import verification",
    computerProfile: "none",
  });
  sourceEmployeeId = source.id;
  const verificationChannel = await store.createChannel({
    name: `Dispatch audit ${employeeVerificationId}`,
    description: "Disposable channel for dispatch audit verification.",
    botIds: [source.id],
  });
  verificationChannelId = verificationChannel.id;
  const verificationTask = await store.submitTask(verificationChannel.id, {
    content: "Verify a bounded background dispatch failure event.",
    botId: source.id,
  });
  verificationRunId = verificationTask.run.id;
  await store.recordDispatchFailure({
    runId: verificationTask.run.id,
    nodeId: "untrusted-node-id",
    phase: "database-verification",
    code: "dispatch_failed",
  });
  const [dispatchAudit] = await first.client`
    select node_id, payload
    from run_events
    where run_id = ${verificationTask.run.id} and type = 'DISPATCH_FAILED'
    order by created_at desc
    limit 1
  `;
  if (
    dispatchAudit === undefined ||
    dispatchAudit.node_id !== null ||
    dispatchAudit.payload?.code !== "dispatch_failed" ||
    dispatchAudit.payload?.phase !== "database-verification" ||
    JSON.stringify(Object.keys(dispatchAudit.payload).sort()) !== JSON.stringify(["code", "phase"])
  ) {
    throw new Error("Background dispatch failure did not persist a bounded authoritative audit.");
  }
  const concurrentProfileUpdates = await Promise.allSettled([
    store.updateEmployeeProfileDetails(source.id, {
      role: "Database profile verification",
      description: "Disposable profile used to verify compare-and-swap updates.",
      expectedRevision: 1,
    }),
    store.updateEmployeeProfileDetails(source.id, {
      role: "Stale database profile writer",
      description: "This concurrent overwrite must lose.",
      expectedRevision: 1,
    }),
  ]);
  const successfulProfileUpdates = concurrentProfileUpdates.filter(
    (item) => item.status === "fulfilled",
  );
  const failedProfileUpdates = concurrentProfileUpdates.filter(
    (item) => item.status === "rejected",
  );
  if (successfulProfileUpdates.length !== 1 || failedProfileUpdates.length !== 1) {
    throw new Error("Concurrent Employee profile updates did not reject one stale revision.");
  }
  const winningProfileUpdate = successfulProfileUpdates[0].value;
  const profileAfterUpdate = await store.getEmployeeProfile(source.id);
  const [profileAudit] = await first.client`
    select payload
    from run_events
    where bot_id = ${source.id} and type = 'EMPLOYEE_PROFILE_UPDATED'
    order by created_at desc
    limit 1
  `;
  if (
    profileAfterUpdate.details.revision !== 2 ||
    profileAfterUpdate.details.description !== winningProfileUpdate.details.description ||
    profileAfterUpdate.evolution[0]?.summary.includes(profileAfterUpdate.details.description) ||
    profileAudit === undefined ||
    JSON.stringify(profileAudit.payload).includes(profileAfterUpdate.details.description) ||
    JSON.stringify(Object.keys(profileAudit.payload).sort()) !==
      JSON.stringify(["changedFields", "revision"])
  ) {
    throw new Error("Employee profile revision or content-free evolution verification failed.");
  }
  const candidate = await store.createEmployeeSkill(source.id, {
    slug: `database-import-${employeeVerificationId}`,
    name: "Database import verification",
    description: "Temporary skill used by the disposable database verification script.",
    version: "1.0.0",
    source: "manual",
    requiredCapabilities: [],
    dependencySkillIds: [],
    evidence: [],
    reason: "Verify portable Employee persistence.",
  });
  verificationSkillId = candidate.skill.id;
  await store.updateEmployeeSkillState(source.id, candidate.skill.id, {
    state: "verified",
    confidence: 100,
    reason: "Verified only for the disposable database test.",
    evidence: [],
    ownerReviewed: true,
  });
  const [sensitiveMemoryWrite] = await Promise.allSettled([
    store.createEmployeeMemory(source.id, {
      kind: "secret-reference",
      title: "Credential value must be rejected",
      content: "api_key=super-secret-value",
      sensitivity: "restricted",
      portability: "never",
    }),
  ]);
  if (sensitiveMemoryWrite.status !== "rejected") {
    throw new Error("Employee memory accepted a credential-like value.");
  }
  const createdMemory = await store.createEmployeeMemory(source.id, {
    kind: "semantic",
    title: "Disposable database preference",
    content: "Return the outcome before supporting evidence.",
    sensitivity: "internal",
    portability: "owner-selectable",
  });
  const concurrentMemoryUpdates = await Promise.allSettled([
    store.updateEmployeeMemory(source.id, createdMemory.memory.id, {
      expectedRevision: 1,
      content: "Return the outcome and then supporting evidence.",
    }),
    store.updateEmployeeMemory(source.id, createdMemory.memory.id, {
      expectedRevision: 1,
      content: "This concurrent overwrite must lose.",
    }),
  ]);
  const successfulMemoryUpdates = concurrentMemoryUpdates.filter(
    (item) => item.status === "fulfilled",
  );
  const failedMemoryUpdates = concurrentMemoryUpdates.filter((item) => item.status === "rejected");
  if (successfulMemoryUpdates.length !== 1 || failedMemoryUpdates.length !== 1) {
    throw new Error("Concurrent Employee memory updates did not reject one stale revision.");
  }
  const updatedMemory = successfulMemoryUpdates[0].value.memory;
  await store.deleteEmployeeMemory(source.id, createdMemory.memory.id, {
    expectedRevision: updatedMemory.revision,
    ownerReviewed: true,
  });
  const memoryProfile = await store.getEmployeeProfile(source.id);
  if (
    memoryProfile.memories.length !== 0 ||
    memoryProfile.memoryEvents.length !== 3 ||
    memoryProfile.memoryEvents[0]?.action !== "deleted" ||
    JSON.stringify(memoryProfile.memoryEvents).includes("supporting evidence")
  ) {
    throw new Error("Employee memory deletion or content-free audit verification failed.");
  }
  const employeeTemplate = buildEmployeeTemplate(await store.getEmployeeProfile(source.id));
  const packageDigest = employeeTemplatePackageDigest(employeeTemplate.document);
  const idempotencyKey = randomUUID();
  const activationCommand = {
    document: employeeTemplate.document,
    packageDigest,
    idempotencyKey,
    employeeName: `Import copy ${employeeVerificationId}`,
    signature: { status: "unsigned" },
    reviewedBy: "owner",
    reviewedAt: new Date().toISOString(),
  };
  const concurrentActivations = await Promise.all([
    store.activateEmployeeImport(activationCommand),
    store.activateEmployeeImport(activationCommand),
  ]);
  const activated = concurrentActivations.find((item) => !item.replayed);
  const concurrentReplay = concurrentActivations.find((item) => item.replayed);
  if (activated === undefined || concurrentReplay?.employee.id !== activated.employee.id) {
    throw new Error("Concurrent Employee activation did not converge on one receipt.");
  }
  importedEmployeeId = activated.employee.id;
  const importedProfile = await store.getEmployeeProfile(activated.employee.id);
  if (
    activated.replayed ||
    activated.receipt.packageDigest !== packageDigest ||
    activated.receipt.importedSkillCount !== 1 ||
    importedProfile.skills.length !== 1 ||
    importedProfile.skills[0]?.state !== "candidate" ||
    importedProfile.skills[0]?.source !== "imported" ||
    importedProfile.skills[0]?.confidence !== 0 ||
    importedProfile.details.description !== profileAfterUpdate.details.description ||
    importedProfile.memories.length !== 0
  ) {
    throw new Error("Reviewed Employee activation did not preserve its zero-authority boundary.");
  }
  const replayed = await store.activateEmployeeImport(activationCommand);
  if (!replayed.replayed || replayed.employee.id !== activated.employee.id) {
    throw new Error("Reviewed Employee activation was not idempotent.");
  }
  console.info(`Database verification passed with ${result.migrations} applied migrations.`);
} finally {
  await Promise.allSettled([
    first.client`delete from request_throttle_buckets where client_digest = ${verificationThrottleDigest}`,
    first.client`delete from node_identity_events where node_id = ${verificationNodeId}`,
    first.client`delete from node_credentials where node_id = ${verificationNodeId}`,
    first.client`delete from node_enrollment_tokens where node_id = ${verificationNodeId}`,
  ]);
  if (importedEmployeeId !== undefined) {
    await first.client`delete from employee_import_receipts where employee_id = ${importedEmployeeId}`;
  }
  if (verificationRunId !== undefined) {
    await first.client`delete from run_events where run_id = ${verificationRunId}`;
    await first.client`delete from messages where run_id = ${verificationRunId}`;
    await first.client`delete from runs where id = ${verificationRunId}`;
  }
  if (verificationChannelId !== undefined) {
    await first.client`delete from run_events where channel_id = ${verificationChannelId}`;
    await first.client`delete from channel_bots where channel_id = ${verificationChannelId}`;
    await first.client`delete from channels where id = ${verificationChannelId}`;
  }
  const employeeIds = [sourceEmployeeId, importedEmployeeId].filter((value) => value !== undefined);
  if (employeeIds.length > 0) {
    await first.client`delete from run_events where bot_id = any(${employeeIds})`;
    await first.client`delete from bots where id = any(${employeeIds})`;
  }
  if (verificationSkillId !== undefined) {
    await first.client`delete from skills where id = ${verificationSkillId}`;
  }
  await Promise.allSettled([first.close(), second.close()]);
}
