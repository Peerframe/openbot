# Migration capability reconciliation (S1)

[English](MIGRATION_CAPABILITIES.md) · [简体中文](MIGRATION_CAPABILITIES.zh-CN.md)

Status: source inventory, 2026-09-23 (S1). This document records **evidence about two existing source
trees**. It is not a protocol, an interface decision, or an implementation authorization, and it
supersedes nothing in [the delivery plan](ARCHITECTURE_MIGRATION_PLAN.md).

**No test was executed to produce this document.** Every row was established by reading committed
source. Where a claim comes from a report someone else ran, that report is named and its scope is
kept as narrow as the report itself states.

## Sources compared

| Role | Reference | Where | Access |
| --- | --- | --- | --- |
| Migration source | `codex/architecture-migration` @ `c33e03f1a14de739196113769c59fdaace9029e7` | this checkout | working tree |
| Feature source | `feat/cross-platform-employees` @ `9cc73c9e78451e572f57d142d6b9caf62ccb78e2` | separate feature checkout | committed source only (`git show`/`ls-tree`/`grep`) |

The feature source was read without writing, checking out, cleaning, merging or installing anything,
and without opening `.env`, `data/`, `backups/`, `output/` or any untracked runtime content.

### How to read the evidence column

- A **link** means the path exists in this checkout at `c33e03f`.
- A `code span` means the path exists **only** in the feature source at `9cc73c9e`, or is named for
  completeness without being readable here. These are deliberately not links: they are not files
  this checkout contains, and a reader must not assume they are available.

## The two sources are not additive

This is the finding that governs every other row.

```
public main            ebce9950b2bde2c44d88d1d3d1902b9e27ba9eb8
merge-base             5fdd99ced126509e702fc4ad00314bf06f3d50c3
commits on main only   338
commits on feature     1        (9cc73c9 "feat: add employee browser and shared model web tools")
```

`feat/cross-platform-employees` is **one commit on a base that is 338 commits behind** public main.
It is not "main plus features"; it is a stale base plus one feature commit. Adding the two trees'
capabilities together would describe a release that has never existed, and the feature commit's own
recorded report is written against that older base.

That same single commit is the entire divergent surface: 100 files, of which the capability-bearing
additions are the employee-browser stack and the model-connection/web-tool stack.

### Database migration histories diverge at `0017`

| | Migration source | Feature source |
| --- | --- | --- |
| `0000`–`0016` | 17 files | 17 files — **byte-identical** (SHA-256 compared per file) |
| `0017` | `0017_request_throttle_buckets.sql` | `0017_model_chat.sql` |
| `0018` | `0018_automations.sql` | `0018_model_services.sql` |
| `0019`–`0026` | present | absent |
| journal | `meta/_journal.json` | `meta/_journal.json` |

Both histories fork after `0016`. At indices 17 and 18 the same timestamps identify different SQL
and hashes. This is an incompatible applied history, not just a filename collision. Preserve both
histories unchanged; target-owned forward changes cannot alone upgrade an already-migrated feature
source database. See [the independent lineage audit and later bridge requirements](MIGRATION_DATA_COMPATIBILITY.md)
and [machine-readable hashes](migration-lineage-baseline.json). No user database was inspected.

## The twelve target capabilities

The IDs correspond directly to the twelve rows in [the delivery plan](ARCHITECTURE_MIGRATION_PLAN.md).
Status describes the specified source baseline, not a completed final product or a new test run.
`Implemented, bounded` means the existing implementation must still pass the owning stage's target
journey; `partial` means important target behavior is missing.

