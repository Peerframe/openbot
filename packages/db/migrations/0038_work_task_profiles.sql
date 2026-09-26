-- Explicit product-native admissions only. Historical Tasks are never backfilled.
-- Application writers only INSERT; the digest binds immutable non-secret provenance.
CREATE TABLE work_task_profiles (
  task_id text PRIMARY KEY REFERENCES work_tasks(id),
  bot_id text NOT NULL REFERENCES bots(id),
  execution_profile text NOT NULL CHECK (execution_profile IN ('none','model')),
  model_selection jsonb,
  profile_digest text NOT NULL CHECK (profile_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((execution_profile='none' AND model_selection IS NULL) OR
    (execution_profile='model' AND model_selection IS NOT NULL AND COALESCE((
      jsonb_typeof(model_selection)='object'
      AND model_selection ?& ARRAY['connectionId','modelId']
      AND model_selection - 'connectionId' - 'modelId'='{}'::jsonb
      AND jsonb_typeof(model_selection->'connectionId')='string'
      AND jsonb_typeof(model_selection->'modelId')='string'
      AND length(model_selection->>'connectionId') BETWEEN 1 AND 64
      AND model_selection->>'connectionId' ~ '^[A-Za-z0-9_-]+$'
      AND length(model_selection->>'modelId') BETWEEN 1 AND 256
      AND model_selection->>'modelId' ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$'
    ),false)))
);
