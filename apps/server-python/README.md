# Python control plane and product candidate

[English](README.md) · [简体中文](README.zh-CN.md)

Python/FastAPI implements the trusted business control layer in the
[migration plan](../../docs/ARCHITECTURE_MIGRATION_PLAN.md), separately from the untrusted Agent Runtime.
The explicit `product` entry composes Owner identity/workspace, model connections, knowledge,
conversations, schedules, files/processors, plugins/MCP and Worker Host services. An explicitly
configured Temporal engine supplies durable Work execution, approvals, corrections and publication.
The entry still defaults to read-only; repository development and release defaults still select
the TypeScript Server while retirement gates remain open.

Current scope and evidence are in the [migration handoff](../../docs/MIGRATION_HANDOFF.md).
Local product and packaged macOS arm64 Preview journeys pass; full remote Linux command and
Chromium/human-takeover qualification remain incomplete. Earlier staged-mode sections below
describe their narrower contracts and historical tests, not the complete current product surface.

## Develop and verify

For the full local suite, first install the repository's locked npm dependencies and run
`npm run oracle:build` from the repository root. This also builds the shared contracts used by
the retained publisher CLI interoperability test; that test creates and removes only temporary
synthetic keys. Then, from this directory with Python 3.12 available:

```sh
./scripts/bootstrap.sh
./scripts/check.sh -q
```

`OPENBOT_CONTROL_PYTHON` selects a trusted bootstrap interpreter. The accepted Agent Runtime venv
is separate. The lock records the exact development dependency closure; verification rejects missing, extra or
drifted distributions. This environment includes test tools, is not a production image, and never
installs dependencies on startup.

From the repository root, run the owned disposable database journey:

```sh
apps/agent-runtime-python/scripts/bootstrap.sh
npm run test:control:python
```

The fixture builds the fixed [test-only Server oracle](../../tests/oracles/legacy-server/README.md),
owns a temporary loopback PostgreSQL 17.11 container,
applies the unchanged Node migration history, and uses synthetic credentials/Bots/channels. It
compares Python reads to the actual TypeScript API, including Unicode, multi-member and direct
channels. Legacy membership order is unspecified, so only member IDs are compared as sets; Python
returns them sorted. Other fixture fields match exactly. Both implementations recognize sessions
issued by the other, and revocation takes effect across implementations.

Ninety-five database/HTTP/SDK checks cover reads, expiry/revocation, enforced read-only transactions, exact
schema history, invalid stored Bot status, concurrent persistent throttling, transactional auth
failure without a success cookie, and real loopback processes with bounded SIGTERM shutdown.
Identity checks also exercise exact audit/evolution payloads, missing members, concurrent name
conflicts, rollback on audit failure, revocation during a row-lock wait, expiry during audit waiting,
and real HTTP creation. Task cases cover multi-recipient atomicity, reply/member scope, concurrent source timestamps, audit rollback and bounded Run reads. An additional 60-case differential executes the actual TS and Python routing/Run projections. A separate 129-case input differential compares installed Zod against Python; 34 additional cases compare Owner run commands. Command database cases cover descendant cancellation, corrections, actual lock contention and rollback. Without the explicit fixture,
package checks skip the ninety-five integration cases; skips are not acceptance. Two upstream test-client
deprecation warnings remain at the reviewed pins. The Linux CI job includes these checks; a hosted
run is separate evidence and has not yet run for this local change.

The fixture never uses `OPENBOT_DATABASE_URL`, dotenv, model credentials or a user database; it
removes only owned resources. These checks do not prove live-provider, browser or production behavior.

## Explicit local entry and authority

For a prepared compatible reference database, supply `OPENBOT_CONTROL_DATABASE_URL` and run
`.venv/bin/python -I scripts/serve.py`. It defaults to `127.0.0.1`, uses port 3101 unless
`OPENBOT_CONTROL_PORT` (1–65535) is explicit, and disables forwarded-header trust/access logs.
`OPENBOT_CONTROL_HOST` accepts only `127.0.0.1` or `0.0.0.0`; invalid/empty values fail before
initialization. The opt-in [product container](../../deploy/server/README.product.md) selects
`0.0.0.0` inside the container and publishes its host port only on loopback.
It never runs migrations or reads dotenv. This is not a production cutover instruction.

