# P4: TypeScript Work execution and Python drain

English · [简体中文](typescript-control-plane-p4.zh-CN.md)

- Status: Integrated P4 candidate installed locally; actual isolated-executor and hosted qualification remain open
- Date: 2026-10-09
- Owner: @yxflc11
- Decision: [ADR-0050](../decisions/0050-typescript-control-plane.md)
- Acceptance journey: existing Owner Task HTTP → new versioned TS Temporal workflow → bounded
  model/report Activities → immutable observations → verified atomic publication → artifact download;
  restarting a Worker or losing a response never repeats an unknown effect.
- Security boundary: Server owns admission, identity, root budget, claims, approval and publication.
  Temporal is the only recovery owner. Python retains all existing histories and their dependencies.

## Trigger and existing decision

P4 installs the recovery SDK already approved in the [P0 review](typescript-control-plane-p0.md),
ports the active Python Work contracts, and introduces durable execution ownership before allowing
TS admission. Reusing Python workflow names/history or routing only by a process environment flag
would let both supervisors select the same pending row. The first planned product checkpoint targets
native Tasks with the existing empty resource scope and report tools; broader native scopes,
channel tasks, Worker sockets, command/browser/media/plugin tools, collaboration and Python drain
remain required for P4 completion. This is one P4 branch, not independent product implementations.
No public default changes before the applicable acceptance gate passes.

## Targeted upstream evidence

