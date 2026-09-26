# Desktop alpha.4 feature inventory and product alignment

[English](2026-09-10-feature-inventory.md) · [简体中文](2026-09-10-feature-inventory.zh-CN.md)

## Scope and overall finding

This source inventory covers share-fix baseline `8f6520e` and the Desktop alpha.4 [core upgrade](../CORE_UPGRADE.md). It is not an end-to-end acceptance report for every feature, a live model-output evaluation, or certification of every operating system. “Connected” means a UI operation calls an implemented API or Desktop bridge; credentials, provider availability, packaging, and worker authorization still determine whether a particular installation can execute it.

OpenBot currently provides persistent employees and conversations, a bounded model Agent, public-source research, Markdown outputs, reviewed skills and memory, recurring tasks, channel Bot delegation, persistent attachments and reviewed MCP tools. This substantially supports the identity and continuity direction in [Product definition](../PRODUCT.md). General computer operation, unrestricted asynchronous multi-Bot collaboration, public plugin distribution, and authenticated ownership transfer remain separate gaps.

A **Bot** is an employee; a **Channel** is a persistent working context; a **Run** is one task; a **Node** is an authorized execution computer. Server remains authoritative for identity, routing, approvals, and records. A skill describes a method and cannot grant tools or permissions.

## Installation, navigation, and conversations

| Component | Implemented behavior | Limit or difference from the intended product |
| --- | --- | --- |
| First-run setup | Select a local service computer or connect to an existing service. Installation has progress/retry; connection setup saves a Server address. | Available roles depend on packaged adapters. Exiting a Host Desktop stops its local service; this is not an always-running system service. |
| Login/session | Owner login, session validation, reconnect, and logout. | Not multi-user organization or role administration. |
| Top toolbar | Toggle side panels, navigate backward/forward, inspect channel members, open workers and sharing. | Application navigation; no additional task authority is granted. |
| Sidebar/search | Filter channel names/descriptions and Bot names, create objects, open plugins/settings. | Not message-body or all-file search. No channel rename/delete/archive or Bot-removal UI was found. |
| Bot entry | Single-click opens a persistent direct conversation; right-click or Shift+F10 opens the employee profile. | The product’s “click Bot for profile” description is broader than this implementation: conversation is the primary click action. |
| Channel/membership | Create name and work-goal description, select initial Bots, add existing Bots from the member menu. | Task agents can discover and delegate to native channel colleagues. Membership alone does not trigger conversation; no removal UI was found. |
| Bot creation | Save name, role, fixed execution profile, and previewed head/body/mobility/accessory/accent combination. | Default is no computer. Docker/Cua/Lume/Coder choices do not prove runtime readiness. Appearance is identity, not a permission level. |
| Composer/replies | @Bot picker selects one recipient; direct conversations already identify it. Quote a reply, send text, continue drafting during submission, return to latest messages. | The initial task targets one Bot, which can delegate bounded work to colleagues and synthesize their results. |
| Attachments | Persistent text/code (256 KiB), PNG/JPEG (5 MiB), PDF (10 MiB); eight files/20 MiB per task with short references. | Text is paged. Binary input needs a compatible OpenAI/Anthropic model. Word/Excel extraction, OCR and transcription are not implemented. |
| Skill selection | Request up to two reviewed skills belonging to the selected Bot; remove draft selections. | Runtime rechecks assignment, state, and content identity. A request cannot create tools or external authority. |
| Timeline/live updates | Persisted messages, quoted replies, Markdown/tables, artifacts, task links, and Server event updates. | Continuity exists; unrestricted history search and offline editing do not. |

Evidence: [setup](../../apps/web/src/components/DesktopSetupScreen.tsx), [installation](../../apps/web/src/components/DesktopInstallScreen.tsx), [connection](../../apps/web/src/components/DesktopConnectionScreen.tsx), [app navigation](../../apps/web/src/App.tsx), [sidebar](../../apps/web/src/components/Sidebar.tsx), [channel creation](../../apps/web/src/components/CreateChannelDialog.tsx), [members](../../apps/web/src/components/ChannelMembersMenu.tsx), [Bot creation](../../apps/web/src/components/CreateBotDialog.tsx), [conversation](../../apps/web/src/components/ChannelWorkspace.tsx), [attachment composition](../../apps/web/src/composer-context.ts), [Server routes](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/app.ts).

## Agent execution, results, and oversight

A configured workspace model with Native Agent enabled can execute new no-computer tasks in a model/tool loop. The tools read bounded current-channel messages and task states, public HTTPS text without login/cookies, reviewed skills, and explicitly model-enabled memory. Search is available when its service adapter is configured. Tasks can prepare a memory proposal and Markdown reports.

This is not an interactive logged-in browser. Public fetch rejects private networks and redirects. The reviewed Native Agent has no general shell, arbitrary desktop input, external-message sending, or arbitrary settings-mutation tool. Role descriptions and provider labels cannot supply missing capabilities.

