-- Additive candidate for the canonical migration lineage. Do not replace historical 0017/0018.
-- Root owns the final migration number/journal and any feature-lineage bridge.
CREATE TABLE model_connections (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  preset_id text NOT NULL CHECK (length(preset_id) BETWEEN 1 AND 80),
  base_url text NOT NULL CHECK (length(base_url) BETWEEN 1 AND 2048),
  protocol text NOT NULL CHECK (protocol IN ('openai-chat','anthropic-messages')),
  encrypted_api_key text NOT NULL CHECK (length(encrypted_api_key) BETWEEN 1 AND 5600),
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE runs DROP CONSTRAINT runs_execution_profile_valid;
ALTER TABLE runs ADD CONSTRAINT runs_execution_profile_valid
  CHECK (execution_profile IN ('none','model','docker-linux','macos-cua','lume-vm','coder'));
ALTER TABLE runs ADD COLUMN model_selection jsonb;
ALTER TABLE runs ADD CONSTRAINT runs_model_selection_valid CHECK (
  model_selection IS NULL OR COALESCE((
    execution_profile = 'model' AND jsonb_typeof(model_selection) = 'object'
    AND model_selection ?& ARRAY['connectionId','modelId']
    AND model_selection - 'connectionId' - 'modelId' = '{}'::jsonb
    AND jsonb_typeof(model_selection->'connectionId') = 'string'
    AND jsonb_typeof(model_selection->'modelId') = 'string'
    AND length(model_selection->>'connectionId') BETWEEN 1 AND 128
    AND length(model_selection->>'modelId') BETWEEN 1 AND 256
  ),false)
);
CREATE INDEX runs_model_queue_idx ON runs(created_at,id)
  WHERE status = 'queued' AND node_id IS NULL AND execution_profile = 'model';
