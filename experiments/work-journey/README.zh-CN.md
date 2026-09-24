# 公开工作流程与恢复参考实现

[English](README.md) · [简体中文](README.zh-CN.md)

真实 Python 控制层 API/存储现已接通 Runtime 的可选 Temporal 组合入口。PortModel/PortToolset
执行脚本化模型和读取步骤；延迟写入提案回到既有控制层审批、效果核验和产物发布流程。
加载端口前及每次授权检查时，类型化 Run 参数均与实际已接纳的引擎身份核对；逐 Activity
守卫不替代控制层持久预算。Temporal 已由 ADR0046 选定为目标恢复引擎，但未启用生产默认，
原 stdin/stdout 进程协议保持独立。这仍是固定脚本任务，不是通用产品 Worker 或真实模型接入。
见[研究](../../docs/research/work-temporal-journey.md)。

首个只读活动现通过产品启动加载器等待交接确认，支持 Worker 已先运行；独立重试累计上限
为 120 秒，身份或权限拒绝不会重试。`--only-case worker-before-ack` 要求观察真实 pending
失败和零端口调用，重启后确认并完成；`--only-case cancel-before-ack` 验证迟到确认不能撤销取消。

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
正常退出和失败均清理自建子进程与容器。`--only-handoff` 运行一项未确认历史用例和三项引擎身份冲突用例。

## 发行版 Server 与 PostgreSQL

将 `--temporal-cli` 替换为 `--engine postgres-mtls`（PATH 需有 OpenSSL），在[固定镜像配置](../../deploy/temporal/README.zh-CN.md)
上运行当前场景矩阵。另检查 schema/运行账户权限、等待批准时引擎和数据库 SIGKILL，并在业务库已经
保存未知写入后，把较旧引擎备份恢复到新卷。namespace 与当前公开 Task 状态保持；成功仍为五次 POST、
一次写入、11 假定用量。38 项参考、维护、重放与传输单元检查通过，mTLS PG 流程已接入现有 Linux Python CI。

这是本地 Docker 的真实 PostgreSQL 持久化证据，不是生产选型、完整产品备份或原生 Linux 隔离验收。
CLI/SQLite 路径仍保留为回归基线；维护限制和其余升级/安全门槛见配置说明。

mTLS 配置拒绝明文、无证书、未知 CA 和错误服务端名称；在等待批准时停止服务并更换客户端 CA，
新证书恢复原工作流，旧证书被拒绝。这只认证受信控制客户端，不是按 API 分权。
`--engine postgres` 保留为明文对照。恢复用例通过官方 Replayer 和同版 SDK 插件，在内存中重放真实
等待/完成历史；故意改变首个命令必须产生 NondeterminismError。业务快照和假 HTTP 计数必须不变；
不注册活动、不导出历史。这不证明任意未来工作流或 SDK 升级兼容。

## 相邻引擎版本

完整 `postgres-mtls` 命令追加 `--upgrade-archive /absolute/path/to/temporal_1.31.3_linux_<architecture>.tar.gz`，
不能与 `--only-handoff` 混用。[配置说明](../../deploy/temporal/README.zh-CN.md)记录来源、不可跳过的
600秒旧版健康观察、相同 schema 内容及原卷升级/旧快照恢复的独立检查。新增两个任务分别覆盖等待
批准和已提交发布，各跨越两阶段，增加四条结果记录；当时的原八项流程在同次运行中执行，各边界重放不
产生新副作用；新增的核对场景尚未经过相邻版本验收。这是停机的1.31.3到1.32.0验收，不是通用自动升级服务。

## 验收范围

