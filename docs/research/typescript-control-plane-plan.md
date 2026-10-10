# Moving the control plane back to TypeScript: task and repository plan

- Status: Proposed (input for Codex's ADR; no product code changes until the Owner approves it)
- Date: 2026-10-05
- Owner: @yxflc11
- Related: the Owner's request of 2026-10-05; the architecture migration plan;
  [Temporal ADR 0046](../decisions/0046-temporal-as-recovery-owner.md)
- Acceptance journey: the Desktop app and the Web client run unchanged against a TypeScript
  control plane, with no bundled Python, and every public HTTP and event contract passes the same
  contract suite it passed against Python.
- Security boundary: unchanged. The Server stays the only source of truth for identity,
  authorization, routing, approvals and audit; a ported route must keep its exact checks.

## Why

The Owner's reasons, in priority order:

1. **One language.** Web, Desktop, Node helpers, providers and the database schema are already
   TypeScript; only the control plane is Python. One language means shared types instead of
   Python-to-TS generation, one toolchain, and front and back changes in one pull request.
2. **Simpler deployment.** The Desktop app ships Electron, a standalone CPython 3.12 with 63
   packages, a second Node 24 and PostgreSQL. Electron already contains Node, so a TypeScript
   control plane removes the Python runtime and the extra Node. This benefit arrives only when the
   last Python module is gone.
3. **Performance.** The control plane mostly waits on models, PostgreSQL and Temporal; the language
   will not make those faster. Gains are expected in start-up time and memory. Measure, do not
   assume.

## What exists today

`apps/server-python/src/openbot_server`: about 32,000 lines in 175 modules (about 80,000 lines with
its 141 test files). By area:

| Area | Lines | Modules |
| --- | ---: | ---: |
| Work execution and recovery (Temporal) | 14,300 | 73 |
| Bot profile, knowledge, import and export | 2,500 | 12 |
| HTTP, database and shared code | 2,300 | 14 |
| Model connections and calls | 2,200 | 9 |
| Tasks and runs | 1,900 | 15 |
| Identity and security | 1,600 | 12 |
| Runtime host | 1,500 | 6 |
| Plugins | 1,400 | 5 |
| Worker hosts | 1,200 | 5 |
| Attachments and storage | 1,100 | 6 |
| Employee browser | 700 | 4 |
| Conversations and messages | 500 | 7 |
| Routines, approvals, audit | 600 | 4 |

Already TypeScript and reusable as is: the PostgreSQL schema and migrations (`packages/db`,
Drizzle), the contracts (`packages/protocol`), domain types, the Web and Desktop clients, Node and
Worker hosts, providers, the document and OCR parsers (pdf.js, tesseract.js, officeparser). The
frozen TypeScript Server in `tests/oracles/legacy-server` stays test input only; it is not revived.

## Recommended approach: replace route group by route group

Rewriting everything at once would stop delivery for months and leave nothing to compare against.
Instead, a new TypeScript server takes over one group of routes at a time while Python keeps the
rest, both on the same database, and a shared contract suite decides when a group may switch.

- **Contracts first.** `packages/protocol` (zod) becomes the single definition of every public
  request, response, error and event. JSON Schema and the API reference are generated from it, and
  the contract suite checks Python against it before any port starts.
- **One front door.** The TypeScript server becomes the HTTP entry early and forwards every route it
  does not own yet to Python. Clients never change their address, and switching a group is one
  routing change that can be undone.
- **Shared data, no copies.** Both servers use the same PostgreSQL and the same `packages/db`
  migrations. Sessions, revisions and audit live in the database, so a request may be served by
  either side.
- **Temporal by task queue.** TypeScript workers take new workflow types on their own task queue;
  Python workers drain the workflows already running. A workflow type moves only when no history of
  it is left open on Python, or a replay test proves compatibility.
- **Delete before porting.** Retire what is no longer needed first (for example C28's older single
  model setting), so it is never ported.

## Phases and tasks

Each task is one pull request unless noted. "Gate" is what must be true before the next phase.

| Phase | Tasks | Who | Gate |
| --- | --- | --- | --- |
| **P0 · Decide** | ADR comparing staying on Python, a full rewrite, this route-by-route plan and a permanent split; dependency map with exact versions and licences (FastAPI → Fastify or Hono, psycopg → node-postgres with Drizzle, Pydantic AI and SDKs → the official Anthropic, OpenAI and other TypeScript SDKs, Temporal Python → Temporal TypeScript); start-up, memory and bundle-size baseline of today's Desktop | Codex | Owner approves the ADR |
| **P1 · Contracts** | Move every public DTO, error and event to zod in `packages/protocol`; generate JSON Schema and `docs/API.md` from it; new `packages/contract-tests`, a black-box suite that runs against any server URL; run it against Python until green | Codex; Claude moves the Web client to the new types | The suite passes on Python with no behaviour change |
| **P2 · Front door** | `apps/server-ts`: health, logging, configuration, Owner session check; forwards every other route (and the event stream) to Python; Desktop starts both; measure the forwarding overhead | Codex; Claude checks every screen still works | Full suite and Desktop journeys unchanged; overhead measured |
| **P3a · Small groups** | Routines, approvals settings, audit, Owner preferences, storage settings and reads | Codex | Group passes the suite on TypeScript; switched; Python code for it deleted |
| **P3b · Identity** | Login, sessions, password, Origin checks, Owner security | Codex, with a security review | Same as P3a, plus the negative auth tests |
| **P3c · Product** | Conversations and messages, channels, Bot profile, appearance and knowledge, plugins, attachments and storage, employee browser, worker hosts | Codex, several PRs | Same as P3a, per group |
| **P3d · Models** | Model connections, verification and calls on the official TypeScript SDKs (after C28 retires the older single setting) | Codex | Same, plus recorded model fixtures; no paid calls in CI |
| **P4 · Work and runtime** | Tasks and runs, Temporal workflows and activities on the TypeScript SDK, the runtime host and Worker protocol; drain Python workflows | Codex, the largest phase | Replay and recovery suites green on TypeScript; no open Python histories |
| **P5 · Retire Python** | Delete `apps/server-python`, `packages/python-node-runtime` and the Python lanes in CI; drop CPython and the second Node from Desktop packaging; rename `apps/server-ts` to `apps/server`; update all docs | Codex; Claude updates docs and design notes | Bundle size, start-up and memory compared with the P0 baseline |

New backend features keep landing during the move, in whichever server owns that route group at
the time; a feature in a group that is about to move should wait for the move or be written once,
in TypeScript.

## Repository layout

During the move:

```text
apps/
  server-ts/          new TypeScript control plane (front door, then each ported group)
  server-python/      shrinks group by group; deleted in P5
  server/             today only the retirement README; becomes the TS server in P5
  web/ desktop/ node/ worker-host-*/   unchanged
packages/
  protocol/           single contract definition (zod) → JSON Schema, API reference
  contract-tests/     new: black-box suite, runs against any server URL
  db/                 unchanged: shared schema and migrations
  work/               new in P4: Temporal workflows and activities (TypeScript)
  domain/ provider-sdk/ …    unchanged
tests/oracles/legacy-server/  unchanged, test input only
```

After P5: `apps/server` (TypeScript), no `apps/server-python`, no `packages/python-node-runtime`, no
Python requirement in setup or CI.

## Risks and how the plan handles them

- **Behaviour drift**: the contract suite and the route switch per group catch it, and a switch can
  be undone.
- **Security regressions**: identity is its own phase with a security review and the negative tests
  that already exist for Python.
- **In-flight work**: Temporal workflows move by task queue and only after their Python histories
  are closed or replay-tested.
- **Two servers at once (P2–P4)**: Desktop temporarily runs both; the bundle gets smaller only in
  P5, which is why P5 is a required phase, not optional cleanup.
- **Scope creep**: each group is ported as it is today; improvements come after its switch.

## Unresolved questions (for the ADR)

- Fastify or Hono for HTTP (both maintained; Fastify has the larger plugin ecosystem, Hono is
  smaller and runs anywhere).
- Whether Desktop could later embed PostgreSQL or Temporal more simply; out of scope here.
