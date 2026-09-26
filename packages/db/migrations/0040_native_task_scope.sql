-- Explicit Owner-native grants. Existing Tasks and channel sources are never backfilled.
CREATE TABLE work_task_scopes (
  task_id text PRIMARY KEY REFERENCES work_task_profiles(task_id) ON DELETE CASCADE,
  scope jsonb NOT NULL CHECK (jsonb_typeof(scope)='object' AND octet_length(scope::text)<=20000),
  scope_digest text NOT NULL CHECK (scope_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
-- Channel rows retain real legacy Run/Message provenance; native rows use only Work identities.
ALTER TABLE work_collaborations ADD COLUMN source_kind text NOT NULL DEFAULT 'channel';
ALTER TABLE work_collaborations ALTER COLUMN child_source_run_id DROP NOT NULL;
ALTER TABLE work_collaborations ALTER COLUMN assignment_message_id DROP NOT NULL;
ALTER TABLE work_collaborations ADD CONSTRAINT work_collaboration_source_shape CHECK (
  (source_kind='channel' AND child_source_run_id IS NOT NULL AND assignment_message_id IS NOT NULL)
  OR (source_kind='task' AND child_source_run_id IS NULL AND assignment_message_id IS NULL)
);
--> statement-breakpoint
ALTER TABLE knowledge_proposals ADD COLUMN source_kind text NOT NULL DEFAULT 'channel';
ALTER TABLE knowledge_proposals ADD COLUMN source_work_run_id text REFERENCES work_runs(id) ON DELETE CASCADE;
ALTER TABLE knowledge_proposals ALTER COLUMN source_run_id DROP NOT NULL;
ALTER TABLE knowledge_proposals ADD CONSTRAINT knowledge_proposal_source_shape CHECK (
  (source_kind='channel' AND source_run_id IS NOT NULL AND source_work_run_id IS NULL)
  OR (source_kind='task' AND source_run_id IS NULL AND source_work_run_id IS NOT NULL)
);
CREATE UNIQUE INDEX knowledge_proposals_work_run_idx ON knowledge_proposals(source_work_run_id);
