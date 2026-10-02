# Local API

[English](API.md) · [简体中文](API.zh-CN.md)

OpenBot Server exposes the control-plane API. Development defaults to
`http://localhost:3001`. Except for health, session status, login, and Node enrollment exchange,
every `/api/v1` route requires an authenticated local Owner Session. Do not expose the Server,
PostgreSQL, or a Worker Host management port directly to the public internet; use private-network
HTTPS for remote access.

## Endpoint map

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Server liveness |
| `GET` | `/api/v1/auth/session` | Read the current Owner Session state |
| `POST` | `/api/v1/auth/login` | Create an Owner Session with the deployment password |
| `POST` | `/api/v1/auth/logout` | Revoke the Session and clear its cookie |
| `GET` | `/api/v1/bootstrap` | Lightweight counts and phase information |
| `GET` | `/api/v1/workspace` | Project channels, Bots, Nodes, Runs, approvals, progress, artifacts, and counts |
| `GET` | `/api/v1/runs/:runId/progress` | Exact public checkpoint count and ordinal-selected steps |
| `GET` | `/api/v1/workspace/events` | Subscribe to global Node, Run, and approval changes over SSE |
| `GET` | `/api/v1/channels` | List channels and Bot rosters |
| `POST` | `/api/v1/channels` | Create a channel and atomically add its initial Bots |
| `POST` | `/api/v1/channels/:channelId/bots` | Add an existing Bot to a channel |
| `PATCH` | `/api/v1/channels/:channelId` | Rename a group channel (audited) |
| `DELETE` | `/api/v1/channels/:channelId` | Permanently delete a channel's content and keep a tombstone |
| `POST` | `/api/v1/channels/:channelId/read` | Mark a channel read for the Owner |
| `GET` | `/api/v1/channels/unread` | Unread Bot/system message counts per channel (capped at 99) |
| `GET` | `/api/v1/audit` | Newest audit events with an allowlisted projection |
| `GET` | `/api/v1/channels/:channelId/messages` | Read message pages (before/limit, max 100) and reply relationships |
| `POST` | `/api/v1/channels/:channelId/messages` | Persist an Owner message and create a queued Run atomically |
| `GET` | `/api/v1/channels/:channelId/runs` | Read the latest 50 channel Runs |
| `GET` | `/api/v1/channels/:channelId/events` | Subscribe to channel events over SSE |
| `POST` | `/api/v1/approvals/:approvalId/decision` | Approve once or reject one pending action |
| `GET` | `/api/v1/artifacts/:artifactId/content` | Read an authenticated artifact; currently PNG only |
| `GET` | `/api/v1/runs/:runId/frame` | Read a Run's latest short-lived frame |
| `GET` | `/api/v1/bots` | List Bots |
| `POST` | `/api/v1/bots` | Create a Bot and its initial evolution event |
| `POST` | `/api/v1/bots/quick` | Atomically create a default Bot and its direct conversation |
| `PATCH` | `/api/v1/bots/:botId` | Rename a Bot and its direct conversation (audited) |
| `DELETE` | `/api/v1/bots/:botId` | Permanently delete a Bot's content and grants and keep a tombstone |
| `GET` | `/api/v1/bots/:botId/profile` | Read the complete Employee profile projection |
| `PATCH` | `/api/v1/bots/:botId/profile` | Update role and biography at an expected revision |
| `POST` | `/api/v1/bots/:botId/memories` | Create one bounded Owner memory |
| `PATCH` | `/api/v1/bots/:botId/memories/:memoryId` | Update one memory at an expected revision |
| `DELETE` | `/api/v1/bots/:botId/memories/:memoryId` | Delete one reviewed memory at an expected revision |
| `POST` | `/api/v1/bots/:botId/skills` | Register candidate skill metadata for Owner review |
| `POST` | `/api/v1/bots/:botId/skills/:skillId/state` | Verify, suspend, or permanently revoke a skill |
| `GET` | `/api/v1/bots/:botId/export/preview` | Preview a sanitized Employee template and all exclusions |
| `GET` | `/api/v1/bots/:botId/export` | Download the exact reviewed template instance using `If-Match` |
| `POST` | `/api/v1/employees/import/preview` | Strictly inspect a template in quarantine without writes |
| `POST` | `/api/v1/employees/import/activate` | Revalidate reviewed input and create a zero-authority Employee |
| `GET` | `/api/v1/nodes` | List currently connected Worker Hosts |
| `GET` | `/api/v1/node-identities` | Read enrolled Node metadata without secrets or digests |
| `POST` | `/api/v1/nodes/enrollment-tokens` | Issue a short-lived, single-use token for one exact Node id |
| `POST` | `/api/v1/nodes/enroll` | Exchange a one-time token for a per-Node credential |
| `POST` | `/api/v1/nodes/:nodeId/revoke` | Revoke one Node and disconnect its active session |

## Owner Session and request security

Login body:

```json
{
  "password": "the OPENBOT_OWNER_PASSWORD value"
}
```

Loopback HTTP development uses an `openbot_session` cookie. HTTPS uses the host-only
`__Host-openbot_session` cookie. Both are `HttpOnly`, `SameSite=Strict`, and `Path=/`; the HTTPS
variant is also `Secure`. PostgreSQL stores only the random session token's SHA-256 digest, never
the token or deployment password.

Every mutating request must send an `Origin` that exactly matches either its own request origin or
an entry in `OPENBOT_ALLOWED_ORIGINS`. Browser CORS access remains limited to the configured list;
the Desktop main process uses the same-origin case only after the user verifies and natively
confirms that Server origin.
Non-loopback origins require HTTPS and `OPENBOT_SECURE_COOKIES=true`; an unsafe configuration
stops the Server before it listens. The deployment password must contain at least 15 characters.
Five attempts in five minutes block the same client bucket for five minutes; PostgreSQL serializes
and preserves the bucket across Server processes and restarts. The bucket uses a domain-separated
digest of the direct peer IP. One `Forwarded: for=...` hop is accepted only when that direct peer
equals `OPENBOT_TRUSTED_PROXY_ADDRESS`. This is pseudonymous abuse resistance, not per-device
identity, so the Server still belongs on a trusted private network.

