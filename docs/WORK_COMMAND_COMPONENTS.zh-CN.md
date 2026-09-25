# 离线 Work 命令组件：尚未启用的候选

本候选验证未来 Linux 离线命令链路的 Control 事务，不注册产品工具、HTTP/WebSocket 入口、Node 命令、Provider 或执行服务。接线门槛关闭前，产品 Work 仍不能运行 `docker-linux`。本候选不含 browser。

v1 每条命令必须经 Owner 显式批准。Work proposal、Owner decision 和现有 `PostgresWorkStore.admit` 是唯一 Action 权限事实。dispatch 在原 admission 回调的同一事务中写入；签名、SQL 或最终 fence 失败都会回滚 admission。没有新增批准服务、lease authority、执行重试循环或旧 Run 执行器。

新的频道 Task 才能创建不可变 `work_command_profiles`。真实来源 message/Run、Task、Bot 必须准确对应，Bot 仍须属于该频道且为 `docker-linux`。来源 Run 继续保持 `node_id=NULL` 和 `model_selection=NULL`，不放宽旧 SQL 约束。新的 profile 在同一事务锁住 Bot，从 `Bot.configuration.model` 独立冻结完整选择；以后修改 Bot 选择不会改写排队任务。每次仍通过现有 ModelConnectionsService 检查连接启用、凭据及 endpoint policy。原生、历史或来源二义的 Task 没有默认提升权限。

dispatch 固定原 Action/Work Run、epoch、claim、连接 UUID、operation fingerprint、engine start 证明、纠正上下文及有界输入快照。ticket 不得晚于原 Action 或 claim 到期。一 Action 一行，状态只能 `issued → consumed` 或 `issued → closed`。旧 epoch 不会因恢复变成新 epoch。unknown、已消费或取消后的结果保留原身份；重复消费只返回 `lookup_required`，不重新签发 permit。

锁顺序固定为 `files.lock → registry identity_guard → 原 channel/source/ancestor-Task/Action → dispatch → credential SHARE`。必填的 `CommandInputScope` 没有放行默认值，复用 OwnerFiles 和现有 `ProductWorkReads._attachment` 快照校验，绑定 Task、Work Run、当前 generation、纠正、来源及准确的 filename/size/hash manifest。准备对象还绑定原 Action、epoch 和完整 operation fingerprint。admission/consume 在同一文件锁下复核字节、metadata 和显式处理后的文本版本。跨频道、未引用、删除、改写或 scope 不匹配均拒绝。首版只支持现有 read 工具可读的文本和已显式处理的文档，不静默 OCR、提取或转写。

已集成的 [v2 readiness](WORK_COMMAND_READINESS.zh-CN.md) 取代进程内 PreparedCommand 与调用方传入的 native deadline。服务先 `start()`，再依次 `reserve`、Host 签名挑战、`authorize_preparation`、`accept_ready`，最后以 preparation_id 进行 Work admit 和单次 consume。准备只允许固定有界 staging，不能运行模型 argv；原 Action 不得重新准备。

期限使用经资格验证的因果区间，而不是 Host UTC 时间。准备前检查原 root/Action/claim 预算，首次有效 ready 固定原 native 身份与 Server 时间域内保守停止上界，要求 nativeDeadline 等于 hardDeadline。consume 仍最多签发一次五秒启动许可；恢复、lookup、迟到 ACK 都不能延长或重建。受保护 Host、实际传输与当前权限下 lookup/stop 仍是启用前的必要接线，纯适配器测试不能代替真实运行证据。

Root 仍需接来源/模型选择、当前已消费读取结果重验、审批/catalog、真实 registry UUID/frame、Node relay、一次执行与独立整体截止、输出收件、model receipt、最终 artifact/result review。签名只证明生产者身份，不证明业务效果成功。Browser 和产品完整执行不在当前证据内。

权限 SQL 已编入 `0041_work_command_authority.sql`，新增准备迁移 `0042_work_command_preparations.sql` 后 canonical history 共 43 条；不回填历史 profile/dispatch，不覆盖已集成 codec 或依赖锁。此前 42 条历史的40项迁移/恢复与8项清理检查均通过；活动成套恢复也通过，其中尚未启用的命令表为空。

验证使用随机独占的 loopback PostgreSQL 17.11，完整 canonical migration，真实 Work/Owner/ModelConnections/OwnerFiles 和一个真实 SDK ActivityEnvironment 入口。history、transport、native readiness 明确为 synthetic；不调用 provider/模型，不执行容器命令，不运行真实 Temporal engine。覆盖并发单次消费、取消/消费双方先赢、SQL trigger 回滚、旧 handoff/fence/source/model/member/correction/Node 身份、固定截止及附件边界。

只在独立一次性 `OPENBOT_COMMAND_TEST_FIXTURE` 上运行测试：JSON 必须有 `fixtureKind=work-command-authority`、loopback `openbot_control_test_...` DSN 与合成 Owner token；先应用全部 canonical SQL，使用完整 Worker 依赖及两个 Python source package。测试仅删除自己创建的 model connection，外层夹具负责精确清理自有容器、卷与其余合成数据，不能使用共享夹具或真实 profile。完整 API 及接线顺序见英文同名文档。