| ID | Capability | Status in migration | Feature-source delta | Owning stages |
| --- | --- | --- | --- | --- |
| C1 | Persistent Bot identity | implemented, bounded | same shared schema through `0016` | S1, S2, S7 |
| C2 | Private chats and channels | implemented, bounded | older channels/messages; current direct conversations are main-only | S2, S7 |
| C3 | Multi-step execution | implemented, bounded | earlier model loop on older base | S2, S3, S4 |
| C4 | Persistent work environment | partial | per-Bot browser profile persistence | S3, S4 |
| C5 | Browser and tool operations | partial | human session controls; autonomous multi-step input still missing | S4, S6 |
| C6 | Files and code delivery | partial | no material added document/code output | S2, S4 |
| C7 | Approval and human takeover | partial: approvals and backend human-control veto exist; Owner session UI missing | shared `0008` Worker approvals plus Owner browser session controls | S2, S3, S4 |
| C8 | Background, schedules and safe recovery | partial: scheduling exists; interrupted work is failed, not resumed | later schedules absent from older base | S2, S3, S7 |
| C9 | Scoped long-term memory | partial: reviewed, bounded recent snapshot | shared memory tables; later reviewed knowledge absent | S5 |
| C10 | Skills and teaching reuse | partial: reviewed single-file instructions | shared skill tables; no demonstrated teaching/evaluation loop | S5 |
| C11 | Responsible multi-Bot collaboration | implemented, bounded | current delegation absent from feature source | S6 |
| C12 | Open tools, backends and models | partial | per-Bot model bindings/connections to preserve and migrate | S6 |

### C1 — Persistent Bot identity

- Evidence: [schema.ts](../packages/db/src/schema.ts) (`bots`), `packages/db/migrations/0000_foundation.sql`,
  `0011_employee_profiles.sql`, `0016_employee_profile_details.sql`,
  [postgres-store.ts](../apps/server/src/postgres-store.ts), and `POST /api/v1/bots` in
  [app.ts](../apps/server/src/app.ts).
- Preserve: Bot identity plus configuration (`bots.configuration`), the evolution archive, and the
  employee package/import receipt tables. Identity must outlive any runtime swap.
- Acceptance: create a Bot, restart the Server, and confirm the same identity, profile and history.
  This is the identity half of [EMPLOYEE.md](EMPLOYEE.md).

### C2 — Private chats and channels

- Evidence: [schema.ts](../packages/db/src/schema.ts) (`channels`, `channelBots`, `messages`,
  `messageReactions`), migrations `0002_message_constraints.sql`, `0009_channel_conversations.sql`,
  `0022_direct_bot_conversations.sql`, `0024_multi_bot_message_recipients.sql`,
  `0025_channel_reactions.sql`; `getOrCreateDirectConversation`; integration test
  `postgres-direct-conversations.integration.test.ts`.
- Distinction that matters: "private chat" is not a separate table. It is a channel with
  `direct_bot_id` set, whose membership is fixed and cannot be joined or edited.
- Preserve: conversations, quoted replies, reactions, multi-recipient messages.
- Acceptance: a private conversation stays private — it cannot acquire a second member — and a
  channel conversation survives a client close and reopen.

### C3 — Multi-step task execution

- Evidence: [native-agent.ts](../apps/server/src/native-agent.ts) (`NativeAgentRunner`,
  `executeAgentRun`), [agent-runtime-host.ts](../apps/server/src/agent-runtime-host.ts)
  (`catalog`/`generate`/`executeTool`/`finish`), [agent-runtime-process.ts](../apps/server/src/agent-runtime-process.ts)
  (`createPythonAgentExecutor`, `superviseRuntimeProcess`),
  [agent-runtime-bootstrap.ts](../apps/server/src/agent-runtime-bootstrap.ts) (opt-in
  `OPENBOT_AGENT_RUNTIME=python`; TypeScript stays the default),
  [postgres-task-submission.ts](../apps/server/src/postgres-task-submission.ts)
  (`submitTaskInTransaction`).
- Authority: the Server owns the tool-intent loop, budgets and the final commit. The accepted Python
  runtime is a supervised child process behind a frozen wire profile — see
  [AGENT_RUNTIME_PROTOCOL.md](AGENT_RUNTIME_PROTOCOL.md).
