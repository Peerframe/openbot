-- Existing histories remain bound to Python throughout the P4 drain. A new owner must
-- be selected at admission creation, never by adopting or replaying an existing history.
ALTER TABLE work_admissions ADD COLUMN execution_owner text NOT NULL DEFAULT 'python-v1'
  CHECK (execution_owner IN ('python-v1', 'typescript-v1'));
--> statement-breakpoint
CREATE FUNCTION preserve_work_execution_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_owner IS DISTINCT FROM OLD.execution_owner THEN
    RAISE EXCEPTION 'work_execution_owner_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER work_execution_owner_immutable BEFORE UPDATE ON work_admissions
  FOR EACH ROW EXECUTE FUNCTION preserve_work_execution_owner();
