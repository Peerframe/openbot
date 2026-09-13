# 研究：非权限失败的原生错误分类

- 状态：已实现
- 日期：2026-09-13
- 负责人：@yxflc11
- 相关事项：F02 `scope_revoked` 被误用作“失去频道权限”
- 验收旅程：未知 wait_for_task 目标、用量更新冲突、技能/记忆变更的失败文案不再声称 Bot 失去频道成员关系。
- 安全边界：真实成员关系失效仍 fail-closed。不放宽权限、不增加重试或预算。目录文案不含上游原文。

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
- 上游：无；复用执行体验研究中的 `NativeExecutionError` 模式。
- OpenBot 缺口：未知/不适用目标 → `invalid_target`；用量冲突 → `conflict`；技能漂移 → `skills_changed`；记忆漂移 → `memory_changed`；真实 `channel_bots` 成员失效仍为 `scope_revoked`。
- 来源拷贝：无。

## 验证计划

- 自动化测试区分上述代码与 `scope_revoked`；UI 中文断言；记忆共享撤销集成期望 `memory_changed`；`npm run check`。
