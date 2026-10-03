# C9 and C11: editing a Bot's look, and the new-Bot greeting

English · [简体中文](bot-appearance-and-greeting.zh-CN.md)

- Status: Proposed
- Date: 2026-10-03
- Owner: @yxflc11
- Related issue: backlog C9 and C11 in [IMPLEMENTATION.md](../design/desktop-ui-2026-10/IMPLEMENTATION.md)
- Acceptance journey: in a Bot's rail, 编辑头像 changes its head or colour and every avatar of that
  Bot updates at once; a quick-created Bot, when a model is configured, opens its 单聊 with one
  short greeting above the 「你最想让我先帮你做什么？」 card.
- Security boundary: both are Owner-only. Appearance carries no authority. The greeting is one
  bounded, tool-less model call whose only input is Owner-authored Bot names and role tags; any
  failure means no greeting.

## Trigger and existing decision

- Trigger: public protocol (one new command, one new Server-written message) and a model call.
- Existing decisions:
  - `PATCH /api/v1/bots/:botId/profile` updates role and biography at an expected revision, and
    deliberately excludes appearance.
  - C10 fixed the eight accents.
  - C12 creates a Bot and its 单聊 in one transaction with the Owner's default model (C7).
  - The owner decided on 2026-10-02 that the greeting is wanted: optional, one model call per new
    Bot.
- Missing: there is no command to change a stored appearance, and nothing writes a first message
  for a new Bot.
- Scope: these two contracts only; nothing about skills, permissions or model selection changes.

## Design evidence

- **BotInfo artboard, 编辑头像 popover:** 随机 and 重置, the three heads (圆顶, 耳罩, 猫耳), the
  eight colours, and 「改动立即生效，名字旁的头像同步更新」. Each choice applies immediately; there
  is no save button.
- **NewBotChat artboard:** one Bot message above the card, for example 「嗨，我刚上岗，还没有具体分工。团队里已经有研究助理、客服小橙在做竞品和工单了——你希望我负责哪一块？」.
  It names other Bots and what they do, and asks one question.

## Candidate comparison

| Gap | Candidate | Fit | Decision |
| --- | --- | --- | --- |
| C9 | Add `appearance` to the profile PATCH | That command is documented as excluding appearance and records evolution events; a look is not a capability change | Rejected |
| C9 | Separate `PATCH /api/v1/bots/:botId/appearance` with the profile revision as the concurrency token | Small, audited, no evolution noise, same lost-update protection | **Selected** |
| C11 | Client generates the greeting | The client has no model authority and would need a key | Rejected |
| C11 | The 服务电脑 writes it after quick-create, asynchronously, through the existing model path | One bounded call, reuses C7 selection and Server audit; failure is silent | **Selected** |

## Proposed contracts (for Codex)

- **C9 — `PATCH /api/v1/bots/:botId/appearance`**
  - Owner session, allowed Origin, and a strict JSON body: `{expectedRevision, appearance}`.
    `appearance` is the complete C10 shape (head, body, mobility, accessory, accent); unknown
    values and extra fields return 422.
  - `expectedRevision` is the Employee profile-details revision. A stale revision returns 409. An
    unchanged look returns 200 without a revision change.
  - On change: increment the revision, write an audit event with the old and new values (no
    evolution event), and publish the workspace SSE invalidation for this Bot, so every client's
    sidebar, title and rail update.
  - Response: `{bot, revision}`. Deleted Bots return 404.
- **C11 — the new-Bot greeting**
  - **When it runs:** only after a successful `POST /api/v1/bots/quick` (C12), and only when the
    new Bot has a usable model. Run it outside the creation transaction; creation never waits for
    it and never fails because of it.
  - **Input:** at most 12 other active Bots' names and roles, all Owner-authored, plus the new
    Bot's own name. No messages, memories, files, skills or channel content.
  - **The model call:** exactly one, with no tools and a bounded output of at most 120 characters
    of plain text, written in Chinese like the rest of the product, and ending with one question
    about the Bot's role.
  - **The message:** written as the Bot's first message in its 单聊. Markers, links and Markdown
    are stripped before writing. It uses the normal `message.created` event, and the message is
    marked as a greeting so it can be told apart, for example with `origin: "greeting"`.
  - **Failure:** missing model, refusal, timeout (15 s), over-length output or any error means no
    message and no retry. The failure is audited with a bounded reason only.
  - **No repeats:** a Bot gets at most one greeting, and never after the Owner has already sent a
    message in its 单聊.

