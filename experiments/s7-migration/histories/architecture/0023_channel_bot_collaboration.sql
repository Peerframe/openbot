ALTER TABLE runs ADD COLUMN parent_run_id text REFERENCES runs(id);
ALTER TABLE runs ADD COLUMN root_run_id text REFERENCES runs(id);
ALTER TABLE runs ADD COLUMN delegated_by_bot_id text REFERENCES bots(id);
ALTER TABLE runs ADD CONSTRAINT runs_delegation_shape CHECK (
  (parent_run_id IS NULL AND root_run_id IS NULL AND delegated_by_bot_id IS NULL)
  OR (parent_run_id IS NOT NULL AND root_run_id IS NOT NULL AND delegated_by_bot_id IS NOT NULL
      AND parent_run_id <> id AND root_run_id <> id AND execution_profile = 'none' AND node_id IS NULL)
);
CREATE INDEX runs_root_idx ON runs(root_run_id);
CREATE INDEX runs_parent_idx ON runs(parent_run_id);
