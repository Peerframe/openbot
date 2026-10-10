# Product HTTP contract tests

The P1 suite covers Work plus identity, Owner authentication, workspace/preferences, messages,
Runs/progress, polling SSE, model connections, transcription selection, storage and attachments,
identity lifecycle, reactions, approval decisions/settings, audit JSON/CSV, Employee profiles/
knowledge/skills/memory, automation CRUD, Node identity/enrollment HTTP/WebSocket, Run artifact bytes,
plugin HTTP/MCP discovery/content, browser sessions/maintenance and Employee export/import
on an explicitly disposable target. It imports shared TS validators and calls the public API
without importing Server implementations. Configured publisher and synthetic provider variants are
separate invocations. Mixed-entry forwarding/saturation/reverse switching belong to P2;
Worker/Temporal execution and native packaging retain their later phase gates. Passing this suite
alone does not close P1 or prove those execution paths.

From a checkout prepared according to [CONTRIBUTING](../../CONTRIBUTING.md):

```sh
npm run contracts:test
npm run contracts:http:ts
npm run contracts:http:ts -- --inventory
npm run contracts:http:ts -- --suite control
npm run contracts:http:ts -- --suite publisher
npm run contracts:http:ts -- --suite models
npm run contracts:http:ts
npm run contracts:http:ts -- --suite publisher
npm run contracts:http:ts -- --suite models
```

The first command runs frozen legacy input/DTO serialization parity and Web consumption plus target-input
tests. The second reuses the owned Docker fixture, migrates empty PostgreSQL, starts real
`serve.py` in product mode, logs in, creates a synthetic Bot, then invokes the private-fixture CLI
with all eleven black-box suites. They create identities, messages and Tasks, check CAS/pagination,
model dependency guards, raw upload/download bytes, real DOCX parsing in both attachment scopes,
reference protection, cleanup receipts, lifecycle guards, reactions, cancel/steer, approval settings,
single-use/expired decisions, bounded audit keyset/CSV, profile/memory CAS, reviewed skill digests,
legacy/native proposal review, schedule quota/membership guards, Node single-use token/rotation/revocation,
socket identity/heartbeat, raw Run artifact bytes, digest-bound MCP installation/update, scoped untrusted
resource/prompt/app reads, original browser Host binding/observation/maintenance, exact reviewed
Employee download bytes, quarantined import/concurrent activation and SSE ready/heartbeat/reconnect/abort. They revoke sessions,
change the fixture password and log out. Model connections use synthetic keys; successful
discovery/test/transcription is never invoked. No configured data, `.env`, real model credentials
or Temporal installation are used. The owned fixture seeds an unread Bot message, waiting approvals
and one safe/private audit event, plus legacy/native completed and incomplete knowledge proposal sources,
an expired bootstrap token, native proposed/expired/stale/unknown actions and published artifact files/metadata.
A separately authenticated loopback MCP fixture reuses official SDK1.29.0 and the product's exact-local
endpoint allowlist; it changes declarations and content only through a bounded private controller.
No tool is executed and no controller credential is sent to the product.
These published records stand in for Worker publication; HTTP transactions are real,
but Worker/Temporal execution is not exercised. All owned resources
are removed on success/failure. Docker and the locked Node/npm dependencies are required.
The inventory option records default product HTTP registrations in the existing migration research.
It also records reviewed Web/Desktop/Node/native Host consumer files with their source digests and
the actual registrar/composition boundaries. Source inventory does not establish consumer execution.
The all/resources driver additionally invokes the actual Web client through the Desktop proxy using
Node Fetch: five settings PUT operations and Owner attachment upload/list/download/delete against
the real disposable product. This catches method/header drift; installed Electron and target-platform
behavior remain separate evidence. The proxy preserves the exact seven product PUT paths and the
two raw-upload endpoints, with its existing credential/Origin/body/redirect boundaries.

For a separately prepared TS/mixed disposable target, create a mode-0600 JSON file containing
`baseUrl`, `origin`, `cookie` and `botId`, then run:

```sh
npm run run --workspace @openbot/contract-tests -- --fixture /absolute/private/fixture.json
```

