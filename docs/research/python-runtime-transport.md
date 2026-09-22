# Research: Python runtime process transport

- Status: Accepted for an internal integration adapter; production activation deferred
- Date: 2026-09-23
- Owner: OpenBot maintainers
- Acceptance journey: Run the reviewed Python SDK loop as a child while the Server owns model,
  tool and completion authority, and close that child on every terminal path.

## Primary evidence and reuse decision

Reuse the existing [MCP review](third-party-mcp-plugins.md), including release, license and security
issue evidence for `@modelcontextprotocol/sdk` 1.30.0 / `2d889f2b329e46680ec9bdd565de4616c497825a`
(MIT). Read pinned `src/shared/stdio.ts`, `src/client/stdio.ts`, `test/shared/stdio.test.ts` and
`test/client/stdio.test.ts` through official GitHub raw and contents APIs. The latter tests cover
newline buffering, exact/oversize bounds, overflow clearing, client lifecycle and process IDs.

The released `ReadBuffer` has a configurable partial-buffer limit and `serializeMessage` provides
the newline envelope. Reuse these public helpers in a narrow adapter, with strict UTF-8 validation,
per-frame/lifetime bounds and application schemas. The released `StdioClientTransport` merges
inherited HOME/PATH and terminates only the immediate child; it does not supply this invocation's
minimal environment, process-group cleanup or Server operation gates. Retain the codec dependency
and implement only that missing lifecycle adapter. Do not fork the SDK or invent another codec.

The [JSON-RPC 2.0 specification](https://www.jsonrpc.org/specification) defines request/response
correlation and error envelopes. The private profile admits one invocation and sequential child
requests; it does not claim full JSON-RPC service support or MCP interoperability. Application
methods and Run authority must be defined separately.

Reviewed Node v26.0.0 (the local runtime) `doc/api/child_process.md` from the official GitHub
contents API after the documentation site fetch failed. POSIX `detached: true` creates a new
process group/session, but alone does not guarantee shutdown on parent death. Keep owned pipes,
observe EOF in Python and explicitly terminate the owned group; retain a bounded kill escalation.
No Windows process-tree support is implied. Python is ordinary trusted installed code under the
OS account, not an OS sandbox; no downloaded plugins or arbitrary script entry points are admitted.

## Data and authority design

The Server keeps the original task messages, instructions and media. Python receives a fixed
control prompt and tool declarations, and its SDK drives the model/tool/observation loop through
RPC ports. Each model request supplies only the SDK-generated conversation with that fixed prefix;
the Server replaces the prefix with its original task context and adds current corrections. This
avoids sending media bytes or inventing a second media URL loader in Python. The fixed prompt never
reaches the provider as the actual task. Python does receive model/tool outputs needed for iteration.

The Server never trusts Python usage, correction IDs, tool catalogs, model identities or status.
The host verifies tool intents against its own model response and final text against its last
completed answer. RPC IDs are only correlation; failed or ambiguous effects are never replayed.
Streaming parity remains a separate gate before a production runtime switch.

## Exact implementation contract and verification

See [wire profile](../AGENT_RUNTIME_PROTOCOL.md). Codex owns the Server supervisor and integration;
DeepSeek owns the Python CLI, SDK translation and its tests. Reuse the package's reviewed Pydantic
AI unit, Python stdlib asyncio/json and the existing MCP SDK helpers; add no dependency for framing.
No upstream source is copied or substantially adapted.

Required evidence: real parent/child model-tool-final journey; malformed/oversize/partial frames;
unknown and overlapping requests; stdout/stderr flooding; EOF/cancel/crash/late result; failed
usage/audit, revoked scope and budgets; clean child exit before publication; original media and
per-step corrections retained by Server; real API/PostgreSQL report delivery. Synthetic tests
must identify themselves. Linux reference execution and live streaming remain explicit open gates.
