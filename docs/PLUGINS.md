# Third-party MCP plugins

[English](PLUGINS.md) · [简体中文](PLUGINS.zh-CN.md)

OpenBot connects Bots to external tools through MCP. Plugins can query services, transform data,
or perform approved operations in their own backends. MCP also supplies resources, reusable prompts and isolated HTML views; SKILL.md supplies instructions. Installing a plugin registers a Server connection, without downloading code into
Desktop or launching a subprocess.

## Create an independent plugin

From the OpenBot checkout, run `npm run plugin:create -- ../my-openbot-plugin` with a new directory.
The generator copies the tested MCP example and its MIT license, writes pinned dependencies and
an independent README, and refuses to overwrite an existing directory. In the new project run
`npm install`, retain its lockfile, then `npm test` and `npm start`. No OpenBot workspace imports are required.
Configure the exact local endpoint on the Server as described below; install, grant and enable it
through the plugin manager. The sample includes tools, resources, a prompt and an isolated App.
Plugin updates show added, removed and changed declarations before review; applying an update
still disables the plugin and clears grants. The example's notes are temporary process memory.

## Check compatibility before connecting OpenBot

The generated project includes `npm test`: a real local SDK example plus named negative fixtures
for input/output schemas, required task execution, bearer authentication, transport, protocol,
timeout, pagination and result bounds. These tests need no OpenBot Server, database, model or paid
account. Each fixture binds an ephemeral loopback port and closes it afterward.

With your example running, use a second terminal in that independent project:

```sh
npm run preflight -- http://127.0.0.1:4318/mcp
```

Preflight only initializes and lists tools. It prints a JSON report with the negotiated protocol
version, tool names, zero tool calls and explicit unchecked areas; failure returns exit code 1.
The author command accepts only literal loopback HTTP(S) endpoints, with no credentials in the
URL, queries, fragments or redirects. Set `OPENBOT_PLUGIN_TEST_TOKEN` in the environment for a
local service requiring a dedicated test bearer token. No OAuth flow is started.

The author probe and Server share the same tool/schema/result policy module. The probe does not
check resource/prompt compatibility, actual tool results/effects, Server endpoint authorization,
installation or grants; those still require the Owner workflow. A successful declaration check
cannot prove the behavior of a remote tool. Generated files are a version snapshot: generate into
a new directory when adopting a newer OpenBot policy.

Server preview/install/update and the author probe return fixed, machine-readable `compatibility`
reasons when a known profile check fails. The existing API `code` and HTTP status remain available.
Remote bodies, authentication challenges and tokens are excluded from these messages.

| `compatibility` | Meaning and action |
| --- | --- |
| `authentication_required` | HTTP 401; supply a valid dedicated bearer token. OAuth-only connections need a future authentication integration. |
| `access_denied` | HTTP 403; verify token scope or the service's access policy. |
| `transport_unsupported` | Wrong path/HTTP method, redirect or unsupported response media type; use a direct Streamable HTTP endpoint. |
| `protocol_unsupported` | The pinned SDK rejected the negotiated version; use a supported MCP revision. |
| `schema_unsupported` | Input/output schema uses unsupported syntax, fails compilation or exceeds bounds; follow the draft-07 subset below. |
| `execution_unsupported` | A tool requires task-augmented execution; offer direct invocation to this client. |
| `catalog_unsupported` | Tool names, counts, duplicates or pagination are incompatible; return one bounded complete page. |
| `result_unsupported` | An invoked tool returned unsupported or oversized content; return bounded text and optional structured JSON. |
| `timeout` / `cancelled` | The deadline expired or the caller cancelled; no automatic retry occurs. |

Known incompatibility blocks installation/update before any grants can be created. Existing
installations recheck declarations before invoking; a tool that changes to required-task execution
is rejected without sending `tools/call`. Result compatibility can only be checked after an
explicitly authorized invocation; the result cannot authorize more work.

## Owner workflow

1. Open the plugin manager, enter a name, MCP endpoint and optional dedicated bearer token.
   Preview retrieves declarations without calling tools.
