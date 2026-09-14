-- Preserve all existing outcomes and rows while exposing an actionable stopped-schedule reason.
ALTER TABLE automations DROP CONSTRAINT automations_last_outcome_check;
ALTER TABLE automations ADD CONSTRAINT automations_outcome_valid
  CHECK (last_outcome IN ('submitted', 'skipped_active', 'target_unavailable', 'attachment_unavailable'));
