# 产品定义

## 1. 一句话

OpenBot 是一个受 Grok Bot 体验启发的开源、自托管、跨平台数字员工平台：员工拥有可成长、
可查看和可迁移的持久身份，并通过用户授权的 Windows、macOS、Linux 或隔离运行环境完成工作。

## 2. 用户体验

- 用户可以像使用 Grok Bot 一样安装 OpenBot Desktop，也可以直接打开自己的 OpenBot Web。
- 每台电脑安装同一个 Desktop；首次引导只决定这台电脑启用 Client、Server、Worker Host 中的哪些角色。
- 工作电脑仍然是完整的用户电脑，可以直接打开频道、审批、查看进度和使用其他工作电脑。
- 频道、聊天记录、记忆、审批和审计保存在自己的 Server。
- Server 在后台为 Bot 选择已经声明、在线且获得授权的工作主机。
- 用户可以看屏幕、暂停、批准、拒绝或接管。
- 更换 Mac mini、Windows PC、Linux 主机或隔离环境，不会丢失频道和员工身份。
- Desktop 与 Web 都默认进入 Grok Bot 式长期频道；Marvis 式办公室作为延期的可选插件保留，不进入当前版本导航和构建。
- Bot 外观由头部、身体、移动方式、配件和强调色组合，并作为持久身份在所有界面复用。
- 点击 Bot 可以查看 Bot 档案：概览、进化档案、技能、记忆、工作记录（含进行中的任务和可审计决策）和配置。
- 员工可以导出为安全模板、复制为新员工或通过认证流程转移；电脑权限和凭证不随员工包迁移。
- 进度、团队、审批、电脑和产物均由结构化 run events 渲染，而不是从聊天文本推断。

## 3. 部署角色

### OpenBot Server

系统的唯一真相源，负责：

- 用户、频道、Bot、线程和记忆；
- Agent runtime 与任务生命周期；
- 节点注册、能力发现和确定性路由；
- 策略、审批、凭证和审计；
- routine、重试、熔断和通知；
- 面向所有设备的完整 Web Client，以及供 Desktop 复用的 Server API。

Server 可以部署在 Mac Mini、普通 Linux 主机、NAS 虚拟机或云服务器。

### OpenBot Worker Host / Node

Bot 被授权使用的可替换工作电脑或运行环境，负责：

- 主动连接 Server 并维持心跳；
- 宣告 `docker`、`browser`、`cua`、`lume`、`coder` 等能力；
- 只领取匹配自己 capability 和 policy 的任务；
- 回传状态、屏幕、产物和工具结果；
- 执行短时人工接管租约。

工作主机不负责频道、审批真相、长期记忆、员工技能图谱或 Bot 身份。Mac mini 只是第一种工作
主机；Windows 和 Linux 主流电脑使用同一协议接入。

## 4. 最小角色

| Bot | 责任 | 可用节点 |
| --- | --- | --- |
| `chief` | 拆解、路由、汇总、升级问题 | 无电脑 |
| `ops` | 浏览器、文档和桌面任务 | 跨平台浏览器；必要时 Windows/macOS/Linux 原生 Provider |
| `coder` | 仓库和代码任务 | 隔离 coder Node；后加 Multica |

## 5. 北极星验收

### 场景 A：节点可替换

1. 用户从 Desktop 或手机 Web Client 给 `Ops` 下达测试页填表任务。
2. Server 选择在线 Linux Node。
3. Node 完成填写但不提交，回传截图。
4. 用户在同一频道看到结果。
5. 原 Node 下线后，新 Node 注册并完成下一次相同任务。

### 场景 B：远程审批与接管

1. `Ops` 请求提交表单。
2. Server 在副作用发生前创建审批。
3. 用户从另一设备查看目标、动作、风险和画面。
4. 一次批准只允许对应动作；上下文变化立即失效。
5. 用户也可以取得独占接管租约；接管期间 Agent 输入全部拒绝。

