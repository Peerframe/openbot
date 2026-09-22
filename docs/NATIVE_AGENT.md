# Native Agent

[English](NATIVE_AGENT.md) · [简体中文](NATIVE_AGENT.zh-CN.md)

OpenBot can execute a bounded model/tool/observation loop in the Server. The released Vercel AI SDK
runs iteration; PostgreSQL remains the authority for tasks, channel membership, replies and audit.

## Use it

1. In **Settings → Models & API**, choose a supported provider such as Kimi, OpenAI, Anthropic or OpenRouter, enter a model that supports tool
   calling and its API key, check **Enable native Agent**, then verify and save. The shared UI
   currently labels this option **启用原生 Agent**. Metadata validation alone does not prove that
   a model supports the generation endpoint or tools.
2. Create a Bot with computer profile **none**, add it to a channel, select it and send a new task.
   For example: “Read this channel and summarize the outstanding tasks.”
3. The task changes from queued to running. The inspector records model steps and tool observations;
   a successful task produces a Bot reply and completed Run. A failure is visible on the Run.
4. The inspector identifies native work as **executed by Server**, shows recorded input/output
   tokens and allows the Owner to stop a queued/running native task. A failed or cancelled task can
   be explicitly submitted again as a new task; this starts from the original instruction, not a
   model checkpoint. Worker task cancellation is not exposed by this native-only command.

Inference is off by default, including for existing encrypted model configurations. Enabling it
allows new `none`-profile tasks, including scheduled tasks, to send the task and requested channel
context to the chosen provider; API charges may apply. Tasks created before the most recent enable
are not replayed. Re-enter the key when changing settings. Disabling or replacing settings aborts
active inference. Server must remain running; remote Desktop clients use their connected Server.

For public research, ask for a search or supply a public HTTPS URL and request a Markdown report.
Kimi uses its official search with the saved model key. Other chat providers can use a separate
`TAVILY_API_KEY` configured on the Server; this takes precedence over Kimi search. Desktop forwards
that variable only to its Server when explicitly present in the app launch environment. Without a
search service, public source reading remains available. No per-URL approval is required.
The older indexed source tool still accepts up to three explicit HTTPS URLs. For example: “Read https://example.com and prepare a report.md with citations.”
The resulting file appears in the channel and Run inspector after successful completion. Pages are
untrusted source material; downloads contain model-written text, not executable HTML.

Desktop uses a native **Save report** dialog for Markdown files; choose a new `.md` filename.
Existing files are not overwritten. General browser downloads remain disabled in the native shell.

The native loop includes the assigned Bot's current name, role and description as bounded context,
and records the profile revision it used. Profile content does not grant tools or override policy.

See the [alpha.4 core upgrade](CORE_UPGRADE.md) for channel collaboration, attachment formats and plugin setup.

## Tools and limits

| Boundary | Behavior |
| --- | --- |
| `read_channel_context` | At most 12 messages, bounded text, only the current task's channel and no messages created after the task |
| `list_channel_bots` / `delegate_task` | Discover same-channel native Bots and execute an independently identified child task; up to two levels/four descendants per root, no cycles |
| `read_attachment` | Page explicitly supplied channel text/code; image/PDF input is provided only to enabled OpenAI/Anthropic adapters and requires model support |
| `call_plugin` | Invoke an explicitly granted, digest-reviewed MCP tool as this Bot; confirm mode requires a fresh Owner decision |
| `read_task_status` | At most 8 task titles/statuses in that channel, no tasks created after this task |
| `web_search` | Public search through the selected official Kimi service or explicit Tavily service; query up to 1,000 characters, bounded response, no automatic retries |
| `fetch` | Read model-selected public HTTPS sources through the existing DNS-pinned reader; same page/time/text bounds as `read_public_page` |
| `read_public_page` | Read one of at most 3 explicit task URLs by index; 15 seconds, 512 KiB input, 6,000 UTF-8 bytes of extracted text |
| `read_employee_memory` | Frozen snapshot of up to 8 explicitly model-enabled memories for this Bot; 2,000 UTF-8 bytes per body and 10 KiB projection, with IDs/revisions/truncation |
| `propose_memory` | One bounded candidate lesson per successful task; no active-memory change until Owner review |
| `write_report` | Prepare at most 2 Markdown files; 24 KiB authored text and 32 KiB including Server source provenance |
| Authority | Strict schemas; Server binds channel/Bot from the claimed Run and rechecks membership and Run state. Public HTTPS source selection is allowed; filesystem paths and private network targets are not |
| Iteration | At most 8 model steps, 16 executed tools including at most 4 web calls, and 1,024 output tokens per step (4,096 for Kimi); no next step after reported cumulative input reaches 64,000 or output reaches 5,120 tokens |
| Time/output | 300-second task-tree deadline (90 seconds for a runtime without collaboration), 30-second HTTP deadline, 512 KiB provider reply, 16 KiB instruction/ordinary tool projection, up to 128 KiB serialized opaque search evidence (never truncated), 8,000-character final reply |
| Concurrency | At most 6 root task trees per Server; same-Bot channel tasks remain serialized while different Bots and sibling assignments can run concurrently |
| Network | Fixed official model/search endpoints plus bounded public HTTPS source GETs and reviewed MCP service calls. Source DNS answers must all be public; the connection pins the checked address and verifies the original TLS host. No redirects, proxies or automatic retries; OpenAI response storage is disabled |
| Lifecycle | Reply, report metadata, completion and audit commit together. Prepared report files are removed when publication fails. Interrupted running tasks fail on restart; ambiguous/failed tasks are not automatically retried |