Channel and workspace SSE subscribers each have a 128-event pending bound. The Server terminates
an overloaded subscriber; the Client reconnects and reloads the authoritative database snapshot
instead of pretending a dropped stream is continuous.

## Owner password and sessions (C2)

- `GET /api/v1/auth/sessions` returns `{ sessions: [{ id, userAgent, current, createdAt, expiresAt }] }`
  for active Owner sessions, newest first (maximum 100). IDs are non-bearer session IDs; no tokens,
  digests or IP addresses are returned. `userAgent` is an untrusted hint bounded to 256 code points;
  old sessions have an empty hint. Login refuses issuance above 100 active sessions.
- `POST /api/v1/auth/sessions/revoke-others` requires the current cookie and exact allowed Origin.
  Returns `{ revoked: number }`, keeps the initiating session, and atomically audits
  `OWNER_SESSIONS_REVOKED` with the count. No body is required.
- `POST /api/v1/auth/password` requires the cookie, exact Origin and JSON
  `{ currentPassword, newPassword }`. No unknown fields; no whitespace trimming. Current password:
  1–1024 code points; new password: 15–1024, excluding the example password. The existing 8192-byte
  request bound applies. Success returns `{ changed: true, reauthenticationRequired: true }`,
  clears the cookie, atomically revokes **all** sessions and records `OWNER_PASSWORD_CHANGED`.
  Wrong current password is 401, throttled attempts 429 (`Retry-After`), invalid input 422,
  unknown/revoked session 401 and storage/audit failure 503 without mutation or cookie clearing.

Rotated credentials use salted stdlib scrypt (N=32768, r=8, p=3) in PostgreSQL. The environment
password is bootstrap-only once a stored credential exists; restart never restores it. Credential
revision and a shared transaction lock reject a login proof computed before password rotation.
Back up `owner_credentials` together with the existing database. No password recovery or device
identity verification is implied; an Owner locked out of a deployment must use its administration path.

## Bots and Employee profiles

Create a Bot:

```json
{
  "name": "Ops",
  "role": "Browser operations and daily workflows",
  "computerProfile": "docker-linux"
}
```

`computerProfile` is one of `none`, `docker-linux`, `macos-cua`, `lume-vm`, or `coder`. Names are
unique in the local workspace. Creation writes the Bot and an immutable `created` evolution event
in one transaction; a Bot is the Employee identity, not a second wrapper around one.

`GET /api/v1/bots/:botId/profile` returns:

- `employee`: identity, role, state, appearance, and fixed execution configuration;
- `details`: descriptive biography, Server revision, and last update time;
- `evolution`: append-only, source- and evidence-backed changes;
- `skills`: versions, dependencies, capability requirements, state, and confidence;
- `memories`: typed Owner records with sensitivity, portability, provenance, and revision;
- `memoryEvents`: content-free memory lifecycle audit rows;
- `records`: recent Runs, approvals, artifacts, and structured decision summaries;
- `statistics`: result counts across the latest 50 Runs and verified skill count;
- `configuration`: execution profile and portable package format.

Decision records come only from persisted `RUN_PROGRESS` events. They expose stages,
observations, concise action explanations, and next actions—not hidden chain-of-thought, provider
tokens, prompts, or secrets. Skill confidence and memory portability never grant Worker Host
authority.

### Update descriptive profile details

`PATCH /api/v1/bots/:botId/profile` accepts only the complete role and biography plus the revision
the Owner inspected:

```json
{
  "role": "Evidence reviewer",
  "description": "Review evidence and document limitations before reporting conclusions.",
  "expectedRevision": 1
}
```

The Server trims both strings, requires a non-blank role of at most 160 characters, and limits the
biography to 2,000 characters. A stale revision returns `409`; an unchanged update or an
authority-bearing extra field returns `422`. The successful transaction increments the revision
and appends an evolution event that stores changed field names, not biography text. Workspace SSE
then publishes only the Employee id and affected sections. Name, model policy, Worker Host,
appearance, skill state, and permission grants are deliberately outside this command.

## Server general preferences (C7)

`GET /api/v1/settings/general` returns `{revision,timezone,defaultModel,updatedAt}` to the authenticated
Owner. `PUT /api/v1/settings/general` requires the exact allowed Origin and a strict JSON body up to
2 KiB: `{expectedRevision,timezone,defaultModel}`. Revision is an integer 1–2147483647; stale writes
return `409 owner_preferences_revision_conflict`. Timezone is a bounded IANA key validated against
Server ZoneInfo, with default `UTC`; a malformed/unknown zone returns 422. Default model is explicitly
null or the existing `{connectionId,modelId}` selection. No key, endpoint, command or unknown field is
accepted. The getter deliberately retains a stale selection so the Owner can clear or replace it.

The singleton and `SETTINGS_OWNER_UPDATED` audit publication share one Owner transaction. No-op writes
retain their revision. Audit records only changed field names and revision, not credentials. Timezone
supplies the Owner display default; existing API instants remain UTC and existing schedules are not
reinterpreted. The caller formats those instants using the returned timezone.

Creation of a new Bot with profile `model` or `docker-linux` and an omitted model reads this default
in the identity transaction. An explicit model wins. A profile such as `none` never inherits model
capability; existing Bots are unchanged. Resolve the current enabled connection, endpoint policy and
credential before creation/evolution/audit commit. A missing, disabled or unavailable default fails
closed without publishing a Bot; it never falls back to another model. Setting a default performs no
provider network request, discovery, inference or billing operation.

