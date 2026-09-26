# 迁移能力对账（S1）

[English](MIGRATION_CAPABILITIES.md) · [简体中文](MIGRATION_CAPABILITIES.zh-CN.md)

状态：源码清单，2026-09-23（S1）。本文记录的是**关于两棵既有源码树的证据**。它不是协议、不是接口决策，
也不是实施授权，不取代[分段交付计划](ARCHITECTURE_MIGRATION_PLAN.zh-CN.md)中的任何内容。

**本文没有运行任何测试。** 每一行都来自阅读已提交源码。若某条结论来自他人运行的报告，该报告会被具名引用，
并保持该报告自身声明的范围，不做放大。

## 比对的两棵源码

| 角色 | 引用 | 位置 | 访问方式 |
| --- | --- | --- | --- |
| 迁移源码 | `codex/architecture-migration` @ `c33e03f1a14de739196113769c59fdaace9029e7` | 本检出 | 工作区 |
| 功能源码 | `feat/cross-platform-employees` @ `9cc73c9e78451e572f57d142d6b9caf62ccb78e2` | 独立功能源码检出 | 仅已提交源码（`git show`/`ls-tree`/`grep`） |

读取功能源码时未做任何写入、检出、清理、合并或安装，也未打开 `.env`、`data/`、`backups/`、`output/`
或任何未跟踪的运行内容。

### 证据列的读法

- **超链接**表示该路径存在于本检出的 `c33e03f`。
- `代码体`表示该路径**仅**存在于功能源码 `9cc73c9e`，或仅为完整起见而提及。这些刻意不做成链接：
  它们不是本检出包含的文件，读者不得假定其可访问。

## 两棵源码不可相加

这是决定其余所有行的结论。

```
公开 main              ebce9950b2bde2c44d88d1d3d1902b9e27ba9eb8
分叉点（merge-base）    5fdd99ced126509e702fc4ad00314bf06f3d50c3
main 独有提交数          338
功能分支独有提交数        1        （9cc73c9 "feat: add employee browser and shared model web tools"）
```

`feat/cross-platform-employees` 是**一个提交，建立在一个落后公开 main 338 个提交的基线之上**。
它不是"main 加功能"，而是"陈旧基线加一个功能提交"。把两棵树的能力相加，描述的是一个从未存在过的版本；
而该功能提交自己的实测报告，其记录的运行环境正是那个更旧的基线。

同一个提交就是全部差异面：100 个文件，其中承载能力的部分是员工浏览器栈与模型连接/Web 工具栈。

### 数据库历史在 `0017` 分叉

两边都有 `meta/_journal.json`。`0000`–`0016` 共 17 个 SQL 文件逐字节相同；
索引 17、18 使用相同时间戳，却分别执行不同 SQL：功能线是 `model_chat` / `model_services`，
迁移线是 `request_throttle_buckets` / `automations`。这是已应用历史不兼容，不只是文件编号冲突。
两条历史保持不动；给目标新增迁移不能直接升级已按功能线建库的数据。
见[独立 SQL 血缘审计及后续桥接要求](MIGRATION_DATA_COMPATIBILITY.zh-CN.md)与
[机器可读哈希](migration-lineage-baseline.json)。本次没有读取用户数据库。

## 十二类目标能力

编号直接对应[阶段计划](ARCHITECTURE_MIGRATION_PLAN.zh-CN.md)的十二项。
“已有有界实现”表示当前代码存在，仍需相应阶段的完整验收；“部分”表示目标中的重要行为尚缺失。
此表描述固定源码基线，不是最终产品已完成或本次新测试通过的声明。

