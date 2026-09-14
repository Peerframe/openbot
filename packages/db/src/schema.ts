import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const channels = pgTable(
  "channels",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    directBotId: text("direct_bot_id").references(() => bots.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("channels_name_idx").on(table.name).where(sql`${table.directBotId} is null`),
    uniqueIndex("channels_direct_bot_idx").on(table.directBotId),
    check("channels_name_not_blank", sql`length(btrim(${table.name})) > 0`),
  ],
);

export const bots = pgTable(
  "bots",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    role: text("role").notNull(),
    description: text("description").notNull().default(""),
    profileRevision: integer("profile_revision").notNull().default(1),
    status: text("status").notNull().default("idle"),
    computerProfile: text("computer_profile").notNull().default("none"),
    configuration: jsonb("configuration").notNull().default({}),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("bots_name_idx").on(table.name),
    check("bots_name_not_blank", sql`length(btrim(${table.name})) > 0`),
    check("bots_role_not_blank", sql`length(btrim(${table.role})) > 0`),
    check("bots_role_length_valid", sql`length(${table.role}) <= 160`),
    check("bots_description_length_valid", sql`length(${table.description}) <= 2000`),
    check("bots_profile_revision_valid", sql`${table.profileRevision} >= 1`),
  ],
);

export const employeeEvolutionEvents = pgTable(
  "employee_evolution_events",
  {
    id: text("id").primaryKey(),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    source: text("source").notNull(),
    sourceId: text("source_id"),
    evidence: jsonb("evidence").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("employee_evolution_bot_time_idx").on(table.botId, table.createdAt),
    check(
      "employee_evolution_type_valid",
      sql`${table.type} IN ('created', 'role_changed', 'skill_discovered', 'skill_verified', 'skill_suspended', 'skill_revoked', 'configuration_changed', 'imported')`,
    ),
    check(
      "employee_evolution_source_valid",
      sql`${table.source} IN ('run', 'artifact', 'approval', 'manual', 'import')`,
    ),
    check("employee_evolution_title_not_blank", sql`length(btrim(${table.title})) > 0`),
    check("employee_evolution_summary_not_blank", sql`length(btrim(${table.summary})) > 0`),
  ],
);

export const skills = pgTable(
  "skills",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    version: text("version").notNull(),
    source: text("source").notNull(),
    requiredCapabilities: jsonb("required_capabilities").notNull().default([]),
    skillMarkdown: text("skill_markdown"),
    contentSha256: text("content_sha256"),
    metadata: jsonb("metadata").notNull().default({}),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("skills_slug_version_idx").on(table.slug, table.version),
    check("skills_slug_not_blank", sql`length(btrim(${table.slug})) > 0`),
    check("skills_name_not_blank", sql`length(btrim(${table.name})) > 0`),
    check("skills_version_not_blank", sql`length(btrim(${table.version})) > 0`),
    check("skills_source_not_blank", sql`length(btrim(${table.source})) > 0`),
  ],
);

export const employeeSkills = pgTable(
  "employee_skills",
  {
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    state: text("state").notNull().default("candidate"),
    source: text("source").notNull().default("manual"),
    reviewedContentSha256: text("reviewed_content_sha256"),
    revision: integer("revision").notNull().default(1),
    confidence: integer("confidence").notNull().default(0),
    evidence: jsonb("evidence").notNull().default([]),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.botId, table.skillId] }),
    index("employee_skills_state_idx").on(table.botId, table.state),
    check(
      "employee_skills_state_valid",
      sql`${table.state} IN ('candidate', 'verified', 'suspended', 'revoked')`,
    ),
    check(
      "employee_skills_source_valid",
      sql`${table.source} IN ('built-in', 'installed', 'learned', 'imported', 'manual')`,
    ),
    check("employee_skills_confidence_valid", sql`${table.confidence} BETWEEN 0 AND 100`),
  ],
);

