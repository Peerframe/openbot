# TypeScript 任务执行（P4）

[English](README.md) · 简体中文

本包实现新 `OpenBotWorkTsV1` Temporal 工作流、单次启动交接、不可变启动历史读取和可信 Activity
身份核对。Server 的 SQL 准入与执行栅栏位于 `apps/server-ts/src/work-handoff.ts` 和
`work-execution.ts`。模型/工具策略、回执与发布仍归 Server；本包不导入应用代码。

目前仍在集成，**尚未启用产品运行时，P4 尚未完成**。当前 Activity 只由明确的合成控制验收组合。
公开接口、桌面启动、产品监管进程和已有 Python 工作流均未切换归属。Python 交接和 Activity
门禁排除新建的 `typescript-v1` 准入；已有记录默认 `python-v1`，SQL 禁止修改归属。在协作的根任务
优先加锁规则迁完前，TS 控制适配器拒绝执行子任务。

下一产品检查点是 Owner 新建原生任务，经模型/报告执行和独立验证后下载产物。完整 P4 还包括
harness 策略、全部运行时工具、Work/来源接口、Worker 连接、监管、打包与 Python 历史排空。
见[已批准决策](../../docs/decisions/0050-typescript-control-plane.zh-CN.md)和
[实现证据](../../docs/research/typescript-control-plane-p4.zh-CN.md)。

## 检查

在仓库根目录运行，使用已有的固定 Worker Python 环境与 Docker：

```sh
npm test --workspace @openbot/work
npm run test:work:ts
```

第二条命令先构建依赖，再复用仓库的 PostgreSQL 持久化 Temporal 1.32.0/mTLS 夹具。创建私有测试
证书、隔离数据库和有独立归属的 Docker 资源，在成功、失败或终止时清理；不安装工具、不连接产品
数据、不调用付费模型，也不自动下载测试服务器。`OPENBOT_TEMPORAL_TEST_PYTHON` 可指定已有且通过
锁定环境验证的 Worker 解释器，默认使用 `apps/server-python/.worker-venv/bin/python`。

验收使用真实 SQL/SDK/Temporal，覆盖并发预留、跨归属拒绝、取消后丢失启动响应的恢复、Worker
替换、持久等待唤醒、旧栅栏拒绝、Continue-As-New 链身份、导出历史回放及启动确认竞态。合成
`advanceWork` Activity 只证明这些引擎/控制合同，不证明模型质量、工具效果、公开任务完成或跨语言
历史回放。

产品组合必须显式配置认证引擎连接与独立 TS 队列，在远程 Activity 内通过 `currentBinding()`
提取事实，并在每次模型/工具准入及发布前检查 SQL 绑定与当前权限。唤醒信号不授予权限。启动结果
未知时只查原历史，不重复发起上层启动。完整排空门槛通过前，已有 Python 历史、计时器、子任务和
Continue-As-New 链均由原 Worker 处理。切换公开接口组前必须完成界面验收 `PASS 12/12`。