## UI plan (Claude, after each contract lands)

- **C9:** 编辑头像 in the Bot rail, following the BotInfo artboard: 随机, 重置, the head and colour
  choices, each applied immediately with the current revision. A 409 re-reads the profile and keeps
  the rail as the 服务电脑 has it.
- **C11:** nothing new to build. The 单聊 already renders the Bot's first message above the role
  card. The UI only stops implying a greeting when there is none.

## Reuse decision

- Selected option: local contract extensions on the existing Bot, audit, SSE and model paths.
- OpenBot-specific gap: the two facts above.
- Exit plan: none needed. Neither adds a dependency.
- Failure behaviour: C9 refuses stale or invalid input without partial writes. C11 fails closed
  to no greeting.

## Source incorporation

- Source copied or substantially adapted: no.

## Verification plan

- Automated tests:
  - C9 route tests: CAS, unchanged look, invalid values, audit, the SSE invalidation, a deleted Bot.
  - C11 tests with a fake model: the bounded input, length and Markdown stripping, the timeout,
    no greeting without a model, at most one greeting.
  - Web tests for 编辑头像.
- Negative tests: wrong Origin, missing session, extra fields, model failure.
- Documentation: `docs/API.md` (en/zh) and the DESIGN screen map.
- Support level the evidence permits: Integrated, once each contract and its UI are merged.

## Unresolved questions

- None.

## C9 implementation (2026-10-03)

Owner approved the contract on 2026-10-03. C9 reuses `OwnerTransactions`, the profile row lock and
revision, strict C10 `BotAppearance`, and the current Python workspace poll stream. The only new
fact is the cosmetic PATCH: old/new values are audited atomically; evolution is unchanged. A
no-op leaves revision/audit unchanged. Reconnect retains the existing `workspace.ready` recovery.
Reviewed primary semantics: [RFC 9110 §15.5.10](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.10)
(conflict with current state). No dependency or source incorporation; the approved body revision
contract is retained rather than introducing an ETag protocol.

## C11 implementation checkpoint (2026-10-03)

Owner approved the contract on 2026-10-03. The implementation reuses the existing C7/C12 default
selection, encrypted model resolver and bounded model port reviewed in
[work-model-ports](work-model-ports.md): Pydantic AI 2.47.0, OpenAI 3.17.0 and Anthropic 1.8.0
under their existing licenses and pins. Installed SDK source confirms tools can be empty and
existing transport disables SDK retries. No new dependency or upstream source copy.

For the persistence gap, an audit join on every message read would add projection and paging cost.
A nullable `messages.origin` column instead preserves all historical messages and exposes the
optional tag through normal reads and C18 pages. PostgreSQL 17 partial unique indexes bound the
persisted attempt and greeting to one per Bot, following the
[official partial-index contract](https://www.postgresql.org/docs/17/indexes-partial.html).
The existing audit table retains the attempt after failure, cancellation, restart or deletion of the
message; this is not a retry queue or another ledger. Migration 0052 is additive and journaled.

Generation runs after the quick-create transaction, using one tool-less SDK call and only the
approved roster input. The model phase has a 15-second deadline; SQL retains its own existing
transaction, statement and lock bounds. The same channel-before-Bot lock order as Owner sends
protects first-message insertion. Owner session, model revision and channel/Bot lifetime are
rechecked. A prior Owner send remains disqualifying even if its message is later deleted, because
its normal audit remains. Invalid/refused output never writes a message. Failure reasons are fixed
local categories; a database outage can prevent auditing and does not authorize another write path.
Shutdown cancels and joins outstanding jobs. No paid model or production database is used in tests.

Backend qualification uses real disposable PostgreSQL and the pinned SDK with a synthetic HTTP
transport, including actual 15-second timeout and channel SSE. Renderer integration remains Claude's
separate acceptance scope; no live-provider or cross-platform support claim is added.

C11 adds the 53rd canonical migration, so the existing product preflight/smoke count and synthetic
paired-restore target explicitly advance from 52 to 53. No applied SQL or sealed source history
changes. The current [40-case restore evidence](../../experiments/s7-migration/evidence/bot-greeting-result.json)
preserves old messages and references; 20 delivery/cleanup checks pass. Product delivery count
checks now compare both consumers with the verified target to catch stale qualification during
`npm run check`. The initial hosted container/restore failures were stale 52-entry guards, not
failures of the new SQL; this checkpoint records their correction, rather than claiming those
failed hosted runs passed.
