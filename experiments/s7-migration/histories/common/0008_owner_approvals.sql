ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "node_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "summary" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "risk" text DEFAULT 'write';--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "target_fingerprint" text;--> statement-breakpoint
UPDATE "approvals" AS approval
SET "node_id" = run."node_id"
FROM "runs" AS run
WHERE approval."run_id" = run."id" AND approval."node_id" IS NULL;--> statement-breakpoint
UPDATE "approvals"
SET "summary" = concat("action", ' · ', "target")
WHERE "summary" IS NULL;--> statement-breakpoint
UPDATE "approvals"
SET "target_fingerprint" = concat(md5(concat("action", ':', "target")), md5(concat("target", ':', "action")))
WHERE "target_fingerprint" IS NULL;--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "node_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "summary" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "risk" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "risk" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "target_fingerprint" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_status_valid" CHECK ("status" IN ('pending', 'approved', 'rejected', 'expired'));--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_risk_valid" CHECK ("risk" IN ('write', 'destructive', 'privileged'));--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_action_not_blank" CHECK (length(btrim("action")) > 0);--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_target_not_blank" CHECK (length(btrim("target")) > 0);--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_summary_not_blank" CHECK (length(btrim("summary")) > 0);--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_target_fingerprint_valid" CHECK (length("target_fingerprint") = 64);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approvals_status_expiry_idx" ON "approvals" USING btree ("status", "expires_at");
