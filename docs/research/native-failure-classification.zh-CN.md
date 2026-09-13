# 研究：非权限失败的原生错误分类

- 状态：实现审查中
- 日期：2026-09-13
- 负责人：@yxflc11
- 相关事项：F02 `scope_revoked` 被误用作“失去频道权限”
- 验收旅程：未知 wait_for_task 目标、用量更新冲突、技能/记忆变更的失败文案不再声称 Bot 失去频道成员关系。
- 安全边界：真实成员关系失效仍 fail-closed。不放宽权限、不增加重试或预算。目录文案不含上游原文。

## 独立复核补充（2026-09-13）

初版只检查本地实现；以下外部研究在后续修正前完成，不倒推声称初版遵守了先研究后实现。
检索 GitHub 的 `nodejs/node errors error.code stable error.message` 与 RFC Editor 的
`RFC 9457 problem type detail`，查阅 [RFC 9457（2023 年 7 月）第 1、3.1、5 节](https://www.rfc-editor.org/rfc/rfc9457.html)。
沿用机器分类与人类说明分离、避免泄漏内部信息的原则，保留现有 Run 表示，不新增或宣称兼容
`application/problem+json` HTTP 接口。

核对 Node.js v22.22.2（标签 c7462cf3 → 提交 `2645dc73720b1b4f27c49f395d3c66025ce126cc`）
的[错误码文档](https://github.com/nodejs/node/blob/2645dc73720b1b4f27c49f395d3c66025ce126cc/doc/api/errors.md)、
错误目录源码、SystemError 测试和 MIT 许可；测试区分 code、name、message。
检视当前 errors 维护队列及 [#61599](https://github.com/nodejs/node/pull/61599) 的文案修正，
确认应依靠稳定代码而非解析上游消息。现有运行时已提供 Error，不导入其私有 internal/errors。

首选为标准原则加现有 Error/Run 目录；HTTP 错误依赖或私有 Node 适配器不能解释本项目的数据库
条件，因此无须新增依赖、分叉或复制源码。IETF Trust 与既有 Node 发行许可说明保留。
后续修正按实际拒绝条件区分非活动任务/写入冲突、无效上下文、已审阅资料变化及真实成员撤销，
不放宽任何拒绝条件，不改写历史错误。

## 检索证据

- 检索日期：2026-09-13
- 已核对：[agent-execution-experience](agent-execution-experience.md)、[native-agent-loop](native-agent-loop.md)、`docs/NATIVE_AGENT.md`、OPEN_SOURCE_REUSE 原生 Agent 行。
- 代码核对：`agent-observations.ts` 目录；`native-agent.ts` / store / skills / collaboration 抛错点；`NativeRunControls.tsx` 中文映射。

## 候选对比

| 候选 | 精确版本或提交 | 许可 | 维护与测试 | 平台/API/安全拟合 | 决定 |
| --- | --- | --- | --- | --- | --- |
| 扩展现有 `nativeFailureMessages` | 当前 main（`0aafca2`） | 本项目 | 已驱动 Run.errorCode、英文落库文案、中文 UI | 对齐 `settings_changed` / `plugin_changed` | 选用薄本地分类 |
| 仅复用 `execution_failed` / `tool_unavailable` | 同上 | 本项目 | 可去掉错误权限文案但丢失可操作区分 | 弱化 Owner 指导 | 拒绝 |
| 新增错误分类依赖 | 无 | 无 | 无外部缺口 | 增加表面无权限收益 | 拒绝 |

## 复用决定

- 选用：在现有失败目录内补充分类。
- 上游：前述 RFC 9457 的分类与详情分离原则、Node 公开 Error/code 模型，通过已有 `NativeExecutionError` 目录应用；没有新增运行依赖。
- OpenBot 缺口：未知/不适用目标 → `invalid_target`；用量冲突 → `conflict`；技能漂移 → `skills_changed`；记忆漂移 → `memory_changed`；真实 `channel_bots` 成员失效仍为 `scope_revoked`。
- 来源拷贝：无。

## 验证计划

- 自动化测试区分上述代码与 `scope_revoked`；UI 中文断言；记忆共享撤销集成期望 `memory_changed`；`npm run check`。

## 验证结果

- 独立补充修复的 98 项相关测试通过，包含真实 NativeAgentRunner 未知子任务入口，以及临时 PostgreSQL 中的任务生命周期和成员撤销流程。
- 类型检查和全仓 `npm run check` 通过；临时数据库已关闭并移除。
- Web 文案测试使用 jsdom；修复后安装版界面及平台 CI 另行验收。这些结果不代表已定位先前安装版故障的具体原因。