| ID | 能力 | 迁移线状态 | 功能线差异 | 阶段 |
| --- | --- | --- | --- | --- |
| C1 | 持久 Bot 身份 | 已有有界实现 | 共享直到 `0016` 的模式 | S1、S2、S7 |
| C2 | 私聊与频道 | 已有有界实现 | 有旧频道/消息，当前私聊是主线新增 | S2、S7 |
| C3 | 多步骤执行 | 已有有界实现 | 旧基线上的另一套模型循环 | S2、S3、S4 |
| C4 | 持久工作环境 | 部分 | 按 Bot 的浏览器 profile 持久化 | S3、S4 |
| C5 | 浏览器与工具 | 部分 | 有人工会话控制，仍无通用自主多步输入 | S4、S6 |
| C6 | 文件与代码交付 | 部分 | 未增加完整文档/代码输出 | S2、S4 |
| C7 | 审批与人工接管 | 部分：已有审批和后端人工控制否决，缺 Owner 会话界面 | 共享 `0008` Worker 审批，另有 Owner 浏览器会话 | S2、S3、S4 |
| C8 | 后台、定时与安全恢复 | 部分：已有定时，中断任务标失败，不会续跑 | 旧基线没有后来的定时实现 | S2、S3、S7 |
| C9 | 有范围的长期记忆 | 部分：已审核的近期有界快照 | 共享记忆表，没有后来的审核知识实现 | S5 |
| C10 | 技能与教学复用 | 部分：已审核单文件说明 | 共享技能表，没有教学/评测闭环 | S5 |
| C11 | 有负责人的多 Bot 协作 | 已有有界实现 | 功能线没有当前委派实现 | S6 |
| C12 | 开放工具、执行后端与模型 | 部分 | 按 Bot 模型绑定和连接需要保留迁移 | S6 |

### C1 —— 持久 Bot 身份

- 证据：[schema.ts](../packages/db/src/schema.ts)（`bots`）、`packages/db/migrations/0000_foundation.sql`、
  `0011_employee_profiles.sql`、`0016_employee_profile_details.sql`、
  [postgres-store.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/postgres-store.ts)、
  [app.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/app.ts) 中的 `POST /api/v1/bots`。
- 必须保留：Bot 身份及其配置（`bots.configuration`）、演化档案、员工包/导入回执表。
  身份必须比任何运行时替换更长寿。
- 验收旅程：创建 Bot，重启 Server，确认同一身份、档案与历史仍在。这是
  [EMPLOYEE.md](EMPLOYEE.md) 中的身份部分。

### C2 —— 私聊与频道

- 证据：[schema.ts](../packages/db/src/schema.ts)（`channels`、`channelBots`、`messages`、
  `messageReactions`）、迁移 `0002_message_constraints.sql`、`0009_channel_conversations.sql`、
  `0022_direct_bot_conversations.sql`、`0024_multi_bot_message_recipients.sql`、
  `0025_channel_reactions.sql`；`getOrCreateDirectConversation`；集成测试
  `postgres-direct-conversations.integration.test.ts`。
- 关键区分："私聊"不是另一张表。它是设置了 `direct_bot_id` 的频道，其成员固定、不可被加入或编辑。
- 必须保留：对话、引用回复、表情回应、多接收者消息。
- 验收旅程：私聊保持私密——无法获得第二个成员；频道对话在客户端关闭再打开后仍在。

### C3 —— 多步骤执行

- 证据：[native-agent.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/native-agent.ts)（`NativeAgentRunner`、`executeAgentRun`）、
  [agent-runtime-host.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/agent-runtime-host.ts)（`catalog`/`generate`/`executeTool`/`finish`）、
  [agent-runtime-process.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/agent-runtime-process.ts)（`createPythonAgentExecutor`、
  `superviseRuntimeProcess`）、[agent-runtime-bootstrap.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/agent-runtime-bootstrap.ts)
  （显式开启 `OPENBOT_AGENT_RUNTIME=python`；TypeScript 仍为默认）、
  [postgres-task-submission.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/postgres-task-submission.ts)（`submitTaskInTransaction`）。
- 权威归属：工具意图循环、预算与最终提交由 Server 拥有。已验收的 Python 运行时是被监督的子进程，
  位于冻结线协议之后——见 [AGENT_RUNTIME_PROTOCOL.zh-CN.md](AGENT_RUNTIME_PROTOCOL.zh-CN.md)。
- 不要把功能源码的 `model-run-dispatcher.ts` / `model-services.ts` 当作第二个引擎去合并。
  它是建立在更旧基线上的更早循环，不是可互换的组件。
