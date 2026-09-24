ALTER TABLE runs DROP CONSTRAINT runs_execution_profile_valid;
--> statement-breakpoint
ALTER TABLE runs ADD CONSTRAINT runs_execution_profile_valid
  CHECK (execution_profile IN ('none', 'model', 'docker-linux', 'macos-cua', 'lume-vm', 'coder'));
--> statement-breakpoint
CREATE INDEX runs_model_queue_idx ON runs (created_at, id)
  WHERE status = 'queued' AND node_id IS NULL AND execution_profile = 'model';
