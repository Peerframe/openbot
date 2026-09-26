-- New tasks alone may opt into page data/input; existing capture profiles are unchanged.
CREATE TABLE work_browser_page_scopes (
  task_id text PRIMARY KEY REFERENCES work_browser_profiles(task_id),
  scope jsonb NOT NULL CHECK (jsonb_typeof(scope)='object' AND octet_length(scope::text)<=8192),
  scope_digest text NOT NULL CHECK (scope_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (scope->>'kind'='work_browser_page_scope' AND scope->>'version'='1'
    AND scope->>'taskId'=task_id AND scope->>'maxActions'='16'
    AND jsonb_typeof(scope->'origins')='array' AND jsonb_array_length(scope->'origins') BETWEEN 1 AND 10),
  CHECK (scope ?& ARRAY['kind','version','taskId','origins','maxActions']),
  CHECK (scope - ARRAY['kind','version','taskId','origins','maxActions'] = '{}'::jsonb)
);
