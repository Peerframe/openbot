import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { botProjection, runProjection } from "./channel-read-projection.js";
import { employeeProfileSchema } from "@openbot/protocol";
import { memoryFields } from "./employee-input.js";
import { refuse } from "./owner-transaction.js";
export type EmployeeDB = postgres.TransactionSql;
export type EmployeeRow = Record<string, any>;
export const projectionMaximum = 4 * 1024 * 1024;
// Only local constant SELECT statements enter this helper. Size inside SQL before allocating
// persisted JSON/text on the Server, including malformed legacy rows.
export async function employeeRows(
  db: EmployeeDB,
  query: string,
  parameters: any[] = [],
): Promise<EmployeeRow[]> {
  const rows = await db.unsafe(
    `WITH selected AS MATERIALIZED (${query}), documents AS MATERIALIZED
    (SELECT to_jsonb(selected) AS body FROM selected), sized AS
    (SELECT body,sum(octet_length(body::text)::bigint) OVER () AS total FROM documents)
    SELECT total>${projectionMaximum} AS oversized,CASE WHEN total<=${projectionMaximum} THEN body ELSE NULL END AS body FROM sized`,
    parameters,
  );
  if (rows.some((row) => row.oversized)) refuse(503, "employee_knowledge_projection_limit");
  return rows.map((row) => row.body);
}
export async function employeeOne(
  db: EmployeeDB,
  query: string,
  parameters: any[] = [],
  missing = "employee_not_found",
) {
  const rows = await employeeRows(db, query, parameters);
  return rows[0] ?? refuse(404, missing);
}
export const employeeTime = (value: unknown) => {
  const date = value instanceof Date ? value : new Date(value as string);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999)
    throw new Error("Invalid Employee timestamp.");
  return date.toISOString();
};
const timestamps = (row: EmployeeRow) => ({
  ...row,
  created_at: new Date(row.created_at),
  updated_at: new Date(row.updated_at),
});
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((s) => typeof s === "string") : [];
export function evidence(value: unknown): EmployeeRow[] {
  return Array.isArray(value)
    ? value
        .filter(
          (item) =>
            item &&
            typeof item === "object" &&
            ["run", "artifact", "approval", "manual", "import"].includes(item.kind) &&
            typeof item.id === "string",
        )
        .map((item) => ({
          kind: item.kind,
          id: item.id,
          ...(typeof item.label === "string" ? { label: item.label } : {}),
        }))
    : [];
}
export function mergeEvidence(old: unknown, fresh: unknown) {
  const values = new Map<string, EmployeeRow>();
  for (const item of [...evidence(old), ...evidence(fresh)]) {
    const key = JSON.stringify([item.kind, item.id]);
    values.delete(key);
    values.set(key, item);
  }
  return [...values.values()].slice(-64);
}
export function evolution(row: EmployeeRow) {
  return {
    id: row.id,
    botId: row.bot_id,
    type: row.type,
    title: row.title,
    summary: row.summary,
    source: row.source,
    ...(row.source_id != null ? { sourceId: row.source_id } : {}),
    evidence: evidence(row.evidence),
    createdAt: employeeTime(row.created_at),
  };
}
export function skillRecord(skill: EmployeeRow, assignment: EmployeeRow, dependencies: string[]) {
  return {
    id: skill.id,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    source: assignment.source,
    state: assignment.state,
    confidence: assignment.confidence,
    requiredCapabilities: strings(skill.required_capabilities),
    dependencyIds: dependencies,
    evidence: evidence(assignment.evidence),
    acquiredAt: employeeTime(assignment.acquired_at),
    updatedAt: employeeTime(assignment.updated_at),
    ...(skill.skill_markdown && skill.content_sha256
      ? {
          skillMarkdown: skill.skill_markdown,
          contentSha256: skill.content_sha256,
          modelUseEnabled:
            assignment.state === "verified" &&
            assignment.reviewed_content_sha256 === skill.content_sha256,
        }
      : {}),
  };
}
const object = (value: unknown): EmployeeRow =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
export function memoryRecord(row: EmployeeRow) {
  return {
    id: row.id,
    botId: row.bot_id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    sensitivity: row.sensitivity,
    portability: row.portability,
    provenance: object(row.provenance),
    modelUseEnabled: row.model_use_enabled,
    revision: row.revision,
    createdAt: employeeTime(row.created_at),
    updatedAt: employeeTime(row.updated_at),
  };
}
export function memoryEvent(row: EmployeeRow) {
  return {
    id: row.id,
    botId: row.bot_id,
    memoryId: row.memory_id,
    action: row.action,
    revision: row.revision,
    changedFields: strings(row.changed_fields).filter((s) =>
      (memoryFields as readonly string[]).includes(s),
    ),
    actor: "owner" as const,
    createdAt: employeeTime(row.created_at),
  };
}
const approvalRecord = (r: EmployeeRow, botId: string) => ({
  id: r.id,
  runId: r.run_id,
  channelId: r.channel_id,
  botId,
  nodeId: r.node_id,
  action: r.action,
  target: r.target,
  summary: r.summary,
  risk: r.risk,
  targetFingerprint: r.target_fingerprint,
  beforeState: object(r.before_state),
  status: r.status,
  expiresAt: employeeTime(r.expires_at),
  createdAt: employeeTime(r.created_at),
  ...(r.decided_by != null ? { decidedBy: r.decided_by } : {}),
  ...(r.decided_at != null ? { decidedAt: employeeTime(r.decided_at) } : {}),
});
const artifactRecord = (r: EmployeeRow) => ({
  id: r.id,
  runId: r.run_id,
  name: r.name,
  mediaType: r.media_type,
  sha256: r.sha256,
  sizeBytes: typeof object(r.metadata).sizeBytes === "number" ? object(r.metadata).sizeBytes : 0,
  createdAt: employeeTime(r.created_at),
});
const decisions = (rows: EmployeeRow[]) =>
  rows.flatMap((r) => {
    const payload = object(r.payload);
    return r.run_id != null &&
      r.channel_id != null &&
      typeof payload.stage === "string" &&
      typeof payload.message === "string"
      ? [
          {
            id: r.id,
            runId: r.run_id,
            channelId: r.channel_id,
            ...(r.node_id != null ? { nodeId: r.node_id } : {}),
            stage: payload.stage,
            message: payload.message,
            summary: payload.message,
            createdAt: employeeTime(r.created_at),
          },
        ]
      : [];
  });
