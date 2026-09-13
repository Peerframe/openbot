# Research: Native failure classification for non-permission errors

- Status: Implementation under review
- Date: 2026-09-13
- Owner: @yxflc11
- Related issue: F02 scope_revoked misused as lost channel permission
- Acceptance journey: Owner-facing failure text for unknown wait_for_task targets, usage
  conflicts, and skill/memory changes no longer claims the Bot lost channel membership.
- Security boundary: Server remains fail-closed for true membership loss. No permission
  relaxation, retries, or budget changes. Catalogue messages stay free of upstream bodies.

## Search evidence

The initial implementation used local inspection only. This independent upstream review was
completed before the follow-up changes; it does not backdate compliance of the initial commit.

- Searched GitHub `nodejs/node errors error.code stable error.message` and RFC Editor
  `RFC 9457 problem type detail`. Reviewed [RFC 9457 (July 2023), sections 1, 3.1 and 5](https://www.rfc-editor.org/rfc/rfc9457.html):
  separate machine classification from human detail and avoid exposing implementation secrets.
  Adopt those principles in the existing Run representation, without adding an HTTP
  `application/problem+json` endpoint or claiming wire-format conformance.
- Reviewed Node.js **v22.22.2**, tag `c7462cf36736a20ed7b8d701dedbe713dff0e1df` → commit
  **`2645dc73720b1b4f27c49f395d3c66025ce126cc`**: [public error-code guidance](https://github.com/nodejs/node/blob/2645dc73720b1b4f27c49f395d3c66025ce126cc/doc/api/errors.md),
  [catalogue source](https://github.com/nodejs/node/blob/2645dc73720b1b4f27c49f395d3c66025ce126cc/lib/internal/errors.js),
  [SystemError tests](https://github.com/nodejs/node/blob/2645dc73720b1b4f27c49f395d3c66025ce126cc/test/parallel/test-errors-systemerror.js)
  and MIT license. The tests distinguish code, name and message. The supported runtime already
  supplies `Error`; private `internal/errors` is not a public application API and is not imported.
- Checked the current errors maintenance queue, including open [nodejs/node#61599](https://github.com/nodejs/node/pull/61599)
  about array-element error wording. It reinforces stable-code handling but does not supply
  OpenBot Run/membership classification. No upstream source is copied or substantially adapted.
- First viable choice: standard classification principles plus the existing `Error`/Run
  catalogue. A new HTTP error dependency or private Node adapter would not interpret OpenBot's
  database predicates. No dependency/fork or new notice obligations; RFC material remains under
  IETF Trust terms and existing Node distribution notices remain unchanged.
- Follow-up gap: inactive Run/conflicting writes, invalid task context, changed reviewed
  resources and actual membership loss must be classified at the rejecting predicate.
  Preserve all rejecting guards and terminal behavior; old persisted errors are not rewritten.

- Search date: 2026-09-13
- Existing OpenBot entries checked: [agent-execution-experience](agent-execution-experience.md),
  [native-agent-loop](native-agent-loop.md), `docs/NATIVE_AGENT.md`, OPEN_SOURCE_REUSE native Agent
  loop row.
- Code inspection: `nativeFailureMessages` / `NativeExecutionError` in `agent-observations.ts`;
  throw sites in `native-agent.ts`, `postgres-agent-store.ts`, `postgres-agent-skills.ts`,
  `postgres-agent-collaboration.ts`; Owner ZH mapping in `NativeRunControls.tsx`.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| Extend existing `nativeFailureMessages` catalogue | Current OpenBot main (`0aafca2`) | Project | Already drives Run.errorCode, EN stored message, ZH UI map, and fail-closed paths | Fits Server-owned catalogue; mirrors `settings_changed` / `plugin_changed` | Select thin local classification |
| Reuse only `execution_failed` / `tool_unavailable` | Same | Project | Would stop the wrong permission string but collapse Owner guidance | Loses actionable distinction | Reject |
| New dependency for error taxonomy | n/a | n/a | No gap requiring an external taxonomy | Would add surface without closing authority | Reject |

## Reuse decision

- Selected option: local gap closed inside the existing failure catalogue.
- Selected upstream or standard: RFC 9457 classification/detail principles and the public Node
  Error/code model reviewed above, applied through the existing `NativeExecutionError` catalogue.
- Why this is the first viable option: the catalogue already separates settings/plugin changes from
  scope revocation; invalid targets and skill/memory drift were incorrectly aliased to
  `scope_revoked`.
- Exact OpenBot-specific gap: map wait_for_task unknown IDs and ineligible tool targets to
  `invalid_target`; usage optimistic-update misses to `conflict`; skill assignment/content drift to
  `skills_changed`; memory eligibility/revision drift to `memory_changed`; keep true
  `channel_bots` membership loss as `scope_revoked`.
- Upgrade, replacement, or exit plan: further catalogue entries may split conflict causes later
  without relaxing permission checks.
- Failure behavior: existing Server rejection predicates remain authoritative; this change adds no
  runtime service or package whose availability can affect authorization.

## Source incorporation

- Source copied or substantially adapted: no
- Files and upstream locations: n/a
- Required copyright or license notice location: n/a

## Verification plan

- Automated tests: unit coverage distinguishing `invalid_target` / `conflict` / `skills_changed`
  from `scope_revoked`; UI ZH message assertions; integration expectation for memory sharing
  revocation uses `memory_changed`; `npm run check`.

## Verification results

- Independent follow-up: 98 directed tests passed, including the actual NativeAgentRunner unknown
  child-task path and PostgreSQL lifecycle/membership tests against a disposable local instance.
- Typecheck and full `npm run check` passed. The temporary database was stopped and removed.
- Web message tests use jsdom; corrected installed-app behavior and platform CI remain separate
  release checks. These results do not identify the cause of an earlier installed-app failure.
