-- Preparation is a uniqueness/readiness fact; Work admission remains the only execution authority.
CREATE TABLE work_command_preparations (
 action_id text PRIMARY KEY REFERENCES work_actions(id),
 preparation_id uuid NOT NULL UNIQUE,
 task_id text NOT NULL REFERENCES work_command_profiles(task_id),
 original_claim_id text NOT NULL,
 binding jsonb NOT NULL CHECK(jsonb_typeof(binding)='object' AND octet_length(binding::text)<=8192),
 operation jsonb NOT NULL CHECK(jsonb_typeof(operation)='object' AND octet_length(operation::text)<=32768),
 engine_proof jsonb NOT NULL CHECK(jsonb_typeof(engine_proof)='object' AND octet_length(engine_proof::text)<=16384),
 input_scope jsonb NOT NULL CHECK(jsonb_typeof(input_scope)='object' AND octet_length(input_scope::text)<=32768),
 timing jsonb NOT NULL CHECK(jsonb_typeof(timing)='object' AND octet_length(timing::text)<=2048),
 server_instance_id uuid NOT NULL,
 root_deadline_ms bigint NOT NULL CHECK(root_deadline_ms>0),
 original_expiry_ms bigint NOT NULL CHECK(original_expiry_ms>0),
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','authorized','ready','closed')),
 challenge_token text CHECK(octet_length(challenge_token)<=8192),
 authorization_token text CHECK(octet_length(authorization_token)<=8192),
 issued_at_ms bigint,
 ready_token text CHECK(octet_length(ready_token)<=8192),
 readiness_digest text CHECK(readiness_digest ~ '^[0-9a-f]{64}$'),
 received_at_ms bigint,
 native_deadline_ms bigint,
 closed_at_ms bigint,
 close_reason text CHECK(close_reason IN ('cancel','revoked','expired','source_changed','identity_changed','restart','clock_changed')),
 CHECK(binding->>'actionId'=action_id AND binding->>'taskId'=task_id AND binding->>'preparationId'=preparation_id::text),
 CHECK((state='reserved' AND challenge_token IS NULL AND authorization_token IS NULL AND issued_at_ms IS NULL
     AND ready_token IS NULL AND readiness_digest IS NULL AND received_at_ms IS NULL AND native_deadline_ms IS NULL AND closed_at_ms IS NULL)
   OR (state='authorized' AND challenge_token IS NOT NULL AND authorization_token IS NOT NULL AND issued_at_ms IS NOT NULL
     AND ready_token IS NULL AND readiness_digest IS NULL AND received_at_ms IS NULL AND native_deadline_ms IS NULL AND closed_at_ms IS NULL)
   OR (state='ready' AND challenge_token IS NOT NULL AND authorization_token IS NOT NULL AND issued_at_ms IS NOT NULL
     AND ready_token IS NOT NULL AND readiness_digest IS NOT NULL AND received_at_ms>=issued_at_ms
     AND native_deadline_ms>received_at_ms AND native_deadline_ms<=root_deadline_ms
     AND native_deadline_ms<=original_expiry_ms AND closed_at_ms IS NULL)
   OR (state='closed' AND closed_at_ms IS NOT NULL AND close_reason IS NOT NULL)),
 CHECK((closed_at_ms IS NULL)=(close_reason IS NULL))
);
--> statement-breakpoint
ALTER TABLE work_command_dispatches ADD COLUMN preparation_id uuid REFERENCES work_command_preparations(preparation_id);
--> statement-breakpoint
ALTER TABLE work_command_dispatches ADD COLUMN readiness_digest text CHECK(readiness_digest ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE work_command_dispatches ADD CONSTRAINT work_command_v2_preparation_pair CHECK((preparation_id IS NULL)=(readiness_digest IS NULL));
--> statement-breakpoint
CREATE INDEX work_command_preparations_task_state_idx ON work_command_preparations(task_id,state);
