# Desktop alpha.4 功能清单与产品设想对照

[English](2026-09-10-feature-inventory.md) · [简体中文](2026-09-10-feature-inventory.zh-CN.md)

## 范围与总体判断

本清单覆盖分享修复基线 `8f6520e` 和本轮 Desktop alpha.4，新增能力见[核心升级说明](../CORE_UPGRADE.zh-CN.md)。它不是所有功能的完整实机验收，不是实际模型产出的质量评价，也不是所有操作系统的兼容性认证。“已接通”表示界面调用了已实现的 API 或 Desktop bridge；当前安装能否执行，还取决于密钥、Provider、打包组件及主机授权。

当前 OpenBot 已具备持久员工与对话、有边界的模型 Agent、公开资料研究、Markdown 产出、审核后的技能与记忆，定时任务、频道 Bot 委派、持久附件和经授权的 MCP 工具。这与[产品定义](../PRODUCT.md)中的持久数字员工方向有实质一致性。通用电脑操作、无限异步多 Bot 协作、公开插件分发和认证所有权转移仍有独立差距。

四个对象需要分清：**Bot 是员工，Channel 是长期工作上下文，Run 是一次任务，Node 是获授权的执行电脑**。身份、路由、审批和记录以 Server 为准。技能描述“怎么做”，不能自行增加工具或权限。

## 安装、导航与日常对话

| 部件 | 当前已实现行为 | 边界及与设想的关系 |
| --- | --- | --- |
| 首次引导 | 选择本机作为服务电脑或连接已有服务；安装页展示进度与重试，连接页保存 Server 地址。 | 可用角色受打包适配器约束。退出服务电脑的 Desktop 会停止本机服务，还不是持续运行的系统服务。 |
| 登录与会话 | Owner 登录、会话校验、重新连接和退出。 | 不是多人组织、成员和角色权限管理产品。 |
| 顶部工具栏 | 开关左右栏、页面前进后退、频道与成员菜单、工作电脑及分享入口。 | 是真实应用导航，不增加任务授权。 |
| 左栏与搜索 | 按频道名称/简介和 Bot 名称过滤，创建对象，进入插件与设置。 | 不是聊天全文或全部文件搜索；未发现频道改名、删除、归档和 Bot 删除界面。 |
| Bot 入口 | 单击打开持久专属对话；右键或 Shift+F10 打开员工档案。 | 当前以对话为主要点击动作，与产品文档概括性的“点击 Bot 查看主页”有差异。 |
| 频道与成员 | 创建频道名称、工作目标，选择初始 Bot，通过成员菜单添加已有 Bot。 | 任务中的 Bot 可发现同频道成员并委派原生工作；仅加入频道不会自动触发对话，未发现移除成员界面。 |
| 创建 Bot | 保存名字、职责、固定执行配置，实时预览头部/身体/移动方式/配件/强调色组合。 | 默认暂不绑定电脑。Docker/Cua/Lume/Coder 可选不证明运行时可用；外观是身份，不是权限等级。 |
| 输入与回复 | @候选选一名接收 Bot，私聊已有接收对象；引用回复、文字消息、发送中继续起草、回到最新消息。 | 初始任务面向一个 Bot；它可按职责调用其他成员并汇总结果，当前为有界顺序委派。 |
| 附件 | 持久保存文本/代码（256 KiB）、PNG/JPEG（5 MiB）、PDF（10 MiB）；每任务八件/20 MiB，正文保留短引用。 | 文本分页读取；图片/PDF 依赖 OpenAI/Anthropic 所选模型支持。尚无 Word/Excel 提取、OCR 和音视频转写。 |
| 使用技能 | 请求所选 Bot 最多 2 个已审核技能，可从草稿移除。 | 运行时重查分配、状态和内容身份；请求技能不能增加工具或外部操作权限。 |
| 时间线与实时更新 | 保存消息、引用、Markdown/表格、产物、任务链接，接收 Server 事件更新。 | 有连续上下文；没有不限范围的历史搜索或离线编辑。 |

