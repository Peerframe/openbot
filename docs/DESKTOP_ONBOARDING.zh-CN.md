# Desktop 首次设置

[English](DESKTOP_ONBOARDING.md)

macOS arm64 和 Windows x64 桌面发行包含本地 Server 与 PostgreSQL。
首次使用时选择这台电脑的连接方式：

- **服务电脑：** Desktop 初始化自己的 PostgreSQL 17 数据库、启动随包提供的 Server、创建
  私有 Owner 身份、自动连接，然后进入模型设置。无需 Docker、Homebrew、管理员账户或首次启动下载。
- **远程客户端：** 验证并保存已有 HTTPS Server 地址，再登录对应的 Owner 账户。
  不初始化或启动本地数据库和 Server。

macOS 保留原生红黄绿按钮和左侧栏收起开关。侧栏保留 **OpenBot** 文字品牌，只删除独立品牌图标。
文字右侧的唯一创建 **+** 提供创建频道和 Bot；不再单列“新建对话”，频道和 Bots 标题旁也没有额外加号。
搜索筛选已授权的频道和 Bot。底部仅保留“插件”和“Owner”；Owner 菜单提供设置、关于、帮助、反馈和
退出登录。办公室场景继续搁置。

## 工作空间导航与对话

左右侧栏可分别收起和展开。频道名称与横向堆叠的 Bot 头像合为一个无边框入口，点击查看频道详情和
成员，不再另设三点菜单。右上角分别保留分享、工作电脑、右侧信息栏开关。顶部紧凑任务进度条与频道信息栏保留。

点击侧栏 Bot 打开其持久单独对话；右键点击打开 Bot 档案。单独对话由 Server 绑定唯一 Bot 标识，
反复打开复用原对话，禁止添加其他成员或将任务改派给其他 Bot，也不列入普通频道。
见[单独对话调研](research/desktop-direct-conversations.zh-CN.md)。

后退和前进可以返回访问过的工作空间页面。新建频道后立即进入，从设置返回保留原页面、草稿和阅读位置。
导航仅改变本机界面状态，不改变 Server 路由或权限。见[导航调研](research/desktop-navigation-continuity.md)。

对话保留清晰的消息、引用回复和关联任务状态。在频道中输入 **@**，从当前成员中选择 Bot；选中项使用
Server 返回的真实标识。单独对话无需提及 Bot。输入区底部不再提供 Bot 下拉框；圆角输入框按内容从两行
增高到八行，保留发送按钮，默认 Enter 发送、Shift+Enter 换行。阅读旧消息时保持位置，点击“回到最新”恢复跟随。

输入框的 **+**、拖放和文件粘贴都可以添加附件。每条消息最多 **8 个文件，合计 20 MiB**：
文本与代码每个最多 256 KiB，PNG/JPEG 每个最多 5 MiB，支持的 PDF、Office/OpenDocument 和音视频
每个最多 10 MiB。原文件保存在 Server，可随时下载；提取文字、OCR 与转写是独立操作。
媒体转写会在明确点击后把所选媒体发送到已配置的服务。上传可以取消，失败时只重试失败文件，
保留成功附件。取消后忽略迟到响应；Server 已经收到的原文件可能仍在附件管理中。
录音、添加语音草稿与发送消息分别操作。技能标签只请求使用已审核技能，不授予能力。

**分享**提供任务产出下载和分享 Bot 本身。分享 Bot 时先预览档案与已验证技能；选中已审核的单文件
技能正文后使用 v2 包。私人记忆、历史、密钥与电脑权限保留在来源 Server。
接收方创建新 Bot，并在模型使用前审核导入的技能正文。见[员工分享说明](EMPLOYEE.zh-CN.md)。

完成首次设置后，再次打开会恢复原本的本地服务和数据库，用紧凑连接状态代替安装检查清单，
沿用已保存凭据。系统密钥读取采用异步方式，系统授权期间启动窗口仍可响应；解锁失败不会覆盖
原有加密身份或数据。未签名构建变更后，macOS 仍可能要求钥匙串授权，详见下方发行限制。

