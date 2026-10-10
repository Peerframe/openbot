/** Maintains reviewed Employee skills, memory and learning proposals under Owner authority. */
import { randomUUID } from "node:crypto";
import { deleteEmployeeMemoryInputSchema } from "@openbot/protocol";
import {
  memoryCreateInput,
  memoryUpdateInput,
  memoryPolicy,
  memoryFields,
  parseEmployee,
  proposalInput,
  proposalReviewInput,
  skillCreateInput,
  skillDocument,
  skillImportInput,
  skillStateInput,
} from "./employee-input.js";
import {
  employeeOne as one,
  employeeRows as rows,
  employeeNow as now,
  employeeProfile,
  employeeTime,
  insertMemory,
  memoryRecord,
  mergeEvidence,
  skillRecord,
  writeEvolution,
  writeMemoryEvent,
  type EmployeeDB as DB,
  type EmployeeRow as Row,
} from "./employee-records.js";
import { lockEmployeeSource } from "./employee-source-lock.js";
import { refuse } from "./owner-transaction.js";
import type { ProductRoute } from "./product-identity.js";

async function dependenciesVerified(db: DB, botId: string, ids: string[]) {
  if (!ids.length) return;
  const assigned = await rows(
    db,
    "SELECT skill_id,state FROM employee_skills WHERE bot_id=$1 AND skill_id IN (SELECT jsonb_array_elements_text($2::jsonb)) ORDER BY skill_id FOR SHARE",
    [botId, db.json(ids)],
  );
  if (assigned.length !== ids.length || assigned.some((r) => r.state !== "verified"))
    refuse(422, "skill_dependencies_not_verified");
}
async function createSkill(db: DB, botId: string, body: unknown) {
  const value = parseEmployee(skillCreateInput, body);
  const document = value.skillMarkdown === undefined ? null : skillDocument(value.skillMarkdown);
  if (
    document &&
    (document.name !== value.slug ||
      document.description !== value.description ||
      value.requiredCapabilities.length ||
      value.dependencySkillIds.length)
  )
    refuse(422, "skill_content_metadata_mismatch");
  await one(db, "SELECT id FROM bots WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", [botId]);
  await dependenciesVerified(db, botId, value.dependencySkillIds);
  const time = await now(db);
  let [skill] =
    await db`INSERT INTO skills(id,slug,name,description,version,source,required_capabilities,metadata,skill_markdown,content_sha256,created_at,updated_at) VALUES(${randomUUID()},${value.slug},${value.name},${value.description},${value.version},${value.source},${db.json(value.requiredCapabilities)},${db.json({ format: "agentskills.io" })},${document?.markdown ?? null},${document?.sha256 ?? null},${time},${time}) ON CONFLICT(slug,version) DO NOTHING RETURNING *`;
  if (skill)
    for (const dependency of value.dependencySkillIds)
      await db`INSERT INTO skill_dependencies(skill_id,depends_on_skill_id) VALUES(${skill.id},${dependency})`;
  else {
    skill = await one(
      db,
      "SELECT * FROM skills WHERE slug=$1 AND version=$2 FOR SHARE",
      [value.slug, value.version],
      "skill_not_found",
    );
    const dependencies = await rows(
      db,
      "SELECT depends_on_skill_id FROM skill_dependencies WHERE skill_id=$1 LIMIT 65",
      [skill.id],
    );
    const same = (a: unknown, b: string[]) =>
      Array.isArray(a) &&
      JSON.stringify([...new Set(a.filter((x) => typeof x === "string"))].sort()) ===
        JSON.stringify([...b].sort());
    if (
      skill.skill_markdown !== (document?.markdown ?? null) ||
      skill.name !== value.name ||
      skill.description !== value.description ||
      skill.source !== value.source ||
      !same(skill.required_capabilities, value.requiredCapabilities) ||
      !same(
        dependencies.map((r) => r.depends_on_skill_id),
        value.dependencySkillIds,
      )
    )
      refuse(409, "skill_definition_conflict");
  }
  const [assignment] =
    await db`INSERT INTO employee_skills(bot_id,skill_id,state,source,confidence,evidence,acquired_at,updated_at) VALUES(${botId},${skill.id},'candidate',${value.source},0,${db.json(value.evidence)},${time},${time}) ON CONFLICT(bot_id,skill_id) DO NOTHING RETURNING *`;
  if (!assignment) return refuse(409, "skill_already_assigned");
  return {
    skill: skillRecord(skill, assignment, value.dependencySkillIds),
    evolution: await writeEvolution(
      db,
      botId,
      "skill_discovered",
      "Candidate skill added",
      value.reason,
      value.source === "imported" ? "import" : "manual",
      skill.id,
      value.evidence,
      time,
    ),
  };
}
async function importSkill(db: DB, botId: string, body: unknown) {
  const value = parseEmployee(skillImportInput, body),
    document = skillDocument(value.markdown);
  return createSkill(db, botId, {
    slug: document.name,
    name: document.name,
    description: document.description,
    version: value.version,
    source: "manual",
    reason: value.reason,
    skillMarkdown: document.markdown,
  });
}
async function setSkillState(db: DB, botId: string, skillId: string, body: unknown) {
  const value = parseEmployee(skillStateInput, body);
  await one(db, "SELECT id FROM bots WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", [botId]);
  const record = await one(
    db,
    "SELECT to_jsonb(s) AS skill,to_jsonb(e) AS assignment FROM employee_skills e JOIN skills s ON s.id=e.skill_id WHERE e.bot_id=$1 AND e.skill_id=$2 FOR UPDATE OF e FOR SHARE OF s",
    [botId, skillId],
    "employee_skill_not_found",
  );
  const { skill, assignment: current } = record;
  if (
    value.state === "verified" &&
    skill.content_sha256 &&
    value.reviewedContentSha256 !== skill.content_sha256
  )
    refuse(409, "skill_digest_review_required");
  const allowed: Record<string, string[]> = {
    candidate: ["verified", "suspended", "revoked"],
    verified: ["suspended", "revoked"],
    suspended: ["verified", "revoked"],
    revoked: [],
  };
  if (!allowed[current.state]?.includes(value.state)) refuse(409, "skill_state_conflict");
  const dependencies = await rows(
    db,
    "SELECT depends_on_skill_id FROM skill_dependencies WHERE skill_id=$1 ORDER BY depends_on_skill_id LIMIT 65",
    [skillId],
  );
  if (dependencies.length > 64) refuse(503, "employee_knowledge_projection_limit");
  const ids = dependencies.map((r) => r.depends_on_skill_id as string);
  if (value.state === "verified") await dependenciesVerified(db, botId, ids);
  const time = await now(db);
  const [assignment] =
    await db`UPDATE employee_skills SET state=${value.state},revision=revision+1,reviewed_content_sha256=${value.state === "verified" ? skill.content_sha256 : null},confidence=${value.state === "verified" ? value.confidence : current.confidence},evidence=${db.json(mergeEvidence(current.evidence, value.evidence))},updated_at=${time} WHERE bot_id=${botId} AND skill_id=${skillId} AND revision=${current.revision} RETURNING *`;
  if (!assignment) return refuse(409, "skill_state_conflict");
  return {
    skill: skillRecord(skill, assignment, ids),
    evolution: await writeEvolution(
      db,
      botId,
      "skill_" + value.state,
      "Skill " + value.state,
      value.reason,
      "manual",
      skillId,
      value.evidence,
      time,
    ),
  };
}
async function createMemory(db: DB, botId: string, body: unknown) {
  const value = parseEmployee(memoryCreateInput, body);
  memoryPolicy(value);
  await one(db, "SELECT id FROM bots WHERE id=$1 AND deleted_at IS NULL FOR SHARE", [botId]);
  const time = await now(db),
    memory = await insertMemory(db, botId, value, { source: "owner", actor: "owner" }, time);
  return {
    memory,
    event: await writeMemoryEvent(
      db,
      botId,
      memory.id,
      "created",
      1,
      memoryFields.filter((field) => field in value),
      time,
    ),
  };
}
async function updateMemory(db: DB, botId: string, memoryId: string, body: unknown) {
  const value = parseEmployee(memoryUpdateInput, body);
  memoryPolicy(value);
  const current = memoryRecord(
    await one(
      db,
      "SELECT * FROM employee_memories WHERE bot_id=$1 AND id=$2 FOR UPDATE",
      [botId, memoryId],
      "employee_memory_not_found",
    ),
  );
  if (current.revision !== value.expectedRevision) refuse(409, "memory_revision_conflict");
  const merged = Object.fromEntries(
    memoryFields.map((field) => [field, field in value ? value[field] : current[field]]),
  );
  merged.title = merged.title.trim();
  merged.content = merged.content.trim();
  memoryPolicy(merged);
  const changed = memoryFields.filter((field) => current[field] !== merged[field]);
  if (!changed.length) refuse(422, "memory_unchanged");
  const time = await now(db);
  const [row] =
    await db`UPDATE employee_memories SET kind=${merged.kind},title=${merged.title},content=${merged.content},sensitivity=${merged.sensitivity},portability=${merged.portability},model_use_enabled=${merged.modelUseEnabled},revision=revision+1,updated_at=${time} WHERE bot_id=${botId} AND id=${memoryId} AND revision=${value.expectedRevision} RETURNING *`;
  if (!row) return refuse(409, "memory_revision_conflict");
  const memory = memoryRecord(row);
  return {
    memory,
    event: await writeMemoryEvent(db, botId, memoryId, "updated", memory.revision, changed, time),
  };
}
async function deleteMemory(db: DB, botId: string, memoryId: string, body: unknown) {
  const value = parseEmployee(deleteEmployeeMemoryInputSchema, body);
  const current = await one(
    db,
    "SELECT revision FROM employee_memories WHERE bot_id=$1 AND id=$2 FOR UPDATE",
    [botId, memoryId],
    "employee_memory_not_found",
  );
  if (current.revision !== value.expectedRevision) refuse(409, "memory_revision_conflict");
  if (
    !(
      await db`DELETE FROM employee_memories WHERE bot_id=${botId} AND id=${memoryId} AND revision=${value.expectedRevision} RETURNING id`
    ).length
  )
    refuse(409, "memory_revision_conflict");
  return {
    memoryId,
    event: await writeMemoryEvent(
      db,
      botId,
      memoryId,
      "deleted",
      current.revision + 1,
      [],
      await now(db),
    ),
  };
}
async function proposals(db: DB, botId: string) {
  await one(db, "SELECT id FROM bots WHERE id=$1 AND deleted_at IS NULL", [botId]);
  const selected = await rows(
    db,
    "SELECT * FROM knowledge_proposals WHERE bot_id=$1 AND status='pending' ORDER BY created_at ASC,id ASC LIMIT 50",
    [botId],
  );
  const result = [];
  for (const row of selected) {
    const draft = proposalInput({ kind: row.kind, title: row.title, content: row.content });
    let source: Row;
    if (row.source_kind === "channel") source = { sourceRunId: row.source_run_id };
    else {
      const [run] = await db`SELECT task_id FROM work_runs WHERE id=${row.source_work_run_id}`;
      if (!run) return refuse(503, "knowledge_proposal_source_missing");
      source = { source: { kind: "task", taskId: run.task_id, runId: row.source_work_run_id } };
    }
    result.push({
      ...draft,
      id: row.id,
      botId: row.bot_id,
      ...source,
      createdAt: employeeTime(row.created_at),
    });
  }
  return { proposals: result };
}
async function reviewProposal(db: DB, botId: string, proposalId: string, body: unknown) {
  const value = parseEmployee(proposalReviewInput, body);
  const original = await one(
    db,
    "SELECT source_kind,source_work_run_id FROM knowledge_proposals WHERE bot_id=$1 AND id=$2",
    [botId, proposalId],
    "knowledge_proposal_not_found",
  );
  let task: Row | undefined;
  if (original.source_kind === "task") {
    const record = await one(
      db,
      "SELECT p.*,r.task_id FROM knowledge_proposals p JOIN work_runs r ON r.id=p.source_work_run_id WHERE p.id=$1 AND p.bot_id=$2 AND p.source_kind='task'",
      [proposalId, botId],
      "knowledge_proposal_not_found",
    );
    task = await lockEmployeeSource(db, record.task_id);
    await one(db, "SELECT id FROM bots WHERE id=$1 FOR UPDATE", [botId]);
  }
  const proposal = await one(
    db,
    "SELECT * FROM knowledge_proposals WHERE bot_id=$1 AND id=$2 FOR UPDATE",
    [botId, proposalId],
    "knowledge_proposal_not_found",
  );
  if (proposal.status !== "pending") refuse(409, "knowledge_proposal_already_reviewed");
  let channelId: string | undefined;
  if (task) {
    const run = await one(
      db,
      "SELECT task_id,status FROM work_runs WHERE id=$1 FOR SHARE",
      [proposal.source_work_run_id],
      "source_task_not_found",
    );
    if (
      run.task_id !== task.id ||
      task.bot_id !== botId ||
      task.status !== "completed" ||
      run.status !== "completed" ||
      !task.completion_digest
    )
      refuse(409, "source_task_not_completed");
  } else
    channelId = (
      await one(
        db,
        "SELECT channel_id FROM runs WHERE id=$1 AND bot_id=$2",
        [proposal.source_run_id, botId],
        "source_task_not_found",
      )
    ).channel_id;
  const time = await now(db);
  let memoryId: string | null = null;
  if (value.decision === "accept") {
    const draft = {
      ...proposalInput({ kind: proposal.kind, title: value.title, content: value.content }),
      sensitivity: "internal",
      portability: "never",
      modelUseEnabled: value.modelUseEnabled,
    };
    const provenance = task
      ? {
          source: "reviewed-work-proposal",
          actor: "owner",
          proposalId,
          sourceTaskId: task.id,
          sourceWorkRunId: proposal.source_work_run_id,
        }
      : {
          source: "reviewed-agent-proposal",
          actor: "owner",
          proposalId,
          sourceRunId: proposal.source_run_id,
        };
    const memory = await insertMemory(db, botId, draft, provenance, time);
    memoryId = memory.id;
    await writeMemoryEvent(db, botId, memory.id, "created", 1, memoryFields, time);
  }
  await db`UPDATE knowledge_proposals SET status=${value.decision === "accept" ? "accepted" : "rejected"},title='',content='',memory_id=${memoryId},reviewed_at=${time} WHERE id=${proposalId}`;
  const payload = { actor: "owner", proposalId, decision: value.decision, memoryId };
  if (task) {
    const [updated] =
      await db`UPDATE work_tasks SET revision=revision+1 WHERE id=${task.id} RETURNING revision`;
    await db`INSERT INTO work_events(task_id,revision,kind,payload) VALUES(${task.id},${updated!.revision},'KNOWLEDGE_PROPOSAL_REVIEWED',${db.json({ ...payload, workRunId: proposal.source_work_run_id })})`;
  } else
    await db`INSERT INTO run_events(id,run_id,bot_id,channel_id,type,payload,created_at) VALUES(${randomUUID()},${proposal.source_run_id},${botId},${channelId!},'KNOWLEDGE_PROPOSAL_REVIEWED',${db.json(payload)},${time})`;
  return { proposalId, decision: value.decision, memoryId };
}
const route = (
  path: string,
  method: string,
  execute: ProductRoute["execute"],
  status = 200,
  maxBytes = 32768,
): ProductRoute => ({
  path: "/api/v1/bots/{bot_id}" + path,
  method,
  kind: "product",
  status,
  maxBytes,
  error: "employee_knowledge_storage_unavailable",
  execute,
});
export const employeeKnowledgeRoutes: readonly ProductRoute[] = [
  route("/profile", "GET", async (db, ids) => ({ profile: await employeeProfile(db, ids[0]!) })),
  route("/skills", "POST", (db, ids, body) => createSkill(db, ids[0]!, body), 201),
  route("/skills/import", "POST", (db, ids, body) => importSkill(db, ids[0]!, body), 201),
  route("/skills/{skill_id}/state", "POST", (db, ids, body) =>
    setSkillState(db, ids[0]!, ids[1]!, body),
  ),
  route("/memories", "POST", (db, ids, body) => createMemory(db, ids[0]!, body), 201),
  route("/memories/{memory_id}", "PATCH", (db, ids, body) =>
    updateMemory(db, ids[0]!, ids[1]!, body),
  ),
  route("/memories/{memory_id}", "DELETE", (db, ids, body) =>
    deleteMemory(db, ids[0]!, ids[1]!, body),
  ),
  route("/knowledge-proposals", "GET", (db, ids) => proposals(db, ids[0]!)),
  route(
    "/knowledge-proposals/{proposal_id}/review",
    "POST",
    (db, ids, body) => reviewProposal(db, ids[0]!, ids[1]!, body),
    200,
    16384,
  ),
];
