-- Existing sessions remain valid and have no claimed device identity until their next login.
ALTER TABLE auth_sessions ADD COLUMN user_agent text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_user_agent_bound CHECK (length(user_agent)<=256);
--> statement-breakpoint
CREATE TABLE owner_credentials (
  owner_id text PRIMARY KEY DEFAULT 'owner' CHECK (owner_id='owner'),
  password_hash text NOT NULL CHECK (password_hash ~ '^scrypt\$32768\$8\$3\$[a-f0-9]{32}\$[a-f0-9]{64}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
