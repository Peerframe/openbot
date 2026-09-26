ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS execution_profile text NOT NULL DEFAULT 'none';

ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS max_concurrent_runs integer NOT NULL DEFAULT 1;

UPDATE runs
SET execution_profile = bots.computer_profile
FROM bots
WHERE runs.bot_id = bots.id
  AND runs.execution_profile = 'none';

ALTER TABLE runs
  DROP CONSTRAINT IF EXISTS runs_status_valid;

ALTER TABLE runs
  ADD CONSTRAINT runs_status_valid
  CHECK (status IN ('queued', 'assigned', 'running', 'waiting_approval', 'blocked', 'completed', 'failed', 'cancelled'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'runs_execution_profile_valid'
      AND conrelid = 'runs'::regclass
  ) THEN
    ALTER TABLE runs
      ADD CONSTRAINT runs_execution_profile_valid
      CHECK (execution_profile IN ('none', 'docker-linux', 'macos-cua', 'lume-vm', 'coder'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'nodes_max_concurrent_runs_valid'
      AND conrelid = 'nodes'::regclass
  ) THEN
    ALTER TABLE nodes
      ADD CONSTRAINT nodes_max_concurrent_runs_valid
      CHECK (max_concurrent_runs BETWEEN 1 AND 16);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS runs_dispatch_queue_idx
  ON runs (created_at, id)
  WHERE status = 'queued'
    AND node_id IS NULL
    AND execution_profile <> 'none';
