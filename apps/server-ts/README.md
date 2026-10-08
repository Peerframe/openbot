# TS control-plane entry candidate

[简体中文](README.zh-CN.md)

Accepted [ADR-0050](../../docs/decisions/0050-typescript-control-plane.md) P2 introduces one public
HTTP/Worker entry and one fixed private Python upstream. Python is the default owner of the 121
HTTP operations and background services. Explicitly selected P3 groups transfer only their listed
operations after qualification. The installed Desktop retains its Python baseline; the temporary
forwarder exits in P5.

Install the repository's locked dependencies and Python Worker environment using
[CONTRIBUTING](../../CONTRIBUTING.md). Run from the repository root:

```sh
npm exec -- turbo run build --filter=@openbot/server-ts
npm run test --workspace @openbot/server-ts
npm run contracts:http:ts
npm run contracts:http:ts -- --suite publisher
npm run contracts:http:ts -- --suite models
npm run contracts:http:tls
npm run contracts:http:tls -- --suite publisher
npm run contracts:http:tls -- --suite models
```

The mixed contract driver owns both processes and one disposable PostgreSQL database; it never
loads `.env` or configured user data. Publisher/provider variants use synthetic local credentials
and transports. This does not execute a live provider or qualify Temporal/native packaging.
Use `contracts:http:python` for the direct baseline. The same suite/fixture definitions serve both.
The HTTP mixed all-suite stops each writer before switching mixed→direct→mixed on the same public URL
and database, checking the issued Owner session and existing Bot projection after both switches.
The HTTPS suite uses a disposable CA trusted only by its Node child processes, verifies the secure
Owner cookie, canonical redirect and entry restart, and runs the same Python/SQL/client contracts.
It does not change OS trust or disable certificate verification. HTTPS entry restart is a separate
check from removing and reinstating the HTTP entry.

For an operator-owned composition, first start the existing Python product exactly as documented,
with its normal explicit database/configuration and these additional environment values:

```sh
OPENBOT_CONTROL_HOST=127.0.0.1
OPENBOT_CONTROL_PORT=3102
OPENBOT_CONTROL_PROXY_ADDRESS=127.0.0.1
OPENBOT_CONTROL_PUBLIC_ORIGIN=http://127.0.0.1:3101
OPENBOT_CONTROL_ALLOWED_ORIGINS=http://127.0.0.1:3101
OPENBOT_CONTROL_COOKIE_MODE=loopback
```

Then start `npm run start --workspace @openbot/server-ts` with:

```sh
OPENBOT_TS_HOST=127.0.0.1
OPENBOT_TS_PORT=3101
OPENBOT_TS_PYTHON_ORIGIN=http://127.0.0.1:3102
OPENBOT_TS_PUBLIC_ORIGIN=http://127.0.0.1:3101
```

Supply these as environment configuration; this is not a script that provisions credentials or
migrates data. The Python listener must be private and does not accept direct traffic in proxy mode.
Both origins are exact, with no path, credentials or URL normalization. The entry verifies public
Host and rejects caller forwarding/identity headers; it generates one RFC7239 `for` from the direct
socket. Python validates that hop and applies existing per-client login/enrollment limits. The fixed
public scheme/Host also preserve redirect URLs. Origin, credentials and authorization remain Python-owned.
The optional built Web root and unknown method/path refusals stay in Python during P2.

For HTTPS, replace the public origin/allowed-origin values in Python with your exact HTTPS URL and
set `OPENBOT_CONTROL_COOKIE_MODE=secure`. Keep its listener and proxy address private. Configure TS
with the same public URL and an operator-provisioned certificate/key:

```sh
OPENBOT_TS_HOST=0.0.0.0
OPENBOT_TS_PORT=3101
OPENBOT_TS_PYTHON_ORIGIN=http://127.0.0.1:3102
OPENBOT_TS_PUBLIC_ORIGIN=https://openbot.example:3101
OPENBOT_TS_TLS_CERT_PATH=/absolute/operator/tls/fullchain.pem
OPENBOT_TS_TLS_KEY_PATH=/absolute/operator/tls/server.key
```

