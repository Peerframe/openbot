-- The submission reference names the engine Workflow; the attempt identifier proves which
-- reserved start input owned it. A fresh 128-bit random value is persisted with the reference
-- before the only high-level start, so an unknown response, a duplicate-ID collision or a later
-- same-ID chain after history retention cannot be mistaken for the reserved attempt.
-- Historical rows stay NULL: they are never backfilled and never authorize a start.
ALTER TABLE work_admissions ADD COLUMN submission_attempt_id text;
--> statement-breakpoint
ALTER TABLE work_admissions ADD CONSTRAINT work_admissions_submission_attempt_pair_check
  CHECK (submission_attempt_id IS NULL OR submission_reference IS NOT NULL);
--> statement-breakpoint
ALTER TABLE work_admissions ADD CONSTRAINT work_admissions_submission_attempt_id_check
  CHECK (submission_attempt_id IS NULL OR submission_attempt_id ~ '^[0-9a-f]{32}$');
