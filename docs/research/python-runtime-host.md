# Research: Server gates for a Python-driven Agent loop

- Status: Accepted for implementation of the Server host unit; process integration pending
- Date: 2026-09-23
- Owner: OpenBot maintainers
- Acceptance journey: An external loop requests individual model steps and tool calls while the
  existing Server retains credentials, authority, budgets, durable usage/audit and final completion.
- Security boundary: The worker cannot supply a model, tool executor, grant, usage total or Run ID.

## Search evidence

Reused the completed native Agent entries in OPEN_SOURCE_REUSE.md and the
[runtime ports](runtime-execution-ports.md) / [executor seam](runtime-executor-seam.md) reviews.
Inspected the installed ai 7.0.93 APIs (`generateText`, `asSchema`, `modelMessageSchema`) and fetched
pinned [generateText source](https://github.com/vercel/ai/blob/6359fd58fe68eaade096b5d923bac26de84ca3bd/packages/ai/src/generate-text/generate-text.ts),
[tool execution](https://github.com/vercel/ai/blob/6359fd58fe68eaade096b5d923bac26de84ca3bd/packages/ai/src/generate-text/execute-tool-call.ts)
and [tests](https://github.com/vercel/ai/blob/6359fd58fe68eaade096b5d923bac26de84ca3bd/packages/ai/src/generate-text/generate-text.test.ts).
The source defaults to one step; the tests explicitly cover tools without `execute` and invalid
finish reasons. Use one step, zero retries, and schemas without local executors. Existing reviewed
issues 18518/15864 remain reasons not to depend on lifecycle callback exceptions for durable failure.
The public generateText documentation fetch failed; source and executable local tests are the evidence.

For the later process boundary, reviewed [JSON-RPC 2.0](https://www.jsonrpc.org/specification) and
reuse the existing MCP stdio framing review. These define an envelope/framing, not OpenBot Run
commit semantics, exactly-once effects or OS isolation. This host unit does not implement a codec.

## Candidate comparison

| Candidate | Exact version | License | Decision |
| --- | --- | --- | --- |
| Existing ai single-step generation and schema APIs | 7.0.93 / 6359fd58fe68eaade096b5d923bac26de84ca3bd | Apache-2.0 | Reuse model adapters without giving the SDK tool execution authority in this path |
| Existing Server tools, policy, usage and audit ports | OpenBot 481bb87 | MIT | Bind unchanged target/approval rules; validate every proposal and operation |
| Direct provider credentials in Python | Not selected | Not applicable | Would bypass Server-observable step budgets and revocation; reject |
| Handwritten provider HTTP or a second Server state store | Not selected | Not applicable | Existing released adapters and database contract already cover these responsibilities |

## Reuse decision

Implement a narrow Server host around the existing dependency. Python will own its SDK loop,
while each model request comes through this host with Server instructions and tool schemas. Bound
history, reject system-role/provider-option injection and refuse any new image/file reference not
already supplied by the Server, so SDK automatic media retrieval cannot become a worker bypass.

Each single model response persists Server-observed usage before release to the worker. Retain the
8-step/16-tool/4-web budgets across continuations and read current corrections on every model step.
Record model-issued tool intents, require matching identifiers/name/arguments, validate against the
Server schema again, and consume each intent once before effects. Correlation is not an exactly-once
external-effect guarantee; a failed/ambiguous call seals this invocation instead of being retried.

The host admits only one operation at a time and retains any failure. Pending tool intents block
another model call or completion. Final output must match the latest completed model answer; only
NativeAgentRunner later publishes artifacts and commits the Run. A process transport must still
add bounded framing, a minimal environment, cancellation/EOF cleanup and real Python integration.

## Source incorporation

No upstream source copied. Reuse public ai APIs and existing OpenBot policy. No dependency added;
existing Apache-2.0 and MIT notices remain applicable.

## Verification plan

Deterministic real-SDK tests cover a model/tool/observation/final journey, denied and altered tool
calls, duplicate/concurrent calls, step/tool/web budgets, audit/usage failure, dynamic corrections,
revocation during awaits, cancellation and media/provider-option injection. Native/headless tests
and npm run check remain required. This unit alone does not establish Python integration, OS
isolation, streaming parity or Linux application support.

## Recorded verification (2026-09-23)

- Server TypeScript check passed.
- `node scripts/test-runtime-headless.mjs`: 161 passed across six files, including the real
  Server/PostgreSQL report journey through this host and 32 host tests. No paid provider call.
- `npx --yes npm@10.9.9 run check`: passed after the final tool-failure audit change, including
  the host's 32 regression tests, repository checks, typecheck, tests and builds. Turbo reused
  unchanged workspace results. The disposable database fixture was cleaned up.
- Python process integration and streaming remain unverified by these checks.

## Streaming follow-up (2026-09-23)

Reuse the same pinned ai release's `streamText`, `fullStream` and final aggregate promises. Read
`packages/ai/src/generate-text/stream-text.ts` and its upstream tests through official GitHub
contents API after the raw URL fetch failed. Reviewed the error/onError tests (2400–4035), usage
promise tests (6915), tool-call promises (8434), and abort cases, alongside the existing OpenBot
public-stream regression. Omitting `streamRetries` disables stream recovery; keep zero request
retries and a non-retrying onError observer. Never release SDK reasoning or raw provider errors.

An external loop still gets one complete model response over RPC; the Server can independently
publish bounded public text as it arrives. The Server persists usage before releasing tool intents
or final response. A per-step AbortController closes the model stream on every exit, including
local size/format refusal. Stream previews remain provisional and do not commit Run completion.
No protocol change, dependency or upstream source copy. Required tests cover incremental output,
reasoning exclusion, stream error without retry, cancellation/late events and size limits, plus a
real Owner output API journey using the selected runtime.


Streaming verification: 37 host tests passed, including five streaming regressions. The headless
command passed 213 cases across eight files (15 real API/database journeys). `npm run check`
exited zero: Server 616 passed / 84 database-dependent skips; the separate headless run executed
its database cases. No Python integration claim: these journeys currently use the TypeScript
lane, and the Python selector requires a real CLI without fallback.

## Tool correlation scope follow-up (2026-09-23)

The real Python/Server/PostgreSQL delegation journey exposed a host-only incompatibility: the
existing deterministic provider reuses `delegate` for distinct model steps, while the host kept
an invocation-wide seen-ID set. The TypeScript loop permits the journey. The frozen profile
already defines tool IDs as correlation for current model-issued intents, not replay credentials.

Searches: `site.ai-sdk.dev toolCallId tool results` and
`site.github.com/vercel/ai tool call duplicate id steps`. Rechecked ai 7.0.93 at the exact commit
above, including installed `parse-tool-call.ts`, `to-response-messages.ts` and tool-call types.
The response converter's ID ordering map is local to one response. Official
[tool calling documentation](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling) pairs
calls with results; [JSON-RPC 2.0](https://www.jsonrpc.org/specification) defines request/response
correlation, not external-effect idempotency. The separate wire request IDs remain monotonic.
Reviewed [issue 7883](https://github.com/vercel/ai/issues/7883) (closed): provider response-item
identity can impose additional history constraints; it does not define OpenBot authorization.
No claim is made that every live provider accepts reused IDs.

Selected option: correct the thin adapter on the reviewed dependency. Check duplicate tool IDs
against the current pending-intent map. A new model step remains impossible until every previous
intent was consumed; repeated IDs within a response, changed names/arguments, repeated execution,
concurrent operations and failed operations remain refused. An independently generated later
intent is new work and must pass the same authority, schema and shared-budget checks. Do not
rewrite provider IDs, alter the collaboration fixture or retry ambiguous effects. No dependency
or copied source. Verification: same-ID consecutive steps, same-response duplicates, stale
arguments after a reused ID, existing replay tests, actual Python delegation and full checks.

Follow-up verification: 40 host regressions passed. The default headless lane passed 222 cases
across nine files; full `npm run check` exited zero (Server 625 passed / 84 default DB skips,
Web 329, Desktop 359 / 1 skip, Node 51 / 3 skips). The real Python delegation now reaches its
second response but the Python unit still rejects it with `duplicate_tool_call`; parity is pending
the matching Python guard correction. No completed Python delegation claim.
