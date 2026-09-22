# Research: Server-bound runtime execution ports

- Status: Accepted for implementation
- Date: 2026-09-22
- Owner: OpenBot maintainers
- Related issue: Development track R2
- Acceptance journey: A contributor exercises the actual bounded SDK execution unit with only a
  deterministic model and explicit authority, tool, storage and audit ports; the production Server
  composes the same unit without giving it database credentials, scheduling or approval authority.
- Security boundary: Ports are trusted Server adapters, never model-supplied capabilities. The unit
  must fail closed when authority or durable records fail. Only the Server commits task results.

## Search evidence

- Search date: 2026-09-22. Queries: `repo:vercel/ai ToolLoopAgent prepareStep onStepEnd errors isolation`,
  `site:ai-sdk.dev/docs ToolLoopAgent tools testing abortSignal`.
- Reviewed [Agent interface](https://ai-sdk.dev/docs/reference/ai-sdk-core/agent),
  [ToolLoopAgent](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent),
  [tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling), and
  [ai 7.0.93 release](https://github.com/vercel/ai/releases/tag/ai%407.0.93).
- Reused the previously inspected exact source/tests at
  [`6359fd58fe68eaade096b5d923bac26de84ca3bd`](https://github.com/vercel/ai/tree/6359fd58fe68eaade096b5d923bac26de84ca3bd/packages/ai/src/agent)
  and the installed `ai/test` mock provider. The SDK owns iteration, tool parsing and callback
  dispatch; OpenBot must retain denial flags because lifecycle callback errors can be isolated.
- Reviewed upstream [18518](https://github.com/vercel/ai/issues/18518) on prepared-call typing and
  [15864](https://github.com/vercel/ai/issues/15864) on stream errors: preserve the existing pinned
  `prepareCall` onError override and per-call abort signal rather than assume new callback behavior.
- Existing completed reuse entries: Server-owned native Agent loop, native cancellation/usage,
  public-source reports. Existing evidence: `native-agent-loop.md`, `headless-runtime-acceptance.md`,
  `agent-execution-experience.md`. Baseline `2cc32d0`; R1 behavior and limits remain authoritative.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| SDK ToolLoopAgent, LanguageModel and ToolSet APIs | ai 7.0.93 / `6359fd58fe68eaade096b5d923bac26de84ca3bd` | Apache-2.0 | Released loop/mock tests and active issue tracker | Already owns model/tool iteration; accepts bound Server tools and explicit abort | Reuse |
| Existing OpenBot Server adapters | `2cc32d0` | MIT | R1 has 90 deterministic and real database checks | Identity, settings, grants, durable publication and audit already exist | Compose through narrow ports |
| OpenAI Agents JS | v0.17.0, existing reviewed comparison | MIT | Maintained runner/tools/handoffs tests | Would add another runtime/provider abstraction without filling this adapter gap | No new dependency |
| New independently published runtime package | Not selected | Not applicable | Would first require public versioning and its own compatibility policy | Current execution still uses OpenBot's bounded usage/error vocabulary and Node byte limits | Defer package publication; isolate the real unit inside Server first |

## Reuse decision

- Selected option: existing dependency and a thin adapter, not a new Agent loop implementation.
- Exact gap: `executeAgentRun` currently mixes Server-bound tool construction with SDK iteration,
  tool budgets, audit sequencing, usage persistence, correction reads and output consumption.
  Contributors must mock the whole Run store even when changing one execution policy.
- Introduce one module whose explicit ports are model, bound local tools plus per-tool policy,
  mandatory authority guard, storage for corrections/usage, durable progress audit, and optional
  public output events. It returns validated text and applied correction IDs; it cannot claim,
  cancel, complete, publish artifacts, grant tools or approve actions.
- Wrap every supplied local tool centrally, requiring a matching bounded policy. Keep the existing
  8 steps / 16 tools / 4 web calls / cumulative usage limits, before/after scope checks, audit-before-
  web-request ordering, non-retry behavior and output bounds. Server adapters retain target policy,
  plugin approvals, error classification and Run-scoped report/knowledge state.
- Upgrade/exit: run isolated unit checks and the R1 real Server journey after SDK/adapter changes.
  A later package extraction must preserve this contract and separately review public APIs.
- Failure behavior: missing policy, denied authority, failed audit/storage, malformed tool call,
  revoked scope, cancellation and excess limits cannot yield a successful runtime result. No
  permissive default guard, environment-enabled test model or fallback persistence is provided.
- The installed `ai@7.0.93` resolver uses the global provider for string model IDs (gateway by default);
  require a resolved Server model object. Its `ToolSet` also permits async generators; this adapter
  accepts only one completed JSON result and rejects iterators before reporting tool success.
  Checked its locked `@ai-sdk/provider-utils@5.0.36` `execute-tool` implementation (Apache-2.0):
  wrapping a generator in an async executor otherwise turns the iterator into a final value.
- Recheck authority after awaited audit/correction reads. A deterministic revocation during the
  storage read demonstrates why the prior check alone could allow a stale model request.

## Source incorporation

- Source copied or substantially adapted: no upstream source. Extract and adapt existing MIT
  OpenBot execution policy; retain the installed SDK's existing Apache-2.0 notices.

## Verification plan

- Isolated deterministic execution tests import the unit directly without Server app, PostgreSQL,
  model settings, plugin service, realtime hub or filesystem storage dependencies.
- Test real SDK tool observations, mandatory policy, authority before and after tools, durable audit
  failure before effects, usage storage failure, unknown calls, cancellation, streaming public text,
  correction reads and budgets retained across calls.
- Run native-loop tests and the real R1 headless/collaboration journey; Server typecheck and full
  `npm run check`; document module responsibilities and exact entry in English and Chinese.
- Evidence is local Node execution with deterministic models, not live provider quality or a
  separately supported/publicly released runtime package.

## Verification results

- Direct module entry: 22 deterministic tests passed after building only `@openbot/domain` and its
  protocol dependency. It imports no Server app, settings, plugin service or database store.
- `npm run test:runtime`: 112 tests passed using a newly created and automatically removed
  digest-pinned PostgreSQL 17.11 fixture: 22 isolated, 65 native adapter, 19 collaboration and six
  authenticated Server delivery journeys. No paid inference or personal configuration.
- `npm run typecheck --workspace=@openbot/server` and full `npm run check` passed on macOS.
  Platform-dependent and database opt-in tests retain their normal skips in the full check;
  the explicit headless command executes the relevant real database suites without skips.

## Unresolved questions

- Public package versioning, crash checkpoints and multi-Server scheduling remain separate work.