- Do not treat the feature source's `model-run-dispatcher.ts` / `model-services.ts` as a second
  engine to merge. It is an earlier loop on an older base, not an interchangeable component.
- Preserve: the single-writer rule. A migrated responsibility has exactly one selected writer.
- Acceptance: a task runs tool → observation → result through Server authorization, and the final
  submission happens once. The accepted evidence for this slice is deterministic and synthetic; live
  model quality is explicitly not established by it.

### C4 — Persistent work environment

- Evidence in this checkout: object storage via `OPENBOT_OBJECT_STORE_PATH` (artifacts,
  attachments, plugins); [workspace-realtime-hub.ts](../apps/server/src/workspace-realtime-hub.ts) is
  a UI event channel, not a filesystem workspace. There is **no** persistent workspace directory and
  **no** restricted command execution: [coder provider](../providers/coder/src/index.ts) declares
  `shell.execute` and implements no `execute`.
- Feature-source delta: the feature source adds a per-Bot
  browser profile volume reached through `x-openbot-bot-id`, with the `deploy/browser/` Dockerfile
  and Compose entry.
- Preserve: whatever is chosen must keep Bot-scoped separation, because takeover and approvals are
  per-Bot decisions and cross-Bot bleed would defeat them.
- Acceptance: two Bots on the same host do not see each other's session state or files.

### C5 — Browser and tool operations

- Evidence in this checkout: [providers/docker/src/index.ts](../providers/docker/src/index.ts) is the
  only provider implementing `execute`, advertising `["browser", "screenshot"]` plus an opt-in
  `browser.input@1`; [reviewed-click.ts](../providers/docker/src/reviewed-click.ts) and
  [computer-request.ts](../providers/docker/src/computer-request.ts) implement one approved click
  against an external agent-computer. [CONTROLLED_BROWSER.md](CONTROLLED_BROWSER.md) states the real
  limit: disabled by default, trusted test origins only, "does not implement native desktop input or a
  general browsing agent".
- Feature-source delta: a complete session model this checkout lacks —
  `apps/server/src/browser-sessions.ts`, `apps/node/src/browser-host.ts`,
  `providers/docker/src/browser.ts`, `packages/protocol/src/browser.ts`,
  `apps/web/src/components/EmployeeBrowser.tsx`, `deploy/browser/`, and
  `docs/decisions/0028-employee-browser-sessions.md`.
- The `BrowserSessions.command` path is **Owner/human input**. `navigate`/`click`/`type`/`key`/
  `scroll` require that exact session's active takeover grant; they are not model-selected autonomous
  verbs. Feature-source `docs/EMPLOYEE_BROWSER.md` explicitly limits automated Runs to opening an
  explicit URL and taking a screenshot. Preserve the human session/lease boundary and separately
  implement reviewed autonomous input in S4.
- Acceptance: an approved write on a local fixture site, then a cancel, then a restart — with the
  model refused while the human holds control.

### C6 — Files and code delivery

Recorded per operation, not as one number. Aspiration must not be read as capability.

| Format | Read/extract | Create | Edit | Render |
| --- | --- | --- | --- | --- |
| text/code, Markdown | yes (also as attachment text, paged) | Markdown report only | no | no |
| CSV/JSON | yes, as plain text — no structured parse | no | no | no |
| PDF | yes (`pdfjs-dist`) | no | no | no |
| DOCX, XLSX, PPTX | yes (`officeparser`) | **no** | no | no |
| PNG | n/a | screenshot only | no | n/a |

- Evidence: [channel-attachments.ts](../apps/server/src/channel-attachments.ts) (SHA-256 + size
  admission), [attachment-processing.ts](../apps/server/src/attachment-processing.ts) (extraction in a
  worker thread; also image OCR via `tesseract.js` and audio transcription),
  [artifact-storage.ts](../apps/server/src/artifact-storage.ts).
- Hard bounds worth preserving exactly: artifacts accept **only** `image/png` (≤ 5 MiB, PNG signature
  checked) and `text/markdown` reports (≤ 32 KiB, non-empty, no NUL), each stored with SHA-256 and
  re-verified on read by `GET /api/v1/artifacts/:artifactId/content`.