Both TLS paths are required with HTTPS; a public bind refuses plaintext. Files must have canonical
absolute paths without symlink components, be regular files owned by the server UID, and have one
hard link. The key must be mode0600 and at most16KiB; the certificate chain must not be group/world
writable and is bounded to64KiB, with the leaf first. Before listening, the leaf must be non-CA,
currently valid, match the private key and public-host SAN, and permit server authentication when
extended key usage restricts its purpose. Startup errors conceal filenames and PEM/key details.
This operator-file policy currently supports POSIX; Windows ACL qualification is separate.

TLS terminates in the existing Node/Fastify entry with minimum TLS1.2, a5s handshake deadline and
at most192 TCP connections. Shutdown also releases unfinished handshakes. Rotate certificates by
restarting the entry; there is no ACME issuer or implicit trusted proxy. Supply a client-trusted chain
and validate the actual deployment separately. Private Python remains the sole writer during restart.

HTTP uses Fastify5.12.5 and released reply-from12.6.5 with raw streams and all retries disabled.
At most128 active HTTP requests and32 Worker tunnels are admitted. Request/header/idle deadlines
are45s; Worker handshake deadline is5s. SSE heartbeat traffic keeps the stream live. Worker handshake
buffering uses a64KiB stream high-water mark; subsequent byte streams use Node backpressure. Client
abort and shutdown destroy owned upstream work. Transport failure yields a sanitized503 and never
repeats a possibly committed mutation. Body validation/bounds stay with Python; no JSON conversion
occurs at the entry. Source integration evidence is in the linked record; licenses are in
[third-party notices](../../THIRD_PARTY_NOTICES.md).

The isolated macOS arm64 candidate uses one PostgreSQL supervisor/migrator, private Python and public
TS. The strict `ts-control.json` resource marker selects the pair; malformed/incomplete TS resources
refuse startup. Either child's exit stops its partner, and inherited parent pipes stop both when
Desktop exits. TS receives the selected groups' explicit database and Owner bootstrap configuration; no model keys. The retained Node runtime is still required.
Build and review the unsigned candidate without replacing an installed application:

```sh
npm exec -- turbo run build --filter=@openbot/desktop --filter=@openbot/server-ts --filter=@openbot/python-node-runtime
node apps/desktop/scripts/prepare-native-server.ts --ts-product
node apps/desktop/scripts/smoke-python-product.ts apps/desktop/out/ts-product-runtime
node apps/desktop/scripts/package.ts --preview --ts-product
node apps/desktop/scripts/smoke-python-product.ts "apps/desktop/out/ts-product/OpenBot TS Preview-darwin-arm64/OpenBot TS Preview.app/Contents/Resources/native-runtime"
```

This creates `OpenBot TS Preview` with a separate app identity/profile/output. The native smoke uses
disposable PostgreSQL and synthetic encryption callbacks; it verifies both product PIDs after parent
death, each child's failure, persistence and shutdown. It does not qualify Keychain, native Work or
signing. The linked record separately documents the actual Electron/safeStorage journey.

For full Desktop resource qualification, build the existing macOS Worker companion from a clean
source commit using [the C19 builder](../../scripts/build-macos-worker-host-candidate.ts), then set
`OPENBOT_DESKTOP_MACOS_WORKER_COMPANION` to its absolute app path and run
`node apps/desktop/scripts/package.ts --ts-product`. This macOS arm64 mode requires the companion,
keeps the canonical production identity and writes `apps/desktop/out/ts-product/OpenBot-darwin-arm64`.
The isolated Preview continues to refuse that production companion. Building the candidate does
not install it or register the Worker service. Keep signing variables unset for unsigned development
qualification; use a disposable profile for any startup because the canonical identity shares normal
profile defaults. Worker registration, Keychain access-group provisioning and distribution signing
retain their separate existing acceptance gates.

