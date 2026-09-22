import { randomUUID } from "node:crypto";
import {
  artifacts as artifactsTable,
  bots,
  channelBots,
  employeeMemories,
  knowledgeProposals,
  messages,
  runEvents,
  runs,
} from "@openbot/db";
import type { KnowledgeProposalDraft, Run, RunModelUsage, RunProgress } from "@openbot/domain";
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { DelegateTaskInput } from "./agent-collaboration.js";
import {
  type AgentKnowledge,
  boundedKnowledgeText,
  type KnowledgeReference,
  validateKnowledgeProposal,
} from "./agent-knowledge.js";
import {
  NativeExecutionError,
  type NativeFailureCode,
  nativeFailureMessages,
  runModelUsageSchema,
} from "./agent-observations.js";
import type { SkillReference } from "./agent-skills.js";
import { assertSteeringApplied, readSteering, submitSteering } from "./agent-steering.js";
import type { PersistedArtifact } from "./artifact-storage.js";
import { StoreConflictError, StoreNotFoundError } from "./control-plane-store.js";
import type { AgentRunStore } from "./native-agent.js";
import {
  activeCollaborationChain,
  channelColleagues,
  createDelegatedRun,
} from "./postgres-agent-collaboration.js";
import { assertSkillReferences, readSkillDocument, skillCatalog } from "./postgres-agent-skills.js";
import { toMessage, toRun } from "./postgres-task-records.js";
import { scanSensitiveText } from "./sensitive-content.js";

type Database = ReturnType<typeof import("@openbot/db")["createDatabase"]>["db"];
const running = (run: Run) =>
  and(
    eq(runs.id, run.id),
    eq(runs.channelId, run.channelId),
    eq(runs.botId, run.botId),
    eq(runs.executionProfile, "none"),
    isNull(runs.nodeId),
    eq(runs.status, "running"),
  );
const membership = (run: Run) =>
  and(eq(channelBots.channelId, run.channelId), eq(channelBots.botId, run.botId));