- The plan lists DOCX/XLSX/PPTX as target *file operations*. Today those exist only on the **input**
  side. Creating or rendering them is new capability, not a rename.
- Acceptance: an exported file opens or renders, and its digest is verified on read.

### C7 — Approval and human takeover

- Evidence: [approval-policy.ts](../apps/server/src/approval-policy.ts) (`approvalPolicyRules`,
  `isRiskDowngrade`) covering `browser.click` (HTTPS/loopback) and `form.submit` (HTTPS);
  `approvals` in [schema.ts](../packages/db/src/schema.ts) with `pending`/`approved`/`rejected`/
  `expired`; `POST /api/v1/approvals/:approvalId/decision` in [app.ts](../apps/server/src/app.ts);
  the plugin confirm lifecycle in [plugin-service.ts](../apps/server/src/plugin-service.ts).
- The feature source already has the shared `0008_owner_approvals.sql` Worker approval path.
  The later native plugin confirmation lifecycle is a separate addition.
- Preserve: approval is a **state**, not a log line, and it is context-bound — the approved target
  must be the target actually executed. Waiting for approval is not a terminal run state.
- Acceptance: approve a concrete external change, and confirm the exact approved action is what
  runs — nothing broader.

#### C7a — Human takeover

The migration baseline lacks the full Owner browser-session UI and Server lease path. Its
`human_takeover` status/label is not proof of that path. However,
[reviewed-click.ts](../providers/docker/src/reviewed-click.ts) checks the external backend's
`/control` holder before and after reviewed input and refuses a human-held browser. That veto
already exists and must be preserved.

The feature source supplies the Owner session implementation:

- Server issues the session and owns the lease:
  `apps/server/src/browser-sessions.ts` (`BrowserSessions.open/command/close`).
- A view session lasts **600 s**; a `take` action grants an **exclusive, per-Bot 30 s control lease**,
  refreshed by each command while held. `release` ends it explicitly.
- Persistence is deliberately shallow, and the source says so in one line: *"In-memory view grants
  never survive reconnect/restart; the backend's paused latch does."* The durable parts are the
  `run_events` audit rows (`BROWSER_OPENED` / `BROWSER_COMMAND`) and the Worker-side browser profile.
  The paused latch lives in `apps/server/src/node-registry.ts` (`setBrowserPaused`). That file exists in
  this checkout, but the latch does not: `setBrowserPaused` appears nowhere here.
- All session input is Owner control (see C5). Model input requires a separately authorized path
  which must respect the human-control latch.
- Routes: `POST /api/v1/bots/:botId/browser` and `POST /api/v1/browser-sessions/:sessionId/commands`.

Preserve: exclusive, time-bounded, per-Bot human control; the boundary between Owner session input and separately authorized automated input; the audit rows; and the honest statement that grants do not survive restart. Takeover grants a
human *control of an interface*, never new authority.

Acceptance: a Bot browses a local fixture site; the Owner takes control mid-task; the model's
commands are refused while the lease is held; release returns control; after a restart the sessions
are gone but the audit rows and the Bot's browser profile remain.

### C8 — Background, schedules and safe recovery

- Evidence: [automations.ts](../apps/server/src/automations.ts) (`AutomationScheduler.start/tick/stop`,
  `nextIntervalOccurrence`), [postgres-automation-store.ts](../apps/server/src/postgres-automation-store.ts)
  (`submitDue`), migrations `0018_automations.sql`, `0026_automation_attachment_outcome.sql`;
  startup recovery at [run-dispatcher.ts](../apps/server/src/run-dispatcher.ts) calling
  `requeueAssignedRuns` and `failRunningRuns` in [postgres-store.ts](../apps/server/src/postgres-store.ts)
  with payload reason `server-recovery`.
