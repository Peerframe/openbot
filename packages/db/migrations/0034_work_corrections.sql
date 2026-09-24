-- Opt-in Owner corrections are control facts, never tool grants or evidence of application.
ALTER TABLE work_runs ADD COLUMN corrections_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE work_corrections (
  id text PRIMARY KEY,
  task_id text NOT NULL,
  run_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 8),
  request_key text NOT NULL CHECK (octet_length(request_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  requested_by text NOT NULL CHECK (requested_by = 'owner'),
  instruction text NOT NULL CHECK (octet_length(instruction) BETWEEN 1 AND 4096),
  generation bigint NOT NULL CHECK (generation > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (task_id,run_id) REFERENCES work_runs(task_id,id),
  UNIQUE (run_id,sequence),
  UNIQUE (task_id,request_key),
  UNIQUE (task_id,id)
);
--> statement-breakpoint
CREATE TABLE work_correction_contexts (
  id text PRIMARY KEY,
  task_id text NOT NULL,
  run_id text NOT NULL,
  checkpoint_key text NOT NULL CHECK (octet_length(checkpoint_key) BETWEEN 1 AND 128),
  generation bigint NOT NULL CHECK (generation > 0),
  -- JSON escaping can expand an allowed one-byte control character to six bytes.
  -- 256 KiB includes eight 4-KiB instructions, IDs, keys and PostgreSQL JSON spacing.
  corrections jsonb NOT NULL CHECK (jsonb_typeof(corrections) = 'array'
    AND jsonb_array_length(corrections) <= 8 AND octet_length(corrections::text) <= 262144),
  content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (task_id,run_id) REFERENCES work_runs(task_id,id),
  UNIQUE (run_id,checkpoint_key),
  UNIQUE (task_id,run_id,id)
);
--> statement-breakpoint
ALTER TABLE work_actions ADD COLUMN correction_context_id text;
--> statement-breakpoint
ALTER TABLE work_actions ADD CONSTRAINT work_actions_correction_context_fk
  FOREIGN KEY (task_id,run_id,correction_context_id) REFERENCES work_correction_contexts(task_id,run_id,id);
--> statement-breakpoint
ALTER TABLE work_actions ADD COLUMN superseded_by text;
--> statement-breakpoint
ALTER TABLE work_actions ADD CONSTRAINT work_actions_superseded_by_fk
  FOREIGN KEY (task_id,superseded_by) REFERENCES work_corrections(task_id,id);
--> statement-breakpoint
ALTER TABLE work_actions DROP CONSTRAINT work_actions_status_check;
--> statement-breakpoint
ALTER TABLE work_actions ADD CONSTRAINT work_actions_status_check
  CHECK (status IN ('proposed','admitted','unknown','applied','not_applied','superseded'));
--> statement-breakpoint
ALTER TABLE work_actions ADD CONSTRAINT work_actions_superseded_check
  CHECK ((status = 'superseded' AND superseded_by IS NOT NULL AND decision <> 'denied'
          AND actual_tokens IS NULL AND evidence IS NULL)
         OR (status <> 'superseded' AND superseded_by IS NULL));
