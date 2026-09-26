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
`OPENBOT_TEMPORAL_TEST_PYTHON` 指向下节的精确 Worker 环境，不能混装旧 DBOS 实验依赖。见[审查边界](../../docs/research/work-model-ports.md)。
新引擎 Run 链、产品配置及真实模型效果仍需分别验收。

## 产品 Worker 恢复用例

可选 `openbot_server.work_worker.product_worker` 使用一个产品 Workflow/Agent，要求显式提供
可信服务加载器与独立结果核验器。产品代码不依赖实验目录；此处回调仍为合成夹具。
`product-model-recovery` 在模型结果落盘后、引擎确认前终止 Worker。
`product-publication-recovery` 从实际产品 CLI 派发，在核验后的产物提交成功、发布确认前终止 Worker；
恢复时任何服务加载或重新核验都会使测试失败，必须回读原结果。110 秒等待覆盖真实的 75 秒 Activity 超时。
两个用例均用 `--engine postgres-mtls --only-case <用例名>`；完整安装与执行命令见英文页。

产品验收必须在新建虚拟环境安装 `apps/server-python/requirements-worker.lock`，执行 `pip check` 和
`verify_environment.py --worker`，核对精确63项依赖；完整命令见英文页。该锁已包含 Temporal 夹具依赖，
共享辅助模块仅在调用独立 DBOS 实验时导入 DBOS，不得向产品环境添加旧实验 requirements。
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

## 产品媒体与完成后配对恢复

`product_media_probe.py` 使用实际产品 `serve.py`、Owner HTTP 上传与频道提交、PostgreSQL、
双向认证的 Temporal 服务和 Worker；仅外部模型传输使用合成响应。OpenAI Responses 请求断言
要求两次生产请求与一次独立审阅请求都包含准确的原始 PNG/PDF 字节、MIME 类型和中文 PDF 文件名。
任务完成、报告下载和源消息发布均经实际检查，再离线重放原始历史。解码后的 history Payload
不得包含原始／base64 媒体或合成 API key；允许有界媒体 manifest。

使用固定依赖的完整 Worker 环境、现有 Node 依赖、Docker Compose 和已审查的固定引擎镜像。
私有 JSON fixture 的 `dsn` 必须指向自有、已完成 canonical 迁移的 loopback 数据库，名称以
`openbot_control_test_` 开头且没有 Work Task。输出目录须为空或不存在。运行期间保持代码稳定，
使 Worker 与 Replayer 加载相同 Workflow。完整命令见英文页；`OPENBOT_MEDIA_FIXTURE`、
`OPENBOT_MEDIA_OUTPUT`、`OPENBOT_MEDIA_PG_CONTAINER` 分别指定私有 fixture、新输出目录和自有 PG 容器。

可选 `--restore-container` 指定该 fixture 的 PostgreSQL 17.11 容器；探针核对不可变 ID、固定镜像
和 loopback 端口。已完成的产品 API/Worker 停止后，`product_restore_probe.py` 将原生 custom dump
与私有产物、附件、模型设置／密钥、插件状态／密钥，以及 32 字节原始连接密钥配对。
备份前，真实 Owner 服务创建一个启用的合成保存连接和一个显式 `model` profile／selection 的独立 Bot，
不修改已完成媒体任务的源。通过
`pg_restore --single-transaction --exit-on-error` 恢复到同容器的新随机空库。逐表完整行哈希、
sequence 状态、全部文件哈希与权限必须一致，再用实际 Python 接口核对 Owner 会话、任务／报告、
全部 blob、两份媒体，以及模型设置和禁用插件 token／审计的解密。恢复后的连接服务实际 resolve Bot
选择，并比较原 secret、revision 和来源信息。模型、插件、连接密钥分别缺失或错误的六个副本必须拒绝读取；
缺失连接密钥不得重新生成，错误连接密钥须返回 `model_credential_unavailable`。禁用插件没有工具或授权，
连接使用明确允许的 `.invalid` 端点和拒绝所有请求的 transport，不调用发现、计费测试或 provider 网络。