Progress contains action/result summaries, never internal reasoning, API keys or raw provider error
bodies. Per-step provider-reported input/output totals and model identity persist in PostgreSQL.
Missing or invalid counts remain unknown. The usage panel sums only known records in the loaded
channel/workspace sample; it is not a lifetime total, cost estimate or bill. An interrupted request
may incur usage that was never reported. Reported-token thresholds stop subsequent calls, not a
provider request already in flight. Existing byte/time/step limits apply even when counts are absent.
Database availability remains required for state changes and shutdown.

Cancellation and audit commit before the active request is aborted; stopping a parent also cancels its active descendants. Late results cannot replace a
cancelled Run. Credential rejection, rate limits, unavailable providers, changed settings, revoked
scope, invalid tool targets, usage conflicts, changed skills or memory, tool failures and
execution limits have fixed actionable failure messages. No automatic retry
is performed. See [execution experience research](research/agent-execution-experience.md).

The tools do not expose unshared memory, executable skills, shell, arbitrary local file paths, computer input or approval decisions. Explicit task attachments and per-Bot MCP grants provide the bounded extension paths described above; general private-network access is unavailable. Existing Worker-profile tasks keep their existing dispatcher and
approval path. A native task requiring an unavailable action should explain that limitation.
Hermes/Pi/OpenClaw delegation, browser observe/act tools and arbitrary desktop control remain future
adapters, with their own authority and conformance gates.

## Evidence

Tests exercise the real SDK and both provider adapters with deterministic HTTP fixtures, including
a tool result received by the next model step. Tests cover scope/argument rejection, limits,
settings opt-in, cancellation and persistence. The disposable PostgreSQL integration suite covers
competing claims, no historical replay, Worker exclusion, channel isolation, membership revocation,
transaction rollback, exactly one reply and restart interruption. UI tests cover explicit opt-in
and Server progress without a fabricated Node. Source tests cover private/reserved addresses, mixed DNS,
numeric connection pinning, TLS host preservation, redirects, compression, size and cancellation.
Report tests cover transactional publication, rollback, source provenance and authenticated downloads.

These fixtures make no paid requests and do not certify live model availability, output quality or
real-device desktop control. See the [research record](research/native-agent-loop.md) and
[source/report research](research/agent-research-artifacts.md) and [execution plan](EXECUTION_PLAN.md).

## Reviewed memory loop

Ask the Bot to retain a reusable lesson after a task. It may call `propose_memory` once; the lesson
is stored as pending only when the task completes. Open **Employee → Memory → Candidate lessons**
(UI: **员工 → 记忆 → 候选经验**) and refresh to read the source task, full title and body. Edit it,
then accept or reject. The model-use checkbox is off by default: accepting alone saves an internal,
non-portable Owner memory. Explicitly enable model use to make it available to this Bot's later tasks.
Existing memories also have this separate opt-in in their editor. Confidential/restricted entries and
secret references cannot be shared. Old records remain off after migration.

`read_employee_memory` retrieves a bounded recent snapshot, not semantic search or FTS. Each task
records only retrieved IDs/revisions in audit; source Run IDs accompany reviewed proposals. Later
model steps and final publication recheck those revisions and permissions. Disabling, deleting or
editing a used record stops further use of the stale snapshot; content already sent upstream cannot
be recalled. Pending proposals never enter retrieval. Each Bot can have at most 50 pending lessons;
review the queue before creating more. A full queue skips the optional candidate and records
`KNOWLEDGE_PROPOSAL_SKIPPED` with reason `pending_limit`; the valid reply and reports still commit.
Invalid proposals, revoked knowledge and database failures still fail closed.
Acceptance/rejection is serialized and cannot duplicate memory.
Rejected text is removed; accepted text lives in the Owner memory, not the proposal audit.

