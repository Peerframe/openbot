import type { KnowledgeProposalDraft } from "@openbot/domain";
import { z } from "zod";
import { StoreValidationError } from "./control-plane-store.js";
import { scanSensitiveText } from "./sensitive-content.js";

const title = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine((value) => !value.includes("\0"));
const content = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((value) => !value.includes("\0") && Buffer.byteLength(value) <= 8000);
export const knowledgeProposalSchema = z
  .object({
    kind: z.enum(["semantic", "episodic", "procedural"]),
    title,
    content,
  })
  .strict();
export const reviewKnowledgeProposalSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("reject"), ownerReviewed: z.literal(true) }).strict(),
  z
    .object({
      decision: z.literal("accept"),
      ownerReviewed: z.literal(true),
      title,
      content,
      modelUseEnabled: z.boolean(),
    })
    .strict(),
]);

export function validateKnowledgeProposal(input: unknown): KnowledgeProposalDraft {
  const result = knowledgeProposalSchema.safeParse(input);
  if (!result.success) throw new StoreValidationError("Invalid knowledge proposal.");
  for (const field of ["title", "content"] as const) {
    if (scanSensitiveText(result.data[field], field, { portable: false }).length)
      throw new StoreValidationError(
        "Knowledge proposals cannot contain credential values or private keys.",
      );
  }
  return result.data;
}

export interface KnowledgeReference {
  id: string;
  revision: number;
}
export interface AgentKnowledge {
  memories: Array<
    KnowledgeReference & {
      title: string;
      content: string;
      kind: string;
      truncated: boolean;
      sourceRunId?: string | undefined;
    }
  >;
  truncated: boolean;
}

/** Truncate by complete code points; report the loss instead of silently changing evidence. */
export function boundedKnowledgeText(value: string, maximumBytes: number): string {
  let size = 0;
  let result = "";
  for (const character of value) {
    size += Buffer.byteLength(character);
    if (size > maximumBytes) break;
    result += character;
  }
  return result;
}
