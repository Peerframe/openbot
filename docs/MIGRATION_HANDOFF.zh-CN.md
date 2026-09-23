# 架构迁移交接 — 2026-09-24

当前分支：`codex/architecture-migration`；已验证的 S3 代码基线为 `9ccaff5`。后续先读本交接和下列文件；只有出现具体失败时再查旧日志。

## 本阶段已完成

- ADR 0046 选定 Temporal 作为**目标**恢复调度者，生产切换尚未开启。已关闭工作流的仅查询修复参考实现位于 `6e7cffd`。
- `9ccaff5` 在首次请求 Temporal 启动前持久记录派发尝试；重复通知只查原工作流历史，不允许二次启动。未确认 Task/Run 可精确查询，不会被待处理列表遮住；历史缺失仍保持未解决。受影响控制层 189 项、参考测试 61 项、公开 HTTP/PostgreSQL/开发版 Temporal 的四项交接场景实际通过。PostgreSQL/mTLS 的交接及恢复场景在最后一次精确查询小改动前通过，此读路径改动后未重跑。`npm run check` 通过，其中 Turbo 有缓存命中。
- TASK028 的有界输出候选位于本地未跟踪的 `experiments/linux-execution/`。独立审查修正了 CLI 输出管道未关闭仍报成功、镜像检查结果未知却报不存在的问题。在该目录实际运行 `python3 -m unittest test_sandbox`：133 项通过。`sandbox.py` SHA-256 为 `0815cb3fb4329e04522eaf9f054d973fbfe38b5335dd37bb1c1cf3a7ede8b5c5`；`test_sandbox.py` 为 `a840a2153e90dadf534fcba808c0035241811d5d261f6536681c6937fea9a314`。

## 未完成

- S3：生产 Temporal 派发、真实 Python Runtime 的细粒度检查点、批准与核验操作、恢复验收。`experiments/work-journey/` 的固定 CSV 流程只是参考实现。
- S4/TASK020：真实 Docker 日志行为、Linux/runsc 隔离及其余审查问题。模拟测试通过不代表 TASK020 验收或真实执行授权。
- S2 客户端/API 对齐及 S5–S7 仍未完成。保留无关的模型依赖未提交文件和 TASK020 未跟踪候选，不将其作为已验收产品代码合入 main。

## 有效约束与下一步输入

Python 控制层拥有身份、授权、任务/动作事实、批准、预算及产物；Temporal 独自负责持久继续；Runtime 和 Worker 不产生授权。未知外部写入只能凭权威查询核实，否则保持未知。验收前不盲目重试、不设第二写入者、不切生产、不发布。

下一步 S3 只需先读 `docs/decisions/0046-temporal-as-recovery-owner.md`、`apps/server-python/src/openbot_server/work_handoff.py`、`apps/agent-runtime-python/src/openbot_agent_runtime/executor.py`、`experiments/work-journey/{dispatch.py,workflow_worker.py}`，并按所选改动读取对应测试和失败片段。
