// Merges a streamed reply draft into the channel's live drafts, keeping only the newest sequence
// for a running model-only task of this channel.
import type { Run, RunOutput } from "@openbot/domain";
import { isRunOutputProjection } from "./api";

/** Drafts are transient projections, never persisted messages or routing authority. */
export function mergeRunOutput(
  current: ReadonlyMap<string, RunOutput>,
  output: unknown,
  channelId: string,
  runs: Run[],
): Map<string, RunOutput> | ReadonlyMap<string, RunOutput> {
  if (!isRunOutputProjection(output, channelId)) return current;
  const run = runs.find((item) => item.id === output.runId);
  if (
    !run ||
    run.channelId !== channelId ||
    run.botId !== output.botId ||
    !["queued", "running"].includes(run.status) ||
    run.executionProfile !== "none"
  )
    return current;
  if ((current.get(run.id)?.sequence ?? -1) >= output.sequence) return current;
  const next = new Map(current);
  next.set(run.id, output);
  return next;
}
