# TypeScript 任务执行（P4）

[English](README.md) · 简体中文

本包实现新 `OpenBotWorkTsV1` Temporal 工作流、单次启动交接、不可变启动历史读取和可信 Activity
身份核对。Server 的 SQL 准入与执行栅栏位于 `apps/server-ts/src/work-handoff.ts` 和
`work-execution.ts`。模型/工具策略、回执与发布仍归 Server；本包不导入应用代码。

显式 P4 产品候选现通过 TS Server 监管、Work/来源接口和唯一 Worker socket 注册表组合这些
Activity，覆盖原生/频道任务、周期任务、根任务优先协作、原有 harness 策略及模型/媒体/知识/
插件/网页/浏览器/审批命令工具。Python 门禁排除新 `typescript-v1` 准入；旧记录保留 `python-v1`，
SQL 拒绝修改归属。新 TS 准入前必须完成旧 SQL/Temporal 全部分页义务排空。

Desktop v8 选择同一组合并要求私有引擎配置。macOS arm64 完整候选已安装，实际认证启动、正常
双服务退出与重启验收通过。真实保护 Linux/runsc 命令与隔离浏览器也已通过原到期及完整拥有资源
清理验收。统一评估要求实际 PR HEAD 的全部托管检查通过；Python 退役属于 P5。见[已批准决策](../../docs/decisions/0050-typescript-control-plane.zh-CN.md)和
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

验收使用真实 SQL/SDK/Temporal，覆盖并发预留、跨归属拒绝、丢失启动响应恢复、Worker 替换、
持久唤醒、旧栅栏拒绝、Continue-As-New 链身份和官方导出历史重放。产品流程还覆盖公开任务/
报告下载、全部运行时工具族、频道/周期/来源归属、协作过期与五个真实进程 SIGKILL 恢复窗口。
受控树关闭回执竞态同时验证成功关闭、关闭失败传播与两份历史重放。模型响应与部分 peer 仍为
合成；真实原生命令/浏览器在有明确归属的 Linux CI 夹具另验。这些检查不证明模型质量或跨语言
历史重放。

产品组合必须显式配置认证引擎连接与独立 TS 队列，在远程 Activity 内通过 `currentBinding()`
提取事实，并在每次模型/工具准入及发布前检查 SQL 绑定与当前权限。唤醒信号不授予权限。启动结果
未知时只查原历史，不重复发起上层启动。完整排空门槛通过前，已有 Python 历史、计时器、子任务和
Continue-As-New 链均由原 Worker 处理。切换公开接口组前必须完成界面验收 `PASS 12/12`。
