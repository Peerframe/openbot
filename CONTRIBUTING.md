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
| Control plane and realtime | `apps/server`, `packages/db` |
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

Requirements: Node.js 22.22.2 (the CI baseline), npm 10.9.9, and Docker with Docker Compose. Other Node.js releases must satisfy the exact engine range in `package.json`. Use `npm ci` to reproduce the committed lockfile.

```bash
git clone https://github.com/yxflc11/openbot.git
cd openbot
cp .env.example .env
```

Replace `OPENBOT_OWNER_PASSWORD` in `.env`, then run:

```bash
npm ci
npm run db:up
npm run dev
```

Keep this terminal open. Turbo builds the required shared packages before starting Server/Web.
Open `http://localhost:5173` and sign in with the Owner password from `.env`; Server uses port
`3001`. This is sufficient for frontend/control-plane development. The native Agent remains off
until explicitly enabled in model settings. Keep an existing checkout's `.env` and data directories.
To reproduce the clean-start CI journey with a disposable database, see
[the Server startup smoke instructions](apps/server/README.md).

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

- Research maintained GitHub repositories and open standards before designing any non-trivial
  feature. Create a durable issue, ADR, or [feature research record](docs/research/README.md) before
  implementation and record the queries, comparison, selected version, license, and decision.
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
reviewed before expansion.

### Research evidence and documentation exemptions

Behavior, dependency, protocol and non-trivial feature changes use the seven research fields in the
PR template. Link the durable record created before implementation; existing module research can
be reused when it covers the change.

For an ordinary Markdown spelling correction, faithful translation, or mechanical prose formatting
change that changes neither behavior nor claims, replace all seven fields under `## Open-source
research` with these two lines:

```markdown
- Research exemption: spelling
- Exemption reason: Correct the README introduction's spelling; instructions and product claims are unchanged.
```

Choose `spelling`, `translation`, or `mechanical-formatting`. CI checks the actual committed PR
diff, rather than a self-reported file list. The automatic path covers root READMEs, Markdown under
`docs/`, and workspace READMEs. It excludes policy documents, ADR/research records, source, configuration, dependencies,
executable modes and changes to code blocks, inline commands, link destinations, markup or metadata.
Unchanged commands and links can remain inside translated prose. Do not mix exemption fields with
partial research answers.

The check cannot prove that a translation is faithful or a prose claim is unchanged; that remains
part of the existing PR review. If a harmless change falls outside the automatic scope, use the
seven fields to reference existing module research and explain the unchanged behavior. Pure source
formatting still needs no new research under `AGENTS.md`. This limitation does not add an approval
step. An edited PR body alone does not automatically trigger CI; a new commit follows the usual
pull-request checks.

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
