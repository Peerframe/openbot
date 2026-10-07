# TS control-plane entry candidate

[简体中文](README.zh-CN.md)

Accepted [ADR-0050](../../docs/decisions/0050-typescript-control-plane.md) P2 introduces one public
HTTP/Worker entry and one fixed private Python upstream. Python still owns all 121 default HTTP
operation, authentication, approval, audit, database and background service. Nothing is retired and
the installed Desktop still uses its Python baseline. The forwarding adapter exits in P5.

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
Desktop exits. TS receives transport configuration only. The retained Node runtime is still required.
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