Migration `0046_owner_preferences` introduces the seeded singleton (revision 1, UTC, null model).
Its independent PR and C2 both append to the current migration journal; rebase/re-index the second
migration PR against the first merged migration before merging it. Never replace committed history.

## Owner-managed memory

The first memory lifecycle is manual and Owner-only. Models, Providers, and Worker Hosts do not
have these commands. Titles are limited to 160 characters and content to 8,000 characters.
Unknown fields fail strict parsing. Credential-like values and private-key material are rejected;
store only an opaque vault reference such as `vault://operations/email`.

Create a memory:

```json
{
  "kind": "semantic",
  "title": "Preferred report format",
  "content": "Use a short summary followed by a source table.",
  "sensitivity": "internal",
  "portability": "owner-selectable"
}
```

`kind` is `working`, `episodic`, `semantic`, `procedural`, or `secret-reference`.
`sensitivity` is `public`, `internal`, `confidential`, or `restricted`. Owner commands may set portability only to
`never` or `owner-selectable`; `included` is rejected because every `openbot.employee/v1` package
contains zero memories. A `secret-reference` must be `restricted` and `never` portable, and its
content must be a reference rather than a credential value.

Update a memory:

```json
{
  "expectedRevision": 1,
  "content": "Use a five-line summary followed by a source table."
}
```

At least one field must change. The update succeeds only if `expectedRevision` is current, then
increments it. A stale edit returns `409` without changing the record.

Delete a memory:

```json
{
  "expectedRevision": 2,
  "ownerReviewed": true
}
```

Deletion requires a distinct reviewed command and the current revision. It physically removes the
memory row. The same transaction appends a lifecycle event containing only Employee id, memory id,
action, revision, changed field names, actor, and time; it never retains title, content,
provenance, or a content hash. Semantic/full-text retrieval, retention schedules, autonomous active-memory writes,
version restoration, and selective export remain unimplemented.

## Skill metadata review

`POST /api/v1/bots/:botId/skills` creates only `candidate` metadata. Slugs use the Agent
Skills-compatible lowercase letters, numbers, and hyphens subset, up to 64 characters; description
is required and limited to 1,024 characters. Dependencies must already be verified skills owned by
the same Employee.

```json
{
  "slug": "source-triangulation",
  "name": "Source triangulation",
  "description": "Compare independent primary sources before reporting a conclusion.",
  "version": "1.0.0",
  "source": "learned",
  "requiredCapabilities": ["browser.observe"],
  "dependencySkillIds": [],
  "evidence": [{ "kind": "run", "id": "run-reference" }],
  "reason": "Repeated successful Runs produced a reusable procedure."
}
```

The state command accepts `verified`, `suspended`, or `revoked`. Every transition requires a
non-empty reason and literal `ownerReviewed: true`; verification also requires confidence from 1
through 100. Revocation is terminal. Concurrent transitions return `409` instead of overwriting
the earlier review. The Employee profile now exposes the stored description, source, version,
required host-capability names, dependencies, and evidence references before showing only the
transitions valid from the current state. Permanent revocation uses a separate confirmation form.

```json
{
  "state": "verified",
  "confidence": 88,
  "reason": "The Owner reviewed the procedure and evidence.",
  "ownerReviewed": true,
  "evidence": [{ "kind": "manual", "id": "owner-review-1" }]
}
```

These endpoints manage profile metadata only. They do not install or execute `SKILL.md`, change a
Node, route work, alter approval policy, or grant tools.

## Reviewed plugin catalog (C8)

`GET /api/v1/plugins/catalog` authenticates the Owner and returns the bounded versioned catalog:
`{format:"openbot.reviewed-plugin-catalog/v1",revision,entries}`. It accepts no query parameters and
performs no remote discovery or installation. Each entry has a slug `id`, bounded `name`/`description`,
`distribution` (`self-hosted-template|self-hosted`), exact `version`, SPDX-style `license`, HTTPS
`sourceUrl` containing its 40-character `sourceCommit`, 1–16 source `files` with SHA-256, and
`review:{status:"reviewed",reviewedAt,reviewedBy,record,scope}`. Protocol/domain export schemas/types.

Only explicit reviewed records enter the response. Maximum source size is 64 KiB, maximum entries
32; duplicate JSON keys, IDs or paths, unreviewed/rejected records, unknown credentials/endpoint fields,
unsafe source URLs and malformed digests fail the whole source with `503 plugin_catalog_unavailable`.
The bundled source contains the actually reviewed OpenBot notebook developer template, including
its exact main source commit and hashes. It requires separate hosting/endpoint setup and explicit
live manifest review/grants; a catalog entry grants no permission and is not an installation.

An operator may set `OPENBOT_PLUGIN_CATALOG_PATH` to an exact absolute private owner-controlled
regular file in the same format. It is read with the existing bounded owned-file helper; renderer,
Worker, model and imported plugin content cannot choose that source. A broken source is not presented
as a successful empty catalog. No remote third-party service is claimed reviewed: the attempted
public documentation MCP review was refused by the retained non-public-DNS boundary in this environment.

## Employee export, import, and activation

Export preview is generated from the same canonical package preparation path that download uses.
It creates one fresh `packageId` and `generatedAt` and returns a `downloadReviewToken`. That token
is the opaque value of the target download representation's strong entity tag: the SHA-256 digest
of the exact pretty-printed JSON bytes, including the DSSE envelope when signing is configured. It
is not a credential or authority grant. Its
`employee` projection contains the exact name, role, optional descriptive biography, and appearance
selected for the template; its ordered `skills` projection contains every selected verified skill's
slug, name, Agent Skills description, version, capability requests, and dependency slugs.
`employeeName` remains a deprecated v1 compatibility alias for `employee.name`. The preview also
lists the checksum, exclusions, and blockers. The v1 template structurally excludes source identity,
ownership, all memories, Runs, evolution,
decisions, artifacts, approvals, Node identity, host binding, credentials, sessions, and authority.
Free text is scanned for credential-like values, bearer tokens, private keys, and local paths.
Every exported verified skill must also have all of its skill dependencies inside the same verified
set. An excluded or unknown dependency produces an `excluded-skill-dependency` finding rather than
being silently omitted. A blocked export returns `422`.

