-- Existing messages retain NULL origin. Only the optional Server-written quick-create greeting
-- uses this tag; it cannot be attributed to an Owner or system author.
ALTER TABLE messages ADD COLUMN origin text;
--> statement-breakpoint
ALTER TABLE messages ADD CONSTRAINT messages_origin_valid CHECK
  (origin IS NULL OR (origin = 'greeting' AND author_type = 'bot' AND author_id IS NOT NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX messages_bot_greeting_once ON messages (author_id) WHERE origin = 'greeting';
--> statement-breakpoint
-- This claim survives failed/cancelled calls and message deletion. Restart never retries a claim.
CREATE UNIQUE INDEX run_events_bot_greeting_once ON run_events (bot_id) WHERE type = 'BOT_GREETING_STARTED';
