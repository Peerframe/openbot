import { createHash, randomUUID } from "node:crypto";
import {
  approvals as approvalsTable,
  artifacts as artifactsTable,
  bots,
  channelBots,
  channels,
  employeeEvolutionEvents,
  employeeImportReceipts,
  employeeMemories,
  employeeMemoryEvents,
  employeeSkills,
  messages,
  nodes,
  runEvents,
  runs,
  skillDependencies,
  skills,
} from "@openbot/db";
import type {
  Approval,
  ApprovalDecision,
  ApprovalResolution,
  Artifact,
  Bot,
  Channel,
  CreateBotInput,
  CreateChannelInput,
  CreateEmployeeMemoryInput,
  CreateEmployeeSkillInput,
  CreateMessageInput,
  DeleteEmployeeMemoryInput,
  EmployeeDecisionTrace,
  EmployeeEvidenceReference,
  EmployeeEvolutionEvent,
  EmployeeImportActivationResult,
  EmployeeImportReceipt,
  EmployeeMemory,
  EmployeeMemoryDeletionResult,
  EmployeeMemoryEvent,
  EmployeeMemoryMutationResult,
  EmployeeProfile,
  EmployeeProfileChangedField,
  EmployeeProfileDetailsMutationResult,
  EmployeeSkill,
  EmployeeSkillMutationResult,
  ExecutionNode,
  Message,
  Run,
  RunProgress,
  SubmitTaskResult,
  UpdateEmployeeMemoryInput,
  UpdateEmployeeProfileDetailsInput,
  UpdateEmployeeSkillStateInput,
} from "@openbot/domain";
import type { RunFailureCode } from "@openbot/protocol";
import { and, asc, count, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { parseSkillDocument } from "./agent-skills.js";
import type {
  ActivateEmployeeImportCommand,
  ArtifactRecord,
  ControlPlaneStore,
  DispatchFailureInput,
  PersistedCounts,
  RequestApprovalInput,
  RunCompletion,
} from "./control-plane-store.js";
import {
  StoreConflictError,
  StoreNotFoundError,
  StoreValidationError,
} from "./control-plane-store.js";
import { skillContentProblem } from "./employee-package-content.js";
import { toMessage, toRun } from "./postgres-task-records.js";
import { submitTaskInTransaction } from "./postgres-task-submission.js";
import { scanSensitiveText } from "./sensitive-content.js";

type Database = ReturnType<typeof import("@openbot/db")["createDatabase"]>["db"];

const activeRunStatuses = ["queued", "assigned", "running", "waiting_approval", "blocked"];

export class PostgresControlPlaneStore implements ControlPlaneStore {
  readonly #db: Database;

  constructor(database: Database) {
    this.#db = database;
  }

  async channelExists(channelId: string): Promise<boolean> {
    const rows = await this.#db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);
    return rows.length > 0;
  }

  async listChannels(): Promise<Channel[]> {
    const rows = await this.#db
      .select({
        id: channels.id,
        name: channels.name,
        description: channels.description,
        directBotId: channels.directBotId,
        createdAt: channels.createdAt,
        botId: channelBots.botId,
      })
      .from(channels)
      .leftJoin(channelBots, eq(channelBots.channelId, channels.id))
      .orderBy(desc(channels.createdAt));

    const result = new Map<string, Channel>();
    for (const row of rows) {
      const channel = result.get(row.id) ?? {
        id: row.id,
        name: row.name,
        description: row.description,
        ...(row.directBotId === null ? {} : { directBotId: row.directBotId }),
        botIds: [],
        createdAt: row.createdAt.toISOString(),
      };
      if (row.botId !== null) {
        channel.botIds.push(row.botId);
      }
      result.set(row.id, channel);
    }
    return Array.from(result.values());
  }

  async listBots(): Promise<Bot[]> {
    const rows = await this.#db.select().from(bots).orderBy(desc(bots.createdAt));
    return rows.map(toBot);
  }

  async getEmployeeProfile(botId: string): Promise<EmployeeProfile> {
    const [botRow] = await this.#db.select().from(bots).where(eq(bots.id, botId)).limit(1);
    if (botRow === undefined) throw new StoreNotFoundError("Bot not found.");

    const [
      evolutionRows,
      skillRows,
      dependencyRows,
      memoryRows,
      memoryEventRows,
      runRows,
      approvalRows,
      artifactRows,
      progressRows,
    ] = await Promise.all([
      this.#db
        .select()
        .from(employeeEvolutionEvents)
        .where(eq(employeeEvolutionEvents.botId, botId))
        .orderBy(desc(employeeEvolutionEvents.createdAt))
        .limit(100),
      this.#db
        .select({ assignment: employeeSkills, skill: skills })
        .from(employeeSkills)
        .innerJoin(skills, eq(employeeSkills.skillId, skills.id))
        .where(eq(employeeSkills.botId, botId))
        .orderBy(desc(employeeSkills.updatedAt))
        .limit(100),
      this.#db
        .select({
          skillId: skillDependencies.skillId,
          dependsOnSkillId: skillDependencies.dependsOnSkillId,
        })
        .from(skillDependencies)
        .innerJoin(employeeSkills, eq(skillDependencies.skillId, employeeSkills.skillId))
        .where(eq(employeeSkills.botId, botId)),
      this.#db
        .select()
        .from(employeeMemories)
        .where(eq(employeeMemories.botId, botId))
        .orderBy(desc(employeeMemories.updatedAt))
        .limit(100),
      this.#db
        .select()
        .from(employeeMemoryEvents)
        .where(eq(employeeMemoryEvents.botId, botId))
        .orderBy(desc(employeeMemoryEvents.createdAt))
        .limit(200),
      this.#db
        .select()
        .from(runs)
        .where(eq(runs.botId, botId))
        .orderBy(desc(runs.createdAt))
        .limit(50),
      this.#db
        .select({ approval: approvalsTable, channelId: runs.channelId })
        .from(approvalsTable)
        .innerJoin(runs, eq(approvalsTable.runId, runs.id))
        .where(eq(runs.botId, botId))
        .orderBy(desc(approvalsTable.createdAt))
        .limit(100),
      this.#db
        .select({ artifact: artifactsTable })
        .from(artifactsTable)
        .innerJoin(runs, eq(artifactsTable.runId, runs.id))
        .where(eq(runs.botId, botId))
        .orderBy(desc(artifactsTable.createdAt))
        .limit(100),
      this.#db
        .select()
        .from(runEvents)
        .where(and(eq(runEvents.botId, botId), eq(runEvents.type, "RUN_PROGRESS")))
        .orderBy(desc(runEvents.createdAt))
        .limit(200),
    ]);

    const dependencyIds = new Map<string, string[]>();
    for (const row of dependencyRows) {
      const ids = dependencyIds.get(row.skillId) ?? [];
      ids.push(row.dependsOnSkillId);
      dependencyIds.set(row.skillId, ids);
    }

    const employeeRuns = runRows.map(toRun);
    const employeeSkillsProjection = skillRows.map((row) =>
      toEmployeeSkill(row.skill, row.assignment, dependencyIds.get(row.skill.id) ?? []),
    );
    const decisions = progressRows.flatMap(toEmployeeDecisionTrace);
    return {
      employee: toBot(botRow),
      details: {
        description: botRow.description,
        revision: botRow.profileRevision,
        updatedAt: botRow.updatedAt.toISOString(),
      },
      evolution: evolutionRows.map(toEmployeeEvolutionEvent),
      skills: employeeSkillsProjection,
      memories: memoryRows.map(toEmployeeMemory),
      memoryEvents: memoryEventRows.map(toEmployeeMemoryEvent),
      records: {
        runs: employeeRuns,
        approvals: approvalRows.map((row) => toApproval(row.approval, row.channelId, botId)),
        artifacts: artifactRows.map((row) => toArtifact(row.artifact)),
        decisions,
      },
      statistics: {
        totalRuns: employeeRuns.length,
        completedRuns: employeeRuns.filter((run) => run.status === "completed").length,
        failedRuns: employeeRuns.filter((run) => run.status === "failed").length,
        verifiedSkills: employeeSkillsProjection.filter((skill) => skill.state === "verified")
          .length,
      },
      configuration: {
        executionProfile: botRow.computerProfile as Bot["computerProfile"],
        portabilityFormat: "openbot.employee/v1",
      },
    };
  }

  async updateEmployeeProfileDetails(
    botId: string,
    input: UpdateEmployeeProfileDetailsInput,
  ): Promise<EmployeeProfileDetailsMutationResult> {
    const role = input.role.trim();
    const description = input.description.trim();

    return this.#db.transaction(async (transaction) => {
      const [current] = await transaction.select().from(bots).where(eq(bots.id, botId)).limit(1);
      if (current === undefined) throw new StoreNotFoundError("Bot not found.");
      if (current.profileRevision !== input.expectedRevision) {
        throw new StoreConflictError(
          "The Employee profile changed while it was being edited. Reload and review the current values.",
        );
      }

      const changedFields: EmployeeProfileChangedField[] = [];
      if (current.role !== role) changedFields.push("role");
      if (current.description !== description) changedFields.push("description");
      if (changedFields.length === 0) {
        throw new StoreValidationError("At least one Employee profile field must change.");
      }

      const now = new Date();
      const nextRevision = current.profileRevision + 1;
      const [updated] = await transaction
        .update(bots)
        .set({ role, description, profileRevision: nextRevision, updatedAt: now })
        .where(and(eq(bots.id, botId), eq(bots.profileRevision, input.expectedRevision)))
        .returning();
      if (updated === undefined) {
        throw new StoreConflictError(
          "The Employee profile changed while it was being edited. Reload and review the current values.",
        );
      }

      const [evolution] = await transaction
        .insert(employeeEvolutionEvents)
        .values({
          id: randomUUID(),
          botId,
          type: changedFields.includes("role") ? "role_changed" : "configuration_changed",
          title: changedFields.includes("role") ? "Employee role updated" : "Profile updated",
          summary: `Owner updated: ${changedFields.join(", ")}.`,
          source: "manual",
          evidence: [],
          createdAt: now,
        })
        .returning();
      if (evolution === undefined) throw new Error("Evolution event was not created.");

      await transaction.insert(runEvents).values({
        id: randomUUID(),
        botId,
        type: "EMPLOYEE_PROFILE_UPDATED",
        payload: { changedFields, revision: nextRevision },
        createdAt: now,
      });

      return {
        employee: toBot(updated),
        details: {
          description: updated.description,
          revision: updated.profileRevision,
          updatedAt: updated.updatedAt.toISOString(),
        },
        evolution: toEmployeeEvolutionEvent(evolution),
      };
    });
  }

  async listMessages(channelId: string): Promise<Message[]> {
    await this.#requireChannel(channelId);
    const rows = await this.#db
      .select()
      .from(messages)
      .where(eq(messages.channelId, channelId))
      .orderBy(desc(messages.createdAt))
      .limit(100);
    return rows.reverse().map(toMessage);
  }

  async listRuns(channelId?: string): Promise<Run[]> {
    if (channelId !== undefined) {
      await this.#requireChannel(channelId);
      const rows = await this.#db
        .select()
        .from(runs)
        .where(eq(runs.channelId, channelId))
        .orderBy(desc(runs.createdAt))
        .limit(50);
      return rows.map(toRun);
    }

    const rows = await this.#db.select().from(runs).orderBy(desc(runs.createdAt)).limit(50);
    return rows.map(toRun);
  }

  async listApprovals(): Promise<Approval[]> {
    const rows = await this.#db
      .select({ approval: approvalsTable, channelId: runs.channelId, botId: runs.botId })
      .from(approvalsTable)
      .innerJoin(runs, eq(approvalsTable.runId, runs.id))
      .orderBy(desc(approvalsTable.createdAt))
      .limit(100);
    return rows.map((row) => toApproval(row.approval, row.channelId, row.botId));
  }

  async listRunProgress(channelId?: string): Promise<RunProgress[]> {
    if (channelId !== undefined) await this.#requireChannel(channelId);
    const query = this.#db
      .select()
      .from(runEvents)
      .where(
        channelId === undefined
          ? eq(runEvents.type, "RUN_PROGRESS")
          : and(eq(runEvents.type, "RUN_PROGRESS"), eq(runEvents.channelId, channelId)),
      )
      .orderBy(desc(runEvents.createdAt))
      .limit(200);
    const rows = await query;
    return rows.reverse().flatMap(toRunProgress);
  }

  async listArtifacts(runId?: string): Promise<Artifact[]> {
    const query = this.#db.select().from(artifactsTable);
    const rows = await (runId === undefined
      ? query.orderBy(desc(artifactsTable.createdAt)).limit(100)
      : query
          .where(eq(artifactsTable.runId, runId))
          .orderBy(desc(artifactsTable.createdAt))
          .limit(100));
    return rows.map(toArtifact);
  }

  async getArtifact(artifactId: string): Promise<ArtifactRecord | undefined> {
    const [row] = await this.#db
      .select()
      .from(artifactsTable)
      .where(eq(artifactsTable.id, artifactId))
      .limit(1);
    return row === undefined ? undefined : toArtifactRecord(row);
  }

  async listDispatchableRuns(limit = 50): Promise<Run[]> {
    const rows = await this.#db
      .select()
      .from(runs)
      .where(and(eq(runs.status, "queued"), isNull(runs.nodeId), ne(runs.executionProfile, "none")))
      .orderBy(asc(runs.createdAt), asc(runs.id))
      .limit(limit);
    return rows.map(toRun);
  }

  async getRunningRunForNode(runId: string, nodeId: string): Promise<Run | undefined> {
    const [row] = await this.#db
      .select()
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.nodeId, nodeId), eq(runs.status, "running")))
      .limit(1);
    return row === undefined ? undefined : toRun(row);
  }

  async getCounts(): Promise<PersistedCounts> {
    const [channelCount, botCount, activeRunCount] = await Promise.all([
      this.#db.select({ value: count() }).from(channels),
      this.#db.select({ value: count() }).from(bots),
      this.#db.select({ value: count() }).from(runs).where(inArray(runs.status, activeRunStatuses)),
    ]);
    return {
      channels: channelCount[0]?.value ?? 0,
      bots: botCount[0]?.value ?? 0,
      activeRuns: activeRunCount[0]?.value ?? 0,
    };
  }

  async createBot(input: CreateBotInput): Promise<Bot> {
    const now = new Date();
    const bot = {
      id: randomUUID(),
      name: input.name,
      role: input.role,
      status: "idle" as const,
      computerProfile: input.computerProfile,
      configuration: input.appearance === undefined ? {} : { appearance: input.appearance },
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.#db.transaction(async (transaction) => {
        await transaction.insert(bots).values(bot);
        await transaction.insert(employeeEvolutionEvents).values({
          id: randomUUID(),
          botId: bot.id,
          type: "created",
          title: "Employee created",
          summary: `${bot.name} was created with the ${bot.role} role.`,
          source: "manual",
          evidence: [],
          createdAt: now,
        });
        await transaction.insert(runEvents).values({
          id: randomUUID(),
          botId: bot.id,
          type: "BOT_CREATED",
          payload: { name: bot.name, role: bot.role },
        });
      });
    } catch (error) {
      translateDatabaseError(error, `A Bot named “${input.name}” already exists.`);
    }

    return toBot(bot);
  }

  async activateEmployeeImport(
    input: ActivateEmployeeImportCommand,
  ): Promise<EmployeeImportActivationResult> {
    const payload = input.document.payload;
    for (const skill of payload.skills) {
      const problem = skillContentProblem(skill);
      if (problem) throw new StoreValidationError(problem);
    }
    const employeeName = input.employeeName ?? payload.employee.name;
    const requestFingerprint = employeeImportRequestFingerprint(input, employeeName);

    try {
      return await this.#db.transaction(async (transaction) => {
        const importLockKeys = [
          `employee-import:idempotency:${input.idempotencyKey}`,
          `employee-import:package:${payload.packageId}`,
        ].sort();
        for (const lockKey of importLockKeys) {
          await transaction.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
          );
        }

        const [idempotentReceipt] = await transaction
          .select({ receipt: employeeImportReceipts, employee: bots })
          .from(employeeImportReceipts)
          .innerJoin(bots, eq(employeeImportReceipts.employeeId, bots.id))
          .where(eq(employeeImportReceipts.idempotencyKey, input.idempotencyKey))
          .limit(1);
        if (idempotentReceipt !== undefined) {
          if (idempotentReceipt.receipt.requestFingerprint !== requestFingerprint) {
            throw new StoreConflictError(
              "This idempotency key was already used for a different Employee import.",
            );
          }
          return {
            employee: toBot(idempotentReceipt.employee),
            receipt: toEmployeeImportReceipt(idempotentReceipt.receipt),
            replayed: true,
          };
        }

        const existingPackage = await transaction
          .select({ id: employeeImportReceipts.id })
          .from(employeeImportReceipts)
          .where(eq(employeeImportReceipts.packageId, payload.packageId))
          .limit(1);
        if (existingPackage.length > 0) {
          throw new StoreConflictError("This Employee package was already activated.");
        }

        const now = new Date();
        const reviewedAt = new Date(input.reviewedAt);
        const employeeRow = {
          id: randomUUID(),
          name: employeeName,
          role: payload.employee.role,
          description: payload.employee.description ?? "",
          profileRevision: 1,
          status: "idle" as const,
          computerProfile: payload.configuration.recommendedExecutionProfile,
          configuration:
            payload.employee.appearance === undefined
              ? {}
              : { appearance: payload.employee.appearance },
          createdAt: now,
          updatedAt: now,
        };
        await transaction.insert(bots).values(employeeRow);

        const skillBySlug = new Map<string, typeof skills.$inferSelect>();
        const insertedSkillIds = new Set<string>();
        for (const portableSkill of payload.skills) {
          const insertedRows = await transaction
            .insert(skills)
            .values({
              id: randomUUID(),
              slug: portableSkill.slug,
              name: portableSkill.name,
              description: portableSkill.description,
              version: portableSkill.version,
              source: "imported",
              requiredCapabilities: portableSkill.requiredCapabilities,
              metadata: { format: "agentskills.io" },
              skillMarkdown: portableSkill.content?.markdown ?? null,
              contentSha256: portableSkill.content?.sha256 ?? null,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing({ target: [skills.slug, skills.version] })
            .returning();
          const insertedSkill = insertedRows[0];
          const [resolvedSkill] =
            insertedSkill === undefined
              ? await transaction
                  .select()
                  .from(skills)
                  .where(
                    and(
                      eq(skills.slug, portableSkill.slug),
                      eq(skills.version, portableSkill.version),
                    ),
                  )
                  .limit(1)
              : [insertedSkill];
          if (resolvedSkill === undefined) {
            throw new StoreConflictError("The skill definition changed during Employee import.");
          }
          if (
            resolvedSkill.skillMarkdown !== (portableSkill.content?.markdown ?? null) ||
            resolvedSkill.contentSha256 !== (portableSkill.content?.sha256 ?? null) ||
            resolvedSkill.name !== portableSkill.name ||
            resolvedSkill.description !== portableSkill.description ||
            !sameStringSet(
              toStringArray(resolvedSkill.requiredCapabilities),
              portableSkill.requiredCapabilities,
            )
          ) {
            throw new StoreConflictError(
              `Skill ${portableSkill.slug}@${portableSkill.version} already identifies a different definition.`,
            );
          }
          skillBySlug.set(portableSkill.slug, resolvedSkill);
          if (insertedSkill !== undefined) insertedSkillIds.add(insertedSkill.id);
        }

        for (const portableSkill of payload.skills) {
          const skill = skillBySlug.get(portableSkill.slug);
          if (skill === undefined) {
            throw new StoreValidationError(
              `Imported skill ${portableSkill.slug} was not resolved.`,
            );
          }
          const dependencyIds = portableSkill.dependencySlugs.map((dependencySlug) => {
            const dependency = skillBySlug.get(dependencySlug);
            if (dependency === undefined) {
              throw new StoreValidationError(
                `Imported skill dependency ${dependencySlug} was not resolved.`,
              );
            }
            return dependency.id;
          });
          if (insertedSkillIds.has(skill.id)) {
            if (dependencyIds.length > 0) {
              await transaction.insert(skillDependencies).values(
                dependencyIds.map((dependencyId) => ({
                  skillId: skill.id,
                  dependsOnSkillId: dependencyId,
                })),
              );
            }
          } else {
            const dependencyRows = await transaction
              .select({ id: skillDependencies.dependsOnSkillId })
              .from(skillDependencies)
              .where(eq(skillDependencies.skillId, skill.id));
            if (
              !sameStringSet(
                dependencyRows.map((row) => row.id),
                dependencyIds,
              )
            ) {
              throw new StoreConflictError(
                `Skill ${portableSkill.slug}@${portableSkill.version} has a different dependency graph.`,
              );
            }
          }
        }

        if (payload.skills.length > 0) {
          await transaction.insert(employeeSkills).values(
            payload.skills.map((portableSkill) => {
              const skill = skillBySlug.get(portableSkill.slug);
              if (skill === undefined) {
                throw new StoreValidationError(
                  `Imported skill ${portableSkill.slug} was not resolved.`,
                );
              }
              return {
                botId: employeeRow.id,
                skillId: skill.id,
                state: "candidate",
                source: "imported",
                confidence: 0,
                evidence: [
                  {
                    kind: "import",
                    id: payload.packageId,
                    label: "Reviewed Employee package",
                  },
                ],
                acquiredAt: now,
                updatedAt: now,
              };
            }),
          );
        }

        await transaction.insert(employeeEvolutionEvents).values({
          id: randomUUID(),
          botId: employeeRow.id,
          type: "imported",
          title: "Employee imported",
          summary: `${employeeRow.name} was activated from an Owner-reviewed portable package.`,
          source: "import",
          sourceId: payload.packageId,
          evidence: [{ kind: "import", id: payload.packageId, label: input.packageDigest }],
          createdAt: now,
        });
        await transaction.insert(runEvents).values({
          id: randomUUID(),
          botId: employeeRow.id,
          type: "BOT_IMPORTED",
          payload: {
            packageId: payload.packageId,
            packageDigest: input.packageDigest,
            importedSkillCount: payload.skills.length,
          },
          createdAt: now,
        });

        const receiptRows = await transaction
          .insert(employeeImportReceipts)
          .values({
            id: randomUUID(),
            packageId: payload.packageId,
            packageDigest: input.packageDigest,
            employeeId: employeeRow.id,
            idempotencyKey: input.idempotencyKey,
            requestFingerprint,
            signatureStatus: input.signature.status,
            publisherKeyId:
              input.signature.status === "dsse" ? input.signature.trustedPublisherKeyId : null,
            reviewedBy: input.reviewedBy,
            reviewedAt,
            importedSkillCount: payload.skills.length,
            createdAt: now,
          })
          .returning();
        const receipt = receiptRows[0];
        if (receipt === undefined) throw new Error("Employee import receipt was not created.");

        return {
          employee: toBot(employeeRow),
          receipt: toEmployeeImportReceipt(receipt),
          replayed: false,
        };
      });
    } catch (error) {
      if (
        error instanceof StoreConflictError ||
        error instanceof StoreNotFoundError ||
        error instanceof StoreValidationError
      ) {
        throw error;
      }
      translateDatabaseError(
        error,
        "The Employee name, package, or idempotency key already exists.",
      );
    }
  }

  async createEmployeeSkill(
    botId: string,
    input: CreateEmployeeSkillInput,
  ): Promise<EmployeeSkillMutationResult> {
    const document =
      input.skillMarkdown === undefined ? undefined : parseSkillDocument(input.skillMarkdown);
    if (
      document &&
      (document.name !== input.slug ||
        document.description !== input.description ||
        input.requiredCapabilities.length ||
        input.dependencySkillIds.length)
    )
      throw new StoreValidationError(
        "Skill content must match its metadata and use only existing native tools without dependencies.",
      );
    return this.#db.transaction(async (transaction) => {
      const botRows = await transaction
        .select({ id: bots.id })
        .from(bots)
        .where(eq(bots.id, botId))
        .limit(1);
      if (botRows.length === 0) throw new StoreNotFoundError("Bot not found.");

      if (input.dependencySkillIds.length > 0) {
        const dependencyAssignments = await transaction
          .select({ skillId: employeeSkills.skillId, state: employeeSkills.state })
          .from(employeeSkills)
          .where(
            and(
              eq(employeeSkills.botId, botId),
              inArray(employeeSkills.skillId, input.dependencySkillIds),
            ),
          );
        if (dependencyAssignments.length !== input.dependencySkillIds.length) {
          throw new StoreValidationError(
            "Every dependency must already be assigned to this employee.",
          );
        }
        if (dependencyAssignments.some((dependency) => dependency.state !== "verified")) {
          throw new StoreValidationError(
            "Every dependency must be verified before this candidate can be added.",
          );
        }
      }

      const now = new Date();
      const insertedRows = await transaction
        .insert(skills)
        .values({
          id: randomUUID(),
          slug: input.slug,
          name: input.name,
          description: input.description,
          version: input.version,
          source: input.source,
          requiredCapabilities: input.requiredCapabilities,
          metadata: { format: "agentskills.io" },
          skillMarkdown: document?.markdown ?? null,
          contentSha256: document?.sha256 ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: [skills.slug, skills.version] })
        .returning();
      const insertedSkill = insertedRows[0];
      const [resolvedSkill] =
        insertedSkill === undefined
          ? await transaction
              .select()
              .from(skills)
              .where(and(eq(skills.slug, input.slug), eq(skills.version, input.version)))
              .limit(1)
          : [insertedSkill];
      if (resolvedSkill === undefined) {
        throw new StoreConflictError("The skill definition changed during creation.");
      }
      const skillRow: typeof skills.$inferSelect = resolvedSkill;

      if (insertedSkill !== undefined) {
        if (input.dependencySkillIds.length > 0) {
          await transaction.insert(skillDependencies).values(
            input.dependencySkillIds.map((dependencySkillId) => ({
              skillId: skillRow.id,
              dependsOnSkillId: dependencySkillId,
            })),
          );
        }
      } else {
        const dependencyRows = await transaction
          .select({ id: skillDependencies.dependsOnSkillId })
          .from(skillDependencies)
          .where(eq(skillDependencies.skillId, skillRow.id));
        const existingDependencies = dependencyRows.map((row) => row.id).sort();
        if (
          skillRow.skillMarkdown !== (document?.markdown ?? null) ||
          skillRow.name !== input.name ||
          skillRow.description !== input.description ||
          skillRow.source !== input.source ||
          !sameStringSet(
            toStringArray(skillRow.requiredCapabilities),
            input.requiredCapabilities,
          ) ||
          !sameStringSet(existingDependencies, input.dependencySkillIds)
        ) {
          throw new StoreConflictError(
            "This skill slug and version already identify a different definition.",
          );
        }
      }

      const existingAssignments = await transaction
        .select({ skillId: employeeSkills.skillId })
        .from(employeeSkills)
        .where(and(eq(employeeSkills.botId, botId), eq(employeeSkills.skillId, skillRow.id)))
        .limit(1);
      if (existingAssignments.length > 0) {
        throw new StoreConflictError("This skill is already assigned to the employee.");
      }

      const assignmentRows = await transaction
        .insert(employeeSkills)
        .values({
          botId,
          skillId: skillRow.id,
          state: "candidate",
          source: input.source,
          confidence: 0,
          evidence: input.evidence,
          acquiredAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: [employeeSkills.botId, employeeSkills.skillId] })
        .returning();
      const assignment = assignmentRows[0];
      if (assignment === undefined) {
        throw new StoreConflictError("This skill is already assigned to the employee.");
      }

      const evolutionRows = await transaction
        .insert(employeeEvolutionEvents)
        .values({
          id: randomUUID(),
          botId,
          type: "skill_discovered",
          title: "Candidate skill added",
          summary: input.reason,
          source: input.source === "imported" ? "import" : "manual",
          sourceId: skillRow.id,
          evidence: input.evidence,
          createdAt: now,
        })
        .returning();
      const evolution = evolutionRows[0];
      if (evolution === undefined) {
        throw new Error("Evolution event creation did not return a record.");
      }

      return {
        skill: toEmployeeSkill(skillRow, assignment, input.dependencySkillIds),
        evolution: toEmployeeEvolutionEvent(evolution),
      };
    });
  }

  async updateEmployeeSkillState(
    botId: string,
    skillId: string,
    input: UpdateEmployeeSkillStateInput,
  ): Promise<EmployeeSkillMutationResult> {
    return this.#db.transaction(async (transaction) => {
      const [record] = await transaction
        .select({ assignment: employeeSkills, skill: skills })
        .from(employeeSkills)
        .innerJoin(skills, eq(employeeSkills.skillId, skills.id))
        .where(and(eq(employeeSkills.botId, botId), eq(employeeSkills.skillId, skillId)))
        .limit(1);
      if (record === undefined) throw new StoreNotFoundError("Employee skill not found.");

      if (
        input.state === "verified" &&
        record.skill.contentSha256 &&
        input.reviewedContentSha256 !== record.skill.contentSha256
      )
        throw new StoreConflictError(
          "Review the complete current SKILL.md and confirm its digest before enabling model use.",
        );

      const currentState = record.assignment.state as EmployeeSkill["state"];
      if (!isEmployeeSkillTransitionAllowed(currentState, input.state)) {
        throw new StoreConflictError(
          `A ${currentState} skill cannot transition to ${input.state}.`,
        );
      }

      const dependencyRows = await transaction
        .select({ id: skillDependencies.dependsOnSkillId })
        .from(skillDependencies)
        .where(eq(skillDependencies.skillId, skillId));
      const dependencyIds = dependencyRows.map((row) => row.id).sort();
      if (input.state === "verified" && dependencyIds.length > 0) {
        const verifiedDependencies = await transaction
          .select({ skillId: employeeSkills.skillId, state: employeeSkills.state })
          .from(employeeSkills)
          .where(
            and(eq(employeeSkills.botId, botId), inArray(employeeSkills.skillId, dependencyIds)),
          );
        if (
          verifiedDependencies.length !== dependencyIds.length ||
          verifiedDependencies.some((dependency) => dependency.state !== "verified")
        ) {
          throw new StoreValidationError(
            "Every dependency must be verified before this skill can be verified.",
          );
        }
      }

      const evidence = mergeEvidenceReferences(
        toEvidenceReferences(record.assignment.evidence),
        input.evidence,
      );
      const now = new Date();
      const assignmentRows = await transaction
        .update(employeeSkills)
        .set({
          state: input.state,
          revision: sql`${employeeSkills.revision} + 1`,
          reviewedContentSha256:
            input.state === "verified" ? (record.skill.contentSha256 ?? null) : null,
          confidence: input.state === "verified" ? input.confidence : record.assignment.confidence,
          evidence,
          updatedAt: now,
        })
        .where(
          and(
            eq(employeeSkills.botId, botId),
            eq(employeeSkills.skillId, skillId),
            eq(employeeSkills.state, currentState),
          ),
        )
        .returning();
      const assignment = assignmentRows[0];
      if (assignment === undefined) {
        throw new StoreConflictError("The skill state changed while it was being reviewed.");
      }

      const eventType = `skill_${input.state}` as EmployeeEvolutionEvent["type"];
      const evolutionRows = await transaction
        .insert(employeeEvolutionEvents)
        .values({
          id: randomUUID(),
          botId,
          type: eventType,
          title: skillStateEventTitle(input.state),
          summary: input.reason,
          source: "manual",
          sourceId: skillId,
          evidence: input.evidence,
          createdAt: now,
        })
        .returning();
      const evolution = evolutionRows[0];
      if (evolution === undefined) {
        throw new Error("Evolution event creation did not return a record.");
      }

      return {
        skill: toEmployeeSkill(record.skill, assignment, dependencyIds),
        evolution: toEmployeeEvolutionEvent(evolution),
      };
    });
  }

  async createEmployeeMemory(
    botId: string,
    input: CreateEmployeeMemoryInput,
  ): Promise<EmployeeMemoryMutationResult> {
    const normalizedInput = normalizeEmployeeMemory(input);
    validateEmployeeMemoryPolicy(normalizedInput);
    return this.#db.transaction(async (transaction) => {
      const [bot] = await transaction
        .select({ id: bots.id })
        .from(bots)
        .where(eq(bots.id, botId))
        .limit(1);
      if (bot === undefined) throw new StoreNotFoundError("Bot not found.");

      const now = new Date();
      const memoryId = randomUUID();
      const [memory] = await transaction
        .insert(employeeMemories)
        .values({
          id: memoryId,
          botId,
          kind: normalizedInput.kind,
          title: normalizedInput.title,
          content: normalizedInput.content,
          sensitivity: normalizedInput.sensitivity,
          portability: normalizedInput.portability,
          provenance: { source: "owner", actor: "owner" },
          modelUseEnabled: normalizedInput.modelUseEnabled ?? false,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (memory === undefined) throw new Error("Employee memory was not created.");

      const [event] = await transaction
        .insert(employeeMemoryEvents)
        .values({
          id: randomUUID(),
          botId,
          memoryId,
          action: "created",
          revision: 1,
          changedFields: [
            "kind",
            "title",
            "content",
            "sensitivity",
            "portability",
            ...(normalizedInput.modelUseEnabled === undefined ? [] : ["modelUseEnabled"]),
          ],
          actor: "owner",
          createdAt: now,
        })
        .returning();
      if (event === undefined) throw new Error("Employee memory event was not created.");

      return { memory: toEmployeeMemory(memory), event: toEmployeeMemoryEvent(event) };
    });
  }

  async updateEmployeeMemory(
    botId: string,
    memoryId: string,
    input: UpdateEmployeeMemoryInput,
  ): Promise<EmployeeMemoryMutationResult> {
    return this.#db.transaction(async (transaction) => {
      const [current] = await transaction
        .select()
        .from(employeeMemories)
        .where(and(eq(employeeMemories.botId, botId), eq(employeeMemories.id, memoryId)))
        .limit(1);
      if (current === undefined) throw new StoreNotFoundError("Employee memory not found.");
      if (current.revision !== input.expectedRevision) {
        throw new StoreConflictError(
          "The memory changed while it was being edited. Reload and review the current value.",
        );
      }

      const next = normalizeEmployeeMemory({
        kind: input.kind ?? (current.kind as EmployeeMemory["kind"]),
        title: input.title ?? current.title,
        content: input.content ?? current.content,
        sensitivity: input.sensitivity ?? (current.sensitivity as EmployeeMemory["sensitivity"]),
        portability: input.portability ?? (current.portability as EmployeeMemory["portability"]),
        modelUseEnabled: input.modelUseEnabled ?? current.modelUseEnabled,
      });
      validateEmployeeMemoryPolicy(next);
      const changedFields = employeeMemoryChangedFields(current, next);
      if (changedFields.length === 0) {
        throw new StoreValidationError("At least one memory field must change.");
      }

      const nextRevision = current.revision + 1;
      const now = new Date();
      const [memory] = await transaction
        .update(employeeMemories)
        .set({ ...next, revision: nextRevision, updatedAt: now })
        .where(
          and(
            eq(employeeMemories.botId, botId),
            eq(employeeMemories.id, memoryId),
            eq(employeeMemories.revision, input.expectedRevision),
          ),
        )
        .returning();
      if (memory === undefined) {
        throw new StoreConflictError(
          "The memory changed while it was being edited. Reload and review the current value.",
        );
      }

      const [event] = await transaction
        .insert(employeeMemoryEvents)
        .values({
          id: randomUUID(),
          botId,
          memoryId,
          action: "updated",
          revision: nextRevision,
          changedFields,
          actor: "owner",
          createdAt: now,
        })
        .returning();
      if (event === undefined) throw new Error("Employee memory event was not created.");

      return { memory: toEmployeeMemory(memory), event: toEmployeeMemoryEvent(event) };
    });
  }

  async deleteEmployeeMemory(
    botId: string,
    memoryId: string,
    input: DeleteEmployeeMemoryInput,
  ): Promise<EmployeeMemoryDeletionResult> {
    if (input.ownerReviewed !== true) {
      throw new StoreValidationError("Memory deletion requires explicit Owner review.");
    }
    return this.#db.transaction(async (transaction) => {
      const [current] = await transaction
        .select({ revision: employeeMemories.revision })
        .from(employeeMemories)
        .where(and(eq(employeeMemories.botId, botId), eq(employeeMemories.id, memoryId)))
        .limit(1);
      if (current === undefined) throw new StoreNotFoundError("Employee memory not found.");
      if (current.revision !== input.expectedRevision) {
        throw new StoreConflictError(
          "The memory changed before deletion. Reload and review the current value.",
        );
      }

      const deleted = await transaction
        .delete(employeeMemories)
        .where(
          and(
            eq(employeeMemories.botId, botId),
            eq(employeeMemories.id, memoryId),
            eq(employeeMemories.revision, input.expectedRevision),
          ),
        )
        .returning({ id: employeeMemories.id });
      if (deleted.length === 0) {
        throw new StoreConflictError(
          "The memory changed before deletion. Reload and review the current value.",
        );
      }

      const now = new Date();
      const [event] = await transaction
        .insert(employeeMemoryEvents)
        .values({
          id: randomUUID(),
          botId,
          memoryId,
          action: "deleted",
          revision: current.revision + 1,
          changedFields: [],
          actor: "owner",
          createdAt: now,
        })
        .returning();
      if (event === undefined) throw new Error("Employee memory event was not created.");

      return { memoryId, event: toEmployeeMemoryEvent(event) };
    });
  }

  async createChannel(input: CreateChannelInput): Promise<Channel> {
    const channelId = randomUUID();
    const now = new Date();

    try {
      await this.#db.transaction(async (transaction) => {
        if (input.botIds.length > 0) {
          const existingBots = await transaction
            .select({ id: bots.id })
            .from(bots)
            .where(inArray(bots.id, input.botIds));
          if (existingBots.length !== input.botIds.length) {
            throw new StoreValidationError("One or more selected Bots no longer exist.");
          }
        }

        await transaction.insert(channels).values({
          id: channelId,
          name: input.name,
          description: input.description,
          createdAt: now,
          updatedAt: now,
        });
        if (input.botIds.length > 0) {
          await transaction.insert(channelBots).values(
            input.botIds.map((botId) => ({
              channelId,
              botId,
              joinedAt: now,
            })),
          );
        }
        await transaction.insert(runEvents).values([
          {
            id: randomUUID(),
            channelId,
            type: "CHANNEL_CREATED",
            payload: { name: input.name },
          },
          ...input.botIds.map((botId) => ({
            id: randomUUID(),
            channelId,
            botId,
            type: "BOT_JOINED_CHANNEL",
            payload: {},
          })),
        ]);
      });
    } catch (error) {
      if (error instanceof StoreValidationError) {
        throw error;
      }
      translateDatabaseError(error, `A channel named “${input.name}” already exists.`);
    }

    return {
      id: channelId,
      name: input.name,
      description: input.description,
      botIds: input.botIds,
      createdAt: now.toISOString(),
    };
  }

  async getOrCreateDirectConversation(botId: string): Promise<Channel> {
    return this.#db.transaction(async (transaction) => {
      // A database row lock serializes this singleton across processes, not just one renderer.
      const [bot] = await transaction
        .select({ id: bots.id, name: bots.name })
        .from(bots)
        .where(eq(bots.id, botId))
        .for("update")
        .limit(1);
      if (bot === undefined) throw new StoreNotFoundError("Bot not found.");
      const [existing] = await transaction
        .select()
        .from(channels)
        .where(eq(channels.directBotId, botId))
        .limit(1);
      if (existing !== undefined) {
        return {
          id: existing.id,
          name: existing.name,
          description: existing.description,
          directBotId: botId,
          botIds: [botId],
          createdAt: existing.createdAt.toISOString(),
        };
      }
      const id = randomUUID();
      const now = new Date();
      await transaction.insert(channels).values({
        id,
        name: bot.name,
        directBotId: botId,
        description: "",
        createdAt: now,
        updatedAt: now,
      });
      await transaction.insert(channelBots).values({ channelId: id, botId, joinedAt: now });
      await transaction.insert(runEvents).values([
        {
          id: randomUUID(),
          channelId: id,
          type: "CHANNEL_CREATED",
          payload: { name: bot.name, directBotId: botId },
        },
        { id: randomUUID(), channelId: id, botId, type: "BOT_JOINED_CHANNEL", payload: {} },
      ]);
      return {
        id,
        name: bot.name,
        description: "",
        directBotId: botId,
        botIds: [botId],
        createdAt: now.toISOString(),
      };
    });
  }

  async submitTask(channelId: string, input: CreateMessageInput): Promise<SubmitTaskResult> {
    // Interactive and scheduled submissions share this exact routing and audit transaction.
    return this.#db.transaction((transaction) =>
      submitTaskInTransaction(transaction, channelId, input),
    );
  }

  async assignRun(runId: string, nodeId: string): Promise<Run | undefined> {
    const now = new Date();
    return this.#db.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(runs)
        .set({ nodeId, status: "assigned", updatedAt: now })
        .where(and(eq(runs.id, runId), eq(runs.status, "queued"), isNull(runs.nodeId)))
        .returning();
      if (updated === undefined) return undefined;

      await transaction.insert(runEvents).values({
        id: randomUUID(),
        runId: updated.id,
        channelId: updated.channelId,
        botId: updated.botId,
        nodeId,
        type: "RUN_ASSIGNED",
        payload: { executionProfile: updated.executionProfile },
      });
      return toRun(updated);
    });
  }

  async startRun(runId: string, nodeId: string): Promise<Run | undefined> {
    const now = new Date();
    return this.#db.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(runs)
        .set({ status: "running", updatedAt: now })
        .where(and(eq(runs.id, runId), eq(runs.nodeId, nodeId), eq(runs.status, "assigned")))
        .returning();
      if (updated === undefined) return undefined;
      await transaction.insert(runEvents).values({
        id: randomUUID(),
        runId,
        channelId: updated.channelId,
        botId: updated.botId,
        nodeId,
        type: "RUN_STARTED",
        payload: {},
      });
      return toRun(updated);
    });
  }

  async requestApproval(
    runId: string,
    nodeId: string,
    input: RequestApprovalInput,
  ): Promise<ApprovalResolution | undefined> {
    const now = new Date();
    const expiresAt = new Date(input.expiresAt);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) {
      throw new StoreValidationError("Approval expiry must be in the future.");
    }
    const targetFingerprint = approvalTargetFingerprint(input);

    try {
      return await this.#db.transaction(async (transaction) => {
        const [updatedRun] = await transaction
          .update(runs)
          .set({ status: "waiting_approval", updatedAt: now })
          .where(and(eq(runs.id, runId), eq(runs.nodeId, nodeId), eq(runs.status, "running")))
          .returning();
        if (updatedRun === undefined) return undefined;

        const [approval] = await transaction
          .insert(approvalsTable)
          .values({
            id: input.requestId,
            runId,
            nodeId,
            action: input.action,
            target: input.target,
            summary: input.summary,
            risk: input.risk,
            targetFingerprint,
            status: "pending",
            beforeState: input.beforeState,
            expiresAt,
            createdAt: now,
          })
          .returning();
        if (approval === undefined) throw new Error("Approval was not persisted.");

        await transaction.insert(runEvents).values({
          id: randomUUID(),
          runId,
          channelId: updatedRun.channelId,
          botId: updatedRun.botId,
          nodeId,
          type: "APPROVAL_REQUESTED",
          payload: {
            approvalId: approval.id,
            action: approval.action,
            risk: approval.risk,
            targetFingerprint,
            expiresAt: expiresAt.toISOString(),
          },
        });
        return {
          approval: toApproval(approval, updatedRun.channelId, updatedRun.botId),
          run: toRun(updatedRun),
        };
      });
    } catch (error) {
      translateDatabaseError(error, "This approval request has already been recorded.");
    }
  }

  async decideApproval(
    approvalId: string,
    decision: ApprovalDecision,
    decidedBy: string,
  ): Promise<ApprovalResolution> {
    const now = new Date();
    // Conditional updates make a decision single-use even when two Owner clients race.
    return this.#db.transaction(async (transaction) => {
      const [current] = await transaction
        .select({ approval: approvalsTable, run: runs })
        .from(approvalsTable)
        .innerJoin(runs, eq(approvalsTable.runId, runs.id))
        .where(eq(approvalsTable.id, approvalId))
        .limit(1);
      if (current === undefined) throw new StoreNotFoundError("Approval not found.");
      if (current.approval.status !== "pending") {
        throw new StoreConflictError("Approval has already been resolved.");
      }
      if (current.run.status !== "waiting_approval") {
        throw new StoreConflictError("The run is no longer waiting for this approval.");
      }

      const expired = current.approval.expiresAt <= now;
      const status = expired ? "expired" : decision === "approve" ? "approved" : "rejected";
      const runStatus = status === "approved" ? "running" : "blocked";
      const [updatedApproval] = await transaction
        .update(approvalsTable)
        .set({ status, decidedBy, decidedAt: now })
        .where(and(eq(approvalsTable.id, approvalId), eq(approvalsTable.status, "pending")))
        .returning();
      if (updatedApproval === undefined) {
        throw new StoreConflictError("Approval has already been resolved.");
      }
      const [updatedRun] = await transaction
        .update(runs)
        .set({ status: runStatus, updatedAt: now })
        .where(and(eq(runs.id, current.run.id), eq(runs.status, "waiting_approval")))
        .returning();
      if (updatedRun === undefined) {
        throw new StoreConflictError("The run is no longer waiting for this approval.");
      }

      await transaction.insert(runEvents).values({
        id: randomUUID(),
        runId: updatedRun.id,
        channelId: updatedRun.channelId,
        botId: updatedRun.botId,
        nodeId: updatedApproval.nodeId,
        type:
          status === "approved"
            ? "APPROVAL_APPROVED"
            : status === "rejected"
              ? "APPROVAL_REJECTED"
              : "APPROVAL_EXPIRED",
        payload: {
          approvalId: updatedApproval.id,
          action: updatedApproval.action,
          targetFingerprint: updatedApproval.targetFingerprint,
          decidedBy,
        },
      });
      return {
        approval: toApproval(updatedApproval, updatedRun.channelId, updatedRun.botId),
        run: toRun(updatedRun),
      };
    });
  }

  async appendRunProgress(
    runId: string,
    nodeId: string,
    stage: string,
    message: string,
  ): Promise<RunProgress | undefined> {
    const now = new Date();
    return this.#db.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(runs)
        .set({ updatedAt: now })
        .where(and(eq(runs.id, runId), eq(runs.nodeId, nodeId), eq(runs.status, "running")))
        .returning({
          channelId: runs.channelId,
          botId: runs.botId,
        });
      if (updated === undefined) return undefined;
      const progress: RunProgress = {
        id: randomUUID(),
        runId,
        channelId: updated.channelId,
        nodeId,
        stage,
        message,
        createdAt: now.toISOString(),
      };
      await transaction.insert(runEvents).values({
        id: progress.id,
        runId,
        channelId: updated.channelId,
        botId: updated.botId,
        nodeId,
        type: "RUN_PROGRESS",
        payload: { stage, message },
        createdAt: now,
      });
      return progress;
    });
  }

  async completeRun(
    runId: string,
    nodeId: string,
    summary: string,
    artifacts: ArtifactRecord[],
  ): Promise<RunCompletion | undefined> {
    const now = new Date();
    // Publish only after the terminal Run, Bot reply, artifacts, and audit events commit together.
    return this.#db.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(runs)
        .set({ status: "completed", resultSummary: summary, errorMessage: null, updatedAt: now })
        .where(and(eq(runs.id, runId), eq(runs.nodeId, nodeId), eq(runs.status, "running")))
        .returning();
      if (updated === undefined) return undefined;

      const message = {
        id: randomUUID(),
        channelId: updated.channelId,
        authorType: "bot" as const,
        authorId: updated.botId,
        replyToMessageId: updated.sourceMessageId,
        runId: updated.id,
        content: summary,
        createdAt: now,
      };
      await transaction.insert(messages).values(message);

      if (artifacts.length > 0) {
        await transaction.insert(artifactsTable).values(
          artifacts.map((record) => ({
            id: record.id,
            runId: record.runId,
            name: record.name,
            mediaType: record.mediaType,
            storageKey: record.storageKey,
            sha256: record.sha256,
            metadata: record.metadata,
            createdAt: new Date(record.createdAt),
          })),
        );
      }
      await transaction.insert(runEvents).values([
        {
          id: randomUUID(),
          runId,
          channelId: updated.channelId,
          botId: updated.botId,
          nodeId,
          type: "MESSAGE_CREATED",
          payload: {
            messageId: message.id,
            authorType: message.authorType,
            replyToMessageId: message.replyToMessageId,
          },
        },
        {
          id: randomUUID(),
          runId,
          channelId: updated.channelId,
          botId: updated.botId,
          nodeId,
          type: "RUN_COMPLETED",
          payload: { summary, artifactIds: artifacts.map((artifact) => artifact.id) },
        },
      ]);
      return {
        run: toRun(updated),
        artifacts: artifacts.map(stripArtifactRecord),
        message: toMessage(message),
      };
    });
  }

  async failRun(
    runId: string,
    nodeId: string,
    error: string,
    code: RunFailureCode = "provider_execution_failed",
  ): Promise<Run | undefined> {
    const now = new Date();
    return this.#db.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(runs)
        .set({ status: "failed", errorMessage: error, updatedAt: now })
        .where(and(eq(runs.id, runId), eq(runs.nodeId, nodeId), eq(runs.status, "running")))
        .returning();
      if (updated === undefined) return undefined;
      await transaction.insert(runEvents).values({
        id: randomUUID(),
        runId,
        channelId: updated.channelId,
        botId: updated.botId,
        nodeId,
        type: "RUN_FAILED",
        payload: { code, error },
      });
      return toRun(updated);
    });
  }

  async failRunningRuns(nodeId?: string): Promise<Run[]> {
    const now = new Date();
    return this.#db.transaction(async (transaction) => {
      const condition =
        nodeId === undefined
          ? eq(runs.status, "running")
          : and(eq(runs.status, "running"), eq(runs.nodeId, nodeId));
      const updated = await transaction
        .update(runs)
        .set({
          status: "failed",
          errorMessage: "Execution was interrupted before the Server received a result.",
          updatedAt: now,
        })
        .where(condition)
        .returning();
      if (updated.length === 0) return [];
      await transaction.insert(runEvents).values(
        updated.map((run) => ({
          id: randomUUID(),
          runId: run.id,
          channelId: run.channelId,
          botId: run.botId,
          nodeId: nodeId ?? run.nodeId,
          type: "RUN_FAILED",
          payload: {
            code: "execution_interrupted",
            reason: nodeId === undefined ? "server-recovery" : "node-unavailable",
          },
        })),
      );
      return updated.map(toRun);
    });
  }

  async recordDispatchFailure(input: DispatchFailureInput): Promise<void> {
    const [run] = await this.#db.select().from(runs).where(eq(runs.id, input.runId)).limit(1);
    if (run === undefined) return;
    await this.#db.insert(runEvents).values({
      id: randomUUID(),
      runId: run.id,
      channelId: run.channelId,
      botId: run.botId,
      nodeId: run.nodeId,
      type: "DISPATCH_FAILED",
      payload: { code: input.code, phase: input.phase.slice(0, 80) },
    });
  }

  async requeueAssignedRuns(nodeId?: string): Promise<Run[]> {
    const now = new Date();
    return this.#db.transaction(async (transaction) => {
      const condition =
        nodeId === undefined
          ? eq(runs.status, "assigned")
          : and(eq(runs.status, "assigned"), eq(runs.nodeId, nodeId));
      const updated = await transaction
        .update(runs)
        .set({ nodeId: null, status: "queued", updatedAt: now })
        .where(condition)
        .returning();
      if (updated.length === 0) return [];

      await transaction.insert(runEvents).values(
        updated.map((run) => ({
          id: randomUUID(),
          runId: run.id,
          channelId: run.channelId,
          botId: run.botId,
          nodeId: nodeId ?? run.nodeId,
          type: "RUN_REQUEUED",
          payload: { reason: nodeId === undefined ? "server-recovery" : "node-unavailable" },
        })),
      );
      return updated.map(toRun);
    });
  }

  async upsertNode(node: ExecutionNode): Promise<void> {
    const connectedAt = new Date(node.connectedAt);
    const lastSeenAt = new Date(node.lastSeenAt);
    const now = new Date();
    await this.#db
      .insert(nodes)
      .values({
        id: node.id,
        name: node.name,
        platform: node.platform,
        osVersion: node.osVersion,
        architecture: node.architecture,
        deviceClass: node.deviceClass,
        isolation: node.isolation,
        trustTier: node.trustTier,
        capabilities: node.capabilities,
        capabilityManifest: node.capabilityManifest,
        maxConcurrentRuns: node.maxConcurrentRuns,
        status: "online",
        connectedAt,
        lastSeenAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: nodes.id,
        set: {
          name: node.name,
          platform: node.platform,
          osVersion: node.osVersion,
          architecture: node.architecture,
          deviceClass: node.deviceClass,
          isolation: node.isolation,
          trustTier: node.trustTier,
          capabilities: node.capabilities,
          capabilityManifest: node.capabilityManifest,
          maxConcurrentRuns: node.maxConcurrentRuns,
          status: "online",
          connectedAt,
          lastSeenAt,
          updatedAt: now,
        },
      });
  }

  async markNodeOffline(nodeId: string): Promise<void> {
    await this.#db
      .update(nodes)
      .set({ status: "offline", lastSeenAt: new Date(), updatedAt: new Date() })
      .where(eq(nodes.id, nodeId));
  }

  async joinBotToChannel(channelId: string, botId: string): Promise<Channel> {
    try {
      await this.#db.transaction(async (transaction) => {
        const [channelRows, botRows] = await Promise.all([
          transaction
            .select({ id: channels.id, directBotId: channels.directBotId })
            .from(channels)
            .where(eq(channels.id, channelId))
            .for("update"),
          transaction.select({ id: bots.id }).from(bots).where(eq(bots.id, botId)),
        ]);
        if (channelRows.length === 0) {
          throw new StoreNotFoundError("Channel not found.");
        }
        if (channelRows[0]?.directBotId !== null) {
          throw new StoreValidationError("Direct conversation membership cannot be changed.");
        }
        if (botRows.length === 0) {
          throw new StoreNotFoundError("Bot not found.");
        }

        const inserted = await transaction
          .insert(channelBots)
          .values({ channelId, botId })
          .onConflictDoNothing()
          .returning({ botId: channelBots.botId });
        if (inserted.length > 0) {
          await transaction.insert(runEvents).values({
            id: randomUUID(),
            channelId,
            botId,
            type: "BOT_JOINED_CHANNEL",
            payload: {},
          });
        }
      });
    } catch (error) {
      if (error instanceof StoreNotFoundError) {
        throw error;
      }
      throw error;
    }

    const channel = (await this.listChannels()).find((item) => item.id === channelId);
    if (channel === undefined) {
      throw new StoreNotFoundError("Channel not found.");
    }
    return channel;
  }

  async #requireChannel(channelId: string): Promise<void> {
    if (!(await this.channelExists(channelId))) {
      throw new StoreNotFoundError("Channel not found.");
    }
  }
}