Measure the API-only forwarding overhead from the same staged payload and compiled Desktop launcher:

```sh
env -i PATH="$PATH" LANG=en_US.UTF-8 apps/desktop/out/ts-product-runtime/node/bin/node apps/desktop/scripts/measure-ts-product.ts apps/desktop/out/ts-product-runtime > p2-overhead.json
```

This macOS arm64 probe refuses stale TS build output, owns fresh disposable profiles and alternates
Python direct/TS forwarding order across three trials, each with a fresh start and restart. It records
native descendant RSS after the same P0 settling interval and100 serial requests per target after10
warmups (`health` and authenticated channel reads), then verifies complete shutdown. It uses synthetic
encryption and no configured external transports. Raw observations are descriptive loopback API
measurements; renderer/Keychain, active Temporal and public-network throughput remain separate scopes.

The linked record includes actual same-source API-only overhead measurements. Current qualification
is a local candidate; externally deployed TLS/PKI and hosted platform checks remain P2 acceptance
items. Local certificate/transport contracts do not establish deployment or P3 ownership.

## First P3 read cohort

The explicit `transcription` candidate owns only GET `/api/v1/settings/transcription`. It uses the
existing PostgreSQL session/prefs rows and strict shared DTO. PUT, login/logout, model resolution,
audit writes and Temporal stay in Python. The default remains forwarding-only (`none`).

Set `OPENBOT_TS_READ_GROUP=transcription` and `OPENBOT_TS_DATABASE_URL` to the same operator-owned
URL as `OPENBOT_CONTROL_DATABASE_URL`; pass `OPENBOT_TS_READ_ALLOWED_ORIGINS` as the same explicit
comma-separated origin list as Python (default: TS public origin). On private Python product set
`OPENBOT_CONTROL_TS_READ_GROUP=transcription`. That exact private GET refuses; no automatic fallback
is permitted. Both group flags must be set back to `none` to reverse without copying data or
reissuing sessions. Keep the same address, database and cookie mode; stop old processes before
starting their replacements. The retained Python reader exits after the complete transcription
cohort is accepted, and forwarding exits in P5.

