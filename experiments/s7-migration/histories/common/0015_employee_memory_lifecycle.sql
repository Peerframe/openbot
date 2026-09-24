ALTER TABLE "employee_memories" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;
ALTER TABLE "employee_memories" ADD CONSTRAINT "employee_memories_revision_valid" CHECK ("revision" >= 1);

CREATE TABLE "employee_memory_events" (
  "id" text PRIMARY KEY NOT NULL,
  "bot_id" text NOT NULL,
  "memory_id" text NOT NULL,
  "action" text NOT NULL,
  "revision" integer NOT NULL,
  "changed_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "actor" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "employee_memory_events_action_valid" CHECK ("action" IN ('created', 'updated', 'deleted')),
  CONSTRAINT "employee_memory_events_revision_valid" CHECK ("revision" >= 1),
  CONSTRAINT "employee_memory_events_actor_valid" CHECK ("actor" = 'owner')
);

ALTER TABLE "employee_memory_events" ADD CONSTRAINT "employee_memory_events_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "employee_memory_events_bot_time_idx" ON "employee_memory_events" USING btree ("bot_id", "created_at");
CREATE INDEX "employee_memory_events_memory_time_idx" ON "employee_memory_events" USING btree ("memory_id", "created_at");
