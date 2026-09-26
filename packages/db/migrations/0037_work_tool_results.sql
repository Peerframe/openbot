-- A received tool response is private untrusted data, not an independent business-effect
-- verdict. No observation creates permission or allows an admitted tool to be resent.
CREATE TABLE work_tool_results (
  action_id text PRIMARY KEY REFERENCES work_actions(id),
  task_id text NOT NULL,
  run_id text NOT NULL,
  intent_digest text NOT NULL CHECK (intent_digest ~ '^[0-9a-f]{64}$'),
  codec text NOT NULL CHECK (codec = 'openbot-tool-json-v1'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 131072),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (task_id,run_id) REFERENCES work_runs(task_id,id)
);
