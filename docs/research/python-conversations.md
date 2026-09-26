# Research: direct conversations and membership joins in Python

- Date: 2026-09-23
- Status: Accepted and locally verified.
- Baseline: fad7ded, including the accepted identity transactions and input oracle.

Reuse PostgreSQL 17.11 row locks/constraints and Psycopg 3.3.6 transactions/Jsonb from
[the identity review](python-identity-transactions.md), with the same tested Owner session SHARE
lock and final expiry check. No new dependencies or schema migrations. Upstream source, releases,
known platform limits, issues and license decisions remain those pinned there. The narrow shared
OwnerTransactions context only consolidates that accepted authorization/commit behavior; it does
not acquire a new authority or become a model tool.

Inspected existing postgres-store.ts getOrCreateDirectConversation and joinBotToChannel, app.ts,
channel-interactions-store.ts, postgres-task-submission.ts and migration 0022 at the baseline.
Keep direct-conversation singleton creation under a Bot FOR UPDATE lock; reuse its unique direct
Bot index and exact two initial audit rows. A repeated request returns the existing channel.
Joining locks the ordinary channel, verifies/locks the Bot, inserts with ON CONFLICT DO NOTHING,
and adds an audit event only for a newly inserted member. Direct membership is immutable.

A shared transaction context is preferred to copying session/timeout/revocation code into each
new module. The context validates the cookie shape, holds session SHARE through commit, rechecks
expiry before completion and provides bounded parameterized SQL execution through the driver.
Error-to-HTTP mapping remains an adapter responsibility. This is a structural extraction of existing
OpenBot code, not copied upstream source; its nineteen real integration regressions must still pass.

Only direct creation/retrieval and member join are in this slice. Membership removal is intentionally
coupled to S2b: existing code cancels descendant tasks and pending approvals under advisory lock 731.
Message submission also belongs with S2b because it atomically creates routing decisions and runs.
Message reads may move separately with explicit bounded projections. No new realtime protocol yet.

Acceptance: concurrent direct requests produce one channel and two initial audit events; missing
Bot/channel errors are preserved; duplicate joins do not duplicate events; direct channels reject
join; audit failure rolls back both channel and member changes; revoked/expired sessions cannot
write; responses are projected through the existing TS reader. No private database or credentials.

Implementation evidence: 275 package tests, 81 Zod/Python input comparisons and 24 combined real
PostgreSQL/HTTP checks pass. The five new database cases exercise concurrent creation/joins,
revocation/rejection, audit rollback and refusal to repair malformed direct membership; the existing
explicit-process test now includes both conversation routes over loopback HTTP. TypeScript reads
the Python-created private channel identically. Hosted CI and production selection remain separate.