- Preserve exactly: recovery does **not** replay external side effects. Missed intervals are skipped,
  and `running` work is failed rather than blindly retried. This is the correct default and S3 must
  keep it, while adding the per-effect retry policy the plan asks for.
- Acceptance: kill and restart the service before dispatch, after commit and while waiting for
  approval; completed work is retained and unknown external writes are not blindly repeated.

### C9 — Scoped long-term memory

- Evidence: [agent-knowledge.ts](../apps/server/src/agent-knowledge.ts),
  [postgres-knowledge-store.ts](../apps/server/src/postgres-knowledge-store.ts), and
  [native-agent.ts](../apps/server/src/native-agent.ts). The model receives a bounded recent snapshot
  (up to eight entries), not task-relevance retrieval.
- Preserve Owner review, provenance, scope and deletion. S5 must qualify relevant retrieval and
  demonstrate that deleting or disabling a memory prevents later use.

### C10 — Skills and teaching reuse

- Evidence: [agent-knowledge.ts](../apps/server/src/agent-knowledge.ts) (`validateKnowledgeProposal`,
  `boundedKnowledgeText`), [postgres-knowledge-store.ts](../apps/server/src/postgres-knowledge-store.ts),
  migrations `0020_reviewed_knowledge.sql`, `0015_employee_memory_lifecycle.sql`, `0011_employee_profiles.sql`
  (`employee_memories`, `employee_memory_events`, `skills`, `employee_skills`, `skill_dependencies`);
  [agent-skills.ts](../apps/server/src/agent-skills.ts); [agent-steering.ts](../apps/server/src/agent-steering.ts).
- **A reviewed `SKILL.md` is advisory text, not an executable skill.** `parseSkillDocument` admits one
  Markdown document ≤ 12 KiB with bounded YAML frontmatter, SHA-256-bound, and its own comment states
  the rule: parsing text never follows files, URLs or tool declarations. The Agent reads the text
  (`read_skill`, bounded to 8 descriptors and 2 full documents). There is no script execution, no
  skill-directory loading, and no authority granted by `allowed-tools`.
- Teaching is Owner-mediated and explicit: a successful task may *propose* one lesson; the Owner edits,
  accepts or rejects it, and a separate switch permits later model use. The Agent cannot approve itself.
- Absent: any evaluation harness for model or skill quality. [PROVIDER_CONFORMANCE.md](PROVIDER_CONFORMANCE.md)
  and `packages/provider-conformance-runner` cover provider conformance, which is a different thing.
- Preserve: Hermes Agent attribution (required by [AGENTS.md](../AGENTS.md)), provenance and scope on
  every memory and skill, deletion control, and the rule that no learning path increases authority.
- Acceptance: a correction becomes a reviewed method, measurably improves a held-out task, and can be
  revoked.

### C11 — Responsible multi-Bot collaboration

- Evidence: [agent-collaboration.ts](../apps/server/src/agent-collaboration.ts),
  [postgres-agent-collaboration.ts](../apps/server/src/postgres-agent-collaboration.ts)
  (`activeCollaborationChain`, `channelColleagues`, `createDelegatedRun`), the `start_task` /
  `wait_for_task` / `delegate_task` tools in [native-agent.ts](../apps/server/src/native-agent.ts),
  and `agent-collaboration.integration.test.ts`.
- What "independent grant" means in code: a delegated child Bot runs with **its own** profile, skills,
  memories and plugin grants, which are not inherited from the caller. Step, tool and web-call
  budgets are per Run; the root deadline is shared
  ([ASYNC_COLLABORATION.md](ASYNC_COLLABORATION.md)). Shared Task budget admission remains a
  target requirement, not an existing guarantee; see the independently checked
  [S6 baseline](research/s6-compatibility.md).
- Bounded by construction: depth ≤ 2, ≤ 4 descendants, no self/ancestor/cross-channel delegation, and
  a channel lease taken with a PostgreSQL advisory lock.
- Preserve the limit as loudly as the capability: this is *delegation*, and there is **no general
  durable-team abstraction** in either source. S6's "existing delegation preserved through durable
  execution" must not be read as a team feature that already exists.