2. Inspect the endpoint, descriptions, input schemas and annotations, then confirm installation.
   New plugins are disabled and have no Bot grants.
3. Choose a Bot and select tools. **confirm** requires approval every time, and should be used for
   writes, messages, other external mutations and tools whose behavior you have not established.
   **read** is an explicit standing Owner grant to send parameters and call a trusted observational
   tool without another prompt. A plugin's `readOnlyHint` never grants either mode automatically.
4. Save grants and enable the plugin. Ask the authorized Bot to use it in a channel. The Agent sees
   only its permitted catalog and calls through the Server.
5. Confirm-mode requests appear in that channel with plugin, tool, Bot, exact arguments and expiry.
   Approve or reject within 60 seconds. Approval admits one call; rejection, expiry or task
   cancellation prevents execution.
6. Disable/remove/change grants to block further access and abort pending/in-flight requests.
   Already transmitted operations may have taken effect. Uncertain calls are never retried.

The Run determines Bot/channel identity; model parameters cannot choose another identity. Changed
declarations invalidate old calls. For changed catalogs, preview and apply an update: installation is disabled and every grant is cleared. To change an endpoint or token, remove and preview/install the connection again. Removal disconnects OpenBot;
it does not erase third-party data.

An external service receives tool arguments, not an automatic workspace dump or other providers'
credentials. The selected model receives tool results. Results cannot grant authority. An external
server can misdescribe its behavior: OpenBot's grant checks do not sandbox that remote server.
Use a trusted backend and narrowly privileged service account.

## Run the example

After `npm ci`, run this separate local MCP server from the source checkout:

```sh
npx tsx apps/server/src/plugin-example.ts
```

Explicitly configure the development endpoint on the **OpenBot Server computer**, then restart:

```dotenv
OPENBOT_PLUGIN_LOCAL_ENDPOINTS=http://127.0.0.1:4318/mcp
```

For an application-hosted Server, set the variable in the application's launch environment before
opening it. Localhost means the Server computer, not a remote client. Only exact operator-listed
literal `127.0.0.1`/`::1` endpoints are admitted; other endpoints require public HTTPS, and all DNS
results must be public. URL credentials, queries, fragments and redirects are rejected.

Install that endpoint through the Owner workflow. Grant `sum_numbers` as read and `append_note`
as confirm to one Bot, and enable it. Enable the native Agent with a tool-capable model, then ask
“Use sum_numbers to add 13 and 29.” Next ask “Use append_note to save ‘Checked result: 42’.” The
second operation appends one note only after approval. Other ungranted Bots cannot call these tools.
Notes are real state in the example process's memory, cleared on restart; no external account or
local document is used. Source: [plugin-example.ts](../apps/server/src/plugin-example.ts).

## Author contract

Implement a normal **MCP 2025-11-25-compatible Streamable HTTP** server, in any language. OpenBot
pins official `@modelcontextprotocol/sdk` **1.30.0**, commit
`2d889f2b329e46680ec9bdd565de4616c497825a`. No OpenBot-specific plugin SDK is required.
See the [research](research/third-party-mcp-plugins.md).

| Area | Current contract |
| --- | --- |
| Transport | One exact endpoint; fresh SDK client per preview/call, no redirects, cookies, proxy, reconnection or replay. Return completed JSON or bounded POST SSE responses; permanent GET push streams are disabled. |
| Authentication | Optional dedicated bearer token encrypted on the Server. OAuth and dynamic credential discovery are not implemented. |
| Discovery | One complete page per capability, up to 32 tools, 32 resources and 32 prompts; at least one declaration, catalog ≤64 KiB. No pagination or URI templates. |
| Names/description | Names: 1–64 ASCII letters, digits, dot, underscore or hyphen. Descriptions ≤2,000 characters; Agent sees bounded excerpts. |
| Input schema | Synchronous draft-07 subset; object root, ≤12 KiB, depth ≤12 and ≤1,000 JSON nodes. Objects, arrays, scalars, bounds, required, enums and draft-07 applicators work. References, `$id`, regex patterns, formats and header-mirroring extensions are rejected. See the dialect contract below. |
| Arguments/results | Arguments ≤8 KiB and validated. Results: text blocks plus optional structured JSON ≤12 KiB; no images/audio/resources/renderer code. `isError` fails the call. |
| Time | HTTP ≤30 seconds; approval ≤60 seconds; invocation ≤120 seconds and within the parent Run deadline. |
| Capacity | 16 installations; 32 tools and 128 Bot grant entries per plugin; 16 concurrent calls. Agent catalog ≤16 tools and 12 KiB, with truncation flagged. |
| Execution | Direct tool calls only. `execution.taskSupport: "required"` fails discovery; `optional` may use the direct path. |
| Authority | `call_plugin` shares the native Agent tool budget; no additional execution, recursion or background authority. |

