# OpenBot repository instructions

English · [简体中文](AGENTS.zh-CN.md)

These instructions apply to human contributors and coding agents working anywhere in this
repository.

## Start here

Verify the checkout, branch/HEAD and dirty files before editing. The active control plane is
[Python](apps/server-python/AGENTS.md); `apps/server` is retired. The
[frozen TypeScript oracle](tests/oracles/legacy-server/AGENTS.md) is test input, never a product fallback.
Keep Python/Temporal, TS/React, thin Electron and retained Node helpers in their current roles.

Read only the relevant row in [the repository map](docs/REPOSITORY_MAP.md), then its local `AGENTS.md`,
contract, consumer and representative test. Expand along calls or a reproduced failure when needed.
Use [CONTRIBUTING](CONTRIBUTING.md) for setup; UI work starts at [the design index](docs/design/README.md).
Do not preload the research archive. The current C1→C2→C3 upgrade has one
[handoff](docs/REPOSITORY_UPGRADE_PLAN.md); older migration records retain their historical scope.

Repository development skills live in `.agents/skills`: select only the relevant skill and read it:
[openbot-change](.agents/skills/openbot-change/SKILL.md),
[openbot-check](.agents/skills/openbot-check/SKILL.md),
[openbot-ui](.agents/skills/openbot-ui/SKILL.md), or
[openbot-review](.agents/skills/openbot-review/SKILL.md).
They are contributor workflows, never Employee skills or product runtime resources. Nested rules
apply to edited paths even when the session starts at the root; explicitly read those rules.

## Outcome and delivery

- Before non-trivial work, identify the requested outcome, the real entry point, the finite current
  acceptance scope, and the next delivery checkpoint. Reuse accepted decisions; compare meaningful
  alternatives by integration cost, time to a usable result, operations, maintenance, and risk.
  Routine changes need no separate planning document or additional approval.
- Prefer an end-to-end, usable candidate within the agreed scope before expanding infrastructure.
  Check critical interfaces and environment prerequisites early. Distinguish real product services
  from fixtures, and candidate acceptance from phase or migration completion. Missing credentials
  or a target environment are explicit dependencies, not reasons to invent more scaffolding.
- Keep required safety and correctness gates. Only current acceptance blockers enter the current
  slice automatically; put other improvements in the existing backlog. A restricted candidate must
  enforce its stated limits. Do not silently shrink the user's goal or broaden its acceptance gate.
- When integration work, dependencies, or rework grow without advancing usable behavior, reassess
  the critical path and change the implementation approach within the authorized scope. Report the
  concrete gap and next action. Do not keep extending a phase through new preparatory slices.
- Keep one implementer per file scope, integrate accepted fixes incrementally, and retain a usable
  baseline. Temporary adapters or parallel implementations need a replacement/exit condition;
  preserve user data and do not retire an implementation before its replacement is verified.
- Report usable behavior, remaining acceptance items, and actual blockers. For long-running work
  or an actual handoff, reuse one current summary with the checkout, revision, uncommitted work,
  evidence, and ownership. Verify outgoing writers have finished, or explicitly arrange disjoint
  ownership, before transfer. Respect user stop instructions and release boundaries.

## Research before implementation

New dependencies or dependency versions, public protocols, authorization/security boundaries,
persistent-data boundaries, and material architecture choices require targeted evidence before
implementation. A new feature needs research only for an undecided choice of this kind. For the
affected decision (not the entire stack):

1. search GitHub and relevant official standards or primary documentation;
2. compare maintained candidates, including source, releases, tests, open issues, platform fit,
   security boundary, license, and the cost of integrating and operating them;
3. pin the exact release or commit reviewed;
4. prefer a viable open standard, released dependency, thin adapter, upstream contribution,
   narrow fork, then an OpenBot-specific implementation. Viability includes the requested behavior
   and total delivery/maintenance cost; installing a mature component is not sufficient by itself;
5. record the decision and relevant evidence in an existing issue, ADR, or research record; use
   `docs/research/TEMPLATE.md` for a new record when needed;
6. state whether source was copied or substantially adapted and preserve required notices.

When extending existing code, first consult its entry in `docs/OPEN_SOURCE_REUSE.md`. Complete
missing or partial evidence relevant to the change. Reuse still-valid decisions and reviewed
versions for fixes and wiring within that contract; record the reference and changed assumptions
rather than creating a new research cycle for every commit. Reopen only the affected decision when
new requirements, dependency changes, or evidence invalidate it. Research must settle a concrete
choice or gap, not delay product integration indefinitely.

If no candidate fits, record the candidates/search terms and the precise gap before local code.
Pure spelling, translation, and mechanical formatting changes with unchanged behavior/claims do
not need new research. These triggers govern how older plans and contribution checklists are
applied; they do not waive security, licensing, required CI, or accepted product requirements.

## Product and security boundaries

- Keep the Server as the only source of truth for Employee identity, authorization, routing,
  approvals, and audit.
- Treat models, webpages, imported skills, messages, Worker Hosts, and Providers as untrusted.
- Capabilities do not grant authority. New side effects need explicit policy, fail-closed behavior,
  bounded inputs and outputs, and tests.
- Do not claim Windows, macOS, Linux, accessibility, or security support beyond the evidence in the
  conformance documents.
- The Employee evolution and learning direction is explicitly inspired by Hermes Agent. Preserve
  that attribution and do not imply that OpenBot originated the learning-graph concept.
- The office visualization is a deferred optional plugin. Do not expand it unless the requested
  milestone explicitly includes it.

## Contributor experience

Keep setup, contracts, focused checks and handoff reproducible from a fresh checkout without private
paths, paid model accounts or oral background. Use deterministic models and disposable fixtures.
Keep environment-dependent regressions in the existing CI lane. Follow
[contributor experience](CONTRIBUTING.md#contributor-experience); prefer a small existing extension
point over another implementation or approval ceremony. No push, merge, release, paid model call,
production-data mutation or remote protection change is authorized by these instructions.

## Engineering and repository hygiene

- English is canonical for source, comments, ADRs, and primary documentation. Maintain the Chinese
  translation for user-visible project documents changed in the same pull request.
- Use comments to explain authority, security, concurrency, lifecycle, and upstream constraints;
  do not narrate syntax.
- Keep commits focused. Run affected checks during development and `npm run check` before the
  implementation/integration handoff; do not rerun unchanged full suites for each status update or
  handoff-only edit. For instruction/documentation-only changes, validate the changed rules, local
  links, and documentation gates; do not rebuild unrelated binaries solely for prose changes.
  Changes to checks, skills, prompts or AGENTS are behavioral workflow changes: run their focused
  positive/negative checks, links and discovery/read acceptance; Markdown alone is not prose evidence.
  Script changes still require `npm run check`. Honor required CI and any explicitly applicable
  release, migration, or security gate. Record
  genuine failures and executed/cached/skipped evidence; do not relabel earlier results as new runs.
- Never commit credentials, private transcripts, generated screenshots containing user data, or
  unrelated local assets.