export const employeeImportReceipts = pgTable(
  "employee_import_receipts",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id").notNull(),
    packageDigest: text("package_digest").notNull(),
    employeeId: text("employee_id")
      .notNull()
      .references(() => bots.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    signatureStatus: text("signature_status").notNull(),
    publisherKeyId: text("publisher_key_id"),
    reviewedBy: text("reviewed_by").notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull(),
    importedSkillCount: integer("imported_skill_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("employee_import_receipts_package_idx").on(table.packageId),
    uniqueIndex("employee_import_receipts_idempotency_idx").on(table.idempotencyKey),
    index("employee_import_receipts_employee_idx").on(table.employeeId),
    check(
      "employee_import_receipts_package_digest_valid",
      sql`length(${table.packageDigest}) = 64`,
    ),
    check(
      "employee_import_receipts_request_fingerprint_valid",
      sql`length(${table.requestFingerprint}) = 64`,
    ),
    check(
      "employee_import_receipts_signature_status_valid",
      sql`${table.signatureStatus} IN ('unsigned', 'dsse')`,
    ),
    check(
      "employee_import_receipts_publisher_valid",
      sql`(${table.signatureStatus} = 'unsigned' AND ${table.publisherKeyId} IS NULL) OR (${table.signatureStatus} = 'dsse' AND length(btrim(${table.publisherKeyId})) > 0)`,
    ),
    check("employee_import_receipts_reviewer_valid", sql`${table.reviewedBy} = 'owner'`),
    check(
      "employee_import_receipts_skill_count_valid",
      sql`${table.importedSkillCount} BETWEEN 0 AND 256`,
    ),
  ],
);

export const skillDependencies = pgTable(
  "skill_dependencies",
  {
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    dependsOnSkillId: text("depends_on_skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.skillId, table.dependsOnSkillId] }),
    check("skill_dependencies_not_self", sql`${table.skillId} <> ${table.dependsOnSkillId}`),
  ],
);

export const employeeMemories = pgTable(
  "employee_memories",
  {
    id: text("id").primaryKey(),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    sensitivity: text("sensitivity").notNull().default("internal"),
    portability: text("portability").notNull().default("owner-selectable"),
    provenance: jsonb("provenance").notNull().default({}),
    modelUseEnabled: boolean("model_use_enabled").notNull().default(false),
    revision: integer("revision").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    index("employee_memories_bot_time_idx").on(table.botId, table.updatedAt),
    check(
      "employee_memories_kind_valid",
      sql`${table.kind} IN ('working', 'episodic', 'semantic', 'procedural', 'secret-reference')`,
    ),
    check(
      "employee_memories_sensitivity_valid",
      sql`${table.sensitivity} IN ('public', 'internal', 'confidential', 'restricted')`,
    ),
    check(
      "employee_memories_portability_valid",
      sql`${table.portability} IN ('never', 'owner-selectable', 'included')`,
    ),
    check("employee_memories_title_not_blank", sql`length(btrim(${table.title})) > 0`),
    check("employee_memories_content_not_blank", sql`length(btrim(${table.content})) > 0`),
    check("employee_memories_revision_valid", sql`${table.revision} >= 1`),
    check(
      "employee_memories_model_use_safe",
      sql`NOT ${table.modelUseEnabled} OR (${table.kind} <> 'secret-reference' AND ${table.sensitivity} IN ('public', 'internal'))`,
    ),
  ],
);

export const employeeMemoryEvents = pgTable(
  "employee_memory_events",
  {
    id: text("id").primaryKey(),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    memoryId: text("memory_id").notNull(),
    action: text("action").notNull(),
    revision: integer("revision").notNull(),
    changedFields: jsonb("changed_fields").notNull().default([]),
    actor: text("actor").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("employee_memory_events_bot_time_idx").on(table.botId, table.createdAt),
    index("employee_memory_events_memory_time_idx").on(table.memoryId, table.createdAt),
    check(
      "employee_memory_events_action_valid",
      sql`${table.action} IN ('created', 'updated', 'deleted')`,
    ),
    check("employee_memory_events_revision_valid", sql`${table.revision} >= 1`),
    check("employee_memory_events_actor_valid", sql`${table.actor} = 'owner'`),
  ],
);

export const channelBots = pgTable(
  "channel_bots",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.channelId, table.botId] }),
    index("channel_bots_bot_idx").on(table.botId),
  ],
);

