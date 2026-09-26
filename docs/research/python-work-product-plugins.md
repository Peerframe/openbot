# Work durable plugin adaptation review

Reviewed before implementation, 2026-09-25. This packet reuses the current repository's
`docs/research/python-plugins.md`, `python-plugin-dependencies.md` and exact checked-in
`python-plugin-pins/{mcp-pin,jsonschema-pin,dependency-pins}.json`; no dependency or protocol
is added. MCP official Python SDK 1.29.0 (MIT, source commit 98b7159), jsonschema 4.26.0
(MIT, a727743), MCP 2025-11-25 and the pinned HTTPX/HTTPCore bounded transport remain the
reviewed implementation. Primary sources and reviewed issue/security evidence are retained in
those records, including https://github.com/modelcontextprotocol/python-sdk/releases/tag/v1.29.0
and https://modelcontextprotocol.io/specification/2025-11-25/basic/transports.

Reuse order: existing released SDK, then a narrow product adapter. No SDK fork, new executor,
approval queue, SQL schema or custom MCP protocol is needed. Repository MIT source is adapted
locally; no upstream source is copied, and the existing LICENSE remains applicable.

Inspected current PluginService/FilePluginStore/MCPConnector and the native TS call_plugin /
read_plugin_resource declarations; Work DeferredActivities, effects, ToolResults, engine binding,
source provenance, correction context, claims and ProductWorkModel establish the target boundary.
The Work path must never call the old PluginService.call pending-Future approval path.

Selected design: immutable plugin revision + manifest digest + selected descriptor/schema +
grant-mode snapshot, with the existing DeferredPlan/Action approval. Exact arguments already
belong to the deferred Action envelope. The Work adapter rebinds the actual SDK Activity and
reads its exact accepted start, then verifies Task, source membership, correction, live fence,
admitted Action/digest/generation and approval in one SQL transaction at dispatch. A durable
content-free dispatch-started event under the same Task lock consumes this one send; neither a
caller boolean nor an old admitted row can permit another call. Lost response stays unknown.

Necessary narrow transport extension: an optional trusted callback runs only for the exact
tools/call or resources/read POST, after DNS validation immediately before transport dispatch.
It receives the actual method/params and must match the immutable snapshot. Metadata discovery
keeps existing behavior. No SQL lock is held while waiting for network response. The callback's
successful transaction is the dispatch linearization point; revocation after dispatch cannot
undo an external effect. The existing SDK/transport has retries disabled. A received response
is an untrusted observation, not independent verification of a business mutation; ToolResults
retains it and lookup never contacts the remote service again.

The source read_plugin_resource tool supports only granted non-app resources, not prompts or
MCP app HTML. Both tool paths retain original bounds and current manifest verification. Owner
API methods and their original approvals remain compatible. A trusted Work dispatch callback
is mandatory for the new seam; absence or malformed callback fails closed.

Validation uses the dedicated owned work_plugins.json PostgreSQL fixture (38 canonical
migrations), synthetic localhost official-SDK MCP service, and the existing Temporal SDK/history
test seam. No credentials, provider billing or production service is used. Actual Temporal
Runtime composition and whole-root checks remain root's responsibility.

Final implementation also exports detached ToolDescriptors for the exact retained call_plugin /
read_plugin_resource inputs. UUID acceptance reuses the existing identity_inputs Zod pattern and
its retained THIRD_PARTY_NOTICES attribution; no new upstream pattern/source was copied. Catalog
projection remains a read-only product operation with existing tool/resource count and byte limits.

## Large declared schemas

The retained plugin contract allows a 12-KiB inputSchema inside a complete Tool/Resource
declaration bounded at 24 KiB by plugin_inputs.parse, plus 8-KiB arguments. Their combination
can exceed Work's 16-KiB immutable Action limit. Reuse the same private LocalWorkFiles digest/size
mechanism already reviewed for prepared reports (OCI descriptor verification; see
python-product-runtime.md). Only an oversized declaration snapshot is stored as an immutable
blob; the Action keeps exact plugin/revision/manifest/mode plus the blob descriptor and original
arguments. Fresh grant and dispatch validation expands and compares the original schema bytes.
No Action limit, tool argument limit, approval boundary, remote protocol or dependency changes.
The existing small inline schema form remains readable. No third-party code is copied.

The declaration blob uses the existing complete-declaration 24-KiB bound for both writing and
reading. Applying the schema-only 12-KiB limit here would reject legitimate descriptions and
annotations: catalog truncation/omission does not narrow the reviewed declaration. A real
FastMCP test reproduced that refusal before the fix. The focused regressions use a
10,000-character schema description, 7,000-character arguments and a 2,000-character Chinese
full tool description, covering exact snapshot recovery, approval, one dispatch, current grant
revalidation, blob integrity and no replanning/reconnect. No existing schema/argument/Action
limit or approval behavior is increased. See the focused test_work_plugin_large.py regression.
