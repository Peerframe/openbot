# 架构迁移交接 — 2026-09-26

## 当前检查点——草稿已发布，浏览器组件和产品容器通过验收

- 交付：[草稿 PR #96](https://github.com/Peerframe/openbot/pull/96)，分支
  `codex/python-migration-draft-20260925`，首个已发布检查点为
  `4beb58b1adac1a68b6c098c84fa116b21a8d9f77`，后续代码已提交至`1978bcb4d46160ecd75a0c862328495876a71e53`。
  迁移历史和整合产品已在 GitHub；本交接记录增量的最终本地验收与 CI 修复。本检查点不授权合并、默认后端切换、替换已安装应用或部署生产。
- 架构：用户确认《2026-09-24 OpenBot 设计研究 v2》。模块归属和文档事实修正已整合；Server 管权限，
  Temporal 管持久恢复，DSH 协助传输开发。全仓包／目录重排、视觉系统和市场仍是后续工作，不阻塞本草稿。
- 产品：Python Owner API 与保留的 React 客户端覆盖身份、工作区、模型档案、知识、会话、计划、文件、
  处理器、插件／MCP 和 Worker Host。原生 Task 保留不可变的 Owner 附件／知识／插件／网页／协作者范围，
  子任务只能缩小。真实 HTTP／PG／mTLS 下合成父子任务、审批、纠正、取消、终态／提交后丢失恢复、发布及
  离线重放已通过；模型或 Native peer 模拟边界仍保留，不能据此宣称远端 Linux 产品链路通过。
- 数据和真实模型：canonical schema 为43条至0042。停止写入的合成成套恢复通过：46张控制表／110行、
  40张历史表加3张可见性表、13个配套文件、36个TLS文件及6个错误密钥反例，保留原身份和离线重放。
  唯一已完成 Kimi 任务使用4份回执、8,854 tokens，下载231字节报告；不得重发。不代表在线原子备份或生产转换。
- Linux 命令：native case2 已通过准确CSV、签名回执、原50秒期限及清理，Control权限仍为合成。
  product1在预留前失败且原stderr丢失，根因未分类。已授权的product2同样在run／Action预留前停止：
  Host夹具向固定codec传了不支持的1024字节上限，现改用已有512字节类别；6项真实stdin反例及共161项
  控制器／Host检查通过。product2密钥、公开bundle、进程／socket／监听和测试unit均已清理，10个既有容器与
  防火墙语义保持不变。见[脱敏失败证据](../experiments/work-journey/evidence/product-command-remote-product2-attempt.json)。
  两个身份已消耗；新product3四文件包已准备，具体上传与单次150秒测试授权待回复，不得直接重跑旧身份。
- 浏览器组件：授权的固定镜像CDP场景已在真实Linux x86-64／runsc通过。两次Chromium实际启动完成合成DOM／
  PNG渲染和预定profile保留，核实namespace／PID／network／seccomp及真实运行参数。原180秒unit到期后54ms
  观测停止，自有资源清理，10个容器／防火墙语义不变。早期观测瞬态错误原样保留。该证据只覆盖组件，尚不覆盖
  产品权限／profile归属、出网和人工接管。见[REAL_CDP_RESULT.json](../experiments/browser-execution/REAL_CDP_RESULT.json)。
- 产品容器：独立Python主入口镜像与可选Compose已整合。已批准的`OPENBOT_CONTROL_HOST`只允许127.0.0.1
  （默认）或0.0.0.0，非法值先于DB／密钥初始化拒绝。本地Linux arm64实际镜像通过Owner／Web、43条迁移、
  DOCX／PDF／空白OCR、SIGTERM重启后原文件／密钥／schema持久化、四项非法启动及自有资源清理，不含TS业务
  Server／oracle。该镜像在817d46c的原生Linux amd64和arm64 CI均已实际构建并通过smoke；配置Temporal与部署分别验收。见[容器结果](../deploy/server/PRODUCT_CONTAINER_RESULT.json)。
- Desktop：1978bcb的canonical43／63依赖unsigned arm64 Preview已重新构建，通过暂存／包内API启动、
  parent-EOF停止、不安全目录拒绝、重启和清理。159个Python源码模块及生命周期脚本／锁与该提交一致，
  ASAR／控制器哈希与前一候选一致。见[刷新证据](../experiments/work-journey/evidence/desktop-preview-refresh.json)。
  本轮不新增mTLS Worker、GUI、Keychain、签名或安装验收声明。
- CI和检查：1978bcb的[run36160191190](https://github.com/Peerframe/openbot/actions/runs/36160191190)
  已通过三个Portable任务、Windows Host构建、validation、database、security和两个原生Server容器任务。
  Windows实际安装与原生Server生命周期已通过；合成迁移也已通过。Python精确Worker启动和独占PostgreSQL
  base826项（2项可选跳过）、Worker1489项（1项缺少历史夹具跳过）通过，随后两个真实Unix socket夹具因
  使用macOS专属`/private/tmp`失败，汇总check因此失败。
- 当前CI修复：Linux／macOS均使用短canonical `/tmp` socket路径。整合DSH实际实现的测试修复
  `SubprocessCommander(binary=sys.executable)`，环境过滤断言不再依赖Docker CLI；缺失可执行文件的
  拒绝行为及独立反例保持不变。另一个本地Linux容器的`/tmp`已确认带`noexec`，仅为该临时夹具的合成
  shell执行显式启用`exec`，不改产品或安全断言。实际Linux复查通过198项执行器、153项pytest和172项流程
  测试；`npm run check`通过，未变Turbo任务复用缓存。仍须最新提交托管检查通过，本地通过不能代替CI验收。
- 退役：publisher／MCP工具、解析器与运行依赖已解耦。差异测试使用固定59文件`tests/oracles/legacy-server`，
  没有产品入口。剩余命令链路、浏览器产品／接管及最终候选检查通过后，才将已替代TS业务Server退出主构建／CI／
  发布，保留恢复提交及TS Node／Provider驱动，不启用未验收路径来宣称完成。
- 资源与归属：CI任务在独立工作树独占后续修复；原迁移工作树与交接补丁保留。DSH只接收最小公开／合成材料，
  其他任务不写CI归属文件。PG `openbot-migration-c8b2-30b7e37a`在51899保留
  terminal／native／Kimi证据，必须保留；UI API33551／Vite33552为合成数据。当前没有VPS测试窗口，远端测试及
  本地容器smoke资源均已清理。早期夹具曾把镜像放入共享Docker缓存，之后已改私有containerd，不可盲删共享缓存。
  原数据／配置及已消耗stage记录保留。
- 下一个有界检查点：完成同一草稿最新提交的全部托管检查与汇总check。product3仍须具体授权；
  浏览器产品／人工接管和候选包／退役门槛属于其他迁移工作。复用既有证据，不因继续任务而重跑成功的真实模型、native case2或CDP测试。

以下阶段说明仅作为历史证据，不是当前工作顺序。

## 当前简短交接——已验收并行增量（代码 `a61153e`）

- 已完成：S3 `76667ea` 在原 Workflow 关闭后核对 unknown，不新增写入或授权。S2 `ef1e254`＋`a61153e` 提供真实 `#/tasks` 创建／查看／取消，并关闭独立发现的断线迟到响应与 413 两项反例。S5 `ace87c8` 只整合已审查的离线选择／重校验端口。
- 证据：S3 冻结输入的真实 HTTP/PG/mTLS 恢复与审批回放通过；S2 原32项、独立4反例以及实现者真实浏览器／PG 证据通过。整合后的 S2 与 `dfa40d4` 字节一致；S5 与 `df1c24d` 字节一致，主线复跑15项新增测试通过。最终组合入口／检查结果写入 S2 研究记录。
- 未完成：S3 执行中纠正与可信服务启用；S2 审批／核对／下载和已安装 Desktop；S4 真实 Linux/runsc 正向流程、浏览器／接管与安全输出存储；S5 权威产品读取及使用前校验。S6/S7 的准备不算阶段完成。
- S4 `bb37d57`：独立155项检查仅接受拒绝未核实挂载；继续留在 `<isolated-s4-worktree>`，不覆盖或验收主线既存未跟踪 TASK020。
- 下一步输入：本交接、`work_worker.py`、`work_closed_repair.py`、S2 `WorkTasksScreen.tsx`、S5 `SELECTION_PORT.md` 及各自局部研究。保留模型服务脏修改、既存开源复用条目与 TASK020。每范围单一实现者；Server 管权限，Temporal 管继续，unknown 只核对；未推送、切换或发布。


## 历史简短交接——关闭后核对（父提交 `6f69be9`）

- 已完成：显式 `--repair-closed` 派发与同 Worker 内的仅查询修复，处理原流程关闭后的持久延期 Action；错误证据保留 unknown／预留，后续周期不改写旧 unresolved 命令。提交后确认丢失的重试不再查询。
- 证据：独立审查、冻结输入的真实 HTTP/PG/mTLS 关闭修复及受影响的延期审批恢复通过；入口、真实数据库、仓库检查通过。实际执行／缓存／跳过及哈希见 `docs/research/work-closed-repair.md`。
- 未完成：S3 产品纠正和可信部署／服务启用仍待完成。S2 `0a9fc21` 有两项独立复现问题（断线迟到响应、明确 413 拒绝），已交原实现者修复；S5 `df1c24d` 离线范围已独立验收并整合为 `ace87c8`（字节一致，局部测试复跑通过）。S4 `bb37d57` 仅接受拒绝未验证输出挂载，继续单独保留；没有 runsc／真实生命周期验收，TASK020 未结案。
- 下一步：本交接、`work_closed_repair.py`、`work_repair_binding.py`、`work_repair_dispatch.py`、`work_worker.py` 及上述研究。保留其他模型服务修改及 TASK020，维持原权限与 unknown 契约，不切默认、不发布。


## 历史简短交接——延期审批（父提交 `965a643`）

- 已完成：产品延期提案/审批在重启后复用原持久 Action；unknown 通过人工命令仅核对原动作，确认后使用完整历史与累计用量继续。拒绝关闭任务，关闭回执丢失后的读回不产生新授权。
- 证据：真实公开 HTTP/PG/mTLS 的准备与拒绝回执丢失、离线批准、取消、unknown 修复、下载和无副作用回放通过。长流程前完成独立审查；候选哈希、失败日志及实际执行/缓存/跳过记录见 `docs/research/work-deferred-approval.md`。
- 未完成：本切片不代表 S3 完成。产品纠正、通用服务启用及已关闭 Workflow 的修复集成仍在后续范围；S4 Linux/runsc 与 TASK020 未验收。没有切换默认实现或发布。
- 停止：用户最新要求替代先前“整合到 S4 后停止”的出口。本切片本地交付后暂停，不启动其他 S3/S4 工作。再次获授权后，从本交接、本地交付提交、`work_deferred.py`、`work_worker.py` 和本轮研究记录开始；保留其他模型服务修改与 TASK020。


## 当前短交接——产品 Worker／派发（父提交 `d0f7c1a`）

- 已完成：可选的产品 Workflow/Agent、逐 Run 可信服务接口及独立发布核验；有限单次 CLI 派发强制显式 mTLS。发布确认丢失后回读准确的已提交结果，不新增 claim、不调用核验器、不重复动作。
- 证据：真实公开 HTTP/PG/mTLS 的模型回执恢复、实际 CLI 发布恢复，以及同一 Worker 中两个并发任务的取消隔离均通过，包含文件下载和无副作用重放。干净可选依赖安装、权限／派发反例、数据库损坏／竞态及仓库检查通过。代码哈希、失败、命令与缓存边界见 `docs/research/work-product-worker.md`。
- 未完成：S3 产品服务配置和通用批准／纠正／继续；可选 Worker 不等于 S3 完成。S4 真实 Linux/runsc、浏览器／接管和集成仍未验收。总体粗估仍约25%，处于 S3；准备工作不算阶段完成。
- 下一步：`work_worker.py`、`work_runtime_ports.py`、`work_dispatch_batch.py`、`scripts/dispatch-work.py` 及 `experiments/work-journey/` 产品用例。保持 Server 授权、Temporal 单一恢复职责、unknown 仅核对契约；保留无关脏修改及 TASK020。不切默认、不发布，通过至 S4 的整合验收后停止。

## 上一份短交接——模型观察持久化（`d2b3372`）

- 已完成：接入可选的真实 OpenAI/Pydantic SDK 模型端口，由控制层保存与已准入 Action 绑定的原回复。Activity 确认丢失、旧 claim 过期后仍可恢复原结果与用量。unknown／缺失回执不重发、不退款；已结算回复必须匹配原证据。仅支持文本／函数，拒绝隐式媒体下载和托管工具。
- 证据：真实公开 HTTP/PostgreSQL/mTLS Temporal 的保存后崩溃、唯一结算、下载及无副作用回放通过，并发任务隔离回归通过。数据库取消／损坏／未知反例和 SDK 边界检查通过；仓库检查通过且区分缓存。SQL0033 已用两条保留的合成旧历史重新验收，未改写源历史。详见 `docs/research/work-model-ports.md` 与 S7 证据。SDK 连接合成 HTTP，并非真实模型账户。
- 未完成：S3 产品服务配置／派发、通用继续／纠正与发布；本端口仍可选，不代表通用 Worker 或 S3 已完成。S4 仍缺真实 Linux/runsc、浏览器／接管和执行集成验收。总体粗估仍约25%，处于 S3；S5–S7 准备不算阶段完成。
- 下一步：`work_model_activity.py`、`work_model_receipts.py`、`work_openai_model.py`、`work_runtime_ports.py` 与 `experiments/work-journey/model_recovery_probe.py`。在既有权限／回执契约下接产品服务配置。保留单一恢复引擎、事实补记不授权、其他脏文件和未验收 TASK020。不切默认、不发布；通过 S4 整合验收后停止。

## 上一短交接——共享 Worker 端口（父提交 `06f6762`）

- 已完成：可选的控制层 `WorkRuntimePortFactory` 从已确认的 Task/Run 身份装配每次 Activity 独立的模型/工具端口，隔离嵌套 schema、复用限额和权限检查。服务加载不能执行副作用。dsh 交稿结束后，Codex 独立复现并修复了加载期间撤权及截止时间缺口；没有增加进程内任务缓存。
- 证据：开发引擎及 PostgreSQL/mTLS Temporal 的真实 HTTP/数据库流程均通过；同一 Worker/Agent/队列执行两个重叠任务，取消其中一个阻止后续操作，另一个独立记账并下载自己的文件。两段历史重放无状态改动。反例和仓库检查通过，具体哈希、失败、命令位于研究记录末尾；缓存命中与实际执行的 Python/完整流程分开记录。
- 未完成：真实产品服务配置、通用持久操作标识、继续/纠正与发布恢复仍属 S3。共享夹具使用脚本端口，不代表 S3 完成或低预算拒绝已验证。总体粗估仍约25%，处于 S3。S4 已再次确认缺 Linux/runsc 实测和已提供的 Linux x86-64 目标 VM；TASK020 不得接入，fake 测试不能充当隔离证据。
- 下一步关键文件：`work_runtime_ports.py`、`work_temporal_start.py`、`work_temporal_effect.py`、Runtime `temporal_agent.py`、`experiments/work-journey/multitask_worker.py`。在现有控制层权限下接真实服务与持久操作标识；保留 unknown 仅查询、撤权和既存脏文件边界。不切默认后端、不发布；到用户要求的 S4 整合真正验收后停止。


## 当前简短交接 — Worker 启动（父提交 `1f5f98e`）

- 已完成：控制层提供只读、基于已接纳 Activity 的 Task／Run 上下文加载器。参考 Worker 可先于派发确认启动，由引擎在独立的 120 秒上限内重试启动检查，确认前不调用模型或工具。等待期间重启、随后确认能完成一次；确认前取消在重启后仍保持关闭。首个活动名称／输入／None 返回和效果策略不变。dsh 实现加载器与单元候选；Codex 接线、补真实数据库与公开入口反例并独立验收。
- 证据：31 项加载器单元检查、79 项参考单元检查通过；真实 PostgreSQL／HTTP 检查 302 项通过、2 个可选文件跳过。真实公开入口的提前启动、等待期间取消、五个交接拒绝场景及恢复／历史回放通过。研究记录含精确命令、源码摘要和日志。`npm run check` 通过，仓库前置检查实际执行、Turbo 项命中缓存。保留此前 `1f5f98e` 的 PostgreSQL/mTLS 相邻版本验收，未重跑未变化的部署验证，也不把旧结果冒充本候选完整验收。
- 未完成：通用产品 Worker／模型／工具组合、稳定逐操作身份及整个 Run 的继续／纠正；参考仍使用固定脚本。S4 真实 Linux/runsc 未验收；S5–S7 仅整合准备成果。总体仍粗估约 25%，当前 S3；未切换默认实现、未发布。
- 下一步：`work_temporal_start.py`、`work_temporal_activity.py`、`work_temporal_effect.py`、Runtime `temporal_agent.py` 与 `experiments/work-journey/workflow_worker.py`。把固定逐 Task 的 Worker 配置替换为已接纳逐 Run 工厂和持久控制层 Action。上下文不是授权；未知写入只核验，取消／撤权不恢复权限。保留其他脏文件与 TASK020，仅遇具体失败才查旧证据。

## 上一 Runtime 组合交接（父提交 `e07e858`）

- 已整合：Runtime 现在拥有可选的 Temporal Agent 构造入口。两个并发 Run 在 Activity 内使用同步/异步工厂，Workflow 准备只使用不能执行请求的元数据；嵌套重试配置不受调用方后续修改影响。独立复核通过；71 项定向检查、真实双 Run 历史与回放通过。集成 `npm run check` 通过，仓库前置检查实际执行，Turbo 结果命中缓存。源码摘要、失败与最终日志见 `docs/research/work-temporal-journey.md` 末节。
- 未完成：产品 Worker 的端口加载仍需绑定已接纳身份与控制层 Action/预算，纠正、最终发布、重启与继续执行仍开放。S4 的真实 Linux/runsc 未验收，已整合的 S5–S7 准备成果不代表阶段完成。总体仍粗估约 25%，当前 S3；未切换默认实现、未发布。
- 下一步只读：`apps/agent-runtime-python/src/openbot_agent_runtime/temporal_agent.py`、`experiments/work-journey/multirun_port_probe.py`、控制层 `work_temporal_activity.py` / `work_temporal_effect.py` 与 ADR0046。Server 权限边界和 unknown 核验规则不变，重试不能产生新外部写入。保留其他脏文件与未验收 TASK020；仅遇具体失败才查旧证据。

## 上一固定参考交接（父提交 `e176e90`）

- 已完成：固定参考流程已在真实 Temporal 引擎中执行产品 Activity→Action 接线。未知写入仅查回执、不重复 POST；取消后只补记历史事实。修复命令核对持久化尝试标识与原始引擎链。最终候选独立通过 21 项局部单元检查和完整 16 项开发引擎流程，包含真实历史重放。集成目录 `npm run check` 退出码为 0，Turbo 项命中缓存，仓库前置检查实际执行。文件摘要、命令、失败与日志见 `docs/research/work-temporal-journey.md` 末节。
- 未完成：产品 Worker/Runtime 组合、稳定的逐操作 Action 身份、整个 Run 的预算和通用继续执行仍属 S3 工作。本候选未运行 PostgreSQL/mTLS 引擎或相邻版本升级；后者需先复核等待发布场景的查询计数预期。真实 Linux/runsc 和 S2 全面对齐仍开放。总体仍粗估约 25%，当前 S3；参考流程通过不等于阶段完成。
- 约束：Python 控制层拥有身份、授权、Task/Action、审批、预算和产物；Temporal 独占继续执行；Runtime/Worker 不产生授权。未知写入只能权威核对或保留 unknown。取消、撤权不能恢复副作用授权。未切换生产、未发布。
- 下一阶段输入：`apps/server-python/src/openbot_server/{work_temporal_activity.py,work_temporal_effect.py,work_effects.py}`、`apps/agent-runtime-python/src/openbot_agent_runtime/{executor.py,sdk_ports.py}`、本提交的 `experiments/work-journey/` 改动与研究末节。保留无关模型服务修改、`docs/OPEN_SOURCE_REUSE.md` 和未验收 `experiments/linux-execution/`。S4–S7 已有独立工作树任务，准备工作不算产品验收；仅遇具体失败才读旧记录。

S6 基线 `1fd8b0d` 已独立验收：合成 PostgreSQL/MCP 授权、取消、401、串行领取和 per-Run 预算检查，见 `docs/research/s6-compatibility.md`。C11 已区分共享期限与逐 Run 预算；S6 产品接入仍待完成。

S7 前置验证 `ea75b92` + 清理修复 `36ddc5d` 已独立验收：固定来源历史、有界合成数据转移与真实 PostgreSQL/文件备份恢复。目标 SQL 仍固定为 `e176e90` 的 33 条；专属 CI 已准备但未运行，旧任务转换、完整产品数据与 Temporal 配对恢复仍开放。见 `docs/research/s7-migration-qualification.md`。

S5 离线夹具 `5d838b5` 已独立验收：纠正审核、范围检索、停用/撤销/删除与授权不增加。固定算术解释器的结果不是模型学习效果证据。S5–S7 前置成果现已整合，产品接入仍等待 S2/S3 契约；S4/TASK020 继续保留在未验收产品代码之外。见 `docs/research/s5-memory-skills.md`。

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