| 场景 | 检查结果 |
| --- | --- |
| 完整恢复 | 通过公开接口登录、创建 Bot/Task；派发前及引擎接收后杀进程；重试只确认同一工作流；等待批准时杀 Worker，无 Worker 时批准；API 重启后快照一致；写入成功但响应丢失，公开状态保留核对提示和预算；Worker 与假外部服务重启后 GET 核对，独立读回 CSV，再发布并认证下载 |
| 写入前取消 | 等待批准时取消，恢复后不写入、不再调用最终模型、不生成产物 |
| 未知结果时取消 | 已发生写入保留，核对后记实际用量并结束取消，不产生最终模型调用或产物 |
| 损坏回执 | 内容不匹配使引擎活动失败；业务 Task 仍待核对，预留不退款、不重复 POST、不虚报完成 |
| 损坏回执后的显式核对 | Owner 经公开接口提交仅查询回执的命令；首次无法核实仍保留 unknown 和预留，下一轮独立核实后结束同一 Action，外部只写一次 |
| 异常 JSON 后核对 | 无法解析或嵌套过深的响应不算成功；保留待核对状态与预留，随后查到既有写入才结束 |
| 核对超时 | 有界的引擎活动连续超时后仍保持 unknown；之后核实回执，不重做写入 |
| 自动/人工核对竞态 | 自动核实和 Owner 命令归并同一 Action/命令，不重复完成或写入 |
| 取消后的核对 | 可补记既有写入及真实用量，但不恢复授权、不发布已取消的 Task |
| 已关闭引擎 | Owner 的持久命令可启动单独的仅查询工作流，不重启原 Agent。错误回执仍保留 unknown；修复回执后需新命令核实原写入，不发生第二次 POST |
| 发布确认丢失 | 发布提交后、活动确认前杀 Worker；恢复验证同一完成结果，不重新取得执行权限，不重复产物/事件/外部请求 |
| 交接身份冲突（三项） | 相同引擎 ID 但输入、类型或队列不同，不能确认交接；输入范围冲突另启动真实 Worker，验证没有产品动作 |

成功流程只有五次 POST：三次脚本模型、一次读取、一次写入；外部写入一次，假定用量 11。
写入前取消为三次请求、零写入、用量 6；未知结果时取消为四次请求、一次写入、用量 8。
损坏回执仍为已花费 6、预留 2。计数独立记录每次 POST，不能用假外部服务去重掩盖重复请求；这些不是实际模型账单。

产品 `HandoffStore` 在联系 Temporal 前，先在 Task 锁内持久记录唯一派发尝试；分别列出未派发与已尝试但未确认的记录，只确认与原记录相符的引擎回执。回执丢失后只能查询原工作流历史，不能再次发送启动请求；历史缺失时保持未解决。本检查点受影响的 PostgreSQL/HTTP 控制层测试实际通过 189 项。
实验派发器只处理显式配置的 Task，并按 Task/Run 精确查找此前的派发尝试；不能当作通用生产派发器或第二套恢复调度器。
派发器通过引擎启动事件验证接收，不依赖 Worker 在线；工作流也在第一个模型/工具或控制状态修改之前，通过受信活动独立核验启动身份。工作流 ID 唯一性受命名空间和历史保留范围约束。

参考派发器现在调用产品控制层的 `work_dispatcher.dispatch_one`，完成单个 Run 的交接决策。注入的 Temporal 适配器核对启动事件与实际命名空间，参考流程仍保留故障注入屏障。这并未安装生产派发器，也未把固定策略接入真实 Python Runtime。

派发记录已提交但尚未发送时发生崩溃的定向场景中，重送找不到历史，任务保持未确认，且没有创建替代工作流。此场景与三种启动身份冲突，在开发引擎和 PostgreSQL/mTLS 引擎上均通过；恢复主场景在两种引擎上都只有一次外部写入。此次没有重跑历史场景全矩阵。

## 仍待完成

本地证据只覆盖固定 CSV 流程的真实进程恢复与产品状态持久化。真实模型质量、任意工具、Linux 隔离、
Temporal 生产部署授权/PKI、历史保留、完整产品备份恢复、版本升级、扩展、资源费用和真实网络分区尚未验收。
本次客户端是认证 HTTP 重连，浏览器/SSE 和共享客户端仍待实现。引擎重试耗尽不等于业务成功或预算退款；
公开 Owner 核对入口也可为已关闭的参考工作流启动单条命令的历史核查；这只补记 Action 事实，不恢复原 Agent、不自动完成 Task，也不构成生产派发器验收。文件配额、回收及存储耐久性仍未完成。