| Setting | Meaning |
| --- | --- |
| `OPENBOT_CONTROL_HOST` | Default `127.0.0.1`; only explicit `0.0.0.0` is also accepted. This does not change origin, cookie or forwarded-header policy |
| `OPENBOT_CONTROL_AUTHORITY` | `read-only` by default; `owner-auth` enables login/logout; `identity` additionally enables Bot/channel creation, direct conversations, member joins and profile details; `tasks` adds legacy queued submission; `work` additionally exposes the independent work-domain admission API |
| `OPENBOT_CONTROL_OWNER_PASSWORD` | Required for `owner-auth`, `identity`, `tasks` and `work`; 15–1024 Unicode characters, non-example value. The old Server password variable is not inherited |
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

## Owner task commands

The explicit `tasks` mode also exposes POST `/api/v1/runs/{run_id}/cancel` with a strict empty
JSON object (128-byte limit) and POST `/api/v1/runs/{run_id}/steer` with a strict `instruction`
field (18,000-byte limit). Both require a current Owner session and allowed origin. Steering
requires a UUID task ID, trims 1–4000 Unicode code points, refuses attachment markers and accepts
at most eight instructions for a native queued/running task whose Bot remains a channel member.
It returns 202 with `steering` only after the audit transaction commits. This endpoint records an instruction; the HTTP reference still has no dispatcher. The persisted completion adapter checks all committed steering IDs before publication.

Cancellation returns the committed `run`, stops its active native descendants in the same channel,
and records exact Owner/ancestor audits atomically. Repeating cancellation adds no duplicate audit.
Other terminal or Worker states return 409; missing tasks return 404 after authentication. The
transaction bounds descendants to 1000 and projected text/JSON to 4 MiB, with complete rollback
when exceeded. A failed audit or expired Owner session rolls back both target and descendants.
The current reference still has no dispatcher: process/plugin interruption and realtime publication
must be connected after commit before claiming cancellation of executing external work.

Local command acceptance: 71 combined PostgreSQL/HTTP cases, actual TS cancellation/steering
readback, 728 Python package cases, and full repository checks passed. Database tests skip only
in the ordinary package run; use the owned `npm run test:control:python` fixture to run them.

## Control-owned runtime adapter (S2b-2 internal seam)

The separate `runtime_host`, `runtime_ports` and `runtime_executor` modules retain authority,
model resolution, tool executors, budgets, usage and final-result checks in control. The installed
SDK worker receives only the existing process profile. These modules are not wired to the task
HTTP dispatcher yet: queued task execution, SQL terminal state and approval integration remain
unfinished. A deterministic model port is test evidence, not live-provider support.

The host rechecks authority around asynchronous boundaries, consumes exact admitted tool intents
before side effects, and compares returned history with the actual model/tool transcript. It
rejects replay, invented tool observations and success after a latched failure or cancellation.
Effect adapters must enforce their own atomic authority/approval at dispatch and cooperate with
cancellation; host checks cannot undo external effects. Returned final text is provisional until
the SQL service separately commits completion. The process adapter owns its PID before connecting
pipes and completes group cleanup before propagating cancellation. At the supervision checkpoint,
651 package cases passed, with its 45 database cases verified separately; 83 process/actual-SDK cases and
48 actual TS/Python profile comparisons pass. These do not establish persisted task execution; see
[supervision research](../../docs/research/python-control-runtime-supervision.md).

For the real-worker control tests, first bootstrap `apps/agent-runtime-python` in its own venv.
`tests/test_runtime_sdk_integration.py` skips when that environment is absent or on Windows; a
skip does not establish interoperability. The existing `npm run test:runtime:linux` fixture
installs both isolated locked environments in the pinned Linux image and requires the real worker.
The control tests do not inherit the synthetic database credential used by the TS test phase.
The local Linux/amd64 fixture passed 306 control cases, plus the existing 418 SDK and 222 TS/PG
cases. It uses Docker init to reap orphan descendants. Hosted CI is wired but not yet run for this change.

