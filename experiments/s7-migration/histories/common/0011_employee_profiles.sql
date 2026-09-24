CREATE TABLE "employee_evolution_events" (
  "id" text PRIMARY KEY NOT NULL,
  "bot_id" text NOT NULL REFERENCES "bots"("id") ON DELETE cascade,
  "type" text NOT NULL,
  "title" text NOT NULL,
  "summary" text NOT NULL,
  "source" text NOT NULL,
  "source_id" text,
  "evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "employee_evolution_type_valid" CHECK ("type" IN ('created', 'role_changed', 'skill_discovered', 'skill_verified', 'skill_suspended', 'skill_revoked', 'configuration_changed', 'imported')),
  CONSTRAINT "employee_evolution_source_valid" CHECK ("source" IN ('run', 'artifact', 'approval', 'manual', 'import')),
  CONSTRAINT "employee_evolution_title_not_blank" CHECK (length(btrim("title")) > 0),
  CONSTRAINT "employee_evolution_summary_not_blank" CHECK (length(btrim("summary")) > 0)
);
--> statement-breakpoint
CREATE INDEX "employee_evolution_bot_time_idx" ON "employee_evolution_events" USING btree ("bot_id", "created_at");
--> statement-breakpoint
CREATE TABLE "skills" (
  "id" text PRIMARY KEY NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "version" text NOT NULL,
  "source" text NOT NULL,
  "required_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skills_slug_not_blank" CHECK (length(btrim("slug")) > 0),
  CONSTRAINT "skills_name_not_blank" CHECK (length(btrim("name")) > 0),
  CONSTRAINT "skills_version_not_blank" CHECK (length(btrim("version")) > 0),
  CONSTRAINT "skills_source_not_blank" CHECK (length(btrim("source")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "skills_slug_version_idx" ON "skills" USING btree ("slug", "version");
--> statement-breakpoint
CREATE TABLE "employee_skills" (
  "bot_id" text NOT NULL REFERENCES "bots"("id") ON DELETE cascade,
  "skill_id" text NOT NULL REFERENCES "skills"("id") ON DELETE cascade,
  "state" text DEFAULT 'candidate' NOT NULL,
  "confidence" integer DEFAULT 0 NOT NULL,
  "evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "employee_skills_bot_id_skill_id_pk" PRIMARY KEY("bot_id", "skill_id"),
  CONSTRAINT "employee_skills_state_valid" CHECK ("state" IN ('candidate', 'verified', 'suspended', 'revoked')),
  CONSTRAINT "employee_skills_confidence_valid" CHECK ("confidence" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE INDEX "employee_skills_state_idx" ON "employee_skills" USING btree ("bot_id", "state");
--> statement-breakpoint
CREATE TABLE "skill_dependencies" (
  "skill_id" text NOT NULL REFERENCES "skills"("id") ON DELETE cascade,
  "depends_on_skill_id" text NOT NULL REFERENCES "skills"("id") ON DELETE cascade,
  CONSTRAINT "skill_dependencies_skill_id_depends_on_skill_id_pk" PRIMARY KEY("skill_id", "depends_on_skill_id"),
  CONSTRAINT "skill_dependencies_not_self" CHECK ("skill_id" <> "depends_on_skill_id")
);
--> statement-breakpoint
CREATE TABLE "employee_memories" (
  "id" text PRIMARY KEY NOT NULL,
  "bot_id" text NOT NULL REFERENCES "bots"("id") ON DELETE cascade,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "content" text NOT NULL,
  "sensitivity" text DEFAULT 'internal' NOT NULL,
  "portability" text DEFAULT 'owner-selectable' NOT NULL,
  "provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "employee_memories_kind_valid" CHECK ("kind" IN ('working', 'episodic', 'semantic', 'procedural', 'secret-reference')),
  CONSTRAINT "employee_memories_sensitivity_valid" CHECK ("sensitivity" IN ('public', 'internal', 'confidential', 'restricted')),
  CONSTRAINT "employee_memories_portability_valid" CHECK ("portability" IN ('never', 'owner-selectable', 'included')),
  CONSTRAINT "employee_memories_title_not_blank" CHECK (length(btrim("title")) > 0),
  CONSTRAINT "employee_memories_content_not_blank" CHECK (length(btrim("content")) > 0)
);
--> statement-breakpoint
CREATE INDEX "employee_memories_bot_time_idx" ON "employee_memories" USING btree ("bot_id", "updated_at");
