CREATE TABLE automations (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  bot_id text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  prompt text NOT NULL CHECK (length(btrim(prompt)) BETWEEN 1 AND 8000),
  interval_minutes integer NOT NULL CHECK (interval_minutes BETWEEN 15 AND 10080),
  enabled boolean NOT NULL DEFAULT true,
  next_run_at timestamptz NOT NULL,
  last_run_at timestamptz,
  last_run_id text REFERENCES runs(id) ON DELETE SET NULL,
  last_outcome text CHECK (last_outcome IN ('submitted', 'skipped_active', 'target_unavailable')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX automations_due_idx ON automations (next_run_at) WHERE enabled = true;