`baseUrl` and `origin` must be exact HTTP(S) origins; the fixture supplies an existing Owner session
and a Bot with the `none` profile. The suite creates/corrects/cancels synthetic Tasks and expects
an idle target without an execution worker. Keep the private fixture outside the repository.
The same runner can be imported as `runWorkContracts`; every call requires an explicit target.
An optional `work` object adds `{ taskId, intentDigest, actions: { approve, reject, expired, stale, unknown } }`:
IDs are canonical UUIDs and the digest is64 lowercase hex characters. The owned all/work driver
supplies the [SQL publication recipe](../../scripts/server-contract-fixture.ts). `runWorkContracts(target, work)`
checks successful approval/rejection, concurrent idempotent decision/event publication, expiry/generation/
digest refusal, one pending reconciliation command, replay/CAS conflicts and lookup after cancellation.
Requests cannot resolve unknown facts, spend tokens or admit execution. The private all fixture requires
this metadata; basic standalone Work targets retain create/read/correct/cancel/refusal scope.
`--suite resources` or `runResourceContracts(target)` runs model/storage/attachment cases and
uses the included [synthetic DOCX](fixtures/README.md). It requires the target's existing released
document parser. Storage settings are restored to default-off during the run.
Document extraction requests allow35s for the product's30s parser deadline; other requests retain10s.
The all-suite child has a180s limit; focused children retain120s. Each is stopped and reaped on failure.
The owned driver accepts `--suite` with the same suite names as the private CLI below; `--inventory`
requires `all`. Unknown/repeated options and partial inventory requests fail before fixture creation.
Browser JSON responses explicitly allow8MiB for the existing5MiB PNG/base64 ceiling; other JSON
responses remain4MiB. Review headers are bounded and cannot contain CR/LF; abort signals remain explicit.

For `--suite lifecycle`, add a `lifecycle` object with `channelId`, `unreadMessageId` and
`approvals: { approve, reject, expired }`, all canonical UUIDs. Prepare the same synthetic publication
states and bounded audit event as the [owned fixture seeding](../../scripts/server-contract-fixture.ts):
one unread Bot message, two live and one expired pending legacy approvals on waiting Runs with an
offline synthetic Node, and a `SETTINGS_PRIMARY_BOT_UPDATED` event with nullable previous ID,
160-emoji `fileName`, 120-emoji `name` and a private sentinel. These fixtures are test inputs, never
product fallback data. `runLifecycleContracts(target, lifecycle)` uses the same metadata, with no
database credentials or Worker authority. This suite changes approval settings and clears the primary
Bot when deleting its selected identity; use a fresh disposable target.

For `--suite employee`, add an `employee` object with canonical UUID `botId`, `sourceRunId`,
`sourceTaskId`, `sourceWorkRunId` and `proposals: { accept, reject, native, incomplete }`.
Use the [owned seeding recipe](../../scripts/server-contract-fixture.ts): a separate `none` Bot with
two completed legacy Run proposals, one completed native Task/Run with completion digest and one
incomplete native source. `runEmployeeContracts(target, employee)` covers Owner profile/memory,
candidate skills, digest-bound review and both proposal provenance forms. Candidate learning remains
inspired by Hermes Agent. No task completion or model use is executed by these fixtures.

`--suite automations` or `runAutomationContracts(target)` requires an empty disposable schedule set.
It creates future schedules, checks pause/resume against current membership and parallel admission at
the50-record ceiling, then deletes only its owned schedules. Actual due submission and Temporal
recovery are separate gates.

`--suite nodes` requires `nodes: { expiredNodeId, expiredToken }`, with one already-expired token
in the owned database. `runNodeContracts(target, nodes)` issues/exchanges only local bootstrap material,
opens bounded synthetic protocol peers, checks identity/heartbeat projections, rotates credentials,
revokes/disconnects and tests the shared enrollment throttle. It never starts a Worker executor or Provider.
Use an idle disposable target; throttling and revocation leave deliberate state for disposal.

`--suite artifacts` requires `artifacts: { valid, integrity, refusedKey, oversized, symlink? }`.
The two `valid` records have UUID `id`, UTF-8 `name`, `mediaType` (`image/png` or `text/markdown`) and
bounded `base64` bytes. Other fields identify published negative records; use the
[owned seeding recipe](../../scripts/server-contract-fixture.ts). `runArtifactContracts(target, artifacts)`
checks exact bytes, response headers, integrity, key bounds, oversized files and optional symlink refusal.
For native Work downloads, add `native: { taskId, valid, integrity, sizeMismatch, missing, oversized, symlink? }`
inside `artifacts`. `taskId` binds the seeded completed Work source. Native valid records retain the same
fields, allow2–3 records,255-character names, empty bytes and `application/octet-stream` as well as PNG/Markdown.
The owned driver includes3 records and checks raw8MiB-store downloads, RFC5987 filenames, sandbox headers,
the Work snapshot's digest/size/download links, digest/size mismatch, missing files, oversize and no-follow.
The private `all` fixture requires `native`; a standalone artifacts fixture can retain legacy-only scope.
The driver first runs19 checks with both owned symlinks, removes only those links, then runs all
suites with17 artifact checks. Whole-root storage measurement correctly refuses any symlink, so this
ordering preserves its independent successful-storage gate. These are publication fixtures, not Worker-produced files.

`--suite plugins` requires `plugins: { endpoint, token, controllerToken }`. The endpoint must be
an exact `http://127.0.0.1:PORT/mcp` URL of the [owned MCP fixture](../../scripts/contract-plugin-fixture.ts);
the two distinct credentials are64-character lowercase hex. The product must explicitly allow this
one local endpoint. `runPluginContracts(target, plugins)` tests actual discovery, reviewed digest,
disabled-by-default installation, revision/concurrent CAS, declaration/grant/membership guards,
untrusted resource/prompt/app payloads, ordinary-resource byte limits, update reset, deletion and
MCP bearer/session cleanup. Public records omit private tokens. The default service cannot publish
a legacy pending call because it has no legacy Run authority guard; that HTTP decision route is
qualified for authentication, malformed input and unknown-call refusal only. Successful legacy
decisions and native durable tool approval/execution remain separate acceptance items.