每个频道的文字草稿、所选 Bot、引用回复、附件与技能标签分别保存在当前工作空间的会话内存中。
发送过程中切换频道，结果仍属于原频道；发送成功只清空没有继续编辑的已提交草稿，保留更新后的输入。
每个频道同一时刻只发送一条消息；失败时保留草稿，不自动重试。网络结果不确定时，先查看频道记录再提交。

草稿不会写入磁盘或 localStorage，退出登录、更换 Owner/Server、重新加载或关闭窗口后不保留。
内存缓存最多保留 32 个访问过的频道，每条草稿最多 8,000 个字符。有未发送文字、引用回复、附件/技能选择或正在发送的
频道不会被挤出；全部位置占用时，下一个频道会提示达到上限，需先发送或清空较早的草稿。
这不等同于离线发送或服务端幂等重试。见[对话连续性调研](research/desktop-conversation-continuity.md)。

右侧信息栏优先显示当前频道的待批准操作、进行中的任务、最近结果与产物，已有操作仍由 Server 授权。
Token 面板在 Server 提供测量时展示相应用量；缺失测量仍显示不可用。近期有界任务/用量数据不代表
全部历史累计或已计费用量。见[信息栏调研](research/desktop-contextual-inspector.md)。

macOS 左侧导航使用 Electron 提供的原生侧栏材质，聊天和信息内容区保持不透明；可在设置中关闭透明效果。
系统的“减少透明度”或“高对比度”优先于应用选择；环境不支持或材质不可用时使用不透明背景。
当前工作空间采用浅色外观，本次不宣称完整深色主题或 Liquid Glass 实现。
见[材质调研](research/desktop-sidebar-material.md)。

## 原生菜单与快捷键

macOS 的应用、文件、编辑、显示和窗口菜单使用中文。文字编辑、缩放、全屏和窗口操作使用 Electron
提供的原生角色；对应页面操作可用时，导航菜单才会启用。

| 操作 | macOS 快捷键 |
| --- | --- |
| 创建频道 | Command+N |
| 打开设置 | Command+, |
| 后退 / 前进 | Command+[ / Command+] |
| 显示或隐藏左侧栏 | Command+B |
| 显示或隐藏信息栏 | Command+Shift+B |

这些页面操作仍可从界面直接使用。本次不新增全局快捷键、任意命令通道、重新加载菜单或开发者工具菜单。
见[原生菜单调研](research/desktop-native-navigation-menu.md)。

## 设置与本机偏好

通过“**Owner → 设置**”进入。设置占满应用窗口，以自己的竖向分类导航、搜索和“返回应用”替换频道/Bot
侧栏。分类按“应用”和“工作空间”分组：

| 分类 | 可调整的内容与说明 |
| --- | --- |
| 常规 | 半透明侧栏、两栏独立开关、舒适/紧凑间距、14/16 px 字号、减少动态效果、发送快捷键、12/24 小时时间 |
| 关于 OpenBot | 版本、平台与运行时、模型接口选项及 Hermes Agent 启发来源 |
| 隐私与数据 | 数据/凭据位置、Server 授权边界、可用用量及恢复本机界面偏好 |
| 模型服务 | 验证并保存 Server 的**唯一默认模型配置**、替换密钥、明确启用或关闭原生 Agent |
| 工作电脑 | 当前用途和 Server 地址、更换用途/远程连接、管理设备、查看本机 Worker 状态 |
| 自动任务 | 通过已有 Server 接口创建和管理持久计划 |

提供方预设是同一个默认配置的选项，不表示已保存多条独立连接，也不表示支持为每个 Bot 单独指定模型。

界面偏好是保存在本机 renderer 资料中的非秘密数据，不是服务端的工作空间策略。调整立即生效，
存储可用时重新打开会保留；保存失败则在本次打开期间继续生效，设置会说明未能保存。
恢复界面默认偏好不会删除对话、Bot、自动任务或模型凭据。更换 Server 连接会清除 Desktop 会话存储，
可能使这些偏好恢复默认。Shift+Enter 始终换行，输入法组词期间不会发送消息。
即使应用内“减少动态效果”关闭，系统的对应设置仍然有效。
见[偏好调研](research/desktop-workspace-preferences.md)。

