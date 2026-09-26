# Approved Work browser capture

Design reviewed before implementation on 2026-09-26, baseline `364d3082f7934605b6f70600704b60bc00a69f82`.

## Reuse decision

Use the existing Work deferred approval, private ToolResults/LocalWorkFiles and exact Worker
browser connection binding. Reuse the retained `browser.command` observe operation and Node/Docker
adapter; no new wire protocol, browser driver, executor or retry engine. Existing pins and licenses:
Temporal Python 1.33.0 (MIT), PydanticAI 2.47.0 (MIT), Pydantic 2.13.5 (MIT), psycopg 3.3.6 (LGPL-3.0),
PostgreSQL 17.11, and CopilotKit/OpenBot agent-computer
`257c1280d684089be9adb0b35cce262efc7064bf` (MIT), Playwright 1.62.1 (Apache-2.0).
See `OPEN_SOURCE_REUSE.md`, `python-product-runtime.md`, `work-tool-results.md`,
`browser-host-binding.md` and `controlled-browser-click.md`. OpenBot MIT adapter patterns are
adapted locally; no third-party implementation is copied and no dependency is added.

Primary documentation rechecked:
[Temporal Activity definitions and retries](https://docs.temporal.io/activity-definition),
[PostgreSQL 17 locks](https://www.postgresql.org/docs/17/explicit-locking.html),
and the [pinned upstream browser source](https://github.com/CopilotKit/openbot/blob/257c1280d684089be9adb0b35cce262efc7064bf/agent-computer/src/index.ts).
GitHub searches and maintained upstream source/tests/license checks are retained in the linked
browser reviews. The web reader could not open the pinned tree; the previously hash-verified
upstream cache confirms `/screenshot` and per-Bot profile selection. Temporal can re-execute an
Activity after an acknowledgement loss; the existing Work admission/receipt contract remains the
at-most-once dispatch authority. Upstream browser functionality does not supply that authority.

## Bounded product path

Add an opt-in Server configuration mapping specific Bot ids to original Node ids. Capture the
model selection, current Node credential and previously Owner-opened browser host binding in a
new immutable Work browser profile at channel Task creation. It is mutually exclusive with a
command profile; browser selection cannot silently broaden command-only Tasks or historical Tasks.
The sole tool is `capture_browser`, with empty arguments and explicit Owner approval every time.
Native Task scope, collaborators, navigation, click, typing, downloads and public egress are unchanged.

Preparation binds the current connection and latest durable human-control event. A human takeover,
even followed by release, invalidates that prepared observation. Dispatch holds the shared Agent
pause gate, rechecks original Action/Task/source/claim/approval and exact host identity at the actual
socket send, and records a durable attempt before sending. A cancelled, revoked, replaced or paused
scope cannot dispatch. Uncertain results are looked up only; no retry captures a new screen as if
it were the original observation. At most four attempts per Task, across correction generations.

Store bounded PNG bytes in the existing private content-addressed store. Work history, audit and
model observations contain only verified metadata, not image base64 or Node credentials. The
original blob and digest must match before publication. The model receives no visual content and
must not claim to have interpreted the page. Result review verifies capture metadata/publication,
not page meaning. Owner downloads the exact PNG on verified Task completion. Default composition
remains disabled; this does not qualify browser egress, physical profile storage or human input.

## Acceptance

Actual owned PostgreSQL plus public HTTP/WebSocket enrollment, real Node/Docker adapter against a
synthetic computer, and existing Work approval/settlement/result publication. Cover denied approval,
scope revocation, same-id enrollment, takeover/release between prepare and execute, cancellation,
lost receipt acknowledgement, restart lookup without resend, receipt/blob corruption, capacity and
binary artifact review. SDK/model fixtures remain explicitly synthetic; Linux CDP component and
paid-model evidence are reused without rerunning. Run required repository checks and keep CI
ownership separate from this product increment.


## Implemented candidate and evidence

DSH/DeepSeek implemented the initial `work_browser_profiles.py` from the verified public OpenBot
MIT `work_command_profiles.py` at `1978bcb4d46160ecd75a0c862328495876a71e53` (SHA-256
`4d1477b8b9babdc2bebb175f3ef3b17d6ba123602dcf39a283125f8742ca3f0a`). Only the explicitly authorized
bounded design packet and that public reference were sent. Root corrected the candidate's
`run_events.kind` query to the actual `type` column, ordered by `created_at,id`, and removed ID
case normalization to preserve the retained exact-identity contract. DSH's syntax check alone
was not counted as runtime acceptance.

The final adapter shares BrowserSessions' existing PostgreSQL human gate, captures its durable
revision, and checks the Work SDK/Task/Action/correction/claim at preparation, actual socket send
and reply. The durable attempt is committed before transport. The Server never retries a screenshot
on lookup; a received private ToolResult can settle after acknowledgement loss, while an absent
receipt stays unknown. Historical PNG access still checks the current original profile and source.
No URL, credential digest or image base64 is returned in the public tool payload. Result review
receives PNG metadata only and explicitly cannot certify its visual contents.

Canonical SQL is now 44 entries through `0043_work_browser_profiles`. Fresh owned PostgreSQL 17.11
migration succeeded. The older 43-entry paired restore, real Linux CDP/native command and paid
model evidence remain separately pinned and were not rerun or relabeled. The new Node switch is
explicitly off by default; takeover remains disabled in normal Python startup.

Validation on 2026-09-26:

- `tests/test_work_product_browser.py`: 17 tests with real PostgreSQL, HTTP enrollment, original
  Worker WebSocket, immutable profiles, public Work approval, exact private PNG download, result
  review, receipt lookup, denied/changed authority, cancellation before send/after reply, missing
  receipt, human takeover/release, and task-wide four-attempt bounds across corrections. One case
  starts the real Node client plus configured Docker Provider and synthetic loopback computer.
  Model responses and Temporal SDK/history bindings are synthetic, not a new live-model or real
  Temporal restart qualification.
- 187 adjacent tests passed: native/channel profiles, product Runtime, read tools, result review,
  model ports, Work sources, browser sessions and immutable Worker browser bindings.
- 30 Node/config tests passed, including the real WS/provider/HTTP transport and explicit opt-in.
- `npm run check` passed. Initial run executed repository prerequisites, 6 of 33 typecheck tasks,
  4 of 33 test tasks and 2 of 20 builds; other Turbo tasks reused valid cache.

Observed failures were fixed or scoped: the first test fixture opened a `none` employee as a
browser; setting its intended `docker-linux` profile fixed setup. The first full product path
exposed a command-only provenance key in ProductWorkReads; browser Tasks now record their own
`browserProfileSha256`. A sandbox Node attempt could not bind loopback (`EPERM`); the authorized
local test then passed. One adjacent invocation named a nonexistent test file and ran no tests;
using `test_work_sources_postgres.py` produced the 187-test result. No failed/empty invocation is
included in the passing counts.

Reproduce from the pinned Worker environment and an owned synthetic PostgreSQL fixture via
`OPENBOT_CONTROL_TEST_FIXTURE`, with `PYTHONPATH=apps/server-python/src:apps/agent-runtime-python/src`:

```sh
npm run check
apps/server-python/.worker-venv/bin/python -m pytest apps/server-python/tests/test_work_product_browser.py -q --tb=short
```

The test is registered in `apps/server-python/worker-tests.txt` for the existing disposable
`test:control:python` gate. No private machine path, paid account, VPS or credential is needed.
Paired restore for schema 44, final packaging, page interaction/interpretation and browser egress
remain distinct gates. This increment does not replace the dedicated CI task or retire the TS
business Server.