function toBot(row: typeof bots.$inferSelect | typeof bots.$inferInsert): Bot {
  const configuration = asRecord(row.configuration);
  const appearance = toBotAppearance(configuration.appearance);
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    status: row.status as Bot["status"],
    computerProfile: row.computerProfile as Bot["computerProfile"],
    ...(appearance === undefined ? {} : { appearance }),
    createdAt: (row.createdAt ?? new Date()).toISOString(),
  };
}

function toBotAppearance(value: unknown): Bot["appearance"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    !["round", "square", "cat"].includes(String(candidate.head)) ||
    !["classic", "tall", "cape", "armor", "storage", "quadruped"].includes(
      String(candidate.body),
    ) ||
    !["feet", "single-wheel", "dual-wheel", "hover", "four-legs"].includes(
      String(candidate.mobility),
    ) ||
    !["none", "headphones", "backpack", "trench", "arm", "toolbox"].includes(
      String(candidate.accessory),
    ) ||
    !["green", "yellow", "red", "blue"].includes(String(candidate.accent))
  ) {
    return undefined;
  }
  return {
    head: candidate.head as NonNullable<Bot["appearance"]>["head"],
    body: candidate.body as NonNullable<Bot["appearance"]>["body"],
    mobility: candidate.mobility as NonNullable<Bot["appearance"]>["mobility"],
    accessory: candidate.accessory as NonNullable<Bot["appearance"]>["accessory"],
    accent: candidate.accent as NonNullable<Bot["appearance"]>["accent"],
  };
}