## 插件与自动任务

从侧栏底部打开“插件”，页面占满应用窗口并提供“返回应用”，不保留工作空间侧栏。“技能”页列出实际工作空间
技能，可搜索和按状态筛选。“添加技能”为选中的 Bot 导入单个 `SKILL.md`，进入原有审核流程；导入不代表
立即信任或激活。进入对应 Bot 档案审核来源、版本、全文、声明的能力和内容摘要。“Bots”页提供创建 Bot 和已有的
Bot 模板审核导入流程。档案读取失败明确显示不可用，不视为空记录。这里是工作空间扩展界面，不是公共插件商店或
任意可执行插件包安装器。见[入口调研](research/workspace-destinations.md)及
[界面优化调研](research/desktop-ui-refresh.zh-CN.md)。

在“技能”与“Bots”页签上方展开“插件”面板，选择“添加工具插件”，即可预览并安装 MCP Server 连接。
审核声明后，为 Bot 授予选定工具或内容的权限，再启用插件。仅安装不会授予访问权限；调用仍受 Server
授权和所选审批模式约束。见 [MCP 插件说明](PLUGINS.zh-CN.md)。

自动任务通过“**Owner → 设置 → 自动任务**”进入。

已登录的 Owner 可以为频道中的 Bot 新建自动任务，再暂停、恢复或删除计划。界面提供每 1 小时、
每 24 小时、每 7 天的固定时长间隔；首次时间按界面显示的本地时区输入，并保存为 UTC 时间点。
这些间隔不承诺跨夏令时保持相同的当地钟点。Server 接受 15 至 10,080 分钟的间隔，首次时间须在未来
366 天内；每个 Server 工作空间最多保存 50 个计划。

计划持久保存在 PostgreSQL，由 Server 沿用已有路由、审批和审计流程提交普通频道任务。
服务电脑需要保持运行，远程客户端可以关闭。停机后恢复时，最多提交一次已经到期的任务，再跳过错过的间隔，
不会连续补跑积压次数。上次 Run 尚未完成时跳过本次；恢复已过期的计划会把下次时间移到未来。
到期检查发现 Bot 已被移出频道时暂停对应计划，不会自动改派给其他 Bot。暂停或删除计划只停止后续提交，
已经创建的 Run 和历史记录会保留。

自动任务不授予额外权限。原生推理需要单独[启用 Agent](NATIVE_AGENT.zh-CN.md)；Worker 任务仍需
符合原有能力与审批要求。计划提交时间不代表执行或完成保证。旧版 Server 没有自动任务接口时显示不可用。
当前仍是单 Server 运行，不代表支持多个 Server 副本共同调度。
见[持久自动任务调研](research/server-automations.md)。

## 当前边界

当前公开预览版为 **0.1.0-alpha.7**，提供 macOS arm64 DMG 和 Windows x64 EXE。
两端均支持内置本地 Server/PostgreSQL，也可连接已有 Server。Linux x64 仍为远程客户端构建目标；
alpha.7 未发布 Linux 安装器。这些是未签名开发构建，正式代码签名和 macOS 公证仍未完成。
Windows 安装与保留数据的运行检查已在托管运行器执行；Windows 真机桌面和 SmartScreen 验收仍未完成。
macOS Intel 不在安装器矩阵内。版本产物和发行边界见
[安装说明](DESKTOP_INSTALLATION.zh-CN.md)与 [Windows 验证说明](WINDOWS_DESKTOP.zh-CN.md)。

[原生 Agent](NATIVE_AGENT.zh-CN.md) 在 Owner 启用后提供模型回复。输入框通过认证的频道附件接口
支持上述有界文本/代码、图片、PDF、Office/OpenDocument 和音视频附件。上传原件不会自动提取文字、OCR
或转写。任务提交不会自动重试。已有原生任务停止与明确重新提交继续由 Server 管理；
重新提交会创建新任务，不保证安全重放此前的副作用。

