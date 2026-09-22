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
