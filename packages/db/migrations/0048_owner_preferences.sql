CREATE TABLE owner_preferences (
  owner_id text PRIMARY KEY CHECK (owner_id = 'owner'),
  timezone text NOT NULL DEFAULT 'UTC' CHECK (length(timezone) BETWEEN 1 AND 64 AND timezone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+.-]+)*$'),
  default_model jsonb,
  revision integer NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 2147483647),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT owner_preferences_model_valid CHECK (
    default_model IS NULL OR CASE WHEN jsonb_typeof(default_model) = 'object' THEN
      default_model ?& ARRAY['connectionId','modelId'] AND default_model - 'connectionId' - 'modelId' = '{}'::jsonb
      AND jsonb_typeof(default_model->'connectionId') = 'string'
      AND (default_model->>'connectionId') ~ '^[A-Za-z0-9_-]{1,64}$'
      AND jsonb_typeof(default_model->'modelId') = 'string'
      AND length(default_model->>'modelId') BETWEEN 1 AND 256
      AND (default_model->>'modelId') ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$'
    ELSE false END
  )
);
--> statement-breakpoint
INSERT INTO owner_preferences(owner_id) VALUES ('owner');
