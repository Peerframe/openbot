import { StoreValidationError } from "./control-plane-store.js";
import type { CreateMessageInput, Bot } from "@openbot/domain";

export type ChannelBotCandidate = Pick<Bot, "id" | "name" | "role">;

export function selectChannelAssignee<Candidate extends ChannelBotCandidate>(
  candidates: Candidate[],
  requestedBotId?: string,
): Candidate | undefined {
  if (requestedBotId !== undefined) {
    return candidates.find((candidate) => candidate.id === requestedBotId);
  }
  return candidates.find(isChief) ?? candidates[0];
}

function isChief(candidate: ChannelBotCandidate): boolean {
  const identity = `${candidate.name} ${candidate.role}`.toLocaleLowerCase();
  return ["chief", "总管", "协调", "调度"].some((marker) => identity.includes(marker));
}

/** Validate the complete recipient set before any message or Run is persisted. */
export function selectChannelAssignees<Candidate extends ChannelBotCandidate>(
  candidates: Candidate[],
  input: Pick<CreateMessageInput, "botId" | "botIds">,
  directBotId?: string,
): Candidate[] {
  if (input.botId !== undefined && input.botIds !== undefined)
    throw new StoreValidationError("Choose botId or botIds, not both.");
  const requested = input.botIds ?? (input.botId === undefined ? undefined : [input.botId]);
  if (
    requested &&
    (requested.length < 1 || requested.length > 6 || new Set(requested).size !== requested.length)
  )
    throw new StoreValidationError("Choose one to six unique Bot recipients.");
  if (directBotId !== undefined && requested?.some((id) => id !== directBotId))
    throw new StoreValidationError("A direct conversation can only address its Bot.");
  const ids = requested ?? (directBotId === undefined ? undefined : [directBotId]);
  const selected = ids
    ? ids.map((id) => selectChannelAssignee(candidates, id))
    : [selectChannelAssignee(candidates)];
  if (selected.some((bot) => bot === undefined))
    throw new StoreValidationError(
      ids === undefined
        ? "Add a Bot to this channel before assigning a task."
        : "The selected Bot is not a member of this channel.",
    );
  return selected as Candidate[];
}
