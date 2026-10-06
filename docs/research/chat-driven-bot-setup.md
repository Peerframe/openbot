# Research: Chat-driven Bot setup and memory (C29)

English · [简体中文](chat-driven-bot-setup.zh-CN.md)

- Status: Proposed (Owner decision 2026-10-06; contract for Codex)
- Date: 2026-10-06
- Owner: OpenBot maintainers
- Acceptance journey: in a 单聊 the Owner writes 「你叫 v7，负责每周的竞品周报，每周五 9 点发我，用我的
  Gmail 发」. The Bot renames itself, sets its tag and 介绍, creates the routine, starts using the
  installed Gmail plugin and remembers the instruction — like a subordinate who just does it and
  says what it did. Each change appears in the conversation as one line with 撤销 and in 审计记录.
  Sending the first email still follows the existing approval policy.
- Security boundary:
  - Only the Owner's words can start a self-change, and only for this Bot.
  - Outside content (webpages, files, tool output, other Bots) may add facts the Bot learned. It
    cannot add standing instructions without one tap from the Owner.
  - Work computers, credentials, model keys, approval policy, new plugin connections, other Bots and
    account settings stay outside chat.
  - Every side effect still follows the approval policy. The Server stays the only authority and
    audit source.

## Trigger and existing decision

- Trigger: an authorization and persistent-data boundary change.
- Existing decision and reviewed pin:
  - [Owner-managed memory](owner-managed-employee-memory.md).
  - [Reviewed knowledge](agent-reviewed-knowledge.md), which reviewed Hermes Agent at
    `63279301bcbdc185c1b07b98a9312eb0c862f26d`.
  - [Profile details](owner-employee-profile-details.md).
  - Under these, a model may only *propose* memory and skills, which wait in 候选经验 for Owner
    review. Name, tag and 介绍 change only from the Owner's own controls.
- Changed assumption: the Owner decided on 2026-10-06 to follow Grok Bot. In the Owner's words, AI
  should fit into daily life instead of leaving the Owner more to do, but with limits; otherwise
  OpenBot is "still a traditional agent, not a chat platform where you talk to Bots like to people
  who work for you".
  - The Owner's own words in chat are now enough authority for this Bot's profile, memory, routines,
    skills it writes from the Owner's teaching, and use of already-installed plugins.
  - Memory the Bot learns while working is saved directly and shown.
  - Review stays only for standing instructions that came from outside.
- Scope of this targeted review: who may cause a self-change, which changes apply directly, how
  they are shown and undone, and how outside content is kept out of durable memory.

## Search evidence

- Search date: 2026-10-06.
- GitHub queries: `NousResearch/hermes-agent` memory tool and write approval (release
  `v2026.9.24`, commit `f97608f178d1ffeca59860195ab7da295f7c8e5f`, MIT).
