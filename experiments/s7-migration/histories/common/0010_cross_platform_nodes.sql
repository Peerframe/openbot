ALTER TABLE "nodes" ADD COLUMN "os_version" text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "architecture" text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "device_class" text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "isolation" text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "trust_tier" text DEFAULT 'development' NOT NULL;
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "capability_manifest" jsonb DEFAULT '[]'::jsonb NOT NULL;
