# Research: optimistic Owner profile editing in Python

- Date: 2026-09-23
- Status: Implemented and independently verified locally.
- Baseline: 6b6dd9a; message-read slice is independently pending acceptance.

Extend the existing reviewed PostgreSQL 17.11/Psycopg 3.3.6 Owner transactions and Pydantic 2.13.5
input adapter; reuse source, release, tests, issues, platform and license decisions from
[identity transactions](python-identity-transactions.md) and [identity inputs](python-identity-inputs.md).
No dependency, migration or third-party source is added. Existing OpenBot profile mutation is the
compatibility source, not a generic ORM or a new employee subsystem.

Inspected updateEmployeeProfileDetailsInputSchema, EmployeeProfileDetailsMutationResult,
postgres-store.ts updateEmployeeProfileDetails/toEmployeeEvolutionEvent and its app PATCH route.
Only role and description are editable; expectedRevision is required. Unknown properties, null,
non-integral/unsafe/non-positive revisions and blank normalized roles fail. Zod accepts JSON 1.0
as integer 1, so Python must validate mathematical integers instead of accidentally rejecting every
float token. Existing ECMAScript trim and code-point bounds are reused. No name, profile, permission,
identity or credential change can pass through this route.

The shared Owner transaction holds the session SHARE lock. Lock the Bot, compare expected revision,
reject unchanged data, update role/description/revision/time, then commit the exact evolution and
run-event rows together. A stale revision is 409, missing Bot 404, unchanged input 422, storage
uncertainty 503. Preserve source order of changedFields (role then description). Do not retry a write
or overwrite a competing edit. Reuse statement timestamps truncated to milliseconds and strict Bot
projection; no private configuration is returned. Standard PostgreSQL row locks and the existing
revision predicate implement the compare-and-set, not an in-memory lock or new transaction protocol.

Acceptance: two simultaneous requests at one revision produce one accepted edit and one conflict;
DB and both audit tables reflect only the accepted update; an audit failure rolls back the profile;
revoked/expired Owner fails; no-change/missing Bot/status mapping and actual TS profile readback.
Input differential includes strict extra keys, explicit null and integral floating JSON numbers.

The aggregate GET profile includes skills/memory and task/approval/artifact projections. Preserve
that full contract in S2c after their projection services exist; do not return an invented empty
profile to make this PATCH endpoint seem complete. Realtime invalidation also remains S2c.

HTTP integration reuses one extracted Origin/session preflight across business routes; the database
transaction remains the actual authorization boundary. Profile JSON is limited to 32 KiB/five
seconds (covers 2160 astral characters even when JSON-escaped); existing routes retain 8 KiB.
The limit is trusted route configuration, never derived from request input.

Local acceptance: 316 final package tests pass; six new real-database cases bring the combined PG/HTTP suite to 35 passing cases;
24 new profile inputs bring the actual Zod/Python oracle to 105 agreeing cases. The explicit identity
process also patches a profile over HTTP, and the actual TS aggregate endpoint recognizes the
Python profile/revision/evolution. Full repository check passed. Package verification additionally
covers strict inputs, fixed errors and maximum Unicode body sizes. Hosted CI and production selection
remain unverified and unchanged.
