# 仓库地图

[English](REPOSITORY_MAP.md)

先读[当前架构](ARCHITECTURE.zh-CN.md)理解权限边界，按[贡献指南](../CONTRIBUTING.zh-CN.md)复现环境。下列命令都在仓库根目录运行。每次修改聚焦一个行为及其负面测试，避免增加第二个状态权威或重复的全局样式覆盖。

| 区域 | 主要位置 | 扩展方式与检查 |
| --- | --- | --- |
| Server API | `apps/server/src/app.ts`、各功能 `*-routes.ts` | Owner/Origin middleware 后挂载；先校验后变更；运行 Server 测试 |
| 持久化 | `packages/db/src/schema.ts`、migrations、Server `postgres-*.ts` | [手写 SQL 与只读迁移计划](DATABASE.zh-CN.md#编写迁移)；条件事务；不重生成既有历史。运行 `npm run migration:plan --workspace @openbot/db -- --help`、迁移检查与隔离 PostgreSQL 测试 |
| 原生 Agent | Server `native-agent.ts`、`agent-*.ts`、`postgres-agent-*.ts` | 有界工具、执行前审计、准确身份和取消；运行 SDK 流测试与协作数据库测试 |
| MCP 扩展 | Server `plugin-*.ts`、Web `Plugin*` 组件 | 已审阅的工具/资源/提示词及沙箱网页；运行 service/content/transport/sandbox 测试 |
| 产品类型 | `packages/domain/src` | 稳定 DTO，不导入 apps；运行 domain typecheck |
| 外部协议 | `packages/protocol/src` | 严格 schema 和非法输入测试，与内部类型区分 |
| 频道体验 | Web `ChannelWorkspace`、`MessageActionBar`、`MessageReactions`、附件组件 | 每个组件负责一种交互，回调变更 Server 状态；组件测试及宽窄窗口实测 |
| Web 数据与会话 | `api.ts`、`conversation-session.ts`、`run-output-state.ts` | 鉴权请求、草稿所有权、准确频道事件；API/session 测试和类型检查 |
| Desktop 边界 | `apps/desktop/src/main.ts`、`preload.ts`、`native-server.ts` | 类型化受限桥接、可信 frame 校验；运行桌面测试及目标平台安装/启停 |
| Node 执行 | `apps/node/src/client.ts`、`runtime.ts`、`providers.ts` | 先[登记开发 Node](../CONTRIBUTING.zh-CN.md#按需启动开发-node)，再连接；分派与实际能力校验、生命周期/传输测试 |
| Provider | `providers/*`、`packages/provider-sdk`、conformance runner | 对维护中的上游做薄适配；通过具体能力的符合性检查 |
| 安全/策略 | `packages/policy`、`docs/SECURITY.md`、Server auth/approval | 默认拒绝、权限上限、显式审计；策略/鉴权负测与安全配置检查 |
| 打包/CI | `scripts`、Desktop scripts、`.github/workflows`、`deploy` | 可复现版本、目标平台构建与生命周期；release checks 和原生 smoke |
| 官网/手册 | [openbot-website](https://github.com/yxflc11/openbot-website)、`docs`、根 README | 链接当前正式文档，区分实现/验证/计划；站点构建、docs check 和浏览器验收 |

## 修改流程

先运行[最短 Server/Web 开发流程](../CONTRIBUTING.zh-CN.md#本地开发)，再按需启用执行能力。
恢复操作使用[完整持久资产清单](DATABASE.zh-CN.md#备份边界)，包含模型密钥/设置和插件状态。
第三方运行时原始声明及版本/哈希清单位于 [licenses/runtime](../licenses/runtime/README.zh-CN.md)。

1. 找到模块以及[开源复用记录](OPEN_SOURCE_REUSE.zh-CN.md)。
2. 非简单行为变更先记录一手来源研究。
3. 修改最小功能模块；授权留在 Server，外部契约使用共享 schema。
4. 边界变化增加有意义的失败或竞态测试；数据库使用独立临时实例，不使用用户数据。
5. 单独运行下游 typecheck 前先构建改过的 shared package；根 Turbo 脚本会按依赖顺序处理。
6. 同步英文正式文档与中文翻译，最后运行 `npm run check`。

## 源码与生成内容

`dist`、`node_modules`、`.turbo`、Desktop `out`/`native-runtime`、私有 `.env`、数据库和日志不提交。已安装应用不是源码权威。`docs/research` 保存决策依据，产品手册通过链接引用，避免复制旧实现历史。

依赖方向是 apps 使用共享 packages，共享 packages 不能反向导入 apps。插件作者从[插件协议](PLUGINS.zh-CN.md)开始；电脑后端作者从[Provider 符合性](PROVIDER_CONFORMANCE.zh-CN.md)开始。技能只是一种内容，不等于整个扩展协议。

任务流程入口：`task-attachment-references.ts` 管理新引用策略；`postgres-task-submission.ts` 管理既有 Message/Run 同事务提交；`postgres-task-records.ts` 仅作行数据映射；`postgres-attachment-references.ts` 为清理查询持久引用。共享协议文件 `attachments.ts`、`automations.ts`、`plugins.ts` 只包含数据契约。Web 的 `use-workspace-state.ts` 统一快照、操作响应与实时事件。见[任务研究](research/task-flow-refactor.zh-CN.md)和[工作区研究](research/workspace-state-refactor.zh-CN.md)。

[设计素材索引](design/README.zh-CN.md)明确区分当前参考与历史概念。
