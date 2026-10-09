# 安全模型

## 1. 基本假设

OpenBot 假设以下组件都会犯错或被不可信内容影响：

- 大模型；
- 浏览器页面、邮件、文档和聊天内容；
- 第三方 Skill、MCP server 与连接器；
- Docker/VM 内的 Agent；
- 任意“我会小心”的自然语言承诺。

安全性来自进程边界、最小权限、确定性策略、人工审批和审计，不来自提示词。

## 2. 信任边界

### 可信

- Owner 身份和批准操作；
- OpenBot manifest 与签名/固定版本的部署配置；
- OpenBot Server / Action Gateway；
- 本机审批与审计存储；
- Tailscale 私网身份。

### 有条件可信

- OpenBot Node：只在被授予的 execution profile 内执行，不能修改 Server 策略；
- Cua Driver runtime：持有 macOS TCC 权限，因此其入口、版本和 policy 必须固定；
- Docker/Lume supervisor：拥有强生命周期权限，必须隔离且不能暴露公网。

### 不可信

- Agent session；
- 网页和附件；
- Docker/VM 工作负载；
- 未审查的 Skill、MCP、浏览器扩展和脚本。

## 3. 动作等级

| 等级 | 例子 | 默认决定 |
| --- | --- | --- |
| Observe | 截图、读取公开网页、列目录、查看状态 | 自动；仍写审计 |
| Prepare | 填草稿、编辑未发送邮件、生成待审文件 | 受限租约；限定目标和 TTL |
| Commit | 提交表单、发邮件/消息、删除、安装、发布、改权限 | 每次审批或人接管 |
| Forbidden | 支付、转账、改系统安全设置、导出主密钥、关闭审计 | V1 永久禁止 |

支付不是“审批后允许”，而是 V1 根本不支持。未来即使开放，也必须是独立设计和独立 threat model。

## 4. 关键规则

1. **默认拒绝。** 未声明的 Agent、工具、电脑、域名或动作不能运行。
2. **路由不可由模型改变。** Agent 只能在 manifest 分配的 execution profile 中工作。
3. **批准是一次性能力。** 绑定目标、动作、上下文、次数和过期时间。
4. **审计先于执行。** Server Action Gateway 必须先写入 `requested/decision`，再向 Node 发放动作租约。
5. **接管互斥。** 人在操作电脑时，Agent 输入必须被拒绝，不能排队偷偷补做。
6. **密钥不可回读。** UI 只显示 configured/not configured；日志不显示原值。
7. **宿主权限最小化。** Bot 使用工作主机上的专用标准用户；控制面和执行面使用不同身份/目录。
8. **生产不拉 main。** 只部署固定版本和校验过的构建。
9. **频道成员由 Server 校验。** Client 或模型指定的 assignee 只有在目标 Bot 已加入频道时才有效；未指定时只从该频道 roster 中确定性选择。

## 5. GUI 审批的真实限制

像素点击本身没有“发送”或“支付”语义。仅凭坐标、按钮文字或模型自报，无法建立可靠的安全边界。

因此 V1 采用以下保守策略：

- 普通网页优先使用可提供 DOM/URL/表单语义的隔离浏览器工具；
- 原生 macOS 默认只开放观察能力；
- prepare 租约只允许指定 app/window，并限制时长；
- 不可逆的原生 GUI 操作必须走专门工具、确定性 routine checkpoint，或交给人接管；
- 若目标窗口、URL、表单摘要或 app 身份变化，既有批准立即失效；
- 对无法识别的动作升级风险，不自动降级。

任何宣传都不能声称“系统能理解所有按钮的后果”。

## 6. Server 与 Node 基线

### Server