export async function employeeProfile(db: EmployeeDB, id: string) {
  const bot = await employeeOne(db, "SELECT * FROM bots WHERE id=$1 AND deleted_at IS NULL", [id]);
  const events = await employeeRows(
    db,
    "SELECT * FROM employee_evolution_events WHERE bot_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100",
    [id],
  );
  const assignments = await employeeRows(
    db,
    "SELECT to_jsonb(s) AS skill,to_jsonb(e) AS assignment FROM employee_skills e JOIN skills s ON s.id=e.skill_id WHERE e.bot_id=$1 ORDER BY e.updated_at DESC,s.id DESC LIMIT 100",
    [id],
  );
  const dependencies = await employeeRows(
    db,
    "SELECT skill_id,depends_on_skill_id FROM skill_dependencies WHERE skill_id IN (SELECT jsonb_array_elements_text($1::jsonb)) ORDER BY skill_id,depends_on_skill_id LIMIT 6401",
    [db.json(assignments.map((row) => row.skill.id))],
  );
  if (dependencies.length > 6400) refuse(503, "employee_knowledge_projection_limit");
  const memories = await employeeRows(
    db,
    "SELECT * FROM employee_memories WHERE bot_id=$1 ORDER BY updated_at DESC,id DESC LIMIT 100",
    [id],
  );
  const memoryEvents = await employeeRows(
    db,
    "SELECT * FROM employee_memory_events WHERE bot_id=$1 ORDER BY created_at DESC,id DESC LIMIT 200",
    [id],
  );
  const runs = await employeeRows(
    db,
    "SELECT * FROM runs_work_projection WHERE bot_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50",
    [id],
  );
  const approvals = await employeeRows(
    db,
    "SELECT a.*,r.channel_id FROM approvals a JOIN runs r ON r.id=a.run_id WHERE r.bot_id=$1 ORDER BY a.created_at DESC,a.id DESC LIMIT 100",
    [id],
  );
  const artifacts = await employeeRows(
    db,
    "SELECT a.* FROM artifacts a JOIN runs r ON r.id=a.run_id WHERE r.bot_id=$1 ORDER BY a.created_at DESC,a.id DESC LIMIT 100",
    [id],
  );
  const progress = await employeeRows(
    db,
    "SELECT * FROM run_events WHERE bot_id=$1 AND type='RUN_PROGRESS' ORDER BY created_at DESC,id DESC LIMIT 200",
    [id],
  );
  const projectedSkills = assignments.map((r) =>
    skillRecord(
      r.skill,
      r.assignment,
      dependencies.filter((d) => d.skill_id === r.skill.id).map((d) => d.depends_on_skill_id),
    ),
  );
  const projectedRuns = runs.map((r) => runProjection(timestamps(r)));
  const employee = botProjection(timestamps(bot));
  const result = employeeProfileSchema.parse({
    employee,
    details: {
      description: bot.description,
      revision: bot.profile_revision,
      updatedAt: employeeTime(bot.updated_at),
    },
    evolution: events.map(evolution),
    skills: projectedSkills,
    memories: memories.map(memoryRecord),
    memoryEvents: memoryEvents.map(memoryEvent),
    records: {
      runs: projectedRuns,
      approvals: approvals.map((r) => approvalRecord(r, id)),
      artifacts: artifacts.map(artifactRecord),
      decisions: decisions(progress),
    },
    statistics: {
      totalRuns: projectedRuns.length,
      completedRuns: projectedRuns.filter((r) => r.status === "completed").length,
      failedRuns: projectedRuns.filter((r) => r.status === "failed").length,
      verifiedSkills: projectedSkills.filter((s) => s.state === "verified").length,
    },
    configuration: {
      executionProfile: bot.computer_profile,
      portabilityFormat: "openbot.employee/v1",
      ...(employee.model ? { model: employee.model } : {}),
    },
  });
  if (Buffer.byteLength(JSON.stringify(result)) > projectionMaximum)
    refuse(503, "employee_knowledge_projection_limit");
  return result;
}
export async function employeeNow(db: EmployeeDB) {
  return (await db`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`)[0]!.now as Date;
}
export async function writeEvolution(
  db: EmployeeDB,
  botId: string,
  type: string,
  title: string,
  summary: string,
  source: string,
  sourceId: string,
  refs: EmployeeRow[],
  now: Date,
) {
  const [row] =
    await db`INSERT INTO employee_evolution_events(id,bot_id,type,title,summary,source,source_id,evidence,created_at) VALUES(${randomUUID()},${botId},${type},${title},${summary},${source},${sourceId},${db.json(refs)},${now}) RETURNING *`;
  return evolution(row!);
}
export async function writeMemoryEvent(
  db: EmployeeDB,
  botId: string,
  memoryId: string,
  action: string,
  revision: number,
  fields: readonly string[],
  now: Date,
) {
  const [row] =
    await db`INSERT INTO employee_memory_events(id,bot_id,memory_id,action,revision,changed_fields,actor,created_at) VALUES(${randomUUID()},${botId},${memoryId},${action},${revision},${db.json([...fields])},'owner',${now}) RETURNING *`;
  return memoryEvent(row!);
}
export async function insertMemory(
  db: EmployeeDB,
  botId: string,
  value: EmployeeRow,
  provenance: EmployeeRow,
  now: Date,
) {
  const [row] =
    await db`INSERT INTO employee_memories(id,bot_id,kind,title,content,sensitivity,portability,model_use_enabled,provenance,revision,created_at,updated_at) VALUES(${randomUUID()},${botId},${value.kind},${value.title},${value.content},${value.sensitivity},${value.portability},${value.modelUseEnabled ?? false},${db.json(provenance)},1,${now},${now}) RETURNING *`;
  return memoryRecord(row!);
}
