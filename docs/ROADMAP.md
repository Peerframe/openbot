# 实施路线图

当前开发主线与验收状态见 [独立开发主线](DEVELOPMENT_TRACKS.zh-CN.md)。以下保留历史阶段记录。

当前交付状态见 [2026-09-08 功能与缺口清单](DELIVERY_STATUS.zh-CN.md)。下文保留此前阶段路线。

## 当前进度

M1 第二切片已完成：Server 会自动执行 PostgreSQL migration；频道、Bot、频道成员、频道消息、任务、结构化事件、Owner Session、结果和 Artifact 元数据会真实落库；Web 可以本地登录、创建组合式 Bot、创建频道、把 Bot 加入频道并指定 Bot 提交任务。任务完成结果会作为 Bot 回复保存到频道，频道 SSE、多浏览器即时同步、回复关系、富文本表格、断线检测和自动重连已跑通。任务再以 Bot 固定的 execution profile 匹配有容量的 Node。

Node 已通过出站 WebSocket 上报真实可执行能力和并发容量；两阶段 offer/accept/confirm、显式 start、progress、frame、completed/failed/settled、数据库条件转换、节点断线恢复已通过进程级链路验证。首个 Docker provider 已用薄适配层接通 CopilotKit/OpenBot `agent-computer`：当前只打开任务中明确的公开 URL 并回传一张 PNG。Workspace SSE 已让 Node、Run 与审批状态在所有设备实时同步；结构化 progress 与最新临时画面已进入 Run Inspector。

M2 第一切片已完成：Node/provider 可发送结构化 `approval.request`，Server 原子保存审批和目标指纹并把 Run 切换为 `waiting_approval`；桌面 Attention 与手机审批页可批准一次或拒绝，决定会审计并回传原 Node。重复决定、过期审批和失联 Node 均 fail closed。下一步是接入真正的交互式 provider，并把当前请求/决定握手升级为可验证、可消费一次的 capability lease；连续画面与接管仍待补。

M3 基础切片已完成：员工进化事件、版本化技能、技能依赖和分类记忆已经落库；七视图员工主页
可以从 Bot 列表、频道成员和消息作者进入。安全模板导出已有严格 schema、默认排除项、疑似敏感
文本阻止、SHA-256 校验和 Owner 鉴权下载。只读导入预览也已完成严格 schema、2 MiB 上限、
完整性与技能语义检查、敏感文本检查和在线主机兼容报告。审核后激活会绑定预览摘要、生成新身份、
把技能保持候选禁用并写入不可变幂等收据；它不会导入记忆、绑定主机或获得工作主机权限。
当前 HTTP 模板默认未签名且不含记忆。实验性的 Owner 文件密钥库已经完成加密 PKCS#8 保存、
显式公钥信任、轮换、撤销，以及 DSSE/Ed25519 签名导出和验签后隔离预览；公钥指纹必须带外核对，
任何包都不能自授信任或携带权限。Agent Skills
兼容的技能元数据现在只能先成为候选，再由登录 Owner 验证、暂停或永久撤销；每次变化都会追加
进化事件，不会改变主机权限。员工主页已经可以展开查看来源、版本、主机能力声明、依赖和证据引用，
只显示当前状态允许的审核动作，永久撤销需要第二步确认。进化档案明确参考 Hermes Learning Journey，
目前可按事件类型筛选、沿真实日期截止查看历史，并展开完整事件/来源/证据标识。登录 Owner 现在还可以新增、编辑和删除分类记忆；接口带字段上限、
凭据值阻止和 revision 并发检查，删除会移除正文并只留下无内容审计。模型与工作主机不能写记忆，
v1 员工包仍排除全部记忆。员工变更还会向其他已连接设备发送不含正文的档案失效通知，让它们
从 Server 重读当前员工。Owner 还可以用 revision 冲突检查编辑职责与说明性简介；另一台设备
更新时，本地草稿不会静默覆盖。新导出的安全模板会保留简介并继续扫描敏感内容，旧 v1 模板仍
兼容。导出下载现在还必须返回预览生成的包 ID、时间和强 `ETag`；内容或发布密钥变化时会以
`412` 阻止旧审核请求，Client 只刷新预览，不会自动下载替代文件。下一步是分别审查显示名、
模型/Provider、工作主机与外观编辑，以及系统钥匙串/KMS/TUF
信任适配、可执行技能目录的隔离检查、
完整 diff 审核、注册表分发、选择性复制和认证所有权转移。

