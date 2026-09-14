# Research: MCP lifecycle and shared plugin contracts

- Status: Accepted for implementation
- Date: 2026-09-14
- Owner: OpenBot contributors
- Related issue: Independent repository review PP-1, PP-2, PP-3, PP-5
- Acceptance journey: A stateful local MCP server accepts a tool with an ordinary `format` argument, executes it once through the existing grants, and releases its session when OpenBot closes; malformed Provider declarations fail before connecting.
- Security boundary: Server retains discovery policy, endpoint/DNS/TLS bounds, credentials, grants, approvals and audit. Shared schemas describe data only. Cleanup has no tool execution/retry authority.

## Search evidence

- Search date: 2026-09-14.
- GitHub queries: `repo:modelcontextprotocol/typescript-sdk terminateSession close session`, `repo:json-schema-org/json-schema-spec properties enum const`, `repo:colinhacks/zod safeParse 4.5.4`.
- Inspected pinned SDK [client source](https://github.com/modelcontextprotocol/typescript-sdk/blob/2d889f2b329e46680ec9bdd565de4616c497825a/src/client/streamableHttp.ts), [AJV adapter](https://github.com/modelcontextprotocol/typescript-sdk/blob/2d889f2b329e46680ec9bdd565de4616c497825a/src/validation/ajv-provider.ts), [transport tests](https://github.com/modelcontextprotocol/typescript-sdk/blob/2d889f2b329e46680ec9bdd565de4616c497825a/test/client/streamableHttp.test.ts), [release 1.30.0](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.30.0), MIT LICENSE, and [session expiry issue 1708](https://github.com/modelcontextprotocol/typescript-sdk/issues/1708). GitHub web could not render the test file; GitHub contents API returned its DELETE/session-clear/405 tests. SDK `close()` is local abort; `terminateSession()` handles DELETE and permits 405.
- Primary standards: [MCP 2025-11-25 session management](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management), [JSON Schema draft 2020-12 core](https://json-schema.org/draft/2020-12/json-schema-core), [object properties](https://json-schema.org/understanding-json-schema/reference/object#properties). A properties-map key names instance data; enum/const contents are data. Termination DELETE is a SHOULD, not a MUST.
- Existing ledger: `OPEN_SOURCE_REUSE.md` Third-party MCP tool plugins, Node protocol input validation, Provider SDK/current Docker adapter; `third-party-mcp-plugins.md`, `plugin-platform-completion.md`, Provider declaration tests and shared wire schemas.
- Zod [4.5.4 release](https://github.com/colinhacks/zod/releases/tag/v4.5.4), commit `e8e206fa33ac5fe7ce20a2beb12d57b1cb3df653`, and [recursive external-schema issue 6549](https://github.com/colinhacks/zod/issues/6549) were checked. This change reuses flat existing protocol schemas; it does not add recursive Zod schemas or dependency upgrades.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| MCP standard + official SDK | 2025-11-25; SDK 1.30.0 / `2d889f2b329e46680ec9bdd565de4616c497825a` | MIT | July 27 release includes end-to-end and transport lifecycle fixes; upstream session termination tests cover DELETE and 405 | Existing Node dependency; official termination method preserves protocol ownership | Select SDK method plus existing bounded fetch adapter |
| Existing Zod and protocol schemas | 4.5.4 / `e8e206fa33ac5fe7ce20a2beb12d57b1cb3df653` | MIT | Release and external recursive-schema issue reviewed; repository tests exercise strict wire constraints | Already shared between Node and Server, browser-safe data schemas | Select shared DTO/schema definitions and reuse wire validation |
| SDK AJV validator alone | SDK 1.30.0 above; locked AJV 8.20.0 | MIT | Existing upstream validation adapter uses strict:false, validateSchema:false and formats | Validates arguments but does not enforce OpenBot's no-reference/no-regex policy or total depth/node budget | Retain validation; supplement only the policy traversal |
| New protocol codec or general schema engine | Local implementation | N/A | No matching implementation needed | Would duplicate existing SDK/AJV behavior and expand scope | Reject |

## Reuse decision

- Selected option: open standards, existing released dependencies, narrow adapters.
- Session cleanup uses SDK `terminateSession()`, a separate at-most-five-second cleanup deadline, exact endpoint/session identity, and the same DNS pinning/TLS/no-redirect policy. Cancel the operation promptly; permit only the session DELETE to continue after parent cancellation. Missing/expired sessions and unsupported termination do not retry any business call.
- Shared `packages/protocol/src/plugins.ts` contains DTOs and data schemas; Server alone retains digest generation, discovery Schema policy, encrypted state and permission decisions. Public types have one definition, with compatibility re-exports from prior entry points.
- Exact local gap: existing policy walk must distinguish subschema positions from property-name maps and enum/const/annotation data, while bounding all JSON nodes and depth, including non-schema data. AJV continues to compile and validate; this is not a second JSON Schema validator.
- Provider declarations reuse the existing wire schemas before ownership/duplicate checks. Invalid versions, names, constraints and enums fail locally.
- Upgrade/exit: keep SDK1 and protocol scope unchanged; a future dialect/SDK upgrade must update the schema-policy keyword positions and rerun interoperability/security fixtures. OAuth, stdio, renderer capabilities and signed leases remain outside scope.
- Failure behavior: fail closed on transport/schema mismatch; best-effort bounded cleanup cannot convert a failed tool operation into a retry or hide its uncertainty.

## Source incorporation

No upstream implementation or documentation is copied or substantially adapted. Use existing SDK/Zod/AJV dependencies through their APIs; existing `THIRD_PARTY_NOTICES.md` records their MIT notices. Shared DTOs are moved from OpenBot source, and the policy traversal implements OpenBot-specific restrictions from the referenced standard's schema positions.

## Verification plan

- Real SDK local stateful HTTP fixture: successful discovery and call, repeated sessions released, normal close idempotent, 405 accepted, cancelled call and failed initialization release a known session without tool replay, hanging cleanup bounded.
- Schema policy: property names format/pattern/$id and enum/const data accepted; actual forbidden keywords rejected in nested applicators; bytes/depth/node limits remain enforced over all data.
- Provider declaration: wire-invalid version/constraints/name/platform inputs rejected before startup; built-in declarations still pass.
- Shared contract: protocol tests and Server/Web TypeScript checks; existing service/grant/revocation/content tests continue to pass.
- Platforms: hermetic local Node/HTTP only; no paid model, real user data or native Provider support claim. Maintainer performs complete repository check.
- Bilingual evidence here; maintainer updates public author guide and reuse index in the coordinated change.

## Unresolved questions

A remote server may reject cleanup or become unreachable. OpenBot cannot guarantee remote resource deletion in that case; it must stop locally within the cleanup bound and never replay business operations.

## Verification results (2026-09-14)

- Four new targeted test files passed 25 tests, including the actual SDK stateful HTTP fixture: three independent sessions released, keyword-like arguments discovered and called, one effect on cancellation, known-session cleanup after failed initialization, 405, redirect denial, and bounded hanging cleanup.
- Eight existing plugin/Provider/UI suites passed 58 tests. After retaining the active concurrency slot until cleanup ends, the service/content suites passed 22 tests including the new 16-slot cleanup-admission regression (84 distinct tests across the executed files).
- Server, Web and Provider SDK TypeScript checks passed. Scoped Biome checks and diff whitespace validation passed; public DTO definitions now exist only in the protocol file.
- The first loopback test invocation was denied by the sandbox with EPERM; the same local-fixture tests passed after automatic execution approval. No external service or model was called. Full repository check is owned by the coordinating maintainer.