- 必须保留：单写入方规则。一项被迁移的职责，只有一个选定写入方。
- 验收旅程：任务经 Server 授权完成"工具 → 观察 → 结果"；最终提交只发生一次。
  该切片已验收的证据是确定性的、合成的；它明确不证明真实模型质量。

### C4 —— 持久工作环境

- 本检出证据：经 `OPENBOT_OBJECT_STORE_PATH` 的对象存储（产物、附件、插件）；
  [workspace-realtime-hub.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/workspace-realtime-hub.ts) 是 UI 事件通道，不是文件系统工作目录。
  这里**没有**持久工作目录，也**没有**受限命令执行：
  [coder provider](../providers/coder/src/index.ts) 声明了 `shell.execute`，但未实现任何 `execute`。
- 功能源码差异：功能线新增按 Bot 的执行环境隔离，经 `x-openbot-bot-id` 抵达的浏览器 profile 卷，
  以及 `deploy/browser/` 的 Dockerfile 与 Compose 入口。
- 必须保留：无论选哪种方案，都必须保持按 Bot 的隔离，因为接管与审批都是按 Bot 做出的决定，
  跨 Bot 串扰会直接使其失效。
- 验收旅程：同一宿主上的两个 Bot 看不到彼此的会话状态与文件。

### C5 —— 浏览器与工具操作

- 本检出证据：[providers/docker/src/index.ts](../providers/docker/src/index.ts) 是唯一实现 `execute` 的 Provider，
  声明 `["browser", "screenshot"]` 以及需显式开启的 `browser.input@1`；
  [reviewed-click.ts](../providers/docker/src/reviewed-click.ts) 与
  [computer-request.ts](../providers/docker/src/computer-request.ts) 针对外部 agent-computer 实现一次经审批的点击。
  [CONTROLLED_BROWSER.zh-CN.md](CONTROLLED_BROWSER.zh-CN.md) 写明了真实上限：默认关闭、仅可信测试源、
  "不实现原生桌面输入，也不是通用浏览 Agent"。
- 功能源码差异：本检出所没有的一整套会话模型——
  `apps/server/src/browser-sessions.ts`、`apps/node/src/browser-host.ts`、
  `providers/docker/src/browser.ts`、`packages/protocol/src/browser.ts`、
  `apps/web/src/components/EmployeeBrowser.tsx`、`deploy/browser/`、
  `docs/decisions/0028-employee-browser-sessions.md`。
- `BrowserSessions.command` 是 **Owner 人工输入**。`navigate`/`click`/`type`/`key`/`scroll`
  要求该会话持有有效接管授权，不能算成模型自主动作。功能线的 `docs/EMPLOYEE_BROWSER.md`
  明确说明自动 Run 仍只打开指定 URL 并截图。保留人工会话和租约边界；S4 再独立实现受审查的自主输入。
- 验收旅程：在本地测试站点上完成一次被批准的写入，再取消，再重启——且人工持有控制权期间模型被拒绝。

### C6 —— 文件与代码交付

按操作分别记录，不合并成一个数字。愿望不得被读成能力。

| 格式 | 读取/抽取 | 创建 | 编辑 | 渲染 |
| --- | --- | --- | --- | --- |
| 文本/代码、Markdown | 是（也可作为附件正文，分页） | 仅 Markdown 报告 | 否 | 否 |
| CSV/JSON | 是，作为纯文本——无结构化解析 | 否 | 否 | 否 |
| PDF | 是（`pdfjs-dist`） | 否 | 否 | 否 |
| DOCX、XLSX、PPTX | 是（`officeparser`） | **否** | 否 | 否 |
| PNG | 不适用 | 仅截图 | 否 | 不适用 |

- 证据：[channel-attachments.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/channel-attachments.ts)（SHA-256 与尺寸准入）、
  [attachment-processing.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/attachment-processing.ts)（在 Worker 线程中抽取；
  另有 `tesseract.js` 图像 OCR 与音频转写）、[artifact-storage.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/artifact-storage.ts)。
- 应原样保留的硬边界：产物**只**接受 `image/png`（≤ 5 MiB，校验 PNG 签名）与 `text/markdown` 报告
  （≤ 32 KiB、非空、不含 NUL），均按 SHA-256 存储，并在读取时由
  `GET /api/v1/artifacts/:artifactId/content` 复核。