新版产品方向已经确定：Desktop 是主要安装入口，Web 是完整远程入口和模块化自部署入口；同一个
Desktop 可以组合 Client、Server 与 Worker Host。技术选择已经完成；首个 Desktop 安全外壳切片
已经实现本地打包界面、沙盒 renderer、最小 preload、受限 `openbot://` 资源协议、严格 ASAR/fuse
策略，并在 Windows、macOS 与 Linux CI 中构建未签名开发包。第二个 Desktop 切片已实现连接已有
Server 的初次引导：严格 origin 配置、健康证明、原生确认、专用 Session Cookie、受限 REST/SSE
代理、更换 Server 时清除会话，以及打包后运行时依赖清单校验；macOS arm64 本地开发包已完成从
首次连接到登录工作区的实际验证。第三个切片已经实现四种安装模式、最多 100 台 Worker 电脑的
配置清单、本地严格持久化与重启恢复；“5 台电脑”会明确列出当前电脑和其余工作电脑，但保存计划
不会安装服务、登记设备或授予权限。第四个切片已经在本地实现 Desktop 引导的 macOS Worker
配置：使用同一 Desktop 包内的独立 Swift companion，由已鉴权 main process 私下申请并传递单次
token，页面只显示真实服务状态和系统批准步骤；固定 companion 构建和包内清单已加入 macOS CI。
签名、更新、Server 安装、Windows/Linux Desktop 服务适配器和真实设备矩阵仍未完成，因此还不能
宣称任何桌面平台已经 Supported。精确语言、版本和安全边界见
[技术基线](TECHNOLOGY.zh-CN.md)。

## 新版产品交付顺序

每个阶段使用独立、可回滚的 Pull Request；Codex 负责实现和验收，Owner 负责阶段末的产品、权限、
合并和发布检查点。

1. **文档与技术基线：**同步双语 README，确定语言、Desktop 外壳、角色组合和安全边界。
2. **Desktop Client：**交付只加载本地资源的 Electron 壳，共享现有频道 UI，并连接已有 Server。
3. **多设备与自部署（进行中）：**安装模式、持久化配置清单、“五台电脑”规划，以及 Desktop 引导
   的 macOS Worker 绑定/服务状态源码已经实现；下一步完成签名真实设备门槛，再加入 Server 安装、
   Windows/Linux Desktop 适配器、逐台配对总览、恢复事务和独立安装路径。电脑数量只是进度清单，
   不是授权限制。
4. **多 Agent：**先以 Server 控制的有界委派适配 OpenBot、Hermes、Pi 和 OpenClaw，再评估哪些
   Agent 可以成为频道中的直接成员。
5. **插件平台：**定义签名、来源、权限、UI 槽位、主题、频道、Agent、工具和 Provider 扩展；插件
   默认不可信且不能自授权限。
6. **安全执行：**完成一次性 capability lease、交互 Provider、连续画面、独占接管和真实平台权限
   证据。
7. **发布：**完成签名安装包、自动更新、回滚、SBOM、第三方声明、备份恢复、真实设备矩阵和明确
   的 Experimental/Supported/Certified 标签。

任何阶段未通过验收都不能通过扩大宣传或跳过测试来“完成”。

## M0 — 本地控制平面（基础已完成）

### 已交付

- 本地 Owner 认证、PostgreSQL、频道、Bot、消息、Run、审批、产物和审计。
- 频道优先的响应式 Web UI、组合式 Bot 外观和多设备实时同步。
- 办公室隔离为未加载的 `@openbot/office-plugin`。

### 剩余过线项

- Desktop Client、响应式 Web 的可安装能力、通知投递、恢复工具和更完整的无障碍支持。

## M1 — 跨平台 Server/Node 基础

### 交付

- Linux x64/arm64 生产 Server 镜像，可运行在 Linux、NAS、云、macOS 或 Windows 容器主机。
- 结构化 Worker Host 身份、版本化 capability 和确定性能力路由。
- Windows、macOS、Linux Node daemon 的共同生命周期和兼容测试。
- 已完成一次性 Node enrollment 与单节点吊销；继续完成持有证明、证书轮换、系统密钥库和防重放。

### 过线测试

- 三种桌面平台的模拟 Node 都能注册、心跳、领取匹配任务并安全断线。
- Node 不开放公网入站控制端口。
- 更换工作主机后，员工、频道和历史保持不变。

