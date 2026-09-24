ALTER TABLE "employee_skills" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
UPDATE "employee_skills"
SET "source" = "skills"."source"
FROM "skills"
WHERE "employee_skills"."skill_id" = "skills"."id";
--> statement-breakpoint
ALTER TABLE "employee_skills" ADD CONSTRAINT "employee_skills_source_valid" CHECK ("employee_skills"."source" IN ('built-in', 'installed', 'learned', 'imported', 'manual'));
--> statement-breakpoint
CREATE TABLE "employee_import_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"package_id" text NOT NULL,
	"package_digest" text NOT NULL,
	"employee_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"signature_status" text NOT NULL,
	"publisher_key_id" text,
	"reviewed_by" text NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	"imported_skill_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_import_receipts_package_digest_valid" CHECK (length("employee_import_receipts"."package_digest") = 64),
	CONSTRAINT "employee_import_receipts_request_fingerprint_valid" CHECK (length("employee_import_receipts"."request_fingerprint") = 64),
	CONSTRAINT "employee_import_receipts_signature_status_valid" CHECK ("employee_import_receipts"."signature_status" IN ('unsigned', 'dsse')),
	CONSTRAINT "employee_import_receipts_publisher_valid" CHECK (("employee_import_receipts"."signature_status" = 'unsigned' AND "employee_import_receipts"."publisher_key_id" IS NULL) OR ("employee_import_receipts"."signature_status" = 'dsse' AND length(btrim("employee_import_receipts"."publisher_key_id")) > 0)),
	CONSTRAINT "employee_import_receipts_reviewer_valid" CHECK ("employee_import_receipts"."reviewed_by" = 'owner'),
	CONSTRAINT "employee_import_receipts_skill_count_valid" CHECK ("employee_import_receipts"."imported_skill_count" BETWEEN 0 AND 256)
);
--> statement-breakpoint
ALTER TABLE "employee_import_receipts" ADD CONSTRAINT "employee_import_receipts_employee_id_bots_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."bots"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "employee_import_receipts_package_idx" ON "employee_import_receipts" USING btree ("package_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "employee_import_receipts_idempotency_idx" ON "employee_import_receipts" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "employee_import_receipts_employee_idx" ON "employee_import_receipts" USING btree ("employee_id");
