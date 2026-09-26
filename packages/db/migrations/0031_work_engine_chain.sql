-- A Workflow ID can be reused after history retention. Bind accepted work to the
-- engine's first execution Run ID, stable across Continue-As-New within one chain.
-- Historical acknowledgements remain nullable and must be reverified before use.
ALTER TABLE work_admissions ADD COLUMN engine_first_run_id text;
--> statement-breakpoint
ALTER TABLE work_admissions ADD CONSTRAINT work_admissions_engine_first_run_id_check
  CHECK (engine_first_run_id IS NULL OR
         (state = 'acknowledged' AND octet_length(engine_first_run_id) BETWEEN 1 AND 128));
