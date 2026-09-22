-- Synthetic, public regression data for the 0018_automations schema. No credentials.
INSERT INTO channels (id, name, description, created_at, updated_at)
VALUES ('upgrade-channel', 'Retained upgrade fixture', 'Synthetic old channel', '2026-09-01Z', '2026-09-02Z');
INSERT INTO bots (id, name, role, description, configuration, profile_revision, created_at, updated_at)
VALUES ('upgrade-bot', 'Retained Employee', 'Researcher', 'Portable template description',
  '{"appearance":{"head":"cat","body":"classic","mobility":"feet","accessory":"headphones","accent":"blue"}}',
  3, '2026-09-01Z', '2026-09-02Z');
INSERT INTO channel_bots (channel_id, bot_id, joined_at)
VALUES ('upgrade-channel', 'upgrade-bot', '2026-09-02Z');
INSERT INTO nodes (id, name, platform, created_at, updated_at)
VALUES ('upgrade-node', 'Synthetic offline Node', 'linux', '2026-09-01Z', '2026-09-02Z');
INSERT INTO messages (id, channel_id, author_type, content, created_at)
VALUES ('upgrade-message', 'upgrade-channel', 'human', 'Synthetic retained request', '2026-09-02Z');
INSERT INTO runs (id, channel_id, bot_id, title, instruction, status, source_message_id, created_at, updated_at)
VALUES ('upgrade-run', 'upgrade-channel', 'upgrade-bot', 'Retained report', 'Create a synthetic report',
  'completed', 'upgrade-message', '2026-09-02Z', '2026-09-03Z');
INSERT INTO artifacts (id, run_id, name, media_type, storage_key, sha256, created_at)
VALUES ('upgrade-artifact', 'upgrade-run', 'Synthetic report.txt', 'text/plain', 'fixture/report.txt',
  repeat('a', 64), '2026-09-03Z');
INSERT INTO approvals (id, run_id, node_id, action, target, summary, risk, target_fingerprint, status, expires_at, created_at)
VALUES ('upgrade-approval', 'upgrade-run', 'upgrade-node', 'synthetic.read', 'fixture', 'Synthetic approval',
  'write', repeat('d', 64), 'pending', '2026-10-01Z', '2026-09-02Z');
INSERT INTO run_events (id, run_id, channel_id, bot_id, type, payload, created_at)
VALUES ('upgrade-audit', 'upgrade-run', 'upgrade-channel', 'upgrade-bot', 'RUN_COMPLETED',
  '{"fixture":true}', '2026-09-03Z');
INSERT INTO employee_evolution_events (id, bot_id, type, title, summary, source, evidence, created_at)
VALUES ('upgrade-evolution', 'upgrade-bot', 'imported', 'Synthetic import', 'Retain the portable profile',
  'import', '[{"kind":"fixture"}]', '2026-09-01Z');
INSERT INTO skills (id, slug, name, version, source, metadata, created_at, updated_at)
VALUES ('upgrade-skill', 'synthetic-research', 'Synthetic research', '1.0.0', 'imported',
  '{"template":true}', '2026-09-01Z', '2026-09-02Z');
INSERT INTO employee_skills (bot_id, skill_id, state, confidence, evidence, source, acquired_at, updated_at)
VALUES ('upgrade-bot', 'upgrade-skill', 'verified', 80, '[{"kind":"fixture"}]', 'imported', '2026-09-01Z', '2026-09-02Z');
INSERT INTO employee_memories (id, bot_id, kind, title, content, sensitivity, portability, provenance, revision, created_at, updated_at)
VALUES ('upgrade-memory', 'upgrade-bot', 'semantic', 'Synthetic preference', 'Cite primary sources',
  'internal', 'owner-selectable', '{"source":"synthetic"}', 2, '2026-09-01Z', '2026-09-02Z'),
  ('upgrade-restricted-memory', 'upgrade-bot', 'secret-reference', 'Synthetic reference', 'Not a secret',
  'restricted', 'never', '{"source":"synthetic"}', 1, '2026-09-01Z', '2026-09-02Z');
INSERT INTO employee_import_receipts (id, package_id, package_digest, employee_id, idempotency_key,
  request_fingerprint, signature_status, reviewed_by, reviewed_at, imported_skill_count, created_at)
VALUES ('upgrade-receipt', 'upgrade-package', repeat('b', 64), 'upgrade-bot', 'upgrade-import',
  repeat('c', 64), 'unsigned', 'owner', '2026-09-01Z', 1, '2026-09-01Z');
INSERT INTO automations (id, name, channel_id, bot_id, prompt, interval_minutes, enabled,
  next_run_at, last_run_at, last_run_id, last_outcome, created_at, updated_at)
SELECT 'upgrade-automation-' || outcome, 'Synthetic ' || outcome, 'upgrade-channel', 'upgrade-bot',
  'Review synthetic sources', 60, outcome <> 'target_unavailable', '2026-10-01Z', '2026-09-03Z',
  'upgrade-run', outcome, '2026-09-01Z', '2026-09-03Z'
FROM unnest(ARRAY['submitted', 'skipped_active', 'target_unavailable']) AS outcome;
