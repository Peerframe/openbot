# Native Task capability provenance — pre-implementation review

Date: 2026-09-25. Status: approved design implemented in two mergeable packets. No dependency install.

Reviewed local candidate HEAD 482bdc5bea56c5b1a996492701b6dbb012d5691e and its current uncommitted
work_task_profiles, reads, runtime, collaboration, media, knowledge, plugins/web, OwnerFiles,
Work API/store, migrations0020/0038/0039 and WORK_EXECUTION_CONTRACT. The reuse ledger already
accepts the relevant Python product ports and points to python-work-task-profiles,
python-work-collaboration, python-work-product-reads, python-work-knowledge-runtime,
python-work-product-model, python-work-product-web and work-product-media.

Reuse pins and their prior source/releases/tests/issues/security/license reviews: PostgreSQL17.11
(PostgreSQL License), Psycopg3.3.6 (LGPL-3.0), Temporal Python1.33.0 (MIT), Pydantic AI2.47.0 (MIT),
plus the existing exact model/MCP/parser adapters recorded in those reviews. No new dependency,
framework, provider client, local learning algorithm or copied third-party source is selected.
OpenBot's MIT ports are adapted locally; preserve all existing upstream notices and Hermes
learning attribution. Security boundary: Owner transaction creates scope; model/tools propose;
current Server checks and Action approval remain authoritative.

Primary documentation rechecked:
- https://www.postgresql.org/docs/17/ddl-constraints.html: use real FKs/unique indexes and exact
  nullable source alternatives; CHECK constraints cannot safely validate other mutable rows.
- https://www.postgresql.org/docs/17/explicit-locking.html: retain ordered row/transaction locks
  for access revocation and concurrent admission; constraints do not substitute for authority.
- https://github.com/postgres/postgres/blob/REL_17_11/src/test/regress/sql/foreign_key.sql:
  exact pinned upstream regression source requested; browser returned an internal error, so no
  new inspection claim is made. Existing project's pinned PostgreSQL review remains the source
  for upstream test/release qualification; actual proposed constraints will be exercised locally.

Alternatives: (1) capability catalog toggles fail because actual adapters and FKs require a
channel; (2) fake channels/legacy Runs break accepted identity and attribution; (3) a parallel
Task execution/knowledge/attachment service duplicates authority, recovery and review. The first
viable choice is the existing released stack with narrow OpenBot source-discriminated adapters
and native grant records. The concrete gap is OpenBot-specific Owner scope/provenance, not a
missing generic Agent framework. No unrelated upstream candidate or dependency expansion is
needed for this extension.

Root approved the fixed single-Owner asset namespace and source union migration, reserved as
0040_native_task_scope.sql. Only the new independent native_scope database was used; shared
test fixtures and the provided VPS were not accessed.

## Implemented source-specific gap

The existing adapters now discriminate channel/native Work provenance through the shared profile
resolver. Native knowledge retains current digest/revision/review checks and records real Work
proposal origins. A private v2 target adds native profile/scope provenance; exact legacy v1 target
serialization and decoding remain compatible. Native collaboration reuses root deadline/waiting/
unknown mechanisms, adds a root-native advisory lock before root-to-leaf Tasks, and uses bounded
Work Task/Run child records with narrowing source scope. Original cascade and Workflow code are
unchanged. No alternative scheduler, background loop, connector, search or learning framework.

Database constraints were exercised on the independently owned native_scope fixture. The exact
0040 SQL bytes matched root before recording its already-applied hash as canonical journal41;
DDL was not repeated and no shared fixture was modified. Official SDK ActivityEnvironment/MCP
HTTP were used with synthetic data/providers. UI and actual Temporal/Linux qualification belong
to the integration owner; tests here do not claim those journeys.

Concurrency detail: native proposal review and completion acquire Task then Bot capacity then
knowledge rows. Consuming an already accepted native memory holds the linked proposal row as
the source-deletion CASCADE barrier, then reads the terminal Task/Run without another Task lock.
Terminal tasks cannot be reopened by the product. This preserves deletion exclusion without
inverting current Task/Bot locks against a concurrent Owner review of the old source Task.
A real two-transaction regression checks that lock interaction.

## Integrated actual native product journey

The independent native HTTP/PostgreSQL/mTLS fixture passed real parent/child Work execution,
narrowing source grants,10 synthetic model HTTP phases, attachment and child observations,
192-byte report publication/download, pending native knowledge proposal and explicit Owner
acceptance with modelUse=false. SQL publication committed immediately before killing the API
Worker; recovery used the same engine Run and original records, with provider calls forbidden.
No legacy channel/Run was fabricated. Two sanitized actual histories replayed with the official
SDK and no registered Activities; root reran those replays after integration.

Portable source, exact assertions and safe evidence are in
[the native capability journey](../../experiments/work-journey/native-capabilities/README.md).
This qualifies real product orchestration and recovery with a synthetic model transport;
separate live Kimi and Linux/browser tests must not inherit a positive result from it.
