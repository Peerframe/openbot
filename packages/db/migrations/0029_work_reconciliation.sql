-- A repair request authorizes receipt lookup, never a new effect or an asserted outcome.
CREATE TABLE work_reconciliation_commands (
  id text PRIMARY KEY,
  action_id text NOT NULL REFERENCES work_actions(id),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^[0-9a-f]{64}$'),
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 64),
  requested_by text NOT NULL CHECK (requested_by = 'owner'),
  reason text NOT NULL CHECK (octet_length(reason) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivery_reference text CHECK (octet_length(delivery_reference) BETWEEN 1 AND 256),
  delivered_at timestamptz,
  outcome text CHECK (outcome IN ('resolved','unresolved')),
  finished_at timestamptz,
  UNIQUE (action_id,sequence),
  CHECK ((delivery_reference IS NULL) = (delivered_at IS NULL)),
  CHECK ((outcome IS NULL) = (finished_at IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX work_reconciliation_unfinished_idx ON work_reconciliation_commands(action_id)
  WHERE finished_at IS NULL;
--> statement-breakpoint
CREATE INDEX work_reconciliation_pending_idx ON work_reconciliation_commands(created_at,id)
  WHERE delivered_at IS NULL AND finished_at IS NULL;
--> statement-breakpoint
-- Coalesced clicks also keep their accepted idempotency key after the shared cycle finishes.
CREATE TABLE work_reconciliation_requests (
  request_key text PRIMARY KEY CHECK (octet_length(request_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  command_id text NOT NULL REFERENCES work_reconciliation_commands(id)
);