## Persisted execution lifecycle

`PostgresExecutionStore` owns background claim, current-state checks, frozen channel context,
usage, progress, correction reads, failure and atomic completion. It uses bounded PostgreSQL
transactions without an Owner cookie; every successful mutation rechecks persisted Run identity,
ancestry and channel membership. HTTP commands retain their separate locked Owner authorization.
Claims preserve the six-root and per-Bot/channel limits. Usage advances by one step and retains
unknown token counts. Failure cannot overwrite cancellation and settles eligible descendants.

Completion retains up to two Markdown artifacts, eight memory references and two reviewed skill
references. It verifies current revisions/digests and all Owner corrections before committing the
Bot reply, artifact metadata, terminal state and audits together. A lesson is stored only as a
pending proposal; reaching the existing 50-pending cap does not undo delivery. The trusted file
port owns bytes and orphan cleanup; SQL metadata alone cannot prove a physical file exists.

The owned acceptance gate now includes 24 new lifecycle/SDK checks (95 total): real contention,
revocation/cancel versus completion, exact-once publication, audit rollback, context cutoff and
actual TS readback. Four cases run the separately installed SDK subprocess against real database
ports and deterministic model responses, including a real report file and late-result refusals.
The value comparator adds 40 actual TS cases and verifies all 20 failure messages.
The CI lane bootstraps both interpreters; the combined gate refuses a missing SDK environment.

This is an internal control adapter. Public task dispatch, production tool/model/approval ports,
realtime events and restart recovery remain unfinished. The default backend is unchanged.

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

## Independent work-domain admission (S3 foundation)

Opt in with `OPENBOT_CONTROL_AUTHORITY=work` against an explicitly prepared reference database
including migrations `0027` and `0028`; startup verifies history and never applies migrations. This mode
retains the prior reference routes. It does not enable an execution dispatcher or select an engine.
`/health` reports `s3-work-admission-reference`; the default mode/backend is unchanged.

| Command | Committed behavior |
| --- | --- |
| `POST /api/v1/tasks` | `{botId, objective, tokenLimit, requestKey}` creates one Task, first Run, pending engine handoff and event atomically; returns 202/queued. Same key/content reads existing state, changed content returns 409. No Channel required. |
| `GET /api/v1/tasks/{task_id}` | Owner-only consistent snapshot: revision, Runs, Actions, usage, attention and last 100 events; `eventsTruncated` exposes truncation. No live event stream yet. |
| `POST /api/v1/actions/{action_id}/decision` | `{intentDigest, approved}` binds to the exact stored Action, current authority generation and DB expiration; conflicting/stale decisions return 409. |
| `POST /api/v1/tasks/{task_id}/cancel` | `{}` closes new admissions; unresolved admitted Actions retain reservations. Terminal cancellation waits for trusted reconciliation. It never claims an external effect was undone. |
| `POST /api/v1/actions/{action_id}/reconcile` | `{intentDigest, requestKey, expectedSequence, reason}` records an Owner request to look up an existing unknown Action. It returns 202 with a durable command; delivery and verified completion are separate facts. Repeating the key returns the same command. It never repeats the external write. |

Writes require the current Owner session and exact allowed Origin. Control-only methods propose,
reserve and record independently verified outcomes; no client/Runtime/Worker resolution endpoint
exists. A model/tool call ID is not a deduplication guarantee. Digest/receipt shape validation does
not verify an external fact. Only trusted adapter verification may feed `resolve`.

Task-row locking serializes reservations across Runs and makes events/usage/outcome atomic. Unknown
outcomes retain their reservation. Verified actual overuse remains recorded and blocks new spend.
The current slice bounds Actions to 256, canonical intent JSON to 16 KiB and approval lifetime to
one hour; these are reference limits, not a complete pricing or resource budget implementation.

