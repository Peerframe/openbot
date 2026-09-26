ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS source_message_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'runs_source_message_fk'
      AND conrelid = 'runs'::regclass
  ) THEN
    ALTER TABLE runs
      ADD CONSTRAINT runs_source_message_fk
      FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'runs_title_not_blank'
      AND conrelid = 'runs'::regclass
  ) THEN
    ALTER TABLE runs
      ADD CONSTRAINT runs_title_not_blank CHECK (length(btrim(title)) > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'runs_status_valid'
      AND conrelid = 'runs'::regclass
  ) THEN
    ALTER TABLE runs
      ADD CONSTRAINT runs_status_valid
      CHECK (status IN ('queued', 'running', 'waiting_approval', 'blocked', 'completed', 'failed', 'cancelled'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS runs_source_message_idx
  ON runs (source_message_id)
  WHERE source_message_id IS NOT NULL;
