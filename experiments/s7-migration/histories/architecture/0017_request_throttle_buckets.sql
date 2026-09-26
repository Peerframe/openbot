CREATE TABLE "request_throttle_buckets" (
	"scope" text NOT NULL,
	"client_digest" text NOT NULL,
	"attempt_count" integer NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"blocked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_throttle_buckets_scope_client_digest_pk" PRIMARY KEY("scope","client_digest"),
	CONSTRAINT "request_throttle_scope_valid" CHECK ("scope" IN ('owner-login', 'node-enrollment')),
	CONSTRAINT "request_throttle_client_digest_valid" CHECK (length("client_digest") = 64),
	CONSTRAINT "request_throttle_attempt_count_valid" CHECK ("attempt_count" >= 1)
);
--> statement-breakpoint
CREATE INDEX "request_throttle_expiry_idx" ON "request_throttle_buckets" USING btree ("updated_at");
