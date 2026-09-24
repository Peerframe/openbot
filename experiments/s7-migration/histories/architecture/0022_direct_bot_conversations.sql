ALTER TABLE "channels" ADD COLUMN "direct_bot_id" text REFERENCES "bots"("id") ON DELETE RESTRICT;
--> statement-breakpoint
DROP INDEX "channels_name_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "channels_name_idx" ON "channels" ("name") WHERE "direct_bot_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "channels_direct_bot_idx" ON "channels" ("direct_bot_id");
