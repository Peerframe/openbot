# 研究：统一任务与附件流程

[English](task-flow-refactor.md) · [简体中文](task-flow-refactor.zh-CN.md)

- 状态：批准实施；日期：2026-09-14；负责人：@yxflc11。
- 基准：OpenBot `3a02750e8851298a1b27246fd1ac4925f319fdc1`。
- 验收：处理后的附件进入真实 Agent；定时任务首次运行前保留附件，引用失效后停用并解释原因。
- 边界：身份、成员关系、权限和审计仍由 Server 决定，模型和文件不能授予权限。

## 调研与选择

复核复用索引及现有 Agent、附件、定时任务研究。检索 PostgreSQL 17 显式锁和死锁、
AI SDK ToolLoopAgent 的工具声明、pg-boss 事务队列；实际读取固定版本的 GitHub 源码、
测试目录、发布信息及开放问题。完整链接和比较见[英文记录](task-flow-refactor.md)。

采用 PostgreSQL 17 的事务/行锁与现有文件锁；继续使用 ai 7.0.93
（`6359fd58fe68eaade096b5d923bac26de84ca3bd`，Apache-2.0）和 Zod 4.5.4（MIT）。
比较 pg-boss 12.26.0（`31a4cf0093b0df73d077782689b738bcd0292021`，MIT），其队列能力不能
替代 OpenBot 的文件引用、成员关系和 Message/Run 同事务约束，故不增加队列依赖。
AI SDK issue 14170 涉及动态工具列表和缓存；本次每个 Run 保持固定工具表，权限另行复核。

### 持续 PostgreSQL 验收

合并前复核 `11ac702ca1fb3dd389adf8d97f9a8b09fe1e9714` 发现：新增附件集成测试要求
`OPENBOT_ATTACHMENT_TEST_DATABASE_URL`，但 CI 没有设置，因此普通测试命令会跳过该验收。
2026-09-14 查阅 GitHub 的 [PostgreSQL 服务容器指南](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers)
（GitHub 检索：`repo:github/docs creating PostgreSQL service containers`）及 PostgreSQL 17 的
[`CREATE DATABASE` 约定](https://www.postgresql.org/docs/17/sql-createdatabase.html)。运行器通过已发布的
回环端口访问服务；建库沿用现有测试连接，在事务外执行。

复用现有 `database` job、通过健康检查的 `postgres:17.11-bookworm`、Postgres.js 3.4.9
（Unlicense）、Vitest 5.0.0（MIT）和 Node 22.22.2。保持现有 MIT Actions 固定版本：
[`actions/checkout` v7.0.1](https://github.com/actions/checkout/tree/3d3c42e5aac5ba805825da76410c181273ba90b1) 和
[`actions/setup-node` v7.0.0](https://github.com/actions/setup-node/tree/820762786026740c76f36085b0efc47a31fe5020)。
现有适配已经满足需求，不增加运行器、容器框架或依赖。仅新增专用的
`openbot_attachment_test_ci` 数据库及显式附件测试命令，保留全部旧集成测试命令。
固定库名符合测试的破坏性清理保护；服务随 CI job 销毁，不涉及应用数据、生产凭据或部署。
不复制或实质改写上游源码。

## 实施与兼容

- 从综合 store 提取现有任务 SQL 和纯数据映射，不改变任务路由、审批或取消。
- 前后端共用附件类型、扩展名、大小和操作定义；字节检测、存储和权限留在 Server。
- 工具注册、审计包装和返回校验使用同一份工具表，不再分别维护允许名单。
- 交互任务、定时创建/恢复/到期执行共用附件校验。先文件锁、后数据库事务；事务中不重复
  获取文件锁。保留最多 50 个任务、每批 10 个到期任务和现有事务超时。
- 包括已暂停任务在内的所有现存定时任务保留引用，删除后释放；清理查询完整消息、Run 和
  定时任务。软删、缺失或损坏附件禁止新执行，到期记录 `attachment_unavailable` 并停用，
  界面提示恢复文件或删除重建；不泄露文件内容或存储路径。已有 Run 继续保留历史读取语义。
- 原数据、外观和员工包兼容。追加一条迁移扩展结果字段的 CHECK 约束，不改历史迁移；现有任务记录即可保留引用，不新增引用表或升级依赖。

## 来源与验收

不复制或实质改写上游实现，仅移动现有 OpenBot 代码并添加其特定接入逻辑，保留原声明。
真实 Agent 配确定性模型验证 PDF、Office、OCR、转写及普通附件；临时 PostgreSQL 配真实
文件存储验证引用保留、删除释放、损坏、并发提交/清理、成员撤销和事务回滚。
CI 的 PostgreSQL job 必须用专用回环测试库设置 `OPENBOT_ATTACHMENT_TEST_DATABASE_URL`，
显式执行 `task-attachment-references.integration.test.ts`；不带环境变量的普通测试不能作为该套件的通过证据。
执行共享契约、现有接口、Web/桌面界面检查及 `npm run check`，不使用付费模型或用户数据。

本批无未决问题。跨进程共享文件锁、日历调度、新 Provider 和头像重设计不在本轮范围。
