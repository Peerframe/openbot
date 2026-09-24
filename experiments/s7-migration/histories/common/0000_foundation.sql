CREATE TABLE IF NOT EXISTS channels (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS channels_name_idx ON channels (name);

CREATE TABLE IF NOT EXISTS bots (
  id text PRIMARY KEY,
  name text NOT NULL,
  role text NOT NULL,
  status text NOT NULL DEFAULT 'idle',
  computer_profile text NOT NULL DEFAULT 'none',
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channel_bots (
  channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  bot_id text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, bot_id)
);

CREATE TABLE IF NOT EXISTS nodes (
  id text PRIMARY KEY,
  name text NOT NULL,
  platform text NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'offline',
  connected_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY,
  channel_id text NOT NULL REFERENCES channels(id),
  bot_id text NOT NULL REFERENCES bots(id),
  node_id text REFERENCES nodes(id),
  title text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runs_channel_idx ON runs (channel_id);
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs (status);

CREATE TABLE IF NOT EXISTS run_events (
  id text PRIMARY KEY,
  run_id text REFERENCES runs(id) ON DELETE CASCADE,
  channel_id text REFERENCES channels(id),
  bot_id text REFERENCES bots(id),
  node_id text REFERENCES nodes(id),
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS run_events_run_time_idx ON run_events (run_id, created_at);

CREATE TABLE IF NOT EXISTS approvals (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  action text NOT NULL,
  target text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  before_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  decided_by text,
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS approvals_run_status_idx ON approvals (run_id, status);

CREATE TABLE IF NOT EXISTS artifacts (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name text NOT NULL,
  media_type text NOT NULL,
  storage_key text NOT NULL,
  sha256 text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS artifacts_run_idx ON artifacts (run_id);