- PostgreSQL、频道、线程、策略、凭证和审计只存在于 Server 控制域。
- 默认只经 Tailscale/私网 HTTPS 访问；禁止公开数据库和内部 API。
- M0 使用单 Owner 本地认证：至少 15 个字符的 Owner 密码来自 Server 环境变量，不写入数据库；随机 Session Token 只进入 `HttpOnly`、`SameSite=Strict` Cookie，数据库只保存 SHA-256 摘要。
- 所有控制面接口默认要求有效 Session；非只读请求还必须与请求自身 origin 或配置的 Origin 精确匹配。浏览器 CORS 仍只开放配置列表；Desktop 只在健康验证和原生确认后把写请求重写为目标 Server 自身 origin。`null`、缺失和跨站 Origin 均 fail closed。登录尝试由 PostgreSQL 原子限速，状态跨进程与重启保留；桶键只保存直接对端 IP 的域分隔 SHA-256 摘要。仅当直接对端等于唯一配置的 `OPENBOT_TRUSTED_PROXY_ADDRESS` 时才接受单跳 `Forwarded`，歧义或缺失会 fail closed。这不是可信的每设备边界，不能代替私网部署。
- Session 默认 12 小时过期，支持主动撤销。非 loopback Origin 必须使用 HTTPS 并启用 Secure Cookie，否则 Server 启动失败；HTTPS 会话使用 `__Host-` 前缀 Cookie 和 HSTS。审批等高风险操作仍需要后续增加重新验证或设备绑定。
- 控制面复用 Hono 的维护中安全响应头中间件。每个 SSE 订阅的待发送事件固定为最多 128 项；溢出会终止连接，客户端必须从数据库权威快照恢复，不能静默跳过控制事件。
- 每个 HTTP 响应带 Server 生成的 `X-Request-Id`。Server 与 Node 使用遵循
  `OPENBOT_LOG_LEVEL` 的结构化 JSON 日志，只允许有界关联字段；HTTP 日志不含 query，任何日志
  都不得写入 header、Cookie、正文、凭证、任意异常原文或 stack。未预期的 `500` 只返回稳定的
  `internal_error`、通用说明与 request id。
- Node 的 `run.failed` 文本不可信：Server 只接受白名单代码并重新映射通用说明。Run 失败事件
  不保存 Provider 异常、token 或本地路径。后台调度异常另写有界 `DISPATCH_FAILED` 审计事实；
  该审计若失败只记一次安全日志，不能递归。
- Server 签发的 view/control/upload token 都绑定用户、run、node、用途和 TTL。
- 收到停机信号后，Server 先停止新调度并排空已接受的 Node 消息和 HTTP 请求，再关闭 PostgreSQL；
  空闲 HTTP 连接立即关闭，其余连接最多等待 10 秒。WebSocket 等升级连接由各自 registry 显式关闭。
- 备份加密并定期在另一台机器验证恢复。

### Node

- 生产目标是 Node 主动建立 WSS/mTLS 连接，不接受公网入站控制；当前配置只允许 loopback 使用
  `ws:`，非 loopback Server 地址必须使用 `wss:`，但尚未提供 mTLS。
- 每个 Node 通过短时、单次 enrollment token 换取独立可吊销凭证；Server 只保存令牌和凭证的
  域分隔 SHA-256 摘要。Owner 吊销后会断开对应在线 Node。
- `run.accept` 只表示能力与容量校验通过，不授予执行权；只有 Server 持久化条件认领并返回 `run.assigned` 后才能占用任务槽位。
- 当前 Node credential 仍是 bearer secret，默认保存在专用账户可读的本地文件；Linux 专用登录
  用户也可以明确选择 Secret Service，且后端失败不会退回文件。它能区分和吊销 Node，但不能
  证明不可导出私钥的持有，也不能阻止凭证被复制后重放。Linux 真实密钥库证据、其余平台密钥库、
  持有证明、轮换、mTLS 和消息序号完成前，只允许通过 WSS 与可信私网使用。
- POSIX 文件适配器使用 `0600` 原子写入，并在同一个已打开句柄上检查普通文件、大小和权限后才
  读取；一旦出现 group/other 权限位就拒绝认证。Windows 文件适配器通过 `@openbot/windows-secret-acl` 对 Node 凭据与 Server model/plugin 机密强制 Owner+SYSTEM DACL；Windows Credential Manager 与
  macOS Keychain 仍未实现，不能由这条 POSIX 保证或 Linux Secret Service 契约外推。
- enrollment token 默认十分钟过期、只能兑换一次、只在创建时返回；Node credential 也只在兑换
  时返回。任何一种明文都不能进入日志、Git、员工包或频道消息。
