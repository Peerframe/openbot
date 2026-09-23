# Python control-plane reference

[English](README.md) · [简体中文](README.zh-CN.md)

S2a and S2b-1 of the [migration plan](../../docs/ARCHITECTURE_MIGRATION_PLAN.md): Python/FastAPI reads
existing Owner sessions, Bots, channels and recent messages and can explicitly enable Owner login/logout against the
current PostgreSQL schema. This trusted control layer is separate from the untrusted Agent Runtime.
**The TypeScript Server remains the default.** Python starts read-only; explicit `owner-auth` mode
enables authentication, and `identity` mode adds Bot/channel creation, direct conversations, member joins and revision-checked profile edits. `tasks` adds atomic queued task submission. Task dispatch, approvals,
files, schedules and realtime events have not moved.

## Develop and verify

From this directory, with Python 3.12 available:

```sh
./scripts/bootstrap.sh
./scripts/check.sh -q
```

`OPENBOT_CONTROL_PYTHON` selects a trusted bootstrap interpreter. The accepted Agent Runtime venv
is separate. The lock contains 23 exact development pins; verification rejects missing, extra or
drifted distributions. This environment includes test tools, is not a production image, and never
installs dependencies on startup.

From the repository root, run the owned disposable database journey:

```sh
npm run test:control:python
```

The fixture builds the existing Server, owns a temporary loopback PostgreSQL 17.11 container,
applies the unchanged Node migration history, and uses synthetic credentials/Bots/channels. It
compares Python reads to the actual TypeScript API, including Unicode, multi-member and direct
channels. Legacy membership order is unspecified, so only member IDs are compared as sets; Python
returns them sorted. Other fixture fields match exactly. Both implementations recognize sessions
issued by the other, and revocation takes effect across implementations.

Forty-five database/HTTP checks cover reads, expiry/revocation, enforced read-only transactions, exact
schema history, invalid stored Bot status, concurrent persistent throttling, transactional auth
failure without a success cookie, and real loopback processes with bounded SIGTERM shutdown.
Identity checks also exercise exact audit/evolution payloads, missing members, concurrent name
conflicts, rollback on audit failure, revocation during a row-lock wait, expiry during audit waiting,
and real HTTP creation. Task cases cover multi-recipient atomicity, reply/member scope, concurrent source timestamps, audit rollback and bounded Run reads. An additional 60-case differential executes the actual TS and Python routing/Run projections. A separate 129-case input differential compares installed Zod against Python. Without the explicit fixture,
package checks skip the forty-five integration cases; skips are not acceptance. Two upstream test-client
deprecation warnings remain at the reviewed pins. The Linux CI job includes these checks; a hosted
run is separate evidence and has not yet run for this local change.

The fixture never uses `OPENBOT_DATABASE_URL`, dotenv, model credentials or a user database; it
removes only owned resources. These checks do not prove live-provider, browser or production behavior.

## Explicit local entry and authority

For a prepared compatible reference database, supply `OPENBOT_CONTROL_DATABASE_URL` and run
`.venv/bin/python -I scripts/serve.py`. It binds only `127.0.0.1`, uses port 3101 unless
`OPENBOT_CONTROL_PORT` (1–65535) is explicit, and disables forwarded-header trust/access logs.
It never runs migrations or reads dotenv. This is not a production cutover instruction.

| Setting | Meaning |
| --- | --- |
| `OPENBOT_CONTROL_AUTHORITY` | `read-only` by default; `owner-auth` enables login/logout; `identity` additionally enables Bot/channel creation, direct conversations, member joins and profile details; `tasks` adds queued submission |
| `OPENBOT_CONTROL_OWNER_PASSWORD` | Required for `owner-auth`, `identity` and `tasks`; 15–1024 Unicode characters, non-example value. The old Server password variable is not inherited |
| `OPENBOT_CONTROL_SESSION_TTL_HOURS` | Integer 1–168; default 12 |
| `OPENBOT_CONTROL_ALLOWED_ORIGINS` | Exact comma-separated HTTP(S) origins; defaults to localhost/127.0.0.1 at the configured port in auth mode. No wildcard or Host-header inference |
| `OPENBOT_CONTROL_COOKIE_MODE` | `secure` by default uses `__Host-openbot_session`; explicit `loopback` uses plain `openbot_session` for local fixtures. No cross-mode fallback |
| `OPENBOT_OWNER_NAME` | Public Owner display name; default `Owner` |

Auth writes require the configured Origin. Login JSON is bounded to 8 KiB and five seconds; errors
never echo credentials. Direct peer IP selects the existing five-attempt/five-minute PostgreSQL
bucket under the same transaction advisory lock as TypeScript. Forwarded IPs cannot reset it.
A proxy deployment is outside this slice. Tokens have 32 bytes of entropy; only SHA-256 digests are
stored. Login issues HttpOnly/SameSite=Strict/Path=/ cookies only after commit; logout revokes before
clearing. Storage uncertainty returns 503 without automatic retry or a success cookie.

Startup requires the exact SQL hash/timestamp history in `packages/db/migrations`; any other
history fails without repair. Reads use bounded read-only READ COMMITTED transactions and recheck
revocation. No private Bot configuration or credential digest is projected. Unauthenticated protected
reads return 401; unsupported mutations return 405. Projection ceilings are 1,000 Bots, 10,000
channel-member rows and 4 MiB JSON; exceeding them errors instead of truncating.

**Intentional legacy-data differences:** an illegal stored Bot status rejects the whole Python list
with 503, while legacy TypeScript can return the unchecked value. A malformed appearance such as
an array-valued enum is omitted; the old coercion could accept it. Python never repairs these rows.
Valid current-schema records match the paired fixture; this is not a claim of parity for corrupt data.
The database NOT NULL constraint prevents the old null timestamp fallback case.