export const nodes = pgTable(
  "nodes",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    platform: text("platform").notNull(),
    osVersion: text("os_version").notNull().default("unknown"),
    architecture: text("architecture").notNull().default("unknown"),
    deviceClass: text("device_class").notNull().default("unknown"),
    isolation: text("isolation").notNull().default("unknown"),
    trustTier: text("trust_tier").notNull().default("development"),
    capabilities: jsonb("capabilities").notNull().default([]),
    capabilityManifest: jsonb("capability_manifest").notNull().default([]),
    maxConcurrentRuns: integer("max_concurrent_runs").notNull().default(1),
    status: text("status").notNull().default("offline"),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    check("nodes_max_concurrent_runs_valid", sql`${table.maxConcurrentRuns} BETWEEN 1 AND 16`),
  ],
);

export const nodeEnrollmentTokens = pgTable(
  "node_enrollment_tokens",
  {
    id: text("id").primaryKey(),
    nodeId: text("node_id").notNull(),
    tokenDigest: text("token_digest").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("node_enrollment_tokens_digest_idx").on(table.tokenDigest),
    uniqueIndex("node_enrollment_tokens_one_active_per_node_idx")
      .on(table.nodeId)
      .where(sql`${table.consumedAt} IS NULL`),
    index("node_enrollment_tokens_expiry_idx")
      .on(table.expiresAt)
      .where(sql`${table.consumedAt} IS NULL`),
    check("node_enrollment_tokens_digest_valid", sql`length(${table.tokenDigest}) = 64`),
    check("node_enrollment_tokens_node_id_not_blank", sql`length(btrim(${table.nodeId})) > 0`),
  ],
);

