ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "reply_to_message_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "run_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_reply_idx" ON "messages" USING btree ("reply_to_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_run_idx" ON "messages" USING btree ("run_id");
