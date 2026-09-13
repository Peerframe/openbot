import { employeeSkills, skills } from "@openbot/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { NativeExecutionError } from "./agent-observations.js";
import { type AgentSkillCatalog, type SkillReference, parseSkillDocument } from "./agent-skills.js";

type Database = ReturnType<typeof import("@openbot/db")["createDatabase"]>["db"];
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const eligible = (botId: string) =>
  and(
    eq(employeeSkills.botId, botId),
    eq(employeeSkills.state, "verified"),
    sql`${skills.contentSha256} is not null`,
    eq(employeeSkills.reviewedContentSha256, skills.contentSha256),
    sql`${skills.requiredCapabilities} = '[]'::jsonb`,
    sql`not exists (select 1 from skill_dependencies where skill_id = ${skills.id})`,
  );

export async function skillCatalog(db: Database, botId: string): Promise<AgentSkillCatalog> {
  const rows = await db
    .select({
      id: skills.id,
      name: skills.slug,
      description: skills.description,
      version: skills.version,
      revision: employeeSkills.revision,
      sha256: skills.contentSha256,
    })
    .from(employeeSkills)
    .innerJoin(skills, eq(employeeSkills.skillId, skills.id))
    .where(eligible(botId))
    .orderBy(desc(employeeSkills.updatedAt), desc(skills.id))
    .limit(9);
  const catalog: AgentSkillCatalog = { skills: [], truncated: rows.length > 8 };
  for (const row of rows.slice(0, 8)) {
    if (!row.sha256) continue;
    const item = { ...row, sha256: row.sha256 };
    if (Buffer.byteLength(JSON.stringify([...catalog.skills, item])) > 4096) {
      catalog.truncated = true;
      break;
    }
    catalog.skills.push(item);
  }
  return catalog;
}

/** Lock reviewed assignment revisions through publication; a resumed skill is a new revision. */
export async function assertSkillReferences(
  db: Database | Transaction,
  botId: string,
  references: SkillReference[],
) {
  if (!references.length) return;
  if (references.length > 2 || new Set(references.map((ref) => ref.id)).size !== references.length)
    throw new NativeExecutionError("task_limit");
  const rows = await db
    .select({ id: skills.id, revision: employeeSkills.revision, sha256: skills.contentSha256 })
    .from(employeeSkills)
    .innerJoin(skills, eq(employeeSkills.skillId, skills.id))
    .where(
      and(
        eligible(botId),
        inArray(
          skills.id,
          references.map((ref) => ref.id),
        ),
      ),
    )
    .orderBy(skills.id)
    .for("share");
  if (
    references.some(
      (ref) =>
        !rows.some(
          (row) => row.id === ref.id && row.revision === ref.revision && row.sha256 === ref.sha256,
        ),
    )
  )
    throw new NativeExecutionError("skills_changed");
}

export async function readSkillDocument(
  db: Database | Transaction,
  botId: string,
  reference: SkillReference,
) {
  await assertSkillReferences(db, botId, [reference]);
  const [row] = await db.select().from(skills).where(eq(skills.id, reference.id));
  if (!row?.skillMarkdown) throw new NativeExecutionError("skills_changed");
  const parsed = parseSkillDocument(row.skillMarkdown);
  if (
    parsed.sha256 !== reference.sha256 ||
    parsed.name !== row.slug ||
    parsed.description !== row.description
  )
    throw new NativeExecutionError("skills_changed");
  return {
    ...reference,
    name: row.slug,
    description: row.description,
    version: row.version,
    markdown: parsed.markdown,
  };
}