- 计划把 DOCX/XLSX/PPTX 列为目标*文件操作*。今天它们只存在于**输入**侧。创建或渲染它们是新增能力，
  不是改名。

### C7 —— 审批与人工接管

- 证据：[approval-policy.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/approval-policy.ts)（`approvalPolicyRules`、`isRiskDowngrade`）
  覆盖 `browser.click`（HTTPS/回环）与 `form.submit`（HTTPS）；[schema.ts](../packages/db/src/schema.ts) 的
  `approvals` 表含 `pending`/`approved`/`rejected`/`expired`；
  [app.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/app.ts) 的 `POST /api/v1/approvals/:approvalId/decision`；
  [plugin-service.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/plugin-service.ts) 的插件确认生命周期。
- 功能线已含共享的 `0008_owner_approvals.sql` Worker 审批路径；后来的原生插件确认是另一项新增。
- 必须保留：审批是一个**状态**而不是日志行，且与上下文绑定——被批准的目标必须就是实际执行的目标。
  等待审批不是运行的终态。
- 验收旅程：批准一项具体的外部修改，并确认实际执行的正是被批准的那个动作——不多不少。

#### C7a —— 人工接管

迁移基线缺少完整的 Owner 浏览器会话界面与 Server 租约路径；声明 `human_takeover` 状态及标签不代表
该路径存在。但 [reviewed-click.ts](../providers/docker/src/reviewed-click.ts) 已在输入前后检查外部后端
`/control` 的持有人并拒绝人工控制期间的动作。这个现有否决检查必须保留。

功能线提供 Owner 会话实现：

- 会话由 Server 签发、租约由 Server 拥有：
  `apps/server/src/browser-sessions.ts`（`BrowserSessions.open/command/close`）。
- 查看会话持续 **600 秒**；`take` 动作授予**独占的、按 Bot 的 30 秒控制租约**，持有期间每条命令都会续期。
  `release` 显式结束它。
- 持久化刻意做浅，源码用一行写明：*"内存中的查看授权不会跨越重连/重启；后端的 paused 闩锁会。"*
  持久的部分是 `run_events` 审计行（`BROWSER_OPENED` / `BROWSER_COMMAND`）与 Worker 侧浏览器 profile。
  paused 闩锁位于 `apps/server/src/node-registry.ts`（`setBrowserPaused`）。该文件在本检出中存在，
  但闩锁不存在：`setBrowserPaused` 在本检出中没有任何出现。
- 会话中的输入均为 Owner 控制（见 C5）。模型输入需要独立授权路径，并遵守人工控制闩锁。
- 路由：`POST /api/v1/bots/:botId/browser` 与 `POST /api/v1/browser-sessions/:sessionId/commands`。

必须保留：独占的、有时限的、按 Bot 的人工控制；Owner 会话输入与独立授权自动输入的边界；审计行；
以及"授权不跨越重启"这一诚实表述。接管授予人对**界面的控制权**，从不授予新的权限。

验收旅程：Bot 在本地测试站点浏览；Owner 在任务中途接管；租约持有期间模型的命令被拒绝；
释放后交还控制权；重启后会话消失，但审计行与 Bot 的浏览器 profile 仍在。

### C8 —— 后台、定时与安全恢复

- 证据：[automations.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/automations.ts)（`AutomationScheduler.start/tick/stop`、
  `nextIntervalOccurrence`）、[postgres-automation-store.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/postgres-automation-store.ts)
  （`submitDue`）、迁移 `0018_automations.sql`、`0026_automation_attachment_outcome.sql`；
  启动恢复在 [run-dispatcher.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/run-dispatcher.ts)，
  调用 [postgres-store.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/postgres-store.ts) 的 `requeueAssignedRuns` 与
  `failRunningRuns`，事件 payload 为 `server-recovery`。
- 必须原样保留：恢复**不**重放外部副作用。错过的周期直接跳过，`running` 的工作被标记失败而不是盲目重试。
  这是正确的默认行为，S3 必须守住它，同时补上计划要求的"按动作确定重试策略"。