## M2 — 安全浏览器、审批与接管

### 交付

- 跨平台语义浏览器 Provider 的 observe/fill/act 循环。
- 审批前冻结动作、一次性 capability lease 和上下文指纹复核。
- 连续画面、短时 view token、独占 control lease 和人机互斥。
- 手机 Web Client 审批、通知和接管。

### 过线测试

- 未批准的 commit 不发生；批准不能重放，超时或目标变化立即拒绝。
- 一台 Client 接管后，其他 Client 和 Agent 都不能输入。
- Client 无法绕过 Server 直连工作主机。

## M3 — 员工档案、技能与可迁移模板

### 交付

- 员工个人主页：概览、进化档案、技能图谱、运行轨迹、记忆、记录和配置。
- 有来源、版本、验证状态和证据的技能注册表。
- 类型化记忆、敏感等级、保留和删除控制。
- 安全默认的员工模板导出、导入预览和本地重新授权。

### 过线测试

- 每项进化和技能都可以追溯证据。
- 决策轨迹不暴露私有思维链、密钥或凭证。
- 默认员工包不含私人记忆、设备身份、电脑权限、Session 或租约。
- 导入员工在新 Owner 授权前不能操作任何工作主机。

完整模型见[可迁移数字员工模型](EMPLOYEE.zh-CN.md)。

## M4 — Windows、macOS、Linux 原生工作主机

### 交付

- Windows UI Automation/PowerShell Provider 与 Windows Service。
- macOS Cua/Lume Provider、权限诊断与 launchd 服务。
- Linux Shell/File Provider，随后认证支持的 Linux 桌面环境。
- 全部 Provider 使用相同 prepare/approve/commit 和一致性测试。

### 过线测试

- 同一员工可以在策略允许时更换 Windows、macOS 或 Linux 工作主机。
- 缺少对应 Provider 时不会错误路由或静默降级。
- 工作主机使用员工专用账户，不复用 Owner 主账号和主密码库。

平台矩阵见[跨平台工作主机](CROSS_PLATFORM.zh-CN.md)。

## M5 — 多 Bot、Routine、Coder 与所有权转移

### 交付

- `chief` / `ops` / `coder` 结构化 handoff。
- durable queue、并发限制、幂等、重试、熔断和长期记忆。
- Codex/Claude CLI adapter 与可选 Multica Provider。
- 经认证的员工所有权转移、来源端撤销和双方收据。

### 过线测试

- `chief` 无电脑权限，只能派活和汇总。
- Routine 在 Server 重启后不重复执行副作用。
- `coder` 不能读取 `ops` 的浏览器配置或原生桌面凭证。
- 完成转移后，来源端不能继续使用员工身份或权限。

## M6 — 移动设备、发布与运维

### 交付

- 受管理 Android Node 与 iOS/Android 伴侣端。
- Server Docker Compose、Linux systemd、Windows Service 和 macOS launchd 安装。
- 固定版本、签名、checksum、SBOM、第三方 notice、备份、恢复和回滚。
- Provider 模板、支持等级、兼容矩阵和社区认证流程。

### 过线测试

- 新 Server 能从备份恢复员工、频道、策略和审计。
- 升级失败能回滚且不重新消费审批。
- Experimental、Supported、Certified 能力不会在产品和文档中混淆。

## 下一批 Issue

这些条目已经拆成可独立领取的验收包，见[贡献者任务包](CONTRIBUTOR_TASKS.zh-CN.md)。新增
Provider 请使用专门 Issue 表单，不要用能力声明代替真实设备证据。

1. `Skills: validate quarantined SKILL.md directories with the official skills-ref worker`
2. `Skills: add bounded proposal expiry, supersession, notification, and full-diff review`
3. `Conformance runner: execute scenarios and publish the implemented machine-readable reports`
4. `Provider CI: run hermetic and real-device Windows, macOS, and Linux matrices`
5. `Employee registry: distribute publisher trust, revocation, and package updates`
6. `Import: add package-family update and selective local clone semantics`
7. `Memory: add retrieval, retention, autonomous proposal review, redaction, and selective export`
8. `Node identity: add proof-of-possession, rotation, native keyrings, and replay protection`
9. `Approval: issue single-use capability leases bound to target fingerprints`
10. `Web: add accessible internationalization for Employee portability flows`