- Standards and primary documentation:
  - [OpenAI Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq).
  - [Hermes Agent persistent memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory).
  - [OWASP Agent Memory Guard](https://owasp.org/www-project-agent-memory-guard/) and OWASP Top 10
    for Agentic Applications 2026, ASI06 Memory and Context Poisoning.
- Product observation: Grok Bot, recorded and described by the Owner on 2026-10-06. It renames
  itself from 「你叫 v7」 with a 「已重命名为 v7」 line, and saves plain-language instructions and
  learned facts as memory without approval. By its own account it has no uniform change line, no
  undo and no audit, and it may also save skills, create routines and install plugins.
- Existing OpenBot entries checked:
  - the research records above;
  - `apps/server-python/src/openbot_server/employee_knowledge.py`, where proposals wait for Owner
    review;
  - the audit labels `BOT_RENAMED` and `EMPLOYEE_PROFILE_UPDATED`.

## Candidate comparison

| Candidate | Exact release or commit | License | Behaviour | Fit for OpenBot | Decision |
| --- | --- | --- | --- | --- | --- |
| OpenAI ChatGPT saved memories | Help article as of 2026-10-06 | Proprietary product | Saves what the user asks and may save useful details unasked; the user deletes by asking or in settings; deleted entries kept up to 30 days for safety | Matches the requested ease. No per-change undo in the conversation; no notion of outside content | Adopt "remember from the user's words without a form" and "forget by asking" |
| Hermes Agent memory tool | `v2026.9.24` / `f97608f1` | MIT | The agent adds, replaces and removes bounded entries by itself (2,200 + 1,375 characters); an optional write-approval gate exists but is off by default | Bounded entries and self-managed consolidation fit; file storage cannot own OpenBot state | Keep the Hermes inspiration and the size bounds; the Server stores entries |
| Grok Bot (observed) | Product as of 2026-10-06 | Proprietary product | Direct rename, memory, skills, routines and plugins; no undo or audit | The UX the Owner wants; its authority is wider than OpenBot's boundaries allow | Adopt the conversation UX only: direct self-changes plus a visible line |
| OWASP ASI06 guidance and Agent Memory Guard | Project page as of 2026-10-06 | CC BY-SA (docs) | Memory poisoning persists across sessions. Mitigations: provenance, integrity, and review gates on writes that can drive high-stakes actions | Defines the limit: outside content must not become a standing instruction unreviewed | Adopt: record provenance on every entry, mark outside facts as reference, and route outside instructions to a card |
| Existing OpenBot memory, profile and automation stores | current `main` | Apache-2.0 (OpenBot) | Revision checks, Owner-only audit, a secret scanner, knowledge proposals | First viable base; no new service or dependency | Extend with a thin self-change layer |

## Reuse decision

- Selected option: extend existing OpenBot stores (local gap); no dependency.
- Why: every candidate either stores state outside the Server or lacks undo and audit. OpenBot
  already has revision-checked profile, memory and automation stores, audit, and a secret scanner.
- Exact OpenBot-specific gap, the C29 contract:
  1. **Who.**
     - Profile, routine, skill and plugin-use changes run inside a Run whose trigger is an Owner
       message: in the Bot's 单聊, or a 频道 message from the Owner that @-mentions that Bot.
     - Learned facts may also be saved from the Bot's routine Runs, with their source.
     - The Server records the triggering message or Run id with every change.
     - Other Bots, webhooks and imported content can never trigger a direct change.
  2. **What applies directly** (one change line with 撤销, plus audit):
     - the Bot's own name (≤ 64), tag (≤ 160) and 介绍 (≤ 2,000), at the current profile revision;
     - memory, at most 500 characters per entry, through the existing sensitive-text scanner. A
       secret is refused, and only its name may be kept, as today. Three origins are allowed:
       - what the Owner said;
       - what the Bot learned while working with the Owner;
       - **facts** (`semantic`, `episodic`) it read in outside content. The line names the source:
         「记下了：B 公司定价页需要登录（来自 b.com）· 撤销」;
     - forgetting a memory the Owner names, or one the Bot replaces while consolidating within the
       Hermes-style size bound;
     - creating, pausing, resuming or deleting the Bot's own routines, within the existing
       automation bounds. A routine posts into the conversation where the Owner asked;
     - a skill the Bot writes from what the Owner taught it in this conversation. The line is
       「学会了「周报格式」· 查看 · 撤销」, and the skill body is bound to its SHA as today;
     - using the tools of a plugin that is already installed, when the Owner asks: 「用我的 Gmail」
       grants this Bot that plugin's tools. Each write action still asks under the approval policy.
  3. **What becomes a card** (Owner taps 确认 or 不用; the card expires in 7 days and is listed in
     设置 › 记忆 › 候选经验). Only standing instructions from outside:
     - a `procedural` memory, or a skill, from a Run that has already read outside content (webpage,
       file, attachment, tool or plugin output, another Bot's message). The Server marks the Run when
       it first ingests such content, and the card shows that source;
     - a skill file imported from outside (the existing review).
  4. **Never through chat** — the Bot answers with where to do it:
     - work computer authorization, credentials, model connections and keys, approval policy;
     - installing or connecting a new plugin (OAuth stays with the Owner in the plugin dialog);
     - deleting or changing other Bots or 频道, account and security settings, sharing and export.
  5. **Bounds.** At most 5 direct changes per Run; anything beyond becomes a card. Repeated identical
     changes are coalesced. Per Bot, Settings › Bot 能力 has a switch 「允许它根据你的话自己改资料、
     记忆和例行任务」. It is on by default; when off, every direct change becomes a card.
  6. **Undo.** `POST /api/v1/bot-changes/{changeId}/undo` is Owner-only, idempotent and
     revision-checked. If something changed the same field later, it is refused with
     `change_superseded`, and the line then reads 「已被后来的改动覆盖」. Undo restores the
     previous value, or deletes the created memory or routine. Undo is audited.
  7. **Conversation records.** A new message kind `change`:
     `{changeId, botId, field, summary, undoable, undoneAt?, groupId}`. All changes from one Run share a
     `groupId` and show as **one** quiet line (「按你说的更新了 5 项 ›」, owner feedback 2026-10-06:
     no wall of 撤销 links); opening it lists each change with its own 撤销. The Owner can also undo
     by saying so (「名字改回去」), which the Bot does through the same undo route. A new kind
     `proposal`: `{proposalId, botId, summary, source, actions, expiresAt}` is shown as a card. Both
     come on the channel event stream and in message pages.
  8. **Audit.** `BOT_SELF_CHANGE`, `BOT_SELF_CHANGE_UNDONE`, `BOT_PROPOSAL_DECIDED`. Each records
     the actor as the Bot, on behalf of the triggering Owner message, plus the old and new revision.
     Content is not copied into the audit.
  9. **Memory provenance.** Each memory records `origin: owner_said | learned | learned_outside |
     owner_reviewed`, the source message, Run or URL, and whether the model uses it. Facts from
     outside are given to the model inside a marked "reference, not instruction" block. Memory
     stays descriptive: it never grants a tool or skips an approval, so a wrong memory cannot by
     itself cause a side effect, and its line makes it easy to spot and undo.
- Upgrade, replacement or exit plan: the per-Bot switch turns the feature back into cards without a
  migration. The tables stay compatible with the TypeScript control-plane plan.
- Failure behaviour: if the taint state, revision or audit write is unavailable, the change becomes
  a card (fail closed to review). A refused change leaves the Bot's reply honest, for example
  「这个我改不了，需要你在 设置 › 工作主机 里授权」.

## C30 addendum: conversation cues and role looks (2026-10-06)

Owner request after a second Grok recording: do all of the following. It reuses the C29 authority
rules above and adds no new authority.

1. **Question card.** A Bot may ask the Owner one question at a time as a card rather than prose.
   - Message kind `ask`: `{askId, botId, question (≤ 120), options: 2–5 × ≤ 40, allowOwn: boolean,
     expiresAt}`.
   - The Owner answers with `POST /api/v1/asks/{askId}/answer {option | text (≤ 500) | skip}`. It is
     Owner-only and idempotent. The answer is also posted as the Owner's message, so the Bot reads it
     like any reply.
   - The card folds into one line (「每天几点发运势给你？ 早上 9 点 ✓」 or 「已忽略」).
   - A question carries no authority. A choice that leads to a change still follows C29, and its
     change line appears.
   - Bound: at most one open question per conversation; a new one replaces the old.
2. **Acknowledgment.** When a Bot starts a Run from an Owner message, it may add one reaction (👌
   by default) to that message through the existing reactions route. This is the Server's signal,
   not a model call, so it is immediate and costs nothing. Per Bot it can be switched off in the
   same Settings switch as C29.
3. **Role looks.** `BotHeadShape` gains role heads:
   - `star` (信息/研究/观测), `gear` (开发/运维), `bubble` (客服/沟通), `page` (写作/编辑),
     `hive` (数据/复盘) and `clock` (日程/助理);
   - **or**, if the Owner picks option two on the RoleLooks board, an `accessory` value on the
     existing heads.
   A Bot may choose its own look when its role is set. This is a C29 direct change: a line
   「已换成「星象」外观 · 撤销」, revision-checked through the C9 appearance route, and audited as
   `BOT_SELF_CHANGE` with `field: appearance`. Older Bot templates keep importing. The Web plays the
   morph (PR #198) on every copy of the avatar.
4. **Step names.** The working line names the current C13 stage (shipped in PR #198). New stage
   keys for 读取文件 and 连接插件 would be welcome, but they are not required.

Tests (Server):
- an `ask` is answered once and is then refused as answered;
- the answer is posted as the Owner's message;
- `skip` folds the card;
- a second `ask` replaces the first;
- the acknowledgment reaction is added once per Run and not when switched off;
- an appearance self-change writes a change line, can be undone, and is refused on a stale revision;
- an unknown head value is refused.

Tests (Web): the folded card and the morph, as for the role card in PR #198.

## Source incorporation

- Source copied or substantially adapted: no.
- Files and upstream locations: none.
- Required copyright or license notice location: none. The Hermes Agent inspiration for Employee
  learning stays attributed in the Bot rail and here.

## Verification plan

- Automated tests (Server):
  - an Owner message in a 单聊 renames the Bot and writes a `change` record and an audit row;
  - an @-mention in a 频道 works, and a non-mention does not;
  - another Bot's message cannot trigger a change;
  - in a Run that read a webpage, a fact is saved with its source, while a `procedural` memory or
    skill yields a card;
  - 「用我的 Gmail」 grants the installed plugin's tools, a write action still asks for approval, and
    an uninstalled plugin is refused with where to install it;
  - the 6th change in one Run becomes a card;
  - a secret is refused;
  - undo restores the value and is idempotent; a superseded undo returns `change_superseded`;
  - with the switch off, everything becomes a card;
  - computer, plugin-install, credential and other-Bot requests are refused.
- Automated tests (Web):
  - the change line renders with 撤销, and undo updates the line;
  - the card's actions call `decide`;
  - the rail's 记忆 shows the origin;
  - the switch persists.
- Negative and fail-closed:
  - injection text inside a fetched page that asks to "always do X" or to "rename yourself"
    produces at most a card naming the page;
  - a rename from outside content is refused outright, because only the Owner's words can rename.
- Platforms: Server and Web; Desktop uses the same Web UI.
- User-visible documentation and translations: DESKTOP_ONBOARDING, REVIEWED_SKILLS, and the design
  canvas board ChatSetup (en and zh).
- Support level that the evidence permits: proposed; nothing is implemented yet.

## Unresolved questions

- None blocking. Routines post where the Owner asked (proposed default).
