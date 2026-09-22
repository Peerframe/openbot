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
fixture on a random loopback port, runs the native and collaboration tests serially, and removes
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
| `apps/server/src/native-agent.ts` | `executeAgentRun` uses the real SDK with the `AgentRunStore` port; `NativeAgentRunner` owns scheduling, budgets, cancellation and continuation. Use `native-agent.test.ts` for deterministic loop and authority regressions. |
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
