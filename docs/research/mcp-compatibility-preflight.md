# Research: MCP compatibility preflight and independent author checks

- Status: Accepted
- Date: 2026-09-22
- Owner: OpenBot maintainers
- Related issue: contributor-growth track P
- Acceptance journey: an author generates a standalone plugin, runs local success and failure scenarios without OpenBot or a model account, and receives the same tool-profile rejection reason as the Server preview before installation.
- Security boundary: declarations and HTTP responses are untrusted. Preview only initializes and discovers; it never invokes tools or grants authority. The Server retains endpoint/DNS pinning, installation, grants, approvals and audit.

## Search evidence

- Search date: 2026-09-22.
- GitHub queries: `site:github.com/modelcontextprotocol/typescript-sdk 1.30.0 StreamableHTTPClientTransport error 401 protocolVersion`; inspected [pinned client source](https://github.com/modelcontextprotocol/typescript-sdk/blob/2d889f2b329e46680ec9bdd565de4616c497825a/src/client/index.ts), [transport source](https://github.com/modelcontextprotocol/typescript-sdk/blob/2d889f2b329e46680ec9bdd565de4616c497825a/src/client/streamableHttp.ts), [releases](https://github.com/modelcontextprotocol/typescript-sdk/releases), and [issue 2730](https://github.com/modelcontextprotocol/typescript-sdk/issues/2730) on notification acknowledgements.
- Standards queries: MCP 2025-11-25 [lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), [transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), and [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools). Version negotiation and required task execution are protocol facts; the narrower draft-07, text-result and no-task profile is OpenBot policy, not full MCP conformance.
- Existing entries: `docs/OPEN_SOURCE_REUSE.md` third-party MCP tools and MCP lifecycle contracts; `third-party-mcp-plugins.md`, `plugin-flow-refactor.md`, `plugin-platform-completion.md`; existing transport, schema and service tests.
- Source review confirmed SDK `listTools` compiles output schemas and records `execution.taskSupport`; ordinary `callTool` then refuses required-task tools. OpenBot currently drops that field in its catalog, allowing installation of tools it cannot invoke. Input/output schema restrictions already exist and must be reused, not reimplemented as a competing schema engine.
- Installed 1.30.0 package source and MIT license were inspected. Its [client tests](https://github.com/modelcontextprotocol/typescript-sdk/blob/2d889f2b329e46680ec9bdd565de4616c497825a/test/client/index.test.ts) cover supported/unsupported protocol negotiation and structured output validation; existing OpenBot real HTTP lifecycle tests cover protocol/session behavior. The current split SDK 2 release is not needed for this bounded profile and would require a separate migration.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| MCP lifecycle/tools/HTTP standard | 2025-11-25 | Specification terms | Published version with lifecycle and tool execution requirements | Defines negotiation, declarations and auth failure semantics; does not define OpenBot grants or limits | Reuse standard wire contract |
| Official TypeScript SDK | 1.30.0 / `2d889f2b329e46680ec9bdd565de4616c497825a` | MIT | Released source, client/transport tests and current open issue reviewed | Already pinned; owns protocol parsing, output schema validation and transport | Reuse existing dependency and thin policy adapter |
| MCP conformance | `74edef34d674f563537be8c6587cebaa58e830ca` | Apache-2.0/MIT transition; docs CC-BY-4.0 | Executable named scenarios and negative tests; prior repository review retained | Tests broad standard compliance, not this deliberately smaller profile or Owner authority | Reuse named scenario approach; no runner dependency |
| New custom MCP client/schema implementation | None | N/A | Would duplicate reviewed parser/lifecycle code | Unnecessary protocol and security surface | Rejected |

## Reuse decision

- Selected option: standard plus existing dependency and thin adapter.
- Selected upstream: MCP 2025-11-25 and SDK 1.30.0, unchanged pins.
- First viable option: SDK already negotiates and validates; expose bounded diagnostic reasons and share existing schema/tool-profile checks between Server and copied author starter.
- Exact local gap: reject required-task declarations during preview; preserve safe machine-readable reasons for auth, transport, protocol, timeout, schema, catalog and result incompatibility; provide an independently executable author preflight and synthetic negative fixtures.
- Replacement plan: shared policy helpers have no OpenBot workspace imports. Any future SDK/dialect/OAuth/task migration must update these checks and fixtures together. Generated copies reflect their generation version; regenerate into a new directory to adopt changes.
- Failure behavior: no rejected declaration reaches installation or authorization. Diagnostics use fixed local messages and reason identifiers, never remote bodies, tokens or challenge URLs. Preflight performs no tool calls; result checks are exercised only against explicitly invoked local test fixtures. It cannot establish that a remote tool is safe or that all future results will conform.
- Standalone author networking is restricted to literal loopback HTTP(S), exact endpoint, no redirects and bounded response/time. It is a developer check, not a replacement for Server public HTTPS/DNS policy, resource/prompt grants or application installation.

## Source incorporation

- Source copied or substantially adapted: no upstream source copied. Existing MIT OpenBot validation/example code is extracted and copied into the generated standalone project with the repository LICENSE.
- Files/upstream locations: existing `plugin-types.ts`, `plugin-transport.ts`, `plugin-example.ts`; SDK imported through its public APIs.
- Notices: generated project LICENSE and installed dependency licenses remain intact.

## Verification plan

- Automated tests: existing schema/transport/service tests; real HTTP fixtures for valid tools, input/output schema rejection, required tasks, auth/forbidden responses, unsupported protocol/transport, timeout and text-result bounds.
- Negative/fail-closed: rejected preview and install leave store empty, no grants or tool calls; errors contain stable reasons without remote content; cancelled/session cleanup remains bounded and not replayed.
- Independent author check: generate outside workspace, install pinned dependencies independently, run `npm test`, start example and run read-only `npm run preflight -- <endpoint>`.
- Platforms: local Node on macOS plus portable repository test suite; no new Windows/native/security certification claim.
- Documentation: English/Chinese plugin guide and generated bilingual README, including scope and unchecked execution outcomes.

## Unresolved questions

- OAuth, full MCP conformance, task execution, broader schema dialects and hosted connector onboarding remain separate milestones.

## Verification results

- 2026-09-22: focused production policy/transport/service/content/preflight suite: 77 tests passed across 5 files. New real HTTP cases verify no installation, grants or `tools/call` after incompatible input/output schemas, required tasks, auth/forbidden, transport/version or pagination failures. A previously granted tool changed to required-task execution is blocked before dispatch and update application.
- Full `npm run check` passed in the isolated worktree: documentation/research checks, release/configuration checks, lint, typechecks, repository tests and all builds. Server reports 512 passed and 69 pre-existing environment/platform-dependent skips; this is not a real external-service or native-platform conformance claim.
- Generated `/private/tmp/openbot-mcp-independent-check` outside every workspace, installed its own 98 dependency packages with `npm install --ignore-scripts`, then `npm test`: 13/13 passed after synchronizing the final HTTP 205 guard and scenario from the generator source. No workspace symlink, OpenBot service, database, paid model or external service credentials were used.
- Actual generated `npm start` plus `npm run preflight -- http://127.0.0.1:4318/mcp` returned `ok: true`, protocol `2025-11-25`, tools `sum_numbers`/`append_note`, `toolCalls: 0`, and explicit unchecked result/effect, resource/prompt and installation/grant areas. The actual CLI authentication-failure path also returned exit code 1 with `authentication_required`, without remote body/challenge text. Temporary example processes were closed after verification.

### Owner-facing diagnostic presentation

The existing Web plugin adapter discarded response JSON and reduced all failures to HTTP status.
Accept only the new fixed `compatibility` allowlist and map it to local Chinese guidance; never
display the response's `error`, token, challenge URL or unknown fields. Unknown/prototype-key and
malformed bodies retain existing status fallbacks. Sixteen focused Web adapter tests and its
TypeScript check passed. No new component, permission or network endpoint is introduced.

Final transport review also identified that HTTP 205 must be rejected before constructing a
non-null Fetch Response body. Both author and Server tests now exercise that peer response and
require `transport_unsupported` without installation or dispatch; no response body is reflected.
