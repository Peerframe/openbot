import { randomUUID } from "node:crypto";
import type { OwnerFiles, FileSession } from "./owner-files.js";
import {
  automationReferences,
  automationProjection,
  automationSelection,
} from "./product-automations.js";
import { WriteFailure } from "./primary-bot-write.js";
import { submitChannelWork } from "./work-channel.js";
import type { WorkTransactions } from "./work-handoff.js";
import { workAttachmentIds } from "./work-source.js";
/** Port of the existing schedule admission pass: SQL occurrence claims only, never execution or backlog replay. */
export async function submitDueWork(
  transactions: WorkTransactions,
  files: OwnerFiles | undefined,
  tokenLimit: number,
  signal: AbortSignal,
) {
  const run = (session?: FileSession) =>
    transactions.run(async (db) => {
      const due = await db.unsafe(
        `SELECT ${automationSelection} FROM automations WHERE enabled=true AND next_run_at<=date_trunc('milliseconds',now()) ORDER BY next_run_at,id LIMIT 10 FOR UPDATE SKIP LOCKED`,
      );
      for (const row of due) {
        const prior = automationProjection(row);
        let outcome = "submitted",
          runId: string | null = null;
        const [previous] = row.last_run_id
          ? await db`SELECT status FROM runs_work_projection WHERE id=${row.last_run_id}`
          : [];
        try {
          if (session) automationReferences(session, row.channel_id, row.prompt);
          else if (workAttachmentIds(row.prompt).length) outcome = "attachment_unavailable";
        } catch {
          outcome = "attachment_unavailable";
        }
        if (outcome === "submitted") {
          if (
            previous &&
            ["queued", "assigned", "running", "waiting_approval", "blocked"].includes(
              previous.status,
            )
          )
            outcome = "skipped_active";
          else {
            try {
              const submitted = await db.savepoint((tx) =>
                submitChannelWork(
                  tx,
                  session,
                  row.channel_id,
                  { content: row.prompt, botId: row.bot_id },
                  tokenLimit,
                  row.id,
                ),
              );
              runId = submitted.run!.id;
            } catch (error) {
              if (error instanceof WriteFailure && (error.status === 404 || error.status === 422))
                outcome = "target_unavailable";
              else throw error;
            }
          }
        }
        const [next] =
          await db`UPDATE automations SET next_run_at=next_run_at+(floor(extract(epoch FROM (date_trunc('milliseconds',now())-next_run_at))/(interval_minutes*60))+1)*interval_minutes*interval '1 minute',
        last_run_at=date_trunc('milliseconds',now()),last_run_id=coalesce(${runId},last_run_id),last_outcome=${outcome},enabled=${!["target_unavailable", "attachment_unavailable"].includes(outcome)},updated_at=date_trunc('milliseconds',now()) WHERE id=${row.id} RETURNING next_run_at`;
        await db`INSERT INTO run_events(id,channel_id,bot_id,run_id,type,payload) VALUES(${randomUUID()},${row.channel_id},${row.bot_id},${runId},'AUTOMATION_OCCURRENCE',
        ${db.json({ automationId: row.id, scheduledFor: prior.nextRunAt, outcome, nextRunAt: next!.next_run_at.toISOString(), actor: "schedule" })})`;
      }
      return due.length;
    });
  return files ? files.withLock(run, signal) : run();
}
