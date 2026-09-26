# 原生 Task 产品验收

[English](README.md) · [简体中文](README.zh-CN.md)

2026-09-25 实际运行 Owner HTTP、PostgreSQL、ProductWorkRuntime 和 mTLS Temporal，仅模型 transport 为合成。Owner 明确授予 CSV 附件、已启用记忆与一位同事的 scope；父 Task 读取附件/记忆，创建真实子 Task 并消费其持久结果，准备待审知识提案，经过父子独立内容审阅后发布 192 字节报告。

完成事务提交、Activity 确认丢失处杀掉 API/Worker，再启动后原 Temporal Run 恢复相同结果。10 个模型阶段各执行一次。Owner HTTP 接受提案后保留真实 Task/WorkRun 来源，模型使用仍关闭。SQL 验证唯一子 Task/提案/完成事件，没有伪造频道关系、legacy Run 或 work_sources。独立 Web/FastMCP 合成用例覆盖 scope、批准、撤权和不重发，不冒充它们参加了该 Temporal 主流程。

## 离线回归

使用已固定 Worker 环境：

```sh
apps/server-python/.worker-venv/bin/python -B experiments/work-journey/product_native_replay.py
```

此入口不建网络客户端、不注册 Activity、不读凭据、不启动 Docker，也不调用模型。两条实际父子历史仅替换 Worker identity 与 sticky queue 名称，去掉主机 metadata；普通 queue、事件 ID、Workflow 命令、payload 与观察结果不变。`evidence.json` 保留原文件/导出文件哈希及替换计数，排敏后按原 Workflow ID 使用官方 SDK Replay 已通过。内容均为合成。

## 新建 mTLS 验收

准备[既有旅程](../README.zh-CN.md)要求的固定 Worker、Node 依赖、Docker Compose、OpenSSL 与已审查镜像。显式提供独占合成 fixture：0600 JSON 含 `dsn` 和 `ownerName`；数据库只能是 loopback 的 `openbot_control_test_*`，必须完成 canonical migration 且没有 Work Task。输出目录必须全新或空。

```sh
apps/server-python/.worker-venv/bin/python -B experiments/work-journey/product_native_probe.py \
  --repo . --fixture "$OPENBOT_NATIVE_FIXTURE" --output "$OPENBOT_NATIVE_OUTPUT"
```

只创建一个自有引擎，复用资源上限：Temporal 1536 MiB / 2 CPU，PostgreSQL 512 MiB / 1 CPU，schema 初始化 512 MiB / 1 CPU。finally 结束自有 API/Worker 并删除该引擎容器/卷。合成 SQL 证据保留，由 fixture 所有者审阅后统一处理。输出目录含合成私密配置与 TLS key，只能发布明确白名单，不能整目录入库。失败/unknown Action 不可重置后重发，重新验收应换全新独占 fixture。

可入库脚本保留成功流程，仅将临时 packet overlay 和绝对路径替换成显式 CLI 输入与当前 checkout。此包装形态已重新验证语法、CLI 和排敏历史 Replay；没有重复完整引擎旅程，原实际 HTTP/PG/mTLS 证据记录于 `evidence.json`。

复用[原生能力研究](../../../docs/research/python-native-task-capabilities.md)及既有 OpenBot probe，没有新依赖、runtime、业务执行器或外部源码复制。原许可证和 Hermes 学习归因保持。验收控制端是 macOS、服务为 Docker Linux；不声称 Linux 主机、真实模型质量、外部业务效果或 UI 已由本例证明。
