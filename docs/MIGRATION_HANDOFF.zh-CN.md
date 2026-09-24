# 架构迁移交接 — 2026-09-24

## 当前简短交接（`7e276d5`）

- 已完成：S3 多 Run 参考探针在 Worker 启动前只构造一个 Agent，按序列化的 Run 依赖选择各模型/工具 Activity，并拒绝串 Run 的观察。Codex 用固定版本 SDK 和自建临时 Temporal 实际运行：两条真实历史均有两次已完成模型请求和一次已完成工具调用，工具执行区间实际重叠。证据见 `experiments/work-journey/multirun_port_probe.py`、`docs/research/work-temporal-journey.md` 末节及 `/private/tmp/openbot-s3-multirun-probe-overlap-20260924.log`。`npm run check` 退出码为 0；18 项构建均命中缓存。
- 未完成：探针不是生产 Worker；此处未证明整个 Run 的预算可持久化，也未测试崩溃重放、批准等待、外部结果最终性或真实服务。S3 的 Worker/Runtime 组合与继续执行、S2 全面对齐、S4/TASK020 真实 Linux/runsc、S5–S7 均开放。总体交付粗估仍约 25%，当前处于 S3。
- 约束：Python 控制层持有身份、授权、任务/动作事实、批准、预算与产物；Temporal 持有继续执行；Runtime/Worker 不产生授权。未知外部写入须经权威核验，否则保持未知。取消/撤权不重新授权。尚不切换生产或发布。
- 下一阶段输入：`7e276d5`、`apps/server-python/src/openbot_server/{work_effects.py,work_temporal_activity.py}`、`apps/agent-runtime-python/src/openbot_agent_runtime/{executor.py,sdk_ports.py}` 和上述研究文档末节。保留无关的模型服务改动、`docs/OPEN_SOURCE_REUSE.md` 与 `experiments/linux-execution/`；仅遇具体失败才读下方旧记录。

## 旧阶段证据（保留）

分支：`codex/architecture-migration`。当前 S3 按活动领取：`3ece362`；此前领取边界：`13fb278`；活动绑定：`8df7c89`；尝试来源代码：`4160f26`；执行链绑定：`69b5faf`；S2 外壳边界：`b2de930`。先读本文件与当前代码，遇到具体失败才查旧日志。

## 已完成

- ADR 0046 选定 Temporal 作为目标恢复调度者，尚未切换生产。派发前持久记录尝试；重新通知只检查原启动历史，不再次启动。
- `69b5faf` 把 Temporal 首次 Run ID 与已确认交接一同保存。只读入口核对精确 Task/Run、控制层有效状态、可信引擎事实、已确认引用及首次 Run ID；它不授予操作权限，也未接入生产 Worker。
- `4160f26` 在唯一一次启动预留时保存新的 128 位尝试标识，只有不可变的 Temporal 启动输入与之相符才能确认；历史 NULL 尝试保持未解决。独立审查还让固定参考 Worker 的首次控制活动在模型/工具工作前核对已保存的标识。
- 对 `4160f26`：临时 PostgreSQL/HTTP 控制测试 258 项、定向派发/Temporal 测试 48 项、离线参考测试 14 项、真实 Temporal 交接 5 个场景和恢复 1 个场景通过。错误尝试标识的碰撞没有产生模型/工具调用；恢复流程只有一次模拟外部写入、一次核验查询。`npm run check` 通过；Turbo 的 lint/类型检查/测试任务 31 项中 29 项及构建 18 项全部命中缓存，仓库前置检查实际运行。细节见 `docs/research/work-temporal-journey.md` 和 issue #91。
- `8df7c89` 从真实 Temporal SDK 活动上下文和精确引擎 Run 的不可变启动事件取得身份，再通过只读 PostgreSQL 入口核对已保存的尝试标识与执行链。它不授予操作权限，尚未接入生产 Worker。临时 PostgreSQL/HTTP 测试 274 项通过、可选 SDK 文件跳过 1 项；同一夹具用固定版本 SDK 跑适配器测试 32 项通过。真实本地 Temporal 活动验证了当前 Run 与启动事件。`npm run check` 通过；Turbo lint/测试/构建任务命中缓存，仓库前置检查实际运行。
- `3ece362` 把真实 SDK Activity ID 纳入控制层领取标识。同一活动的有效重试复用租约；同一引擎 Run 的下一活动推进 epoch；过期或复用的 ID 保持拒绝。公开只读绑定入口仍自行读取 SDK 上下文；领取边界通过私有函数复用同一次快照。真实 Temporal 探针验证了重试与下一活动的 ID。临时 PostgreSQL/HTTP 测试 274 项通过、可选 SDK 文件跳过 1 项；同一夹具的固定版本 SDK 活动/领取测试 63 项通过，包含取消/撤权竞态。`npm run check` 通过，Turbo 任务命中缓存。生产 Worker 和外部操作授权仍未接线。
- S2 已把模板与产物保存移至 Web/Desktop 外壳适配器（`877b439`、`b2de930`），全面对齐仍未完成。工作流内直接调用工具端口会拒绝（`b0db90d`）。

## 未完成与约束

- 生产 Worker/Runtime 组合、细粒度检查点、批准、外部结果核验、多 Run 继续与崩溃恢复尚未验收。`experiments/work-journey/` 只是参考实现。
- S2 全面对齐、S4/TASK020 的真实 Linux/runsc 与其余审查问题、S5–S7 仍未完成。未跟踪的 `experiments/linux-execution/` 是候选，不是已验收产品代码。
- Python 控制层持有身份、授权、任务/动作事实、批准、预算与产物；Temporal 持有持久继续；Runtime 和 Worker 不产生授权。未知外部写入须通过权威查询核实，否则保持未知；取消或撤权不能重新授权。通过验收前不切换生产、不发布。
- 保留无关的模型服务依赖修改、`docs/OPEN_SOURCE_REUSE.md`、`docs/research/python-model-services.md` 和未跟踪 TASK020 候选。

## 下一阶段输入

读 `docs/research/work-temporal-journey.md` 最后一节、`apps/server-python/src/openbot_server/{work_dispatcher.py,work_handoff.py,temporal_engine.py,work_engine_binding.py,work_temporal_activity.py}`、`apps/agent-runtime-python/src/openbot_agent_runtime/{executor.py,sdk_ports.py}` 与 `experiments/work-journey/workflow_worker.py`。继续组合按 Run 隔离的生产 Worker、控制层授权及独立核验的外部操作；启用前验证多 Run 与崩溃恢复。不要把含外部副作用的整个 Run 包成可重试活动。
