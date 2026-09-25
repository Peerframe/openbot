# 离线命令准备就绪 — 未启用的 Control/协议候选

本切片以持久化、签名的唯一准备事实替代调用方传入的 native deadline，提供 Control 事务、
受保护 Host 接口和协议 0.10.0 帧 schema；可选产品接入已整合，默认关闭。既有 Work Action 仍是唯一
批准与 admission 权限来源，本切片不包含 browser。

验收仅在 product 权限模式和明确 Temporal 配置同时存在时读取
`OPENBOT_CONTROL_COMMAND_CONFIG_PATH`。[配置 schema](../experiments/linux-execution/command-installation.schema.json)
与[不可直接部署的示例](../experiments/linux-execution/command-installation.example.json)定义固定路由、
镜像／资源、时限和分离签名角色。加载配置不授予 Work 权限，仍须原来源快照、当前身份、Owner
批准和在线单次消费。无效的显式配置会阻止启动。配置／密钥必须为本地所属的普通文件，Control
私钥不会发往 Node。当前 Host 最长50秒，停止观测余量5秒。产品完整 UTF-8 输出上限64KiB，
模型只收到最多16KiB的不可信节选；最终复核与发布使用完整私有字节。同一连接可查询原执行，
重新连接恢复尚未验收。
可信命令adapter使用固定120秒Activity claim以容纳已审准备与停止时限，通用工具仍保持60秒。
这不会续期重放的claim，也不延长原Task／Action／native截止。

只有明确获得 Owner 批准的原 Action 才能保留一次 preparation，并在远程准备前固定原 epoch、
来源/profile、连接/路由、输入范围和原 native unit 身份。与 Node credential 分离的 enforcement
key 签署本地 boot 绑定挑战；Control 复核当前 Work、来源、文件及 fence 后，仅授权固定准备程序。
准备消息不含模型 argv。固定 native helper 必须在启动任何 producer 前拒绝已过期的原 nonce。
输入总量仍受原 20 MiB manifest 限制，单 chunk 最大 16 KiB，JSON 帧最大 32 KiB。Node 只负责不可信转发。

第一次有效 readiness 在原往返预算 B 内固定 D=t1+U(R)+S；它是 Server 时间域内保守停止上界，
不是宣称把 Host 单调时钟准确换算成 UTC。Control 先要求
`t0+max(B,U(Q))+U(R)+S <= 原 root/Action/claim 截止`，且 `U(R)+S <= 已批准 wall 上限`。
`nativeDeadlineMs == hardDeadlineMs == D`；原 boot、invocation 和单调时钟读回仍保留在签名证明中。
lookup 和恢复后的新 Activity epoch 都不能选择新的 D 或 unit。五秒在线单次 consume 许可只用于
输入/runtime 就绪后的 create/start；投递未知只能查询原事实，不能重新消费或更换执行身份。

`CommandDispatches` 必须组合原 `CommandInputScope`、经资格验证的 timing policy 和进程绑定的
`ServerPrepareClock`，使用前调用 `start()`。公共接口为 `reserve`、`authorize_preparation`、
`accept_ready`、`admit`、`consume`；admit 只接受 preparation_id，旧 PreparedCommand/整数 deadline
入口已移除。来源和 CommandIntent 保持 v1，执行令牌与期限 profile 为 v2。原来源
Run.model_selection 仍为 NULL，模型选择继续由独立、不可变的 command profile 保存。锁顺序仍为
文件锁、registry identity guard、原来源/祖先 Task/Action、preparation/dispatch、credential 读取；
SQL 持锁期间不等待网络。

lookup 与 stop 共用新的本地 Host 挑战。Control 只有复核当前权限后，才能签署绑定准确 challenge
digest、requestId、nonce 的类型化回应；Host 拒绝迟到的首次回应，并在每次披露输出前复核同一期限。
Node credential、旧 receipt 或单独 Server nonce 均不授予读取权限，stop 不授予输出访问权。
签名只识别可信 producer，效果仍须经过受限收件、观察校验和既有 artifact/result review。

