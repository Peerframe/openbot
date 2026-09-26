# Research: Headless runtime acceptance and continuation integrity

- Status: Implemented; focused acceptance verified
- Date: 2026-09-22
- Owner: OpenBot maintainers
- Related issue: Independent contributor runtime workstream
- Acceptance journey: Run the real Server task API and native runner with a deterministic model,
  obtain a persisted report, observe a bounded failure, cancel an active task, and disconnect a
  realtime client without losing Server work; no Web, Electron, model key, or private configuration.
- Security boundary: PostgreSQL remains the sole task/identity/audit authority. Test services use
  disposable loopback storage. Continuation must retain previously consumed knowledge/skill
  revisions and staged outputs; optional learning saturation must not discard task delivery.

## Search evidence

- Search date: 2026-09-22.
- GitHub queries: `repo:vercel/ai MockLanguageModelV4 ToolLoopAgent test`,
  `repo:vercel/ai ToolLoopAgent cancellation`, and the existing pinned runtime sources.
- Reviewed [AI SDK testing](https://ai-sdk.dev/docs/ai-sdk-core/testing), the
  [ai 7.0.93 release](https://github.com/vercel/ai/releases/tag/ai%407.0.93), and pinned
  [mock model source](https://github.com/vercel/ai/blob/6359fd58fe68eaade096b5d923bac26de84ca3bd/packages/ai/src/test/mock-language-model-v4.ts)
  and [ToolLoopAgent tests](https://github.com/vercel/ai/blob/6359fd58fe68eaade096b5d923bac26de84ca3bd/packages/ai/src/agent/tool-loop-agent.test.ts).
  The released mock executes the real SDK while recording input and providing deterministic output.
  Upstream tests cover per-call abort propagation. Open issues
  [13075](https://github.com/vercel/ai/issues/13075) and
  [17606](https://github.com/vercel/ai/issues/17606) reinforce preserving explicit iteration limits;
  closed [18517](https://github.com/vercel/ai/issues/18517) concerns constructor timeout forwarding,
  so retain OpenBot's per-call composed signal and deadline.
- Reviewed [PostgreSQL 17 explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html):
  conditional terminal writes and the existing per-Bot row lock remain authoritative.
- Existing entries: `OPEN_SOURCE_REUSE.md` native Agent loop, cancellation/profile/usage,
  public reports; `native-agent-loop.md`, `agent-execution-experience.md`, `NATIVE_AGENT.md`;
  OpenBot baseline `ebce995`, `native-agent.test.ts`, `agent-collaboration.integration.test.ts`.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| Existing AI SDK mock provider and ToolLoopAgent | ai 7.0.93 / `6359fd58fe68eaade096b5d923bac26de84ca3bd` | Apache-2.0 | Released source and runner/mocking tests reviewed; active issue tracker | Same Node runtime and real scoped tools, no provider connection | Reuse installed dependency |
| Existing PostgreSQL transaction/store and Hono application | PostgreSQL 17; Hono 4.13.7; OpenBot `ebce995` | PostgreSQL License; MIT | Existing app, cancellation, collaboration and artifact tests | Exercises real Owner authentication, task submission, durable state and artifact download | Thin test composition |
| Separate workflow/agent service or in-memory production store | Not selected | Not applicable | Would require another execution and persistence contract | Would bypass the Server boundary under test | Reject; no new runtime framework |

The fixture also reuses the [official Docker run interface](https://docs.docker.com/engine/containers/run/)
and [Docker Official PostgreSQL packaging](https://github.com/docker-library/postgres) (MIT packaging;
PostgreSQL License for the database). The reviewed image is PostgreSQL 17.11 Bookworm,
`sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0`.
It has no host filesystem mount, publishes only a random loopback port, stores fixture data in
tmpfs and is removed using its unique invocation-owned name. This is test infrastructure only.

## Reuse decision

- Selected option: existing released dependency, PostgreSQL standard transactions, thin adapter.
- First viable option: compose the same SDK fixture, real Hono app, Postgres stores and artifact
  storage already used in repository tests. Build only Server dependencies for cold-checkout tests.
- OpenBot-specific gap: no single credential-free headless acceptance command; continuation
  recreates tool state while retaining only text and budget; the pending knowledge-proposal cap
  currently rejects the entire completion transaction. Reproduce before changing these paths.
- Keep staged reports, sources and consumed references in bounded Run-lifetime state across
  continuations. Revalidate consumed references at each boundary and final transaction. Render
  report provenance on copies so continuation cannot append the footer repeatedly.
- When the optional pending-proposal queue is full, retain its cap, write a bounded skip audit,
  and commit the task reply/artifacts. Invalid proposals, revoked references and database errors
  still fail closed; this is not a general error-swallowing fallback.
- Replacement plan: retain public Server API and existing store port; future SDK updates run the
  same acceptance and regression suite. No package split, durable checkpoint, or new authority.
- Failure behavior: fixture prerequisite errors fail explicitly; no fallthrough to real keys,
  remote services, user databases, or private settings.

## Source incorporation

- Source copied or substantially adapted: no. Existing public APIs and local test patterns only.
- Existing AI SDK, Hono, Node and PostgreSQL notices remain applicable; no dependency added.

## Verification plan

- Failing regressions first for report/reference retention after a continuation and optional
  proposal saturation; preserve one-proposal/two-report/eight-step limits across the whole Run.
- Headless real Server/SDK/database journey: authenticated submission, report download, tool
  failure, cancellation followed by a late result, and realtime disconnect while a task runs.
- Typecheck, native/collaboration regressions, and the repository `npm run check` at integration.
- English and Chinese runtime module instructions with exact commands and support limitations.
- Deterministic fixtures establish Server behavior, not paid provider quality, crash checkpoint
  recovery, native desktop interaction, or multi-Server deployment support.

## Unresolved questions

- None blocking this bounded acceptance slice. Cross-process task resumption remains deferred.

## Verification results (2026-09-22)

- Before runtime fixes, the real database acceptance had four passing scenarios and two failures:
  continuation delivered zero reports; a full pending lesson queue changed valid delivery to failed.
- Separate deterministic regressions failed because consumed memory/skill revisions disappeared
  after a correction; both pass after Run-scoped state retention.
- The self-contained command passed 90 tests: 65 native-loop tests, 19 existing PostgreSQL
  collaboration tests, six new real Server/database headless scenarios. Its own container was
  removed after completion; no paid model call or private configuration was used.
- Server TypeScript check, documentation link check and full `npm run check` passed. The initial
  sandboxed full check failed existing socket-listener tests with EPERM; rerunning with local socket
  permission passed. The final focused acceptance command still passed all 90 tests after the
  settings/realtime port types were narrowed. An unsafe database URL was rejected before any
  fixture, build or test operation.
- Local evidence is macOS host + Linux PostgreSQL container. Windows execution of this driver and
  hosted CI remain unverified until their own jobs run.

## PR96 database regression alignment — 2026-09-25

The automation PostgreSQL test still expected full optional-lesson queues to discard completion,
contradicting the reviewed contract above and implementation commit
`e0dc4e4d5a53fd994c429671296214988e491312`. Correct only that stale assertion: the51st Run
completes with one reply, exactly50 pending proposals remain, no overflow proposal exists, and
one content-free `KNOWLEDGE_PROPOSAL_SKIPPED` event records `pending_limit`. Count SQL rows directly
because the public list itself caps at50. No production, schema, authority or oracle code changes.
All26 cases in the affected integration file passed against a new disposable PostgreSQL fixture
on canonical43; its owned resources were removed. Hosted CI must still validate the new commit.
