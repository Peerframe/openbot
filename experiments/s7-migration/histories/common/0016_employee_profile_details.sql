ALTER TABLE "bots" ADD COLUMN "description" text DEFAULT '' NOT NULL;
ALTER TABLE "bots" ADD COLUMN "profile_revision" integer DEFAULT 1 NOT NULL;
ALTER TABLE "bots" ADD CONSTRAINT "bots_role_not_blank" CHECK (length(btrim("role")) > 0);
ALTER TABLE "bots" ADD CONSTRAINT "bots_role_length_valid" CHECK (length("role") <= 160);
ALTER TABLE "bots" ADD CONSTRAINT "bots_description_length_valid" CHECK (length("description") <= 2000);
ALTER TABLE "bots" ADD CONSTRAINT "bots_profile_revision_valid" CHECK ("profile_revision" >= 1);