macOS 和 Windows 的内置 Server **仅供这台电脑使用**。让另一台电脑访问这个原生安装实例，仍需实现经过认证的
HTTPS 接入配置。不能把本机回环地址填到另一台电脑。当前远程使用应连接已有的 HTTPS 部署，
高级部署见下文。关闭 macOS 窗口会保留后台 Desktop；关闭 Windows 窗口会退出 Desktop。
退出应用会停止它自己的 Server 和数据库。
重新打开会使用原有数据。这不等同于登录启动服务、备份、数据库升级或无人值守恢复。

包含 macOS 数据库监督进程的构建会在 Desktop 主进程异常退出、私有通信管道关闭后，
停止监督进程自己启动的 PostgreSQL。重新打开时最多等待15秒让前一次关闭结束，再复用原数据。
它不会接管旧版遗留的无监督数据库，也不会根据 PID 文件停止进程；监督进程自身也被强制终止
的情况不在本项恢复范围内。本项改动不代表 Windows 异常退出恢复已经通过验证。


数据保存在 Desktop 用户数据目录的 `openbot/local-server`。Electron safeStorage 通过 macOS
钥匙串或 Windows DPAPI 加密引导秘密，
数据库使用随机私有凭据和 SCRAM；模型密钥由 Server 使用 AES-256-GCM 加密。模型摘要接口不返回密钥。
资源缺失、系统凭据存储不可用、数据路径不安全或数据库版本不兼容时会明确失败；重试不会删除已有数据库。
切换为远程客户端会停止本机服务并保留数据，切回后复用数据。

## 模型接口

本机安装后选择受支持的提供方预设、允许的 API 地址/区域、账户可用的模型 ID 和 API Key。当前界面选项包括
OpenAI、Anthropic、Gemini、DeepSeek、Kimi/Moonshot 等。验证/发现模型只查询元数据，不生成内容、不上传对话。
Server 保存唯一默认提供方/模型配置，由原生 Agent 任务共用；切换并保存会替换这一默认配置。
可在“**Owner → 设置 → 模型服务**”替换密钥；过期版本或并发保存会被拒绝，避免覆盖更新。可以暂时跳过。
预设不保证账户能使用所列的每个模型，也不接受任意自定义代理地址。

只保存密钥不会开启推理。Owner 勾选“启用原生 Agent”后，新建的 `none` 配置任务可通过
[原生 Agent](NATIVE_AGENT.zh-CN.md) 执行有界的模型/工具/观察循环，将任务与所需频道上下文发送给
所选模型，可能产生 API 费用。未实现的 Worker 能力仍不可用。旧版远程 Server 不支持此设置接口。

## 构建与高级自部署

在仓库根目录安装锁定依赖并运行 `npm run check`，然后在目标操作系统执行
`npm run package --workspace @openbot/desktop`。macOS 和 Windows 打包会将编译后的 Server、生产依赖、PostgreSQL
和许可通知放入 `native-runtime`，再组装应用。生成目录不会进入 Git。
本地开发启动前也需先运行 `npm run prepare:native --workspace @openbot/desktop`，再执行
`npm start --workspace @openbot/desktop`。首次启动不下载可执行代码。

需要独立测试应用时，运行 `npm run package:preview --workspace @openbot/desktop`，然后在 Apple
Silicon 打开 `apps/desktop/out/preview/OpenBot Preview-darwin-arm64/OpenBot Preview.app`
（Intel 构建将 `arm64` 替换为 `x64`）。Finder、Dock、辅助进程和应用菜单使用 Preview 名称，
图标仍为 OpenBot。该命令只打包，不启动应用、不覆盖 `/Applications`；`npm start` 是 Electron
开发启动器，与这个打包应用不同。Preview 的 bundle ID 为 `dev.openbot.desktop.preview`，
可执行文件为 `OpenBot Preview`，独立数据目录为 `~/Library/Application Support/OpenBot Preview`，
包含会话 Cookie 和本机 Server 数据，不迁移已安装应用的数据。重新打包保留 Preview 数据。
Preview 包含本地 Server，但禁止携带正式 macOS Worker 配套应用，因为后者的后台服务身份独立且共享。
普通打包命令保留原有应用身份。