[2026-09-25 结果](evidence/product-media-paired-restore.json)记录最终 exit 0：两次生产请求、
一次审阅，134 字节 PNG 与 620 字节 PDF，90 字节报告完成，44 个解码 Payload 通过隐私检查且原历史
离线重放通过。恢复保留 42 张表、109 行、40 条 canonical 迁移、18 个配对文件和 6 个验证过的不可变
blob；六个密钥负例通过。自有 API、Compose、生成的 SQL 行和临时恢复库均已清理。早期清理及 dump
角色错误，以及一次误加载旧恢复探针的尝试在 evidence 中单独记录；只有最终候选运行计作非空连接验收。

范围仅为一个合成模型协议和完成后停写的产品快照；不证明真实模型理解、OCR、其他协议端到端执行、
在线 SQL／文件原子备份、活跃 Temporal 数据库恢复、集群角色／ACL、OS keychain 或跨版本迁移。
原 history 重放与活跃引擎恢复是分别验收的事项。
生成的 dump、配对密钥、引擎 PKI／配置、session hash 和完整历史保持私有，只提交有界公开结果。
参见[媒体边界](../../docs/research/work-product-media.md)和
[原生备份恢复审查](../../docs/research/s7-migration-qualification.md)及
[连接恢复边界](../../docs/research/product-connection-paired-restore.md)。

## 活动 Task 成套冷恢复

`active_restore_probe.py` 验收同一份当前快照里的待审批、已批准但 unknown、已取消三个任务。
使用实际 Owner HTTP API（`OPENBOT_CONTROL_AUTHORITY=work`）、产品 Worker、PostgreSQL 和
mTLS Temporal；模型及外部效果复用已接受的脚本 CSV fixture，不是完整 `ProductWorkRuntime`
或真实 provider 旅程。探针自行创建随机命名的源／目标 Control 容器、引擎项目和卷，
不需要现有数据库、私有配置、VPS 或模型账号。

先构建 canonical 数据库包，使用固定依赖的完整 Worker 环境、Node、Docker Compose、OpenSSL。
`deploy/temporal/compose.yaml` 中三个固定 digest 的镜像必须已存在；缺失会在前置检查中拒绝。
运行到 Replay 结束期间保持 Workflow 源码稳定。

```sh
npm run build --workspace @openbot/db
apps/server-python/.worker-venv/bin/python -B experiments/work-journey/active_restore_probe.py \
  --repo . --output /tmp/openbot-active-restore-new
```

输出目录必须为空或不存在。主场景上限 600 秒，之后执行有界清理；单个原生命令上限 60 秒。
源与目标顺序运行，最多三个常驻容器与一个短期 schema 工具；每个原生归档上限 64 MiB，
配对应用文件总量上限 64 MiB。不安装依赖、不引入旧 DBOS 实验，仅删除记录了归属的自有进程、
容器和卷。dump、密钥、PKI、会话／配置及完整历史保留在私有输出，仅按本地诊断需要保留，
不可作为仓库或 CI 公开产物。

先停止源 API／Worker，再停止 Temporal，然后原生备份 Control、history 和 visibility 三库；
在该停写边界配对应用文件／密钥、mTLS 和配置。之后源数据库容器永久停止。目标使用新空库事务恢复，
引擎／API／Worker 保持停机，直到完整逐表／sequence 哈希、文件／权限哈希、Owner 会话、
媒体／blob 读取，以及设置／插件／保存连接的实际解密全部一致。缺失或错误密钥的六个副本均拒绝读取，
缺失连接密钥不得重建；不完整文件副本在停机时无法通过 manifest 比较。此停机控制属于探针生命周期，
不是新增产品恢复准入服务。Temporal 角色复用原部署配置创建，恢复后再次验证 runtime 无 schema 创建
及 schema metadata 写权限。

目标保留原 namespace、visibility、Workflow／engine Run、Work Run 和 Action 身份。待审批任务
必须由 Owner 在恢复后明确批准；unknown 保留原批准动作和预算 reservation，公开 Owner 核对命令
仅 lookup 原外部回执，不重放写入。恢复后的 Worker 一旦尝试再次 apply unknown／cancelled 动作就失败，
且禁用重新规划。独立外部回执服务始终不回滚，取消任务不复活。等待中和终态历史都经官方离线 Replayer，
源历史前缀保持不变，回放不改变产品行或外部计数；解码 Payload 不得含合成媒体，或已检查的 Owner／会话、Control DB、模型 API、保存连接凭据。