此前固定流程候选在开发引擎与 PostgreSQL/mTLS 引擎各通过 15 项场景，包括旧引擎冷备份恢复后重新通知已送达、未完成的命令。新增的已关闭历史核查在两种引擎上各通过一次定向公开 API/PostgreSQL/Temporal 流程，包含送达确认丢失与两轮显式查询；接入 Activity→Action 后，研究末节标识的候选已通过完整 16 项开发引擎场景；该候选尚未重跑 PostgreSQL/mTLS 矩阵和相邻版本升级。外部服务为受控假件，不是 Linux/runsc 隔离验收。

此前显式相邻版本路径已在 arm64 通过 12 项流程记录、57 项参考单元检查和 11 份历史重放。
范围是 PG schema 相同的 1.31.3 -> 1.32.0 停机升级；amd64 CI 和更广版本/工作流代码兼容仍待验证。

## 共享 Worker 验收

`--only-case concurrent-runs` 使用同一个 Worker、Agent 和队列，进程配置不含固定 Task/Run ID。
仅供 Worker 使用的 `work_runtime_ports` 工厂按每次 Activity 重新读取已确认的任务上下文和可信服务，
在配置加载后复核权限、分离嵌套 schema，并区分提供给模型和可内联执行的工具。
服务装配不能执行副作用；回调仍须经过控制层持久 Action 准入与结算，Activity 计数不是整个 Run 的预算。
普通 HTTP 服务启动不导入该可选组合。

真实 API 创建目标和额度不同的两个任务，确认两个工具 Activity 在首次尝试中同时执行，再取消其中一个。
被取消任务的下一次操作被拒绝；另一个任务独立完成、结算用量并下载自己的文件。
两段历史离线重放均不能改变状态或重复操作。这里证明的是脚本端口下的取消、路由和记账隔离，
没有验证低额度拒绝、真实模型、通用操作标识、发布时重启或 Linux/runsc。
`multitask_worker.py` 中固定操作键和发布流程属于测试夹具，没有激活生产 Worker。
使用上文固定版本开发 CLI，或 `--engine postgres-mtls`；CI 已包含后者。


## 模型回复持久化验收

可选 SDK 配置安装 `requirements-model.txt`，然后执行
`python -B experiments/work-journey/probe.py --engine postgres-mtls --only-case model-receipt-recovery`。
使用已发布 SDK 与合成 HTTP，不使用真实凭据。公开 Task 在回复保存后经历 Worker 中断，旧 claim
过期后仍复用原回复、不重复请求，结算一次并交付文件。缺失／损坏回执与取消反例位于
`apps/server-python/tests/test_work_model_receipts_postgres.py`；向已有控制层数据库 runner 提供
`OPENBOT_TEMPORAL_TEST_PYTHON` 指向独立 SDK 环境。见[审查边界](../../docs/research/work-model-ports.md)。
新引擎 Run 链、产品配置及真实模型效果仍需分别验收。

## 产品 Worker 恢复用例

可选 `openbot_server.work_worker.product_worker` 使用一个产品 Workflow/Agent，要求显式提供
可信服务加载器与独立结果核验器。产品代码不依赖实验目录；此处回调仍为合成夹具。
`product-model-recovery` 在模型结果落盘后、引擎确认前终止 Worker。
`product-publication-recovery` 从实际产品 CLI 派发，在核验后的产物提交成功、发布确认前终止 Worker；
恢复时任何服务加载或重新核验都会使测试失败，必须回读原结果。110 秒等待覆盖真实的 75 秒 Activity 超时。
两个用例均用 `--engine postgres-mtls --only-case <用例名>`；完整安装与执行命令见英文页。