高级用户可按[根目录源码部署说明](../README.zh-CN.md)分别部署 Server、PostgreSQL、Web 和 Worker。
这些选项放在 GitHub 文档中，不进入 Desktop 首次用途选择。远程使用需配置受信任的 HTTPS 反向代理；
数据库凭据和 Owner 认证留在服务端。

单独部署的 Server 如需模型设置，必须同时设置 `OPENBOT_MODEL_SETTINGS_PATH`（私有持久目录中的
绝对路径）和 `OPENBOT_MODEL_ENCRYPTION_KEY`（32 个随机字节对应的 64 位小写十六进制文本）。
加密主密钥应保存在独立秘密管理工具中；丢失后无法解密原有 API Key。两项均不设置则禁用此接口。
每个配置文件只允许一个 Server 写入。Owner 专用的 `GET`/`POST /api/v1/settings/model` 沿用来源检查；
POST 接收 `provider`、`model`、`apiKey` 和最新 `revision`（首次为 null）。
`agentEnabled` 默认 false，Owner 明确启用后才推理新建任务。

CI 打包 Linux x64、Windows x64 和 macOS arm64，各端验证成功后保留未签名包七天。
登录 GitHub 后，可从对应的成功 [CI 运行](https://github.com/yxflc11/openbot/actions/workflows/ci.yml)
下载带提交标识的 `.tar.gz`，使用 `tar -xzf <archive>` 解压以保留可执行权限和内部链接。
这些是临时开发产物，不是签名安装器、自动更新或桌面控制认证。
见[交付调研](research/desktop-cross-platform-handoff.md)。

macOS 使用固定原生包 `17.10.0-beta.17` 提供的 PostgreSQL 17.10。Windows 从固定的官方
PostgreSQL 17.11 源码构建，不再接受原 Windows npm 二进制包。见
[Windows 构建来源](research/windows-desktop-completion.md)。生产发行仍需审查原生依赖来源、
分发许可、签名和公证；本机功能测试不能替代发行支持证据。

视觉测试只在隔离环境使用测试数据，不向实际用户资料写入示例对话。


## 本机会话恢复

macOS 应用托管的 Server 自行生成并保护 Owner 身份。会话过期、请求返回 401 或重新回到应用时，
Desktop 会恢复本机会话。密码始终留在主进程，不显示或传给页面；刷新已启动的本地 Server 页面
也无需重启数据库。失败的操作不会自动重放。

主动退出后，本次窗口保持退出，显示“重新进入”按钮。这不等于系统锁屏：重新启动应用仍可自动
登录它自己的 Server。远程客户端与浏览器继续沿用密码和会话到期规则；恢复操作不能指向远程或
已停止的 Server。见[研究与验证](research/desktop-local-session-recovery.md)。

安装后的应用名称为 **OpenBot**。已有 macOS Preview 配置可直接沿用原加密身份，内部数据目录
名称保留；已配置的正式 OpenBot 目录优先。更新时只删除旧应用包与安装文件，不删除正在使用的数据目录。

更新后的应用首次读取旧配置的加密密钥时，macOS 可能要求输入登录钥匙串密码。这是系统授权，
与 OpenBot 的 Owner 登录不同。本地开发构建没有稳定的 Developer ID 签名，因此重新构建后可能
再次提示。原钥匙串项目会保留，以便继续读取已有加密数据。

### 高级搜索账号配置

Desktop 启动器可显式提供 `OPENBOT_DESKTOP_TAVILY_API_KEY`，为内置 Server 选择可选的
Tavily 搜索账号；其他项目或 Shell 中通用的 `TAVILY_API_KEY` 不会被自动使用。
Desktop 不会自动读取仓库 `.env`。此配置不改变已保存的模型连接，也不改变支持的 Kimi
内置搜索。独立部署的 Server 仍使用自己的 `TAVILY_API_KEY` 配置。