The mixed all/control/resources and HTTPS control fixtures qualify the real read with session,
revocation/expiry, lock/abort, Python-stop and paired reverse checks. They never load user data.
Before each group switch, run `npm run ui:acceptance -- --entry ts` and require PASS12/12 with zero
unexpected responses/page errors. A workspace503 must be investigated, not allowlisted. See the
[decision and current checkpoint](../../docs/research/typescript-control-plane-p0.md#p3-transcription-read-decision-and-security-review-2026-10-07).

## Primary Bot write candidate

On this candidate, set `OPENBOT_TS_WRITE_GROUP=primary-bot`, the existing explicit
`OPENBOT_TS_DATABASE_URL`, and `OPENBOT_TS_WRITE_ALLOWED_ORIGINS` to the same exact origin list as
Python (default: TS public origin). Also set private Python `OPENBOT_CONTROL_TS_WRITE_GROUP=primary-bot`.
Only PUT `/api/v1/workspace/primary-bot` changes owner; other methods/routes forward. SQL authority,
workspace-first CAS, Bot liveness and audit commit together. Identity lifecycle stays in Python.
The entry checks Origin/session before collecting at most1024 UTF-8 bytes of JSON within5s, then
locks/rechecks the same session in its6s transaction. No bearer substitution, new credential access,
implicit retry or automatic fallback. An interrupted commit response is unknown until authoritative
refresh; never resubmit it automatically.

Default write selection is `none`. For an explicit reverse, stop both owned processes, set both
write flags to `none`, and restart on the same URL/SQL/session without restoring data. Keep the
previous qualified release throughout the bounded rollback window. The new strict native marker is
`openbot.desktop.ts-control/v2` with `readGroup:transcription` and `writeGroup:primary-bot`; it refuses
old/incomplete selection. Retain the independently packaged previous release as rollback.

Real mixed/HTTPS contracts include primary-Bot failures, concurrency, expiry/revocation, audit
rollback, client-abort SQL cleanup, Python-stop and paired reverse. Run the required exact-candidate
TS UI12/12 before any operation switch; qualify native staging and the actual uninstalled package.
See [the decision](../../docs/research/typescript-control-plane-p0.md#p3-primary-bot-selection-decision-2026-10-08).

## Owner authentication candidate

The explicit `owner` group owns GET session/sessions and POST login/logout/password/revoke-others.
Set `OPENBOT_TS_AUTH_GROUP=owner` and private Python `OPENBOT_CONTROL_TS_AUTH_GROUP=owner` together.
Use the same database and `OPENBOT_TS_OWNER_PASSWORD` as Python's explicit bootstrap password,
`OPENBOT_OWNER_NAME` (default Owner), `OPENBOT_TS_SESSION_TTL_HOURS` (default12, range1–168), and
`OPENBOT_TS_AUTH_ALLOWED_ORIGINS` (default public origin). Keep TTL/identity/origin/cookie mode equal
on both sides. Persisted credentials override bootstrap; Python CLI recovery retains its authority.
The six exact private routes refuse503 while selected; other methods and OPTIONS still forward.

The native v3 marker fixes `authGroup:owner` in addition to the read/write selections. Native launch
passes only its existing bootstrap credential to the TS issuer, alongside the shared database.
Two asynchronous native KDFs and four SQL transactions may run concurrently; overflow fails closed503.
Slots remain occupied until actual work settles, including abort/timeout. JSON is bounded to8192 bytes
and5s; each KDF/SQL operation has a6s deadline. Passwords remain the exact UTF-8 scalar/code-point
contract and fixed scrypt format. Tokens never persist in plaintext. Password verification occurs
before issuance's lock, then rechecks credential revision; cookies follow committed audit/session data.

Reverse only by stopping both processes and setting both auth flags to `none`, on the same database,
public address and cookie mode. Do not restore old credential/session rows. Retain the prior qualified
package during the rollback window; Python routes retire after this full cohort is accepted and the
window closes. Require real SQL/HTTP/HTTPS concurrency and reverse-switch checks, UI12/12, full checks,
and native stage/package qualification before selection. Native smoke explicitly submits the changed
password after restart; this does not claim automatic Desktop bootstrap login after a user changes it.
See [the auth decision](../../docs/research/typescript-control-plane-p0.md#p3-owner-authentication-decision-2026-10-08).

## Channel read candidate (P3)

The local `channels` cohort selects only GET Bot list, channel list, channel messages and channel Runs.
Set `OPENBOT_TS_CHANNEL_READ_GROUP=channels` on TS and
`OPENBOT_CONTROL_TS_CHANNEL_READ_GROUP=channels` on private Python, with the same explicit
`OPENBOT_TS_DATABASE_URL` used by other selected groups. Both default to `none`; unknown selections
and Python selection outside private product mode refuse startup. Optional
`OPENBOT_TS_READ_ALLOWED_ORIGINS` retains the existing read CORS policy.

The four Python HTTP routes refuse while selected; internal Python readers and all identity/message/
Run writers remain active in their existing roles. Reads use bounded read-only READ COMMITTED SQL,
recheck the Owner session before returning data or a channel-specific error, preserve message cursor
microseconds and enforce existing SQL/JSON ceilings. No table migration, provider access or dispatch.
For reverse, stop the pair, select `none` on both sides and restart using the same newer database.
Retain the previous qualified package; never restore old session or message data.

The v4 unsigned macOS arm64 Preview marker includes `channelReadGroup:channels` and requires all
three compiled read modules before launching the pair. The contract and UI drivers select this group
with prior qualified groups. Real HTTP/HTTPS comparisons include pagination, revocation during blocked
reads, bounded admission, malformed/oversized records, Python-down availability and reverse switching.
See [current qualification](../../docs/research/typescript-control-plane-p0.md#current-migration-checkpoint-2026-10-08).