| Component | Actual behavior | Limit |
| --- | --- | --- |
| Active task strip | Bot/state/latest structured stage, task-details entry. | Observable progress, not private chain of thought. |
| Task inspector | Instruction, assigned Bot/Node, progress, available frame, artifacts, failure information. | This version has no interactive employee-browser UI or generic takeover control. A frame is not a controllable desktop. |
| Stop/re-submit | Stop queued/running Native tasks and active descendants; create a new task from failed/cancelled instructions. | Applies to no-node Native tasks. Re-submit starts over and retains the previous record, not checkpoint recovery. |
| Reports/artifacts | Up to two Markdown reports per Native task, each bounded to 24 KiB, published after successful completion. PNG viewing and native Desktop report saving exist. | Not arbitrary DOCX/XLSX/PPTX generation. Actual quality and evidence completeness need review. |
| Approvals | Show risk, target, summary, validity and persist approve/reject through Server. | Action labels do not establish a working execution adapter. Built-in tools do not send email or submit forms; granted MCP tools can perform declared external operations after required confirmation. |
| Information panel | Current-channel approvals, active tasks, recent results; expandable workspace/worker overview. | Limited to loaded records, not unlimited analytics history. |
| Token usage | Sum known input/output usage in scope; preserve unknown/no-data states. | Not provider quota, balance, cost, or billing; missing usage is not estimated. |

Evidence: [Agent tools](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/native-agent.ts), [runtime wiring](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/index.ts), [bounded context](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/postgres-agent-store.ts), [inspector](../../apps/web/src/components/RunInspector.tsx), [controls](../../apps/web/src/components/NativeRunControls.tsx), [artifacts](../../apps/web/src/components/ArtifactCard.tsx), [approvals](../../apps/web/src/components/ApprovalCard.tsx), [information panel](../../apps/web/src/components/ContextRail.tsx).

## Employee profile and reviewed learning

| Profile section | Implemented behavior | Remaining boundary |
| --- | --- | --- |
| Overview | Role/description, task/completion/failure/verified-skill counts, recent evolution, skills, work. | Counts are records, not intelligence scores or authority. |
| Evolution archive | Filter dated events by type/time cutoff; inspect provenance and evidence references. | Traceable change ledger, not unattended autonomous skill acquisition. The learning/evolution direction is explicitly inspired by Hermes Agent. |
| Skills | Inspect version, provenance, imported full instructions, dependencies, capability requirements and evidence; review, suspend/revoke; import immutable versions. | Review list rather than full graph canvas. Reviewed instructions can actually be read by the Agent, but cannot add tools. |
| Live | Active records and structured decision summaries. | No private reasoning, separate remote-control UI, or complete approval console in this tab. |
| Memory | Owner add/edit/delete, types/sensitivity/future portability, lifecycle events, per-memory explicit permission for model use. | Runtime can read this Bot’s permitted memory. No general search/retention-period editor or unreviewed automatic writes. |
| Work records | Task dates, titles, state, result/error and related approval/artifact/decision counts. | Not a complete searchable audit explorer. |
| Configuration | Edit role/description with revision protection, inspect execution/package boundaries. | No per-Bot model selector, host-binding editor, policy editor or full migration administration. Models are workspace-wide. |

The learning loop is partially real: a successful task may propose one reusable lesson. The Owner can edit its title/body, accept it as internal non-portable memory, or reject and delete the candidate. A separate checkbox permits later model use. Before review, it is neither active memory nor available to later tasks; the Agent cannot approve itself. This is reviewed learning, not observation of a user’s computer followed by automatic learning.

Evidence: [profile/memory](../../apps/web/src/components/EmployeeProfileView.tsx), [evolution](../../apps/web/src/components/EmployeeEvolutionArchive.tsx), [skills](../../apps/web/src/components/EmployeeSkillReview.tsx), [candidate experience](../../apps/web/src/components/KnowledgeReviewPanel.tsx), [runtime skill/memory tools](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/native-agent.ts).

## Plugins and portable employees

The **Plugins** destination has Skills and Bots tabs for the current workspace: search, skill-state filters, a target Bot for import, profile links, and Bot creation/import. It explicitly says the external skill store is not connected. MCP tool management now adds reviewed endpoint installation, enable/disable/remove, per-Bot grants and channel call approval. Marketplace, OAuth, stdio and resources/prompts remain unsupported; see the [author manual](../PLUGINS.md).

SKILL.md import accepts one Markdown document up to 12 KiB plus a version. It becomes a candidate requiring full-text review before use. Only single-file instructions with existing tools are supported, not attached resources, scripts, or arbitrary file access. Employee export does not contain this imported skill body.

Employee export previews included/excluded data, blocking reasons and signature state before a review-bound JSON download. Import validates structure, integrity, applicable signatures and compatibility before separate Owner activation creates a new local identity. Imported skills start disabled. Credentials, host authority, private memory and work history do not travel. This is not authenticated ownership transfer or a complete replica of everything the original employee knows.

