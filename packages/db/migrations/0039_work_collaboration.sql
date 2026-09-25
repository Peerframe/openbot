-- OpenBot MIT source adaptation: durable local collaboration uses existing Work ingress.
ALTER TABLE runs DROP CONSTRAINT runs_delegation_shape;
ALTER TABLE runs ADD CONSTRAINT runs_delegation_shape CHECK (
  (parent_run_id IS NULL AND root_run_id IS NULL AND delegated_by_bot_id IS NULL)
  OR (parent_run_id IS NOT NULL AND root_run_id IS NOT NULL AND delegated_by_bot_id IS NOT NULL
      AND parent_run_id <> id AND root_run_id <> id AND execution_profile IN ('none','model') AND node_id IS NULL)
);
CREATE TABLE work_collaborations (
  creation_action_id text PRIMARY KEY REFERENCES work_actions(id),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  parent_task_id text NOT NULL REFERENCES work_tasks(id),
  parent_work_run_id text NOT NULL,
  child_task_id text NOT NULL UNIQUE REFERENCES work_tasks(id),
  child_work_run_id text NOT NULL UNIQUE,
  child_source_run_id text NOT NULL UNIQUE REFERENCES runs(id),
  root_task_id text NOT NULL REFERENCES work_tasks(id),
  root_work_run_id text NOT NULL,
  assignment_message_id text NOT NULL UNIQUE REFERENCES messages(id),
  depth integer NOT NULL CHECK(depth BETWEEN 1 AND 2),
  deadline_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(parent_task_id <> child_task_id AND root_task_id <> child_task_id),
  FOREIGN KEY(parent_task_id,parent_work_run_id) REFERENCES work_runs(task_id,id),
  FOREIGN KEY(child_task_id,child_work_run_id) REFERENCES work_runs(task_id,id),
  FOREIGN KEY(root_task_id,root_work_run_id) REFERENCES work_runs(task_id,id)
);
CREATE INDEX work_collaborations_parent_idx ON work_collaborations(parent_task_id);
CREATE INDEX work_collaborations_root_idx ON work_collaborations(root_task_id);
