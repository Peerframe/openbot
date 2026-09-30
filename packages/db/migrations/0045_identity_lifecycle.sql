-- ADR-0047: tombstone deleted channels/Bots, scope name uniqueness to live rows and add the
-- single-Owner channel read cursor. Existing rows stay live; existing channels start as read so an
-- upgrade does not mark historical conversations unread. Rollback boundary: the added column,
-- index predicates and table are additive; restoring the previous indexes requires that no two live
-- rows share a name, which this migration never creates.
ALTER TABLE "bots" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
DROP INDEX "bots_name_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "bots_name_idx" ON "bots" ("name") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
DROP INDEX "channels_name_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "channels_name_idx" ON "channels" ("name") WHERE "direct_bot_id" IS NULL AND "deleted_at" IS NULL;
--> statement-breakpoint
CREATE TABLE "channel_read_states" (
  "channel_id" text PRIMARY KEY NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "last_read_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
INSERT INTO "channel_read_states" ("channel_id", "last_read_at")
SELECT "id", date_trunc('milliseconds', statement_timestamp()) FROM "channels";