Download must return the reviewed `packageId` and `generatedAt` as query parameters and the
preview's `downloadReviewToken`, quoted as one strong entity tag, in `If-Match`:

```http
GET /api/v1/bots/{botId}/export?packageId={uuid}&generatedAt={encoded-ISO-8601}
If-Match: "{downloadReviewToken}"
```

The Server rebuilds the candidate from its current authoritative profile and publisher state with
that exact package identity. It returns the file only when the complete serialized bytes still
match. Missing review state returns `428 Precondition Required`; malformed or weak tags return
`422`; changed content or publisher state returns `412 Precondition Failed` and requires a fresh
preview. The Client refreshes the preview but never retries the download automatically. All
preview, error, and download responses are `Cache-Control: no-store`. Before creating a browser
download, the Web Client also requires the matching response `ETag` and recomputes SHA-256 over the
received `Blob`; a mismatch produces no file.

The advisory download filename is a bounded lowercase ASCII slug with a fixed JSON suffix. Path,
control, quoting, and extension input from the Employee name is removed; Windows device names such
as `CON`, `NUL`, `COM1`, and `LPT1` are disambiguated. This keeps one deterministic fallback valid
across Windows, macOS, and Linux while the package retains the Employee's full display name.

Unsigned export uses `application/vnd.openbot.employee+json`. When the optional Owner publisher
keyring is configured, export uses `application/vnd.openbot.employee.dsse+json` and a DSSE/Ed25519
signature over the exact package bytes. A package key id is only a lookup hint; trust comes from an
explicit Server trust store and successful verification. See [Employee signing](EMPLOYEE_SIGNING.md).

Import preview accepts one v1 template or DSSE envelope, up to 2 MiB. It validates strict schema,
signature when present, checksum, skill dependencies and capabilities, sensitive text, and current
Worker Host compatibility. A successful preview is still read-only quarantine: it creates no Bot,
skill, memory, host binding, or authority. Its `employee` projection includes the name, role,
optional biography, and appearance that were checked in the package. Clients should show the
biography and `requestedCapabilities` before confirmation and must describe both as untrusted input,
not as granted authority. Each `skills` item retains its required Agent Skills description,
version, requested capabilities, and dependency slugs so the Owner can review what will become a
disabled candidate; no executable skill files are present in v1.

Activation body:

```json
{
  "package": {},
  "expectedPackageId": "uuid-from-preview",
  "expectedDigest": "sha256-from-preview",
  "ownerReviewed": true,
  "allowUnsigned": false,
  "idempotencyKey": "new-request-uuid",
  "employeeName": "Optional local name"
}
```

Activation repeats every preview check and binds the reviewed package id and canonical digest. For
a signed package, that digest includes the authenticated publisher key id, so substitution by a
different trusted publisher also requires a new review. Cosmetic JSON whitespace is not identity.
Unsigned input requires `allowUnsigned: true`. One PostgreSQL transaction creates a fresh Employee id, imports
skills as `candidate` with confidence `0`, appends an `imported` evolution event, and stores an
immutable receipt. It imports no memory, history, credential, session, Node binding, capability, or
authority. An exact idempotent retry returns the original receipt; changed reuse or a duplicate
package id returns `409`.

## Rename, delete, read state, and audit

[ADR-0047](decisions/0047-identity-lifecycle-and-read-state.md) defines these Owner routes. Rename
bodies are `{ "name": string }` with the create limits (Bot 1–64, channel 1–80 UTF-16 units after
trimming); unknown keys are stripped. A live duplicate returns `409 name_already_exists`; direct
conversations follow their Bot and return `409 direct_channel_identity_follows_bot`.

Delete removes content but keeps the row as a tombstone so Runs, Work, approvals, and audit still
resolve it. A channel delete removes messages that no durable Work references (referenced messages
keep their row with a fixed placeholder), reactions, membership, automations, and read state. A Bot
delete also removes its direct conversation, memberships, automations, memories, skills, knowledge
proposals, evolution rows, and plugin grants. Any active Run returns `409 active_work_blocks_delete`;
the Server never cancels work on a delete's behalf. The Bot response includes
`pluginGrantsRemoved`; `false` means the encrypted grant file could not be updated after the
tombstone committed, leaving inert grants for a Bot that can no longer run. Both delete responses
include `attachmentsRemoved`; `false` means the channel's attachment files could not be removed and
remain on disk, unreadable through any live route. Tombstones answer `404`
at every live entry point and their names can be reused.

`GET /api/v1/channels/unread` returns `{ "unread": { channelId: count } }` for channels with Bot or
system messages after the Owner's last `POST .../read`. `GET /api/v1/audit?limit=1..100&before=<nextBefore>`
returns `{ events, nextBefore? }`; `nextBefore` is an opaque keyset cursor (exact time and event id,
so events written in one transaction are never skipped); each event carries type, time, ids, current or tombstoned names,
and only allowlisted scalar payload keys (never message text).

## Audit categories and CSV (C3)

`GET /api/v1/audit` additionally accepts `category`: `authentication`, `settings`, `hosts`,
`approvals`, `channels`, `bots`, `runs`, `plugins`, or `other`. Omit it for all categories.
Every event includes its Server-assigned category. Filtering happens in SQL before the existing
exact-time/ID keyset pagination; unknown/duplicate query keys, categories and malformed bounds
return 422. JSON pages remain limited to 1–100 events.

