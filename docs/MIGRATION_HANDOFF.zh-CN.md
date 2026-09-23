# 架构迁移交接 — 2026-09-24

当前分支：`codex/architecture-migration`；最新已验证的 S3 代码为 `15c5a98`，S2 外壳代码为 `b2de930`。后续先读本交接；只有出现具体失败时再查旧日志。

## 本阶段已完成

- ADR 0046 选定 Temporal 作为**目标**恢复调度者，生产切换尚未开启。已关闭工作流的仅查询修复参考实现位于 `6e7cffd`。
- `9ccaff5` 在首次请求 Temporal 启动前持久记录派发尝试；重复通知只查原工作流历史，不允许二次启动。未确认 Task/Run 可精确查询，不会被待处理列表遮住；历史缺失仍保持未解决。受影响控制层 189 项、参考测试 61 项、公开 HTTP/PostgreSQL/开发版 Temporal 的四项交接场景实际通过。PostgreSQL/mTLS 的交接及恢复场景在最后一次精确查询小改动前通过，此读路径改动后未重跑。`npm run check` 通过，其中 Turbo 有缓存命中。
- `877b439` 把员工模板保存方式移入 Web/Desktop 外壳适配器；共享 API 只获取和校验文件，不再依赖 Desktop bridge 或操作 DOM 保存。受影响的 28 项测试、Web 类型检查及 `npm run check` 通过；这不等于 S2 客户端全面对齐。
- `b2de930` 把产物保存从 `ArtifactCard` 移入 Web/Desktop 外壳适配器。dsh 在隔离副本交付四个限定文件，Codex 审查并集成。定向 15 项测试与 Web 类型检查在隔离副本和集成分支都实际运行通过；集成后的 `npm run check` 通过（18 个 Turbo 任务中 17 个命中缓存）。浏览器下载、PNG 预览、Desktop 保存及状态提示仍有覆盖；S2 全面对齐尚未完成。
- `b0db90d` 拒绝在 Temporal 工作流中直接使用 OpenBot 工具端口。真实本地 Temporal 探针显示：直接挂载 `PortToolset` 虽返回工具结果，但没有工具活动；构造时注册的 `DynamicToolset` 则记录 `call_tool` 活动和一次可信端口调用。加入保护后，直接路径以零次可信调用拒绝，动态路径仍通过。Python Runtime 相关测试实际运行 419 项通过，`npm run check` 通过但 Turbo 有缓存命中。这是安全边界，不是生产 Runtime 集成。
- `15c5a98` 将单个 Run 的引擎交接决策放入 Python 控制层，并让现有真实 Temporal 参考流程调用。dsh 交付限定的控制模块；Codex 修正测试预期、保留引擎检查异常、绑定实际引擎命名空间并独立验收。最终候选的 25 项控制测试、2 项离线派发检查、4 项公开 HTTP／PostgreSQL／开发版 Temporal 交接场景及完整恢复流程通过（一次外部写入、一次核验查询）。取消且结果未知的流程在添加命名空间检查前通过，之后未重跑。Python 控制层检查为 836 项通过，189 项 PostgreSQL 测试因未启用专用夹具而跳过；`npm run check` 通过但 Turbo 命中缓存。生产 Temporal Worker、真实 Python Runtime 组合与默认派发仍缺失。
- TASK028 的有界输出候选位于本地未跟踪的 `experiments/linux-execution/`。独立审查修正了 CLI 输出管道未关闭仍报成功、镜像检查结果未知却报不存在的问题。在该目录实际运行 `python3 -m unittest test_sandbox`：133 项通过。`sandbox.py` SHA-256 为 `0815cb3fb4329e04522eaf9f054d973fbfe38b5335dd37bb1c1cf3a7ede8b5c5`；`test_sandbox.py` 为 `a840a2153e90dadf534fcba808c0035241811d5d261f6536681c6937fea9a314`。

## 未完成

- S3：生产 Temporal 派发、真实 Python Runtime 的细粒度检查点、批准与核验操作、恢复验收。`experiments/work-journey/` 的固定 CSV 流程只是参考实现。
- S4/TASK020：真实 Docker 日志行为、Linux/runsc 隔离及其余审查问题。模拟测试通过不代表 TASK020 验收或真实执行授权。
- S2 客户端/API 对齐及 S5–S7 仍未完成。保留无关的模型依赖未提交文件和 TASK020 未跟踪候选，不将其作为已验收产品代码合入 main。
- S3 的 Runtime 组合仍需按 Run 序列化的依赖、构造时注册的动态工具集，以及由控制层持有的授权、用量、动作事实与外部结果核验。不能把单次 `BoundedExecutor` 整体包成可重试活动，因为一次运行可能包含外部副作用。临时探针未验证多 Run 隔离、崩溃恢复或产品派发。

## 有效约束与下一步输入

Python 控制层拥有身份、授权、任务/动作事实、批准、预算及产物；Temporal 独自负责持久继续；Runtime 和 Worker 不产生授权。未知外部写入只能凭权威查询核实，否则保持未知。验收前不盲目重试、不设第二写入者、不切生产、不发布。

下一步 S3 先读 `docs/research/work-temporal-journey.md` 最后两节、`apps/server-python/src/openbot_server/{work_dispatcher.py,work_handoff.py}`、`apps/agent-runtime-python/src/openbot_agent_runtime/{executor.py,sdk_ports.py}` 和 `experiments/work-journey/workflow_worker.py`。继续实现按 Run 隔离的生产引擎／Runtime 组合与控制层活动，不把固定参考策略当成产品。保留无关的模型服务未提交文件与 TASK020 未跟踪候选。