This is an experimental reviewed-memory loop inspired by Hermes Agent, not autonomous skill learning.
Executable SKILL.md loading, semantic/FTS retrieval, background consolidation, retention schedules and
cross-session user modelling remain future work. See [research](research/agent-reviewed-knowledge.md).

## OpenRouter models

Select **OpenRouter** and enter an explicit `author/model` ID from its current catalog. Verification
reads key and model-endpoint metadata without generating a completion. Management/provisioning keys,
mismatched model IDs and Agent-enabled models without a declared tool-capable endpoint are rejected.
Metadata validation does not certify model quality, account credit or generation availability.

The Server uses @openrouter/ai-sdk-provider 3.0.0 against the fixed chat-completions endpoint. Routing
requires supported parameters, disables automatic provider fallback and requests data_collection=deny.
OpenRouter forwards task content to its selected model provider; the routing request is not independent
certification of third-party retention. Existing loop, output, cancellation, memory and usage limits
apply. No OpenRouter web plugins, BYOK injection, arbitrary endpoints or automatic model selection.
One active Server model configuration is retained; multi-profile/per-Bot selection remains future work.
See [research and known compatibility limits](research/openrouter-model-entry.md).

## Kimi K3

Desktop Settings → Model & API includes Kimi (Moonshot CN), default model `kimi-k3`. Enter the API key and enable the native Agent; the key is encrypted on the service computer and retained after restart. Verification checks the model list without generating content. K3 uses low reasoning effort and up to 4,096 output tokens per step (including reasoning), within the current 300-second tree deadline and eight-step limit. Only newly created tasks for Bots without a computer run automatically. Existing queued tasks are not replayed. Public search and source reading are available in the installed native Agent through the [Desktop web tool integration](research/desktop-public-web-tools.md). Search progress records started/completed/failed tool names without queries or result bodies.

## Asynchronous coordination, corrections and output

[Asynchronous collaboration](ASYNC_COLLABORATION.md) documents nonblocking assignment receipts, result joins, safe Owner corrections and real streamed text. The shared Run budget includes all continuations. Interrupted trees still fail on restart; external side effects are never automatically replayed.

Continuations retain staged reports, source provenance, the frozen memory snapshot, consumed
memory/skill revisions and the single candidate lesson. Their original per-Run limits still apply;
an Owner correction or colleague join cannot reset those limits or bypass a consumed grant's
revocation. Reports receive one source footer when prepared for publication.

## Contribute without a UI or model account

From a fresh checkout, use the repository's Node version, npm and a running Docker daemon with
Linux container support:

```sh
npm ci --ignore-scripts
node scripts/test-runtime-headless.mjs
```

The command builds only the Server's shared dependencies, starts a digest-pinned PostgreSQL 17.11
fixture on a random loopback port, runs the isolated execution, native and collaboration tests serially, and removes
its own container and temporary report files. The first run may download the image. No Web or
Electron build, `.env`, Owner setup, model API key or paid request is required. Missing prerequisites
fail the command; the acceptance suite does not silently skip its database checks.

If an existing disposable PostgreSQL service is preferred, set
`OPENBOT_COLLAB_TEST_DATABASE_URL` to a loopback URL whose database name starts with
`openbot_collab_test_` (letters, digits and underscores only). Fixture tables in that database are
reset. The command never uses `OPENBOT_DATABASE_URL`; it does not remove externally supplied
databases. Integration suites sharing the same fixture database must run serially.

| Change location | Responsibility and verification |
| --- | --- |
| `apps/server/src/agent-runtime.ts` | `executeAgentRuntime` composes the real SDK through explicit model, tool, authority, storage and audit ports. Use `agent-runtime.test.ts` without the Server app or database. |
| `apps/server/src/native-agent.ts` | `executeAgentRun` binds Server-owned context, identities, tools and the `AgentRunStore` adapter to those ports; `NativeAgentRunner` owns scheduling, budgets, cancellation and continuation. Use `native-agent.test.ts` for adapter and authority regressions. |
| `apps/server/src/postgres-agent-store.ts` | Durable claims, scope, cancellation, reply/report publication and audit. Use the headless and collaboration integration suites; an in-memory mock cannot establish transaction behavior. |
| `apps/server/src/app.ts` | Owner-authenticated submission, stop, realtime observation and artifact download; UI clients do not own execution. |
| `apps/server/src/native-agent-headless.integration.test.ts` | Runnable examples combining real Server routes, Owner authentication, PostgreSQL stores, file artifacts and the SDK's deterministic model. |

