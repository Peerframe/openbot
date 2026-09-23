# Python control-plane reference

[English](README.md) · [简体中文](README.zh-CN.md)

S2a-1/2 of the [migration plan](../../docs/ARCHITECTURE_MIGRATION_PLAN.md): Python/FastAPI reads
existing Owner sessions, Bots and channels and can explicitly enable Owner login/logout against the
current PostgreSQL schema. This trusted control layer is separate from the untrusted Agent Runtime.
**The TypeScript Server remains the default. Business mutations, task dispatch, approvals, files,
schedules and events have not moved.** Python starts read-only; auth writes require explicit selection.

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

Nine database/HTTP checks cover reads, expiry/revocation, enforced read-only transactions, exact
schema history, invalid stored Bot status, concurrent persistent throttling, transactional auth
failure without a success cookie, and real loopback processes with bounded SIGTERM shutdown.
The local package has 198 additional passing cases at this slice. Without the explicit fixture,
package checks skip the nine integration cases; skips are not acceptance. Two upstream test-client
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
| `OPENBOT_CONTROL_AUTHORITY` | `read-only` by default; `owner-auth` explicitly enables only login/logout writes |
| `OPENBOT_CONTROL_OWNER_PASSWORD` | Required only for `owner-auth`; 15–1024 UTF-16 units, non-example value. The old Server password variable is not inherited |
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
selected routes; interactive docs are disabled. Complete client parity, revisioned workspace
snapshots and durable event cursors remain later S2 work.

## Reuse and licenses

See [read research](../../docs/research/python-control-read-slice.md) and
[auth research](../../docs/research/python-owner-auth.md). FastAPI/Pydantic are MIT;
Starlette/Uvicorn/HTTPX are BSD-3-Clause; Psycopg and its binary distribution are LGPL-3.0-only;
CPython is PSF-licensed. Installed notices remain intact. No upstream source is vendored or patched.
Redistribution must retain required notices and applicable license rights.