- 验收旅程：在派发前、提交后、等待审批中分别杀进程并重启；已完成工作保留，未知的外部写入不被盲目重放。

### C9 —— 有范围的长期记忆

- 证据：[agent-knowledge.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/agent-knowledge.ts)、
  [postgres-knowledge-store.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/postgres-knowledge-store.ts) 与
  [native-agent.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/native-agent.ts)。模型获得至多八条近期快照，不是按当前任务的相关性检索。
- 保留 Owner 审核、来源、范围与删除。S5 需验证相关检索，以及删除/停用后不再使用对应记忆。

### C10 —— 技能与教学复用

- 证据：[agent-knowledge.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/agent-knowledge.ts)（`validateKnowledgeProposal`、
  `boundedKnowledgeText`）、[postgres-knowledge-store.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/postgres-knowledge-store.ts)、
  迁移 `0020_reviewed_knowledge.sql`、`0015_employee_memory_lifecycle.sql`、`0011_employee_profiles.sql`
  （`employee_memories`、`employee_memory_events`、`skills`、`employee_skills`、`skill_dependencies`）；
  [agent-skills.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/agent-skills.ts)；[agent-steering.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/agent-steering.ts)。
- **被复核的 `SKILL.md` 是咨询性文本，不是可执行技能。** `parseSkillDocument` 只接受一份 ≤ 12 KiB 的
  Markdown 文档加有界 YAML frontmatter，按 SHA-256 绑定，且其自身注释写明规则：解析文本绝不跟随文件、
  URL 或工具声明。Agent 读取该文本（`read_skill`，上限 8 条描述、2 份完整文档）。没有脚本执行、
  没有技能目录加载，`allowed-tools` 也不授予任何权限。
- 教学是 Owner 中介且显式的：一次成功的任务可以**提议**一条经验；Owner 编辑、接受或拒绝它，
  并用另一个开关允许后续模型使用。Agent 不能自我批准。
- 缺失：任何模型或技能质量评测工具。[PROVIDER_CONFORMANCE.zh-CN.md](PROVIDER_CONFORMANCE.zh-CN.md)
  与 `packages/provider-conformance-runner` 覆盖的是 Provider 一致性，是另一件事。
- 必须保留：Hermes Agent 归因（[AGENTS.md](../AGENTS.md) 强制要求）、每条记忆与技能的来源与范围、
  删除控制，以及"任何学习路径都不增加权限"这一规则。
- 验收旅程：一条纠正变为经过复核的方法，在留出任务上显示可测量的改善，并且可以被撤销。

### C11 —— 有负责人的多 Bot 协作

- 证据：[agent-collaboration.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/agent-collaboration.ts)、
  [postgres-agent-collaboration.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/postgres-agent-collaboration.ts)
  （`activeCollaborationChain`、`channelColleagues`、`createDelegatedRun`）、
  [native-agent.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/native-agent.ts) 中的 `start_task` / `wait_for_task` / `delegate_task`，
  以及 `agent-collaboration.integration.test.ts`。
- 代码中"独立授权"的含义：被委派的子 Bot 使用**自己的** profile、技能、记忆与插件授权，
  不继承调用方。模型步骤、工具和网页调用预算按 Run 分别计算；共享的是根任务期限
  （[ASYNC_COLLABORATION.zh-CN.md](ASYNC_COLLABORATION.zh-CN.md)）。共享 Task 预算准入仍是目标要求，
  不是已有保证，见独立核验的 [S6 基线](research/s6-compatibility.md)。
- 构造上即有界：深度 ≤ 2、后代 ≤ 4、禁止自我/祖先/跨频道委派，频道租约由 PostgreSQL 咨询锁取得。
- 必须像对待能力一样大声地保留这个界限：这是*委派*，两棵树中都**没有通用持久团队抽象**。
  S6 的"保留现有委派并接入持久任务"不得被读成"团队功能已经存在"。
- 验收旅程：被委派的电脑/文件工作在独立于调用方的授权下运行，具备冲突与取消验证，
  且委派树的权威留在 Server/DB。

### C12 —— 开放工具与模型