This adapter does not expose sampling, elicitation, roots, stdio, task extensions, resource subscriptions, binary resource content, or automatic package execution. Separate read and
write tools, validate arguments and authorization in your backend, and describe actual effects.
Annotations assist human review but do not prove behavior. Put dedicated service authentication
in connection configuration rather than asking the model for account passwords.

### Schema dialect contract

OpenBot's pinned SDK validates with draft-07. Omit `$schema`, or set it to
`http://json-schema.org/draft-07/schema#` (the same identifier without `#` also works).
Other declared dialects are rejected, including 2019-09 and 2020-12; the Server does not silently
reinterpret them. This policy also applies to a tool's optional `outputSchema`.

Supported constraints include `properties`, `additionalProperties`, `required`, `dependencies`,
scalar/array bounds, `enum`, `const`, `allOf`/`anyOf`/`oneOf`, `not`, `if`/`then`/`else`,
`contains`, and draft-07 `items`/`additionalItems`. For example, a tuple uses
`"items": [{"const": "read"}], "additionalItems": false`; field dependencies use
`"dependencies": {"source": ["revision"]}`. Keep both examples within an object-root schema.

The newer keywords `prefixItems`, `dependentRequired`, `dependentSchemas`, `minContains`,
`maxContains`, `unevaluatedProperties` and `unevaluatedItems` are rejected. So are `$vocabulary`,
`$anchor`/`$dynamicAnchor`/`$recursiveAnchor`, `contentSchema`, OpenAPI `discriminator`, and Ajv
`$async`. Errors identify the unsupported keyword or dialect. Ordinary property names and
`enum`/`const`/`default` values with these spellings remain usable; annotations do not enforce
additional validation or grant authority.

If an installed plugin used an unsupported schema, calls now stop before connecting. Export the
supported subset from your schema library, preview the changed declarations, apply the update,
then review and restore grants. Do not remove a required constraint merely to pass discovery;
preserve its meaning using supported constructs and validate it again in the plugin backend.

## Owner API

Paths are under `/api/v1`; existing Owner sessions and trusted mutation Origins are required.
Tokens are input-only and never returned in plugin lists or audit records.

| Request | Body / response |
| --- | --- |
| `GET /plugins` | `{ plugins, pendingCalls }` |
| `POST /plugins/preview` | `{ name, endpoint, token? }` → manifest `{ name, endpoint, tools, resources?, prompts?, digest }` |
| `POST /plugins` | `{ name, endpoint, token?, reviewedDigest }` → `201 { plugin }` |
| `PATCH /plugins/:id` | `{ revision, enabled }` → `{ plugin }` |
| `PUT /plugins/:id/grants/:botId` | `{ revision, tools: [{ name, mode: "read" | "confirm" }], resources?: [uri], prompts?: [name] }` → `{ plugin }`; all empty revokes |
| `POST /plugins/:id/update/preview` | `{ revision }` → `{ currentDigest, revision, changed, manifest }`; no mutation |
| `POST /plugins/:id/update` | `{ revision, reviewedDigest }` → `{ plugin }`; disabled with all grants removed |
| `GET /channels/:channelId/bots/:botId/plugin-content` | Existing channel membership and Bot grants → `{ items, truncated }`; no prior Run required |
| `POST /channels/:channelId/bots/:botId/plugin-content` | `{ pluginId, revision, kind: "resource" or "prompt", name, arguments? }` → untrusted material/view content |
| `DELETE /plugins/:id` | `{ revision }` → `{ deleted: true }` |
| `GET /runs/:runId/plugin-calls` | `{ calls: PluginCallReceipt[] }`; unknown Run `404`, known Run with no retained calls `{ calls: [] }` |
| `GET /plugin-calls/:id` | `{ call: PluginCallReceipt }`; unknown/evicted ID `404`, invalid ID `400` |
| `POST /plugin-calls/:id/decision` | `{ decision: "approve" | "reject" }` → `{ decided: true }` |

