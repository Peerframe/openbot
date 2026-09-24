CREATE TABLE "message_reactions" (
  "message_id" text NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE,
  "channel_id" text NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "emoji" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("message_id", "emoji"),
  CONSTRAINT "message_reactions_emoji_valid" CHECK ("emoji" IN ('👍', '❤️', '😂', '🎉', '🤔', '👀'))
);
--> statement-breakpoint
CREATE INDEX "message_reactions_channel_idx" ON "message_reactions" ("channel_id", "message_id");
