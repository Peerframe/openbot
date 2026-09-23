# Research: Python Owner session issuance and revocation

- Status: Implemented and locally accepted for S2a-2; hosted Linux CI pending.
- Date: 2026-09-23
- Owner: OpenBot maintainers
- Journey: explicitly select the Python Owner-auth reference, log in, read a Bot, log out,
  and confirm both implementations reject the revoked session in a disposable shared schema.
- Boundary: Owner authentication only. No task, approval, settings, model or file writes.

## Primary-source review before implementation

Existing OpenBot behavior reviewed at `990a1b5`: owner-auth.ts, postgres-session-store.ts,
client-identity.ts, request-throttle.ts, postgres-request-throttle-store.ts, app.ts, the protocol
login schema, configuration constraints, and immutable migrations 0003/0017. The
[read-slice research](python-control-read-slice.md) remains the dependency baseline.

| Candidate | Exact version and license | Evidence and decision |
| --- | --- | --- |
| Python secrets/hmac/hashlib/ipaddress | CPython 3.12.13, PSF-2.0 | Reviewed [secrets source](https://github.com/python/cpython/blob/v3.12.13/Lib/secrets.py), [tests](https://github.com/python/cpython/blob/v3.12.13/Lib/test/test_secrets.py), hmac.py and [compare-digest contract](https://docs.python.org/3.12/library/hmac.html#hmac.compare_digest). Reuse explicit 32-byte token entropy and equal-length digest comparison; never use random.Random or invent crypto. The 2026-09-23 GitHub open-issue query `repo:python/cpython is:issue is:open secrets compare_digest` returned no matches; this narrow search is not a security audit. |
| Starlette session middleware | 1.6.0, BSD-3-Clause | Reviewed [source](https://github.com/Kludex/starlette/blob/1.6.0/starlette/middleware/sessions.py). Signed client-carried session content is not the existing PostgreSQL revocation/expiry model. Keep Starlette cookie serialization, not its alternative session store. Release/HTTP tests reviewed in S2a-1. |
| PostgreSQL advisory locks and transactions | 17.11, PostgreSQL License | Reuse [transaction-level advisory locks](https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS) with the exact existing throttle namespace/key. This coordinates existing reservations across processes; no in-memory-only rate limiter. |
| Psycopg | 3.3.6, LGPL-3.0-only | Reviewed [transaction tests](https://github.com/psycopg/psycopg/blob/3.3.6/tests/test_transaction.py) for commit on normal exit and rollback on exceptions, plus the official [transaction guide](https://www.psycopg.org/psycopg3/docs/basic/transactions.html). Retain the already-reviewed driver/release and its known platform limits. |
| OAuth/JWT replacement | Not selected | S2a preserves the current single Owner password/session contract. Connector OAuth belongs to S6; stateless tokens would change immediate revocation and force a separate migration. |

## Selected adapter and authority

Use the released standard-library/ASGI/driver interfaces around the existing PostgreSQL tables.
No new dependency, copied upstream source, second session format or schema change. OpenBot's MIT
business semantics are reimplemented with parameterized SQL. Dependency notices remain installed.
This is not a password database: the operator supplies the Owner secret explicitly to the selected
reference process, as in the current Server; only its digest is retained by the auth service.
No password/token enters logs, exported artifacts or model context.

Default remains read-only. `OPENBOT_CONTROL_AUTHORITY=owner-auth` explicitly opts the loopback
reference into auth writes and requires `OPENBOT_CONTROL_OWNER_PASSWORD`; never inherit the old
Server password variable or automatically fall back. Production authority selection is not changed.
Configure exact allowed origins; never infer mutation trust from caller-supplied Host/Forwarded.
Uvicorn still disables proxy-header trust. Only the direct peer IP contributes the existing salted
namespace digest. A proxy deployment is outside this reference slice.

Preserve 15-character minimum configuration, bounded nonempty request password without trimming,
32-byte URL-safe session tokens, SHA-256 database digests, Owner-only rows, expiry, secure/plain
cookie selection, HttpOnly/SameSite=Strict/Path=/ and no Domain. Use explicit validated TTL 1–168
hours. Login bodies are bounded before parsing and errors exclude submitted inputs.

Reserve the existing five-attempt/five-minute bucket under the same transaction advisory lock.
Invalid attempts must COMMIT their counters; return an outcome before raising an HTTP error, so an
exception does not roll the reservation back. A successful login clears its bucket and persists the
session in the same transaction. Only after commit issue a cookie. Throttled requests return 429
and Retry-After. Storage uncertainty returns 503, with no blind automatic retry or cookie.
Logout revokes persisted authority before clearing the cookie; an uncommitted logout cannot be
reported as successful. Existing read connections stay PostgreSQL read-only.

## Acceptance gates

- Exact selected mode/configuration, origins, request body limits, cookie policy and direct network
  identity; spoofed forwarding headers cannot reset the throttle identity.
- Real PostgreSQL concurrent wrong-password attempts, persistence across service instances,
  success/reset, expired/revoked cookies, rollback/storage failure without a success cookie.
- Both directions of TS/Python session compatibility and revocation, using only owned synthetic
  credentials/database. Keep ordinary Bot/channel writes unavailable.
- New local/CI tests, unchanged read regressions, bilingual boundary docs and full repository check.

## Local acceptance

The combined package has 198 passing cases plus nine owned real PostgreSQL/HTTP cases. Auth
coverage includes ten simultaneous failures yielding five reserved failures and five throttled
requests, limits surviving a new service instance, rollback of the reservation/reset on a forced
session INSERT failure, no cookie on that failure, both directions of TS/Python issuance/revocation,
and explicit owner-auth startup/login/read/logout over HTTP. Uvicorn 0.53.0 deliberately re-raises
SIGTERM after graceful shutdown, so the fixture verifies closed service/process exit by SIGTERM.
This is local evidence, not hosted Linux CI or proxy/production qualification.

## Unicode correction from the S2a-3 differential review

Installed Zod 4.6.2 counts Unicode code points, confirmed in checks.js and the actual login/config
schemas: 14 emoji fail configuration, 15 pass; login accepts 1,024 emoji but rejects 1,025. The
initial UTF-16 assumption was wrong and is corrected to Python len with regression coverage. The
reference additionally rejects configured secrets beyond the login limit (legacy configuration had
no maximum), because that configuration cannot be used to log in. JSON containing lone surrogates
is rejected before UTF-8 credential hashing; no plaintext is exposed in errors.