迁移 `0042_work_command_preparations` 新增 work_command_preparations 及 dispatch 的准备/证明引用，
canonical history 增至 43 条。TypeScript 镜像包含 362 个 Python oracle 向量和 3 个 JavaScript 边界案例；
命令候选尚未启用，现有 Worker 全局握手仍为 0.9.0。历史 v1 dispatch 不回填为可执行 v2。没有新增依赖，纯 Host 模块复用原 JWS/key/JCS
实现，不导入数据库、Temporal 或模型服务。

实际验证为 139 项通过：独占 PostgreSQL 17.11 容器先应用 canonical 42 项迁移，再应用候选 SQL；
原 81 项权限测试全部改编至公开准备接口，另有 22 项数据库测试覆盖并发、签名读回篡改、迟到/重启/
时钟变化、输入和成员权限变化；36 项纯测试覆盖因果时间区间、control 挑战、重放、休眠/boot 变化、
内外关联与帧上限。PG、OwnerFiles、SDK ActivityEnvironment 为真实调用，历史、传输、enforcer 和
时钟是明确的合成接缝。本次容器和卷均已清理，没有调用 provider 网络、VPS、真实产品 Worker 或命令负载。

受保护Host、native adapter、当前权限下的control签发、Node传输及受限manifest收件已整合。
剩余执行门槛是真实Linux Host上的完整产品流程，涵盖native就绪、原执行、清理、最终输出与审核；
本地夹具成功不能替代真实宿主证据。Host的preparation／Action与control book容量有限，耗尽即拒绝，
没有驱逐或重新授权接口来允许再次执行。仍要求经资格验证的不休眠Host；普通systemd timer不证明
任意kernel／VM停顿下的无条件硬实时停止。真实门槛关闭前，产品执行继续默认关闭。

## 已整合的访问控制与转发

可选 Node relay 已进入仓库，默认没有 installation 或能力广告。24项模拟传输／客户端检查通过，
最新完整 Node 套件92项通过、3项既有平台跳过；这只验证传输边界，不是真实Host执行。

`authorize_lookup` 在签署新Host挑战对应的查询前，重验原活动Work／来源／SDK fence、附件字节、
profile、credential与已批准Action；只有原dispatch已消费时才允许输出。
`authorize_owner_stop` 必须验证当前Owner会话，仅停止原unit，允许在取消后使用，不授予输出权限。
两个接口均为内部接线，不暴露任意签名入口。16项真实PG检查覆盖这些边界。最终回执结算、报告审核
及socket整合已通过真实本地产品入口、Owner审批、PG／mTLS Temporal及OpenBotNodeClient验收：
原命令仅一次执行，完整CSV、独立审核、两份产物下载及离线重放通过。本流程的Native执行、peer身份
及模型HTTP为明确模拟，见[准确范围证据](../experiments/work-journey/evidence/product-command-local.json)。
真实Linux Host产品执行仍未完成，公开执行保持默认关闭。浏览器CDP组件已有独立有界验收，产品浏览器／接管仍待完成。

真实受保护Linux Host组件已独立通过原命令签名、准确CSV、原生期限终止与清理；该组件的Control签名者为模拟，完整真实Work产品链路仍待验收。见[组件证据](../experiments/linux-execution/REAL_PROTECTED_COMMAND.json)。

已授权product2远端尝试在run／Action预留前失败，原因是小型注册信封选择了不支持的1024字节codec上限。
夹具现使用已有512字节类别，6项真实stdin回归及共161项控制器／Host检查通过。未发生原生执行，
测试资源已核对清理、既有服务未变；保留[失败证据](../experiments/work-journey/evidence/product-command-remote-product2-attempt.json)。
新product3包等待具体授权，不重跑product2。
