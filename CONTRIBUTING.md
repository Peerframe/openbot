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

Start with the [repository map](docs/REPOSITORY_MAP.md) for module ownership, contracts and focused checks.

## Find an area to contribute

| Interest | Main paths |
| --- | --- |
| Product and mobile UX | `apps/web`, `docs/INTERFACE.md` |
| Control plane and realtime | `apps/server-python`, `packages/db` |
| Python execution core | `packages/harness` (current harness source) |
| Node protocol and reliability | `apps/node`, `packages/protocol` |
| Computer integrations | `providers/*`, `packages/provider-sdk` |
| Policy and security | `apps/server-python/src/openbot_server`, `docs/SECURITY.md` |
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

Keep this terminal open. `scripts/dev-python.ts` verifies the locked Worker environment, builds
the required shared packages through Turbo, then starts Python Server/Web.
Open `http://localhost:5173` and sign in with the Owner password from `.env`; Server uses port
`3001`. This is sufficient for frontend/control-plane development. Executing Work additionally needs explicit model settings and mTLS Temporal configuration;
API startup does not create an engine. Keep an existing checkout's `.env` and data directories.
To reproduce the clean-start CI journey with a disposable database, see
[the Server startup smoke instructions](apps/server-python/README.md).

For a small UI change, locate its component through the [repository map](docs/REPOSITORY_MAP.md),
edit it while this dev command runs, and inspect the real page. For example, the channel side panel
is `apps/web/src/components/ContextRail.tsx`; run its focused test from another terminal:

```bash
npm exec --workspace @openbot/web -- vitest run src/components/ContextRail.test.tsx
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

Before opening a pull request, follow the [applicable validation rules](#ai-development-entry-and-validation).
Implementation and script changes require `npm run check`; prose and contributor instructions use
their applicable documentation and workflow checks. Run `npm audit` and satisfy the required
security and hosted CI gates; focused validation does not exempt them.

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

The protected `check` status is the final CI gate. It compares the selector's explicit required
and not-applicable sets with actual job results. Security and validation always run. Required jobs
must succeed; failure, cancellation, missing results or unexpected skips fail. Main pushes retain
full qualification. Wait for the latest candidate's hosted gate before merging; local success
cannot substitute for native platform, recovery or packaging results.

During development, inspect selection with `npm run ci:scope -- --local`, then run
`npm run check:affected -- --local`. Local tracked and untracked changes are reported separately.
For a PR, use verified immutable 40-character commit IDs:

```sh
npm run ci:scope -- --base "$BASE_SHA" --head "$HEAD_SHA"
npm run check:affected -- --base "$BASE_SHA" --head "$HEAD_SHA"
```

The committed range uses the actual merge base; it excludes uncommitted files. A missing/shallow
base fails instead of guessing `origin/main`. `check:affected` runs **the validation lane only**
and lists separate required qualifications. It does not mean all CI passed. `npm run check`
retains full repository validation before implementation/script handoff. Prose uses the focused
repository gates; AGENTS, skills and prompts also need behavioral discovery/reading acceptance.
Contract, lock, generator, build, CI and unmapped inputs conservatively select the full set.

Selection follows the npm lockfile's transitive consumer graph plus explicit Python, dynamic
Desktop and packaging edges. `npm run ci:check` exercises scope/result counterexamples and real
cache/zero-test behavior. No-test packages expose no fake passing test task; their actual consumer
coverage and missing local tests remain explicit.

Use npm entrypoints (`npm run` / `npm exec -- turbo`) so the Turbo cache hashes the actual npm,
Node, OS and architecture identity in `npm_config_user_agent`. Source, lockfile graph, generators,
config and declared runtime environment also enter task hashes. Direct standalone Turbo invocations
without that identity are not qualification evidence. CI restores npm downloads only, not earlier
successful Turbo test results. Local cached successes must be labeled; root gates and real Python,
Temporal and installed-artifact probes run outside this cache. Parallel jobs own separate checkouts;
builds within a job precede packaging, which consumes their outputs without rebuilding them.
Obsolete PR jobs cancel; main and tag-only release qualification retain their own lifecycles.

Security audits include `npm audit --omit=dev --audit-level=high` and `sh scripts/audit-python.sh`.
The latter uses an isolated pinned audit tool against the exact production Python closure and
rejects skipped/incomplete reports or known advisories. Network failure is a failed gate, not a
clean audit. Normal PR checks do not establish an unsigned artifact, signing/notarization or a
release: changed payloads still need actual packaged startup/refusal/cleanup on supported targets.

### Dependency update intake

Ordinary Dependabot version proposals are paused for npm, GitHub Actions and Docker with
`open-pull-requests-limit: 0`. Security updates are exempt from that limit and remain eligible;
they still require research and the complete protected CI check. Repository security-update
controls are managed separately from this file.

For an ordinary update, select a bounded batch, review the exact upstream versions and existing
reuse records, write the research evidence, then update manifests and lockfiles together. Fill
the PR research section before triggering CI, run a clean install and `npm run check`, and
wait for the latest hosted `check` before merging. A generated Dependabot release summary is a
proposal, not completed research. See the [intake decision](docs/research/dependency-update-intake.md).

Resume automatic ordinary proposals only when their research intake can be maintained. Editing
Dependabot configuration triggers an immediate scan; its PR limit counts concurrently open
proposals, not proposals per week. Preserve security updates and existing major-version limits.

### Research evidence and documentation exemptions

CI requires `## Open-source research` in the PR body only when a PR changes dependencies
(`package.json` dependency fields, lock files, Python requirements or `pyproject.toml`), container
base images, or a protocol, security or persistence contract (`packages/protocol/`, migrations,
schemas, entitlements). It then needs a link to a research record, ADR or prior PR and a
`Source copied or substantially adapted: yes|no` line; all other PRs are exempt automatically.