- Acceptance: delegated browser/file work runs under a grant independent of the caller, with conflict
  and cancellation tests, and the delegation tree's authority stays in the Server/DB.

### C12 — Open tools and models

- Evidence in this checkout: MCP support in [plugin-service.ts](../apps/server/src/plugin-service.ts)
  and `plugin-routes.ts` (`install`/`grant`/`call`, per-Bot grants, `read`/`confirm` modes);
  bounded web tools in [native-web-tools.ts](../apps/server/src/native-web-tools.ts)
  (`web_search`, wired at [native-agent.ts](../apps/server/src/native-agent.ts)).
- **Model configuration here is a workspace-wide Owner singleton**, not per-Bot:
  [model-settings.ts](../apps/server/src/model-settings.ts) (`ModelSettingsService`) behind
  `GET`/`POST /api/v1/settings/model` and `POST /api/v1/settings/model/models`.
- Feature-source delta — the per-Bot path this checkout does not have:
  `PATCH /api/v1/bots/:botId/model` → `updateEmployeeModel`, which requires
  `computerProfile === "model"` and writes `bots.configuration.model`; a `model_connections` table
  (`preset_id`, `base_url`, `protocol` ∈ `openai-chat`|`anthropic-messages`, `encrypted_api_key`,
  `revision`); `runs.model_selection jsonb` constrained to exactly `{connectionId, modelId}` when
  `execution_profile = 'model'`; `model-credential-cipher.ts`; `model-provider-presets.ts`; and the
  `ModelSelector.tsx` / `ModelConnectionsDialog.tsx` UI. Both trees have bounded model web tools, but
  they are different implementations (`model-web-tools.ts` with `maximumWebCalls = 4` and
  `tavily-web-tools.ts` there, versus `native-web-tools.ts` here).
- Security consequence, stated explicitly: `model_connections.encrypted_api_key` is credential
  material. The plan's authorization boundary states that credential protection is **never** retired
  as collateral with peripheral features. Which cipher, which key path
  (`OPENBOT_MODEL_CREDENTIAL_KEY_PATH`) and whether per-Bot connections are migrated or reimplemented
  is a decision for the integrating developer, not a data copy.
- Acceptance: switching a Bot's model keeps its identity, memory and files; a revoked connector stays
  revoked across a refresh.

## Retirement candidates

Retirement here means a **capability decision with a recovery path**, never deletion. Each row names
its replacement, its data consequence and its security consequence.

| Candidate | Evidence | Replacement evidence required | Data consequence | Security consequence |
| --- | --- | --- | --- | --- |
| Swift macOS worker host | [Package.swift](../apps/worker-host-macos/Package.swift) (absent from the feature source) | Linux-first reference execution plus an explicit decision that macOS native host is not a supported path | Preserve device enrollment, configuration and credentials even without business database rows | It carries host-authority code paths. Retiring the artifact must not remove credential protection or authorization logic it shares |
| C# Windows worker host | `apps/worker-host-windows/OpenBot.WorkerHost.Windows/OpenBot.WorkerHost.Windows.csproj`; [WINDOWS_DESKTOP.md](WINDOWS_DESKTOP.md) already marks the service "separately reviewed" | Same as above | Preserve device enrollment, configuration and credential state | Same as above |
| Superseded install chains | `deploy/node/launchd/com.openbot.node.plist` and superseded native installers | Only after a qualified replacement; Linux systemd is not automatically in this retirement scope | Preserve host configuration and enrollment state | Enrollment tokens and node credentials must survive any repackaging |
| Office visualization | [packages/office-plugin/src/index.tsx](../packages/office-plugin/src/index.tsx) — manifest `status: "deferred"`, and the core Web application does not import it | None needed for this scope; it is already inert | None | None — no authority |
| Unimplemented Provider placeholders | [cua](../providers/cua/src/index.ts), [lume](../providers/lume/src/index.ts), [coder](../providers/coder/src/index.ts) declare no `execute`; [PROVIDER_CONFORMANCE.md](PROVIDER_CONFORMANCE.md) marks all three "Not implemented in this repository" | Check declared profiles, persisted configuration, consumers and CI; keep conformance boundaries explicit | None | Retiring the *placeholder* must not remove the conformance document, which is what prevents capability overclaiming |
| Replaced TypeScript backend | `apps/server/src/*` — the transitional authority per the plan | S2 single-writer cutover with the same fixtures against the selected implementation | PostgreSQL data, migrations and applied history are preserved, not moved | Authorization, approval and audit code is security-bearing; each retirement needs the effective security tests to move with it |
| Employee marketplace / distribution / graph | No marketplace or registry exists in either source. The only artifact is the signed employee package export/import in [employee-package.ts](../apps/server/src/employee-package.ts) with `employee_import_receipts`; [EMPLOYEE.md](EMPLOYEE.md) states authenticated ownership transfer is not implemented | n/a | None | Do not describe an *absent* feature as retired, and do not let "employee ecosystem" language sweep up login, approvals or credential protection |

