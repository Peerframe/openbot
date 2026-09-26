# 独立 mTLS 终态验收

探针复用仓库已集成的 ProductWorkService、OpenBotWork 和既有合成审批/HTTP 工具夹具，
不实现另一套 Workflow、调度器或模型 provider；不使用付费模型或外部账号。

使用已锁定的 Worker Python：

```
python -B experiments/work-journey/terminal-recovery/probe.py --repo /absolute/openbot --fixture /private/terminal.json --output /empty/private/output
```

夹具仅限明确分配的 loopback `openbot_control_test_terminal_<suffix>` 数据库，须已应用
canonical migrations，且运行前没有 WorkTask。探针使用其中的合成 Owner token/Bot，
不打印凭据、不改变迁移历史。`deploy/temporal` 的三个 digest 锁定镜像须已在本机。

运行时新建随机独占 Compose project/history volume 和临时私有 mTLS 证书；最多同时
一个产品 Worker 进程、一个 loopback 合成 HTTP 服务。资源上限分别为 Temporal
1536 MiB/2 CPU、引擎 PostgreSQL 512 MiB/1 CPU、瞬时 schema 工具 512 MiB/1 CPU。
不停止共享 Control PostgreSQL，不访问其他库、项目、卷、VPS 或已安装应用。

覆盖三个场景：先执行一次已批准的合成写入，丢弃响应并使回执读取失效，再停止产品进程。
TERMINATED 场景终止真实精确 engine Run；TIMED_OUT 场景等待真实 35 秒 execution
超时事件；ACK 丢失场景在收尾 SQL 提交后暂停并 SIGKILL。每次重启产品服务都必须只收尾
一次，保留 unknown 预算、原 Run、原 Action 和原回执，不重复 POST、claim 或退款。
首个场景还恢复合成回执，通过既有 Owner reconciliation/ClosedRepair 仅查询结算；
Task 保持 failed，原终态回执不随结算改写。

三个原始历史和 Owner lookup 历史随后全部做 SDK 离线 Replay，并检查 SQL 快照及 HTTP
计数不变。finally 清理精确独占容器、卷、进程、HTTP 服务以及本轮跟踪的 Task/查询记录；
清理后移除生成的证书与含凭据配置。证据不包含证书、密钥或配置内容，不应整目录复制
私有运行输出，只保留最终 manifest 列出的脱敏证据和合成历史。

首轮探索曾使用旧的 repair Workflow 前缀读取历史；现已改为导入产品 PREFIX。首轮清理
也遗漏了 reconciliation 外键删除顺序；已修正并独立确认清理完毕，随后完整重跑通过。
这些均为探针问题，验收期间产品文件保持不变。
