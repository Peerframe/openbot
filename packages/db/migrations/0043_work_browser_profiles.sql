-- Explicit browser capture profiles. No historical Work is promoted or rebound.
CREATE TABLE work_browser_profiles (
  task_id text PRIMARY KEY REFERENCES work_tasks(id),
  source_run_id text NOT NULL UNIQUE REFERENCES runs(id),
  bot_id text NOT NULL REFERENCES bots(id),
  model_selection jsonb NOT NULL CHECK (jsonb_typeof(model_selection)='object' AND octet_length(model_selection::text)<=2048),
  profile jsonb NOT NULL CHECK (jsonb_typeof(profile)='object' AND octet_length(profile::text)<=8192),
  profile_digest text NOT NULL CHECK (profile_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (profile->>'kind'='work_browser_profile' AND profile->>'version'='1'
    AND profile->>'executionProfile'='docker-linux' AND profile->>'taskId'=task_id
    AND profile->>'botId'=bot_id AND profile->>'sourceRunId'=source_run_id
    AND profile->'modelSelection'=model_selection AND profile->>'maxCaptures'='4'),
  CHECK (profile ?& ARRAY['kind','version','executionProfile','taskId','botId','sourceRunId','modelSelection','nodeId','credentialDigest','maxCaptures']),
  CHECK (profile - ARRAY['kind','version','executionProfile','taskId','botId','sourceRunId','modelSelection','nodeId','credentialDigest','maxCaptures'] = '{}'::jsonb)
);
