# Research: Docker browser conformance scenarios

- Status: Accepted for implementation
- Date: 2026-09-22
- Related work: DEVELOPMENT_TRACKS B1a; existing controlled-browser slice
- Acceptance journey: an enrolled Node executes the production Docker Provider through a real
  Server, HTTP and authenticated WebSocket connection; required positive and fault scenarios
  produce a strict hermetic conformance report and leave no owned resources running.
- Security boundary: PostgreSQL and Server retain identity, routing, approval and audit authority.
  The loopback computer is synthetic and untrusted. No model, external account or browser profile
  is used; this is not real Chromium, native input or platform certification.

## Search evidence

Reviewed the reuse-ledger entries for the Provider SDK/browser adapter, conformance runner,
Node identity, bounded Server shutdown and disposable PostgreSQL. Existing implementation baseline:
`86223c6`. Reused [controlled click research](controlled-browser-click.md),
[runner research](provider-conformance-runner.md) and [contributor journey research](2026-09-22-contributor-journey.md).
GitHub queries on 2026-09-22: `repo:CopilotKit/openbot is:issue is:open browser`,
`CopilotKit openbot agent-computer click snapshot control`, `nodejs node destroyed socket response`.
Primary API review: pinned upstream `agent-computer/src/index.ts`, `profiles.ts`, `control.ts`,
`package.json`, tests directory and license; pinned Node HTTP documentation and socket-destruction test.
Open upstream issue [#86](https://github.com/CopilotKit/openbot/issues/86) concerns broader content,
cost and injection controls; it does not provide an OpenBot Server approval conformance harness.
No claim is made that the upstream issue list proves the absence of defects.

## Candidate comparison

| Candidate | Exact release or commit | License | Source, tests and lifecycle fit | Decision |
| --- | --- | --- | --- | --- |
| Existing OpenBot conformance runner | `86223c6`; prior-art MCP Conformance `74edef34d674f563537be8c6587cebaa58e830ca` | OpenBot MIT; MCP Apache-2.0/MIT transition, docs CC-BY-4.0 | Bounded setup/run/cleanup, required checks cannot skip, strict outcomes, exclusive report creation; existing negative tests | First viable released-in-repository orchestrator; do not create another reporting framework |
| [CopilotKit/OpenBot agent-computer](https://github.com/CopilotKit/openbot/tree/257c1280d684089be9adb0b35cce262efc7064bf/agent-computer) | `257c1280d684089be9adb0b35cce262efc7064bf` | MIT | `/control`, `/snapshot`, `/screenshot`, `/click`; snapshot generation plus ref, Bot header and token, per-Bot browser profiles; control/authorization/snapshot/close tests. Action route records cancellation separately from errors; response loss cannot attest non-execution | Reuse the production adapter and model only the reviewed HTTP surface for deterministic fault injection |
| [Playwright](https://github.com/microsoft/playwright/tree/v1.62.1) | `1.62.1`, pinned by upstream | Apache-2.0 | Actual browser actionability, locator and browser tests; already exercised in the earlier controlled-click evidence | Keep real-browser validation as a separate evidence level; cannot deterministically prove transport loss and Server state solely with a page test |
| [Node.js HTTP](https://github.com/nodejs/node/tree/2645dc73720b1b4f27c49f395d3c66025ce126cc) | `22.22.2`, `2645dc73720b1b4f27c49f395d3c66025ce126cc` | Node.js license (MIT plus bundled notices) | `doc/api/http.md`, `test/parallel/test-http-destroyed-socket-write2.js`; server destroys the response socket, client receives a transport failure. `closeAllConnections` excludes upgraded WebSockets | Reuse core HTTP and existing OpenBot shutdown helper; close Node/registry upgrades separately |
| Existing database fixture | PostgreSQL `17.11-bookworm`, OCI digest `051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0` | PostgreSQL/MIT image source plus Debian components | Existing smoke owns a randomly named/labeled loopback container with ephemeral storage; validates ownership before removal | Reuse `SmokeDatabase`; no external database, Testcontainers dependency or broad Docker cleanup |

## Reuse decision

Use the existing runner and production Server/Node/Provider classes in a dedicated test process.
Serve the actual application over loopback HTTP; enroll a real Node over the Owner API and connect
its authenticated WebSocket. The only replaced external system is the computer service. Its state
is synthetic, token/Bot-bound, bounded, and can change evidence/control or destroy a response after
recording a click. The local gap is repeatable fault orchestration and assertions across these
existing components. No protocol, authority or production behavior changes are required.

Approval expiry is injected by advancing that fixture's approval deadline in its disposable
PostgreSQL row, then using the real Owner decision route. This tests expiry decisions without
waiting two minutes and must be disclosed. The transport timeout uses the production deadline.
A cleanup gate at the Provider's existing fetch adapter boundary can withhold reader cancellation;
this verifies that another operation for the same Bot cannot enter until cleanup completes.
The gate never replaces Server policy or an approval outcome.

The driver builds existing workspaces, runs fixture regressions, provisions only its own database,
and invokes the generic CLI with a minimal environment and a new output path. Missing prerequisites,
fixture failures and cleanup failures must produce nonzero exit status; no required scenario skips.
The runner's abort and cleanup limits are not an OS sandbox. Keep future upstream API changes
explicit and rerun this suite plus real upstream/browser validation when upgrading.

## Source incorporation

No upstream source is copied or substantially adapted. New code only composes repository APIs
and supplies synthetic data and assertions. Existing dependency/license notices remain unchanged.

## Verification plan

Required scenarios: frozen exact ref/snapshot, approval once and duplicate decision refusal, denial,
expiry, Node stop, credential revocation/disconnect, evidence change, human takeover, real HTTP
timeout, one attempted click after lost receipt with no retry, and per-Bot exclusion until cleanup.
Inspect real durable Run/approval/artifact/audit results and before/after frame evidence. Run fixture
regressions, actual Docker-backed conformance (all checks required), cleanup inspection and
`npm run check`. Update English and Chinese Provider conformance documentation with commands,
coverage and limitations. Record actual host metadata as hermetic evidence only.

## Unresolved questions / B1b

The current Owner cancel route only cancels native (`executionProfile: none`) Runs. Node stop is
not Owner Worker-run cancellation. Disconnect handling only fails `running` Runs and can leave a
`waiting_approval` Run pending until another decision; approving while the Node is offline fails
closed. This suite must describe and test those available entry points accurately, not fabricate
an Owner cancellation path. Durable waiting-approval disconnect recovery and Owner Worker-run
cancellation remain B1b work. Capability leases and cross-process computer locks remain separate.

## Validation evidence (2026-09-23 local time)

The dedicated driver passed on the host reported as `macos`, `arm64`, `osVersion: 27.0.0`, using
Node `v26.0.0`. The final generic-runner artifact records **15 success, 0 failure, 0 skipped**:
eleven required browser scenarios plus four required declaration/target checks, no expected failures,
`summary.conformant: true`, `evidenceLevel: hermetic`. Twelve focused fixture/driver regressions also passed.
The synthetic PNG payloads have valid chunk CRCs; no real screenshots were collected.

The exact frozen click assertion compares the computer's recorded attempt to the **persisted
approval** before-state, not to the computer's mutable current state. Every synthetic snapshot
advances its generation, so an extra observation cannot silently authorize a replacement snapshot.
A first development run correctly returned nonzero with required setup failures when fixture Bot
names collided; random names fixed that fixture isolation bug without any production change.

`npm run check` passed, including documentation/research/configuration/release checks, lint,
typecheck, repository tests and builds. Existing opt-in PostgreSQL/native-platform tests in that
ordinary gate retain their documented skips; the dedicated Docker browser suite has **no skips**
and uses actual PostgreSQL for every scenario.

A separate real interruption test sent SIGTERM to the task-owned driver after the enrolled Node
entered `browser.approve-once: run`. It returned exit 1, created no report, reaped its child, and
returned the labeled Docker container inventory and private fixture directory inventory to their
initial values. Successful suite cleanup also removed its container and private files; computer
socket closure and zero active Provider executions are asserted inside fixture cleanup.

The root integration separately fixes the shared database readiness probe to use TCP
`pg_isready -h 127.0.0.1`: the official image's initialization-only Unix-socket server must not count
as final readiness. That shared helper change is intentionally owned by the integration track.
No real-browser or additional native platform evidence is claimed by these results.

Independent review reproduced a driver deadline defect: `execFile({timeout})` only sent SIGTERM;
an ignoring child kept its Promise pending, so a force-kill inside `catch` was unreachable. The
pinned [Node child-process contract](https://github.com/nodejs/node/blob/2645dc73720b1b4f27c49f395d3c66025ce126cc/doc/api/child_process.md)
distinguishes a timeout signal from an `AbortSignal` callback error. The final helper uses
`spawn({detached:true})` and an independent deadline/external-abort outcome, then drains the known
owned PGID through the shared D2 TERM/KILL and state-verification helper before awaiting pipe closure.
Direct-child, exited-leader/live-grandchild, unrelated-process preservation and output-bound
regressions pass as part of twelve fixture/driver tests. No new generic process supervisor or
dependency is introduced; no upstream source is copied. The process-group follow-up below records
why the earlier direct-child fix was insufficient.

## Follow-up: owned process-group cleanup (2026-09-23)

Root integration reproduced a separate lifecycle gap after the direct-child deadline fix: a parent
Node spawned a grandchild with inherited stdout/stderr; the grandchild ignored SIGTERM and remained
alive after the parent exited and `runConformanceChild` rejected. Turbo builds have descendants,
so waiting for the direct child is insufficient evidence of cleanup.

Re-read pinned [Node child_process implementation](https://github.com/nodejs/node/blob/2645dc73720b1b4f27c49f395d3c66025ce126cc/lib/child_process.js)
and [detached-process documentation](https://github.com/nodejs/node/blob/2645dc73720b1b4f27c49f395d3c66025ce126cc/doc/api/child_process.md#optionsdetached).
On POSIX, `spawn({detached:true})` creates a new session/process-group leader. `execFile` forwards an
explicit subset of options to `spawn` and does not forward `detached`; adding that option to
`execFile` cannot close this gap. A direct child can exit while inherited pipes or other descendants
remain alive. The existing Node release pin/license remains unchanged; no new dependency is needed.

First viable reuse: extract the already-reviewed D2 group lifecycle from
`scripts/smoke-dev-fixture.mjs` (introduced in `d52a9112d80d76fa16fdc1abad8cd80f15684733`) into one shared
helper. Preserve its exact known-PGID signal scope, TERM/KILL grace periods, Darwin EPERM numeric
state verification, live-member failure, own-child reap, concurrent-stop joining and retry behavior.
Both D2 `startProcess` and B1 use that implementation. No database behavior changes are part of
this extraction. See the [D2 Darwin review](2026-09-22-contributor-journey.md#shutdown-correction-darwin-exited-process-groups-2026-09-22)
for the fixed XNU source, official API evidence, licenses and existing regressions.

B1 switches to `spawn({detached:true})` with bounded output and an independent abort deadline. Child
exit, failure, deadline and external cancellation all finish by draining the owned group before
returning. A successful exited leader also cannot leave an in-group descendant behind. Explicitly
retest a parent that exits before its SIGTERM-resistant grandchild, inherited pipes, failure,
deadline, external abort, and an unrelated process that must remain alive. A deliberately escaped
new session is outside this POSIX process-group contract; this harness is not an OS sandbox.

Follow-up validation: **12 focused checks passed**, including all four descendant cases and the
retained output bound. The production Server/Node/Docker Provider required suite passed again:
**15 success, 0 failure, 0 skipped**. It removed its owned database and private directory. The
extracted numeric inspection and signal/stop implementation were also compared byte-for-byte to
D2 before extraction; database code was untouched. Focused Biome and documentation checks passed.
The root integration owns shared D2 regression execution and the final full repository gate.
