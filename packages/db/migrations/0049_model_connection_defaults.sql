-- Existing connections retain no default; credentials and selections are unchanged.
ALTER TABLE model_connections ADD COLUMN default_model text;
--> statement-breakpoint
ALTER TABLE model_connections ADD CONSTRAINT model_connections_default_model_valid CHECK (
  default_model IS NULL OR (length(default_model) BETWEEN 1 AND 256
    AND default_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$')
);