Ten new owned-PostgreSQL cases pass within the 105-case control integration gate. The new public
routes use ASGI TestClient against real PostgreSQL; closing/reopening that client preserves state.
At the admission checkpoint this did not prove live TCP/browser reconnection, engine crash recovery,
actual effect verification or artifact publication. The publication slice below adds real HTTP/file
evidence; the complete engine/executor journey remains open.
See [research](../../docs/research/work-domain-admission.md).

Migration `0029` adds bounded reconciliation commands and idempotent request keys to the explicit `work` mode. A pending command remains discoverable after delivery so an older engine snapshot can receive it again; a second notification only requests a receipt lookup. A missing, malformed or mismatched receipt keeps the Action unknown and its reservation intact. Only a trusted adapter can record independently verified facts, including after cancellation or revocation, without restoring execution authority. See [reconciliation research](../../docs/research/work-reconciliation-commands.md).

### Attempt ownership and artifact publication

Control-owned engine adapters must obtain a `WorkFence` with `claim` before proposing/admitting
Actions or completing work. A new claim ID advances the Run epoch; replaying an old ID never
renews its lease or regains ownership. Claims last 1–300 seconds, maximum 10,000 per Run in this
reference. This is database write fencing, not a scheduler or a guarantee against stale external
HTTP requests. Admission still checks current Task authority, exact approvals and shared budget.
The engine integration must arrange bounded attempts; there is no lease-renewal loop in the store.

Set `OPENBOT_CONTROL_ARTIFACT_ROOT` in explicit `work` mode to an existing absolute, private
control-owned POSIX directory (0700). A configured invalid directory fails startup; an unset root
leaves submission/approval available but cannot publish/download files. Never mount this directory
into an untrusted execution environment. Publication uses immutable content keys, file/directory
flushes and actual readback. The first reference bounds eight files per completion, 8 MiB each;
format processing and semantic result verification belong to trusted task-specific adapters.

The trusted `complete` port rechecks the current epoch, claim expiry, Task revision and authority,
requires all proposed Actions to be confirmed applied and no unfinished sibling Run, verifies the
actual bytes, then commits Artifact metadata, summary, terminal state and event together. A same-
content retry returns the already-published projection; different content conflicts. This slice
has no partial/waived-action transition. A Runtime final answer or fabricated receipt is insufficient;
there is no public complete/resolve API. `resolve` remains a separate trusted reconciliation port
and can record an already-admitted effect after revocation without permitting new execution.

`GET /api/v1/artifacts/{artifact_id}` authenticates the Owner, reads the database descriptor and
rechecks the file's exact size and SHA-256 before serving an attachment with encoded filename and
no-sniff headers. Missing/corrupt/nonregular/symlink files fail closed with no bytes served. A failed
SQL publication may leave an unreferenced blob, which is not exposed by this API; it is retained
rather than risking deletion of content referenced elsewhere. Quotas, orphan collection, full
backup/restore, power-loss/storage durability and Linux deployment qualification remain open.

New evidence includes real HTTP startup/restart, persisted approval, publication and authenticated
file download, plus transaction failures, superseded/expired attempts and concurrent claims. That
earlier publication-only gate used a trusted deterministic fixture and passed 119 owned database
cases separately from 810 package checks. These are historical results; current Temporal
integration and its limits are documented below. See [publication research](../../docs/research/work-artifact-publication.md).


### Accepted Worker startup context

`work_temporal_start.load_current_activity_task` reads the current Temporal activity's accepted
Task/Run through the existing binding gate, then reloads its Bot, objective and token limit under
the Task SHARE lock. It rechecks cancellation/revocation and exact Run state. The detached context
is input data, not a fence, budget reservation or tool grant; each effect still needs control
admission. Callers supply trusted namespace/queue/workflow settings, never a replacement Task ID
or SDK activity context.

`WorkStartPending` means the handoff remains unproven and returns no Task data; it does not prove
that a valid reservation exists. Temporal owns any bounded retry. The public journey reference
uses a separate startup policy (10-second attempts, 120-second total bound), preserving the
initial activity's identity and None result. Wrong start identity, closed authority and missing
Task/Run are terminal; model/tool retry policies do not change. See the [runnable reference](../../experiments/work-journey/README.md)
for Worker-before-acknowledgement and pending-cancellation checks. This opt-in boundary does not
activate a general product Worker, provider or default backend.