### 场景 C：跨平台专属任务

1. `Ops` 收到必须操作 Windows、macOS 或 Linux 原生软件的任务。
2. Server 只能在声明对应平台 Provider、能力和信任等级的工作主机中选择。
3. 没有合格主机时明确等待，不偷偷切换设备、扩大权限或降级到宿主 Shell。

### 场景 D：查看、复制和转移员工

1. 用户点击 `Ops`，查看它的职责、进化档案、技能来源、记忆、工作记录和当前运行轨迹。
2. 用户导出不含凭证和私人记忆的员工模板，并在另一套 OpenBot 中预览导入内容。
3. 新系统生成本地员工身份；技能默认禁用，直到新用户检查兼容性并重新授权工作主机。
4. 若执行正式所有权转移，来源端权限必须撤销，并保留双方可审计的转移凭据。

## 6. V1 必须有

- 可安装 Desktop 与完整 Web Client 使用同一套本地频道，不依赖 Telegram/飞书。
- 同一个 Desktop 可以只做 Client，也可以按引导配置 Server、Worker Host 或两者。
- 本地 PostgreSQL 保存线程、记忆、策略、审批和审计。
- 不连接 CopilotKit Intelligence 时也能完整启动和工作。
- 一个 Server、一台 Linux Worker Host、`chief` 和 `ops`。
- 节点主动出站连接、心跳、断线、重连和撤销。
- 浏览器任务、实时截图和远程审批。
- 所有事件统一关联 `run_id`。
- Tailscale 私网访问作为默认部署方式。
- 员工个人主页基础、进化事件和版本化技能记录。
- 不包含凭证、设备权限和私人记忆的安全员工模板导入导出。

## 7. 明确不做

- V1 不依赖第三方聊天频道。
- 不把 Server 和 Node 状态做成两个真相源。
- 不承诺 Linux 服务器可以操作 macOS 专属软件。
- 不开放 Node、Docker supervisor、Cua 或数据库公网端口。
- 不做观察用户操作后自动学习。
- 不支持自主支付、转账或主密钥操作。
- 不要求原生 iOS/Android App；移动设备先使用响应式 Web Client。
- 不把原始模型思维链当成审计记录；只展示结构化证据和简明决策轨迹。
- 不承诺 iOS V1 可以无人值守控制任意系统界面。

## 8. Grok Bot 能力映射

| 用户可感知能力 | 阶段 | 实现路径 |
| --- | --- | --- |
| 具名 Bot 和本地频道 | M0 | Adapt CopilotKit/OpenBot app/server |
| 像普通软件一样安装 | Desktop 阶段 | Electron Client + 引导式 Client/Server/Worker 角色配置 |
| 持久线程和记忆 | M0 | Local Threads + PostgreSQL |
| 每个 Bot 有工作电脑 | M1/M3 | 跨平台 Worker Host + Browser/Windows/macOS/Linux Provider |
| 一直在线 | M1 | Server service + Node daemon |
| 任意设备访问 | M2 | HTTPS Web Client + Tailscale；桌面电脑也可使用 Desktop |
| 看着它工作 | M1/M2 | 节点屏幕流经 Server relay |
| 人接管 | M2 | 独占短时 control lease |
| 敏感动作审批 | M2 | Action Gateway + local channel approval |
| Bot 间交接 | M4 | 结构化 handoff |
| 例行工作 | M4 | 本地 worker + durable queue |
| 员工个人主页 | M2 | Profile + evolution ledger + skill graph + records |
| 下载和复制员工 | M3 | 签名、版本化、安全默认的 portable employee package |
| 转移员工 | M5 | 认证所有权交接 + 来源撤销 + 导入凭据 |

员工模型的完整边界见[可迁移数字员工模型](EMPLOYEE.zh-CN.md)，跨平台主机策略见
[跨平台工作主机](CROSS_PLATFORM.zh-CN.md)。