`GET /api/v1/audit/export` accepts the same category/cursor and `limit=1..1000` (default 1000).
It downloads UTF-8/BOM CSV (`openbot-audit.csv`), quoted with CRLF rows. Columns are `id`,
`createdAt`, `category`, `type`, channel/Bot IDs and names, `runId`, and allowlisted `details`.
Formula-like cell prefixes are escaped with an apostrophe. Owner authentication and no-store
apply; raw prompts, keys, tool arguments and network digests never enter the export. Each page
is bounded to 4 MiB. A non-final page exposes `X-OpenBot-Next-Before` (also exposed via CORS);
pass it as `before` and concatenate parsed rows to export a larger history. Do not repeat CSV
headers/BOM when assembling pages. The export is paginated history, not a transaction-wide archive.

Login success/failure and logout append `AUTH_LOGIN_SUCCEEDED`, `AUTH_LOGIN_FAILED`, `AUTH_LOGOUT`
without secrets; rejected, already-throttled attempts do not create unbounded audit rows.
Login auditing shares the C2 credential-revision check and session transaction, retaining the bounded
user-agent hint. Audit storage failure returns 503 without issuing a cookie or committing a session
or throttle mutation.
Final legacy model-setting publication audits `SETTINGS_MODEL_UPDATED` in its authority
transaction; audit failure restores the private file. Existing model-connection events remain.
Worker enrollment/revocation and real connection/disconnection append `WORKER_HOST_*`; private
identity digests stay in the identity ledger. Connected-event failure refuses availability;
physical disconnect cleanup still completes if audit persistence fails and logs a fixed error.

## Channels, Runs, and approvals

Create a channel:

```json
{
  "name": "Operations",
  "description": "Daily operations with durable context",
  "botIds": ["00000000-0000-4000-8000-000000000001"]
}
```

The channel and initial roster are one transaction. Any unknown Bot rejects the entire request.

Create a task:

```json
{
  "content": "Open the test page and take a screenshot.",
  "botId": "optional-channel-member-id"
}
```

Content is trimmed and limited to 1–8,000 characters. The Server atomically stores the human
message, one `queued` Run, and matching events. An explicit `botId` must belong to the channel.
Without one, routing deterministically prefers a Chief/coordinator role and otherwise uses stable
roster order. A Run freezes the selected Bot's execution profile; Client, model, and Node cannot
change it mid-run.

A compatible Node receives an offer only when exact capability-major and capacity requirements
match. Offer/accept is not enough: the Server must persist conditional assignment and confirm it,
then persist explicit start before execution. An assigned Run can return to `queued` after a
disconnect; a running Run fails because its external side effects are unknown and are not retried
automatically.

`run.failed` carries one allowlisted code and a generic message. The current codes are
`provider_unavailable`, `provider_execution_failed`, `artifact_persistence_failed`,
`execution_interrupted`, `node_disconnected`, `approval_policy_denied`, and `dispatch_failed`.
The Server maps the code to its own message and discards Node-supplied failure text before writing
Run state or events. Provider exception messages, stack traces, tokens, and local paths are never
part of the public failure contract. A swallowed background dispatcher failure instead writes one
bounded `DISPATCH_FAILED` audit fact with the Run, authoritative Node if assigned, phase, and public
code; failure to write that secondary fact is logged once and is not recursively audited.

Approval decisions use `{ "decision": "approve" }` or `{ "decision": "reject" }`. Only a pending,
unexpired approval may be decided, and only once. Approval resumes a Run; rejection or expiry
blocks it. The current handshake does not yet issue a separately verifiable single-use capability
lease, so only trusted-private-network test Providers are appropriate.

## Owner additional approval settings (C4)

`GET /api/v1/settings/approvals` returns `{revision,productRead,publicWeb,exceptions,
protectedExceptionCategories}`. `PUT` requires Owner Cookie and exact Origin, a strict JSON body
≤16KiB `{expectedRevision,productRead,publicWeb,exceptions}`. Modes: `inherit` (adapter minimum)
and `required` (additional confirmation) for the two built-in Work categories. Revision conflicts
return409 `approval_policy_revision_changed`; missing/corrupt storage returns503. Same-value writes
keep the revision; changes atomically audit `SETTINGS_APPROVAL_UPDATED` with mode/count/revision,
without copying target URLs or attachment IDs. Types/schemas exported by protocol/domain.

Exceptions (≤64) are exact `{botId,category:"product_read"|"public_web",target:{kind,value}}`.
`channel`/`attachment` use canonical UUIDs; `page` uses an exact canonical HTTPS URL without query,
fragment, credentials, wildcards or literal IP addresses. Save validates live Bot and existing
non-deleted local target. Runtime still validates task access, original source, live identities,
public DNS/redirect/byte gates and exact immutable intent. No search/domain/prefix/file exception.

**Delete, installation and permission changes never allow exceptions.** `protectedExceptionCategories`
also includes command, browser, plugin and unknown, whose current minima are unchanged. An exception
only removes extra Owner confirmation; adapter mandatory approval can never be removed. There is
no global auto-approve or grant-changing endpoint. Direct Owner operations keep their existing gates.

Proposal computes added approval transactionally; admission and built-in read/web dispatch recheck
current settings. Revocation/tightening refuses unapproved auto Actions with409
`approval_policy_changed`, requiring a fresh proposal; relaxing settings preserves pending decisions.
Already approved exact Actions and historical receipt recovery remain valid. A web request already
sent before a policy commit may finish; policy does not cancel remote effects or authorize replay.
See [ADR-0049](decisions/0049-owner-approval-policy.md). Independent C2/C7/C4 migrations must be
rebased/reindexed after the first merges; no committed migration history is overwritten.

## Realtime and private media

Channel SSE emits `channel.ready`, `message.created`, `run.created`, `run.updated`, `run.progress`,
`run.frame`, and a 15-second `heartbeat`. The Web Client closes a stream after 35 seconds without
frames, reconnects after two seconds, reloads recent history, and merges entities by id and
`updatedAt`.

