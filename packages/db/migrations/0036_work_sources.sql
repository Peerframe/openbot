-- Only new candidate admissions get a mapping. Historical Runs retain their original meaning.
CREATE TABLE work_sources (
  task_id text PRIMARY KEY REFERENCES work_tasks(id),
  legacy_run_id text NOT NULL UNIQUE REFERENCES runs(id),
  channel_id text NOT NULL REFERENCES channels(id),
  source_message_id text NOT NULL REFERENCES messages(id)
);
--> statement-breakpoint
CREATE INDEX work_sources_channel_idx ON work_sources(channel_id);
--> statement-breakpoint
-- Preserve the existing 8,000/4,000 UTF-16 character channel inputs, including Chinese text.
-- Public Work input limits remain unchanged; only the trusted source adapter uses these caps.
ALTER TABLE work_tasks DROP CONSTRAINT work_tasks_objective_check;
--> statement-breakpoint
ALTER TABLE work_tasks ADD CONSTRAINT work_tasks_objective_check
  CHECK (octet_length(objective) BETWEEN 1 AND 32768);
--> statement-breakpoint
ALTER TABLE work_corrections DROP CONSTRAINT work_corrections_instruction_check;
--> statement-breakpoint
ALTER TABLE work_corrections ADD CONSTRAINT work_corrections_instruction_check
  CHECK (octet_length(instruction) BETWEEN 1 AND 16384);
--> statement-breakpoint
ALTER TABLE work_correction_contexts DROP CONSTRAINT work_correction_contexts_corrections_check;
--> statement-breakpoint
ALTER TABLE work_correction_contexts ADD CONSTRAINT work_correction_contexts_corrections_check
  CHECK (jsonb_typeof(corrections) = 'array' AND jsonb_array_length(corrections) <= 8
    AND octet_length(corrections::text) <= 1048576);
--> statement-breakpoint
-- A read projection, never a second lifecycle writer or a dispatch queue.
CREATE VIEW runs_work_projection AS
SELECT r.id,r.parent_run_id,r.root_run_id,r.delegated_by_bot_id,r.channel_id,r.bot_id,
  r.source_message_id,r.node_id,r.execution_profile,r.instruction,r.title,
  CASE WHEN t.id IS NULL THEN r.status
       WHEN t.status IN ('completed','cancelled','failed') THEN t.status
       WHEN t.cancel_requested OR NOT t.authority_active OR EXISTS (
         SELECT 1 FROM work_actions a WHERE a.task_id=t.id AND a.status='unknown') THEN 'blocked'
       WHEN EXISTS (SELECT 1 FROM work_actions a WHERE a.task_id=t.id AND a.status='proposed'
         AND a.decision='pending') THEN 'waiting_approval'
       WHEN t.status='queued' THEN 'queued' ELSE 'running' END AS status,
  CASE WHEN t.id IS NULL THEN r.result_summary ELSE t.result_summary END AS result_summary,
  CASE WHEN t.id IS NULL THEN r.error_message WHEN t.status='failed' THEN 'Task execution failed.' END AS error_message,
  CASE WHEN t.id IS NULL THEN r.error_code WHEN t.status='failed' THEN 'task_failed' END AS error_code,
  r.model_usage,r.model_selection,r.created_at,
  CASE WHEN t.id IS NULL THEN r.updated_at ELSE coalesce(e.created_at,t.created_at) END AS updated_at,
  t.id AS work_task_id
FROM runs r LEFT JOIN work_sources s ON s.legacy_run_id=r.id
LEFT JOIN work_tasks t ON t.id=s.task_id
LEFT JOIN LATERAL (SELECT created_at FROM work_events WHERE task_id=t.id ORDER BY revision DESC LIMIT 1) e ON true;
