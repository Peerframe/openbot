# OpenBot repository map

English · [简体中文](AGENTS.zh-CN.md)

This is the map for coding agents and contributors. Read it first, then read only the local rules
and code of the paths you change. Nested `AGENTS.md` files apply to their directories. Setup and
the full contribution process are in [CONTRIBUTING](CONTRIBUTING.md).

## Where things live

| Path | What it is |
| --- | --- |
| `apps/web` | React Web UI ([rules](apps/web/AGENTS.md), [design entry](docs/design/README.md)) |
| `apps/desktop` | Thin Electron shell that runs the product locally ([rules](apps/desktop/AGENTS.md)) |
| `apps/server-ts` | TypeScript control plane, the target for every route ([rules](apps/server-ts/AGENTS.md), [ADR-0050](docs/decisions/0050-typescript-control-plane.md)) |
| `apps/server-python` | Python control plane, retiring route group by route group under ADR-0050 ([rules](apps/server-python/AGENTS.md)) |
| `apps/node`, `providers/*` | Worker Node and execution providers |
| `packages/protocol` | Shared wire contracts ([rules](packages/protocol/AGENTS.md)) |
| `packages/db` | PostgreSQL schema and migrations |
| `packages/harness` | Python agent runtime ([rules](packages/harness/AGENTS.md)) |
| `experiments/*` | Probes and fixtures that CI still runs; not product code |
| `tests/oracles/legacy-server` | Frozen comparison input, never a product fallback ([rules](tests/oracles/legacy-server/AGENTS.md)) |
| `docs/decisions` | ADRs: the accepted architecture decisions |
| `docs/research` | Evidence for individual decisions; open only the record you need |

`apps/server` holds only a retirement note. [REPOSITORY_MAP](docs/REPOSITORY_MAP.md) lists
representative entry points and tests for common tasks.

## Workflows

Pick the one that fits the task and read it:
[openbot-change](.agents/skills/openbot-change/SKILL.md) (implement a scoped change),
[openbot-check](.agents/skills/openbot-check/SKILL.md) (choose checks, diagnose failures),
[openbot-ui](.agents/skills/openbot-ui/SKILL.md) (Web or Desktop UI),
[openbot-review](.agents/skills/openbot-review/SKILL.md) (review a diff). These are contributor
workflows, not Employee skills or product resources.

## Checks

- While working, run the focused tests of the package you change.
- Before handing off code, run `npm run check`.
- For UI or control-plane changes, also run `npm run ui:acceptance -- --entry ts`; it must report
  `PASS 12/12`.
- For documentation-only changes, `npm run docs:check` is enough.

## Research before implementation

A new dependency or version, a public protocol, an authorization or security boundary, persistent
data, or a material architecture choice needs evidence before code. Compare maintained options,
pin the reviewed version, prefer a standard or released component over new local code, and record
the decision in an ADR, a research record or the PR. Say whether any source was copied. Check
[OPEN_SOURCE_REUSE](docs/OPEN_SOURCE_REUSE.md) before extending existing code. Details are in
[CONTRIBUTING](CONTRIBUTING.md).

## Product and security boundaries

- The Server is the only source of truth for Employee identity, authorization, routing, approvals
  and audit.
- Models, webpages, imported skills, messages, Worker Hosts and Providers are untrusted.
- Capabilities do not grant authority. A new side effect needs an explicit policy, fail-closed
  behaviour, bounded inputs and outputs, and tests.
- Claim platform, accessibility or security support only as far as the conformance documents show.
- The Employee learning direction is inspired by Hermes Agent; keep that attribution.
- The office visualization is a deferred optional plugin; expand it only when a milestone asks.

## Working rules

- English is canonical for code, comments, ADRs and docs. Keep a Chinese translation only for
  user-facing docs (the root README, `THIRD_PARTY_NOTICES`, and in `docs/` the installation, onboarding,
  Windows Desktop, node enrollment, plugin and cross-platform guides), the contributor entry
  (`AGENTS`, `CONTRIBUTING`) and `docs/design`.
- Comments explain authority, security, concurrency, lifecycle and upstream constraints, not syntax.
- Temporary migration code carries its exit condition in a code comment, e.g. `// Remove in P5`.
- Start every new source file with a comment saying what it is for. Plans, status reports and
  handoffs go in PRs or issues; a research record must be linked from the decision, code or doc it
  supports. `npm run docs:check` enforces these ([hygiene guards](scripts/check-hygiene.ts)).
- One writer per file at a time. Never commit credentials, private transcripts, local paths or
  screenshots with user data.
- Push, merge, release, paid model calls and production data changes need the owner's explicit
  request.