Workspace SSE emits `workspace.ready`, `node.upserted`, `node.removed`, `run.updated`,
`approval.updated`, and `employee.profile.changed`. The Employee event contains only `botId`, a
non-empty allowlisted `sections` array, and `occurredAt`; it is a content-free invalidation hint.
A Client viewing that Employee reloads the authenticated profile aggregate instead of treating SSE
as profile state. The Client also reloads the selected profile after `workspace.ready`, so reconnect
recovers missed mutations. Workspace SSE owns cross-channel status; channel SSE owns one channel's
conversation and Run details. This is a single-Server in-process broadcast. Multi-Server deployment
first requires a reviewed shared event and queue system.

Artifact and frame endpoints use the Owner Session, return `private, no-store`, and set
`X-Content-Type-Options: nosniff`. The Web Client never receives the internal storage key. Frames
are PNG only, at most 2 MiB, held for at most 16 Runs, and expire after two minutes by default.

## Worker Host identity

Online Node projections include platform, OS version, architecture, device class, isolation,
trust tier, and a versioned capability manifest. Protocol `0.9.0` requires exact capability-major
matching on Server and Node. Unknown message fields, duplicate capabilities, invalid or oversized
identity metadata, and unbounded approval context fail closed.

One-time enrollment tokens expire after ten minutes by default and bind one exact Node id. A
successful exchange stores only a digest on the Server and returns an individually revocable
per-Node credential once. The current credential is still a copyable bearer secret—not mTLS or
proof-of-possession identity—so non-loopback Node connections require `wss:` and a trusted private
network. See [Node enrollment](NODE_ENROLLMENT.md).

## Employee browser lifecycle (C6 candidate)

`POST /api/v1/bots/{botId}/browser/maintenance` requires Owner cookie and exact allowed Origin,
and a strict JSON body up to 1 KiB: `{operation:"status"|"restart"|"clear",confirmation?:"clear-browser-data"}`.
Only `clear` requires the confirmation, and other operations reject it. Unknown fields and any path,
URL or command are rejected. Response: `{botId,nodeId,running:boolean,paused:boolean}`.

The Server requires an already bound original browser identity or an explicit operator Bot-to-Node
route; it never selects a replacement Host for maintenance. The original Worker must advertise
`browser.maintenance@1` and `browser.session@1` from the Docker Provider. Enable explicitly with
`OPENBOT_DOCKER_BROWSER_MAINTENANCE=true` plus existing sessions configuration. Default is off.
Status queries upstream health without starting a browser. Restart gracefully stops the original
browser, then starts it through the existing screenshot path without exposing its screenshot.
Clear deletes only that Bot's upstream browser profile and leaves the browser stopped.

Restart/clear persist an intent and invalidate all old viewer/Work observations before dispatch,
retain the Server pause and Provider latch on both success and uncertainty, and require a fresh Owner
takeover and explicit release before Agent work resumes. Origin, Owner expiry, route, credential and
exact socket identity are rechecked at dispatch and completion. Events record only operation/phase
and identity; no profile paths, cookies, page content or network details are returned. There is no
retry of uncertain effects. This direct Owner clear operation can never become an approval exception.

Retention settings are pending an explicit Server-deliverable versus Desktop-local data scope;
this candidate does not advertise or accept a setting that lacks actual enforcement.


The Owner deferred download/screenshot retention for this integration. No retention policy or
automatic deletion is enabled by these lifecycle methods.

## Error contract

| Status | Meaning |
| --- | --- |
| `401` | Missing, expired, or invalid Owner Session |
| `403` | A mutating request has neither the exact request origin nor a configured exact-match Origin |
| `404` | The requested channel, Bot, Employee record, or Node identity does not exist |
| `409` | Name conflict, stale revision, already-decided approval, or changed/reused reviewed input |
| `413` | A request exceeds its transport-level size bound |
| `422` | Strict input, policy, package, compatibility, or sensitive-content validation failed |
| `429` | Login attempts are temporarily limited; follow `Retry-After` |

Error bodies include an `error` string. Schema failures may also include a bounded `fields` map.
Clients must not retry `409` or `422` blindly: reload the authoritative state, show the change to
the Owner, and ask for a new decision.

Every response carries a Server-generated `X-Request-Id`; browser CORS responses expose it. An
unexpected `500` also returns `code: "internal_error"` and that request id, while omitting the
exception message. Server and Node operational logs are structured JSON, honor
`OPENBOT_LOG_LEVEL`, and use allowlisted request/Run/Node fields. HTTP logs record the route path
without its query and never record headers, cookies, bodies, credentials, arbitrary error objects,
or stacks.

## Desktop platform settings and updates (C5)

The sandboxed `openbotDesktop` bridge adds `getPlatformState()`,
`setPlatformPreferences(preferences)`, `setUnreadBadge(count)`, `getUpdateState()`,
`checkForUpdates()`, `downloadUpdate()` and `installUpdate()`. These are native Desktop methods;
Web has no corresponding authority or HTTP endpoints. Types are exported by protocol and domain.

`DesktopPlatformPreferences` is an exact DTO: `launchAtLogin`, `runInBackground`,
`showDockBadge`, `automaticUpdates` (booleans) and `globalShortcut` (empty to disable, or a bounded
accelerator containing a command/control modifier). Defaults are false except `showDockBadge=true`.
The main process stores the versioned DTO in a private atomic file under its own userData directory.
Unknown fields, unsafe files and malformed shortcuts fail closed. Shortcut conflicts retain the old
shortcut; failed persistence rolls back startup, tray, shortcut and badge effects.