Evidence: [plugin destination](../../apps/web/src/components/SkillLibraryScreen.tsx), [skill import](../../apps/web/src/components/EmployeeSkillImport.tsx), [employee export](../../apps/web/src/components/ExportEmployeeDialog.tsx), [employee import](../../apps/web/src/components/ImportEmployeeDialog.tsx), [employee model](../EMPLOYEE.md).

## Schedules, workers, and settings

| Component | Connected behavior | Limit |
| --- | --- | --- |
| Recurring tasks | Create name/channel/member Bot/instruction/future first run and 1-hour, 24-hour or 7-day interval; list/search, last/next execution, pause/resume/delete. Server CRUD and scheduling exist. | Elapsed-time intervals, not full calendar/cron editing. No existing-task instruction/schedule editor. Pause does not cancel submitted tasks. Service must run; a remote client may close. |
| Worker manager | Inspect registered/online/revoked hosts, issue one-time pairing credentials, revoke identity. | Registration or profile selection is not proof of arbitrary-task provider readiness. |
| Local Worker | Desktop binding, enablement, system-settings entry and status/permission refresh. | Depends on packaging and OS authorization, not certification of native control on every platform. |
| General settings | Sidebar translucency where supported, panel toggles, density/font, reduced motion, send shortcut, clock format. | Saved to this device; platform and accessibility preferences affect material behavior. |
| Model settings | Workspace-wide provider, supported API address/region, model ID, encrypted key, model discovery where supported, Native Agent switch. | Not multiple concurrent named connections or per-Bot overrides. Some providers only validate format until a real task calls them. |
| Computer settings | Change local role/client service address; enter worker management. | Host connection is local; closing Host Desktop stops service. |
| Privacy/data | Explain storage/credentials/authority/usage; reset local UI defaults. | Not backup/restore, business-data reset, account deletion or bulk export. |
| About/help/feedback | Platform/Electron and Hermes attribution; GitHub documentation/issues links. | No automatic feedback sending or update-check workflow. |
| Mobile navigation | Responsive channel/Bot/approval/host entry points. | Source presence is not mobile or all-platform acceptance. |

Evidence: [automations](../../apps/web/src/components/AutomationsScreen.tsx), [destination API](../../apps/web/src/destination-api.ts), [Server](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/app.ts), [workers](../../apps/web/src/components/NodeManagerDialog.tsx), [local worker](../../apps/web/src/components/DesktopLocalWorkerScreen.tsx), [settings](../../apps/web/src/components/DesktopSettingsScreen.tsx), [model settings](../../apps/web/src/components/ModelSettingsScreen.tsx), [preferences](../../apps/web/src/workspace-preferences.ts), [mobile](../../apps/web/src/components/MobileNavigation.tsx).

## Sharing changes in this delivery

The toolbar share entry shows only the icon while retaining an accessible name and tooltip. The dialog lists **recent output files for the current channel** with download actions; Markdown files can be previewed and copied. These are files of currently loaded tasks, taken from the workspace projection. There is no separate pagination for full artifact history; this is not an unlimited file archive.

**Sharing a template means sharing the Bot itself.** Select a current-channel Bot and open the existing employee export preview. The user can inspect the actual included/excluded content and then download its employee template for import into another OpenBot. This reuses the Server-owned review/export flow. It does not ask the model to summarize task methods or export the conversation as a template.

The recipient receives the bounded employee definition and allowed metadata, not credentials, permissions, private memories, historical conversations, every learned instruction body, or ownership of the original identity. In particular, imported SKILL.md bodies are not included in the current employee package. This limitation matters when expecting another person to receive an identical fully trained Bot.

| Object | Purpose | Distinction |
| --- | --- | --- |
| Output file | Download the actual artifact produced by a task. | Not the employee identity or a transcript. |
| Bot/employee template | Review and export the selected Bot using the portable employee package. | Not a task-method summary, complete clone, permission transfer or authenticated ownership transfer. |

Evidence: [sharing dialog](../../apps/web/src/components/ShareConversationDialog.tsx), [downloads](../../apps/web/src/components/ArtifactCard.tsx), [toolbar/export routing](../../apps/web/src/App.tsx), [export preview](../../apps/web/src/components/ExportEmployeeDialog.tsx), [package rules](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/employee-package.ts).

## Product alignment

The strongest match is the persistent employee/channel foundation: identity survives tasks, Server retains conversations and outputs, changes have evidence, reviewed skills and memory can inform future work, and repeated work can be scheduled. The reviewed learning loop is meaningful progress toward the Hermes-inspired direction.

Real Bot delegation and MCP tools are now implemented. Remaining gaps include unrestricted asynchronous collaboration, general browser/native-computer execution and exclusive human takeover, always-on local service lifecycle, public plugin distribution, full employee cloning/ownership transfer, and broader output formats. The [product north-star scenarios](../PRODUCT.md)—automatic form completion on replaceable nodes, context-bound approval followed by the exact side effect, and cross-platform native software operation—still require their own execution and conformance evidence. A selector, approval card, screenshot or schema alone is not that evidence.