/** Separate from Worker claims: a model can never acquire a Node or a computer profile here. */
export class PostgresAgentStore implements AgentRunStore {
  constructor(readonly db: Database) {}
  async lookup(runId: string): Promise<Run | undefined> {
    const [row] = await this.db.select().from(runs).where(eq(runs.id, runId));
    return row ? toRun(row) : undefined;
  }
  async steer(runId: string, instruction: string) {
    return submitSteering(this.db, runId, instruction);
  }
  async steering(run: Run) {
    await this.assertScope(run);
    return readSteering(this.db, run);
  }
  async colleagues(run: Run) {
    return channelColleagues(this.db, run);
  }
  async delegate(run: Run, input: DelegateTaskInput) {
    return createDelegatedRun(this.db, run, input);
  }
  async queued(since: string): Promise<Run[]> {
    return (
      await this.db
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.status, "queued"),
            eq(runs.executionProfile, "none"),
            isNull(runs.nodeId),
            gte(runs.createdAt, new Date(since)),
          ),
        )
        .orderBy(asc(runs.createdAt), asc(runs.id))
        .limit(100)
    ).map(toRun);
  }
  async claim(candidate: Run, since: string): Promise<Run | undefined> {
    return this.db.transaction(async (tx) => {
      // A global transaction lease bounds concurrent root claims across Server pollers.
      await tx.execute(sql`select pg_advisory_xact_lock(731, 6)`);
      const activeRoots = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.executionProfile, "none"),
            eq(runs.status, "running"),
            isNull(runs.parentRunId),
          ),
        )
        .limit(6);
      if (activeRoots.length >= 6) return undefined;
      // Serialize each Bot in its channel; independent identities can work concurrently.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${candidate.channelId}, 731))`,
      );
      const [busy] = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.channelId, candidate.channelId),
            eq(runs.botId, candidate.botId),
            eq(runs.executionProfile, "none"),
            eq(runs.status, "running"),
          ),
        )
        .limit(1);
      if (busy) return undefined;
      const [member] = await tx
        .select()
        .from(channelBots)
        .where(membership(candidate))
        .for("share");
      if (!member) return undefined;
      const [row] = await tx
        .update(runs)
        .set({ status: "running", updatedAt: new Date() })
        .where(
          and(
            eq(runs.id, candidate.id),
            eq(runs.channelId, candidate.channelId),
            eq(runs.botId, candidate.botId),
            eq(runs.status, "queued"),
            eq(runs.executionProfile, "none"),
            isNull(runs.nodeId),
            gte(runs.createdAt, new Date(since)),
          ),
        )
        .returning();
      if (!row) return undefined;
      await tx.insert(runEvents).values({
        id: randomUUID(),
        runId: row.id,
        channelId: row.channelId,
        botId: row.botId,
        type: "RUN_STARTED",
        payload: { executor: "native-agent" },
      });
      return toRun(row);
    });
  }
  async assertScope(run: Run): Promise<void> {
    // Ancestry comes from persisted rows even if a caller omits optional provenance fields.
    await activeCollaborationChain(this.db, run);
  }
  async current(run: Run): Promise<Run | undefined> {
    const [row] = await this.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.id, run.id),
          eq(runs.channelId, run.channelId),
          eq(runs.botId, run.botId),
          eq(runs.executionProfile, "none"),
          isNull(runs.nodeId),
        ),
      );
    return row ? toRun(row) : undefined;
  }
  async profile(run: Run) {
    await this.assertScope(run);
    const [profile] = await this.db
      .select({
        name: bots.name,
        role: bots.role,
        description: bots.description,
        revision: bots.profileRevision,
      })
      .from(bots)
      .where(eq(bots.id, run.botId))
      .limit(1);
    if (!profile) throw new NativeExecutionError("invalid_target");
    return profile;
  }
  async skills(run: Run) {
    await this.assertScope(run);
    return skillCatalog(this.db, run.botId);
  }
  async assertSkills(run: Run, references: SkillReference[]) {
    await assertSkillReferences(this.db, run.botId, references);
  }
  async readSkill(run: Run, reference: SkillReference) {
    return this.db.transaction(async (tx) => {
      const [active] = await tx.select({ id: runs.id }).from(runs).where(running(run)).for("share");
      if (!active) throw new NativeExecutionError("conflict");
      const document = await readSkillDocument(tx, run.botId, reference);
      await tx.insert(runEvents).values({
        id: randomUUID(),
        runId: run.id,
        channelId: run.channelId,
        botId: run.botId,
        type: "SKILL_READ",
        payload: { executor: "native-agent", ...reference },
      });
      return document;
    });
  }
  async knowledge(run: Run): Promise<AgentKnowledge> {
    await this.assertScope(run);
    return this.db.transaction(async (tx) => {
      const [active] = await tx.select({ id: runs.id }).from(runs).where(running(run)).for("share");
      if (!active) throw new NativeExecutionError("conflict");
      const rows = await tx
        .select()
        .from(employeeMemories)
        .where(
          and(
            eq(employeeMemories.botId, run.botId),
            eq(employeeMemories.modelUseEnabled, true),
            inArray(employeeMemories.sensitivity, ["public", "internal"]),
            inArray(employeeMemories.kind, ["working", "semantic", "episodic", "procedural"]),
          ),
        )
        .orderBy(desc(employeeMemories.updatedAt), desc(employeeMemories.id))
        .limit(9)
        .for("share");
      const memories: AgentKnowledge["memories"] = [];
      let truncated = rows.length > 8;
      for (const row of rows.slice(0, 8)) {
        if (
          scanSensitiveText(`${row.title}\n${row.content}`, "memory", { portable: false }).length
        ) {
          truncated = true;
          continue;
        }
        const item = {
          id: row.id,
          revision: row.revision,
          kind: row.kind,
          title: boundedKnowledgeText(row.title, 640),
          content: boundedKnowledgeText(row.content, 2000),
          truncated: Buffer.byteLength(row.content) > 2000,
          ...(row.provenance &&
          typeof row.provenance === "object" &&
          "sourceRunId" in row.provenance &&
          typeof row.provenance.sourceRunId === "string" &&
          row.provenance.sourceRunId.length <= 64
            ? { sourceRunId: row.provenance.sourceRunId }
            : {}),
        };
        if (Buffer.byteLength(JSON.stringify([...memories, item])) > 10 * 1024) {
          truncated = true;
          break;
        }
        memories.push(item);
      }
      await tx.insert(runEvents).values({
        id: randomUUID(),
        runId: run.id,
        channelId: run.channelId,
        botId: run.botId,
        type: "KNOWLEDGE_READ",
        payload: {
          executor: "native-agent",
          memories: memories.map(({ id, revision }) => ({ id, revision })),
          truncated,
        },
      });
      return { memories, truncated };
    });
  }
  async assertKnowledge(run: Run, references: KnowledgeReference[]): Promise<void> {
    if (!references.length) return;
    if (references.length > 8) throw new NativeExecutionError("task_limit");
    const rows = await this.db
      .select({ id: employeeMemories.id, revision: employeeMemories.revision })
      .from(employeeMemories)
      .where(
        and(
          eq(employeeMemories.botId, run.botId),
          eq(employeeMemories.modelUseEnabled, true),
          inArray(
            employeeMemories.id,
            references.map((item) => item.id),
          ),
          inArray(employeeMemories.sensitivity, ["public", "internal"]),
          inArray(employeeMemories.kind, ["working", "semantic", "episodic", "procedural"]),
        ),
      );
    if (
      references.some(
        (ref) => !rows.some((row) => row.id === ref.id && row.revision === ref.revision),
      )
    )
      throw new NativeExecutionError("memory_changed");
  }
  async usage(run: Run, input: RunModelUsage): Promise<Run> {
    const usage = runModelUsageSchema.parse(input);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(runs)
        .set({ modelUsage: usage, updatedAt: new Date() })
        .where(
          and(
            running(run),
            sql`coalesce((${runs.modelUsage}->>'steps')::integer, 0) = ${usage.steps - 1}`,
          ),
        )
        .returning();
      if (!row) throw new NativeExecutionError("conflict");
      await tx.insert(runEvents).values({
        id: randomUUID(),
        runId: run.id,
        channelId: run.channelId,
        botId: run.botId,
        type: "MODEL_USAGE_RECORDED",
        payload: { executor: "native-agent", ...usage },
      });
      return toRun(row);
    });
  }
  async cancel(runId: string): Promise<Run> {
    return (await this.cancelWithDescendants(runId)).run;
  }
  async cancelWithDescendants(runId: string): Promise<{ run: Run; descendants: Run[] }> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(runs).where(eq(runs.id, runId)).for("update");
      if (!row) throw new StoreNotFoundError("Task not found.");
      if (row.executionProfile !== "none" || row.nodeId !== null)
        throw new StoreConflictError("Only native Agent tasks can be stopped here.");
      if (row.status === "cancelled") return { run: toRun(row), descendants: [] };
      if (row.status !== "running" && row.status !== "queued")
        throw new StoreConflictError("This task has already ended.");
      const [cancelled] = await tx
        .update(runs)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(runs.id, row.id))
        .returning();
      if (!cancelled) throw new Error("Cancellation was not persisted.");
      await tx.insert(runEvents).values({
        id: randomUUID(),
        runId: row.id,
        channelId: row.channelId,
        botId: row.botId,
        type: "RUN_CANCELLED",
        payload: { executor: "native-agent", actor: "owner" },
      });
      const descendants = await tx
        .update(runs)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(
          and(
            eq(runs.channelId, row.channelId),
            eq(runs.executionProfile, "none"),
            isNull(runs.nodeId),
            inArray(runs.status, ["running", "queued"]),
            or(eq(runs.rootRunId, row.id), eq(runs.parentRunId, row.id)),
          ),
        )
        .returning();
      if (descendants.length)
        await tx.insert(runEvents).values(
          descendants.map((child) => ({
            id: randomUUID(),
            runId: child.id,
            channelId: child.channelId,
            botId: child.botId,
            type: "RUN_CANCELLED",
            payload: { executor: "native-agent", actor: "owner", ancestorRunId: row.id },
          })),
        );
      return { run: toRun(cancelled), descendants: descendants.map(toRun) };
    });
  }
  async initialContext(run: Run): Promise<unknown> {
    return this.context(run);
  }
  async context(run: Run): Promise<unknown> {
    await this.assertScope(run);
    const [source] = await this.db
      .select({
        id: messages.id,
        rootRunId: runs.rootRunId,
        replyToMessageId: messages.replyToMessageId,
      })
      .from(runs)
      .innerJoin(messages, eq(messages.id, runs.sourceMessageId))
      .where(
        and(
          eq(runs.id, run.id),
          eq(runs.channelId, run.channelId),
          eq(messages.channelId, run.channelId),
        ),
      )
      .limit(1);
    if (!source) throw new NativeExecutionError("invalid_target");
    // Delegated runs freeze against the root source message. Confirm that root still exists
    // without loading its timestamp through JS Date (which drops PostgreSQL microseconds).
    if (source.rootRunId !== null) {
      const [rootSource] = await this.db
        .select({ id: messages.id })
        .from(runs)
        .innerJoin(messages, eq(messages.id, runs.sourceMessageId))
        .where(
          and(
            eq(runs.id, source.rootRunId),
            eq(runs.channelId, run.channelId),
            eq(messages.channelId, run.channelId),
          ),
        )
        .limit(1);
      if (!rootSource) throw new NativeExecutionError("invalid_target");
    }
    const [started] = await this.db
      .select({ id: runEvents.id })
      .from(runEvents)
      .where(and(eq(runEvents.runId, run.id), eq(runEvents.type, "RUN_STARTED")))
      .orderBy(asc(runEvents.createdAt))
      .limit(1);
    // Freeze history at the persisted start, not at each model tool call. New human messages
    // remain separate queued tasks; only preceding task trees may contribute late Bot replies.
    if (!started) throw new NativeExecutionError("conflict");
    // Compare timestamptz in SQL so same-millisecond, earlier-microsecond Bot replies before
    // RUN_STARTED stay included. JS Date / toISOString() would truncate to milliseconds.
    const boundaryRunId = source.rootRunId ?? run.id;
    const inputBoundary = sql`(
      select sm.created_at
      from runs boundary_run
      join messages sm on sm.id = boundary_run.source_message_id
      where boundary_run.id = ${boundaryRunId}
        and boundary_run.channel_id = ${run.channelId}
        and sm.channel_id = ${run.channelId}
      limit 1
    )`;
    const startCutoff = sql`(
      select re.created_at
      from run_events re
      where re.run_id = ${run.id}
        and re.type = 'RUN_STARTED'
      order by re.created_at asc
      limit 1
    )`;
    const projection = {
      id: messages.id,
      author: messages.authorType,
      authorId: messages.authorId,
      content: messages.content,
    };
    const rows = await this.db
      .select(projection)
      .from(messages)
      .where(
        and(
          eq(messages.channelId, run.channelId),
          or(
            eq(messages.id, source.id),
            sql`${messages.createdAt} <= ${inputBoundary}`,
            and(
              eq(messages.authorType, "bot"),
              sql`${messages.createdAt} <= ${startCutoff}`,
              sql`exists (
            select 1 from runs reply_run
            join runs root_run on root_run.id = coalesce(reply_run.root_run_id, reply_run.id)
            join messages root_source on root_source.id = root_run.source_message_id
            where reply_run.id = ${messages.runId}
              and reply_run.channel_id = ${run.channelId} and root_run.channel_id = ${run.channelId}
              and root_source.channel_id = ${run.channelId}
              and root_source.created_at <= ${inputBoundary}
          )`,
            ),
          ),
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(12);
    const [reference] =
      source.replyToMessageId === null
        ? []
        : await this.db
            .select(projection)
            .from(messages)
            .where(
              and(eq(messages.id, source.replyToMessageId), eq(messages.channelId, run.channelId)),
            )
            .limit(1);
    const selected = reference
      ? [{ ...reference, referenced: true }, ...rows.filter((row) => row.id !== reference.id)]
      : rows;
    let remaining = 10_000;
    return selected
      .map((row) => {
        const content = boundedKnowledgeText(row.content, Math.min(1600, remaining));
        remaining = Math.max(0, remaining - Buffer.byteLength(content));
        return { ...row, content };
      })
      .reverse();
  }
  async tasks(run: Run): Promise<unknown> {
    await this.assertScope(run);
    return this.db
      .select({ title: sql<string>`left(${runs.title}, 240)`, status: runs.status })
      .from(runs)
      .where(and(eq(runs.channelId, run.channelId), lte(runs.createdAt, new Date(run.createdAt))))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(8);
  }
  async progress(run: Run, stage: string, message: string): Promise<RunProgress> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(runs)
        .set({ updatedAt: new Date() })
        .where(running(run))
        .returning();
      if (!row) throw new Error("Run is no longer active.");
      const id = randomUUID(),
        createdAt = new Date();
      await tx.insert(runEvents).values({
        id,
        runId: run.id,
        channelId: run.channelId,
        botId: run.botId,
        type: "RUN_PROGRESS",
        payload: { stage, message },
        createdAt,
      });
      return {
        id,
        runId: run.id,
        channelId: run.channelId,
        stage,
        message,
        createdAt: createdAt.toISOString(),
      };
    });
  }
  async complete(
    run: Run,
    text: string,
    artifacts: PersistedArtifact[] = [],
    proposalInput?: KnowledgeProposalDraft,
    references: KnowledgeReference[] = [],
    skillReferences: SkillReference[] = [],
    appliedSteeringIds: string[] = [],
  ) {
    if (references.length > 8) throw new NativeExecutionError("task_limit");
    const proposal =
      proposalInput === undefined ? undefined : validateKnowledgeProposal(proposalInput);
    if (!text.trim() || text.length > 8000) throw new Error("Invalid final answer.");
    if (
      artifacts.length > 2 ||
      artifacts.some(
        (record) =>
          record.artifact.runId !== run.id ||
          record.artifact.mediaType !== "text/markdown" ||
          !record.storageKey.startsWith(`runs/${run.id}/`),
      )
    ) {
      throw new Error("Artifact does not belong to this native task.");
    }
    return this.db.transaction(async (tx) => {
      // Share the creation lease so a child cannot appear after the terminal-state check.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${run.channelId}, 731))`);
      await activeCollaborationChain(tx, run, "ancestors");
      const [unfinished] = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.channelId, run.channelId),
            inArray(runs.status, ["running", "queued"]),
            or(eq(runs.rootRunId, run.id), eq(runs.parentRunId, run.id)),
          ),
        )
        .limit(1);
      if (unfinished)
        throw new StoreConflictError("Delegated tasks must finish before their parent completes.");
      const [member] = await tx.select().from(channelBots).where(membership(run)).for("share");
      if (!member) throw new NativeExecutionError("scope_revoked");
      await assertSteeringApplied(tx, run, appliedSteeringIds);
      const now = new Date();
      const [row] = await tx
        .update(runs)
        .set({ status: "completed", resultSummary: text, updatedAt: now })
        .where(running(run))
        .returning();
      if (!row) throw new Error("Run is no longer active.");
      await assertSkillReferences(tx, run.botId, skillReferences);
      if (references.length) {
        const memories = await tx
          .select({ id: employeeMemories.id, revision: employeeMemories.revision })
          .from(employeeMemories)
          .where(
            and(
              eq(employeeMemories.botId, run.botId),
              eq(employeeMemories.modelUseEnabled, true),
              inArray(
                employeeMemories.id,
                references.map((ref) => ref.id),
              ),
              inArray(employeeMemories.sensitivity, ["public", "internal"]),
              inArray(employeeMemories.kind, ["working", "semantic", "episodic", "procedural"]),
            ),
          )
          .for("share");
        if (
          references.some(
            (ref) =>
              !memories.some((memory) => memory.id === ref.id && memory.revision === ref.revision),
          )
        )
          throw new NativeExecutionError("memory_changed");
      }
      const [message] = await tx
        .insert(messages)
        .values({
          id: randomUUID(),
          channelId: row.channelId,
          authorType: "bot",
          authorId: row.botId,
          replyToMessageId: row.sourceMessageId,
          runId: row.id,
          content: text,
          createdAt: now,
        })
        .returning();
      if (!message) throw new Error("Reply was not persisted.");
      if (proposal) {
        // Serialize the per-Bot pending cap across concurrent channels before inserting a proposal.
        await tx.select({ id: bots.id }).from(bots).where(eq(bots.id, run.botId)).for("update");
        const pending = await tx
          .select({ id: knowledgeProposals.id })
          .from(knowledgeProposals)
          .where(
            and(eq(knowledgeProposals.botId, run.botId), eq(knowledgeProposals.status, "pending")),
          )
          .limit(50);
        if (pending.length >= 50) throw new NativeExecutionError("task_limit");
        const proposalId = randomUUID();
        await tx.insert(knowledgeProposals).values({
          id: proposalId,
          botId: run.botId,
          sourceRunId: run.id,
          ...proposal,
          createdAt: now,
        });
        await tx.insert(runEvents).values({
          id: randomUUID(),
          runId: run.id,
          botId: run.botId,
          channelId: run.channelId,
          type: "KNOWLEDGE_PROPOSED",
          payload: { executor: "native-agent", proposalId },
        });
      }
      if (artifacts.length) {
        await tx.insert(artifactsTable).values(
          artifacts.map((record) => ({
            id: record.artifact.id,
            runId: run.id,
            name: record.artifact.name,
            mediaType: record.artifact.mediaType,
            storageKey: record.storageKey,
            sha256: record.artifact.sha256,
            metadata: { ...record.metadata, sizeBytes: record.artifact.sizeBytes },
            createdAt: new Date(record.artifact.createdAt),
          })),
        );
      }
      await tx.insert(runEvents).values([
        {
          id: randomUUID(),
          runId: row.id,
          channelId: row.channelId,
          botId: row.botId,
          type: "MESSAGE_CREATED",
          payload: { messageId: message.id },
        },
        {
          id: randomUUID(),
          runId: row.id,
          channelId: row.channelId,
          botId: row.botId,
          type: "RUN_COMPLETED",
          payload: {
            executor: "native-agent",
            summary: text,
            artifactIds: artifacts.map((record) => record.artifact.id),
          },
        },
      ]);
      return {
        run: toRun(row),
        message: toMessage(message),
        artifacts: artifacts.map((record) => record.artifact),
      };
    });
  }
  async fail(run: Run, code: NativeFailureCode = "execution_failed"): Promise<Run | undefined> {
    return this.db.transaction(async (tx) => {
      const errorMessage = nativeFailureMessages[code];
      const [row] = await tx
        .update(runs)
        .set({ status: "failed", errorMessage, errorCode: code, updatedAt: new Date() })
        .where(running(run))
        .returning();
      if (!row) return undefined;
      await tx.insert(runEvents).values({
        id: randomUUID(),
        runId: row.id,
        channelId: row.channelId,
        botId: row.botId,
        type: "RUN_FAILED",
        payload: {
          code,
          message: errorMessage,
          executor: "native-agent",
        },
      });
      // A failed ancestor cannot leave descendants running and monopolize the channel lease.
      const descendants = await tx
        .update(runs)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(
          and(
            eq(runs.channelId, row.channelId),
            eq(runs.executionProfile, "none"),
            isNull(runs.nodeId),
            inArray(runs.status, ["running", "queued"]),
            or(eq(runs.rootRunId, row.id), eq(runs.parentRunId, row.id)),
          ),
        )
        .returning();
      if (descendants.length)
        await tx.insert(runEvents).values(
          descendants.map((child) => ({
            id: randomUUID(),
            runId: child.id,
            channelId: child.channelId,
            botId: child.botId,
            type: "RUN_CANCELLED",
            payload: { executor: "native-agent", actor: "ancestor-failure", ancestorRunId: row.id },
          })),
        );
      return toRun(row);
    });
  }
}