function toApproval(
  row: typeof approvalsTable.$inferSelect,
  channelId: string,
  botId: string,
): Approval {
  return {
    id: row.id,
    runId: row.runId,
    channelId,
    botId,
    nodeId: row.nodeId,
    action: row.action,
    target: row.target,
    summary: row.summary,
    risk: row.risk as Approval["risk"],
    targetFingerprint: row.targetFingerprint,
    beforeState: asRecord(row.beforeState),
    status: row.status as Approval["status"],
    expiresAt: row.expiresAt.toISOString(),
    ...(row.decidedBy === null ? {} : { decidedBy: row.decidedBy }),
    ...(row.decidedAt === null ? {} : { decidedAt: row.decidedAt.toISOString() }),
    createdAt: row.createdAt.toISOString(),
  };
}

function toRunProgress(row: typeof runEvents.$inferSelect): RunProgress[] {
  const payload = asRecord(row.payload);
  if (
    row.runId === null ||
    row.channelId === null ||
    typeof payload.stage !== "string" ||
    typeof payload.message !== "string"
  ) {
    return [];
  }
  return [
    {
      id: row.id,
      runId: row.runId,
      channelId: row.channelId,
      ...(row.nodeId === null ? {} : { nodeId: row.nodeId }),
      stage: payload.stage,
      message: payload.message,
      createdAt: row.createdAt.toISOString(),
    },
  ];
}

