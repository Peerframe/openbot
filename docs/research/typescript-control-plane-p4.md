# P4: TypeScript Work execution and Python drain

English · [简体中文](typescript-control-plane-p4.zh-CN.md)

- Status: Implementation in progress; no P4 cutover or drain accepted
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