Stale config/grant revisions return `409`. A decision can be submitted only while its original Run
waits. After consumption or restart, repeated decision requests cannot dispatch another call.
If a decision response is lost, query that same call ID to inspect the retained decision; do not
repeat the business operation to discover its result. Read APIs require the Owner session, send
`Cache-Control: no-store` and return `503` when receipt storage is unavailable.

## Durable call receipts

Each admitted `tools/call` has a Server-generated call ID. Receipts contain Run/channel/Bot/plugin
IDs, reviewed plugin revision, plugin/tool names, mode, timestamps, `state` and a separate
`approvalDecision` (`null`, `approved`, `rejected`, `expired`, or `interrupted`). They contain no
arguments, response bodies, endpoint, token or raw error text. This ledger covers tool calls;
resource/prompt reads keep their existing audit path.

| State | Evidence and restart behavior |
| --- | --- |
| `preparing` | Admitted before connection; restart becomes `not_dispatched`. |
| `awaiting_approval` | Review requested. A decided approval may briefly remain here while the manifest is rechecked; restart becomes `not_dispatched`. |
| `dispatching` | Dispatch intent durably committed before the tool request. Restart becomes `outcome_unknown`, including the commit-before-wire crash window. |
| `response_received` | A bounded response passed current authority checks and its receipt was committed. This is local transport evidence, not independent proof of the third party's external state. |
| `not_dispatched` | This invocation ended before committed dispatch intent. A prior `approved` decision remains `approved`; an undecided review interrupted by restart becomes `interrupted`. |
| `outcome_unknown` | Dispatch intent exists but no accepted durable response. A timeout, cancellation, lost response, or failed completion write cannot prove whether an external effect happened. |

Recovery never replays calls, restores pending arguments or automatically resumes the Run.
Late responses after cancellation do not turn an unknown receipt into success. If recording an
error also fails, the committed intent remains; the next readable/writable lookup or restart
converts it conservatively after the in-process call has ended. If storage still fails, lookup
fails closed. Plugin removal and the 500-entry audit rollover do not erase these receipts.

The ledger holds at most **256 calls across all Runs**. Active and `outcome_unknown` records are
protected. Admission can evict only the oldest settled record; if all 256 are protected, it returns
`503` before connecting or dispatching. There is no automatic unknown-outcome deletion or resolution
endpoint in this version. Retained approval decisions are queryable, not a permanent unbounded
history. Lists return all retained calls for that Run: unknown first, other active states next,
then settled states; within each group, creation time descending and call ID ascending break ties.
There is no terminal-history pagination that can hide an unknown call.

## Storage and verification

Encrypted configuration, the bounded call-receipt ledger and the latest 500 content-free audit transitions are stored in
`<OPENBOT_OBJECT_STORE_PATH>/plugins/state.json`, with a separate `state.json.key`. Back up both.
Missing/wrong keys with existing data fail closed. Atomic writes and compare-and-write operations
are serialized for one Server, not multiple processes. Audit excludes parameters/results/tokens;
pending arguments live in memory while the Owner is reviewing them. Legacy encrypted files without
a receipt ledger still load; older audit records are not enough evidence to reconstruct historical
receipts. Atomic file replacement and these tests cover process crashes, not machine power loss.

