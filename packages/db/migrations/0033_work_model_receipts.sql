-- Control-owned observations of one admitted model Action. Payloads live in the existing
-- private immutable blob store; neither these records nor historical settlement grant execution.
CREATE TABLE work_model_receipts (
  action_id text PRIMARY KEY REFERENCES work_actions(id),
  task_id text NOT NULL,
  run_id text NOT NULL,
  intent_digest text NOT NULL CHECK (intent_digest ~ '^[0-9a-f]{64}$'),
  codec text NOT NULL CHECK (codec = 'pydantic-ai2-model-response-v1'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 2097152),
  actual_tokens bigint NOT NULL CHECK (actual_tokens BETWEEN 0 AND 1000000000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (task_id,run_id) REFERENCES work_runs(task_id,id)
);