export const nodeCredentials = pgTable(
  "node_credentials",
  {
    nodeId: text("node_id").primaryKey(),
    credentialDigest: text("credential_digest").notNull(),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull(),
    lastAuthenticatedAt: timestamp("last_authenticated_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("node_credentials_digest_idx").on(table.credentialDigest),
    index("node_credentials_active_idx").on(table.nodeId).where(sql`${table.revokedAt} IS NULL`),
    check("node_credentials_digest_valid", sql`length(${table.credentialDigest}) = 64`),
    check("node_credentials_node_id_not_blank", sql`length(btrim(${table.nodeId})) > 0`),
  ],
);

export const nodeIdentityEvents = pgTable(
  "node_identity_events",
  {
    id: text("id").primaryKey(),
    nodeId: text("node_id").notNull(),
    type: text("type").notNull(),
    details: jsonb("details").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("node_identity_events_node_time_idx").on(table.nodeId, table.createdAt),
    check(
      "node_identity_events_type_valid",
      sql`${table.type} IN ('enrollment_created', 'enrolled', 'revoked')`,
    ),
    check("node_identity_events_node_id_not_blank", sql`length(btrim(${table.nodeId})) > 0`),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    authorType: text("author_type").notNull(),
    authorId: text("author_id"),
    replyToMessageId: text("reply_to_message_id"),
    runId: text("run_id"),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("messages_channel_time_idx").on(table.channelId, table.createdAt),
    index("messages_reply_idx").on(table.replyToMessageId),
    index("messages_run_idx").on(table.runId),
    check("messages_author_type_valid", sql`${table.authorType} IN ('human', 'bot', 'system')`),
    check("messages_content_not_blank", sql`length(btrim(${table.content})) > 0`),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    parentRunId: text("parent_run_id").references((): AnyPgColumn => runs.id),
    rootRunId: text("root_run_id").references((): AnyPgColumn => runs.id),
    delegatedByBotId: text("delegated_by_bot_id").references(() => bots.id),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id),
    sourceMessageId: text("source_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    nodeId: text("node_id").references(() => nodes.id),
    executionProfile: text("execution_profile").notNull().default("none"),
    instruction: text("instruction").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull().default("queued"),
    resultSummary: text("result_summary"),
    errorMessage: text("error_message"),
    errorCode: text("error_code"),
    modelUsage: jsonb("model_usage"),
    ...timestamps,
  },
  (table) => [
    check(
      "runs_delegation_shape",
      sql`(${table.parentRunId} IS NULL AND ${table.rootRunId} IS NULL AND ${table.delegatedByBotId} IS NULL) OR (${table.parentRunId} IS NOT NULL AND ${table.rootRunId} IS NOT NULL AND ${table.delegatedByBotId} IS NOT NULL AND ${table.parentRunId} <> ${table.id} AND ${table.rootRunId} <> ${table.id} AND ${table.executionProfile} = 'none' AND ${table.nodeId} IS NULL)`,
    ),
    index("runs_root_idx").on(table.rootRunId),
    index("runs_parent_idx").on(table.parentRunId),
    index("runs_created_idx").on(table.createdAt),
    index("runs_channel_created_idx").on(table.channelId, table.createdAt),
    index("runs_bot_idx").on(table.botId),
    index("runs_node_idx").on(table.nodeId),
    index("runs_status_created_idx").on(table.status, table.createdAt),
    index("runs_dispatch_queue_idx")
      .on(table.createdAt, table.id)
      .where(
        sql`${table.status} = 'queued' AND ${table.nodeId} IS NULL AND ${table.executionProfile} <> 'none'`,
      ),
    uniqueIndex("runs_source_message_bot_idx")
      .on(table.sourceMessageId, table.botId)
      .where(sql`${table.sourceMessageId} IS NOT NULL`),
    check("runs_title_not_blank", sql`length(btrim(${table.title})) > 0`),
    check("runs_instruction_not_blank", sql`length(btrim(${table.instruction})) > 0`),
    check(
      "runs_model_usage_native",
      sql`${table.modelUsage} IS NULL OR (${table.executionProfile} = 'none' AND ${table.nodeId} IS NULL AND jsonb_typeof(${table.modelUsage}) = 'object')`,
    ),
    check(
      "runs_status_valid",
      sql`${table.status} IN ('queued', 'assigned', 'running', 'waiting_approval', 'blocked', 'completed', 'failed', 'cancelled')`,
    ),
    check(
      "runs_execution_profile_valid",
      sql`${table.executionProfile} IN ('none', 'docker-linux', 'macos-cua', 'lume-vm', 'coder')`,
    ),
  ],
);

export const runEvents = pgTable(
  "run_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").references(() => runs.id, { onDelete: "cascade" }),
    channelId: text("channel_id").references(() => channels.id),
    botId: text("bot_id").references(() => bots.id),
    nodeId: text("node_id").references(() => nodes.id),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("run_events_run_time_idx").on(table.runId, table.createdAt),
    index("run_events_channel_time_idx").on(table.channelId, table.createdAt),
    index("run_events_bot_idx").on(table.botId),
    index("run_events_node_idx").on(table.nodeId),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    tokenDigest: text("token_digest").notNull(),
    ownerId: text("owner_id").notNull().default("owner"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("auth_sessions_token_digest_idx").on(table.tokenDigest),
    index("auth_sessions_active_expiry_idx")
      .on(table.expiresAt)
      .where(sql`${table.revokedAt} IS NULL`),
    check("auth_sessions_owner_valid", sql`${table.ownerId} = 'owner'`),
    check("auth_sessions_token_digest_valid", sql`length(${table.tokenDigest}) = 64`),
  ],
);

export const requestThrottleBuckets = pgTable(
  "request_throttle_buckets",
  {
    scope: text("scope").notNull(),
    clientDigest: text("client_digest").notNull(),
    attemptCount: integer("attempt_count").notNull(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    blockedUntil: timestamp("blocked_until", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.clientDigest] }),
    index("request_throttle_expiry_idx").on(table.updatedAt),
    check(
      "request_throttle_scope_valid",
      sql`${table.scope} IN ('owner-login', 'node-enrollment')`,
    ),
    check("request_throttle_client_digest_valid", sql`length(${table.clientDigest}) = 64`),
    check("request_throttle_attempt_count_valid", sql`${table.attemptCount} >= 1`),
  ],
);