## Data compatibility risks

1. **Different SQL at the same migration timestamps.** The feature and migration histories are
   divergent after the common 17-file prefix. Preserve historical SQL and applied records. Future
   target additions and a separately tested synthetic-data transfer/bridge are distinct work.
   [The completed source audit](MIGRATION_DATA_COMPATIBILITY.md) records both hashes and risks.
2. **`runs.model_selection`.** Per-Bot model selection adds a column plus a check constraint to a table
   the migration line already owns. Adding it is cheap; deciding whether existing runs become `NULL`
   and whether `execution_profile = 'model'` is a supported value here is not.
3. **Credential material.** `model_connections.encrypted_api_key` cannot be copied blindly between
   environments. A credential transfer must preserve the matching key and authorization semantics;
   ordinary exports and model context must exclude this material.
4. **`run_events` overlap.** The feature source writes browser audit rows into `run_events`, which the
   migration line also evolved (`0019_native_run_observations.sql`). The payload shapes must be
   compared before adopting either side.
5. **Audit limit.** The source-history audit is complete; user data, assets, credential transfer and
   backup restoration remain untested until S7's explicit synthetic fixtures.

## Evidence and baseline limits

- Per-Bot model configuration exists in the feature source and must be preserved/migrated in S6;
  the migration baseline still has a workspace-wide singleton.
- Preserve useful behavior from the one divergent feature commit on the newer baseline. Do not
  copy its older backend or overwrite either lineage's applied SQL history.
- [The 2026-09-10 inventory](testing/2026-09-10-feature-inventory.md) and
  [DELIVERY_STATUS.md](DELIVERY_STATUS.md) are historical. Office extraction, OCR/transcription and
  the 32 KiB report bound must be read from the current implementation, not the earlier inventory.
- A declared `human_takeover` status or `shell.execute` capability alone is not an implementation.
  Also distinguish the existing backend human-control veto from the missing full Owner session UI.
- The accepted Python milestone exercised an actual Python child and actual Server/PostgreSQL,
  with synthetic model/tool responses. Feature-source
  `docs/testing/2026-09-08-browser-model-tools.md` records real browser and limited Kimi journeys on
  its older base. Neither evidence establishes universal model quality or final-product acceptance.

## What this document does not claim

- No test was run. Every status above is source reading; passing tests are cited only where someone
  else's report names them and is quoted with its own scope.
- No capability is "supported" merely because code exists for it, and no capability is "retired"
  because this document names it as a candidate.
- The two trees were never combined into one supported release, and the feature commit's recorded
  results were established against an older base.
- Linux, Windows and macOS support claims are unchanged and remain exactly as narrow as
  [CROSS_PLATFORM.md](CROSS_PLATFORM.md) and [WINDOWS_DESKTOP.md](WINDOWS_DESKTOP.md) state.
