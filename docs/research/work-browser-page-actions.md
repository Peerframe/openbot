# Approved Work browser page actions

Design checkpoint2026-09-26, parent63242fc. The local product flow is qualified as described below.

## Reuse and source review

Extend the existing Work approval/receipt path and the existing serialized Node/Docker browser
adapter. Keep CopilotKit/OpenBot agent-computer at257c1280d684089be9adb0b35cce262efc7064bf (MIT),
Playwright1.62.1 (Apache-2.0), PostgreSQL17.11, Temporal Python1.33.0 and PydanticAI2.47.0.
Existing source/license/tests/issues are reviewed in [the capture review](work-browser-capture.md),
[reviewed click](controlled-browser-click.md) and [handover review](work-browser-handover.md).
Rechecked primary [ARIA snapshots](https://playwright.dev/docs/aria-snapshots),
[actionability](https://playwright.dev/docs/actionability) and GitHub searches for
`CopilotKit openbot agent-computer snapshot read browser`. The pinned cached source exposes
`/read`, `/snapshot`, reference-bound `/click` and `/type`, `/key`, `/scroll` and `/navigate`.
Snapshot mutates reference identity; it must not be refreshed between approved evidence and input.

The first viable option remains a thin adapter. A new driver, browser framework or retry engine
would duplicate released upstream behavior without supplying Server authorization. No new production dependency or third-party implementation is copied. Existing local MIT adapter
patterns are reused. The optional fixture downloads the pinned upstream source, verifies every
SHA-256 and preserves its MIT LICENSE; it applies only a loopback listener binding patch. Its
separate npm lock pins Playwright1.62.1, spiffe0.5.1 and yaml2.9.0, unchanged from the accepted
handover fixture.
The deferred browser egress entry in OPEN_SOURCE_REUSE remains a real limitation: DNS preflight
and allowed origins do not constrain redirects/subresources. This increment is disabled by default
and restricted to explicitly configured trusted test origins; public untrusted browsing requires
an enforced Host/network boundary before final retirement.

## Intended contract

A separate immutable page scope beside the unchanged version1 capture profile freezes allowed
origins and a sixteen-operation budget at new Task creation only. Existing capture-only Tasks
never gain page-reading or input capability. Private
Server composition and Node configuration must independently opt in. Reuse the existing original
Node credential/connection binding and PostgreSQL human gate. Each read, navigation and input
requires a separate Owner-approved Work Action; all page content is untrusted model input.

A successful read records bounded text and ARIA elements plus a private screenshot digest.
Subsequent input names an applied observation from this exact Task/Run and an observed reference;
Server resolves it, freezes URL/snapshot/control revision/connection/frame digest and exact input
before approval. The Node checks unchanged screenshot and original reference before a single input.
Never use model-provided selectors, script, credential paths or arbitrary endpoints. A lost response
recovers the original stored receipt only; missing evidence remains unknown and is never resent.
Takeover, correction, route/source revocation or changed identity invalidates pending actions.

The existing Temporal Worker owns continuation. Page text is bounded data rather than authority;
responses and results must state observed evidence and uncertainty. Historical captures remain
readable only under their original grants. The accepted human path and its pause semantics remain.

## Required verification

Exercise malformed/oversized upstream responses, stale screenshot/reference, default-off and
wrong origins, withheld approval, cancellation, takeover, changed route/identity and lost receipt.
Use real PostgreSQL/public Owner HTTP/Node and pinned Chromium on disposable owned pages. Check
actual model tool observations, paused/restarted Worker approval and history replay without repeated
browser effects. A synthetic model does not prove visual-model understanding. Keep Linux isolation,
egress and installed replacement separate until their real product checks pass.

## Reproducible fixture and CI dependency review

The real product probe is `experiments/work-journey/product_browser_probe.py`. It uses owned
PostgreSQL/mTLS Temporal, the actual product entry and Node, pinned upstream Chromium and a
synthetic model/target. It retains no personal browser profile and requires no paid model account.
The CI environment uses official [setup-bun v2.2.0](https://github.com/oven-sh/setup-bun/tree/0c5077e51419868618aeaa5fe8019c62421857d6),
commit0c5077e51419868618aeaa5fe8019c62421857d6, MIT, to install Bun1.3.14. Reviewed action.yml,
src/action.ts, upstream test workflow, release and open issues (notably checksum-input request186
and proxy support180), plus [official installation docs](https://bun.com/docs/installation).
The official released installer is the first viable option; no installer is copied. This is a
disposable CI tool, not production authority. Exact action/Bun versions are pinned; upstream
source hashes and fixture dependency integrity are checked separately.

## Local qualification

DeepSeek, via explicitly authorized DSH, implemented `providers/docker/src/browser-task.ts`;
local integration added strict shared protocol parsing, exact-origin validation and the Server
approval path. It provided implementation assistance, not independent review.

Actual local Chromium/Node/product API/PostgreSQL/mTLS Temporal completed four separately approved
operations: navigate, fill Unicode text, click once and read the resulting page. The Owner approved
the original click while the real SDK Worker was stopped; restarting that Worker used the same
Node connection and performed the click exactly once. Independent target state, the final report
download and offline history replay agreed; replay added no browser or model calls. The model and
independent result reviewer were synthetic HTTP fixtures, so this does not prove visual inference.
The real flow exposed a checkpoint-identity comparison bug: ordinary continuation creates distinct
checkpoint ids without changing authority. The fix validates both original and current contexts
against the current instruction generation, while actual Owner correction still invalidates old
page references. A dedicated PostgreSQL regression covers both outcomes.

The host remains a trusted local-page fixture. Network egress, hostile pages, isolated Linux
browser product execution, browser/Host replacement and final installed retirement remain
unqualified. Screenshot equality is change detection, not a network or malicious-DOM boundary.

Validation at this checkpoint: `npm run check` passed;15 page authority/cancellation tests passed on
real owned PG. The earlier57-case page/result batch and95 of96 adjacent cases were successful;
the one prompt-wording regression was corrected and its complete44-case result suite passed in
that57-case batch. The base Python gate passed1306 with463 environment-dependent skips. Forty
historical migration/restore and eight cleanup cases passed on canonical45. The actual repository
product probe and unauthenticated pinned-source fetch both completed, with owned runtime resources
closed. Hosted Linux browser results are pending the new PR head.

## Whole-Control and Node interruption qualification — 2026-09-26

Before expanding the fixture, reviewed the current Server connection binding, durable pause gate,
Node stop/reconnect implementation and the existing reuse entries. Rechecked the primary
[Workflow execution contract](https://docs.temporal.io/workflow-execution),
[SDK1.33.0 release](https://github.com/temporalio/sdk-python/releases/tag/1.33.0) at ab52fdd and
[open replay issue1881](https://github.com/temporalio/sdk-python/issues/1881). Existing Apache-2.0
SDK source/tests and pinned browser dependencies remain unchanged; no upstream code is copied.
This probe uses the existing remote Activities and explicit history replay; no local-Activity
adapter or alternate recovery engine is introduced.

Extend the owned product fixture, retaining the already accepted same-connection case. Stop the
Worker at the original pending click, then separately kill/restart the complete Control process,
kill/recreate the actual Node process, or revoke/re-enroll that same Node id in a new process. Approving the old click after a
connection/identity change must never dispatch it. Record the original action's durable outcome,
the independent target counter, cancellation and replay without new input. Separately hold human
control through disconnection and check old-view refusal, persisted pause, explicit reacquisition
and return; a replaced credential must not inherit the original browser binding or profile.
Reuse released transport/lifecycle APIs and the existing probe rather than a second fixture or
production restart mechanism. These are actual process/connection tests on a trusted local page;
they do not qualify Linux isolation, network egress, in-flight response loss or profile migration.

The interruption fixture uses a separate child process for the Node modes, with the owned target
and upstream browser kept in the parent fixture. Private stdin supplies only disposable test
credentials; SIGKILL targets the exact child handle and distinct recorded PIDs prove replacement.
The Node, Provider and browser authority code is unchanged. Browser/Host process replacement is
not inferred from Node replacement. The pinned Playwright1.62.1 exported coreBundle registry is
read only to verify its exact headless-shell binary before starting any owned database or Action.

All three actual local cases passed: whole Control restart, two Node SIGKILL/replacements with
three distinct child PIDs, and one same-id credential replacement with two distinct PIDs. Old
click approvals caused zero Node click calls and zero target submissions. Human pause survived
Control/Node interruption and required explicit reacquisition/return. New credentials could not
open the old bound browser. Cancellation removed authority and preserved the unknown action;
the engine closed FAILED, while the Task remained open for reconciliation. This is expected
fail-closed behavior, not successful completion. All three histories replayed with unchanged
browser/model counters, and owned resources closed. The probe's initial missing-browser and
cancellation/error-envelope assumptions were corrected without weakening product guards.
`npm run check` passed; reproducible modes run in CI. Results are in
`experiments/work-journey/evidence/product-browser-interruption.json`.

## Lost browser response and profile process replacement — design 2026-09-26

Reuse the same pinned upstream, Playwright, Node HTTP transport and owned product probe. Read the
exact cached upstream `profiles.ts` and `index.ts` stop/shutdown implementations, the upstream
GitHub profile/configuration documentation and open issue246 (human control does not restrict its
shell). Rechecked [Node HTTP](https://nodejs.org/api/http.html) response destruction and
[Playwright context close](https://playwright.dev/docs/api/class-browsercontext#browser-context-close).
No shell endpoint is exposed by this fixture or the product browser adapter. Dependencies, source
pins, licenses and production authority remain unchanged; no upstream source is copied.

For response loss, insert a disposable loopback-only HTTP relay to the exact owned upstream.
Forward a click once, wait for its successful upstream response and independent target submission,
then destroy its response socket. Assert that the product records unknown, never resends the click,
closes authority on cancellation, and replays without another browser/model call. This is an actual
transport failure after an actual effect, not a mocked Provider result. The relay is a fault fixture,
not an egress proxy or deployable network boundary.

For process replacement, stop the exact owned browser service gracefully, prove its exit before
starting a distinct process on the same private profile directory, and check persisted synthetic
state through the product's human-control path. Do not infer crash consistency, arbitrary site
login retention, Linux isolation, disk migration or permission to repeat unresolved actions.

Both actual local cases passed. After the relay destroyed the successful click response, the target
had one submission, the original action stayed unknown, cancellation closed authority and offline
replay added no calls. Graceful service replacement proved distinct service and Chromium PIDs and
old-browser exit, retained localStorage/expiry cookie/IndexedDB in the same private directory, dropped
the session cookie and preserved human control until explicit return. The initial fixture assumed
a SingletonLock existed; the actual headless shell does not create it. The corrected observation reads
PID/parent ids, then only the exact owned service's child arguments to identify its private profile;
no personal process arguments are collected. No product guard changed.

The existing browser CI steps move to a separate required job, using the same reviewed setup-node,
setup-bun, npm and Python locks. This lets the browser cases run alongside the long Temporal matrix;
no lane loses a gate. The final merge check includes every lane and refuses skipped/failed results.
The new job builds the actual Node dependency closure and canonical DB package before the real probe.

Hosted9927513 reached its50-minute job limit after all four browser modes passed, during the final
Temporal matrix. Actual step times were16m50s through SQL parity,5m32s browser setup/cases, then
27m50s of still-running recovery. Move that unchanged long recovery/upgrade step to its own required
job as well, with the same Control/Runtime bootstraps, full Worker lock and canonical DB build.
No timeout, per-probe deadline, matrix case or expected failure changes.
