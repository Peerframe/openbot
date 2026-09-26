-- Work identities are independent of legacy channel-coupled runs. No old records are reclassified.
CREATE TABLE work_tasks (
  id text PRIMARY KEY,
  owner_id text NOT NULL CHECK (owner_id = 'owner'),
  bot_id text NOT NULL REFERENCES bots(id),
  request_key text NOT NULL UNIQUE CHECK (octet_length(request_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  objective text NOT NULL CHECK (octet_length(objective) BETWEEN 1 AND 16384),
  token_limit bigint NOT NULL CHECK (token_limit BETWEEN 0 AND 1000000000),
  authority_generation bigint NOT NULL DEFAULT 1 CHECK (authority_generation > 0),
  authority_active boolean NOT NULL DEFAULT true,
  cancel_requested boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','open','completed','cancelled','failed')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
CREATE TABLE work_runs (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES work_tasks(id),
  ordinal integer NOT NULL CHECK (ordinal > 0),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','cancelled','failed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (task_id,ordinal),
  UNIQUE (task_id,id)
);
--> statement-breakpoint
-- A pending row is a handoff obligation, not evidence that an engine has started execution.
CREATE TABLE work_admissions (
  run_id text PRIMARY KEY REFERENCES work_runs(id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','acknowledged')),
  engine_reference text,
  CHECK ((state = 'pending' AND engine_reference IS NULL) OR
         (state = 'acknowledged' AND engine_reference IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE work_actions (
  id text PRIMARY KEY,
  task_id text NOT NULL,
  run_id text NOT NULL,
  action_key text NOT NULL CHECK (octet_length(action_key) BETWEEN 1 AND 128),
  intent jsonb NOT NULL CHECK (octet_length(intent::text) <= 32768),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^[0-9a-f]{64}$'),
  authority_generation bigint NOT NULL,
  requires_approval boolean NOT NULL,
  decision text NOT NULL CHECK (decision IN ('not_required','pending','approved','denied')),
  expires_at timestamptz NOT NULL,
  reserved_tokens bigint NOT NULL CHECK (reserved_tokens BETWEEN 0 AND 1000000000),
  actual_tokens bigint CHECK (actual_tokens >= 0),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','admitted','unknown','applied','not_applied')),
  evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (task_id,run_id) REFERENCES work_runs(task_id,id),
  UNIQUE (run_id,action_key),
  CHECK ((requires_approval AND decision <> 'not_required') OR
         (NOT requires_approval AND decision = 'not_required')),
  CHECK ((status IN ('applied','not_applied') AND actual_tokens IS NOT NULL AND evidence IS NOT NULL) OR
         (status NOT IN ('applied','not_applied') AND actual_tokens IS NULL AND evidence IS NULL))
);
--> statement-breakpoint
CREATE TABLE work_events (
  task_id text NOT NULL REFERENCES work_tasks(id),
  revision bigint NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 32768),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (task_id,revision)
);
