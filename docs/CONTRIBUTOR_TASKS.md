# Contributor work packages

[English](CONTRIBUTOR_TASKS.md) · [简体中文](CONTRIBUTOR_TASKS.zh-CN.md)

These packages are backlog scope and historical delivery notes, not instructions to rebuild completed
work. Before choosing one, check its current implementation and [repository map](REPOSITORY_MAP.md).
Use an issue to agree large/new scope; ordinary fixes may start with a focused PR. Apply
[root research triggers](../AGENTS.md#research-before-implementation): reuse valid decisions and pins;
only new dependencies/protocols/authority/persistence/architecture choices need targeted research.
Older “Research first” lists below are references for those choices, not a fresh survey per repair.
Keep support claims within actual evidence. C1→C2→C3 progress lives only in the
[upgrade handoff](REPOSITORY_UPGRADE_PLAN.md).

## Next: fresh-checkout contributor smoke

Status: partially delivered. `npm run dev:smoke` already verifies fresh Python Server/Web startup,
Owner login through the Web proxy and authenticated workspace access; the Linux Python CI job runs it.
Optional development Node enrollment and restart with retained identity remain outside that smoke.

- **Outcome:** one documented CI/local path proves a clean checkout can start Server/Web, sign in,
  enroll an optional development Node and restart it with the retained identity.
- **Start in:** `CONTRIBUTING.md`, `scripts/smoke-dev-startup.ts`, `.github/workflows/ci.yml`,
  existing auth/Node fixtures. Extend the existing smoke instead of adding another startup runner.
- **Research first:** reuse the current pinned Node/npm/PostgreSQL toolchain and lifecycle tests;
  compare existing CI service/readiness patterns before introducing a runner.
- **Acceptance:** fresh private fixture paths, synthetic credentials, no paid model or user profile;
  readiness failures explain the missing service; processes and fixture data are cleaned up.
- **Out of scope:** installer publication, new Providers or an owner-only setup service.

## Next: retained-data migration regression

Status: partially delivered. [S7 synthetic qualification](../experiments/s7-migration/README.md)
already retains two sealed histories, synthetic Bot/channel/message/Run/artifact rows and paired
restore checks in CI. The complete appearance/template/import-receipt/automation fixture below
is still missing; extend the existing fixture rather than recreate its completed baseline.

- **Outcome:** contributors can prove that the reviewed old migration prefix upgrades with retained
  appearance, Employee templates, import receipts and automation rows unchanged.
- **Start in:** `packages/db`, `scripts/verify-database.mjs`, the existing CI database job, and
  [manual migration guidance](DATABASE.md).
- **Research first:** reuse the reviewed Drizzle/Postgres.js runner and PostgreSQL transaction
  semantics from [workflow research](research/developer-workflow-refactor.md).
- **Acceptance:** a repository-owned synthetic fixture, explicit suite/environment/database mapping,
  concurrent and repeated migration, old-row equality, retained constraints, and application rollback
  that keeps applied migrations. A missing requested fixture must fail clearly rather than skip.
- **Out of scope:** rewriting migration history or claiming full cross-machine backup restoration.

## Next: consistent workspace snapshot contract

Status: investigation proposed. Current Web ordering tests pass; a global ordering contract is not implemented.

- **Outcome:** define snapshot revision and count semantics that another client can implement without
  reproducing the Web client's event heuristics.
- **Start in:** Server workspace queries/events, `packages/domain`, `packages/protocol`, and
  `apps/web/src/use-workspace-state.ts`; see [workspace research](research/workspace-state-refactor.md).
- **Research first:** compare maintained revisioned snapshot/event APIs and PostgreSQL snapshot
  isolation; record an ADR before changing the wire format.
- **Acceptance:** a deterministic reproduction covers counts queried at different times, active Runs
  outside the recent-Run page, duplicate events and reconnect. Define compatible behavior before
  implementation; the existing Web currently does not consume `counts.activeRuns`.
- **Out of scope:** a new global client cache framework or moving Server authority into the browser.

## Starter: Create Bot dialog modal lifecycle regression

- **Status:** Delivered (D4). Regression coverage in `CreateBotDialog.test.tsx` (showModal, labelling, cancel/close unmount, create `role="alert"`). Opener focus restore after autofocus remains a known product follow-up; see `docs/research/starter-dom-regressions.md`.

- **Goal:** prove the existing Create Bot native modal matches the accessibility baseline already
  claimed for Owner create dialogs.
- **Existing behavior:** `CreateBotDialog` opens through `useModalDialog`, labels the dialog with
  `aria-labelledby`, exposes an icon close control named `关闭`, surfaces create failures with
  `role="alert"`, and attempts to restore the opener when the dialog closes; autofocus ordering
  remains unresolved.
- **Covered:** `CreateBotDialog.test.tsx` now mounts the dialog and checks its labels, cancel/close
  unmount and failed-create alert. `docs/ACCESSIBILITY.md` lists these regression commands.
- **Remaining:** capture the true opener before autofocus and add the Create Bot path to the
  manual browser checklist; the delivered jsdom tests do not prove browser focus restoration.
- **Entry files:** `apps/web/src/components/CreateBotDialog.tsx`,
  `apps/web/src/components/useModalDialog.ts`, `apps/web/src/test/render-component.tsx`,
  `docs/ACCESSIBILITY.md` (+ `.zh-CN.md` if the checklist text changes).
- **Prerequisites:** Node engine from root `package.json`; `npm ci`; no PostgreSQL, paid model, or
  Desktop app required.
- **Commands:**
  ```bash
  npm exec --workspace @openbot/web -- vitest run src/components/CreateBotDialog.test.tsx
  npm --workspace @openbot/web run typecheck
  npm run docs:check
  ```
- **Acceptance counter-examples:** Escape / `cancel` leaves the dialog mounted; opener does not
  regain focus after close; missing `aria-label` on the icon close; failed `onCreate` rejection is
  rendered without `role="alert"`.
- **Non-goals:** axe/Playwright CI gates; Create Channel or export/import dialogs; WCAG claims.
- **Dependencies:** none beyond the existing Web Vitest/jsdom harness. Research note:
  [contributor-starter-slices](research/contributor-starter-slices.md).

## Starter: Employee profile tab keyboard DOM regression

- **Status:** Delivered (D4). Interactive jsdom coverage in `EmployeeProfileView.test.tsx` asserts Arrow/Home/End move `aria-selected` and focus together; ArrowDown stays a no-op.

- **Goal:** prove horizontal profile tabs move **focus and selection together** under the keys
  already documented in `docs/ACCESSIBILITY.md`.
- **Existing behavior:** `EmployeeProfileView` exposes one `tablist`, seven tabs, and
  `profileTabForNavigationKey` for ArrowLeft/ArrowRight/Home/End with wrapping.
- **Covered:** `EmployeeProfileView.test.tsx` dispatches keydown on focused tabs and asserts
  selection, focus and tabIndex together, including wrapping and ArrowDown remaining a no-op.
- **Entry files:** `apps/web/src/components/EmployeeProfileView.tsx`,
  `apps/web/src/components/EmployeeProfileView.test.tsx`, `apps/web/src/test/render-component.tsx`,
  `docs/ACCESSIBILITY.md` (link the new regression from “Reproduce the checks” if needed).
- **Prerequisites:** `npm ci`; jsdom Vitest only.
- **Commands:**
  ```bash
  npm exec --workspace @openbot/web -- vitest run src/components/EmployeeProfileView.test.tsx
  npm --workspace @openbot/web run typecheck
  ```
- **Acceptance counter-examples:** ArrowRight changes `aria-selected` but leaves focus/tabIndex on
  the previous tab; Home/End ignore wrapping ends; ArrowDown activates a tab (must remain a no-op).
- **Non-goals:** screen-reader matrices; forced-colors / reflow evidence; new profile tabs or
  editors.
- **Dependencies:** none. Research:
  [contributor-starter-slices](research/contributor-starter-slices.md).

## Starter: RunInspector Escape and focus-restore regression

- **Status:** Delivered (D4). `RunInspector.integration.test.tsx` now locks Escape→`onClose`, labelled close control, and prior-focus restore on unmount.

- **Goal:** lock the Escape-close and opener focus restoration that `RunInspector` already
  implements for its custom overlay.
- **Existing behavior:** on mount, `RunInspector` focuses the labelled close control, listens for
  Escape to call `onClose`, and restores the previous focus on unmount (`role="dialog"`,
  `aria-modal="true"`).
- **Covered:** `RunInspector.integration.test.tsx` covers child-run wiring, Escape, the labelled
  close control and prior-focus restore on unmount.
- **Remaining:** `docs/ACCESSIBILITY.md` still calls for a fuller native-dialog/focus-trap review;
  that product change is separate from the delivered regression.
- **Entry files:** `apps/web/src/components/RunInspector.tsx`,
  `apps/web/src/components/RunInspector.integration.test.tsx` (or a sibling focused test),
  `docs/ACCESSIBILITY.md`.
- **Prerequisites:** `npm ci`; no Server process required for the jsdom regression.
- **Commands:**
  ```bash
  npm exec --workspace @openbot/web -- vitest run src/components/RunInspector.integration.test.tsx
  npm --workspace @openbot/web run typecheck
  ```
- **Acceptance counter-examples:** Escape does not invoke `onClose`; unmount leaves focus on an
  unrelated node; close control lacks an accessible name.
- **Non-goals:** migrating the overlay to native `<dialog>`; Tab focus-trap redesign; axe CI;
  claiming WCAG conformance.
- **Dependencies:** none. Research:
  [contributor-starter-slices](research/contributor-starter-slices.md).

## Starter: Node manager dialog modal lifecycle regression

- **Status:** Delivered (D4). `NodeManagerDialog.test.tsx` opens the dialog, asserts `showModal`/labelling, keeps revoke confirmation copy, and unmounts on cancel. Opener focus restore shares the autofocus follow-up noted above.

- **Goal:** prove the Node manager Owner dialog uses the same native modal lifecycle as other
  create/manage dialogs.
- **Existing behavior:** `NodeManagerDialog` mounts a `<dialog>` through `useModalDialog` and
  presents revoke confirmation copy in `NodeIdentityList`.
- **Covered:** `NodeManagerDialog.test.tsx` opens the dialog, checks its labels and revoke copy,
  then fires `cancel` and asserts unmount.
- **Remaining:** opener focus after autofocus is not verified and shares the Create Bot defect.
- **Entry files:** `apps/web/src/components/NodeManagerDialog.tsx`,
  `apps/web/src/components/NodeManagerDialog.test.tsx`,
  `apps/web/src/components/useModalDialog.ts`, `apps/web/src/test/render-component.tsx`.
- **Prerequisites:** `npm ci`; synthetic Node identity fixtures already used by the existing test.
- **Commands:**
  ```bash
  npm exec --workspace @openbot/web -- vitest run src/components/NodeManagerDialog.test.tsx
  npm --workspace @openbot/web run typecheck
  ```
- **Acceptance counter-examples:** `showModal` never runs; Escape leaves the dialog in the tree;
  opener is not focused after close; revoke confirmation UI disappears from the mounted dialog
  regression (keep the existing destructive-copy assertions).
- **Non-goals:** proof-of-possession Node identity; enrollment token UX; Windows/macOS Keychain
  changes.
- **Dependencies:** none. Research:
  [contributor-starter-slices](research/contributor-starter-slices.md).

## Intermediate: accessibility regression runner

- **Outcome:** a repeatable report catches keyboard, name/role/state, and high-confidence WCAG
  regressions in the built Web app across CI.
- **Start in:** `apps/web`, `.github/workflows`, `docs/ACCESSIBILITY.md`.
- **Research first:** compare `axe-core`, Playwright accessibility tooling, and maintained Vitest
  integrations; pin versions and licenses. Reuse the delivered Starter dialog/tab regressions above
  when selecting a repo-wide runner.
- **Acceptance:** deterministic local command; CI artifact; no live network; documented false
  positives; one fixture that proves a violation fails the gate.
- **Out of scope:** claiming screen-reader or WCAG conformance from automation alone; replacing the
  focused Starter regressions.

## Intermediate: translation consistency checker

- **Outcome:** English source docs and maintained locale files cannot silently lose required safety
  warnings, commands, or configuration names.
- **Start in:** `scripts/check-docs.ts`, `README*.md`, `docs/*.md`.
- **Research first:** evaluate documentation-lint and localization consistency tools before adding
  local rules. Reuse existing local-link checks; do not weaken `docs:check`.
- **Acceptance:** catches a deliberately missing warning/link in a fixture; does not require machine
  translation; prints the exact file and missing contract.
- **Out of scope:** judging prose quality or modifying translations automatically.

## Delivered foundation: Provider conformance runner

- **Delivered:** `@openbot/provider-conformance-runner` executes bounded, deterministic scenario
  lifecycles, suppresses raw thrown values, always attempts cleanup, applies explicit
  expected-failure baselines, and creates a new private JSON evidence file without overwrite.
- **Start in:** `packages/provider-conformance-runner`, `packages/provider-sdk`, Provider integration
  tests, and `.github/workflows`.
- **Research baseline:** pinned MCP Conformance, OCI runtime-tools, Sonobuoy, and Vitest reviews; see
  [the runner research record](research/provider-conformance-runner.md).
- **Remaining contribution:** author Provider-specific hermetic suites, connect report artifacts to
  the hosted matrix, and run named suites on controlled Windows, macOS, and Linux devices.
- **Preserve:** no raw secrets in artifacts; expected failures stay non-conformant and expire;
  real-device metadata is mandatory; the runner never self-certifies a platform.
- **Still out of scope:** a hosted certification authority or provisioning a real-device CI fleet.

## Intermediate: Agent Skills quarantine worker

- **Outcome:** an isolated Worker inspects a bounded skill directory with the official `skills-ref`
  validator and returns findings without installing or executing it.
- **Start in:** a new inspection Provider/Worker, not the Server process.
- **Research first:** Agent Skills validator, OpenClaw quarantine guidance, archive extraction
  libraries, and sandbox options.
- **Acceptance:** path traversal, symlinks, size expansion, unknown files, invalid metadata, and
  validator failure all fail closed; the Server receives only a bounded report.
- **Out of scope:** activation, host grants, autonomous skill execution, or network access.

## Completed baseline: signed Employee package design

- **Delivered:** ADR-0014 and ADR-0024 define the signature envelope, encrypted local keyring,
  explicit trust, rotation, revocation, and offline verification for `openbot.employee/v1`.
- **Start in:** `docs/decisions`, `apps/server-python/src/openbot_server/employee_portability.py`, `packages/domain`.
- **Research first:** Sigstore, in-toto, DSSE, TUF, and existing agent-package signing work.
- **Remaining contribution:** add native keyring/KMS adapters, publisher-key expiry, TUF continuity,
  and public identity/transparency without changing the DSSE package contract.
- **Still out of scope:** activation or ownership transfer.

## Delivered baseline: reviewed Employee activation

- **Delivered:** a quarantined preview becomes a new local Employee only through an exact digest,
  explicit Owner command, candidate-only skills, and immutable idempotent receipt.
- **Start in:** `apps/server-python`, `packages/db`, `apps/web`.
- **Research baseline:** Backstage preview/review/create, Kubernetes dry-run, and OpenClaw
  default-untrusted skills; see ADR-0025.
- **Remaining contribution:** package-family updates, registry distribution, selective-memory clone,
  richer receipt inspection, and authenticated ownership transfer.
- **Preserve:** fresh Employee id; imported skills disabled; no memory or Worker Host binding;
  idempotent exact replay; changed or duplicate activation fails closed.

## Delivered baseline: Owner-managed Employee memory

- **Delivered:** bounded Owner-only create/edit/delete, optimistic revisions, credential-value
  blocking, physical content deletion, content-free lifecycle audit, and an accessible profile
  editor. Every v1 Employee package still contains zero memories.
- **Start in:** `apps/server-python`, `apps/web`, `packages/protocol`, `packages/db`, and ADR-0026.
- **Research baseline:** Hermes, Letta, Mem0, and LangMem; see
  `docs/research/owner-managed-employee-memory.md`.
- **Remaining contribution:** retrieval, retention, autonomous proposal review, prompt-injection
  defenses, version restoration, redaction, and selective export.
- **Preserve:** the Server is authoritative; models and Worker Hosts cannot write Owner records;
  secrets are references only; audit never retains titles, content, or content hashes.

## Delivered baseline: Owner-managed profile details

- **Delivered:** authenticated role and biography editing, strict field bounds, PostgreSQL
  compare-and-swap revisions, content-free evolution/SSE metadata, multi-device stale-draft review,
  and biography preservation in safety-scanned Employee templates.
- **Start in:** `apps/server-python/src/openbot_server/profile_details.py`, `apps/web/src/components/EmployeeProfileView.tsx`,
  `packages/protocol`, `packages/db`, and the
  [research record](research/owner-employee-profile-details.md).
- **Research baseline:** Hermes profile editing/UI metadata CAS and Kubernetes `resourceVersion`.
- **Remaining contribution:** independently review and implement display-name, model/Provider,
  Worker Host, schedule, and composable-appearance editors.
- **Preserve:** prose cannot grant authority; stale writes return conflict; audit/realtime events
  never carry biography text; imported packages still create a fresh local identity.

## Advanced: proof-of-possession Node identity

- **Outcome:** replace the current individually revocable bearer credential with a rotatable,
  proof-of-possession Worker Host identity.
- **Start in:** `apps/server-python`, `apps/node`, `packages/protocol`, deployment docs.
- **Research first:** SPIFFE/SPIRE, mTLS bootstrap patterns, short-lived certificate rotation, and
  device enrollment threat models.
- **Acceptance:** preserve one-time enrollment and revocation; add non-exportable-key support,
  challenge/response, rotation, replay tests, Server audit, and no inbound public Node port.
- **Out of scope:** employee identity or OS account provisioning.

## Platform: native Windows, macOS, or Linux Provider

- **Outcome:** one narrowly scoped native Provider advances from Declared to Integrated with real
  target-platform evidence.
- **Start in:** `providers/<name>`, `packages/provider-sdk`, `docs/CROSS_PLATFORM.md`.
- **Research first:** use the Provider issue form and compare mature OS automation projects before
  writing an adapter.
- **Acceptance:** exact capability majors; hermetic negative cases; real-device report; local OS
  permission diagnostics; approval boundary; bounded artifacts; fail-closed cancellation.
- **Out of scope:** claiming other platforms, arbitrary administrator access, or bypassing Server
  routing and approval.