`--suite browser` requires `browser: { frameBase64 }`, the bounded authored1-pixel PNG from the
[owned fixture](../../scripts/server-contract-fixture.ts). `runBrowserContracts(target, browser)` creates
and disposes its own Docker-profile Bot, enrolls an authenticated synthetic Node and returns authored
frames over the real socket. It checks Owner/Origin/body admission, original identity binding, the
default-off control gate, PNG byte validation, maintenance, view close/disconnect and refusal to rebind
a same-id Host with new credentials. No Chromium or browser Provider is started. The current product
entry retains a wait after client abort until the original command's25s deadline; the suite checks
its bounded release and zero automatic retry. It does not claim immediate disconnect cancellation.
Trusted human-control/Work browser composition remains a separate acceptance item.

`--suite portability` or `runPortabilityContracts(target)` needs only the basic disposable target.
It creates a source Bot, private memory and authored reviewed MIT `SKILL.md`; verifies metadata/v2
download bytes, strong `If-Match`, checksum/review binding, privacy exclusions, strict JSON admission,
quarantine and blocked-package/activation guards; then verifies parallel idempotent activation yields
one new identity/receipt and candidate skills with model use disabled. Upload uses `application/json`;
Employee-specific media types describe downloads and are refused as import request media. Missing
publisher trust is tested as refusal; successful signed export/import requires the optional real keyring.
Only owned identities are deleted. Preview creates no identity, memory or Host authority.

`--suite publisher` is the configured signing variant, separate from the unsigned `all` composition.
The owned driver initializes an ephemeral encrypted keyring with the retained offline CLI, supplies
both existing `OPENBOT_CONTROL_PUBLISHER_*` paths to real `serve.py` and deletes the entire private
subtree on success/failure. It never loads `.env` or prints private keys/passphrases.
For another disposable target, add only `publisher: { keyid, publicKey }` to the private fixture:
`keyid` is an `ed25519:` SPKI-SHA256 fingerprint and `publicKey` is bounded public PEM.
`runPublisherContracts(target, publisher)` verifies reviewed v1/v2 raw bytes and Ed25519 signatures
independently, trusted quarantine, tampered/raw signed document/untrusted embedded-key refusal,
non-authoritative signature hints and review-bound parallel activation with one signed receipt.
Candidate skills stay disabled and no memory or Host grants are imported. Fixture inputs never accept
private keys, passphrases or keyring paths. The unsigned suite's missing-trust refusal remains required.

`--suite models` or `runModelContracts(target)` uses only the basic private fixture and requires a
separately composed synthetic provider transport. The owned driver starts
[`ts-model-fixture.ts`](../../scripts/ts-model-fixture.ts), which injects
the existing trusted constructor factory into real `serve.py`; no production setting/header/route
selects this behavior. Owner HTTP, encrypted connection persistence, SDK serialization and current
revision checks remain real. OpenAI Chat and Anthropic discovery/probe success, filtering/deduplication/
256-ID bounds, unsaved verification, invalid credentials, redirects, invalid JSON, oversized declared
responses and unavailable providers are checked. Private provider diagnostics and credentials cannot
enter public errors. The owned receipt requires exactly10 discoveries and4 explicit no-tool probes,
with zero unauthorized dispatch, retry or fallback; it records counts only. It never contacts a live
provider or loads `.env`. This establishes API/SDK transport contracts, not actual model/Task execution.
CI requires unsigned all, signed publisher and models as three separate disposable runs.

For `--suite control` or `--suite all`, include the disposable Owner's `password` in that same
private fixture. Both options run authentication and password-change cases, invalidating the
fixture's sessions and password; prepare a fresh idle disposable target for every run.
`runControlContracts(target, password)` exposes the same suite for a TS/mixed target. `--suite all`
also requires `work`, `lifecycle`, `employee`, `nodes`, `artifacts`, `plugins` and `browser` and runs Work, resources,
lifecycle, Employee, automations, browser, portability, nodes, artifacts, plugins, then control.
Browser enrollment precedes the Node suite's deliberate bootstrap throttle. Redirects are refused,
secrets are never logged, response bytes and SSE reads have
bounded frames/deadlines and every stream is explicitly closed. SSE tests qualify message invalidation,
slow-reader coalescing plus authoritative refresh, channel tombstone and workspace/channel password
revocation. These streams emit content-free ready notifications with no replay IDs; saturation-level
transport pressure remains unqualified. The runner separately refuses UTF-8 truncation, incomplete
frames and over4MiB of actual UTF-8 bytes; synthetic framing tests are not product-pressure evidence.
