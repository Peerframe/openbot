-- ADR-0049: Owner additional confirmation; preserve every pre-existing adapter minimum/decision.
CREATE TABLE "owner_approval_settings" (
  "owner_id" text PRIMARY KEY NOT NULL CHECK ("owner_id" = 'owner'),
  "revision" integer NOT NULL DEFAULT 1 CHECK ("revision" BETWEEN 1 AND 2147483647),
  "configuration" jsonb NOT NULL CHECK (
    jsonb_typeof("configuration") = 'object' AND
    "configuration" ?& ARRAY['productRead','publicWeb','exceptions'] AND
    "configuration" - ARRAY['productRead','publicWeb','exceptions'] = '{}'::jsonb AND
    "configuration"->>'productRead' IN ('inherit','required') AND
    "configuration"->>'publicWeb' IN ('inherit','required') AND
    jsonb_typeof("configuration"->'exceptions') = 'array' AND
    jsonb_array_length("configuration"->'exceptions') <= 64
  )
);
--> statement-breakpoint
INSERT INTO "owner_approval_settings" ("owner_id","configuration") VALUES
('owner','{"productRead":"inherit","publicWeb":"inherit","exceptions":[]}'::jsonb);
--> statement-breakpoint
ALTER TABLE "work_actions" ADD COLUMN "baseline_requires_approval" boolean;
--> statement-breakpoint
UPDATE "work_actions" SET "baseline_requires_approval" = "requires_approval";
--> statement-breakpoint
ALTER TABLE "work_actions" ALTER COLUMN "baseline_requires_approval" SET DEFAULT true;
--> statement-breakpoint
ALTER TABLE "work_actions" ALTER COLUMN "baseline_requires_approval" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "work_actions" ADD CONSTRAINT "work_actions_approval_minimum" CHECK
(NOT "baseline_requires_approval" OR "requires_approval");