`plugin-service.test.ts` runs a real local HTTP MCP service with the official SDK: discovery,
exact review, install, Bot grant, calculation, approval-before-write, one-time consumption and
disable. Negative tests cover wrong Bot, stale revisions/catalogs, bad arguments, timeout, cancel,
revocation, encrypted persistence and neighboring route body limits. This is local protocol
integration evidence, not validation of every third-party service or model account.

`plugin-call-receipts.test.ts` injects dispatch/terminal-write failure, failed error recording,
approval rejection/expiry/interruption, late cancellation results, capacity exhaustion and audit
rollover. `plugin-call-receipts-crash.test.ts` launches a real child process using the production
MCP transport and encrypted store, kills it after approval before dispatch or after a local MCP
counter increments while withholding the response, and recovers twice in fresh processes. The
counter remains respectively zero or one; repeated approval cannot replay it. `app.test.ts`
checks Owner-only receipt lookups. Run these without model credentials:

```sh
npm ci --ignore-scripts
npx turbo run build --filter=@openbot/server^...
npx vitest run apps/server/src/plugin-call-receipts.test.ts apps/server/src/plugin-call-receipts-crash.test.ts apps/server/src/plugin-service.test.ts apps/server/src/app.test.ts
```

The fixture uses temporary synthetic state and loopback ports. Windows ACL behavior has separate
native tests; this lifecycle fixture does not claim Windows ACL or live vendor conformance. See
[the pinned research and recovery limits](research/durable-plugin-call-receipts.md).


## Resources, prompts and isolated views

Use standard `resources/list` / `resources/read` and `prompts/list` / `prompts/get`. Grant exact resource URIs and prompt names to each Bot; a tool grant does not implicitly grant its associated view. A resource URI is passed only to its own MCP server and is never opened as an OpenBot local file or arbitrary URL. Reads recheck the full declaration digest, Bot/channel membership and current grant before dispatch and before returning content. Cancellation, disable and grant changes discard late results.

Plain resources and prompt results are limited to 12 KiB. Resources must return text for the exact requested URI. Prompts support up to 16 named string arguments and 16 user/assistant text messages; missing required or unknown arguments are rejected before transmission. Prompt templates are explicitly selected by the Owner, remain untrusted material and must not become system instructions.

HTML views use `ui://` resources with MIME `text/html;profile=mcp-app`, up to 160 KiB for the complete envelope and 128 KiB per HTML string. Tools can declare `_meta.ui.resourceUri`; that association is included in review digests. The server returns untrusted HTML as data, never executes it. The host must enforce the MCP Apps lifecycle and isolate it from the application origin. Requested CSP/network/device metadata is not permission: the initial host profile denies external network and device access. See the host's supported capability documentation before relying on optional Apps features.

The example also exposes `notes://current`, user-selected `review_note(note)`, and `ui://notebook/view.html`. The resource and prompt integration tests use a real local MCP SDK HTTP server. This proves the transport and authority path, not compatibility with every third-party app.

## Updating a plugin

An update refreshes declarations from the existing exact endpoint; it does not download a program or automatically update the external server. Preview shows the replacement manifest and whether its digest changed. Apply requires that exact fresh digest and the installed revision. Success clears all Bot grants and disables the connection, including when the declared version is unchanged; review and regrant capabilities before enabling it. Concurrent changes or catalog changes between preview and apply return `409`, preserving the prior installation. Credentials are retained but never returned.

The current view host uses official MCP Apps 1.7.5 AppBridge, two isolated iframe layers, local interaction and individually granted resource reads. It does not advertise tool calls, message sending, model-context mutation or external network/device access.

MCP session cleanup uses the SDK termination request on the same validated endpoint, with a five-second bound and support for HTTP 405. The connection keeps its concurrency slot until cleanup finishes. A cleanup failure does not replay a business call or prove remote deletion. Schema keyword restrictions apply to schema positions; ordinary property names such as `format` are allowed. Public data contracts are shared with the renderer; grants and authority remain Server-owned. See [research](research/plugin-flow-refactor.md).
