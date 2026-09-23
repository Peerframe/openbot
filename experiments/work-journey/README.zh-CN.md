# 公开工作流程与恢复参考实现

[English](README.md) · [简体中文](README.zh-CN.md)

将真实 Python 控制层 API/存储与 Pydantic AI 官方 Temporal 适配器接通。受信工作流策略调用控制层活动；
没有选定生产引擎、启用默认派发，也未自动连接现有 stdin/stdout Runtime。见[研究](../../docs/research/work-temporal-journey.md)。

## 运行

需要 POSIX、Node22+、Docker、Python3.12。安装仓库 npm 依赖，按照 Python 控制层 README 准备其环境，
并构建 `@openbot/db`。Temporal CLI1.9.1 的版本和校验依据见[固定参考环境](../../docs/research/temporal-durability-review.md#executable-probe-profile-2026-09-23)。
另建实验环境，完整命令见英文页；核心命令为：

```sh
python3.12 -m venv /tmp/openbot-work-reference
/tmp/openbot-work-reference/bin/python -m pip install -r experiments/work-journey/requirements.txt
/tmp/openbot-work-reference/bin/python -B -m unittest discover -s experiments/work-journey -p 'test_*.py' -v
/tmp/openbot-work-reference/bin/python -B experiments/work-journey/probe.py --temporal-cli /absolute/path/to/temporal
node scripts/test-python-control.mjs
```

程序创建临时 PostgreSQL17.11 容器、使用临时 SQLite 的回环 Temporal Server1.32.0、真实控制层 HTTP 服务，
以及使用独立 SQLite 保存 CSV 与回执的假外部服务。使用随机测试凭据与专用目录，不读取 dotenv 或真实账号；
正常退出和失败均清理自建子进程与容器。`--only-handoff` 仅运行三项引擎身份冲突用例。

## 发行版 Server 与 PostgreSQL

将 `--temporal-cli` 替换为 `--engine postgres-mtls`（PATH 需有 OpenSSL），在[固定镜像配置](../../deploy/temporal/README.zh-CN.md)
上运行同样八项场景。另检查 schema/运行账户权限、等待批准时引擎和数据库 SIGKILL，并在业务库已经
保存未知写入后，把较旧引擎备份恢复到新卷。namespace 与当前公开 Task 状态保持；成功仍为五次 POST、
一次写入、11 假定用量。38 项参考、维护、重放与传输单元检查通过，mTLS PG 流程已接入现有 Linux Python CI。

这是本地 Docker 的真实 PostgreSQL 持久化证据，不是生产选型、完整产品备份或原生 Linux 隔离验收。
CLI/SQLite 路径仍保留为回归基线；维护限制和其余升级/安全门槛见配置说明。

mTLS 配置拒绝明文、无证书、未知 CA 和错误服务端名称；在等待批准时停止服务并更换客户端 CA，
新证书恢复原工作流，旧证书被拒绝。这只认证受信控制客户端，不是按 API 分权。
`--engine postgres` 保留为明文对照。恢复用例通过官方 Replayer 和同版 SDK 插件，在内存中重放真实
等待/完成历史；故意改变首个命令必须产生 NondeterminismError。业务快照和假 HTTP 计数必须不变；
不注册活动、不导出历史。这不证明任意未来工作流或 SDK 升级兼容。

## 验收范围

| 场景 | 检查结果 |
| --- | --- |
| 完整恢复 | 通过公开接口登录、创建 Bot/Task；派发前及引擎接收后杀进程；重试只确认同一工作流；等待批准时杀 Worker，无 Worker 时批准；API 重启后快照一致；写入成功但响应丢失，公开状态保留核对提示和预算；Worker 与假外部服务重启后 GET 核对，独立读回 CSV，再发布并认证下载 |
| 写入前取消 | 等待批准时取消，恢复后不写入、不再调用最终模型、不生成产物 |
| 未知结果时取消 | 已发生写入保留，核对后记实际用量并结束取消，不产生最终模型调用或产物 |
| 损坏回执 | 内容不匹配使引擎活动失败；业务 Task 仍待核对，预留不退款、不重复 POST、不虚报完成 |
| 发布确认丢失 | 发布提交后、活动确认前杀 Worker；恢复验证同一完成结果，不重新取得执行权限，不重复产物/事件/外部请求 |
| 交接身份冲突（三项） | 相同引擎 ID 但输入、类型或队列不同，不能确认交接；输入范围冲突另启动真实 Worker，验证没有产品动作 |

成功流程只有五次 POST：三次脚本模型、一次读取、一次写入；外部写入一次，假定用量 11。
写入前取消为三次请求、零写入、用量 6；未知结果时取消为四次请求、一次写入、用量 8。
损坏回执仍为已花费 6、预留 2。计数独立记录每次 POST，不能用假外部服务去重掩盖重复请求；这些不是实际模型账单。

新增产品 `HandoffStore` 只保存控制层的引擎接收事实：有界读取、Task 锁内确认与审计、同回执幂等、冲突拒绝。
22 项新增数据库测试已接入现有脚本，本检查点真实 PG/HTTP 检查共 141 项。
实验派发器只处理有界列表中显式配置的 Task，不能当作通用生产派发器或第二套恢复调度器。
派发器通过引擎启动事件验证接收，不依赖 Worker 在线；工作流也在第一个模型/工具或控制状态修改之前，通过受信活动独立核验启动身份。工作流 ID 唯一性受命名空间和历史保留范围约束。

## 仍待完成

本地证据只覆盖固定 CSV 流程的真实进程恢复与产品状态持久化。真实模型质量、任意工具、Linux 隔离、
Temporal 生产部署授权/PKI、历史保留、完整产品备份恢复、版本升级、扩展、资源费用和真实网络分区尚未验收。
本次客户端是认证 HTTP 重连，浏览器/SSE 和共享客户端仍待实现。引擎重试耗尽不等于业务成功或预算退款；
生产需要明确的未决任务核对/恢复入口。文件配额、回收及存储耐久性仍未完成。