export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    nodeId: text("node_id")
      .notNull()
      .references(() => nodes.id),
    action: text("action").notNull(),
    target: text("target").notNull(),
    summary: text("summary").notNull(),
    risk: text("risk").notNull(),
    targetFingerprint: text("target_fingerprint").notNull(),
    status: text("status").notNull().default("pending"),
    beforeState: jsonb("before_state").notNull().default({}),
    decidedBy: text("decided_by"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("approvals_run_status_idx").on(table.runId, table.status),
    index("approvals_status_expiry_idx").on(table.status, table.expiresAt),
    check(
      "approvals_status_valid",
      sql`${table.status} IN ('pending', 'approved', 'rejected', 'expired')`,
    ),
    check("approvals_risk_valid", sql`${table.risk} IN ('write', 'destructive', 'privileged')`),
    check("approvals_action_not_blank", sql`length(btrim(${table.action})) > 0`),
    check("approvals_target_not_blank", sql`length(btrim(${table.target})) > 0`),
    check("approvals_summary_not_blank", sql`length(btrim(${table.summary})) > 0`),
    check("approvals_target_fingerprint_valid", sql`length(${table.targetFingerprint}) = 64`),
  ],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mediaType: text("media_type").notNull(),
    storageKey: text("storage_key").notNull(),
    sha256: text("sha256").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("artifacts_run_idx").on(table.runId),
    uniqueIndex("artifacts_storage_key_idx").on(table.storageKey),
    check("artifacts_name_not_blank", sql`length(btrim(${table.name})) > 0`),
    check("artifacts_sha256_valid", sql`length(${table.sha256}) = 64`),
  ],
);

export const automations = pgTable(
  "automations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    intervalMinutes: integer("interval_minutes").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastRunId: text("last_run_id").references(() => runs.id, { onDelete: "set null" }),
    lastOutcome: text("last_outcome"),
    ...timestamps,
  },
  (table) => [
    index("automations_due_idx").on(table.nextRunAt).where(sql`${table.enabled} = true`),
    check("automations_name_valid", sql`length(btrim(${table.name})) BETWEEN 1 AND 80`),
    check("automations_prompt_valid", sql`length(btrim(${table.prompt})) BETWEEN 1 AND 8000`),
    check("automations_interval_valid", sql`${table.intervalMinutes} BETWEEN 15 AND 10080`),
    check(
      "automations_outcome_valid",
      sql`${table.lastOutcome} IN ('submitted', 'skipped_active', 'target_unavailable', 'attachment_unavailable')`,
    ),
  ],
);

export const knowledgeProposals = pgTable(
  "knowledge_proposals",
  {
    id: text("id").primaryKey(),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    sourceRunId: text("source_run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    status: text("status").notNull().default("pending"),
    memoryId: text("memory_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("knowledge_proposals_run_idx").on(table.sourceRunId),
    index("knowledge_proposals_bot_status_idx").on(table.botId, table.status, table.createdAt),
    check(
      "knowledge_proposals_kind_valid",
      sql`${table.kind} IN ('semantic', 'episodic', 'procedural')`,
    ),
    check(
      "knowledge_proposals_status_valid",
      sql`${table.status} IN ('pending', 'accepted', 'rejected')`,
    ),
    check(
      "knowledge_proposals_pending_bounded",
      sql`${table.status} <> 'pending' OR (length(btrim(${table.title})) BETWEEN 1 AND 160 AND length(btrim(${table.content})) BETWEEN 1 AND 2000 AND octet_length(${table.content}) <= 8000)`,
    ),
    check(
      "knowledge_proposals_review_valid",
      sql`(${table.status} = 'pending' AND ${table.reviewedAt} IS NULL AND ${table.memoryId} IS NULL) OR (${table.status} = 'accepted' AND ${table.reviewedAt} IS NOT NULL AND ${table.memoryId} IS NOT NULL) OR (${table.status} = 'rejected' AND ${table.reviewedAt} IS NOT NULL AND ${table.memoryId} IS NULL)`,
    ),
  ],
);

export const messageReactions = pgTable(
  "message_reactions",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.emoji] }),
    index("message_reactions_channel_idx").on(table.channelId, table.messageId),
    check(
      "message_reactions_emoji_valid",
      sql`${table.emoji} IN ('👍', '❤️', '😂', '🎉', '🤔', '👀')`,
    ),
  ],
);
