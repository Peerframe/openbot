-- Global Owner cleanup receipts have no channel lifetime or channel-scoped key.
-- Existing C21 per-channel receipts and deletion/recovery records remain unchanged.
CREATE TABLE storage_cleanup_receipts (
  request_key text PRIMARY KEY CHECK (request_key ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'),
  response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object' AND octet_length(response::text) <= 262144),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