function toEmployeeDecisionTrace(row: typeof runEvents.$inferSelect): EmployeeDecisionTrace[] {
  return toRunProgress(row).map((progress) => ({
    ...progress,
    summary: progress.message,
  }));
}

function toEmployeeEvolutionEvent(
  row: typeof employeeEvolutionEvents.$inferSelect,
): EmployeeEvolutionEvent {
  return {
    id: row.id,
    botId: row.botId,
    type: row.type as EmployeeEvolutionEvent["type"],
    title: row.title,
    summary: row.summary,
    source: row.source as EmployeeEvolutionEvent["source"],
    ...(row.sourceId === null ? {} : { sourceId: row.sourceId }),
    evidence: toEvidenceReferences(row.evidence),
    createdAt: row.createdAt.toISOString(),
  };
}

function toEmployeeSkill(
  skill: typeof skills.$inferSelect,
  assignment: typeof employeeSkills.$inferSelect,
  dependencyIds: string[],
): EmployeeSkill {
  return {
    id: skill.id,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    source: assignment.source as EmployeeSkill["source"],
    state: assignment.state as EmployeeSkill["state"],
    confidence: assignment.confidence,
    requiredCapabilities: toStringArray(skill.requiredCapabilities),
    dependencyIds,
    evidence: toEvidenceReferences(assignment.evidence),
    ...(skill.skillMarkdown && skill.contentSha256
      ? {
          skillMarkdown: skill.skillMarkdown,
          contentSha256: skill.contentSha256,
          modelUseEnabled:
            assignment.state === "verified" &&
            assignment.reviewedContentSha256 === skill.contentSha256,
        }
      : {}),
    acquiredAt: assignment.acquiredAt.toISOString(),
    updatedAt: assignment.updatedAt.toISOString(),
  };
}

