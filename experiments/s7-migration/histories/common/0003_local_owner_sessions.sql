CREATE TABLE IF NOT EXISTS auth_sessions (
  id text PRIMARY KEY,
  token_digest text NOT NULL,
  owner_id text NOT NULL DEFAULT 'owner',
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS auth_sessions_token_digest_idx
  ON auth_sessions (token_digest);

CREATE INDEX IF NOT EXISTS auth_sessions_active_expiry_idx
  ON auth_sessions (expires_at)
  WHERE revoked_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'auth_sessions_owner_valid'
      AND conrelid = 'auth_sessions'::regclass
  ) THEN
    ALTER TABLE auth_sessions
      ADD CONSTRAINT auth_sessions_owner_valid CHECK (owner_id = 'owner');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'auth_sessions_token_digest_valid'
      AND conrelid = 'auth_sessions'::regclass
  ) THEN
    ALTER TABLE auth_sessions
      ADD CONSTRAINT auth_sessions_token_digest_valid CHECK (length(token_digest) = 64);
  END IF;
END $$;
