# Research: Worker cancellation and interrupted approvals

- Status: Accepted for implementation
- Date: 2026-09-23
- Owner: OpenBot maintainers
- Related issue: B1b
- Acceptance journey: an authenticated Owner stops an actual Worker Run; PostgreSQL records the
  terminal decision before an enrolled Node receives cancellation; pending review cannot later
  authorize a click, and an already sent effect remains explicitly uncertain.
- Security boundary: Server owns Run and approval state. Workers and Providers are untrusted;
  cooperative abort and transport delivery do not prove rollback or external non-execution.

## Search evidence

- GitHub searches on 2026-09-23: `repo:websockets/ws terminate close buffered send cancellation issue`,
  `repo:porsager/postgres begin transaction rollback concurrent queries test`.
- Reviewed PostgreSQL 17 [locking](https://www.postgresql.org/docs/17/explicit-locking.html) and
  [isolation](https://www.postgresql.org/docs/17/transaction-iso.html): conditional updates and one
  consistent Run-before-approval lock order, including cancellation and decision transactions.
- Inspected PostgreSQL REL_17_11 / `083ac033419f690758508e08c1736089384bbee8`, isolation test
  `src/test/isolation/specs/deadlock-simple.spec` and COPYRIGHT. Retain current Drizzle 0.45.2 /
  `e7dfa14519f363229ccc3ead7b1b2f2051937efb` adapter (prior database review); no migration needed.
- Inspected ws 8.21.3 release, `lib/websocket.js` send/close/terminate, `test/websocket.test.js`
  close-before-open/closed-send/termination tests and MIT LICENSE. Reviewed
  [issue 2137](https://github.com/websockets/ws/issues/2137): server close is not proof that all
  client sockets or work have stopped. Keep authenticated connection identity and existing cancel
  messages; a successful send is not an application acknowledgement.
- Inspected Postgres.js v3.4.9 release, `src/index.js` begin/savepoint/rollback and `tests/index.js`
  rollback/commit-error tests, UNLICENSE; reviewed
  [issue 1082](https://github.com/porsager/postgres/issues/1082) about an unsettled pipeline on
  validation failure. Keep sequential transaction steps rather than abandoning concurrent writes.
- Existing baseline `418d0e6`: OPEN_SOURCE_REUSE entries for native cancellation, Node identity,
  PostgreSQL, controlled browser and conformance; ADR-0045 Proposed lease design; current Worker
  protocol, Node client, run dispatcher/store, channel-member removal and B1a synthetic fixture.
- Node AbortController is cooperative. Existing Provider checks signals before/after review and
  HTTP requests; pending listeners must also reject an already-aborted signal. No process kill or
  remote undo is inferred from abort.

## Candidate comparison

| Candidate | Exact release/commit | License | Maintenance/tests/platform fit | Decision |
| --- | --- | --- | --- | --- |
| PostgreSQL conditional transactions via existing Drizzle/Postgres.js | PG 17.11 / `083ac033419f690758508e08c1736089384bbee8`; Drizzle 0.45.2; Postgres.js 3.4.9 | PostgreSQL; Apache-2.0; Unlicense | Maintained releases, isolation/rollback tests; durable authority already resides here | First viable standard + released dependencies; reuse |
| Existing authenticated WebSocket + cooperative Node cancellation | ws 8.21.3; OpenBot `418d0e6` | MIT | Existing close/send tests, Node abort and Provider pre-commit checks; supported Node platforms | Thin adapter, no new protocol/dependency |
| Full signed capability lease | ADR-0045 at `418d0e6`, Proposed; jose 6.2.12 selected there | MIT | Separate issue/consume/revoke/key lifecycle and adversarial replay scope | Not required to revoke existing Server authority; do not claim its stronger commit boundary |
| Another workflow/cancellation service | Not selected | Not applicable | Would add a second authority without proving remote rollback | No dependency needed after first viable option |

## Reuse decision

- Keep `POST /runs/:runId/cancel`, Owner authentication, trusted mutation Origin and strict empty
  body. Native cancellation retains descendant handling. Worker queued/assigned/running/waiting
  cancellation is durable and idempotent; completed/failed/blocked results are not overwritten.
- Reuse `pending -> expired` for invalidation, already used by channel-member removal. Audit the
  fixed cancellation/disconnection reason; preserve approved/rejected history. Run and approval
  changes commit together, Run lock first. Do not forge an Owner rejection or automatic reapproval.
- Serialize Worker Owner commands and protocol messages per Run. Suppress stale approved delivery
  after cancellation, and serialize/gate same-Node lifecycle reconciliation before new assignment.
  Conditional database predicates remain authoritative against independent concurrent callers.
- Interrupted running/waiting Runs fail without replay on disconnect/restart; invalidate only
  pending approvals. Node keeps cancelled execution occupancy until Provider cleanup settles.
- A sent action may already have occurred. Cancellation stops accepting future Run results; it is
  not proof of remote undo. Keep controlled-browser origin opt-in and existing single-Provider Bot
  exclusion. No JWT/keyring/lease table, general browser capability or distributed lock is added.
- Exit plan: future accepted leases can attach revoke/consume to these transactions, retaining
  conditional terminal-state guards and historical Owner decisions.

## Source incorporation

No upstream source copied or substantially adapted. Existing dependency notices remain unchanged.

## Verification plan

- Real PostgreSQL: cancel/approve, cancel/complete, cancel/assign/start races; repeated cancel;
  transaction failure rollback; pending approval invalidation on disconnect/restart; completed Run
  and existing artifacts remain intact. No tests against personal databases.
- Dispatcher and Node: delayed approval delivery, stale socket/lifecycle ordering, late results,
  no leftover artifacts after rejected completion, cleanup occupancy, already-aborted waiters.
- Actual B1a Server/Node/Provider suite: Owner cancellation, zero clicks when cancellation wins
  before approval, immediate pending-Run failure on disconnect, one possible click after dispatch
  with no retry, and cleanup/exclusion. Synthetic local computer only, not native browser proof.
- HTTP/UI: authentication, Origin, malformed/extra body, 404/409, Worker stop without a new retry
  affordance; preserve Native task controls. Focused tests and `npm run check`; bilingual docs.

## Unresolved questions

- No remote cancellation acknowledgement or proof of external rollback exists. Multi-Server command
  ownership and capability lease implementation remain separate; no stronger support claim.
