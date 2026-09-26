# Research: authoritative Work-bound knowledge read adapter

Status: accepted narrow adapter, 2026-09-25. No new dependency or retrieval framework.
Employee learning/provenance remains inspired by Hermes Agent.

## Reviewed inputs and first viable reuse

- Accepted offline S5 selection `df1c24d`, integrated unchanged as `ace87c8`:
  `experiments/s5-memory-skills/selection_port.py`, `study.py`, `SELECTION_PORT.md`,
  `docs/research/s5-memory-skills.md`, and migration/reuse ledgers.
- Existing product algorithms: `apps/server/src/postgres-agent-store.ts::knowledge`,
  `postgres-agent-skills.ts::{skillCatalog,readSkillDocument,assertSkillReferences}`,
  `native-agent.ts` read_skill/read_employee_memory/propose_memory; the reviewed decisions in
  `docs/research/agent-reviewed-knowledge.md` and `reviewed-skill-content.md` remain applicable.
- Python authority and schema: `employee_knowledge.py`, `execution_values.py`, `skill_yaml.py`,
  `work_sources.py`, `work_store.py`, `work_claims.py`, `work_completion.py`, migrations
  0011/0015/0020/0021/0027/0028/0036. Source code is existing OpenBot MIT code.
- Previous primary review pins are retained: Hermes Agent
  `63279301bcbdc185c1b07b98a9312eb0c862f26d` (MIT), Agent Skills
  `69ef37e9424c0a7ea9dd2293b559e43ec8176379` (Apache-2.0 code/CC-BY-4.0 docs),
  PostgreSQL 17 row locking https://www.postgresql.org/docs/17/explicit-locking.html.
  No upstream source is copied, dependency added, live model called, or claim of held-out model
  improvement made. No repeat broad upstream research is needed to reuse these accepted choices.

The released PostgreSQL/psycopg stack and existing bounded product selection are the first viable
option. The gap is actual Work/source identity binding, immutable descriptive receipts and fresh
serialized record checks. The offline CSV vocabulary and synthetic workspace/task-kind/Artifact
facts are not product scope fields and are not installed as a general-purpose retrieval algorithm.
Products retain recent updatedAt/id selection (eight memories/eight metadata skill descriptors),
not semantic ranking. S5's typed selection/revalidation contract is retained with real facts.

## Scope and authority

A trusted context names Task, Work Run, Bot and source Channel but grants no authority. Every read
requires a composition-supplied fresh binding gate for the accepted Temporal Activity and the
actual SQL source/Task/Run/current-membership checks. No gate, mapping, running Work Run, current
Task authority or matching employee means refusal. Do not inspect legacy source Run status as a
second scheduler: `work_sources` maps immutable compatibility provenance and Work owns lifecycle.

Lock order matches `work_sources.lock_source`: read immutable mapping without a row lock, lock
Channel FOR KEY SHARE, source Run FOR KEY SHARE, Work Task, Work Run, then membership. Never lock
work_sources first. Record SHARE locks are held through in-transaction freshness checks. Root
must invoke the check in the same transaction as context transmission admission/publication;
a detached receipt or an earlier check does not authorize later use.

Employee knowledge has existing Bot scope, not synthetic workspace/task-kind columns. Owner
opt-in is explicit cross-channel Employee knowledge; the target source Channel must currently
contain that Bot. Reviewed proposal provenance is checked against a current matching completed
source Run/Work projection and its accepted proposal; Owner-created records need no invented
Artifact. Skills must be verified at the current assignment revision, digest-reviewed, parseable
with the shared parser and consistent metadata, with no capability requirements or dependencies
(the existing executable-model subset). Metadata never grants missing tool/file permissions.

Task authority_generation and Work Run execution_epoch are the freshness revision for receipts:
ordinary Work audit/budget events increment task.revision and must not invalidate knowledge by
accident. Corrections/revocation advance authority_generation; new execution attempts advance
epoch. Receipts also bind exact source mapping, query hash, record revisions, full-content and
provenance fingerprints. Disable/resume therefore cannot resurrect a consumed old revision.
No skill/lesson relation is fabricated when the existing product schema has none.

Runtime proposals remain validated drafts. The explicit `proposal_for_completion_in_transaction`
callback returns a freshly validated candidate and actual legacy source Run ID while Work is still
active. Root inserts the pending knowledge_proposals row only after its verified success update in
that same transaction. This packet never writes a Work terminal state, pending proposal or approved
employee_memories. Existing Owner review remains sole activation authority. Root must preserve one
proposal per source Run and 50 pending proposals per Bot. Root takes its Bot capacity lock before
knowledge record locks to avoid reversing the Owner skill-state mutation lock order.

## Acceptance plan

Use the dedicated synthetic PostgreSQL fixture upgraded through0036. Exercise real Owner skill/
memory opt-in, scope mismatch/absence, active authority and attempt changes, digest/revision/
content/provenance/deletion/suspension and source disappearance, bound/truncation, locking against
revocation, actual Work completion followed by explicit fixture insertion and Owner review. Atomic successful
completion insertion, idempotency and the pending cap remain root integration acceptance items.
Expose explicit same-transaction methods for root integration; do not register HTTP/Temporal or
mock a Work binding as product success.

## Integration: transfer between accepted Activities

The actual Temporal composition advances the claim epoch for each new Activity, including the
next model step and publication. A consumed receipt cannot be reused unchanged across those
epochs. Add an explicit private carry-forward method, leaving ordinary target equality strict:
first validate the current accepted Activity in the caller's transaction; require identical
Task/Run/Bot/Channel, source Run/message and authority generation; require a real prior claim epoch
no greater than the current one; then rebind the typed receipt and recheck every content/version
fingerprint under current row locks. Corrections, revocation, source changes or stale Activity
bindings still refuse transfer. Prepared proposals use the same transfer checks and retain their
validated draft fingerprint. No public receipt deserializer or new permission is introduced.

To avoid a nested transaction waiting on its own Task lock, the existing engine binding gate gets
an in-transaction entry that reuses its exact facts/acknowledgement checks. Only actual SDK/start
history supplies these facts. This is transaction composition, not a second binding algorithm.