The headless suite verifies authenticated task-to-download delivery, tool failure without partial
publication, durable cancellation before a late result, SSE response disconnection without task
abort, correction-time report retention, and optional learning saturation. Existing native and
collaboration suites verify consumed reference revocation and bounded colleague joins.
Requests use Hono's in-process HTTP interface and the real PostgreSQL driver; this is not a deployed
socket/proxy test, paid-provider evaluation, process-crash recovery test or desktop certification.
The fixture settings/model adapter is test-only and is never enabled by a production environment flag.

For fast edits after dependencies are built:

```sh
node node_modules/vitest/vitest.mjs run apps/server/src/native-agent.test.ts
npm run typecheck --workspace=@openbot/server
```

Run `npm run check` before handoff and the headless command after changing task lifecycle or
publication behavior. See the [acceptance research](research/headless-runtime-acceptance.md).

## Isolated execution ports

For changes to iteration policy, use the production `executeAgentRuntime` unit directly. From a
fresh checkout, this entry needs Node and npm but no Docker, Server process or model account:

```sh
npm ci --ignore-scripts
npx turbo run build --filter='@openbot/domain...'
node node_modules/vitest/vitest.mjs run apps/server/src/agent-runtime.test.ts
```

The unit accepts a prepared instruction, bounded messages, an abort signal and the shared Run
budget. All ports except public output are required; fixtures supply explicit deterministic
implementations. Production adapters are constructed only by the Server:

| Port | Required contract |
| --- | --- |
| `model` | A resolved SDK model adapter plus its provider/model identity. Credentials, endpoints, HTTP bounds and model selection stay in the Server. String IDs that implicitly select the SDK gateway are rejected. |
| `authority.assertActive` | Revalidate the exact claimed Run, settings, scope and consumed references. The unit checks before model calls and before/after tools, including after awaited correction reads. No permissive default is provided. |
| `tools` | Local SDK definitions already bound to Server identities and target/approval policy, an explicit result-byte/web-budget policy for every tool, and fixed error classification. Each tool returns one completed JSON value; generators, provider-executed tools and missing/unbounded policies are rejected. |
| `storage` | Read only this Run's authorized corrections and persist cumulative provider-reported usage before a subsequent model call or successful return. |
| `audit.progress` | Resolve only after durable bounded progress commits. Web start audit must succeed before dispatch; failed result audit cannot become a successful execution. |
| `output` (optional) | Observe public text deltas/reset events. It conveys no completion authority and excludes provider reasoning. |

The SDK still owns model/tool iteration. The unit enforces the existing execution limits and
returns validated text and applied correction IDs. This is a provisional execution result: only
the Server can commit the reply, report metadata, optional candidate lesson, terminal Run state and
audit together. The Server also retains grants, plugin approval, artifact storage, continuation
state, task-tree scheduling and cancellation. Ports are trusted Server adapters, never capabilities
accepted from a model, plugin or UI request.

The isolated tests cover actual SDK tool feedback, scope revocation, durable audit/usage failure,
invalid calls, bounded results, cancellation with a late answer, correction propagation, shared
budgets and public streaming. The headless command above additionally verifies the same unit through
the real Server and PostgreSQL. This internal module does not establish a separately published
runtime package, process-crash checkpoints or multi-Server execution support. See the
[port extraction research](research/runtime-execution-ports.md).

### Replacing the execution adapter

Server code can pass `NativeAgentOptions.executeRuntime` (an `AgentRuntimeExecutor`) to compose
another reviewed execution adapter. `executeAgentRun` accepts the same option for focused tests;
omitting it retains `executeAgentRuntime`. Roots, delegated tasks and continuations use the same
selected adapter, with each Run's existing Server-owned budget and staged report state.

`runAgentRuntime` guards entry and return, races cancellation, checks final text and accepts only
unique correction IDs observed through the bound storage port. The Server runner still commits
completion and publishes artifacts. The adapter must implement the existing per-step authority,
audit, usage and tool policy contract; these final checks cannot replace those gates.

This is an internal trusted-code extension point, not a per-task request field or worker protocol.
Do not serialize model/tool ports or credentials to an external worker. Runtime selection and
subprocess termination belong to the composition and process adapter described below; the seam
alone does not implement those lifecycle behaviors. See the
[executor seam research](research/runtime-executor-seam.md).

