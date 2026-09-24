CREATE TABLE "node_enrollment_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"node_id" text NOT NULL,
	"token_digest" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_enrollment_tokens_digest_valid" CHECK (length("node_enrollment_tokens"."token_digest") = 64),
	CONSTRAINT "node_enrollment_tokens_node_id_not_blank" CHECK (length(btrim("node_enrollment_tokens"."node_id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "node_credentials" (
	"node_id" text PRIMARY KEY NOT NULL,
	"credential_digest" text NOT NULL,
	"enrolled_at" timestamp with time zone NOT NULL,
	"last_authenticated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_credentials_digest_valid" CHECK (length("node_credentials"."credential_digest") = 64),
	CONSTRAINT "node_credentials_node_id_not_blank" CHECK (length(btrim("node_credentials"."node_id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "node_identity_events" (
	"id" text PRIMARY KEY NOT NULL,
	"node_id" text NOT NULL,
	"type" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_identity_events_type_valid" CHECK ("node_identity_events"."type" IN ('enrollment_created', 'enrolled', 'revoked')),
	CONSTRAINT "node_identity_events_node_id_not_blank" CHECK (length(btrim("node_identity_events"."node_id")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "node_enrollment_tokens_digest_idx" ON "node_enrollment_tokens" USING btree ("token_digest");
--> statement-breakpoint
CREATE UNIQUE INDEX "node_enrollment_tokens_one_active_per_node_idx" ON "node_enrollment_tokens" USING btree ("node_id") WHERE "node_enrollment_tokens"."consumed_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "node_enrollment_tokens_expiry_idx" ON "node_enrollment_tokens" USING btree ("expires_at") WHERE "node_enrollment_tokens"."consumed_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "node_credentials_digest_idx" ON "node_credentials" USING btree ("credential_digest");
--> statement-breakpoint
CREATE INDEX "node_credentials_active_idx" ON "node_credentials" USING btree ("node_id") WHERE "node_credentials"."revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "node_identity_events_node_time_idx" ON "node_identity_events" USING btree ("node_id","created_at");