`DesktopPlatformState` reports `status`, `preferences`, native `capabilities`, and an optional fixed
`code`. Startup is available only in packaged macOS/Windows apps; Linux startup and Windows Dock
badges are unavailable. Background mode requires a tray; closing the last window hides it while
retaining the local Server, and the tray offers show/quit. A global shortcut reveals that same window.
Badges accept safe integers 0–99999, display at most 99, and clear when disabled or quitting.
Preference writes, downloads and installs require isolated-preload user activation and a focused
trusted top frame. IPC never accepts a command, executable path or update URL from the renderer.

`DesktopUpdateState.status` is `unavailable|idle|checking|available|downloading|downloaded|installing|failed`,
with an optional bounded `version`, `percent` and fixed error `code`. Automatic mode checks every
six hours and downloads verified updates; installation always needs native confirmation and a clean
local Server shutdown. Downgrades and automatic install on quit are disabled.

Executable updates use electron-updater 6.8.9 only in a signed packaged macOS/Windows app with a
regular bundled `resources/app-update.yml` (canonical JSON, a YAML subset, maximum 4 KiB). Its exact
fields are `openbotFormat="openbot.signed-updates/v1"`, `provider="github"`, `owner="Peerframe"`,
`repo="openbot"`, `channel="alpha"|"latest"` and either `macTeamIdentifier` (10 uppercase letters/digits)
or `publisherName` (1–8 Windows signer names). Unknown fields, custom feeds and missing signers are
rejected before constructing the updater. The running app must have a valid matching Developer ID
or Authenticode signature; the updater retains its download checksum and native signature checks.
Development, unsigned packages and missing configuration expose `unavailable`; Linux updates are
unsupported. Existing unsigned releases lack update metadata, so production download/install
qualification remains blocked on signed releases and metadata. This contract does not declare that
those releases have been produced or installed.


The Owner deferred production signed automatic updates for this integration. Unsigned packages
continue to report unavailable; native preferences can be used independently.

## Reviewed task knowledge

`modelUseEnabled` is an optional boolean on memory create/update and is returned on stored memory.
It defaults to false for new and migrated entries. It is independent of portability; only public or
internal non-secret-reference entries may be enabled. Updates require the usual expected revision.

- `GET /api/v1/bots/:botId/knowledge-proposals`: Owner-only pending list, at most 50, including
  Server-generated proposal ID, source Run ID, kind, title, content and timestamp.
- `POST /api/v1/bots/:botId/knowledge-proposals/:proposalId/review`: strict 16 KiB maximum body.
  Accept: `{decision:"accept", ownerReviewed:true, title, content, modelUseEnabled:boolean}`.
  Reject: `{decision:"reject", ownerReviewed:true}`. Titles 160 characters; content 2,000 characters
  and 8,000 UTF-8 bytes; credential values/private keys rejected. Cross-Bot or missing IDs return
  404; previously reviewed proposals return 409. Acceptance, new memory, provenance and audit commit
  together; review removes candidate text. The result has proposalId, decision and memoryId/null.

Models only prepare a proposal in the bounded native loop; they do not call these Owner endpoints.
Successful Run completion publishes the candidate atomically. See [Native Agent](NATIVE_AGENT.md).

## Channel activity (C1)

`GET /api/v1/channels` and `GET /api/v1/workspace` return `lastActivityAt` on each
Channel and optional `latestMessage: { id, authorType, preview, createdAt }`.
These fields are Owner-only and absent on channel mutation responses. `preview` is plain text,
at most 160 Unicode code points (640 UTF-8 bytes), truncated in SQL; no attachments, credentials,
metadata or extra message fields are projected. Clients must render it as text, never HTML.
An empty channel omits `latestMessage` and uses `createdAt` for `lastActivityAt`.
The list is ordered by activity descending, then channel ID in C collation ascending;
latest messages break equal timestamps by message ID in C collation descending.
Deleted channels are excluded. Existing session revalidation, row and response-byte limits apply.

## Quick Bot creation (C12)

`POST /api/v1/bots/quick` is Owner-only and requires a trusted Origin. Input is exactly
`{ "appearance": { "head": "round", "body": "classic", "mobility": "feet", "accessory": "none", "accent": "green" } }`.
Unknown keys, null and incomplete appearances return 422. It returns 201 `{bot, channel}` with
existing Bot/Channel shapes. The channel has `directBotId=bot.id` and `botIds=[bot.id]`.
Names are allocated among active Bots as `新建 Bot`, `新建 Bot 2`, … using the smallest free suffix;
deleted names are reusable. The fixed role is `通用助手`, status `idle`, computer profile `none`.
The C7 default model is copied into `bot.model` when configured and currently usable; no default
means the field is omitted. This selection is metadata; creation starts no host, work or inference.
A stale/disabled model default is rejected, with no partial identity. Identity, evolution, direct
conversation, membership and their three audit events commit together. This command creates a new
Bot on each successful request; clients must not retry an ambiguous network result automatically.
Name allocation examines suffixes 1–10001 and retries at most three conflicts with ordinary name
writes. Exhaustion/contention returns 409 `quick_bot_name_exhausted`/`quick_bot_name_contention`.
Existing session, Origin, body limits and sanitized storage/model errors still apply.

## Bot appearance accents (C10)

`BotAppearance.accent` accepts exactly `green`, `yellow`, `red`, `blue`, `violet`, `teal`,
`pink`, `slate`. Ordinary creation, quick creation, public identity/profile projection and
Employee template v1/v2 use this same set. Existing appearance fields and old templates remain
valid. Unknown/case-variant colours, arbitrary CSS strings, numbers and null are rejected.
Template import preserves the appearance under a new identity with unchanged quarantine/review
and digest validation. This contract adds colour data; avatar drawing and UI selectors follow
the separate step-15 design implementation.

## Run progress checkpoints (C13)

`GET /api/v1/runs/:runId/progress` is an Owner-session read of a run in an active channel.
It returns `RunProgressDetails` from `packages/domain`. Current product Runs count their existing
durable Work actions; historical unmapped Runs count persisted `RUN_PROGRESS` checkpoints.
`totalSteps` is the exact observed count, **not a planned future total or a model-token count**.
`currentStepNumber` is the latest recorded ordinal, or null for zero checkpoints. The workspace
adds `runProgress[runId]` summaries for its latest runs independently of its 200-event progress window.