证据：[引导](../../apps/web/src/components/DesktopSetupScreen.tsx)、[安装](../../apps/web/src/components/DesktopInstallScreen.tsx)、[连接](../../apps/web/src/components/DesktopConnectionScreen.tsx)、[应用导航](../../apps/web/src/App.tsx)、[左栏](../../apps/web/src/components/Sidebar.tsx)、[创建频道](../../apps/web/src/components/CreateChannelDialog.tsx)、[成员](../../apps/web/src/components/ChannelMembersMenu.tsx)、[创建 Bot](../../apps/web/src/components/CreateBotDialog.tsx)、[对话](../../apps/web/src/components/ChannelWorkspace.tsx)、[附件组合](../../apps/web/src/composer-context.ts)、[Server 路由](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/app.ts)。

## Agent 执行、产出与监督

配置工作空间模型并启用原生 Agent 后，新建的无电脑任务可以运行模型与工具循环。工具能读取本频道有界消息和任务状态、无需登录/Cookie 的公开 HTTPS 页面、审核技能及明确允许模型使用的记忆；配置了搜索服务适配器时还可搜索。任务可以准备一条经验候选并生成 Markdown 报告。

这不是带登录态的交互浏览器。公开页面读取拒绝私网和重定向。当前 Native Agent 没有通用 Shell、任意桌面输入、对外消息发送或任意配置修改工具。员工职责和 Provider 名称不能补足这些缺失能力。

| 部件 | 实际行为 | 限制 |
| --- | --- | --- |
| 活动任务条 | Bot、状态、最新结构化阶段、详情入口。 | 展示可观察进度，不展示原始思维链。 |
| 任务详情 | 指令、分配的 Bot/Node、进度、可用画面、产物、失败信息。 | 此版本没有可交互员工浏览器或通用接管界面；截图不等于可控制电脑。 |
| 停止/重新提交 | 停止排队或运行中的 Native 任务及其活跃后代；将失败/取消任务的指令提交为新任务。 | 只适用于无节点 Native 任务；重提从头执行且保留旧记录，不是断点续跑。 |
| 报告/产物 | Native 任务成功后最多发布 2 份 Markdown，每份不超过 24 KiB；支持 PNG 查看及 Desktop 原生报告保存。 | 不是任意 DOCX/XLSX/PPTX 生成器；实际质量和证据完整性需审阅。 |
| 审批 | 显示风险、目标、摘要、有效期，经 Server 保存批准/拒绝。 | 动作标签不证明执行适配器可用；内置工具不发送邮件或提交表单；已授权的第三方 MCP 工具可在必要确认后执行其声明的外部操作。 |
| 信息栏 | 当前频道审批、进行中、最近结果，可展开工作区和主机概览。 | 限于已加载记录，不是无限历史分析。 |
| Token 用量 | 汇总范围内已知输入/输出，保留未知/无数据状态。 | 不是供应商额度、余额、费用或账单；不推算缺失用量。 |

证据：[Agent 工具](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/native-agent.ts)、[运行时接线](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/index.ts)、[有界上下文](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/postgres-agent-store.ts)、[详情](../../apps/web/src/components/RunInspector.tsx)、[控制](../../apps/web/src/components/NativeRunControls.tsx)、[产物](../../apps/web/src/components/ArtifactCard.tsx)、[审批](../../apps/web/src/components/ApprovalCard.tsx)、[信息栏](../../apps/web/src/components/ContextRail.tsx)。

## 员工档案与审核式学习