## Optional durable Worker composition

Install `requirements-worker.txt` in a separate Python3.12 environment when composing the
opt-in Temporal Worker. `openbot_server.work_worker.product_worker` requires a connected
`PydanticAIPlugin` client, the authoritative store, a trusted per-Run service loader and an
independent result verifier; it never imports test fixtures or enables a default Worker.
The bounded operator command is `python -I scripts/dispatch-work.py --config /absolute/operator.json`.
Use `--check` for local-only configuration validation. Explicit mTLS and private configuration
are required; there is no database migration, background polling or implicit account configuration.
See the [configuration and reproducible recovery cases](../../experiments/work-journey/README.md#product-worker-recovery-cases).


For deferred tools, provide both trusted `plan_effect(context, request)` and
`load_effect(context, stored_intent)` callbacks. The planner returns `DeferredPlan`; the loader
returns `EffectServices` for the original stored operation. Neither callback grants authority.
The control layer validates the catalog/schema and persists the complete proposal before public
approval. A preparation retry reads the original Action without replanning; execution after a
human wait uses a fresh Activity claim. Admitted or unknown Actions permit lookup only.

The same Workflow resumes with full SDK history and cumulative model usage only after verified
`applied` facts. Denial, expiry or verified non-application closes the Task as failed without
publishing an artifact. Cancellation/revocation cannot grant new execution. Owner reconciliation
commands retain separate persisted, delivered and verified-finished states. This optional path
does not provide a real Linux executor or switch the default backend.

### Closed-workflow reconciliation

Provide a trusted `load_lookup(historical_context, stored_intent)` returning
`LookupServices(lookup, verifier)` to register the command-scoped repair Workflow on the same
Worker. Run the existing operator CLI with `--repair-closed` for one bounded delivery pass.
It proves the original PG-recorded engine Run and repair start identities before lookup; it never
restarts the original Workflow or calls model, admission, apply or publication services. An active
original reports `waiting_original`; missing history remains unconfirmed. Exit0 covers delivered,
finished and waiting-original rows, including an empty pass, and does not mean effects succeeded.

Bad, missing or timed-out evidence leaves the Action unknown and reserved. A completed unresolved
command retains that outcome even if a later Owner command resolves the Action. A retry after a
committed resolution reads the original result without another lookup. Cancellation/revocation
allows historical settlement only. This opt-in path handles stored deferred-tool Actions; trusted
service configuration, product corrections and Linux isolation remain separate delivery gates.
See [validation](../../docs/research/work-closed-repair.md).

### Owner corrections (opt-in)

A trusted `product_worker(..., enable_corrections=True)` composition can accept
`POST /api/v1/tasks/{taskId}/corrections` after its Run has loaded. Send the Owner session,
allowed Origin, and `{runId, requestKey, expectedSequence, instruction}`. Sequence starts at0;
there are at most8 commands per Run, each instruction at most4096 UTF-8 bytes. The HTTP body
is bounded to32KiB, including JSON escaping. Reusing a key within the same Task returns only
the identical command. Unsupported existing Runs refuse commands; the default profile stays off.

202 means the command is stored, not that the model obeyed it or completed the Task. The
control layer freezes each segment's context and supersedes only proposals that were never
admitted. Prior approval is not permission to execute a superseded proposal. Admitted/unknown
operations retain their original identity and reservation; recovery may inspect their receipts
but cannot repeat a write. New proposals and final publication must match the consumed context.
Cancellation and revocation still close admission; historical readback does not restore authority.

This profile rejects inline executors on every service-factory invocation, including after restart.
Use the deferred-tool control boundary, and pass `context.correction_token` as `correction_context`
to `execute_model_activity`. The trusted result verifier receives the same frozen token. SDK
continuations keep full history and shared usage within the existing256KiB message/request bounds;
correction acceptance does not waive those limits or guarantee semantic compliance. There is no
new backend default, correction UI or live service configuration in this increment.
