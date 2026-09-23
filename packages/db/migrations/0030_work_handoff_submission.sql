-- The first engine submission attempt is a durable fact, distinct from verified acceptance.
-- A lost response must be inspected, never blindly submitted again after history retention.
ALTER TABLE work_admissions ADD COLUMN submission_reference text;
--> statement-breakpoint
ALTER TABLE work_admissions ADD COLUMN submission_attempted_at timestamptz;
--> statement-breakpoint
ALTER TABLE work_admissions ADD CONSTRAINT work_admissions_submission_pair_check
  CHECK ((submission_reference IS NULL) = (submission_attempted_at IS NULL));
--> statement-breakpoint
ALTER TABLE work_admissions ADD CONSTRAINT work_admissions_submission_reference_check
  CHECK (submission_reference IS NULL OR octet_length(submission_reference) BETWEEN 1 AND 256);
--> statement-breakpoint
ALTER TABLE work_admissions ADD CONSTRAINT work_admissions_verified_reference_check
  CHECK (state <> 'acknowledged' OR submission_reference IS NULL OR
         submission_reference = engine_reference);
--> statement-breakpoint
CREATE INDEX work_admissions_unconfirmed_idx
  ON work_admissions(submission_attempted_at,run_id)
  WHERE state='pending' AND submission_attempted_at IS NOT NULL;
