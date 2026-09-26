ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS instruction text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS result_summary text,
  ADD COLUMN IF NOT EXISTS error_message text;

UPDATE runs
SET instruction = COALESCE(messages.content, runs.title)
FROM messages
WHERE runs.source_message_id = messages.id
  AND length(btrim(runs.instruction)) = 0;

UPDATE runs
SET instruction = title
WHERE length(btrim(instruction)) = 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'runs_instruction_not_blank'
      AND conrelid = 'runs'::regclass
  ) THEN
    ALTER TABLE runs
      ADD CONSTRAINT runs_instruction_not_blank
      CHECK (length(btrim(instruction)) > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'artifacts_name_not_blank'
      AND conrelid = 'artifacts'::regclass
  ) THEN
    ALTER TABLE artifacts
      ADD CONSTRAINT artifacts_name_not_blank
      CHECK (length(btrim(name)) > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'artifacts_sha256_valid'
      AND conrelid = 'artifacts'::regclass
  ) THEN
    ALTER TABLE artifacts
      ADD CONSTRAINT artifacts_sha256_valid
      CHECK (length(sha256) = 64);
  END IF;
END $$;

ALTER TABLE runs
  ALTER COLUMN instruction DROP DEFAULT;

CREATE UNIQUE INDEX IF NOT EXISTS artifacts_storage_key_idx
  ON artifacts (storage_key);