When a durable decision needs an ADR, adapt the [outline](docs/decisions/TEMPLATE.md) to the decision.
Review reasons, consequences and necessary sources; neither its number nor directory requires a
fixed set of headings. Existing ADRs need no formatting migration.

### AI development entry and validation

The [development entry](.agents/README.md) links the existing workflows and owners.
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
checks and release/migration/security gates remain applicable. Only the tested CI selector may
declare a lane not applicable. State actual test counts, cached results, skips and missing environments.

Start from the current request and checkout; preserve local completion records. UI work follows [the existing design index](docs/design/README.md), current
tokens/components and affected rendered states. A discovery/reading exercise locates owners and
checks; it does not establish a completed implementation, rendered acceptance or hosted CI.

Whole-interface acceptance is one command: `npm run ui:acceptance` (add `-- --entry ts` once the TS
entry is built). It starts a disposable PostgreSQL, the Python product serving the built Web and,
with `--entry ts`, the TS entry in front of it. It then drives the real interface in your installed
Chrome (`-- --browser <path>` for another one) and prints a pass or fail receipt with screenshots.
Prepare Python (`apps/server-python/scripts/bootstrap-worker.sh`) and build the Web first; Docker
must be running. Known gaps are allowlisted by exact route in `scripts/ui-acceptance-report.ts`;
see the [research record](docs/research/ui-acceptance-automation.md). Before every TypeScript
migration HTTP group switch, run `npm run ui:acceptance -- --entry ts` on the current candidate
and require `PASS 12/12`. Retain the receipt and screenshots from its output directory. An
unexpected workspace 503 fails the gate; use its recorded step and paired service logs to
investigate the forwarding path.

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
4. Run the [applicable checks](#ai-development-entry-and-validation), including `npm run check` for
   implementation/script changes; record any real-device, browser, or assistive-technology evidence.
5. Update docs and existing translations when user-visible behavior or project claims change.
6. Complete every applicable section of the pull request template.
7. Preserve upstream copyright and license notices.
8. Link the upstream research note and state whether source was copied or substantially adapted.
9. Disclose AI or automation assistance and identify what a human verified; generated output is not
   acceptance evidence by itself.

All new source files are contributed under the repository's MIT license unless a directory contains
a more specific upstream notice.
