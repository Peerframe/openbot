-- Command authority components stay inactive until host integration is qualified. No history backfill.
CREATE TABLE work_command_profiles (
  task_id text PRIMARY KEY REFERENCES work_tasks(id),
  source_run_id text NOT NULL UNIQUE REFERENCES runs(id),
  bot_id text NOT NULL REFERENCES bots(id),
  model_selection jsonb NOT NULL CHECK (jsonb_typeof(model_selection)='object' AND octet_length(model_selection::text)<=2048),
  profile jsonb NOT NULL CHECK (jsonb_typeof(profile)='object' AND octet_length(profile::text)<=16384),
  profile_digest text NOT NULL CHECK (profile_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (profile->>'kind'='work_command_profile' AND profile->>'version'='1'
    AND profile->>'executionProfile'='docker-linux' AND profile->>'taskId'=task_id
    AND profile->>'botId'=bot_id AND profile->>'sourceRunId'=source_run_id
    AND profile->'modelSelection'=model_selection),
  CHECK (profile ?& ARRAY['kind','version','executionProfile','taskId','botId','sourceRunId','modelSelection','route','credentialDigest','policyId','policyDigest']),
  CHECK (profile - ARRAY['kind','version','executionProfile','taskId','botId','sourceRunId','modelSelection','route','credentialDigest','policyId','policyDigest'] = '{}'::jsonb)
);
--> statement-breakpoint
CREATE TABLE work_command_dispatches (
  action_id text PRIMARY KEY REFERENCES work_actions(id),
  dispatch_id uuid NOT NULL UNIQUE,
  task_id text NOT NULL REFERENCES work_command_profiles(task_id),
  original_claim_id text NOT NULL CHECK (octet_length(original_claim_id) BETWEEN 1 AND 128),
  original_epoch bigint NOT NULL CHECK (original_epoch BETWEEN 1 AND 10000),
  authority_generation bigint NOT NULL CHECK (authority_generation>0),
  connection_id uuid NOT NULL,
  intent_digest text NOT NULL CHECK (intent_digest ~ '^[0-9a-f]{64}$'),
  operation_fingerprint text NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  operation jsonb NOT NULL CHECK (jsonb_typeof(operation)='object' AND octet_length(operation::text)<=32768),
  dispatch_claims jsonb NOT NULL CHECK (jsonb_typeof(dispatch_claims)='object' AND octet_length(dispatch_claims::text)<=16384),
  ticket_digest text NOT NULL CHECK (ticket_digest ~ '^[0-9a-f]{64}$'),
  engine_proof jsonb NOT NULL CHECK (jsonb_typeof(engine_proof)='object' AND octet_length(engine_proof::text)<=16384),
  input_scope jsonb NOT NULL CHECK (jsonb_typeof(input_scope)='object' AND octet_length(input_scope::text)<=32768),
  state text NOT NULL DEFAULT 'issued' CHECK (state IN ('issued','consumed','closed')),
  issued_at_ms bigint NOT NULL CHECK (issued_at_ms>0),
  expires_at_ms bigint NOT NULL,
  root_deadline_ms bigint NOT NULL,
  native_deadline_ms bigint NOT NULL,
  hard_deadline_ms bigint NOT NULL,
  consume_request_digest text CHECK (consume_request_digest ~ '^[0-9a-f]{64}$'),
  consume_nonce text CHECK (consume_nonce ~ '^[A-Za-z0-9_-]{43}$'),
  consumed_at_ms bigint,
  permit_claims jsonb CHECK (jsonb_typeof(permit_claims)='object' AND octet_length(permit_claims::text)<=16384),
  closed_at_ms bigint,
  close_reason text CHECK (close_reason IN ('cancel','revoked','expired','source_changed','identity_changed')),
  CHECK (issued_at_ms<expires_at_ms AND expires_at_ms<=issued_at_ms+30000 AND expires_at_ms<=hard_deadline_ms),
  CHECK (hard_deadline_ms>issued_at_ms AND hard_deadline_ms<=root_deadline_ms AND hard_deadline_ms=native_deadline_ms
    AND hard_deadline_ms<=issued_at_ms+60000),
  CHECK ((state='issued' AND consume_request_digest IS NULL AND consume_nonce IS NULL AND consumed_at_ms IS NULL
      AND permit_claims IS NULL AND closed_at_ms IS NULL AND close_reason IS NULL)
    OR (state='consumed' AND consume_request_digest IS NOT NULL AND consume_nonce IS NOT NULL AND consumed_at_ms IS NOT NULL
      AND consumed_at_ms>=issued_at_ms AND consumed_at_ms<expires_at_ms AND permit_claims IS NOT NULL
      AND closed_at_ms IS NULL AND close_reason IS NULL)
    OR (state='closed' AND consume_request_digest IS NULL AND consume_nonce IS NULL AND consumed_at_ms IS NULL
      AND permit_claims IS NULL AND closed_at_ms IS NOT NULL AND close_reason IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX work_command_dispatches_task_state_idx ON work_command_dispatches(task_id,state);