产品依赖入口是 `apps/server-python/requirements-worker.txt`，实验环境另需夹具依赖。
运维命令为 `python -I apps/server-python/scripts/dispatch-work.py --config /绝对路径/operator.json`；
`--check` 仅检查本地结构与文件权限，不验证 TLS 连通性。
私有 JSON 必须包含 `database_url`、`temporal_address`（host:port）、`namespace`、`queue`，
以及 `tls` 的 `ca`、`certificate`、`key` 绝对路径和 `server_name`。
可选 `limit` 为 1–64（默认16），`execution_timeout_seconds` 为 1–86400（默认3600），
`item_timeout_seconds` 为 1–30（默认10）。配置与密钥须归当前用户且不向其他用户开放；
所有 TLS 文件须为当前用户拥有的普通文件，并拒绝其他用户写入。
CLI 不迁移数据库、不启动 Worker；可信部署代码必须显式组合回调。
退出0表示本轮全部交接已确认（包含无待交接项），退出2表示仍有未确认/错误项，退出1表示调用拒绝或失败。
这些状态不代表任务已完成；重复命令沿用既有交接历史核对契约。

本验收不代表已切换默认后端、已验证任意任务结果、已配置生产服务、已完成通用批准/纠正续跑，
也不是 Linux/runsc 隔离证据。

`product-concurrent-runs` 在产品 Worker 上复用原有双任务取消契约，采用脚本化端口，
保留预算、动作计数及产物的既有断言。


### 延期审批恢复

`--engine postgres-mtls --only-case product-deferred-approval` 使用合成模型/效果服务和真实
公开 HTTP、PostgreSQL、Temporal 验证产品 Worker。Action 提交后、准备回执返回前终止 Worker，
在 Worker 离线时批准，再禁用规划器重启：只能复用原 Action。异常收据保持 unknown 与预算预留；
已持久化的人工命令随后仅查询原动作。另一任务在批准后取消，不能写入。拒绝会关闭任务，并在
关闭事务提交但回执未返回时再次重启，验证终态读回。检查包含实际 Activity 重试、公开文件下载、
预算结算及无额外副作用的历史回放。

局部 Workflow 检查命令：`python -B -m pytest -q experiments/work-journey/test_product_deferred_workflow.py`。
现有临时 PostgreSQL 验证器在 `OPENBOT_TEMPORAL_TEST_PYTHON` 指定固定版本 Worker 环境时包含延期测试。
这里不验证真实模型账户或 Linux/runsc 隔离。候选与失败见[研究记录](../../docs/research/work-deferred-approval.md)。

### 关闭工作流的核对恢复

`--engine postgres-mtls --only-case product-closed-repair` 使用真实运维 CLI、公开 HTTP、
PostgreSQL 和合成模型／效果服务。unknown 任务取消且原 Workflow 关闭后，首个错误回执命令
结束为 unresolved，预算继续保留；新的人工命令核实原写入。核验提交但确认未返回时终止 Worker，
替代 Worker 禁用 lookup；原 Activity 重试须完成，且不能调度兜底 finish Activity 或再次核对。
原流程和两个修复流程历史均作无副作用回放。本流程只恢复历史事实，不恢复 Agent 执行，
也不证明真实服务或 Linux 隔离。运维 `--repair-closed` 模式要求同一产品 Worker 配置
`load_lookup`；送达、结束和等待原流程分开，退出码 0 不表示外部动作成功。
见[候选证据](../../docs/research/work-closed-repair.md)。

### 执行中纠正恢复

`--engine postgres-mtls --only-case product-owner-corrections` 使用真实公开 API、PostgreSQL、
Temporal 与脚本模型验证显式启用的纠正配置。三个并发任务分别覆盖提案准备中纠正、unknown 动作
等待中纠正，以及模型准入前、模型收据落盘后、发布核验中的纠正。自有测试 Worker 的故障注入要求
保留原模型收据、作废提案、完整工具调用配对、只读核对命令和准确的发布回执；历史重放不能产生副作用。
命令落盘不代表语义质量保证，仍保留完整历史大小限制；不涉及真实账号或 Linux 隔离。
范围和证据见[研究记录](../../docs/research/work-owner-corrections.md)。