Reviewed on 2026-10-09: official [SDK 1.24.0 release](https://github.com/temporalio/sdk-typescript/releases/tag/v1.24.0),
commit `1fd1c81a0383f5f5c7923dd735472c7d1ffdc867`, MIT license, npm release metadata for
`@temporalio/worker` and `@temporalio/core-bridge`, official
[TypeScript documentation](https://docs.temporal.io/develop/typescript), and the pinned
[replay test](https://github.com/temporalio/sdk-typescript/blob/1fd1c81a0383f5f5c7923dd735472c7d1ffdc867/packages/test/src/test-integration-replay-and-flags.ts).
The repository security-advisory API returned no published advisory; this is not a complete
vulnerability audit. Native SDK loading passed on macOS arm64. The production npm audit is recorded below.
Use existing Node 24.21.0 and the already available pinned Temporal Server 1.32.0 image for local
acceptance. No Electron-as-Node substitution, automatic test-server download, new desktop app or
paid model call. New SDK packages are workspace dependencies, with exact direct pins and lockfile
integrity. Their published manifests contain no install/postinstall hook; install with scripts disabled.

| Candidate | Version | Decision |
| --- | --- | --- |
| Official Temporal TS SDK | 1.24.0, MIT | Accepted P0 recovery target; separate TS workflow type and task queue; remote Activities and explicit bounded retries. |
| Keep Python indefinitely | Current retained product | Required only for coexistence/drain; does not meet the one-language outcome. |
| Replay Python histories directly in TS | Existing Python types | Not selected; no exported-history compatibility evidence. Drain old executions on their original workers. |
| New scheduler / generic autonomous agent framework | None | Not selected; duplicates established Temporal and Server authority and increases integration cost. |

## Ownership and failure design

Extend the existing admission facts with an immutable execution-owner discriminator; pre-existing
rows retain Python ownership. Both selection and locked reservation/acknowledgement check it.
TS cannot adopt Python rows and Python cannot start/acknowledge TS rows. New root admission may
change owner only before insertion; children inherit their existing root's owner. A drain receipt
must reconcile all pages of engine visibility and SQL handoff/execution facts, including unconfirmed
starts, running/continued chains and closed-but-unresolved effects. No terminal engine state grants
permission to retry an effect or publish an artifact.

The current report composition is explicitly opt-in. It accepts native attachment, knowledge, plugin, web and collaboration scopes; unintegrated resource capabilities remain rejected. All
unsupported behavior stays disabled in that candidate; it is not replaced with fixture output.
Production model calls use the existing approved connection, exact endpoint, fresh permission,
zero SDK retries and bounded transport. Tests inject synthetic provider behavior. A request receipt
must survive before an Activity can be replayed; lost responses remain unknown and reconciliation
is lookup-only. Workflow code cannot read SQL, files, credentials, environment or network.

## Incorporation and verification

No upstream source copied or substantially adapted. Temporal packages retain their MIT notices;
OpenBot's active Python algorithms are compatibility input. The frozen retired TS oracle remains
only a test oracle. No schema history rewrite or data movement.

Required acceptance: actual PostgreSQL races and cross-owner refusals; public HTTP and unchanged
Web request assembly; real Temporal start/history binding, Worker restart and lost-response recovery;
TS exported-history replay; immutable reports and atomic publication; explicit reverse selection and
owned-fixture cleanup; `npm run check`; UI `PASS 12/12` before group cutover. The full P4 gate also
requires all runtime tools, real isolated executor journeys and proven Python drain. A candidate
checkpoint is not P4 completion, a production drain, an installed release or P5 retirement.

## Current implementation boundary and closure audit

The local opt-in `OPENBOT_TS_WORK_GROUP=reports` composition now connects actual Owner HTTP,
versioned TS Temporal workers, the existing OpenAI7.28.0 / Anthropic0.131.0 SDK transports,
immutable model/tool observations, report preparation, independent review, atomic completion and
artifact download. Model normalization preserves provider tool IDs, signed reasoning and exact
observed usage; migration0056 explicitly adds `openbot-ts-model-response-v1`, retaining the Python
codec and all previous migration bytes. Reuse the existing P3 model SDK/endpoint decision; no new
model dependency or provider fallback is introduced.

Native attachments retain the existing file-inode-before-SQL lock order, captured metadata hashes,
UTF-16 pagination, bounded read budgets and ADR-0049 additional Owner confirmation. Model sending
and publication revalidate consumed resources. Employee knowledge reuses reviewed skill parsing,
Owner model-use opt-in, bounded recent-record selection, provenance and sensitive-text checks.
Its private TS receipt binds immutable references to the accepted Run, correction and claim;
prepared memory proposals enter the existing pending-review table only in verified completion's
transaction. Employee learning remains inspired by Hermes Agent.

Plugins reuse the P3 encrypted store and official MCP1.32.1 transport. Read leases precede SQL;
reviewed grants, declaration blobs and source proofs bind the exact Action. The one-use dispatch
marker and private audit commit at the pinned POST seam after DNS. Model disclosure and publication
revalidate consumed grants. A validated response survives a later SDK cleanup failure; a missing
reply remains unknown and is never resent. Actual MCP tests cover read/confirm grants, resource
reads, revocation during review and dropped replies.

Public web/search reuse the original four-attempt Task budget, source URL and Owner search
selection contracts. The public-address checks and Node HTTPS pin DNS results before the fresh
SQL dispatch gate. Pages have no credentials; only the selected Tavily/Kimi endpoint receives its
explicit key. Redirects, compression, mixed/private DNS and oversized responses fail closed.
The bounded Node parser described below runs without credential environment inheritance. Actual
owned HTTPS tests cover page/search approval through reviewed publication and the fifth-send veto;
focused tests cover TLS, parser bounds, Unicode, cancellation and both search response shapes.
These fixtures do not establish live external-service availability.

Hard-terminal observation follows immutable Continue-As-New links from the SQL-accepted first Run;
latest identity is a veto, never sufficient positive evidence. Missing history preserves uncertainty.
Projection closes authority and retains unresolved reservations, without settling effects. Closed
reconciliation uses `OpenBotClosedRepairTsV1` and a real remote Activity bound to the persisted Owner
command and original closed chain. It only reads existing receipts and never invokes a provider or
tool. SQL revision wakeups are hints; they grant no authority. Worker SDK logs omit task tokens,
arguments and raw exception metadata.

Real disposable HTTP/SQL/Temporal/mTLS acceptance has passed for report publication/download,
idempotency, independent-review refusal, cancellation after dispatch, restart/lost-response lookup,
attachment approval and revocation during review, skill/memory consumption, pending-only knowledge
proposals and skill revocation before publication. The closed-repair probe requires an actual
successful repair Activity, not merely an unresolved command projection. Providers are deterministic
injected transports, not paid model or public-network evidence. Focused attachment/file/model cases
also passed. The full repository check passed for the integrated native candidate; canonical57 qualification is recorded below. Packaging, UI and installed-app gates remain due.
The foundation evidence below is historical and does not qualify newly added behavior.

The user selected the existing locally installed OpenBot for final P4 acceptance. Read-only checks
found no running Temporal executions in its configured namespace; SQL pending/unconfirmed/unknown
obligations remain unchecked. No installed application or user data has been changed. Complete P4
still requires media/isolated command/browser tools, channel collaboration and channel/automation
submission, Worker registry/socket ownership, actual process-death recovery, full paged drain,
packaging, UI12/12 and the installed-app acceptance. The current native candidate is not P4 complete.

`npm audit --omit=dev` initially found GHSA-68fv-2mgg-jv7q: the SDK's source-map-loader reaches the
previously locked source-map-js1.2.1. Reviewed the upstream
[advisory](https://github.com/advisories/GHSA-68fv-2mgg-jv7q),
[released 1.2.2](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2) and
[fix/test PR79](https://github.com/7rulnik/source-map-js/pull/79). The compatible BSD-3-Clause patch
adds bounded indexed source-map offsets and regression coverage. Update only this existing
resolved version, preserve all other existing dependency versions, and retain its LICENSE.
The follow-up production audit reports zero known vulnerabilities. Actual workflow bundling and
replay exercise this changed loader; full repository checks cover the existing Web consumers.

Run `npm run test:work:ts` using the existing verified Worker environment. The owned fixture
starts PostgreSQL-backed Temporal1.32.0 with mTLS, runs the TS/SQL probe and removes its resources.
The existing hosted Temporal qualification lane now runs the same command. No new service,
container lifetime outside qualification, desktop app or paid provider is introduced.

## Local foundation verification (2026-10-09)

- `npm run test:work:ts`: passed on macOS arm64, real PostgreSQL/Temporal1.32.0 over mTLS;
  concurrent reservation/owner isolation, lost start reply after cancellation, Worker replacement,
  stale fences, Continue-As-New and both exported histories, plus early-Activity acknowledgement
  race. Synthetic control Activities only; no product model/tool completion claim.
- `npm test --workspace @openbot/work`:9 focused cases passed. `npm run check`:passed at final source;
  unchanged Turbo work was cached, and the earlier full run executed changed Work/Server/Desktop
  and Web consumers. The initial check correctly rejected stale migration/closure pins; those pins
  were updated to the actual qualified target, without weakening the checks.
- `npm run test:control:python` with the verified Worker interpreter:1,077 control cases passed,
  2 optional-Temporal cases skipped in the base environment;1,589 Worker cases passed,1 retained
  external-history input skipped. The two new cross-owner PostgreSQL refusals executed and passed.
  Existing harness quality passed. No skipped case is counted as passed.
- Existing synthetic migration/paired-restore qualifier:40/40 passed at canonical56. New SQL
  SHA-256 `9c54411cde1c4a0779b077c956765ff4848a82998e9d1268b0ba7166895150d1`; journal SHA-256 `6aa92977510c6a9297f54847b7d4627df9fe2f575b140f787332e92a0e046a41`. The target-history record retains the main
  integration base plus the exact uncommitted additive suffix. No prior SQL bytes changed.
- The macOS arm64 TS/Python payload staged successfully. Its existing P3 native smoke passed
  restart/session/model settings,34 resource and13 portability checks, child/parent failure and
  shutdown; model network calls0. The staged Node actually loaded the Temporal SDK/native bridge.
  This does not establish P4 Desktop execution, installed Keychain, or a packaged P4 release.
- Production dependency audit:0 known vulnerabilities. Owned P4/PostgreSQL/Temporal containers
  were cleaned; no application installed and no production dataset used. Public groups were not
  switched, so this checkpoint does not claim a new UI12/12 result. That gate remains required
  before product cutover, together with actual end-to-end execution and the Python drain.

## Public-source extraction decision (2026-10-09)

Reuse the accepted public HTTPS/search policy and P3's reviewed address classification; credentials,
redirects, retry, private addresses and ambient proxy settings remain disallowed for page reads.
The remaining Python-only HTML converter is replaced by released MIT `htmlparser2` **10.1.0**,
commit `57ace50bf6eb3bfab0468deafe10d0a8a2f233aa`, already present in the workspace lockfile.
Reviewed its [release](https://github.com/fb55/htmlparser2/releases/tag/v10.1.0),
[pinned parser and tests](https://github.com/fb55/htmlparser2/tree/v10.1.0/src), installed MIT notice,
and [open issues](https://github.com/fb55/htmlparser2/issues): implicit HTML repair is a documented
limitation, so this adapter extracts untrusted text and does not claim browser DOM equivalence.

Compared retaining Beautiful Soup 4.15.0 (blocks the TS runtime exit), the previously reviewed
`html-to-text` 10.0.1 (extra DOM/formatting behavior and dependencies), and the direct event parser.
Select the latter with no DOM allocation: preserve 512-KiB input, depth/child/node bounds, omitted
script/style/iframe/noscript/image/template content and 6,000-byte UTF-8 output. A fixed Node child
with a bounded heap/time, empty credential environment and read-only dependency permissions retains
process isolation; HTML is stdin data. This is a thin use of released APIs, no upstream source copy.
Extraction equivalence and hostile-input checks are required before enabling the web scope. No new
application, system service, external account or paid request is introduced.

## Collaboration port and deadline decision (2026-10-09)

Reuse the existing Python `work_collaboration`, `work_native_collaboration` and
`work_product_collaboration` contracts and migrations0039/0040: two levels, four descendants,
root-before-leaf advisory locking, immutable creation receipt, narrowing native grants and the
earliest accepted root claim plus300 seconds. No legacy channel/Run is fabricated for a native
child. Only a real execution/repair Activity may restore an existing SQL creation receipt; it never
creates again. Current-correction joins precede the final redraft, independent review and publication.
Parent closure cascades authority without clearing unknown outcomes or observed model usage.
The TS admission check also enforces the ADR0050 aggregate root token budget under the same root
lock; the retained Python Work usage projection is per Task, so it is not reused as evidence for an
aggregate check. Per-Task public usage remains unchanged.

The reviewed SDK1.24.0 [cancellation documentation](https://docs.temporal.io/develop/typescript/workflows/cancellation)
and [pinned cancellation scope implementation](https://github.com/temporalio/sdk-typescript/blob/1fd1c81a0383f5f5c7923dd735472c7d1ffdc867/packages/workflow/src/cancellation-scope.ts)
support a Workflow-owned alarm, heartbeating remote Activities and waiting for cancellation completion.
After admission, a short control read determines whether immutable native grants can create a tree.
Only those workflows poll for the first committed child every two seconds; ordinary tasks have no
alarm polling. Once present, the original SQL deadline becomes a durable timer across worker loss;
Continue-As-New reads the same deadline. This slightly earlier arming than Python's model-proposal
hook covers an Activity reply lost after child creation without a new scheduling/receipt framework.
SQL closes the tree before cancelling the body; every fresh effect and final fence also checks the
clock. Actual owned HTTP/PG/Temporal acceptance passed for delegate/automatic joins, rejected
ungranted targets, SQL creation receipt recovery, parent cancellation with late usage, a real
durable deadline and rejoining the same child after correction. The deadline fixture ages only
the first claim before any child is created; the product's300-second rule is unchanged. This
is native collaboration evidence, not channel collaboration or a completed P4 gate.

The Python compatibility runner also passed1078 base and1589 Worker tests, with2 and1 explicit
skips respectively, including the new Python repair exclusion for TS-owned obligations. Model
providers remain deterministic test transports; no paid/live provider or installed profile was used.

## Canonical57 migration qualification

The existing S7 owned-fixture runner passed all 40 cases on macOS arm64 / PostgreSQL17.11.
[The receipt](../../experiments/s7-migration/evidence/ts-work-result.json) records the exact57-entry
target manifest, journal and0055/0056 SQL digests; no historical SQL was rewritten. This qualifies
the existing synthetic historical upgrade/backup/transfer cases only. It does not establish restoration
of model credentials, attachment journals, active Work/Temporal histories, installed-app drain or P4 completion.


## Channel admission, schedules and media integration (2026-10-09)

Reuse the current Python message/Run admission, channel collaboration, recurring submission and
[original media contract](work-product-media.md). This extends the same P4 candidate and queue;
no new scheduler, table, public protocol or dependency is introduced. `work_sources` retains real
channel message and Run identities. Channel advisory/source locks precede root-to-leaf Task locks;
all-recipient admission is atomic. Context reads use the original root message/Run cutoffs, preserve
reply provenance and consume the existing channel membership. Cancel/steer bridges retain the same
Work authority and observed usage. Verified completion publishes the Bot message in the same SQL
transaction. Native Tasks continue to have no fabricated channel/Run or expanded grants.

The paired Python `ts_work_group=reports` setting quarantines the eleven migrated operations and
disables its schedule submitter, while leaving Python-owned histories available for drain. TS uses
the existing ten-row `FOR UPDATE SKIP LOCKED` occurrence claim, skips active predecessors, advances
elapsed intervals without replaying a backlog, and disables unavailable targets. Candidate API
integration does not qualify a running installed pair or the final drain gate.

The actual disposable PostgreSQL/Temporal/mTLS/HTTP/MCP/HTTPS journey passed channel submission,
source context, atomic publication, steering/cancel, real delegated Runs/joins, member revocation,
combined attachment/knowledge/plugin/web evidence and schedule admission/skip/disable. The paired
Python focused tests passed 23 without warnings. Full repository `check` also passed after media integration and the contention change.
One earlier channel parent engine failure was not reproduced after failure-history diagnostics were
added; its root cause remains unconfirmed and is retained as an integration concern. A subsequent
MCP unknown outcome was traced to the test peer's intentionally persistent lost-reply switch;
restoring responses after its no-resend assertion fixes fixture isolation, without changing product
timeouts or retries.

Media keeps the reviewed per-item5-MiB PNG/JPEG and10-MiB PDF limits,20-MiB aggregate, eight items,
8192-token host reservation per original binary, and12-KiB immutable manifest. Explicit extraction
continues to use validated derived text; no automatic OCR or provider-upload fallback is added.
The manifest binds source, Run, original metadata and derived digest before the first Action.
Correction, recovery, disclosure and final publication revalidate the same bytes under the current
file lease/source/fence. Only the admitted model Activity hydrates originals. Work storage/history
and model Action intents carry descriptors, never base64. Independent review receives the same
original media. Unknown model outcomes remain lookup-only.

Reuse the P0-reviewed Apache-2.0 OpenAI7.28.0 (`fb6955621e1cf6653659adb75094ebace83ebfe9`)
and MIT Anthropic0.131.0 (`d49bdab458000bcdffe77bd84b03293f31824fb3`) SDKs. Rechecked the installed
exact-release Chat content-part and Messages base64 document/image types and the pinned
[Anthropic Messages source](https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts).
The corresponding pinned OpenAI web fetch missed cache; the installed package source and already
accepted P0 evidence supply that check. The narrow adapter supplies typed inline bytes/name/title,
then compares the SDK JSON's exact parts before its existing one-use send. URLs, provider file IDs,
other presets and unreviewed media forms fail closed. No upstream implementation is copied.
SDK focused tests compare against the existing retained media projection and exercise20-MiB raw
inputs in both supported protocols. They passed together with existing model/attachment tests
(10 cases). The combined real HTTP/PG/Temporal/mTLS/MCP/HTTPS journey subsequently passed,
including original PNG/JPEG/PDF producer/reviewer bytes, immutable-manifest replay, live revocation,
two concurrent channel collaboration trees and schedule recovery. Providers are deterministic;
this is not installed-app or paid-provider evidence.

One full-suite run observed a Task GET 503 while full repository checks ran concurrently. A later
owned PostgreSQL diagnostic run recorded 200–233-ms channel advisory-lock waits, with no lock
error, and exceeded the original single-task 40-second fixture wait for two concurrent trees.
This does not establish the original 503 or earlier engine failure's exact cause. The read-only
resource-validation pass now reuses its locked Task/source facts within the same SQL transaction,
then discards them before dispatch or writes; file/grant/receipt/child checks remain live and the
execution fence is checked again at the end. Regression tests cover cross-transaction rejection,
authority changes after the pass and expiry. The expanded aggregate harness allows 600 seconds
and the two-tree case 90 seconds; product SQL/HTTP/Activity/deadline values are unchanged.
The combined run then passed without a 503. Preserve the unresolved earlier failure evidence;
required UI acceptance, Worker execution, installed-app drain and final P4 completion remain open.

## Native Worker and approved browser Task integration (2026-10-09)

The explicit in-process Worker composition now replaces the P3 Python runtime port for live
registry, enrollment/revocation detach and Owner browser transport. It reuses the reviewed MIT
`ws`8.21.3 release/commit `c791e707eab3c13dd9a261d2479c3cc4a49a6fed` from the existing Node liveness review;
the existing dependency moves from the candidate's test edge into its production closure without
an installation or version change. Original credential/connection bindings, identity fence1326850643,
public ingress checks, bounded frames/queues and one-use browser transport claims remain mandatory.
Unselected deployments still use the existing private port; no automatic failover is introduced.

The Task adapter ports the retained `work_browser_profiles.py`, `work_product_browser.py` and
`work_browser_page_actions.py` decisions. Only a deployment-routed channel source with a
`docker-linux` Bot and explicit model selection can capture an immutable browser profile and
optional page-origin scope. The existing tables and digest conventions are reused. Trusted
composition is passed through Work scope; missing composition fails closed. Browser sources receive
channel reads, attachments, reports and their explicit browser tools, without gaining plugin,
knowledge, web-search or collaboration authority from channel membership.

Capture and page operations require separate fresh Owner approvals. The shared human gate1326850642
spans the effect and observation. The original connection, credential, control revision, source,
Task/fence and current approval are checked before dispatch under the identity fence. An immutable
attempt precedes the write; the command expires at the earliest of25seconds, the original claim,
Action or tree deadline. Page inputs bind an already applied same-authority observation and exact
page/frame snapshot; configured origins are rechecked on the response. Original private PNG bytes
and strict page data are persisted, with no claim of visual interpretation or verified business
outcome. Four captures and sixteen page operations are the existing per-task limits. Only capture
artifacts publish after independent review. Lost outcomes remain unknown and recovery reads the
original receipt without recapturing or retrying input.

The combined actual HTTP/PostgreSQL/mTLS Temporal/WebSocket/MCP/HTTPS qualification passed with
all existing native/channel/media/schedule cases. New cases exercise four separately approved
browser effects, download of the committed PNG, human takeover/release between proposal and
approval, socket loss followed by reconnect/reconciliation with one dispatch, and an out-of-origin
page response. Owner browser opening, observe/take/release, maintenance, re-enrollment and revocation
also use the sole TS registry. Browser image/page responses in these new cases are deterministic
peer data: they are not actual browser-engine or Linux-isolation evidence. Focused origin,
argument/receipt and read-pass boundary checks passed5cases. The full repository check subsequently passed (Server153tests; Desktop578passed/3platform skips;
Web695tests; final build20/20 with15cached). The two old packaging assertions excluding ws were
updated to require the existing pinned Worker dependency while still excluding the retired oracle.
No public group or installed application has been switched.

Read-only installed-target checks found OpenBot0.1.0-alpha.9 with existing Temporal configuration,
but no browser/command installation file. The current local Docker runtimes provide runc, not
runsc. A configured Linux Worker Host is an explicit dependency for final isolated-command
qualification; do not discover a personal SSH target or reuse consumed historical remote
reservations. Command authority/transport integration, actual process-death windows, paired
packaging, UI12/12, complete installed SQL/engine drain and installed-app acceptance remain open.


## Approved command integration (2026-10-09)

The explicit P4 Worker composition now accepts the existing private command installation file.
It reuses the [command authority](work-command-authority.md), [SQL transactions](work-command-transactions.md),
[v2 readiness](work-command-readiness.md) and [protected Host](command-protected-host.md) decisions.
The already reviewed MIT jose6.2.12 and Apache-2.0 canonicalize5.0.0 become direct Server production
edges without changing or installing versions. Released JOSE/JCS implementations perform signing
and canonicalization; no upstream source or cryptographic implementation is copied. The strict
adapter rejects duplicate JSON keys, non-integer numeric tokens, unexpected headers and role/key
confusion before accepting any signed authority. Actual Python/TypeScript APIs exchange all nine
v2 purposes, lookup/stop variants and retained operation fingerprints.

A channel or automation with a deployment-routed docker-linux Bot captures the existing immutable
command profile. Its model sees only the original input descriptors, offline policy and bounded
command proposal tool. Each command needs a fresh Owner decision. Preparation fixes the original
Activity claim, approval, source/files, profile, connection and native deadlines before admission.
SQL admission and dispatch creation commit together; consumption commits one permit and its digest
before any wire reply. Original opaque handles, four-frame/64-KiB pressure limits and five-second
pending deadlines apply to the actual Node/Unix channel. Identity locks and SQL transactions never
contain wire sends. Reconnection, process replacement or uncertain commit cannot create another
preparation, ticket or permit. Process-local preparation clocks and Activity authority are released
when the attempt ends; historical evidence cannot recreate them.

The 120-second claim applies to a proposed command action with a frozen command profile,
including a pending approval that can commit during the Activity. Preparation still requires fresh
approval. Existing claims keep their expiry; other claims remain 60 seconds. The first root deadline, Action expiry, readiness-bound
native lifetime and five-second launch window are never extended. Signed original observations and
exact bounded UTF-8 output are verified before recording; independent review receives the full
text before atomic publication. Local receipt recovery never re-executes the command.

The first combined actual PostgreSQL/Temporal/Owner HTTP/Node/WebSocket/Unix journey executed one
approved command and downloaded the exact reviewed CSV. Its initial failure was a fixture that
incorrectly expected repeated approval after task closure to succeed; the product correctly returned
409. The corrected combined journey passed, including subsequent rejection and real Unix reply
loss after execution. Node reconnect and Owner reconciliation leave that Action unknown with no
second preparation or permit and no artifact; SQL checks confirm one preparation/consumption/permit
per executed Action and none for rejection. The three focused files passed ten cases. Native
isolation and Unix peer identity remain explicitly synthetic. The full repository check passed:
Server159, Desktop578 with3platform skips, Web695 and Node129 with3platform skips; final build20/20
with16cached. Actual Linux/runsc qualification, Desktop composition, process-death windows,
UI12/12 and installed drain remain open.


## Installation composition and Python drain (2026-10-09)

Reuse the installed private `temporal.json`, `browser.json` and `command.json`; never rewrite
credentials or the retained queue. Explicit `OPENBOT_TS_WORK_GROUP=p4` requires all accepted P3
selectors, creates the sole TS Worker registry, and derives a disjoint versioned queue from the
configured Python queue. The paired Python process has neither a Work supervisor, Worker socket
nor a private runtime port. Desktop v8 requires the existing Temporal configuration and actual
SDK/native resources. An absent or invalid execution configuration fails closed; this candidate
has no implicit API-only fallback. Python remains packaged for P5 and explicit paired reversal.

Reviewed official [Temporal Visibility documentation](https://docs.temporal.io/visibility) and
SDK1.24.0 `workflow-client` source at the commit already pinned above. Visibility is eventually
consistent: its absence is not a drain proof. Compare a first-page-only list (insufficient), queue
renaming alone (leaves pending SQL obligations), and full SQL plus authoritative per-ID engine
inspection. Select the last using released SDK APIs, with no copied upstream source or new dependency.

Before any TS Work service or automation starts, read all Python-owned SQL rows with keyset paging,
including unconfirmed submissions, admitted/unknown effects and unfinished closed repairs. Describe
each deterministic old workflow ID, verify queue/type/first-run identity and immutable terminal
history, then re-describe for a racing continuation. Scan every running Visibility page to find
engine-only obligations. Missing retained history is counted separately; transport failures,
continued chains, mismatched references and incomplete history refuse cutover. Re-read SQL and
compare its full digest to reject concurrent changes. This is read-only evidence; it never cancels,
retries, settles or refunds old work. Stop the old admission processes before this gate. Empty
Visibility alone, a closed engine execution and fixture results never authorize a production switch.

The disposable gate passed with105 SQL rows (including an active row after the first page),
unconfirmed/unknown/unfinished-repair refusal, three real unpolled Python-type Temporal executions,
multiple Visibility pages, actual terminated-history verification and a concurrent SQL change.
Desktop focused checks passed36 cases with2 platform skips. These qualify the gate implementation;
they do not establish drain of the installed application. Complete P4/UI/native/installed acceptance
remains pending. The local current handoff identifies exact logs and revision scope.


## macOS native qualification engine (2026-10-09)

The existing macOS hosted package lane has no Docker engine. Reuse official Temporal Server1.32.0
as a temporary native fixture, with its documented SQLite initialization and the same mutual TLS
policy. This verifies packaged native loading and paired lifecycle; PostgreSQL durability, schema
and upgrade acceptance stay in the existing real PostgreSQL/mTLS lane. A product never selects
this fixture, plaintext, SQLite or an implicit test server. The installer does not ship it.

Reviewed [Server1.32.0 release](https://github.com/temporalio/temporal/releases/tag/v1.32.0),
its `config/development-sqlite-file.yaml` and `config/docker.yaml` from the verified archive,
and [TLS configuration](https://docs.temporal.io/references/configuration#tls). The macOS arm64
archive SHA-256 is `f95748376241f5941327fa4c4e8e76641e8c4a9acabf77de9c86eb3d8238f4d7`,
size96,287,042 bytes. Reuse the existing bounded archive/member verifier; exact binary sizes and
hashes are in `experiments/work-journey/release_archive.py`. No upstream source is copied; declarative
configuration uses the published schema and the Server retains its MIT license. No automatic
SDK download or new product dependency is introduced: CI explicitly downloads the pinned archive,
and local qualification requires its explicit path. The owned process, credentials and SQLite file
are removed at completion. The package database remains actual native PostgreSQL.

Also reviewed MIT [CLI1.9.1](https://github.com/temporalio/cli/releases/tag/v1.9.1), commit
`1de87a9f26991bf4f5c0a5ff96f2cea8d7a3cbde`, its start-dev implementation/tests and open issues.
Its development command does not expose the required server TLS configuration, so it is not used.
A Docker/VM installation on hosted macOS would add an unnecessary environment dependency.
The released Server asset meets this narrow gate without changing production architecture.


## Integrated recovery and installation evidence (2026-10-09)

The production TS entry now runs in a real child process against disposable PostgreSQL and mutual-TLS
Temporal. Qualification sends SIGKILL at five committed boundaries: reservation before start, engine
acceptance before acknowledgement, admitted effect before response, saved original receipt, and atomic
publication before Activity completion. A replacement uses the same database, queue, keys and files.
The unconfirmed submission is not resent; the unknown effect is not repeated or published. Recoverable
starts and committed receipts complete, preserving the original receipt digest, three model steps and
one final publication. All five windows passed. Provider bytes and pause hooks are synthetic; process
death, HTTP, SQL, file storage and engine recovery are actual. The aggregate qualification budget is
1200 seconds; individual product deadlines are unchanged.

The existing TS UI command now owns the same disposable mTLS engine and requires the P4 health phase
and TS execution owner. Its12 existing steps passed with112 responses, zero unexpected responses,
zero page errors and zero workspace503s, including restart and reconnect. No Web source was changed.
The staged native payload also passed34 resource and13 portability checks with actual native
PostgreSQL and the pinned native mTLS engine. These checks use disposable profiles and synthetic
encryption callbacks; installed Electron/Keychain acceptance remains separate.

For the user-selected installed OpenBot, a consistent copy of its stopped PostgreSQL cluster was
audited with target additive migrations applied only to the copy. Its installed Temporal endpoint
was queried read-only. The copy held two Python Runs; active Runs, unconfirmed submissions, unresolved
effects, unfinished repairs and running engine executions were all zero. One terminal history was
absent and counted separately. All1292 source files (62,318,329 bytes) retained the same full digest,
and the temporary copy was stopped and removed. This is a read-only precheck, not an installed
cutover: actual startup must repeat the gate after the old pair has stopped. Linux/runsc execution,
installed application acceptance and hosted CI still have no completion claim.


The unsigned canonical macOS arm64 app also passed the same34 resource/13 portability checks,
actual mTLS Worker startup, password/data restart, both-child exit supervision, parent-EOF cleanup
and invalid execution configuration refusal. All81 packaged Desktop compiled files match the
current build; its ASAR SHA-256 is
`504141e2fded74e151de9e6998df5edd17f7ccb322fcd004abbeca9082843885`.
The unchanged macOS Worker companion was reused from verified source
`6e9d13edc77e0bb4b1aa797a9701cf16cd7a877c`; its complete packaged manifest remains validated.

Same-source native measurement used three alternating trials per composition, each with a fresh
profile and restart, actual native PostgreSQL and the connected fixture engine,100 measured requests
per endpoint after10 warmups, and only owned descendant RSS. Python-only median fresh/restart
readiness was10,917/8,938ms and248,096KiB RSS; complete P4 was6,696/5,302ms and650,096KiB RSS.
P4 median health/channel latency was0.306/0.815ms (Python0.580/9.889ms). The retained measurement
label `ts-forwarding` represents the complete v8 P4 composition in this run. The engine process,
Electron renderer, Keychain and in-flight execution cost are outside those RSS/timing samples.
This is one macOS arm64 machine, not a general performance promise. Python remains packaged until
P5; memory and payload size have not been reduced by this coexistence stage. All owned measurement
processes stopped and disposable data was removed.


## Installed candidate acceptance (2026-10-09)

The integrated `npm run test:work:ts` run passed all48 named checks, including all five actual
process-death windows. The complete repository `npm run check` exited0: Server162 tests, Desktop579
with3 platform skips, Web695 and Node129 with3 platform skips. Its final20 builds passed,16 cached.
The packaged81 Desktop compiled files still matched after that build. No paid model was called.

Using the environment explicitly chosen by the user, the existing macOS OpenBot application was
replaced by this unsigned development candidate after retaining its original bundle and complete
profile in a private rollback directory. The actual Electron app loaded the existing Keychain
credentials, authenticated, and restored its workspace and realtime connection. Its actual health
endpoint reported `typescript-product-candidate` with `typescript-v1` execution running, which
requires the installed SQL/Temporal drain before Worker admission. Normal application quit stopped
both services and native PostgreSQL. Actual restart passed the drain again and restored the TS
Worker, workspace and realtime connection.

A read-only copy audit after that stop found57 canonical migrations (previously53), the same two
legacy Runs, no active/unconfirmed/unresolved obligations, and no enabled automations. The old
Work SQL digest was unchanged. All18 retained configuration/object/artifact files (3,610,608 bytes)
matched the rollback copy byte-for-byte. There was no production Work submission or model call.
This installed candidate does not supply the missing Linux/runsc deployment or browser configuration,
and does not turn synthetic executor evidence into native acceptance. Full P4 qualification and
hosted CI remain open; Python removal, package reduction and P5 are not included.


## Hosted portability and actual Chromium qualification (2026-10-09)

The first draft PR #212 run at `e5f807fc` passed all hosted jobs except Windows retained-client
tests (and the dependent aggregate). Five pairing tests simulated macOS but accidentally invoked
real POSIX private-file checks on Windows. Mock only that configuration boundary in these pairing
tests, retain the actual POSIX checks and native qualification, and assert refusal propagates before
either process starts. The focused local pair/configuration tests pass37 with2 platform skips;
this is not a claim that the repaired Windows hosted run has passed.

Extend the existing `product_browser_probe.py` with explicit `--entry ts --recovery pages` and
`response-loss` selections. Reuse the reviewed browser upstream commit
`29a83c1932fb67398dd7a36fa80c473e0230a637`, Playwright1.62.1 and the existing real Node fixture.
Only model HTTP is synthetic. The TS entry uses the production configuration, Owner login,
canonical PostgreSQL migrations, mTLS Temporal, browser approval/receipt and publication paths.
Unsupported TS recovery modes refuse before resources are created; this does not claim the Python
Worker-pause or remote Linux replacement cases have been ported. No product dependency or copied
upstream source is added. Official SDK1.24.0 replays binary engine history via its bundled protobuf
codec; the attempted JSON conversion failed before replay and is not counted as a pass.

The local page journey passed: four independently approved operations, exactly one navigation,
Unicode input, click and read, seven single model steps including independent report review,
one downloaded report, independent target state and offline replay. Owned fixtures closed.
An earlier navigation became unknown before the Node provider was called. Inspection of its
retained private evidence identifies a clock mismatch: the database-generated model request and
Temporal UUIDv7 place execution at07:45:37 UTC, while the model receipt was written on the Mac
at08:00:10 UTC. The Action expired at07:50:38 UTC. `WorkBrowser.authorized` bounds its command
by database time, but `WorkerHostRegistry.browserCommand` checks expiry against the sending
process clock and refuses before the socket write. The existing real-WebSocket expiry/authority
negative checks passed again (all6 registry tests); the original Node call counter and browser
profile are empty. This explains the observed pre-dispatch refusal without extending a permit or
retrying the Action. The exact original caught exception was not retained, so the attribution is
an inference from these independent timestamps and the verified refusal path, not an original
exception trace. Later successful runs do not erase that observation. The actual response-loss case also passed: the target
recorded one click while its response socket was destroyed; cancellation removed authority, an
explicit original-receipt lookup remained unresolved, and neither click nor model was repeated.
No artifact was published. Per the existing TS ledger contract the unknown Task remains open and
the engine waits; replay covers that open history, not a fabricated successful close. The first
fixture assertion incorrectly expected immediate workflow closure and was corrected to this contract.
New hosted results must still be reported separately. This is actual local Chromium evidence, not public egress,
Linux isolation, installed browser configuration, or completion of the P4 isolated-executor gate.

The shared probe's Python Worker-stop/approval/resume journey also passed on real Chromium,
including seven single model steps, report download and closed-history replay. Four unsupported
entry/recovery combinations refused before fixture side effects. The workflow-focused102 checks
and full `npm run check` passed; Desktop580 plus3 platform skips, Server162, Web695 and Node129
plus3 platform skips. The final30 test tasks reused14 caches and20 build tasks reused16 caches.
These changes affect tests, qualification and CI; the installed candidate's product bytes are unchanged.


## Fresh native CI qualification and approval race (2026-10-09)

The exact previous HEAD `3ac5e34eb75615f2a5d6a41c66f589fd247c944a` passed all17 hosted checks in
[CI37904521785](https://github.com/Peerframe/openbot/actions/runs/37904521785). That result does not
qualify the new edits. The remaining real executors now use the existing disposable Ubuntu24.04
browser-product lane. `p4_native_ci.py` prepares root-private copies of the unchanged Host/native
algorithms, fixed Docker29.8.1 and gVisor release-20260914.0 binaries. Both downloaded archive
hashes and every reviewed runtime member match. Docker's [binary testing workflow](https://docs.docker.com/engine/install/binaries/)
permits running directly from a fixed temporary path. No runtime is registered with the host daemon.

The command retains actual SO_PEERCRED, UID62425 with no groups/capabilities, root-only signing keys,
one original unit, no network, a bounded ext4 output disk and original expiry/cleanup. Browser
qualification reuses the existing600-second composition, separate Squid and browser networks,
owned HTTPS targets, thirteen socket cases, certificate refusals, graceful replacement, private
profile continuity and established-tunnel revocation. It allocates a fresh identity; consumed
product3/comp5 packets and SSH authority are never reused. Executor daemons have no external route.
The ordinary runner daemon is used only to obtain/export reviewed images before execution.

Offline Docker export bytes may differ from the old packet. Each new archive is hashed after its
reviewed image config, architecture and layers are verified. Only trusted packet constants for
transport hashes, fresh paths, copied-source hashes, rebuilt Squid and the existing CI Bun1.3.14
are rebound, with a root-private manifest. The pinned Playwright1.62.1 image and seccomp policy stay
unchanged. Fresh test certificates and the fixed Ubuntu NSS3.98 builder package create an empty
container-only trust store; no personal/host trust or certificate-error bypass is used. Upstream
source/dependency notices remain in the temporary packet. No new product dependency or copied
third-party implementation is introduced.

The TS approved-command product entry passed actual HTTP/PostgreSQL/mTLS Temporal/Node/WebSocket/Unix,
complete CSV/report downloads, independent content review and official binary history replay.
Native and peer identity in that local proof are explicitly synthetic. A controlled real-SDK
interleaving then reproduced a race: an Activity claimed before Owner approval retained only
59.8seconds, insufficient for the existing preparation/runtime/stop envelope. The new pending-command
claim reserves the existing120-second envelope without renewing an old claim or granting approval.
The same controlled interleaving now passes with one execution, one publication and unchanged
counts after replay. Native CI exercises that race too.166 focused packet/remote/Host tests pass.
At that checkpoint, native command/browser CI and correction packaging were pending; later evidence follows below.

### Native preparation failures and closure acknowledgement correction

The first native attempt on `15203a45` stopped before execution in
[CI37914182843](https://github.com/Peerframe/openbot/actions/runs/37914182843): the archive reader
mistook Docker's top-level directory for its binary. The corrected reader verifies regular members,
size and hashes; the Worker interpreter keeps its venv prefix across its symlink. The next attempt
on `57520ba9` stopped before native execution in
[CI37915993633](https://github.com/Peerframe/openbot/actions/runs/37915993633): preparation confused
Python's manifest digest `6e13e65c…` with its config digest `64d91f7b…`. The official registry's
original immutable manifest confirms the latter; Docker stores expose different inspect IDs.
Neither attempt establishes actual native command/browser success.

The original native preflight also requires the registry digest after offline load. The reviewed
[Skopeo copy contract](https://github.com/containers/skopeo/blob/9e29e4cede9bdaa4a54aa5b0af86efedb823bde4/docs/skopeo-copy.1.md)
provides `--preserve-digests`, OCI archives, explicit platform and anonymous TLS-verified reads.
Its [upstream issue2222](https://github.com/containers/skopeo/issues/2222) explains why a legacy
Docker archive cannot retain the original registry digest. Select Ubuntu24.04's security-maintained
`skopeo=1.13.3+ds1-2ubuntu0.24.04.3`, upstream1.13.3 commit
`9e29e4cede9bdaa4a54aa5b0af86efedb823bde4` (Apache-2.0), only in the disposable CI runner.
The [official package archive](https://archive.ubuntu.com/ubuntu/pool/universe/s/skopeo/) retains
that exact amd64 package. Reject legacy `docker save` for this transport and a custom registry client
because the released CLI already preserves the required bytes. OCI metadata is independently
checked against manifest/config hashes, sizes and Linux amd64; all resulting archive hashes are
recorded. Squid's rebuilt config and manifest are both recorded. No source is copied from Skopeo,
no product dependency or user installation is added, and original Host/image preflight stays intact.
The existing native lane now runs before ordinary browser scenarios to surface its failures first.

That run also exposed a product Workflow race: SQL tree closure can make a concurrent Activity
refuse before the `closeWorkTree` acknowledgement arrives. The Workflow now observes the original
closure result when closure has started, before classifying that refusal or cancelling its monitor.
It keeps the300-second authority limit and does not restart effects. A real SDK/mTLS ordering probe
fails before the fix, passes successful closure after the fix, propagates a failed closure and
replays both histories; its authority callbacks are synthetic. The complete actual SQL/Temporal
Work suite then passed49 named checks, including the real collaboration deadline and five process
SIGKILL windows. Packet/Host tests passed170; full repository checks passed with affected builds
executed and unchanged caches reused. Current-head hosted/native qualification remains required.

The claim-corrected macOS package passed34 resource/13 portability and paired lifecycle smoke;
the same installed app restored Keychain login, workspace and realtime, normally quit with both
services/PostgreSQL stopped, and restarted successfully. That evidence covers the claim correction.
The Workflow-corrected45daf316 canonical package has now been staged and built sequentially.
Its second actual smoke passed34 resource/13 portability checks, real PostgreSQL/mTLS native
Temporal paired lifecycle and invalid-configuration refusal, with zero model calls. The first
smoke genuinely failed in the Node24.21.0 HTTP driver with `setTypeOfService EINVAL`; its log
remains preserved, consistent with the [upstream report](https://github.com/nodejs/undici/issues/5544).
No HTTP-driver patch was added, and the later pass does not erase the first failure. Smoke uses a
synthetic crypto callback; actual installed-app UI separately verified retained Keychain login.
The same installed app now includes both corrected modules, restores authenticated workspace and
realtime, normally quits with paired services/PostgreSQL stopped, and successfully restarts.
Installed/source/package module hashes match: work-execution `f59d018c0f539bfa317a1ee63d69bf82bfd30580f50c7d28fd1cba51d68c65b1`,
Work workflow `2a2a405e72dfd3dc1ce181195127da517d8432b8f1806d56928d988a400a9747`.
Original profile and all app/profile rollback copies remain retained.

### Third preparation failure and actual OCI transport precheck

[CI37918849225](https://github.com/Peerframe/openbot/actions/runs/37918849225) on45daf316 also
failed before either native journey: Skopeo1.13 refuses a Docker registry reference containing
both tag and digest. Sources now use the fixed digest alone. Rebuilt Squid additionally receives
its original tag in the OCI index, as required by the unchanged native offline loader. The
[reviewed transport syntax](https://raw.githubusercontent.com/containers/image/v5.26.1/docs/containers-transports.5.md)
documents both restrictions/annotations. No image-content pin or native enforcement is relaxed.
The same run's Windows missing-resource test exceeded its5-second default while executing roughly
80 full file-preflight cycles. Its own bounded fixture-I/O budget is now15seconds; every resource
refusal and paired-service cleanup assertion remains, and product deadlines do not change.

Before another hosted attempt, actual fixed-package Skopeo copied both immutable public Python
and Chromium images in one auto-removed Ubuntu24.04 amd64 container on macOS. Their original
manifest/config/platform and layer identities passed independent OCI checks. This emulated
precheck establishes transport only, never Linux/runsc acceptance. The first container's TLS
unknown-authority failure is preserved. The successful retry used only the host's existing public
system trust bundle and retained TLS validation; no Docker socket, user profile or credentials
were mounted. Native command/browser acceptance and every check on the final HEAD remain open.


### First actual native staging attempt

On `0b718481`, [CI37921320288](https://github.com/Peerframe/openbot/actions/runs/37921320288)
passed the fresh native packet preparation, including both immutable OCI copies and rebuilt Squid
export. The actual command step then refused at Host staging with `native_stage_failed`; its
cleanup remained unconfirmed and the isolated-browser step was skipped. The private child stderr
was not uploaded, so the exact underlying cause is still unknown. The failed result is preserved.
The same run's Windows client job passed after the resource-fixture budget correction.

The fixed, hash-verified root launcher now returns only an allowlisted error code/type and up to
four locations in the public packet source. The parent retains those content-free JSON diagnostics
on stage/pre-ready failure. It never publishes exception values, locals, keys, enrollment or private
stderr. Positive/negative redaction checks pass; this adds observability, not acceptance or retry.
Fresh actual native staging, command, isolated browser and complete hosted checks remain required.


The diagnostic attempt on `1b5da7fd`,
[CI37923141565](https://github.com/Peerframe/openbot/actions/runs/37923141565), retained
`unsafe_directory` at the original Host stage's protected-directory check, and the same check
prevented key-cleanup verification. No native command or browser succeeded. Fresh root-created
fixture directories have private modes; the shared `/opt` ancestor is the remaining suspected
permission gap, but its prior metadata was not captured. Preparation now seals only that fixed
ancestor to root:root0755 on the guarded disposable GitHub runner, records exact before/after
UID/GID/mode and unchanged inode, and runs original directory checks before native admission.
It does not recurse, change existing tool children, modify user hosts or relax any native gate.
Actual recorded metadata and fresh native results remain required before concluding that gap closed.