[2026-09-25 证据](evidence/active-paired-restore.json)记录本地 Docker 成功验收：三个状态、
全部 43 条 canonical 迁移、Control 与两套引擎库、配对文件／密钥、原身份续跑、密钥负例、
自有资源完整清理。前述完成后产品恢复仍是独立证据。本项不覆盖在线快照、任意陈旧备份回滚、
源／目标并行、HA／PITR、跨版本迁移、OS keychain、Linux 执行隔离、任意部署角色／ACL、
真实 provider 计费或完整产品 prompt／tool／model 集成；仅恢复旧快照无法恢复该快照之后的权限撤销事实。
见[研究与准确边界](../../docs/research/work-active-paired-restore.md)。


## 产品命令整合候选

`product_command_probe.py`从真实`serve.py`入口验证Owner HTTP创建与审批、PG／mTLS Temporal、
OpenBotNodeClient、WebSocket／Unix命令通道、Host签名观测、完整产物下载和独立结果复核。
它创建并清理专用Control／引擎容器。模型HTTP响应、本地Native和Unix peer身份均为明确模拟，
本机运行不证明Linux隔离。修复Docker员工模型配置和可信命令许可时限后，canonical43流程已通过：
命令仅执行一次，完整CSV、独立内容审核、两份产物下载及历史离线重放均通过，重放不再次执行。
见[准确范围证据](evidence/product-command-local.json)。

准备已锁定Worker环境、构建共享包并启动本机Docker后执行：

```sh
node_modules/.bin/esbuild experiments/work-journey/product_command_node.mjs --bundle --platform=node --format=cjs --target=node22 --outfile=/tmp/openbot-command-node.cjs
apps/server-python/.worker-venv/bin/python -B -u experiments/work-journey/product_command_probe.py --output /tmp/openbot-command-product-1 --node-bundle /tmp/openbot-command-node.cjs
```

必须指定新的输出目录，已有目录会被拒绝。私有夹具日志／历史保留在该目录，仅全部产品断言及
离线回放通过后写入`result.json`。Node enrollment及credential仅驻内存，本地Control私钥退出时删除。
真实Linux执行另需准确上传清单和已审Host生命周期；此脚本不会发现SSH目标或外传本地凭据。
见[研究边界](../../docs/research/work-command-product-qualification.md)及
[命令配置](../../docs/WORK_COMMAND_READINESS.zh-CN.md)。

可选远程分支必须同时提供`--remote-ssh-target`、`--remote-ssh-identity`、
`--remote-known-hosts`、`--remote-server-port`、`--remote-fixture-name`及`--remote-upload-authorized`，脚本自身不上传。
须明确选择另行批准的新目录名，匹配`product[1-9][0-9]{0,2}`，例如`--remote-fixture-name product2`，
固定放在`/opt/openbot-command-0925`下；CLI没有默认名称，也不会发现或递增下一个名称。
夹具脚本必须位于该目录；stage、run、检查和未启动清理都使用同一根目录，拒绝符号链接别名。
已有预留保持不变；选择名称不证明目录未使用，也不授权再次上传或执行。
先准备已审的固定Host夹具与准确CommonJS Node包，并向`--node-bundle`传入同一包。
远端源码保存在`product_host_fixture.py`；[远程验收研究](../../docs/research/product-command-remote-probe.md)
说明一次性stage／run边界。Owner凭据、Control私钥和引擎密钥留在本地，仅本次新Node注册令牌通过stdin传递。
前台SSH转发仅绑定回环；必须同时通过原SQL绑定、签名产品结果、完整产物／审核及远端清理检查。
失败或未知调用不能使用同一预留重跑。
启动前的私有错误／清理记录保留有限异常类别和已知源码位置，不记录异常原文、输入、局部变量或完整路径。

