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

The initial report composition is explicitly opt-in and rejects nonempty resource scopes. All
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

The current local implementation is the engine/control foundation only. It is not selected from
product startup and no public interface is switched. The real engine probe composes synthetic
control Activities around the actual SQL handoff, Activity binding and fencing adapters. This
proves single-attempt start, recovery, replay and coexistence, not model/tool execution, report
publication, browser/executor integration or a production drain. Product HTTP → model → artifact
remains the next integrated checkpoint in this same branch.

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
