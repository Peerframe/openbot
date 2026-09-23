ALTER TABLE work_runs ADD COLUMN execution_epoch bigint NOT NULL DEFAULT 0 CHECK (execution_epoch BETWEEN 0 AND 10000);
--> statement-breakpoint
CREATE TABLE work_claims (
  run_id text NOT NULL REFERENCES work_runs(id),
  claim_id text NOT NULL CHECK (octet_length(claim_id) BETWEEN 1 AND 128),
  epoch bigint NOT NULL CHECK (epoch > 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (run_id,claim_id),
  UNIQUE (run_id,epoch)
);
--> statement-breakpoint
ALTER TABLE work_tasks ADD COLUMN result_summary text;
--> statement-breakpoint
ALTER TABLE work_tasks ADD COLUMN completion_digest text CHECK (completion_digest ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE work_tasks ADD COLUMN completed_at timestamptz;
--> statement-breakpoint
CREATE TABLE work_artifacts (
  id text PRIMARY KEY,
  task_id text NOT NULL,
  run_id text NOT NULL,
  artifact_key text NOT NULL,
  name text NOT NULL,
  media_type text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 8388608),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (task_id,run_id) REFERENCES work_runs(task_id,id),
  UNIQUE (run_id,artifact_key)
);
--> statement-breakpoint
CREATE INDEX work_artifacts_task_idx ON work_artifacts(task_id,id);
--> statement-breakpoint
CREATE INDEX work_actions_task_idx ON work_actions(task_id,created_at,id);
