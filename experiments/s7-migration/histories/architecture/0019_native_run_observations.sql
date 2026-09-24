ALTER TABLE runs ADD COLUMN error_code text;
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN model_usage jsonb;
--> statement-breakpoint
ALTER TABLE runs ADD CONSTRAINT runs_model_usage_native CHECK (
  model_usage IS NULL OR (
    execution_profile = 'none' AND node_id IS NULL AND jsonb_typeof(model_usage) = 'object'
  )
);