- 公开兑换接口按相同经摘要化的客户端网络身份限速；成功兑换会清除桶。`enrolled` 审计事件只保存
  客户端摘要与 `direct`/`forwarded` 来源，不保存原始地址、token 或 credential。
- 当前 Node 消息体限制为 32 MiB、未登记 socket 最多保留 10 秒，且每条连接只能登记一次。Server
  每 30 秒发送 ping；未回应的连接会被清退并进入断线恢复。Node 心跳只报告存活，不能增加、释放或
  结算 Server 权威任务槽位。协议 `0.9.0` 会拒绝未知消息字段、无效或超长 Node 身份信息、重复
  能力以及无界审批现场；审批 `beforeState` 最多包含 256 个有界 JSON 值。身份
  限制详见 [ADR-0023](decisions/0023-one-time-node-enrollment.md)。通道权威与输入边界详见
  [ADR-0017](decisions/0017-node-channel-authority-and-liveness.md)与
  [ADR-0019](decisions/0019-strict-node-protocol-inputs.md)。
- Node 不能读取其他 Node、Server 数据库或全局凭证。
- Docker supervisor、Cua 和 Lume 只监听 loopback/Unix socket。
- 人接管必须持有 Server 签发的独占 control lease。

当前 `agent-computer` 适配器只开放 observe 切片：任务必须显式包含 HTTP(S) URL，只调用 navigate 和 screenshot；没有配置 URL/token 时 Node 上报零项相关能力。默认拒绝解析到 loopback、链路本地、私网、CGNAT、组播和云元数据地址，即使显式允许私网仍永久拒绝已知元数据端点。

Node 上报的临时画面必须绑定已在该连接上运行的 Run，协议限制为 PNG，Server 再验证签名与 2 MiB 大小。Server 只在内存中保留最多 16 个 Run 的最新一帧并在 2 分钟后过期；频道 SSE 只携带元数据，画面正文必须通过 Owner Session 读取且禁止缓存。持久 Artifact 返回前还必须与数据库中的权威大小和 SHA-256 匹配，损坏或被替换的文件不会下发。它仍可能包含密码、验证码或私人内容，因此未来连续采集与公开部署前必须增加窗口范围控制和可配置的遮罩/停播策略。

应用层 DNS 检查不能单独阻止 DNS rebinding、重定向到私网或浏览器级旁路。生产执行环境必须再用独立网络命名空间、出站代理或防火墙阻断内网与元数据网段；在这层 egress 隔离完成前，当前 provider 只适合可信私网里的测试账号和公开测试页面。

### 员工包签名

- HTTP 导出默认仍是无签名模板；SHA-256 校验和只能发现变化，不能证明发布者身份。运维者显式
  配置发布者密钥库后，导出改为 DSSE 信封。
- 签名采用 DSSE 1.0.2 和 Ed25519，同时绑定员工包精确字节与 OpenBot 专用媒体类型。
- 信封里的 `keyid` 是未经认证的查找提示，不能决定信任；只有 Server 信任库中的公钥真实验签
  成功，并与包内已认证的签名元数据一致时才算可信。
- 验签通过不等于可以激活：严格 schema、校验和、敏感信息、许可证、能力、Provider 兼容性和
  Owner 本地策略仍需分别通过。
- 文件适配器把私钥保存为口令加密 PKCS#8；口令在另一个 Owner-only 文件中。密钥库、口令、
  trust manifest 或私钥都不能进入员工包、数据库、日志、浏览器或 Node。权限过宽、符号链接、
  格式错误或公私钥不匹配时 Server 拒绝启动；受保护文件会在同一个已打开句柄上完成类型、权限、
  大小校验和读取，避免先检查路径再另行读取。
- 初始化、信任、轮换和撤销只能通过离线 CLI 执行并在重启后生效。接收方必须通过带外渠道核对
  公钥指纹；员工包附带的密钥永远不能自授信任。活动密钥必须先轮换才能撤销。
