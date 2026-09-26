CREATE TABLE model_connections (
  id text PRIMARY KEY,
  name text NOT NULL,
  preset_id text NOT NULL,
  base_url text NOT NULL,
  protocol text NOT NULL,
  encrypted_api_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT model_connections_name_valid CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT model_connections_preset_valid CHECK (length(preset_id) BETWEEN 1 AND 80),
  CONSTRAINT model_connections_url_valid CHECK (length(base_url) BETWEEN 1 AND 2048),
  CONSTRAINT model_connections_protocol_valid CHECK (protocol IN ('openai-chat', 'anthropic-messages')),
  CONSTRAINT model_connections_key_valid CHECK (length(encrypted_api_key) BETWEEN 1 AND 5600),
  CONSTRAINT model_connections_revision_valid CHECK (revision >= 1)
);
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN model_selection jsonb;
--> statement-breakpoint
ALTER TABLE runs ADD CONSTRAINT runs_model_selection_valid CHECK (
  model_selection IS NULL OR coalesce((
    execution_profile = 'model'
    AND jsonb_typeof(model_selection) = 'object'
    AND model_selection - ARRAY['connectionId', 'modelId']::text[] = '{}'::jsonb
    AND jsonb_typeof(model_selection->'connectionId') = 'string'
    AND jsonb_typeof(model_selection->'modelId') = 'string'
    AND length(model_selection->>'connectionId') BETWEEN 1 AND 128
    AND length(model_selection->>'modelId') BETWEEN 1 AND 256
  ), false)
);
