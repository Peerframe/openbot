-- One source message may address multiple exact Bots; each Bot receives it at most once.
DROP INDEX runs_source_message_idx;
CREATE UNIQUE INDEX runs_source_message_bot_idx ON runs(source_message_id, bot_id)
  WHERE source_message_id IS NOT NULL;