| 档案栏目 | 已实现行为 | 仍需区分的边界 |
| --- | --- | --- |
| 概览 | 职责简介、任务/完成/失败/已验证技能数量、最近进化/技能/工作。 | 是真实记录，不是智能分数或权限。 |
| 进化档案 | 按类型和截止时间筛选有日期的事件，查看来源及证据。 | 是变化账本，不是无人审核的自主技能获得。学习与进化方向明确受到 Hermes Agent 启发。 |
| 技能图谱 | 查看版本、来源、完整导入指令、依赖、能力要求、证据；审核、暂停/撤销、导入不可变版本。 | 当前是审核列表，不是完整图谱画布。审核正文可被 Agent 实际读取，但不能增加工具。 |
| 运行中 | 活跃任务记录和结构化决策摘要。 | 没有原始思维链、独立远程控制或完整审批台。 |
| 记忆 | Owner 新增/编辑/删除、类型/敏感度/未来迁移策略、生命周期记录，逐条许可模型使用。 | 运行时能读取本 Bot 获许可的记忆；没有通用搜索/保留时限编辑或无审核自动写入。 |
| 工作记录 | 日期、任务、状态、结果/错误及关联审批/产物/决策数量。 | 不是完整可搜索的审计浏览器。 |
| 配置 | 修订保护下编辑职责/简介，查看执行与包边界。 | 没有每 Bot 模型、主机绑定编辑、策略编辑或完整迁移管理；模型由工作空间统一配置。 |

学习已经有部分真实闭环：成功任务可提出一条可复用经验。Owner 可以编辑标题/正文、接受为内部不可迁移记忆，或拒绝并删除候选；另行勾选才能允许后续模型使用。审核前不是生效记忆，也不可供后续任务读取；Agent 不能自己批准。这是审核式学习，不是观察用户电脑后自动学习。

证据：[主页/记忆](../../apps/web/src/components/EmployeeProfileView.tsx)、[进化](../../apps/web/src/components/EmployeeEvolutionArchive.tsx)、[技能](../../apps/web/src/components/EmployeeSkillReview.tsx)、[候选经验](../../apps/web/src/components/KnowledgeReviewPanel.tsx)、[运行时工具](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/native-agent.ts)。

## 插件与可迁移员工

**插件页**有技能和 Bot 两个标签，面向当前工作空间提供搜索、技能状态筛选、选择导入目标 Bot、档案入口及创建/导入 Bot。界面明确写明外部技能商店尚未接入。新增 MCP 工具管理：预览端点与声明、审阅安装、启停/移除、按 Bot 授权，以及频道内逐次审批。当前没有公开市场、OAuth、stdio 或 MCP resources/prompts；见[作者手册](../PLUGINS.zh-CN.md)。

SKILL.md 导入接受一个不超过 12 KiB 的 Markdown 文档及版本号，先成为候选，查看全文并审核后才能使用。当前只支持使用已有工具的单文件指令，不加载附属资源、不运行脚本，也不能任意访问文件。员工导出不包含这类导入技能的正文。

员工导出先预览包含/排除项、阻止原因与签名状态，再下载与审核绑定的 JSON。导入先检查结构、完整性、适用签名及兼容性，再由 Owner 单独激活为新的本地身份；导入技能初始禁用。凭证、主机权限、私人记忆和工作历史不会随包迁移。这不是认证所有权转移，也不是完整复制原员工掌握的一切。

证据：[插件页](../../apps/web/src/components/SkillLibraryScreen.tsx)、[技能导入](../../apps/web/src/components/EmployeeSkillImport.tsx)、[员工导出](../../apps/web/src/components/ExportEmployeeDialog.tsx)、[员工导入](../../apps/web/src/components/ImportEmployeeDialog.tsx)、[员工模型](../EMPLOYEE.zh-CN.md)。

## 自动任务、工作电脑与设置

| 部件 | 已接通行为 | 限制 |
| --- | --- | --- |
| 自动任务 | 创建名称、频道、成员 Bot、指令、未来首次时间和每小时/24小时/7天间隔；查询/搜索、最近/下次执行、暂停/恢复/删除；Server 有 CRUD 与调度。 | 按经过时间而非完整日历/cron；无已有任务指令/计划编辑。暂停不取消已提交任务。服务需持续运行，远程客户端可关闭。 |
| 主机管理 | 登记/在线/撤销状态，一次性配对凭证，撤销身份。 | 登记或配置可选不证明能完成任意任务。 |
| 本机 Worker | Desktop 绑定、启用、系统设置入口、状态/权限刷新。 | 依赖打包和系统授权，不代表所有平台原生操作认证。 |
| 常规设置 | 支持时半透明侧栏、左右栏、密度/字号、减少动效、发送键、时间制式。 | 保存在本设备；平台与无障碍偏好影响材质。 |
| 模型设置 | 工作空间统一厂商、受支持 API 地址/区域、模型ID、加密密钥、可用时发现模型、Native Agent 开关。 | 不是多条并存连接或每 Bot 覆盖；部分厂商只验证格式，实际任务才验证调用。 |
| 工作电脑设置 | 改本机用途/客户端地址，进入主机管理。 | Host 仅本机，关闭 Host Desktop 会停服务。 |
| 隐私/数据 | 说明存储、密钥、授权、用量；恢复本机 UI 默认。 | 不是备份恢复、业务数据重置、账号删除或批量导出。 |
| 关于/帮助/反馈 | 平台/Electron、Hermes 归因、GitHub文档和问题链接。 | 不自动发送反馈，没有更新检查流程。 |
| 移动端 | 响应式频道/Bot/审批/主机入口。 | 源码存在不构成移动端或所有平台验收。 |

