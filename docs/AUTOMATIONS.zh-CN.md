# 自动任务

自动任务会按设定的间隔，让指定 Bot 在指定频道收到一条任务提示。打开 Desktop 左侧的**自动任务**，选择已经加入频道的 Bot，再设置首次运行时间和重复间隔。计划由 Server 保存，每次提交沿用普通频道消息的任务、路由、审批和审计流程。

## 首版支持的内容

- 最多创建 50 个计划，每个包含名称、频道、Bot、提示词、首次运行时间，以及 15 分钟到 7 天的固定间隔。
- 暂停、恢复或删除计划。暂停和删除会停止后续提交，不会取消已经提交的 Run。
- 查看下次时间、上次调度尝试，以及已提交、因上次任务未结束而跳过、因 Bot 不再属于频道而暂停等结果。
- 进入频道查看任务。自动提交的消息会标为系统消息，Server 审计记录会关联对应计划。

每小时、每天和每周分别表示每隔 1、24 和 168 小时。首次时间选择器使用电脑的本地时间，并保存对应的时间点。这是固定时长间隔；夏令时变化或更换时区后，显示的本地时间可能变化。

## 运行条件与审批

Server 必须保持运行。本机作为服务电脑时，需要保持 OpenBot 运行；退出应用会停止本机 Server。远程 Server 保持运行时，客户端可以关闭。

服务中断后，Server 最多处理一次迟到的计划，然后直接推进到未来的时间，不会逐条补发所有错过的任务。上次 Run 仍处于排队、已分配、运行、阻塞或等待审批时，同一计划不会再提交新 Run。恢复暂停计划时，已经过期的时间会推进到未来。

计划只授权按照指定间隔提交记录的提示词，不会跳过审批、改用其他 Bot、安装技能或在 Server 中执行任意代码。实际执行仍取决于 Bot 已支持的执行配置、可用电脑和现有策略。只保存模型密钥不会开启推理；Owner 单独[启用原生 Agent](NATIVE_AGENT.zh-CN.md) 后，新建的 `none` 任务可执行有界模型循环。推理关闭或电脑配置不受支持时，任务可能一直排队，后续计划因此跳过。

首版不提供 cron 表达式、按夏令时调整的日历重复、立即手动运行、编辑计划或失败 Run 的自动重试。需要更改提示词或时间时，可暂停或删除后重新创建。删除计划后，已经提交的 Run 历史仍保留。

## API

所有接口都需要 Owner 登录会话，写入还需要可信 Origin。以下路径相对于已连接的 Server：

| 方法与路径 | 请求 | 响应 |
| --- | --- | --- |
| `GET /api/v1/automations` | — | `{ automations: Automation[] }` |
| `POST /api/v1/automations` | `{ name, channelId, botId, prompt, intervalMinutes, firstRunAt }` | `201 { automation }` |
| `PATCH /api/v1/automations/:id` | `{ enabled: boolean }` | `{ automation }` |
| `DELETE /api/v1/automations/:id` | — | `{ deleted: true }` |

`firstRunAt` 为未来 366 天以内的 ISO 8601 UTC 时间。名称为 1–80 字符，提示词为 1–8,000 字符，间隔为 15–10,080 的整数分钟。额外字段会被拒绝。创建请求最多 32 KiB，更新最多 1 KiB，没有 Content-Length 的请求也执行限制。未配置自动任务存储的 Server 返回 503。

`Automation` 包含除 `firstRunAt` 外的请求字段，以及 `id`、`enabled`、`nextRunAt`、`lastRunAt`、`lastRunId`、`lastOutcome` 和 `createdAt`。首次尝试前，三个上次运行字段为空。`lastOutcome` 可为 `submitted`、`skipped_active`、`target_unavailable` 或 `attachment_unavailable`。`lastRunAt` 是最近一次调度尝试时间，可能对应跳过提交；`lastRunId` 保留最后一次实际提交的 Run。

首版 POST 没有幂等键。网络失败后，应先刷新列表，再决定是否重新创建。

## 验证

单元测试覆盖间隔计算、重复轮询合并、有界关闭和登录 API 边界。PostgreSQL 集成测试覆盖两个竞争调度器、整体事务回滚、跨存储实例持久化、防止重叠、暂停/恢复/删除、成员资格、50 个计划上限，以及普通任务提交行为。测试不接入 Worker 或外部模型。

如需运行集成测试，将 `OPENBOT_AUTOMATION_TEST_DATABASE_URL` 指向一个空的、可丢弃的本机 PostgreSQL 17+ 数据库，名称必须以 `openbot_automation_test_` 开头，然后运行：

```sh
npx vitest run apps/server/src/postgres-automation-store.integration.test.ts
```

测试会迁移并清理该数据库，会拒绝其他主机和数据库名称。未设置专用变量时跳过。这不代表支持多 Server 调度部署；OpenBot 的 dispatcher 和实时事件机制仍以单 Server 为边界。

复用依据见[调研记录](research/server-automations.md)。

## 附件引用

提示词中已有的附件标记与交互任务共用频道、完整性和大小校验；创建或恢复任务时拒绝无效
引用。所有已保存任务（包括暂停任务）保留已标记删除的文件，删除任务后才释放；已提交消息
和 Run 独立保留历史引用。清理不会删除未标记删除的文件。

每次提交前再次检查原文件及已处理文字。缺失、软删或损坏会暂停任务，结果为
`attachment_unavailable`，不创建 Run，并只记录不含文件内容的原因。恢复或重新处理原文件
后手动启用，或删除并重建任务；不会因此取消已提交的 Run。

实现先取得文件引用锁，再进入数据库事务。新增隔离测试使用
`OPENBOT_ATTACHMENT_TEST_DATABASE_URL`，仅允许本机 `openbot_attachment_test_*` 数据库；执行
`npx vitest run apps/server/src/task-attachment-references.integration.test.ts`。
见[流程研究](research/task-flow-refactor.zh-CN.md)。
