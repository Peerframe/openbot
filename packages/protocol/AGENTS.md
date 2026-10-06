# Protocol contributor rules

This package owns retained Node/wire Zod contracts and the P1 Work/native Task and core control
HTTP schemas in `work-http.ts`, `native-task.ts`, `control-http.ts`, `model-services.ts`,
`storage-http.ts`, `lifecycle-http.ts`, `employee-http.ts`, `automation-http.ts`, `node-http.ts`,
`plugin-http.ts`, `browser-http.ts`, `portability-http.ts` and their OpenAPI registries.
Control/Work OpenAPI and Work compatibility types are generated from TS; Web/domain consume
shared inferred identity/session/message/Run/model/storage types. Retained Python DTOs are parity evidence,
not the generator source. All default registrations and reviewed consumers are inventoried;
mixed-entry transport, engine execution and installed/native packaging retain P2/P4/P5 gates.
Keep strict Server wire schemas separate from the existing additive Web projection and explicit
UUID/default/Unicode-byte adapters. JSON Schema does not replace executable refinements.
`npm run contracts:test` checks actual Python DTO/route serialization, defaults and input normalization;
`npm run contracts:http:python` checks real Work/identity/auth/workspace/read/model/storage/lifecycle HTTP,
attachment bytes/DOCX parsing, approval decisions/settings, audit JSON/CSV, Employee profile/knowledge/
skills/memory, automation CRUD, Node enrollment/revocation HTTP/WebSocket, Run artifact bytes,
plugin installation/update/content over real MCP, browser sessions/maintenance, Employee export/import and SSE
on owned disposable PostgreSQL.
It exercises the private-fixture CLI with eleven suites, including session revocation/password
changes. The default all suite never invokes successful model transport; `-- --suite models` uses
the existing trusted transport factory with real Owner HTTP/SQL/SDK and synthetic responses.
Its count-only receipt requires10 discoveries/4 no-tool probes and zero extra dispatch/retry/fallback.
`-- --suite publisher` separately qualifies ephemeral-keyring signing; CI requires all three runs.
Native Work approval/rejection and pending lookup/replay/cancellation pass real HTTP against seeded
proposed/expired/stale/unknown actions. Requests never admit execution or settle unknown outcomes.
Seeded pending approvals,
unread messages, audit events and legacy/native proposal sources qualify HTTP transactions,
not Worker/Temporal publication or execution. Future schedule CRUD does not qualify due submission.
Neither check proves Temporal execution. Read projection schemas validate
serialized DTOs; explicit optional nulls are omitted except required nullable model usage/progress.
IANA timezone resolution and referenced identities remain service validation beyond JSON shape.
Connection names and transient PDF passwords retain UTF-16 bounds. Model base URLs validate the
raw string before URL parsing; Zod URL parsing can discard controls. Storage and approval-settings
revision inputs must retain raw JSON integer tokens, so a future TS body parser must refuse `1.0`
on those operations. Audit strings retain PostgreSQL code-point truncation and the payload allowlist;
only bounded preference ID fields can retain explicit null.
Employee skill creation uses the current product's17 admitted capabilities; broader retained Node IDs
do not widen that writer. Memory write/store and automation text bounds count UTF-16 units.
Memory credential scanning and merged-state policy, Markdown parsing and schedule range/membership
remain service-owned. Preserve the current memory surrogate503 mapping. Automation update strips
extra fields while creation is strict; occurrence nulls and rejected-proposal `memoryId:null` remain explicit.
Use the [cross-language route](../../docs/REPOSITORY_MAP.md#cross-language-contract).
Node token issuance/revocation use Owner cookies and Origin checks. Bootstrap exchange uses only
the one-time token, with no Owner/Origin requirement; preserve throttle Retry-After, token/credential
rotation and socket disconnection. Public identity metadata omits private digests and optional nulls.
Synthetic protocol peers qualify enrollment/heartbeat/revocation, not a Worker executor or Run authority.
Run artifact reads preserve PNG/Markdown media, original bytes and UTF-8 disposition. Owned file fixtures
qualify digest/size, bounded keys and no-follow checks, not actual Worker artifact publication.
Native Work files use a separate8MiB content-addressed private root, support empty/arbitrary binary
payloads and retain sandbox headers. Its snapshot download links and digest/size/missing/oversize/
no-follow failures have real HTTP evidence from synthetic publication; this is not Worker publication.
Owned `--suite` execution selects one private fixture shape; partial runs cannot refresh the full inventory.
SSE ready notifications omit content and replay IDs. Real message invalidation, slow-reader coalescing,
authoritative refresh, channel deletion and workspace/channel revocation are qualified; saturation
pressure and mixed-entry behavior are not. The runner bounds actual UTF-8 bytes and refuses truncated
frames/sequences; synthetic parser tests do not qualify product transport pressure.
Plugin HTTP reuses retained declarations and reviewed catalog validators with explicit Python trim/UUID/Unicode
adapters. Direct bounded DTO strings count UTF-16; annotated collection values count code points.
Constrained strings refuse lone surrogates, while the retained unconstrained `createdAt` field does not.
Plugin UUID text is case-preserving, includes non-versioned layouts, and revision equality is case-sensitive.
Endpoint normalization/DNS/HTTPS/exact-local policy, manifest digests and declaration/grant/membership
checks remain service-owned. Mutation/no-op/update rotates revision; update always disables and clears grants.
Content is untrusted; HTTP admission is24576 bytes, inner content input/ordinary resource result is12KiB,
and declared app resources retain their separate160KiB ceiling. Public records never contain tokens.
The owned MCP fixture has separate private credentials and changes only bounded declarations/content;
it never executes a tool. Default legacy-call decisions have refusal-only HTTP evidence because the
service has no legacy Run guard; successful decisions/native durable approval/execution remain unqualified.
Web plugin types derive from strict HTTP schemas with an explicit optional content-result projection;
retained Node plugin schemas are compatibility contracts and do not expand HTTP authority.
Browser HTTP retains code-point string bounds, raw AnyUrl spelling, required public control availability
and strict actions. PNG byte/header/dimension validation, original Host credential/socket binding and
the pause gate remain service-owned; synthetic peers never qualify Chromium or browser execution.
Default human control stays disabled. The real product entry retains a cancelled request's wait until
its original25s deadline; preserve bounded lifetime and no retry without claiming immediate cancellation.
Portable HTTP reuses existing Employee package/DSSE definitions with explicit timestamps, content bounds,
null-extension omission and strict public preview/receipt projections. Encoded signed payload bytes stay
intact. Minute-precision package timestamps and second-precision browser timestamps differ. Activate's
inner package remains service-parsed JSON; checksum, trust, credential scanning, dependency closure and
reviewed activation are authority checks beyond DTO shape. Preserve strong review tags and412/428,
JSON-only import requests, both download MIME types and creation201/idempotent replay200. The optional
publisher keyring's successful signed HTTP paths are qualified by the separate `--suite publisher`
composition with ephemeral offline keys and public-only fixture metadata. Trusted browser composition
remains a separate gate. Preserve independent byte/signature verification, non-authoritative hints,
untrusted embedded-key refusal and disabled imported skill state.
The inventory includes reviewed source digests for Web/Desktop/Node/native Host consumers and actual
registrar/composition boundaries. The real Web/Desktop Node-Fetch fixture checks settings PUT and
Owner upload/list/download/delete; it does not qualify installed Electron or native platforms.
Trace actual Node, Web/Desktop and Python consumers, not just direct imports. Preserve strict runtime
validation, unknown fields, missing versus null, error codes, byte bounds and negative serialization
cases. A public contract change requires targeted evidence and affected consumer checks. Shared
packages must not import apps. Build shared contracts before downstream typechecks; frozen oracle
comparison is compatibility evidence, not permission to extend the retired implementation.
