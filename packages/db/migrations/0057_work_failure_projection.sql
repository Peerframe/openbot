-- Read-only error classification; keep the view's columns, owner and privileges.
-- No Work/Run/history rows are rewritten. Historical or unrecognized failures retain task_failed.
-- Only the current Work Run's control-owned, allowlisted public code can change its projection.
-- Older builds refuse the newer migration history; retain the existing pre-upgrade recovery set.
CREATE OR REPLACE VIEW runs_work_projection AS
SELECT r.id,r.parent_run_id,r.root_run_id,r.delegated_by_bot_id,r.channel_id,r.bot_id,
  r.source_message_id,r.node_id,r.execution_profile,r.instruction,r.title,
  CASE WHEN t.id IS NULL THEN r.status
       WHEN t.status IN ('completed','cancelled','failed') THEN t.status
       WHEN t.cancel_requested OR NOT t.authority_active OR EXISTS (
         SELECT 1 FROM work_actions a WHERE a.task_id=t.id AND a.status='unknown') THEN 'blocked'
       WHEN EXISTS (SELECT 1 FROM work_actions a WHERE a.task_id=t.id AND a.status='proposed'
         AND a.decision='pending') THEN 'waiting_approval'
       WHEN t.status='queued' THEN 'queued' ELSE 'running' END AS status,
  CASE WHEN t.id IS NULL THEN r.result_summary ELSE t.result_summary END AS result_summary,
  CASE WHEN t.id IS NULL THEN r.error_message WHEN t.status='failed' THEN
    CASE WHEN f.public_code='model_unavailable' THEN
      'No usable model is configured for this task. Check the Bot model and enabled connection in Settings.'
    ELSE 'Task execution failed.' END END AS error_message,
  CASE WHEN t.id IS NULL THEN r.error_code WHEN t.status='failed' THEN
    CASE WHEN f.public_code='model_unavailable' THEN 'model_unavailable' ELSE 'task_failed' END END AS error_code,
  r.model_usage,r.model_selection,r.created_at,
  CASE WHEN t.id IS NULL THEN r.updated_at ELSE coalesce(e.created_at,t.created_at) END AS updated_at,
  t.id AS work_task_id
FROM runs r LEFT JOIN work_sources s ON s.legacy_run_id=r.id
LEFT JOIN work_tasks t ON t.id=s.task_id
LEFT JOIN LATERAL (SELECT created_at FROM work_events WHERE task_id=t.id ORDER BY revision DESC LIMIT 1) e ON true
LEFT JOIN LATERAL (
  SELECT payload->>'publicCode' AS public_code FROM work_events
  WHERE task_id=t.id AND kind='task.failed'
    AND payload->>'runId'=(SELECT id FROM work_runs WHERE task_id=t.id ORDER BY ordinal DESC LIMIT 1)
  ORDER BY revision DESC LIMIT 1
) f ON true;