- 本检出证据：MCP 支持见 [plugin-service.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/plugin-service.ts) 与 `plugin-routes.ts`
  （`install`/`grant`/`call`、按 Bot 授权、`read`/`confirm` 模式）；有界 Web 工具见
  [native-web-tools.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/native-web-tools.ts)（`web_search`，在
  [native-agent.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/native-agent.ts) 中接线）。
- **这里的模型配置是工作区级的 Owner 单例，不是按 Bot 的：**
  [model-settings.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/model-settings.ts)（`ModelSettingsService`），
  路由为 `GET`/`POST /api/v1/settings/model` 与 `POST /api/v1/settings/model/models`。
- 功能源码差异——本检出所没有的按 Bot 路径：
  `PATCH /api/v1/bots/:botId/model` → `updateEmployeeModel`，要求 `computerProfile === "model"`，
  写入 `bots.configuration.model`；`model_connections` 表
  （`preset_id`、`base_url`、`protocol` ∈ `openai-chat`|`anthropic-messages`、`encrypted_api_key`、
  `revision`）；`runs.model_selection jsonb`，在 `execution_profile = 'model'` 时被约束为恰好
  `{connectionId, modelId}`；`model-credential-cipher.ts`；`model-provider-presets.ts`；
  以及 `ModelSelector.tsx` / `ModelConnectionsDialog.tsx` 界面。两棵树都有有界的模型 Web 工具，
  但是两套不同实现（那边是 `model-web-tools.ts`，`maximumWebCalls = 4`，加 `tavily-web-tools.ts`；
  这边是 `native-web-tools.ts`）。
- 必须明说的安全后果：`model_connections.encrypted_api_key` 是凭据材料。计划的授权边界写明，
  凭据保护**绝不**随外围功能一并退役。采用哪种加密、用哪个密钥路径
  （`OPENBOT_MODEL_CREDENTIAL_KEY_PATH`）、按 Bot 连接是迁移还是重新实现，
  都是集成开发者的决策，不是一次数据拷贝。
- 验收旅程：切换某个 Bot 的模型后，其身份、记忆与文件保持不变；被撤销的连接器在刷新后仍然撤销。

## 退役候选

这里的退役指**带恢复路径的能力决策**，绝不是删除。每行写明替代、数据后果与安全后果。

| 候选 | 证据 | 所需的替代证据 | 数据后果 | 安全后果 |
| --- | --- | --- | --- | --- |
| Swift macOS worker host | [Package.swift](../apps/worker-host-macos/Package.swift)（功能源码中不存在） | Linux 优先的参考执行环境，加上明确的"macOS 原生宿主不是受支持路径"决定 | 即使没有业务数据库，也要保留设备登记、配置与凭据 | 它承载宿主授权代码路径。退役该产物不得移除与之共用的凭据保护或授权逻辑 |
| C# Windows worker host | `apps/worker-host-windows/OpenBot.WorkerHost.Windows/OpenBot.WorkerHost.Windows.csproj`；[WINDOWS_DESKTOP.zh-CN.md](WINDOWS_DESKTOP.zh-CN.md) 已标注该服务"另行审查" | 同上 | 保留设备登记、配置与凭据状态 | 同上 |
| 被替代的安装链 | `deploy/node/launchd/com.openbot.node.plist` 与被替代的原生安装器 | 替代实现验收后再决定；Linux systemd 不自动属于退役范围 | 保留宿主配置与登记状态 | 登记令牌与节点凭据必须在任何重新打包中存活 |
| 办公室可视化 | [packages/office-plugin/src/index.tsx](../packages/office-plugin/src/index.tsx) —— manifest 标 `status: "deferred"`，核心 Web 应用不导入它 | 本次范围无需替代；它已是惰性的 | 无 | 无 —— 不涉及权限 |
| 未实现的 Provider 占位 | [cua](../providers/cua/src/index.ts)、[lume](../providers/lume/src/index.ts)、[coder](../providers/coder/src/index.ts) 均未声明 `execute`；[PROVIDER_CONFORMANCE.zh-CN.md](PROVIDER_CONFORMANCE.zh-CN.md) 把三者标为 "Not implemented in this repository" | 检查已声明 profile、持久配置、调用方与 CI，保持一致性边界明确 | 无 | 退役*占位*不得移除一致性文档——正是它防止能力被虚报 |
| 被替代的 TypeScript 后端 | `apps/server/src/*` —— 按计划属过渡性权威 | S2 单写入方切换，且同一批夹具要在选定实现上跑通 | PostgreSQL 数据、迁移与已应用历史被保留，而非搬移 | 授权、审批与审计代码属安全关键；每次退役都要求相应的有效安全测试随之移动 |
| 员工市场／分发／图谱 | 两棵树都不存在市场或注册中心。唯一的产物是 [employee-package.ts](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/employee-package.ts) 中的签名员工包导出/导入与 `employee_import_receipts`；[EMPLOYEE.zh-CN.md](EMPLOYEE.zh-CN.md) 声明未实现认证式所有权转移 | 不适用 | 无 | 不要把*不存在*的能力说成"已退役"，也不要让"员工生态"这类措辞把登录、审批或凭据保护一并扫走 |