### Server gates for an external loop

`AgentRuntimeHost` prepares declarative tool schemas, executes one model step at a time and admits
only matching, unused model-issued tool intents. Credentials, executable tools, approval policy,
shared budgets and durable usage stay in the Server. It rereads corrections on each step, checks
authority across asynchronous boundaries, bounds history/results and refuses new media references.
A pending tool call blocks another step or completion; any operation failure seals the invocation.
Final text must match the latest completed model response before the runner may commit it.

The headless report journey exercises this host with the real Server and disposable PostgreSQL;
unit tests cover denial, cancellation, failed persistence, concurrent calls and altered tool intents.
The driver in that integration test is a deterministic two-step fixture. The production default
remains the existing TypeScript SDK loop. See [host research](research/python-runtime-host.md).

`createPythonAgentExecutor` now composes the host with a fixed Python executable/entry point,
a minimal environment, bounded newline transport and owned POSIX process-group cleanup. A child
failure aborts in-flight Server operations; only a final response followed by clean child exit can
reach host completion checks. Transport/lifecycle tests use adversarial Node child fixtures and
cover flooding, malformed traffic, concurrent/repeated requests, crash, cancellation and stubborn
descendants. The host also streams bounded public text directly from the Server while the child
awaits a complete model response; reasoning stays private and failed streams are not retried.
These Node fixtures alone do not establish Python integration or Linux product support; the
paired acceptance below runs the actual Python child. See the [wire profile](AGENT_RUNTIME_PROTOCOL.md)
and [transport research](research/python-runtime-transport.md).

### Paired runtime acceptance

`npm run test:runtime:python` selects the real Python process for the Owner API/PostgreSQL journeys.
It requires the package-local virtual environment and `scripts/run-worker.py`, runs the Python
package checks first, and fails if either prerequisite is absent; it never falls back to TypeScript.
The collaboration Runner cases use the same selection, including child cancellation and joined
results; the focused unit tests retain their explicitly selected adapters.

The paired journeys cover report download, cancellation, persisted scope revocation, durable
audit/usage failure, the eight-step budget, per-step Owner corrections, approve/reject/cancel
during plugin approval, provisional public streaming, and retained reports across continuation.
They use deterministic SDK model responses and a synthetic plugin connector; they send no paid
model request or external plugin effect. On macOS, both selected runtime lanes passed 222 cases
across nine files, including 15 Owner API/database journeys. The Python lane first passed its
367 package tests. The report journey preserves a Chinese filename through artifact download;
delegation exercises provider IDs reused by a later model step. These are deterministic integration
results, not paid-provider reliability measurements.

### Explicit source-install selection

The standalone Server accepts `OPENBOT_AGENT_RUNTIME=typescript|python`, defaulting to TypeScript.
For the experimental Python path, bootstrap the package-local environment, run
`npm run test:runtime:python`, then start the Server with `OPENBOT_AGENT_RUNTIME=python`.
The normal Model Settings opt-in is still required; this selector grants no additional tool or
model access. Root tasks, delegated tasks and continuation use the same selected adapter.

Startup checks the fixed package worker, interpreter, imports and dependency lock from an empty
temporary directory with a minimal environment. An absent or incompatible package fails before
database migration or interrupted-Run recovery. There is no automatic install, command/script
configuration, or fallback. Existing PostgreSQL data and migrations are unchanged. The current
production Server container does not yet bundle Python. The separate Linux reference result below
covers the acceptance image, not a production container rollout. See [activation research](research/python-runtime-activation.md).

### Linux reference acceptance fixture

`npm run test:runtime:linux` builds the dedicated `deploy/runtime-acceptance/Dockerfile` test image
with pinned Node 24.21.0, Python 3.12.13 and the existing lockfiles, then runs the paired acceptance
command against an owned PostgreSQL container. Only Docker and Node are needed on the host; the
first build downloads public dependencies. The test containers share an isolated loopback namespace
with no external network or published host ports. Model credentials and local collaboration files
are excluded. The command removes its uniquely named containers and tagged image on exit; Docker
may retain normal build-cache layers. It never selects or resets an existing database.

This is a Linux/amd64 acceptance fixture, distinct from the production Server image. Running it on
an ARM Mac uses emulation and does not prove native hosted CI or desktop support. The final
reference run passed 369 Python tests and all 222 Server/PostgreSQL tests across nine files, with
no external network. Earlier fixture failures and their corrections are recorded in the research.
The `python-runtime` CI job runs this same command and is required by `check`; hosted execution
has not been triggered from this local task.
