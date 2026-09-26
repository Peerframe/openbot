# Reviewed click handover serialization repair

- Date: 2026-09-25
- Scope: three Docker Provider modules and focused tests; no wire, capability-default, dependency, Python gate, or persistent uncertainty changes.
- Source baseline: current repository files recorded in SOURCE_HASHES.json. Existing reuse decisions: `docs/OPEN_SOURCE_REUSE.md` Browser computer/egress rows, `docs/research/controlled-browser-click.md`, and `docs/research/python-browser-sessions.md`.

## Evidence and reuse decision

The separate browser remains CopilotKit/OpenBot agent-computer at **257c1280d684089be9adb0b35cce262efc7064bf**, MIT, with its existing Playwright **1.62.1**, Apache-2.0. Official raw index/control/profiles and their tests, manifest/Dockerfile/LICENSE are locally verified in `/private/tmp/openbot-browser-vps-review-20260925/upstream/SOURCES.json`; this review reads those exact files. The web tool was unable to fetch that pinned commit, so the already pinned direct-upstream cache is reused. No source from upstream is copied.

Primary references:
- https://github.com/CopilotKit/openbot/tree/257c1280d684089be9adb0b35cce262efc7064bf/agent-computer
- https://raw.githubusercontent.com/microsoft/playwright/v1.62.1/docs/src/actionability.md (read again this turn).

The upstream offers separate `/snapshot`, `/control`, `/control/take`, `/control/release`, `/screenshot`, and original-ref/snapshot-bound `/click`. Playwright checks actionability but does not own Server approval or the local Provider queue. The reviewed upstream API therefore remains the first viable implementation; the missing local ordering requires only a thin adapter correction, not a new scheduler, library, browser backend, or wire contract.

The pre-repair Provider enclosed its entire reviewedClick call, including the 120-second approval wait, inside BrowserCoordinator.run. The independently supplied synthetic reproduction records `/click` before an already requested `/control/take`. Existing reviewedClick tests only change the upstream control answer directly and do not exercise that queue.

## Chosen correction before implementation

Split navigation/observation/prepare, the existing Server approval wait, and commit. The first and third segments retain the same Bot serial queue; the approval Promise does not. Preparation receives an opaque process-local generation from that queue. A valid Owner take rotates the generation before any upstream take attempt; success, rejection by the backend, or lost response cannot preserve the old approval. Release removes the pause only after its existing screenshot validation and never restores the old generation. Commit reacquires the queue, compares that exact generation, checks current control and current screenshot, and sends the frozen click ref/snapshot exactly once. Existing activeBots still covers the whole execution, including review wait.

This is local enforcement, not Server authority or durable recovery. No pending approval survives a Worker process restart. No transport retry is introduced. An uncertain click remains unknown with a fixed warning and cannot be retried by the same prepared handle. A later independently authorized new task is outside that handle. The Python BrowserPauseGate remains a distinct, default-off integration prerequisite; this repair does not connect Work browser effects or establish Linux/browser conformance.

## Focused validation

Exercise the actual createDockerProvider with synthetic transport and deferred approval: take completes before approving; approval after take cannot click; take then release cannot revive old approval; uncertain take remains paused and invalidates generation even after explicit successful return; cancellation/denial/expired approval/changed frame/upstream human holder block commit; unknown/malformed/aborted click response never causes a second dispatch. Preserve default-off and original Provider tests. Test one-shot preparation and distinct-Bot independence. No live browser, network, VPS, provider credential, or model call is required for this bounded queue bug.

## Integrated verification

Root reviewed and integrated the five-file repair, then ran the focused browser/reviewed-click
suite:34 tests passed. Provider TypeScript checking and the subsequent full repository check
passed. Transport remains synthetic in these tests; actual Linux/Chromium/product integration
is a separate gate. No external dsh review was executed for this repair.