控制器和夹具边界测试不连接SSH、不启动容器或调用模型：

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=experiments/work-journey:experiments/linux-execution:apps/server-python/src:apps/agent-runtime-python/src apps/server-python/.worker-venv/bin/python -m pytest -p no:cacheprovider -q experiments/work-journey/test_product_command_remote.py experiments/work-journey/test_product_host_fixture.py
```

2026-09-26刷新：同一成对停写恢复探针已通过44条迁移、47张Control表／111行，见
[schema44证据](evidence/active-paired-restore-schema44.json)。明确授权的一次性product3也已通过
真实Linux产品命令链路、原期限与清理、产物及重放检查；模型HTTP仍为合成，见
[product3证据](evidence/product-command-remote-product3.json)。已消费身份不得重跑；两项结果均不
代表通用浏览器出口或默认后端切换已经验收。


## 经审批的浏览器产品验收

`product_browser_probe.py`连接真实 Python 产品入口、Node／Docker适配器、Chromium、PG 和
mTLS Temporal，测试页面及七次模型／审核响应为合成内容，无私人档案或付费模型账户。
它分别批准导航／填字／点击／读取，在点击批准前关闭真实 SDK Worker，保留同一个 Node 连接
并恢复 Worker，核对表单只提交一次、报告可下载，最后重放历史且没有新增动作。
这是可信本地页面验收，不代表公网出口或隔离 Linux Host 通过，见[结果](evidence/product-browser-pages.json)。

准备 POSIX、Docker、项目支持的 Node／npm、Bun1.3.14、OpenSSL 和 Python3.12。从新克隆运行：

```sh
npm ci
npm exec -- turbo run build --filter=@openbot/node... --filter=@openbot/db
python3.12 -m venv /tmp/openbot-browser-worker
/tmp/openbot-browser-worker/bin/python -m pip install -r apps/server-python/requirements-worker.lock
python3 -B experiments/work-journey/product_browser_upstream.py /tmp/openbot-browser-upstream
npm ci --ignore-scripts --prefix /tmp/openbot-browser-upstream
PLAYWRIGHT_BROWSERS_PATH=/tmp/openbot-browser-binaries node /tmp/openbot-browser-upstream/node_modules/playwright/cli.js install chromium
/tmp/openbot-browser-worker/bin/python -B experiments/work-journey/product_browser_probe.py \
  --output /tmp/openbot-browser-product \
  --upstream /tmp/openbot-browser-upstream \
  --browsers /tmp/openbot-browser-binaries
```

选择尚不存在的输出／源码目录。新 Linux 环境可用 `install --with-deps chromium`安装系统库。
准备器检查每份固定公开源码和 MIT 许可证哈希，只修改回环监听地址并提供独立的依赖锁。
验收运行前再次检查，不启动用户日常浏览器；无 GitHub 凭据的公开下载也已验证。
独立的浏览器 CI 作业运行相同流程，只上传 `RESULT.json`。日志、临时凭据、数据库、历史与合成浏览器
档案保留在私有输出目录；`finally`关闭 API／Node／上游浏览器／Temporal 并删除独占数据库，
依赖可复用。权限／取消／纠正回归保存在 `test_work_browser_page_actions.py`和 Docker 适配器测试中。

补充旧审批失效验收时，分别传入 `--recovery control`、`--recovery node` 或
`--recovery replacement`，每次使用新的输出目录。第一种杀掉并重启完整的独占 Control 进程；
后两种杀掉并重新创建真实 Node 子进程，分别保留原凭据或撤销后重新登记同一 Node id。
核对实际子进程 PID 和强制退出；独占浏览器进程继续运行，不据此宣称浏览器／Host 替换通过。
连接改变后才批准原待执行点击，要求没有点击派发／提交，然后取消原 Task 并重放，不能新增动作。
Control／Node 模式还在另一次中断前取得人工控制，验证旧窗口被拒绝、暂停状态保留，原30秒
租期届满后必须明确重新接管和交还。新凭据不能继承原浏览器绑定。每次运行有6分钟截止及
夹具清理；CI 使用独占资源运行各模式，只保留不含内容的结果。

`--recovery response-loss` 在独占上游前加入仅监听回环的故障夹具。批准点击只转发一次，
确认上游成功及独立目标提交后，断开返回连接。产品必须保留 unknown，不重发点击，取消时
关闭权限，重放不得新增调用。`--recovery browser-restart` 完成已审批 Task 后取得人工控制，
优雅关闭准确的测试浏览器服务及 Chromium，再从相同私有档案创建新进程。检查旧浏览器已退出，
localStorage、有效期 Cookie 和 IndexedDB 保留，会话 Cookie 清除，人工暂停保持到明确交还。
两个真实本地用例均通过，见[安全结果](evidence/product-browser-interruption.json)。此处不证明
强制杀浏览器后的恢复、档案跨 Host 迁移、公网出口或 Linux 隔离；丢回执夹具不是网络安全边界。
