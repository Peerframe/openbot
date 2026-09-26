# Research: Python Server-authorized MCP plugins

Status: accepted for implementation, 2026-09-24. Scope preserves `plugin-service.ts`,
`plugin-store.ts`, `plugin-transport.ts`, `plugin-types.ts` and shared protocol schemas;
existing decisions in `docs/research/third-party-mcp-plugins.md`, `plugin-platform-completion.md`,
`plugin-flow-refactor.md` and the reuse ledger remain authoritative.

## Selection and exact evidence

Use MCP 2025-11-25 with the released official Python SDK **mcp 1.29.0** (MIT), release
https://github.com/modelcontextprotocol/python-sdk/releases/tag/v1.29.0, commit 98b7159.
Reviewed the published source archive (`python-plugin-pins/mcp-pin.json` records URL/SHA256),
`src/mcp/client/session.py`, `streamable_http.py`, `_httpx_utils.py`, tests/client
`test_output_schema_validation.py`, `test_resource_cleanup.py`, and shared Streamable HTTP tests.
The SDK owns MCP messages, negotiation and protocol validation; OpenBot owns endpoint/network
admission, catalog digest, bounded draft-07 validation, grants, approval, audit and lifecycle.
The 2.x release changes the default protocol/HTTP dependency; it is not needed for this retained
compatibility slice. No upstream source copied or forked.

Use SDK dependency **jsonschema 4.26.0** (MIT), release
https://github.com/python-jsonschema/jsonschema/releases/tag/v4.26.0, commit a727743;
reviewed published `jsonschema/validators.py`, `_keywords.py`, test suite and COPYING.
Use `Draft7Validator`, never generic dialect selection or remote retrieval. Existing OpenBot
schema-position policy rejects reference/regex/format/unsupported keywords before compilation.
The SDK's generic output-schema validator must be overridden by this same bounded validator.

Reviewed official security advisories https://github.com/modelcontextprotocol/python-sdk/security/advisories
and HTTP redirect issue https://github.com/modelcontextprotocol/python-sdk/issues/3358.
1.29.0 follows the 1.27.2 authenticated-session fix; Server hosting/auth/task/WebSocket facilities
are not exposed. A custom httpx transport denies all redirects and rejects private DNS answers
on every request, pins the connection address, retains original Host/TLS identity, bounds complete
responses, permits no retries or remote GET push, and sends only explicitly retained bearer tokens.
JSON Schema public security page https://github.com/python-jsonschema/jsonschema/security
was reviewed; this is targeted public evidence, not a complete dependency vulnerability audit.

## Historical digest adapter

The old manifest hashes `JSON.stringify(canonical(value))`, where `canonical` uses default
Node `localeCompare` for all object keys. Schemas/annotations include arbitrary Unicode keys,
JSON scalar numbers and integer property names: Python sorted/json.dumps is not equivalent.
PyICU was evaluated against its published metadata and platform build requirements, then rejected
because it introduces a native compilation dependency yet still depends on ICU/locale version.
The parent explicitly selected the existing Node runtime as a narrow legacy-format adapter:
fixed script, no user-provided code/argv, shell=False, bounded stdin/stdout, deadline. No Node
plugin execution, network or permission decisions. The Node executable/locale is an explicit
composition setting. Absence fails closed. A future versioned digest requires explicit re-review;
no silent digest rewrite or retained authorization bypass is permitted.

## Storage and authority

Preserve AES-256-GCM envelope/AAD and `.key` bytes using already-reviewed cryptography 50.0.1.
Reuse protected POSIX file helpers from Python model settings with short file leases and rollback
journal around OwnerTransactions authority commits. Runtime scope callback is mandatory for run
operations. No callback means forbidden. Owner content scope and bot existence use actual SQL.
Only a genuinely absent store and absent key bootstrap empty state; corrupt, unsafe, or keyless
ciphertext fails unavailable. No new connector or automatic OAuth, subprocess MCP or sampling.
The only Node subprocess is the fixed historical manifest serializer described above.

## Validation commitment

Focused real synthetic PostgreSQL Owner/membership checks, real loopback MCP protocol lifecycle,
Node/Python encrypted-state and manifest digest interoperability, revision/grant/approval races,
cancellation/cleanup, body/schema limits, and SSRF/redirect admission regressions. Product HTTP
registration and native runtime scheduling are root integration responsibilities. POSIX is the
verified protected-file platform; this module does not claim unimplemented Windows ACL support.

## Adapter API review and verified artifact pins

The existing HTTPX 0.28.1 / HTTPCore 1.0.9 stack is reused. HTTPCore's documented public
`AsyncNetworkBackend` and `AnyIOBackend` extension point avoids replacing TLS or HTTP parsing:
https://www.encode.io/httpcore/network-backends/ and
https://github.com/encode/httpcore/blob/1.0.9/httpcore/_async/connection.py.
The reviewed connection source keeps TLS `server_hostname` equal to the original origin;
only the backend TCP dial receives the policy-checked numeric IP. Per-request pools have zero
retries, no proxy and no retained connection across DNS checks.

Exact new wheel URLs/SHA256 and existing versions are in `python-plugin-pins/dependency-pins.json`;
`python-plugin-dependencies.md` records upstream and license metadata for every new transitive wheel.
the control requirements lock is the tested constrained set, not a replacement for root requirements.
No root environment was changed. Public PyPI metadata and wheel SHA256 were checked before
unpacking solely into the packet. SDK sdist SHA256:
`52d01f334de1868cc3bb2d6604931126a67631f99a6c5d3b82ba47290315ec36`;
jsonschema sdist SHA256:
`0c26707e2efad8aa1bfc5b7ce170f3fccc2e4918ff85989ba9ffa9facb2be326`.
The protocol source remains the official 2025-11-25 transport standard:
https://modelcontextprotocol.io/specification/2025-11-25/basic/transports.

## Observed limits

Legacy canonicalization remains a narrow explicit Node runtime dependency, with the tested
`en-US` collation. Existing installs made using another Node locale require composing the same
locale; a mismatch is a conflict that requires review, never an authorization bypass.
No live public provider or private credential was used. The tests exercise disposable loopback
HTTP including JSON and SSE, a genuine official Python MCP server and the repository's original
TypeScript MCP server. No claim of external OAuth, all MCP features, Windows protected storage,
or remote TLS infrastructure conformance is made. Remote TLS verification is supplied by the
reviewed HTTP stack and origin-preserving adapter; the local fixtures use explicit HTTP allowlist.
