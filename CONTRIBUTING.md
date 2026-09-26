# Contributing to OpenBot

Thank you for helping build OpenBot. The project is in pre-alpha, so small changes with explicit
acceptance criteria are more valuable than broad rewrites. Before starting a large feature, open an
issue that identifies the milestone, user outcome, and security boundary it advances.

English is the canonical language for source code, comments, issues, pull requests, and project
documentation. Translations are welcome and should remain faithful to the English source.

[简体中文贡献指南](CONTRIBUTING.zh-CN.md)

## Contributor experience

OpenBot is built for multiple independent contributors, not a workflow that only the project
owner can operate. A new developer should be able to locate a module, start the relevant local
services, reproduce a problem, run focused checks and prepare a reviewable PR without private
knowledge or a maintainer's machine.

- Keep setup and validation commands runnable from a fresh checkout. Routine checks use synthetic
  data and deterministic model fixtures; optional live-service checks state their requirements.
- Put API guarantees, supported schema subsets and failure behavior next to the shared contracts
  and contributor docs. Prefer existing extension points over parallel implementations.
- Keep regression tests in the repository. If a test needs PostgreSQL or another fixture, document
  its command and include an isolated CI entry; a skipped test or a maintainer-only report is not
  continuing coverage.
- Keep work packages small, with an observable outcome and a reproducible validation path. Reuse
  the existing PR template and checks rather than adding an owner-only approval step.
- Distinguish implemented, verified, merged and released status. Link the PR and final checks at
  handoff so contributors can see where their change actually landed.

## Contribution priorities

OpenBot currently reviews contributions in this order:

1. reproducible bugs, data loss, and security hardening;
2. Windows, macOS, and Linux compatibility with real-device evidence;
3. reliability, recovery, observability, and fail-closed behavior;
4. small product journeys already present in the roadmap;
5. documentation, accessibility evidence, and faithful translations;
6. broad new subsystems only after issue-level design agreement.

Start with the [contributor work packages](docs/CONTRIBUTOR_TASKS.md) if you want a bounded task with
acceptance criteria.

Start with the [repository map](docs/REPOSITORY_MAP.md) for module ownership, contracts and focused checks.

## Find an area to contribute

| Interest | Main paths |
| --- | --- |
| Product and mobile UX | `apps/web`, `docs/INTERFACE.md` |
| Control plane and realtime | `apps/server-python`, `packages/db` |
| Python execution core | `packages/harness` (current harness source) |
| Node protocol and reliability | `apps/node`, `packages/protocol` |
| Computer integrations | `providers/*`, `packages/provider-sdk` |
| Policy and security | `packages/policy`, `docs/SECURITY.md` |
| Documentation and translations | `README*.md`, `docs/`, ADRs |
| Optional experiences | `packages/office-plugin` and future plugins |

Use an existing issue when possible. For new work, choose the bug or feature template so the
expected behavior, milestone, and permission boundary are recorded before implementation.

| Situation | Start here | Evidence expected |
| --- | --- | --- |
| Reproducible defect | Bug report | Actual/expected behavior, minimal reproduction, sanitized environment |
| Product or architecture change | Feature request | Acceptance journey, upstream review, permission boundary |
| New runtime or computer integration | Provider integration | Pinned upstream, exact capabilities, negative tests, target-platform evidence |
| Security vulnerability | Private Security Advisory | Impact and minimal safe reproduction; never use a public issue |
| Setup question without a defect | Existing docs and Discussions when enabled | Do not create a product bug without reproducible behavior |

## Local development

Requirements: Node.js 22.22.2 (the CI baseline), npm 10.9.9, Python 3.12+, and Docker with Docker Compose. Other Node.js releases must satisfy the exact engine range in `package.json`. Use `npm ci` to reproduce the committed lockfile.

```bash
git clone https://github.com/Peerframe/openbot.git
cd openbot
cp .env.example .env
```

Replace `OPENBOT_CONTROL_OWNER_PASSWORD` in `.env`, then run:

```bash
npm ci
apps/server-python/scripts/bootstrap-worker.sh
npm run db:up
npm run dev
```

Keep this terminal open. `scripts/dev-python.mjs` verifies the locked Worker environment, builds
the required shared packages through Turbo, then starts Python Server/Web.
Open `http://localhost:5173` and sign in with the Owner password from `.env`; Server uses port
`3001`. This is sufficient for frontend/control-plane development. Executing Work additionally needs explicit model settings and mTLS Temporal configuration;
API startup does not create an engine. Keep an existing checkout's `.env` and data directories.
To reproduce the clean-start CI journey with a disposable database, see
[the Server startup smoke instructions](apps/server-python/README.md).

For a small UI change, locate its component through the [repository map](docs/REPOSITORY_MAP.md),
edit it while this dev command runs, and inspect the real page. For example, the channel member menu
is `apps/web/src/components/ChannelMembersMenu.tsx`; run its focused test from another terminal:

```bash
npm exec --workspace @openbot/web -- vitest run src/components/ChannelMembersMenu.test.tsx
```

### Start an optional development Node

A fresh Node must enroll before connecting. Keep Server/Web running, then use another terminal at
the repository root:

```bash
npm run node:enrollment-token -- local-development-node
```

This authenticates as the configured Owner and prints a short-lived
`OPENBOT_NODE_ENROLLMENT_TOKEN=...` line. Add that line to the private `.env`, ensure
`OPENBOT_NODE_ID=local-development-node`, then start the Node with its shared builds:

```bash
npm run dev:node
```

After enrollment succeeds, remove only the one-time token line from `.env`. Keep the stored
identity: with the example configuration it is `apps/node/data/node/identity.json`, because the
Node dev command runs in `apps/node`. Use absolute paths if changing working directories. A
restart uses this credential without a new token. An expired/rejected token needs a new Owner-issued
token; never bypass enrollment with arbitrary bearer credentials. An unconfigured Node advertises
no execution capability; see [Provider conformance](docs/PROVIDER_CONFORMANCE.md) for adapters.
The root `npm run dev` starts Server/Web. A Node starts separately after enrollment; it is not
required for frontend or control-plane development.

For schema changes, start with the read-only
`npm run migration:plan --workspace @openbot/db -- --name describe_change` and the
[manual migration contract](docs/DATABASE.md#author-a-migration). Automatic `generate` is disabled.

Before opening a pull request:

```bash
npm run check
npm audit
```

Run `npm run db:stop` when the development database is no longer needed.

## Engineering principles

- Reuse existing decisions for ordinary fixes and wiring. New dependencies/versions, public
  protocols, authorization/security or persistent-data boundaries, and material architecture choices
  require targeted evidence before implementation. Apply [root triggers](AGENTS.md#research-before-implementation)
  and the [research guide](docs/research/README.md) only to the affected decision.
- Prefer, in order: an open standard, a released dependency, a thin pinned adapter, an upstream
  contribution, a narrow fork, and finally a documented local gap implementation.
- Preserve one Server-owned source of truth for tasks, approvals, and audit events.
- Prefer adapters over forks and upstream fixes over long-lived local patches.
- Treat models, webpages, skills, inbound messages, and execution environments as untrusted.
- Add no capability without a default-deny behavior, failure mode, and verification plan.
- Keep network waits outside database transactions.
- Make state transitions conditional and idempotent where concurrent workers can race.
- Never commit credentials, cookies, private transcripts, secret-bearing screenshots, or real user
  data.
- Keep product claims aligned with executable tests and the current implementation.

The root [repository instructions](AGENTS.md) apply equally to human and automated contributors.
When expanding old code, locate its entry in the
[retroactive reuse ledger](docs/OPEN_SOURCE_REUSE.md) first; an absent or partial entry must be
reviewed for the affected decision before expansion, not a repeated full-stack investigation.

### Required CI completion

The protected `check` status is the final CI gate. It waits for security scanning, repository
validation, every portable platform, the Windows Worker Host build, database journeys, and both
Server container architectures. A failed, cancelled, or skipped required job prevents success.
Wait for this gate on the latest PR commit before merging; local `npm run check` covers only the
repository checks and cannot substitute for hosted platform results.

### Dependency update intake

Ordinary Dependabot version proposals are paused for npm, GitHub Actions and Docker with
`open-pull-requests-limit: 0`. Security updates are exempt from that limit and remain eligible;
they still require research and the complete protected CI check. Repository security-update
controls are managed separately from this file.

For an ordinary update, select a bounded batch, review the exact upstream versions and existing
reuse records, write the research evidence, then update manifests and lockfiles together. Fill
the seven PR research fields before triggering CI, run a clean install and `npm run check`, and
wait for the latest hosted `check` before merging. A generated Dependabot release summary is a
proposal, not completed research. See the [intake decision](docs/research/dependency-update-intake.md).

Resume automatic ordinary proposals only when their research intake can be maintained. Editing
Dependabot configuration triggers an immediate scan; its PR limit counts concurrently open
proposals, not proposals per week. Preserve security updates and existing major-version limits.

### Research evidence and documentation exemptions

Choose one PR evidence path based on the actual change, not its title:

| Change | Evidence |
| --- | --- |
| Ordinary fix/wiring within a valid decision | Cite that decision, scope, unchanged assumptions and focused regression; no fresh candidate survey |
| New dependency/version, public protocol, authorization/security, persistent-data boundary or material architecture | Targeted review of the affected choice, pinned evidence and negative/compatibility tests |
| Pure spelling, faithful translation, mechanical prose formatting | Bounded prose exemption below; unchanged behavior and claims |

For eligible existing Web components, runtime `bounds.py`/`catalog.py`/`errors.py`, or tests, replace
the seven fields under `## Open-source research` with:

```markdown
- Research reuse: docs/research/channel-member-layout.md
- Reuse scope: Restore focus after the existing member menu closes.
- Unchanged assumptions: Same event contract; dependency, protocol, authority, persistence and architecture boundaries unchanged.
- Source copied or substantially adapted: no
```

Use the relevant existing decision, not this example by default. CI reads immutable committed
base/head blobs and rejects missing evidence, mixed forms, new product files, changed imports,
dependencies, boundary owners, instructions/prompts and unknown paths on this shortcut. This is a
conservative convenience, not a semantic proof or approval. Review must still trace actual consumers
and detect a permission or protocol change hidden inside an otherwise eligible file.

Other routine fixes, including changes to boundary-owner files, may use the existing seven fields
with the already-reviewed decision and pins; this does **not** require a new research cycle. Only
changed assumptions reopen the affected choice. New boundaries use those same fields with their
new targeted evidence. Source copying/adaptation keeps license/notice review. Research templates
start with a trigger/reuse assessment; do not fill a new report merely because behavior changed.

For unchanged ordinary prose, replace all seven fields with:

```markdown
- Research exemption: spelling
- Exemption reason: Correct the README introduction's spelling; instructions and product claims are unchanged.
```

Choose `spelling`, `translation`, or `mechanical-formatting`. CI verifies the committed diff. Only
root READMEs, ordinary `docs/` Markdown and workspace READMEs qualify; commands, code, links,
markup and metadata must remain unchanged. Policy, skills, prompts, ADR/research records, source,
configuration, dependencies and executable modes cannot use this exemption. Translation faithfulness
and unchanged claims remain review responsibilities. Do not mix evidence paths. PR-body edits alone
do not trigger CI; missing/shallow history fails closed.

### AI development entry and validation

Read [AGENTS](AGENTS.md) → one [repository map](docs/REPOSITORY_MAP.md) route → local AGENTS, contract,
consumer and test. `.agents/skills` provides `openbot-change`, `openbot-check`, `openbot-ui` and
`openbot-review`; select only the relevant workflow. These are repository-development instructions,
not Employee skills, and must not enter product payloads.

Codex discovers repository skills from the current directory up to the repo root. Its startup rules
follow root-to-current-directory AGENTS; when editing a deeper path, read that local file explicitly.
If a client does not refresh its catalog, reopen the session at this checkout and invoke
`$openbot-change`, or read the SKILL.md linked by root AGENTS. Record which mechanism actually worked.
No Claude integration is configured here; do not maintain a second copy of the rules. A future
compatibility entry must route to canonical AGENTS and be tested in the actual tool.

For workflow changes run `npm run docs:check`, `npm run research:check` and a real discovery/reading
exercise; Markdown is not proof of prose-only impact. Pure prose/instructions need their applicable
gates; script/implementation changes still require `npm run check` before handoff. Hosted required
checks and release/migration/security gates remain applicable. C3 will address CI selection; this
stage does not skip jobs. State actual test counts, cached results, skips and missing environments.

The upgrade continues in [one handoff](docs/REPOSITORY_UPGRADE_PLAN.md). UI work also follows
[the existing design index](docs/design/README.md), current tokens/components and affected rendered
states. New-session C1 acceptance locates UI, Python-core and cross-language tasks; C3 executes the
complete contribution journeys. Do not claim the latter from a successful lookup.

## Code and comments

- Prefer names, types, and small functions that make the normal path self-explanatory.
- Write comments in English and use them to explain **why**: security boundaries, concurrency
  invariants, protocol ordering, rollback behavior, or a non-obvious upstream constraint.
- Do not narrate syntax, restate the next line, preserve dead code, or leave unowned TODO comments.
- Public provider and protocol contracts should document guarantees that an external contributor
  cannot infer from the type alone.
- Update or remove a comment in the same pull request when its invariant changes.

## Documentation and translations

`README.md` is the canonical English README. Each maintained `README.<locale>.md` should preserve:

- the pre-alpha warning and security limitations;
- the distinction between available and planned capabilities;
- the quick-start commands and configuration names;
- the roadmap and contribution entry points.

Do not add large architecture screenshots or generated diagrams to a README. Prefer a compact text
flow, a table, and links to focused documents under `docs/`. A translation-only pull request is a
valid contribution; identify the language and reviewer strategy in its description.

## Security-sensitive changes

A change that touches permissions, computer control, credentials, networking, sandboxing, Node
identity, or approval behavior must include:

- a threat or failure scenario;
- a fail-closed test;
- an audit-event expectation;
- documentation of every new privilege;
- the pinned upstream version or contract it depends on.

Never weaken an approval or identity boundary only to make a demo pass. Report vulnerabilities
through the private process in [SECURITY.md](SECURITY.md), not a public issue.

## Pull requests

1. Fork the repository and create a focused branch such as `fix/dialog-focus` or
   `feat/windows-provider`.
2. Keep one pull request focused on one acceptance journey. Link an existing issue when available;
   a small reproducible bug fix or documentation correction can start directly as a PR. Use an issue
   to agree scope before a large feature.
3. Add tests at the lowest useful boundary and an integration test for cross-component behavior.
4. Run `npm run check`; record any real-device, browser, or assistive-technology evidence.
5. Update docs and existing translations when user-visible behavior or project claims change.
6. Complete every applicable section of the pull request template.
7. Preserve upstream copyright and license notices.
8. Link the upstream research note and state whether source was copied or substantially adapted.
9. Disclose AI or automation assistance and identify what a human verified; generated output is not
   acceptance evidence by itself.

All new source files are contributed under the repository's MIT license unless a directory contains
a more specific upstream notice.