证据：[自动任务](../../apps/web/src/components/AutomationsScreen.tsx)、[页面 API](../../apps/web/src/destination-api.ts)、[Server](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/app.ts)、[主机](../../apps/web/src/components/NodeManagerDialog.tsx)、[本机 Worker](../../apps/web/src/components/DesktopLocalWorkerScreen.tsx)、[设置](../../apps/web/src/components/DesktopSettingsScreen.tsx)、[模型设置](../../apps/web/src/components/ModelSettingsScreen.tsx)、[偏好](../../apps/web/src/workspace-preferences.ts)、[移动端](../../apps/web/src/components/MobileNavigation.tsx)。

## 本次分享调整

顶栏分享仅显示图标，同时保留无障碍名称和悬浮提示。面板列出**当前频道最近产出文件**并提供下载，Markdown 可预览和复制。这里显示当前已加载任务的文件，数据来自工作空间投影；没有针对全历史产物的独立分页，不是无限文件档案库。

**分享模板指直接分享 Bot 本身。** 选择当前频道内的 Bot，进入已有员工导出预览；检查实际包含/排除内容后下载员工模板，供其他人导入自己的 OpenBot。这复用 Server 管理的审核和导出流程，不要求模型总结任务方法，也不把聊天记录导出成模板。

接收者获得有边界的员工定义和允许的元数据，不会同时获得凭证、权限、私人记忆、历史对话、所有学到的指令正文或原身份所有权。尤其是当前员工包不包含导入的 SKILL.md 正文；如果期望对方得到“完全相同且训练内容齐全的 Bot”，这一限制需要明确。

| 对象 | 用途 | 区别 |
| --- | --- | --- |
| 产出文件 | 下载任务实际生成的成果。 | 不是员工身份或聊天全文。 |
| Bot/员工模板 | 按可迁移员工包规则预览并导出选定 Bot。 | 不是任务方法总结、完整克隆、权限转移或认证所有权转移。 |

证据：[分享面板](../../apps/web/src/components/ShareConversationDialog.tsx)、[下载](../../apps/web/src/components/ArtifactCard.tsx)、[工具栏/导出路由](../../apps/web/src/App.tsx)、[导出预览](../../apps/web/src/components/ExportEmployeeDialog.tsx)、[包规则](https://github.com/Peerframe/openbot/blob/67ed7a1f18b8048d76e0ffd373dd4c26c1c4dd69/apps/server/src/employee-package.ts)。

## 与整体产品设想的对照

最符合设想的是持久员工与频道基础：任务结束后身份仍在，Server 保存对话和产出，变化有证据，审核后的技能与记忆可用于未来任务，重复工作可以定时。审核式学习闭环是朝 Hermes 启发方向推进的实际能力。

本轮已补上真实 Bot 委派和 MCP 工具；主要差距仍是无限异步协作、通用浏览器/原生电脑执行及独占接管、本机服务持续在线、公开插件分发、完整员工复制/所有权转移和更多产出格式。[产品北极星场景](../PRODUCT.md)中的可替换节点自动填表、精确上下文审批后执行相应副作用、跨平台原生软件操作，需要分别依据执行与一致性证据验收。仅有下拉框、审批卡、截图或协议结构不足以证明这些场景已完成。