Without `steps`, return all checkpoints up to 12; above 12 return ordinals 1–3 and the latest 6.
`?steps=4,5,6` selects up to 12 unique positive ordinals (1–9999999), sorted ascending. Missing
ordinals return no entry. Query duplicates, unknown parameters and invalid ordinals return 422.
Ordering is `created_at`, then ID with C collation; SQL numbers the entire run before selecting.
Summary and steps use one repeatable-read snapshot. A missing run/deleted channel returns 404.

`stageName` and `description` use only a bounded control-authored stage dictionary. Unknown stages
are null; provider messages, tool results and raw chain-of-thought are never read into this endpoint.
`waiting_approval` explicitly projects the approval stage; terminal runs have no current stage.
Work actions expose admission/resolution timestamps and `completedSteps` counts verified `applied`
outcomes; pending approval has no start/end timestamp and unresolved actions have no end. No model
request, action arguments or receipt bodies are read.
Run `startedAt`/`endedAt` come only from actual lifecycle audit events. A historical checkpoint's `startedAt`
is its observation time; `endedAt` is null because existing progress events do not prove when its
action ended. `plannedTotalSteps` is null because dynamic execution has no promised plan. Historical
`completedSteps` is null because checkpoint events do not prove completion. Do not display
`totalSteps` as a promised plan or treat every observed checkpoint as an action successfully completed.
Missing timestamps and failure codes are explicit nulls; never substitute creation/update times.

## Model connection dialog commands (C17)

All three commands retain Owner session, exact Origin and bounded JSON guards. API keys never
appear in public connection DTOs. Canonical migration `0049_model_connection_defaults` adds a
nullable default without rewriting old connections, ciphertext or Bot selections.

- `POST /api/v1/model-connections/verify`: `{presetId, baseUrl, apiKey}` → 200 `{models: string[]}`.
  The unsaved key exists only in this request. Reuse the existing exact endpoint allowlist and
  discovery-capable preset check; issue one bounded GET to the provider's models resource, never
  chat/inference. No connection, file, cipher envelope or audit event is created. No request key or
  upstream error body is logged/returned. Recheck Owner authority before send and before return;
  disconnect/deadline closes the request. Unsupported discovery/invalid credentials/redirects or
  invalid provider response fail with fixed 422 errors. At most 256 IDs / 2 MiB; no redirects or retries.
- `PATCH /api/v1/model-connections/:id`: `{expectedRevision, defaultModel: "model-id"}` sets the
  connection's public default; `defaultModel: null` clears it. Omitting defaultModel preserves it.
  Existing name/key/enabled patches remain compatible. Successful changes increment revision;
  stale revision or exhausted integer revision returns 409. Unchanged metadata preserves revision.
  Creation also accepts optional defaultModel. This metadata does not silently change existing
  Bots or the Owner's global default. Audit contains only changed field names and revision.
- `DELETE /api/v1/model-connections/:id`: JSON `{expectedRevision}` → 200 `{deleted: true, connectionId}`.
  Missing/invalid body returns 422; stale revision returns 409; absent connection returns 404.
  Environment-provided legacy connection remains read-only (422). If any active Bot, unfinished
  Run snapshot or Owner default refers to it, return 409
  `{error: "model_connection_in_use", bots: [{id,name}], runIds: [...], ownerDefault: boolean}`.
  A dependency read/validation/limit failure refuses deletion; no partial list authorizes it.
  The connection row lock serializes validated new selections against delete. Removing an unused
  saved connection and `MODEL_CONNECTION_DELETED` audit commit together; history/receipts remain.

Verify first, then explicitly save with the existing create command; verification does not save
or grant authority. Use fake providers for tests, never the paid `/test` inference endpoint.

### C18: older message pages

`GET /api/v1/channels/:channelId/messages?limit=100&before=<opaque-cursor>` retains the
existing Owner-session authorization. `limit` defaults to100 and must be a decimal integer1–100;
`before` is optional. Unknown or repeated query fields, empty/malformed/oversized cursors, and
cursors for another channel return422. Missing or deleted channels return404 after authorization.

Response: `{ "messages": [...], "hasMore": true, "nextCursor": "..." }`. With no cursor,
return the newest page. Each page is ascending by stored timestamp then ID with C collation.
Pass nextCursor as before to fetch strictly older messages and prepend that page. When no older
messages remain, hasMore is false and nextCursor is omitted; an empty page is
`{ "messages": [], "hasMore": false }`. The existing default window stays100.

The cursor carries the oldest returned position with full database timestamp precision and ID;
clients must treat it as opaque. It still works if that message is deleted. It grants no authority
and contains no message content. Each request reads current facts, so concurrent history changes
are not a frozen multi-request snapshot. Every page keeps the existing session recheck, selected
text/body byte bounds and no-store response. No message write or model invocation is performed.

### C20: browser and attachment claim boundaries

Browser-view frames are returned transiently and are not persisted by the viewer/audit path;
explicit task screenshots may separately become retained artifacts. Browser profiles persist on
the original working host; clearing browser data removes login state. Closing the viewer that
holds control keeps the Bot paused until explicit take/release; observation-only close does not
pause it. Soft-deleted channel files reject new references and subsequent Bot reads, while
retained Owner downloads remain available; already transferred model input cannot be recalled.
There is currently **no** `/channels/:id/attachments/cleanup` endpoint or seven-day unreferenced
recycle-bin collector. Entire-channel deletion has its separate tombstone-authorized purge.
Explicit transcription requires enabled OpenAI settings and the official endpoint, and retains
original bytes plus derived text on the Server. See the [claim audit](reviews/C20-product-claims.md).
