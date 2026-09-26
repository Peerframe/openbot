# 持久执行方案验收实验

[English](README.md) · [简体中文](README.zh-CN.md)

这是 DBOS 3.0.0 的独立候选实验，不是 OpenBot 派发服务。使用真实 SIGKILL/进程重启、可销毁 PostgreSQL17.11 容器和回环 HTTP 假写入服务，不连接模型、用户数据库、私人配置或生产服务。尚未选定生产引擎；参见[源码审查](../../docs/research/durable-execution-qualification.md)。

## 运行

需要 POSIX 系统、Python3.12+ 和已启动的 Docker。使用独立环境：

```sh
python3 -m venv /tmp/openbot-durability-venv
/tmp/openbot-durability-venv/bin/python -m pip install -r experiments/durable-execution/requirements.txt
/tmp/openbot-durability-venv/bin/python experiments/durable-execution/probe.py
```

依赖固定为参考环境完整解析版本，不修改产品虚拟环境。数据库镜像固定摘要，容器使用唯一名称、回环端口和临时数据；正常及可捕获异常退出会清理容器与自建临时文件，不接受用户数据库地址。若父进程本身被强制杀死，可能留下 `openbot-durability-*` 测试容器。

## 实测与边界

2026-09-23 在 macOS/Python3.12.13＋Docker PostgreSQL 下，10 项通过：

| 场景 | 独立观察结果 | 说明 |
| --- | --- | --- |
| 检查点后杀进程再恢复 | 准备与写入各一次 | 已完成步骤不会重新执行 |
| 复用已完成工作流 ID | 没有额外写入 | 读取已存结果 |
| 无保护、写入后崩溃 | 写入两次 | 反例：关闭普通重试仍不能保证外部动作恰好一次 |
| 有保护、写入后崩溃 | 写入一次，要求核对 | 持久意图阻止盲目重复 |
| 有保护、写入前崩溃 | 零写入，要求核对 | 仅凭意图无法确定外部事实，保守阻止 |
| 执行进程退出时收到批准 | 恢复后写入一次 | 消息跨进程保留 |
| 批准恢复前撤权 | 零写入 | 动作读取当前权限 |
| 暂停旧进程、接管后恢复旧进程 | 旧进程仍可写入 | 反例：领域意图本身不能阻止外部旧写入 |
| 相同故障加执行端代次检查 | 旧写入被拒绝 | 执行入口须落实当前代次校验 |
| 同步动作执行中取消 | 已有写入保留，后续动作不发生 | 取消不能撤销已发生副作用 |

保护逻辑仅供实验，尚无生产租约、经过认证的隔离令牌、自动核对、生产权限/审批或安全升级策略；读取权限后再发送不能解决并发撤权。假写入服务在工作进程崩溃期间保持运行，它自身不是持久外部系统。“需要核对”会结束实验工作流，但真实 Task 必须保持未解决，不能显示成功。

尚未验证真实 Runtime、客户端重连、恶意代码隔离、性能、Linux Python 工作进程、引擎升级、真实网络分区恢复或多机部署。审批测试验证进程死亡后的恢复，不代表引擎自动释放闲置工作流；这些仍是选型门槛。

接管实验用 SIGSTOP 暂停仍存活的旧进程，模拟接管后 SIGCONT 恢复它，不测试自动故障发现。假执行端仅检查内存中的代次，不是生产凭证方案。最初让两个队列同时活跃的尝试超时，不能作为接管证据，已改为可复验的进程暂停场景。

## Temporal 对照实验

另建虚拟环境，安装 `requirements-temporal.txt`，并使用官方 Temporal CLI **1.9.1**
（应报告 Server **1.32.0**、UI **2.54.1**）。执行前核对官方发行包摘要；
[实验版本记录](../../docs/research/temporal-durability-review.md)包含已核对的 macOS arm64 摘要与源码版本。
实验不会自动下载二进制。

```sh
python3 -m venv /tmp/openbot-temporal-venv
/tmp/openbot-temporal-venv/bin/python -m pip install -r experiments/durable-execution/requirements-temporal.txt
/tmp/openbot-temporal-venv/bin/python -B experiments/durable-execution/probe_temporal.py --temporal-cli /path/to/verified/temporal
```

父程序启动只监听回环地址、无界面的临时开发服务，禁用 CLI 用户配置与环境加载；
工作流历史写入自建临时 SQLite，领域意图仍使用与 DBOS 相同的可销毁 PostgreSQL 和模拟 HTTP 服务。
安装 DBOS 只是复用其现有实验文件内的夹具，此实验不启动 DBOS，也不读取生产环境。
正常退出会清理自建服务、工作进程和夹具；父程序被不可捕获地杀死时可能留下测试进程、容器和临时文件，
所以只能使用合成数据。

此开发配置不代表生产持久化、认证、备份恢复、高可用、资源消耗或部署成本已验收。
引擎成功或失败不等于业务 Task 的结论；Worker 是可信测试代码，不是隔离 Agent Runtime。
最终引擎仍需经过完整任务流程及其他门槛后选择。

### Temporal 实测结果

2026-09-23，修正后的完整实验在 macOS/Python 3.12.13 下通过 **12 项**：

| 场景 | 独立观察结果 |
| --- | --- |
| 检查点后恢复 | 准备、写入、结束各一次 |
| 拒绝重新启动已完成 ID | 可读取原结果，没有第二次写入 |
| 无保护、写入后崩溃 | 写入两次 |
| 有保护、写入后崩溃 | 写入一次，等待核对，不执行结束步骤 |
| 有保护、写入前崩溃 | 零写入，等待核对，不执行结束步骤 |
| 工作进程退出期间批准 | 恢复后一次写入，相同决定重复投递 |
| 恢复前撤权 | 不写入，不执行结束步骤 |
| 批准后杀死并重启开发服务 | 从 SQLite 历史恢复后一次写入 |
| 屏蔽线程取消的旧动作在接管后恢复 | 旧动作仍写入，不执行结束步骤 |
| 相同动作增加执行端代次检查 | 拒绝旧写入，不执行结束步骤 |
| 单次尝试的动作写入后退出 | Activity 超时、引擎 FAILED，但外部写入存在 |
| 执行中取消 | 引擎 CANCELED，已有写入保留，不执行结束步骤 |

首轮在旧动作断言处失败：SDK 在 HTTP 发送途中注入了取消异常。修正后的成对用例仅对那个
不可中断动作段显式使用公开 `shield_thread_cancel_exception()`，不能据此声称普通 Temporal
线程总会忽略取消；普通取消用例保留 SDK 默认行为。首次失败与修正原因均已记录。
SIGSTOP 不是真实网络分区；相同批准重复投递也不代表到期、幂等和跨 Continue-As-New 均已验收。
