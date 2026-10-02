-- Minimal deletion and request receipts survive removal of the original file metadata.
CREATE TABLE attachment_purges (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'),
  channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  operation_id text NOT NULL,
  freed_bytes integer NOT NULL CHECK (freed_bytes >= 0),
  purged_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX attachment_purges_operation_idx ON attachment_purges(operation_id);
--> statement-breakpoint
CREATE TABLE attachment_cleanup_receipts (
  channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  request_key text NOT NULL CHECK (request_key ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'),
  response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object' AND octet_length(response::text) <= 262144),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(channel_id, request_key)
);
--> statement-breakpoint
CREATE TABLE owner_storage_settings (
  owner_id text PRIMARY KEY CHECK (owner_id = 'owner'),
  trash_auto_purge_days smallint CHECK (trash_auto_purge_days IS NULL OR trash_auto_purge_days = 30),
  revision integer NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 2147483647),
  last_auto_purge_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO owner_storage_settings(owner_id) VALUES('owner');
--> statement-breakpoint
-- Final SHARE locks serialize all writers. VOLATILE obtains a fresh receipt snapshot even for a
-- statement that waited on those locks; late/non-admission writers cannot resurrect a reference.
CREATE FUNCTION refuse_purged_attachment_reference() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE body text;
BEGIN
  IF TG_TABLE_NAME = 'messages' THEN
    body := lower(NEW.content COLLATE "C");
  ELSE
    body := lower(NEW.instruction COLLATE "C");
  END IF;
  IF EXISTS (
    SELECT 1 FROM regexp_matches(body,
      '\[openbot attachment: ([0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12})\]', 'g') AS m(parts)
    JOIN public.attachment_purges p ON p.id = m.parts[1] AND p.channel_id = NEW.channel_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'attachment_purged',
      CONSTRAINT = 'attachment_purged_reference';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER messages_refuse_purged_attachment
BEFORE INSERT OR UPDATE OF content,channel_id ON messages
FOR EACH ROW EXECUTE FUNCTION refuse_purged_attachment_reference();
--> statement-breakpoint
CREATE TRIGGER runs_refuse_purged_attachment
BEFORE INSERT OR UPDATE OF instruction,channel_id ON runs
FOR EACH ROW EXECUTE FUNCTION refuse_purged_attachment_reference();
