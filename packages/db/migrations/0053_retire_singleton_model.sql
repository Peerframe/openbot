-- Retain legacy files/keys; application startup copies a legacy configuration once.
ALTER TABLE owner_preferences ADD COLUMN transcription_connection_id text;
--> statement-breakpoint
ALTER TABLE owner_preferences ADD CONSTRAINT owner_preferences_transcription_valid CHECK (
  transcription_connection_id IS NULL OR transcription_connection_id ~ '^[A-Za-z0-9_-]{1,64}$'
);
--> statement-breakpoint
-- No foreign key: deleting a migrated connection must not erase its import receipt.
CREATE TABLE legacy_model_imports (
  source_id text PRIMARY KEY CHECK (source_id ~ '^[a-f0-9]{64}$'),
  legacy_revision text NOT NULL,
  connection_id text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
-- Existing digests/rows are unchanged; new native snapshots may bind C7 for a none profile.
ALTER TABLE work_task_profiles DROP CONSTRAINT work_task_profiles_check;
--> statement-breakpoint
ALTER TABLE work_task_profiles ADD CONSTRAINT work_task_profiles_check CHECK (
  (execution_profile='none' AND model_selection IS NULL) OR
  (execution_profile IN ('none','model') AND model_selection IS NOT NULL AND COALESCE((
    jsonb_typeof(model_selection)='object'
    AND model_selection ?& ARRAY['connectionId','modelId']
    AND model_selection - 'connectionId' - 'modelId'='{}'::jsonb
    AND jsonb_typeof(model_selection->'connectionId')='string'
    AND jsonb_typeof(model_selection->'modelId')='string'
    AND model_selection->>'connectionId' ~ '^[A-Za-z0-9_-]{1,64}$'
    AND length(model_selection->>'modelId') BETWEEN 1 AND 256
    AND model_selection->>'modelId' ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$'
  ),false))
);
--> statement-breakpoint
ALTER TABLE runs DROP CONSTRAINT runs_model_selection_valid;
--> statement-breakpoint
ALTER TABLE runs ADD CONSTRAINT runs_model_selection_valid CHECK (
  model_selection IS NULL OR COALESCE((
    execution_profile IN ('none','model') AND jsonb_typeof(model_selection)='object'
    AND model_selection ?& ARRAY['connectionId','modelId']
    AND model_selection - 'connectionId' - 'modelId'='{}'::jsonb
    AND jsonb_typeof(model_selection->'connectionId')='string'
    AND jsonb_typeof(model_selection->'modelId')='string'
    AND length(model_selection->>'connectionId') BETWEEN 1 AND 128
    AND length(model_selection->>'modelId') BETWEEN 1 AND 256
  ),false)
);