function toEmployeeMemory(row: typeof employeeMemories.$inferSelect): EmployeeMemory {
  return {
    id: row.id,
    botId: row.botId,
    kind: row.kind as EmployeeMemory["kind"],
    title: row.title,
    content: row.content,
    sensitivity: row.sensitivity as EmployeeMemory["sensitivity"],
    portability: row.portability as EmployeeMemory["portability"],
    provenance: asRecord(row.provenance),
    modelUseEnabled: row.modelUseEnabled,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toEmployeeMemoryEvent(row: typeof employeeMemoryEvents.$inferSelect): EmployeeMemoryEvent {
  return {
    id: row.id,
    botId: row.botId,
    memoryId: row.memoryId,
    action: row.action as EmployeeMemoryEvent["action"],
    revision: row.revision,
    changedFields: toStringArray(row.changedFields).filter(
      (field): field is EmployeeMemoryEvent["changedFields"][number] =>
        ["kind", "title", "content", "sensitivity", "portability", "modelUseEnabled"].includes(
          field,
        ),
    ),
    actor: "owner",
    createdAt: row.createdAt.toISOString(),
  };
}

function employeeMemoryChangedFields(
  current: typeof employeeMemories.$inferSelect,
  next: Pick<
    EmployeeMemory,
    "kind" | "title" | "content" | "sensitivity" | "portability" | "modelUseEnabled"
  >,
): EmployeeMemoryEvent["changedFields"] {
  const fields: EmployeeMemoryEvent["changedFields"] = [];
  if (current.kind !== next.kind) fields.push("kind");
  if (current.title !== next.title) fields.push("title");
  if (current.content !== next.content) fields.push("content");
  if (current.sensitivity !== next.sensitivity) fields.push("sensitivity");
  if (current.portability !== next.portability) fields.push("portability");
  if (current.modelUseEnabled !== (next.modelUseEnabled ?? false)) fields.push("modelUseEnabled");
  return fields;
}

export function validateEmployeeMemoryPolicy(
  memory: Pick<
    EmployeeMemory,
    "kind" | "title" | "content" | "sensitivity" | "portability" | "modelUseEnabled"
  >,
): void {
  if (
    memory.modelUseEnabled &&
    (memory.kind === "secret-reference" || !["public", "internal"].includes(memory.sensitivity))
  ) {
    throw new StoreValidationError(
      "Only public or internal non-secret memory can be shared with the model.",
    );
  }
  if (memory.title.length === 0 || memory.title.length > 160) {
    throw new StoreValidationError("Memory title must contain between 1 and 160 characters.");
  }
  if (memory.content.length === 0 || memory.content.length > 8000) {
    throw new StoreValidationError("Memory content must contain between 1 and 8000 characters.");
  }
  if (memory.portability === "included") {
    throw new StoreValidationError("Memory inclusion is not supported by Employee package v1.");
  }
  if (
    memory.kind === "secret-reference" &&
    (memory.sensitivity !== "restricted" || memory.portability !== "never")
  ) {
    throw new StoreValidationError(
      "Secret references must use restricted sensitivity and never be portable.",
    );
  }

  const sensitiveFindings = [
    ...scanSensitiveText(memory.title, "title", { portable: false }),
    ...scanSensitiveText(memory.content, "content", { portable: false }),
  ];
  if (sensitiveFindings.length > 0) {
    throw new StoreValidationError(
      "Memory cannot contain credential values or private keys. Store only a vault or secret reference.",
    );
  }
}

function normalizeEmployeeMemory<
  T extends Pick<
    EmployeeMemory,
    "kind" | "title" | "content" | "sensitivity" | "portability" | "modelUseEnabled"
  >,
>(memory: T): T {
  return { ...memory, title: memory.title.trim(), content: memory.content.trim() };
}

function toEvidenceReferences(value: unknown): EmployeeEvidenceReference[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    if (
      !["run", "artifact", "approval", "manual", "import"].includes(String(record.kind)) ||
      typeof record.id !== "string"
    ) {
      return [];
    }
    return [
      {
        kind: record.kind as EmployeeEvidenceReference["kind"],
        id: record.id,
        ...(typeof record.label === "string" ? { label: record.label } : {}),
      },
    ];
  });
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function sameStringSet(left: string[], right: string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

function mergeEvidenceReferences(
  current: EmployeeEvidenceReference[],
  additional: EmployeeEvidenceReference[],
): EmployeeEvidenceReference[] {
  const merged = new Map<string, EmployeeEvidenceReference>();
  for (const reference of [...current, ...additional]) {
    const key = `${reference.kind}:${reference.id}`;
    merged.delete(key);
    merged.set(key, reference);
  }
  return [...merged.values()].slice(-64);
}

function isEmployeeSkillTransitionAllowed(
  current: EmployeeSkill["state"],
  next: UpdateEmployeeSkillStateInput["state"],
): boolean {
  if (current === "revoked" || current === next) return false;
  if (current === "candidate") return true;
  if (current === "verified") return next === "suspended" || next === "revoked";
  return next === "verified" || next === "revoked";
}

function skillStateEventTitle(state: UpdateEmployeeSkillStateInput["state"]): string {
  if (state === "verified") return "Skill verified";
  if (state === "suspended") return "Skill suspended";
  return "Skill revoked";
}

function toArtifact(row: typeof artifactsTable.$inferSelect): Artifact {
  const metadata = asRecord(row.metadata);
  return {
    id: row.id,
    runId: row.runId,
    name: row.name,
    mediaType: row.mediaType,
    sha256: row.sha256,
    sizeBytes: typeof metadata.sizeBytes === "number" ? metadata.sizeBytes : 0,
    createdAt: row.createdAt.toISOString(),
  };
}

function toArtifactRecord(row: typeof artifactsTable.$inferSelect): ArtifactRecord {
  return { ...toArtifact(row), storageKey: row.storageKey, metadata: asRecord(row.metadata) };
}

function stripArtifactRecord({
  storageKey: _storageKey,
  metadata: _metadata,
  ...artifact
}: ArtifactRecord): Artifact {
  return artifact;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function approvalTargetFingerprint(input: RequestApprovalInput): string {
  return createHash("sha256")
    .update(input.action)
    .update("\0")
    .update(input.target)
    .update("\0")
    .update(JSON.stringify(input.beforeState))
    .digest("hex");
}

function employeeImportRequestFingerprint(
  input: ActivateEmployeeImportCommand,
  employeeName: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        packageId: input.document.payload.packageId,
        packageDigest: input.packageDigest,
        employeeName,
        signatureStatus: input.signature.status,
        publisherKeyId:
          input.signature.status === "dsse" ? input.signature.trustedPublisherKeyId : null,
      }),
    )
    .digest("hex");
}

function toEmployeeImportReceipt(
  row: typeof employeeImportReceipts.$inferSelect,
): EmployeeImportReceipt {
  return {
    id: row.id,
    packageId: row.packageId,
    packageDigest: row.packageDigest,
    employeeId: row.employeeId,
    signatureStatus: row.signatureStatus as EmployeeImportReceipt["signatureStatus"],
    ...(row.publisherKeyId === null ? {} : { publisherKeyId: row.publisherKeyId }),
    reviewedBy: "owner",
    reviewedAt: row.reviewedAt.toISOString(),
    importedSkillCount: row.importedSkillCount,
    createdAt: row.createdAt.toISOString(),
  };
}

function translateDatabaseError(error: unknown, conflictMessage: string): never {
  if (hasDatabaseCode(error, "23505")) {
    throw new StoreConflictError(conflictMessage);
  }
  throw error;
}

function hasDatabaseCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  if ("code" in error && error.code === code) {
    return true;
  }
  return "cause" in error && hasDatabaseCode(error.cause, code);
}