## 数据兼容风险

1. **相同时间戳对应不同 SQL。** 两条历史在共同的 17 个文件之后分叉。保留历史 SQL 与已应用记录。
   目标的新增迁移、单独验证的合成数据转移/桥接是两件事。
   [已完成的源码审计](MIGRATION_DATA_COMPATIBILITY.zh-CN.md)记录了哈希与风险。
2. **`runs.model_selection`。** 按 Bot 模型选择会给迁移线已经拥有的表增加一列和一个检查约束。
   加列很便宜；但决定既有 run 是否置 `NULL`、以及 `execution_profile = 'model'` 在本检出是否为受支持取值，
   并不便宜。
3. **凭据材料。** `model_connections.encrypted_api_key` 不能盲目在环境之间复制。
   凭据转移需要匹配密钥与授权语义，普通导出及模型上下文必须排除这些材料。
4. **`run_events` 重叠。** 功能源码把浏览器审计行写入 `run_events`，而迁移线也演进过该表
   （`0019_native_run_observations.sql`）。采用任一侧之前必须比对 payload 形状。
5. **审计边界。** 源码历史审计已完成；用户数据、文件、凭据迁移与备份恢复仍需 S7 的显式合成夹具验证。

## 证据与基线限制

- 功能线已有按 Bot 模型配置，S6 需要保留迁移；迁移基线仍是工作区级单例。
- 在较新基线上保留这个分叉提交中有用的行为，不整套复制旧后端，不覆盖任一已应用 SQL 历史。
- [2026-09-10 清单](testing/2026-09-10-feature-inventory.zh-CN.md)与
  [DELIVERY_STATUS.zh-CN.md](DELIVERY_STATUS.zh-CN.md)属于历史记录。Office 抽取、OCR/转写与
  32 KiB 报告上限以当前代码为准。
- 仅声明 `human_takeover` 状态或 `shell.execute` 能力不代表实现；也必须区分现有后端人工控制否决检查
  与缺失的完整 Owner 会话界面。
- 已验收 Python 里程碑使用真实 Python 子进程、真实 Server/PostgreSQL 和合成模型/工具响应。
  功能线 `docs/testing/2026-09-08-browser-model-tools.md` 记录了旧基线上的真实浏览器与有限 Kimi 流程。
  两者都不证明任意模型质量或最终产品已验收。

## 本文不声称的内容

- 没有运行任何测试。以上状态全部来自阅读源码；通过测试只在他人的报告具名提及、且按其自身声明的范围引用时才被引用。
- 不因为存在代码就宣称某项能力"受支持"，也不因为本文把它列为候选就宣称某项能力"已退役"。
- 两棵树从未被合并成一个受支持的版本，且功能提交的实测结果是针对更旧的基线取得的。
- Linux、Windows 与 macOS 的支持声明保持不变，并与
  [CROSS_PLATFORM.zh-CN.md](CROSS_PLATFORM.zh-CN.md) 和
  [WINDOWS_DESKTOP.zh-CN.md](WINDOWS_DESKTOP.zh-CN.md) 所述一样窄。
