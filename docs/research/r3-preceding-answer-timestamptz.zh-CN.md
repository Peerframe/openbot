# 调研：前序 Bot 答复截止时间保留 PostgreSQL timestamptz 微秒

- 状态：已接受
- 日期：2026-09-23
- 负责人：@yxflc11
- 相关议题：OpenBot R3
- 验收旅程：后排队的 Owner 任务在 `RUN_STARTED` 之前收到的 Bot 答复（含同一毫秒、更早微秒）会出现在该任务的 `initialContext`/`context`；开始后的答复、后续独立人类输入、越权任务树答复仍排除。
- 安全边界：仅 Server `PostgresAgentStore` 上下文。模型仍不可信。无新权限。缺少 `RUN_STARTED` 时 fail-closed。

完整检索、候选对比与验证计划见[英文证据](r3-preceding-answer-timestamptz.md)。

## 复用结论

- 选定：在现有 Drizzle + PostgreSQL 上以 SQL 子查询比较 `timestamptz`，避免 JS `Date`/`toISOString` 截断微秒。
- 禁止：`+1ms`、sleep、扩大边界；本切片不做全库 `mode: 'string'` 迁移。