- 员工包无论是否签名，都不能携带凭证、Session、Node 身份、主机绑定、租约或能力授权。
- 激活必须重新执行预览校验，并绑定 Owner 已看到的包 ID 与规范 SHA-256 摘要。未签名包必须
  单独接受风险；阻止项、内容变化、未信任或已撤销签名都会在写数据库前失败。
- 激活只在一个事务中创建新身份、候选技能、`imported` 进化事件和不可变收据。技能来源记录在
  员工赋值上，初始状态固定为 `candidate`、置信度 `0`；不会自动绑定 Node 或授予能力。
- 包 ID 与幂等键在每个 Server 内唯一。完全相同的重试返回原收据；换包复用幂等键或重复激活
  同一包会冲突失败。
- 当前本地信任库不能建立全球身份、自动传播撤销或提供门限恢复；详见
  [员工包签名手册](EMPLOYEE_SIGNING.md)、ADR-0024 与 ADR-0025。

### 员工记忆

- 只有通过 Owner Session 和精确 Origin 检查的控制面请求可以新增、编辑或删除记忆；模型、
  Worker Host 与 Provider 没有这组命令。
- 标题最多 160 字符、正文最多 8,000 字符；未知字段和 `included` 迁移策略会被拒绝。
- 更新和删除必须携带当前 revision；并发变化以 `409` 失败，不会后写覆盖先写。
- 标题和正文复用员工导出的凭据/私钥扫描。`secret-reference` 只允许保存密码库引用，固定为
  `restricted` 和 `never`，不能保存真实秘密。
- 删除会物理移除记忆正文；独立审计事件只保存 ID、动作、revision、变化字段、操作者和时间，
  不保存标题、正文或内容哈希。
- v1 员工包始终导出零条记忆。检索、自主写入提案、保留期限与选择性导出仍未启用。

### macOS Node

- 专用标准用户；管理员账号只在维护时使用。
- 不登录主 Apple ID、主邮箱、主浏览器 profile 或主密码库。
- FileVault、防火墙、自动安全更新。
- 有线网络、禁止系统睡眠、来电自动启动。
- 屏幕和输入经 Server 的短时 relay/token，不直接暴露 Cua。
- Node 管理服务只监听 loopback/Unix socket。
- TCC 权限只授予固定 Cua runtime identity。
- Node 日志、浏览器 profile、缓存状态和本地产物均加密；长期数据库与备份留在 Server 控制域。

注意：启用 FileVault 后，完全无人值守的冷启动与安全性之间存在取舍。macOS Node 里程碑必须实测目标版本在断电、重启、登录和用户态 launchd 下的恢复行为。

## 7. 必须测试的攻击场景

- 网页提示 Agent 忽略规则并读取宿主文件。
- 邮件要求安装软件或上传 token。
- `chief` 试图直接调用 Cua/Shell。
- `ops` 在运行中要求从 Docker 切换到 This Mac。
- 批准后 URL、窗口或表单内容发生变化。
- 同一 approval 被重复消费。
- 人接管时 Agent 仍发送输入。
- Docker 容器尝试访问 Docker socket、宿主私网或敏感 bind mount。
- 服务重启后错误恢复了已过期批准。
- 日志或截图包含密码、验证码、cookie 或 token。
- 被吊销的 Node 继续领取任务或上传画面。
- 恶意 Node 伪造另一个 Node 或重放旧 sequence。
- Client 绕过 Server 尝试直连 Node/supervisor/Cua。
- 两台设备同时申请人工接管并都获得输入权。

## 8. 开源发布要求

- `SECURITY.md` 提供私密漏洞报告渠道后再公开真实账号支持。
- 发布前生成 SBOM、依赖许可证报告和二进制校验和。
- Linux Worker 发布候选必须来自干净源码提交，使用固定 ncc/npm 和哈希校验的官方 Node 运行时；
  本地候选明确标为未签名。只有授权 tag workflow 完成来源证明后才能成为发布资产，校验和与 SBOM
  本身不代表安全或平台支持。
- 示例配置永远使用占位符；CI 扫描 secret。
- threat model、默认策略和已知限制随版本发布。
- 不把 Tailscale、Docker socket、Cua daemon 或数据库端口暴露到公网。