Routes: `/health`, `/api/v1/auth/session`, `/api/v1/bots`, `/api/v1/channels`, plus
`/api/v1/auth/login` and `/api/v1/auth/logout` only in auth mode. `/openapi.json` describes the
selected routes; interactive docs are disabled. `identity` also enables POST `/api/v1/bots` and POST `/api/v1/channels` (201 with the existing
envelopes). Input defaults, trimming, Unicode code-point length, UUID spelling and pre-deduplication
member bounds match the installed Zod oracle. Explicit null is rejected where only omission is
allowed. The request body limit still applies before normalization.

Creation authenticates before input errors and rechecks the session under a PostgreSQL SHARE lock
in the write transaction. Identity, membership and durable audit/evolution rows commit together;
a later logout waits for that transaction, and a prior revocation or expiry rejects it. Name
conflicts return 409, missing members 422, uncertain storage 503 without automatic retry. Ordinary
channel names use the existing partial unique index, independently of direct-conversation names.
Selecting a computer profile does not grant any tool permission. No transient profile notification
or identity delete/dispatch endpoint is implemented in this slice. Complete client parity,
revisioned workspace snapshots and durable event cursors remain later S2 work.

Direct conversations use POST `/api/v1/bots/{bot_id}/conversation`; ordinary-channel joins use
POST `/api/v1/channels/{channel_id}/bots` with `{ "botId": "..." }`. Both return 200 with the existing
channel envelope. A Bot lock serializes private-channel creation; repeated joins add no duplicate
audit event. Missing identities return 404; direct membership changes return 422. Malformed existing
direct membership returns 503 without repair. These writers share the same Owner transaction
boundary. Five additional real-database cases cover concurrency, idempotence, rejection and rollback;
the explicit-entry process also exercises both routes over real HTTP. Membership removal remains with S2b cancellation and approvals; task submission is available in the separate `tasks` mode below.

Authenticated GET `/api/v1/channels/{channel_id}/messages` returns the newest 100 messages in
chronological order, preserving Unicode and optional IDs. Timestamp ties use a stable ID order;
legacy TS does not specify those ties. Missing channels return 404 only after authorization; an
empty channel returns an empty list. Both selected text bytes before driver transfer and public
JSON have a 4 MiB ceiling; overflow returns 503 without shortening or repairing content. The final
session recheck discards rows if revoked. The paired fixture compares 105 stored messages and an
empty channel against real TS and loopback HTTP; additional cases cover tied timestamps, oversized
content/identifiers and revocation during a read. See [message review](../../docs/research/python-message-reads.md).

In `identity` mode, PATCH `/api/v1/bots/{bot_id}/profile` requires `role`, `description` and
`expectedRevision`; it rejects unknown fields. The 32 KiB/five-second body limit accommodates the
maximum Unicode fields. Only descriptive fields change; stale revision returns 409, unchanged
fields 422, missing Bot 404. Profile revision, evolution and audit commit atomically. Owner authority
uses the same locked transaction. Six real database cases cover conflicts, rollback, revocation,
expiry, error mapping and TS profile readback; the explicit process also serves PATCH over HTTP.
The full aggregate profile GET and realtime invalidation remain in S2c; no empty replacement is
advertised. See [profile review](../../docs/research/python-profile-details.md).

## Queued task reference

In explicit `tasks` mode, POST `/api/v1/channels/{channel_id}/messages` accepts 1–8000 normalized
Unicode code points, optional `botId` or one-to-six unique `botIds`, and an optional in-channel
`replyToMessageId`. The body ceiling is 128 KiB/five seconds. Unknown keys are stripped; explicit
null optional fields are rejected. Direct conversations can only address their Bot; ordinary
channels default to the chief/first ordered member. Names never grant authority.

The locked Owner transaction commits one human source message, all queued runs and the existing
MESSAGE_CREATED/RUN_CREATED audits together. Concurrent source messages get distinct increasing
millisecond timestamps. No partial recipient set is persisted. The response includes `message`
and `run`, plus `runs` only for explicit `botIds`. No dispatcher is attached yet: `queued` is an
accurate intermediate state, not a claim that work is executing. Actual attachment markers return
503 until the file authority is migrated; more than eight unique references returns 413.

Authenticated GET `/api/v1/channels/{channel_id}/runs` returns the latest 50 runs, newest first,
with stable ID ordering for timestamp ties and 4 MiB text-transfer/JSON ceilings. Invalid required
state fails closed; malformed model usage is omitted, while valid usage preserves explicit null
token counts. Usage is reported evidence, not permission or billing. Titles retain the legacy
80 UTF-16-unit bound; the 77-unit prefix plus ellipsis never splits a Unicode scalar. This fixes
the narrow legacy invalid-surrogate case. See [task research](../../docs/research/python-task-authority.md).

## Reuse and licenses

See [read research](../../docs/research/python-control-read-slice.md) and
[auth research](../../docs/research/python-owner-auth.md),
[input research](../../docs/research/python-identity-inputs.md), and
[identity transactions](../../docs/research/python-identity-transactions.md), and
[conversations](../../docs/research/python-conversations.md). FastAPI/Pydantic are MIT;
Starlette/Uvicorn/HTTPX are BSD-3-Clause; Psycopg and its binary distribution are LGPL-3.0-only;
CPython is PSF-licensed. Installed notices remain intact. The UUID pattern is adapted from Zod; its full MIT notice is bundled in
[third-party notices](THIRD_PARTY_NOTICES.md). No installed dependency is patched. Redistribution
must retain required notices and applicable license rights.
