# 原生知识来源 UI

[English](native-knowledge-provenance-ui.md) · [简体中文](native-knowledge-provenance-ui.zh-CN.md)

- 日期：2026-09-25。
- 状态：展示适配候选，仍需最终产品集成验收。
- 范围：在 Owner 知识审阅和已接受记忆中区分原生 Task/Work Run 与旧频道 Run。

## 复用与合同

此有界扩展复用[原生任务 UI 审阅](native-task-ui.md)、React/ReactDOM 19.3.0 / `1d34f91dfde6bba84d08b683aaba164c7194dacb`（MIT）、已有 domain 包和知识审阅/员工资料组件。编码前检查了 Python `employee_knowledge._proposal_source` 及 `work_native_knowledge` 的真实来源记录。复用已有 `#/tasks?task=...` 入口，主要参考仍为[固定 React 源码](https://github.com/react/react/tree/v19.3.0)、[显式事件处理](https://react.dev/learn/responding-to-events)和[Effect 生命周期](https://react.dev/reference/react/useEffect)。未新增依赖、授权协议或框架；未复制上游源码，只局部适配现有 OpenBot UI，依赖许可证保持不变。

`KnowledgeProposal` 使用排他 union：频道提案保留 `sourceRunId`，原生提案使用 `source: {kind: "task", taskId, runId}`，不包含伪造的旧 `sourceRunId`。原生 UI 链接真实 Task，并单独标注 Work Run。Owner 审阅端点与 accept/reject 请求体不变，包括 `modelUseEnabled` 默认 false。来源链接不授予权限，目标页仍通过既有 Owner API 鉴权。

已接受原生记忆的 `provenance.source: "reviewed-work-proposal"` 将 `sourceTaskId` 显示为 Task 链接，`sourceWorkRunId` 显示为 Work Run。原生来源字段不完整时明确显示缺失，不用旧 Run 填补。频道来源仍显示原 Run，Owner 手动记忆不添加虚构来源。React 负责文本转义，hash 路由编码身份字段。

## 验证

KnowledgeReviewPanel 与 EmployeeProfileView 共 16 项通过，其中新增七项原生/旧频道兼容用例。隔离候选 domain 构建、Web TypeScript 和修改文件 Biome lint 均通过；Web 检查使用隔离构建的新 domain 声明。这些是合成记录下的 React DOM/jsdom 与静态渲染证据，不是真实浏览器/Server 旅程。真实 API/浏览器集成由主控完成；未使用服务、provider、PG、Temporal 或用户配置。

```sh
npm run build --workspace @openbot/domain
npm run typecheck --workspace @openbot/web
cd apps/web
../../node_modules/.bin/vitest run src/components/KnowledgeReviewPanel.test.tsx src/components/EmployeeProfileView.test.tsx --maxWorkers=2
```
