CREATE UNIQUE INDEX IF NOT EXISTS bots_name_idx ON bots (name);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'channels_name_not_blank'
      AND conrelid = 'channels'::regclass
  ) THEN
    ALTER TABLE channels
      ADD CONSTRAINT channels_name_not_blank CHECK (length(btrim(name)) > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bots_name_not_blank'
      AND conrelid = 'bots'::regclass
  ) THEN
    ALTER TABLE bots
      ADD CONSTRAINT bots_name_not_blank CHECK (length(btrim(name)) > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS channel_bots_bot_idx ON channel_bots (bot_id);
CREATE INDEX IF NOT EXISTS runs_channel_created_idx ON runs (channel_id, created_at);
CREATE INDEX IF NOT EXISTS runs_bot_idx ON runs (bot_id);
CREATE INDEX IF NOT EXISTS runs_node_idx ON runs (node_id);
CREATE INDEX IF NOT EXISTS runs_status_created_idx ON runs (status, created_at);
CREATE INDEX IF NOT EXISTS run_events_channel_time_idx ON run_events (channel_id, created_at);
CREATE INDEX IF NOT EXISTS run_events_bot_idx ON run_events (bot_id);
CREATE INDEX IF NOT EXISTS run_events_node_idx ON run_events (node_id);

CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY,
  channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_type text NOT NULL,
  author_id text,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_channel_time_idx ON messages (channel_id, created_at);
