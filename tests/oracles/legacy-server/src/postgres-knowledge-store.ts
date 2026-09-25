import { randomUUID } from "node:crypto";
import {
  bots,
  employeeMemories,
  employeeMemoryEvents,
  knowledgeProposals,
  runEvents,
  runs,
} from "@openbot/db";
import type { KnowledgeProposal, ReviewKnowledgeProposalInput } from "@openbot/domain";
import { and, asc, eq } from "drizzle-orm";
import { reviewKnowledgeProposalSchema, validateKnowledgeProposal } from "./agent-knowledge.js";
import { StoreConflictError, StoreNotFoundError } from "./control-plane-store.js";

type Database = ReturnType<typeof import("@openbot/db")["createDatabase"]>["db"];

/** Owner-only review adapter. Native tools never receive this object or its review method. */
export class PostgresKnowledgeStore {
  constructor(readonly db: Database) {}

  async list(botId: string): Promise<KnowledgeProposal[]> {
    const [bot] = await this.db.select({ id: bots.id }).from(bots).where(eq(bots.id, botId));
    if (!bot) throw new StoreNotFoundError("Bot not found.");
    const rows = await this.db
      .select()
      .from(knowledgeProposals)
      .where(and(eq(knowledgeProposals.botId, botId), eq(knowledgeProposals.status, "pending")))
      .orderBy(asc(knowledgeProposals.createdAt), asc(knowledgeProposals.id))
      .limit(50);
    return rows.map((row) => ({
      ...validateKnowledgeProposal({ kind: row.kind, title: row.title, content: row.content }),
      id: row.id,
      botId: row.botId,
      sourceRunId: row.sourceRunId,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async review(botId: string, proposalId: string, input: ReviewKnowledgeProposalInput) {
    const review = reviewKnowledgeProposalSchema.parse(input);
    return this.db.transaction(async (tx) => {
      const [proposal] = await tx
        .select()
        .from(knowledgeProposals)
        .where(and(eq(knowledgeProposals.botId, botId), eq(knowledgeProposals.id, proposalId)))
        .for("update");
      if (!proposal) throw new StoreNotFoundError("Knowledge proposal not found.");
      if (proposal.status !== "pending")
        throw new StoreConflictError("This proposal has already been reviewed.");
      const [source] = await tx
        .select({ channelId: runs.channelId })
        .from(runs)
        .where(and(eq(runs.id, proposal.sourceRunId), eq(runs.botId, botId)));
      if (!source) throw new StoreNotFoundError("Source task not found.");
      const now = new Date();
      let memoryId: string | null = null;
      if (review.decision === "accept") {
        const draft = validateKnowledgeProposal({
          kind: proposal.kind,
          title: review.title,
          content: review.content,
        });
        memoryId = randomUUID();
        await tx
          .insert(employeeMemories)
          .values({
            id: memoryId,
            botId,
            ...draft,
            sensitivity: "internal",
            portability: "never",
            modelUseEnabled: review.modelUseEnabled,
            provenance: {
              source: "reviewed-agent-proposal",
              actor: "owner",
              proposalId,
              sourceRunId: proposal.sourceRunId,
            },
            revision: 1,
            createdAt: now,
            updatedAt: now,
          });
        await tx
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
              "modelUseEnabled",
            ],
            actor: "owner",
            createdAt: now,
          });
      }
      // Keep only content-free decision metadata after review. The accepted Owner memory owns text.
      await tx
        .update(knowledgeProposals)
        .set({
          status: review.decision === "accept" ? "accepted" : "rejected",
          title: "",
          content: "",
          memoryId,
          reviewedAt: now,
        })
        .where(eq(knowledgeProposals.id, proposalId));
      await tx
        .insert(runEvents)
        .values({
          id: randomUUID(),
          runId: proposal.sourceRunId,
          botId,
          channelId: source.channelId,
          type: "KNOWLEDGE_PROPOSAL_REVIEWED",
          payload: { actor: "owner", proposalId, decision: review.decision, memoryId },
        });
      return { proposalId, decision: review.decision, memoryId };
    });
  }
}
