# 开源优先工程规则

[English](OPEN_SOURCE_REUSE.md) · [简体中文](OPEN_SOURCE_REUSE.zh-CN.md)

## 规则

OpenBot 在设计任何非简单功能前，必须先调研成熟的开源实现。目标是优先复用持续维护的标准、
依赖、协议和窄服务，避免再造一套不兼容系统。

调研不等于直接复制看起来相似的仓库。每项功能都要记录：用户结果与安全边界；候选仓库或开放
标准；维护状态、平台/API 适配和测试质量；候选及其传递依赖许可证；最终选择依赖、适配、向上游
贡献、保留署名移植，还是只开发有证据的差集；以及固定版本/commit 和升级替换方案。

如果兼容代码已经解决问题，应通过其公开契约使用。只有 OpenBot 特有的策略、编排、持久化或
调研明确证明的集成缺口才适合本地实现。

许可证未知、source-available、限制商业使用或其他不兼容许可证会阻止代码引入。复制或实质改编
MIT/Apache 代码时，必须在 `THIRD_PARTY_NOTICES.md` 或对应 vendor 目录保留版权和许可证要求。
即使只采用理念、公开 API 或互操作方式，也要引用来源，方便贡献者理解设计脉络。

## 决策顺序

按顺序选择第一个能满足验收和安全要求的方案：采用开放标准；使用发布依赖或独立服务；编写
固定版本的薄适配器；向上游贡献通用缺口；维护窄 fork；最后才实现剩余的 OpenBot 特有差集。

任何上游都不能成为 Employee 身份、授权、审计或路由的第二真相源。外部代码必须位于 Server
策略边界和类型化 Provider 契约之后执行。

## 当前代码审查

审查日期：2026-09-04。以下 commit 只是调研基线，不会自动成为依赖。

本表同时是当前分支已有非简单代码的追溯审查账本。没有在这里、ADR 或对应 Issue 中登记上游与
许可证审查的功能，在补齐记录前不能继续扩展。

| OpenBot 范围 | 调研来源 | 许可证 | 决定与现状 |
| --- | --- | --- | --- |
| Windows 交付稳定性与完整 CI 门禁 | Electron get 5.1.0 / `da84467e`；Packager 20.3.0 / `8c5cc941`；builder 26.16.1 / `7d3b30f3`；.NET Process；GitHub Actions 依赖结果 | MIT；BSD-2-Clause；微软/GitHub 文档条款 | 只重试短暂下载故障，保留校验；安装夹具按进度检查停滞和总时限；受保护的完成检查要求全部任务通过。未复制源码，见[下载](research/windows-ci-download-reliability.zh-CN.md)、[安装](research/windows-installer-progress.zh-CN.md)、[合并门禁](research/windows-ci-merge-gate.zh-CN.md)。 |
| 文档研究豁免 | Git 2.55.0 / `e9019fca`；checkout 7.0.1 / `3d3c42e5` | GPL-2.0；MIT | 复用已提交的 Git 差异和 blob 标识，验证普通 Markdown 正文的简短豁免。源码、政策和受保护技术内容仍使用研究表；主张是否不变仍由审查判断。未增加依赖或复制源码；见[研究](research/2026-09-15-research-exemptions.zh-CN.md)。 |
| 贡献者首次启动与全新检出验证 | Turborepo 2.10.12 / `53752d45`；既有 Node API 和 Postgres.js 3.4.9 | MIT；Node.js 许可；Unlicense | 复用任务依赖图和筛选后的持久任务，启动 Server/Web/可选 Node。在构建前使用空回环数据库验证真实根目录入口，限定 POSIX 进程组并清理。未增加依赖或复制源码；见[研究](research/2026-09-15-contributor-startup.zh-CN.md)。 |
| 流式 JSON 请求大小限制 | WHATWG Streams `b9ba9f49`；已审查 Hono 4.13.7 / `eebdf7be` | WHATWG 条款；Node.js 许可；MIT | 复用原生读取器和流式 UTF-8 解码，按实际字节计数、超限取消，保留各入口上限与错误格式。已审查的 Hono 中间件信任声明长度，直接使用不能满足清理要求。未复制源码或增加依赖；见[研究](research/2026-09-15-request-body-limits.zh-CN.md)。 |
| 统一任务、附件与定时流程 | PostgreSQL 17；ai 7.0.93 / 6359fd58；现有 Zod 4.5.4 | PostgreSQL；Apache-2.0；MIT | 复用既有事务和文件锁、共享协议定义和单份工具表；暂停任务保留附件引用，追加结果约束迁移，失效时停用。未复制源码或增加依赖；见[研究](research/task-flow-refactor.zh-CN.md)。 |
| 工作区状态顺序与旧资源清理 | React 19.2.8；既有浏览器 AbortController / fetch | MIT；WHATWG 条款 | 单个活动快照请求配合有序实体投影，操作响应立即显示；删除无引用像素资源和选择器，保留组合外观兼容。未增加状态框架或复制源码；见[研究](research/workspace-state-refactor.zh-CN.md)。 |
| MCP 生命周期与共享插件契约 | MCP SDK 1.30.0；JSON Schema；Zod 4.5.4 | MIT；规范条款 | 按位置检查 schema、同端点限时终止会话并共享数据契约，权限与并发仍由 Server 控制；Provider 声明复用线协议。未复制源码；见[研究](research/plugin-flow-refactor.zh-CN.md)。 |
| 迁移编写、首次登记与保留声明 | Drizzle Kit 0.31.10；Node 26；PDF.js 6.3.289 | MIT；Apache-2.0 及包内各项声明 | 停用不适合手写历史的自动生成，提供只读模板计划、首次登记步骤与完整备份/声明清单；不新增自动备份或复制源码。见[研究](research/developer-workflow-refactor.zh-CN.md)。 |
| 官方网站与双语手册 | [Astro 7.2.10 / `2fdf7314`](https://github.com/withastro/astro/tree/2fdf731428aa738d5dcf3041b4e78eb9d036968c)、[Starlight 0.42.0 / `88ad3c26`](https://github.com/withastro/starlight/tree/88ad3c2630487ba227a7b4ccbffc01a2bdf623a5)、Vite 8.2.2；比较 VitePress 1.6.4 | MIT | 复用已发布的静态构建、Markdown 手册、语言导航、Pagefind 搜索与 sitemap。公开演示复用真实 OpenBot React 部件并标识合成数据，不持有 Owner 会话或执行权限。官网已迁到独立的 [openbot-website 仓库](https://github.com/yxflc11/openbot-website)，固定演示引用的产品提交；官网依赖不再进入 Server 打包。未复制框架源码，见[研究](research/official-site.md)。本地构建与 GitHub Pages 发布分别验收。 |
| 频道 Bot 协作与扩展附件 | ai 7.0.93 / 6359fd58；Hono 4.13.7；write-file-atomic 8.0.0；已评估 A2A v0.3.0 | Apache-2.0；MIT | 复用 SDK 子 Agent 工具、多模态消息、HTTP 与不可变存储。Server 建立同频道、有界、独立 Bot 身份的任务树；附件支持每任务 8 件/20 MiB、分页文本及 PNG/JPEG/PDF。未复制源码；见[协作研究](research/channel-bot-collaboration.md)、[附件研究](research/channel-attachments.zh-CN.md)和[升级说明](CORE_UPGRADE.zh-CN.md)。 |
| 获批的 Desktop 界面优化 | React 19.2.8 / 1dd4ecb；Electron 44.2.0 / tag 对象 369b0d9d3afdd5b8c0bdb0ad42391443947a7424；WAI APG；既有 OpenBot e8fa933 | MIT；W3C 文档条款 | 复用 HTML 控件与既有 renderer，实现统一创建入口、全窗口竖向设置/插件、结构化成员提及和可移除文本附件/已验证技能请求标签。原先 3 个附件、每个 6,000 字节的设计已被共享的 8 个/20 MiB 附件契约替代；完整任务不超过 8,000 字符；最多 2 个技能请求不授予权限。分享明确预览并复制近期消息，不托管发布。未复制源码或新增依赖，见[调研](research/desktop-ui-refresh.zh-CN.md)。 |
| Server 管理的 Bot 单独对话 | PostgreSQL 17 / ec3f6a6a7dd82a8ce455a0710ef75172f9f318d1；Drizzle 0.45.2 / e7dfa14519f363229ccc3ead7b1b2f2051937efb；Postgres.js 3.4.9 | PostgreSQL License；Apache-2.0；Unlicense | 复用数据库行锁、外键和唯一约束，为每个 Bot 创建唯一固定成员频道。仅 Owner 可幂等打开，精确标识路由与消息/Run 审计仍归 Server 管理。临时 PostgreSQL 实例已验证并发创建；未复制源码或增加依赖，见[调研](research/desktop-direct-conversations.zh-CN.md)。 |
| Desktop 安装分发与模型配置初始化 | electron-builder 26.16.0 / f4610970f78b6ce223b1f4cee2b5e8f5caa14a48；现有 Packager 20.3.0、Fuses 2.1.3；Node 24.20.0 文件/加密与 Compose 卷 | MIT；BSD-2-Clause；Node.js 许可；规范条款 | 只在已验证应用包外复用 builder，生成 DMG/NSIS/AppImage/DEB；完整核对源提交与产物后创建草稿 Release。Server 私有模型目录保留密钥，损坏时关闭失败。未复制上游源码，见[调研](research/desktop-installable-delivery.md)和[安装](DESKTOP_INSTALLATION.zh-CN.md)。 |
| Server 原生 Agent 循环 | ai 7.0.93、@ai-sdk/openai 4.0.60、@ai-sdk/anthropic 4.0.49；比较 OpenAI Agents JS v0.17.0 和已固定的 Hermes 运行时 | Apache-2.0；MIT | 复用已发布 ToolLoopAgent、严格的频道只读工具、有界迭代和官方模型 HTTP。Owner 启用、数据库领取/回复/审计与配置撤销仍由 OpenBot 管理。未复制源码，见[调研](research/native-agent-loop.md)与[运行说明](NATIVE_AGENT.zh-CN.md)。 |
| 原生 Agent 公开网页与报告 | ipaddr.js 2.5.0 / dc552827；html-to-text 10.0.1 / 1c39d988；Node HTTPS 与现有 AI SDK/产物存储 | MIT；Node.js license；Apache-2.0 | 复用地址分类和有界文本提取，适配任务网址、公网 IP 固定连接与 Markdown 报告事务发布。未复制上游源码，见[调研](research/agent-research-artifacts.md)。 |
| 原生任务取消、档案与用量 | Node AbortController；PostgreSQL 17 行锁；ai 7.0.93 / 6359fd58；React 19.2.8 | Node.js；PostgreSQL；Apache-2.0；MIT | 扩展 Server 管理的 Run 生命周期：先持久取消再中止请求、有界 Bot 上下文、模型报告用量和明确重新提交。未复制源码，见[调研](research/agent-execution-experience.md)。 |
| Desktop 统一顶栏与页面历史 | React 19.2.8；2026-09-05 审查的 Apple 工具栏与 WAI-ARIA 指引；比较 React Router 8.3.0 / 2edaca7 和 react-resizable-panels 4.9.0 | MIT；Apple/WHATWG/W3C 条款 | 复用原生控件与 React 状态，实现固定顶栏、左右栏独立开关和有界的授权页面访问历史。显示设置时保留认证工作空间；更换 Owner/Server 或退出登录时结束其生命周期。不引入 URL 路由器、拖动缩放依赖或 Codex 源码/素材。见[调研](research/desktop-navigation-continuity.md)。 |
| Desktop 频道草稿与发送连续性 | 现有 React 19.2.8、原生 HTML textarea 和 CSSOM View；比较 react-textarea-autosize 8.5.9 | MIT；WHATWG/W3C 条款 | 复用外部存储快照与原生几何测量，建立有界工作空间内存缓存、按频道区分的草稿版本和发送归属，并恢复阅读位置。文字不进入 localStorage；发送完成保留更新后的输入，结果不明确时不自动重试。未新增依赖或复制源码，见[调研](research/desktop-conversation-continuity.md)。 |
| 优先显示频道动态的 Desktop 信息栏 | 原生 HTML details/summary、React 19.2.8 / 1dd4ecb，以及 OpenBot 14e41ae78a35cd6a6b52de25a4e60300c2fe993d 的认证快照 | WHATWG 条款；MIT | 先投影当前频道的待审批操作、进行中任务与最近结果，再提供折叠的工作空间总览。检查频道/Run 关联，保留已超出近期 Run 样本的待审批记录。不新增计量或执行权威；缺少 Token 用量时仍显示不可用。未复制源码，见[调研](research/desktop-contextual-inspector.md)。 |
| Desktop 原生导航菜单 | Electron 44.2.0 / aa650d7 公开 Menu/role API；2026-09-05 审查的 Apple 菜单组织规范 | MIT；Apple API 条款 | 复用中文原生菜单和标准编辑/窗口角色。六个固定界面命令及可信主框架提交的严格四布尔快照同步菜单可用性；选择命令时再次检查生命周期、焦点和本地来源。不提供通用 IPC、全局快捷键、重新加载或开发者工具菜单。未复制源码，见[调研](research/desktop-native-navigation-menu.md)。 |
| Desktop 频道工作空间和用量面板 | 现有 React 19.2.8、W3C APG 搜索 / WCAG 2.2 ARIA23；Telegram Desktop v6.9.3 仅作视觉参考 | MIT；W3C 文档条款；GPL-3.0 参考项目未引入 | 原生 HTML 搜索和聊天记录形成三个工作空间区域。获批改版通过已有界面偏好加入统一顶栏与左右栏独立开关，信息栏优先显示当前频道动态。未复制 Telegram 代码或素材，不虚构 Token 用量。见[布局调研](research/desktop-channel-layout.md)、[用量调研](research/desktop-usage-panel.md)和上方导航/对话/信息栏条目。 |
| Desktop 一体化引导 | Electron 44.2.0；PostgreSQL 17.10，@embedded-postgres/darwin-{arm64,x64} 17.10.0-beta.17（c23ad8a0）；Postgres.js 3.4.9；OpenAI/Anthropic 模型元数据 HTTP API | MIT；PostgreSQL 与所带库许可；Unlicense；API 条款 | 复用原生窗口、PostgreSQL 二进制、utilityProcess、safeStorage、现有 Server 和生产依赖收集。首次界面收敛为服务电脑/远程客户端，旧计划仍可读取。新增有界安装生命周期和 Owner 专用的加密模型默认配置；未复制上游实现。见[调研](research/desktop-integrated-onboarding.md)和[能力边界](DESKTOP_ONBOARDING.zh-CN.md)。 |
| Desktop 跨平台交付 | 现有 Electron 44.2.0 平台元数据和 actions/upload-artifact 7.0.1 / 043fb46d1a93c77aae656e7c1c64a875d1fc6a0a | MIT | 根据现有平台桥接显示本地服务入口；验证后的包以提交命名的 tar 归档保留七天。不增加运行时依赖或权限，不复制上游代码。见[调研](research/desktop-cross-platform-handoff.md)。 |
| Desktop 界面偏好与分类设置 | 2026-09-05 审查的 HTML Web Storage 与 WAI-ARIA disclosure 标准；现有 React 19.2.8；比较 electron-store 11.0.2 / e1470fd | WHATWG/W3C 文档条款；MIT | 复用按 origin/本机资料隔离的存储与 React useSyncExternalStore，保存白名单内的非秘密偏好、信息栏开关及专用设置分类（alpha.3 优化为六个竖向分类）。原生按钮和表单保留无障碍语义；存储失败时保留本次内存值并说明未能保存。未复制源码，见[调研](research/desktop-workspace-preferences.md)。 |
| macOS Desktop 原生侧栏材质 | Electron 44.2.0 原生窗口/主题 API 与 Apple AppKit 标准侧栏材质 | MIT；Apple 平台/API 条款 | 复用 setVibrancy 的语义侧栏材质，保留原生窗口控制，仅允许可信主框架通过 IPC 传递布尔值。系统减少透明度和高对比度覆盖本机选择；其他平台或失败时保持不透明。不引入透明无边框窗口、私有 API 或上游源码，见[调研](research/desktop-sidebar-material.md)。 |
| 工作空间技能广场 | Agent Skills 规范 69ef37e9424c0a7ea9dd2293b559e43ec8176379；React 19.2.8；现有 OpenBot Employee 审核界面 fc0ad85 | 源码 Apache-2.0 / 文档 CC-BY-4.0；MIT | 复用经认证的真实 Employee 技能记录、有界并发读取与已有 Owner 审核界面。搜索和状态筛选只是工作空间投影，不是公开市场、下载通道或可执行技能激活。未复制源码，见[调研](research/workspace-destinations.md)。 |
| Server 持有的周期任务提交 | PostgreSQL 17 / ec3f6a6a7dd82a8ce455a0710ef75172f9f318d1；Drizzle 0.45.2；Postgres.js 3.4.9；比较 pg-boss 12.26.0 / 31a4cf0093b0df73d077782689b738bcd0292021 与 node-cron 4.6.0 / 0be2ca03ffebc79fa823081b8a44bff6f731a583 | PostgreSQL；Apache-2.0；Unlicense；MIT；ISC | 优先选择 PostgreSQL 行锁与事务，不另加队列依赖：到期领取、普通 Message/Run、审计和下次时间一起提交。增加有界 Owner 管理与固定时长轮询，不连续补跑积压次数，跳过尚未结束的 Run，并限制最多 50 条计划。沿用现有路由/审批，不宣称模型推理循环或多 Server 调度。未新增依赖或上游源码，见[调研](research/server-automations.md)。 |
| 独立 Desktop Preview 身份 | Electron 44.2.0；Electron Packager 20.3.0 / 8c5cc941018b1d890c7152734972c44b9b98f268 | MIT；BSD-2-Clause | 复用原生应用与辅助进程元数据、暂存包 productName，生成独立 Preview 应用与数据目录。保留正式应用身份，Preview 拒绝携带共享 Worker 配套应用。未复制源码，见[调研](research/desktop-preview-identity.md)。 |
| Desktop 应用与语言基础 | [Electron `v44.2.0`](https://github.com/electron/electron/releases/tag/v44.2.0)、[Electron Packager `v20.3.0`](https://github.com/electron/packager/releases/tag/v20.3.0)、[Electron Fuses `v2.1.3`](https://github.com/electron/fuses/releases/tag/v2.1.3)、仅构建时使用的 [`@electron/asar` `4.3.0`](https://github.com/electron/asar/tree/v4.3.0)、未采用的 [Electron Forge `v7.11.2`](https://github.com/electron/forge/releases/tag/v7.11.2)、[Node.js `v24.20.0` LTS](https://nodejs.org/en/blog/release/v24.20.0)、未采用的 [Tauri `v2.11.5`](https://github.com/tauri-apps/tauri/releases/tag/v2.11.5)、未采用的 [Wails `v2.14.0`](https://github.com/wailsapp/wails/releases/tag/v2.14.0)与延期的 [Playwright `v1.62.1`](https://github.com/microsoft/playwright/releases/tag/v1.62.1) | MIT；BSD-2-Clause；MIT；MIT；MIT；Node.js 许可证；Apache-2.0/MIT；MIT；Apache-2.0 | Electron 是第一个能保留现有 TypeScript/React/Vite 贡献和界面路径的正式发布 Desktop 外壳，并直接使用稳定版 Packager/Fuses 适配器与仅构建时执行的 ASAR 清单验证。实现验证发现 Forge 7 与 Fuses 2 不兼容，其兼容的 Fuses 1 peer 无法完整识别 Electron 44 fuse，且开发依赖仍有未解决的 high/critical 漏洞，因此不采用；Forge 8 仍是预发布版。Node 24 LTS 是新的开发基线，但已生成来源证明的 Worker 版本继续使用 Node 22.22.2，直到单独迁移。Tauri 与 Wails 会增加核心语言和系统 WebView 差异；Playwright 的 Electron 支持仍是实验性。没有复制源码，见[调研证据](research/desktop-application-foundation.md)与 [ADR-0041](decisions/0041-desktop-application-foundation.md)。 Owner 支持链接复用同一主进程 shell API，仅允许两个精确公开地址并检查当前窗口身份；见[固定支持链接审查](research/desktop-support-links.zh-CN.md)。 |
| Desktop 本地内容协议 | [Electron 44.2.0 安全清单](https://www.electronjs.org/docs/latest/tutorial/security)、[`protocol.handle`](https://www.electronjs.org/docs/latest/api/protocol)与 [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses) | MIT | 通过 OpenBot 路径白名单使用正式发布的自定义协议 API，而不是恢复高权限 `file://`。处理器注册在 Desktop 窗口使用的专用 Session 上，只提供不可变 renderer 资源，并拒绝未知来源、方法、编码分隔符和路径穿越。没有复制上游源码，见[调研证据](research/desktop-local-content-protocol.md)。 |
| Desktop Server 连接 | Electron `44.2.0` 的 [`protocol.handle`](https://www.electronjs.org/docs/latest/api/protocol)、[`Session.fetch`](https://www.electronjs.org/docs/latest/api/session)、Cookie 与类型化 IPC；WHATWG Fetch/URL；现有 [`write-file-atomic` `8.0.0`](https://github.com/npm/write-file-atomic/tree/v8.0.0)；未采用的 [`electron-store` `11.0.2` / `e1470fd`](https://github.com/sindresorhus/electron-store/tree/v11.0.2) | MIT；WHATWG 条款；ISC；MIT | 让安装包 renderer 保持同源，只通过专用 Session 把白名单 REST/SSE 请求代理到唯一经过健康验证和原生确认的 Server origin。只用现有原子适配器保存严格的公开 origin；凭证仅存在于请求内存和 HttpOnly Session Cookie。拒绝远程 UI、不透明 origin、重定向、过大请求体、renderer 直连、本地监听器和通用 IPC 请求桥。未复制上游源码，见[调研证据](research/desktop-server-connection.md)与 [ADR-0042](decisions/0042-desktop-server-connection.md)。 |
| Desktop 安装意图 | 现有 React `19.2.8`、WAI-ARIA APG `7e4034b2`、Electron `44.2.0` 类型化 context bridge 与 [`write-file-atomic` `8.0.0`](https://github.com/npm/write-file-atomic/tree/v8.0.0)；未采用 XState `5.31.1` 和 React Hook Form `7.77.0` / `5b20741` | MIT；W3C 软件与文档许可证；MIT；ISC；MIT；MIT | 用原生表单语义、一个可辨识 React 状态、main process 严格持久化和派生清单表达四种产品组合及有上限的计划 Worker 数量。计划只是公开意图：绝不证明已经安装、连接、登记、授权或支持平台，也不触发服务副作用。额外状态机与表单依赖不能填补这个有界切片的缺口。未复制上游源码，见[调研证据](research/desktop-setup-plan.md)与 [ADR-0043](decisions/0043-desktop-setup-intent.md)。 |
| Desktop 引导的 macOS Worker 配置 | 现有 OpenBot Swift Worker Host `8252ea4`；Apple macOS 13+ `SMAppService`、Security 与应用内 helper 契约；Electron `44.2.0`；Electron Packager `20.3.0`；Node.js `22.22.2`；未采用 Electron utility process 与 XState `5.31.1` | OpenBot MIT；Apple 平台/API 条款；MIT；MIT；Node.js 许可证；MIT | 把已经审查的 Worker Host 作为一个独立签名的 Desktop 内嵌 companion，并且只增加有界 stdin/stdout 控制信封、经过鉴权的 main-process 登记适配器、真实状态投影与安装包清单门槛。renderer 不提供 token 或可执行文件路径，只接收白名单状态。utility process 无法提供已接受的登录/重启、Keychain、entitlement 或独立服务生命周期；状态机依赖也不能填补这条有序且不恢复中间步骤的事务缺口。未复制上游源码，见[调研证据](research/desktop-macos-worker-onboarding.md)与 [ADR-0044](decisions/0044-desktop-macos-worker-onboarding.md)。 |
| 员工进化与学习图谱 | [NousResearch/hermes-agent `63279301`](https://github.com/NousResearch/hermes-agent/tree/63279301bcbdc185c1b07b98a9312eb0c862f26d)，重点参考 `agent/learning_graph.py` 的技能/记忆模型 | MIT | 采用“技能与记忆分离、学习技能保留来源和使用证据、个人页展示关系”的产品思想。OpenBot 的 TypeScript/PostgreSQL 实现为本地代码，没有复制 Hermes 源码。 |
| 员工进化档案 | [Hermes Agent `63279301`](https://github.com/NousResearch/hermes-agent/tree/63279301bcbdc185c1b07b98a9312eb0c862f26d)，重点参考 Desktop Star Map 的 `time-axis.ts` 与 `timeline.tsx` | MIT | 把真实日期旅程、稳定顺序和来源优先的交互适配到 OpenBot 已有的 Server 仅追加事件。使用原生 HTML 筛选/滑杆/列表，不采用 Hermes 文件系统权威、D3/Canvas 运行时或变化模型。未复制源码，见[调研证据](research/employee-evolution-archive.md)。 |
| Owner 管理员工主页详情 | [Hermes Agent `63279301`](https://github.com/NousResearch/hermes-agent/tree/63279301bcbdc185c1b07b98a9312eb0c862f26d)，重点参考 `EditProfileDialog.tsx`、`profile-config.tsx`、profile 操作和 UI metadata CAS 测试；[Kubernetes `v1.36.2`](https://github.com/kubernetes/kubernetes/tree/v1.36.2) `resourceVersion` 更新语义 | MIT；Apache-2.0 | 采用显式暂存编辑、路由简介与旧写入者拒绝。复用 OpenBot 已有 Zod/Hono/PostgreSQL revision 变化路径，只增加职责/简介、无正文进化/SSE 元数据和简介随安全模板迁移。未复制上游源码，见[调研证据](research/owner-employee-profile-details.md)。 |
| Owner 管理员工记忆 | [Hermes Agent `63279301`](https://github.com/NousResearch/hermes-agent/tree/63279301bcbdc185c1b07b98a9312eb0c862f26d)、[Letta `0.16.7` / `f3332476`](https://github.com/letta-ai/letta/tree/f33324768950e6752f80d6c725873cc92d22f8b2)、[Mem0 `ts-v3.0.5` / `75a37ec9`](https://github.com/mem0ai/mem0/tree/75a37ec93db7278e3bd9aaf2aa3d6e5139e6789d) 与 [LangMem `f8c7ebd6`](https://github.com/langchain-ai/langmem/tree/f8c7ebd6110c124a36995dab645a8cb0eb0b8210) | MIT；Apache-2.0；Apache-2.0；MIT | 采用可见有界变化、人工编辑、稳定 ID/历史、分类记忆和默认关闭自动删除。复用 OpenBot 现有 PostgreSQL/Zod/Hono/React，只补 revision 检查的 Owner 命令与无内容审计；不引入上游运行时或源码。见[调研证据](research/owner-managed-employee-memory.md)。 |
| 技能写入审核 | [Hermes write-approval gate](https://github.com/NousResearch/hermes-agent/blob/63279301bcbdc185c1b07b98a9312eb0c862f26d/tools/write_approval.py)、[OpenClaw `v2026.7.1-2`](https://github.com/openclaw/openclaw/tree/v2026.7.1-2) 与 [Agent Skills `69ef37e9`](https://github.com/agentskills/agentskills/tree/69ef37e9424c0a7ea9dd2293b559e43ec8176379) | MIT；MIT；Apache-2.0 代码和 CC-BY-4.0 文档 | 将待审核行为适配到 Server 权威记录，并在 Owner 验证、暂停、恢复或终止撤销前展示元数据、依赖、所需能力和证据。不安装可执行包；完整文件 diff、扫描和提案队列仍在计划中。未复制上游源码，证据见[调研记录](research/owner-skill-review-surface.md)。 |
| 可迁移技能格式 | [Agent Skills 规范 `69ef37e9`](https://github.com/agentskills/agentskills/tree/69ef37e9424c0a7ea9dd2293b559e43ec8176379) 与 `skills-ref` | 代码 Apache-2.0；文档 CC-BY-4.0 | 采用开放标准，不自创技能包。当前元数据已采用其名称和简介限制；尚未实现可执行 `SKILL.md` 归档和官方校验器接入。 |
| 第三方技能安全 | [OpenClaw `428fa8e0`](https://github.com/openclaw/openclaw/tree/428fa8e0d3dac835628f6ac6466bb65ce175b249) 的技能隔离与扫描说明 | MIT | 采用第三方内容默认不可信、激活前检查、路径约束和明确授权。员工包技能只会作为禁用候选导入。 |
| 审核后激活员工 | [Backstage `v1.51.0`](https://github.com/backstage/backstage/tree/v1.51.0)、[Kubernetes `v1.36.2` API dry-run](https://github.com/kubernetes/website/blob/main/content/en/docs/reference/using-api/api-concepts.md) 与 [OpenClaw `v2026.7.1-2`](https://github.com/openclaw/openclaw/tree/v2026.7.1-2) | Apache-2.0；Apache-2.0；MIT | 采用“预览 → 审核 → 创建”、无副作用预览和第三方技能默认不可信。OpenBot 只实现自己的包摘要绑定、新身份、PostgreSQL 原子收据和候选技能赋值；没有复制上游源码。见[调研证据](research/reviewed-employee-import-activation.md)。 |
| 可迁移员工资料审核 | [Hermes Agent `63279301`](https://github.com/NousResearch/hermes-agent/tree/63279301bcbdc185c1b07b98a9312eb0c862f26d) 的 profile distribution 与 [Backstage `v1.51.0`](https://github.com/backstage/backstage/tree/v1.51.0) 的目录简介 | MIT；Apache-2.0 | 采用 Hermes 的安装前 manifest 审核和用户数据隔离，以及 Backstage 对说明性元数据的区分。复用 OpenBot 已有的摘要绑定隔离区，只补充在激活前展示已经过校验的可选简介。没有复制上游源码，见[调研证据](research/portable-employee-profile-review.md)。 |
| 可迁移员工技能披露 | [Agent Skills `69ef37e9`](https://github.com/agentskills/agentskills/tree/69ef37e9424c0a7ea9dd2293b559e43ec8176379)、[OpenClaw `v2026.7.1-2`](https://github.com/openclaw/openclaw/tree/v2026.7.1-2) 与 [Hermes Agent `63279301`](https://github.com/NousResearch/hermes-agent/tree/63279301bcbdc185c1b07b98a9312eb0c862f26d) | Apache-2.0 代码 / CC-BY-4.0 文档；MIT；MIT | 采用标准的必填技能说明与启用前阅读边界。复用 OpenBot 已校验的包元数据，在激活前展示说明、版本、能力、依赖和禁用状态；不引入可执行包或上游源码。见[调研证据](research/portable-employee-skill-disclosure.md)。 |
| 员工导出内容预览 | [Hermes Agent `63279301`](https://github.com/NousResearch/hermes-agent/tree/63279301bcbdc185c1b07b98a9312eb0c862f26d) 的 profile distribution、[OpenClaw `v2026.7.1-2`](https://github.com/openclaw/openclaw/blob/v2026.7.1-2/scripts/openclaw-npm-release-check.ts) 与 [npm CLI `v11.6.0`](https://github.com/npm/cli/blob/v11.6.0/lib/commands/pack.js) | MIT；MIT；Artistic-2.0 | 采用发送前内容检查，以及 OpenClaw/npm 从同一打包路径生成清单的做法。复用 OpenBot 规范包构建器，只在下载前投影有界的资料和技能元数据；未复制上游源码，见[调研证据](research/employee-export-content-preview.md)。 |
| 可迁移员工技能依赖闭包 | [Agent Skills `69ef37e9`](https://github.com/agentskills/agentskills/tree/69ef37e9424c0a7ea9dd2293b559e43ec8176379)、[Helm `v4.1.3`](https://github.com/helm/helm/blob/v4.1.3/internal/chart/v3/lint/rules/dependencies.go) 与 [OpenClaw `v2026.7.1-2`](https://github.com/openclaw/openclaw/tree/v2026.7.1-2) | Apache-2.0 代码 / CC-BY-4.0 文档；Apache-2.0；MIT | Agent Skills 尚无正式技能间依赖字段，因此 `dependencySlugs` 是明确的 OpenBot v1 扩展。采用 Helm 的包闭包 fail-closed 规则和 OpenClaw 不静默误报就绪的原则：已验证技能若依赖于导出集合之外就阻止下载。未复制上游源码，见[调研证据](research/portable-employee-skill-dependency-closure.md)。 |
| 员工导出审核绑定 | [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html)、[RFC 6585](https://www.rfc-editor.org/rfc/rfc6585.html)、[Kubernetes `v1.36.2`](https://github.com/kubernetes/kubernetes/tree/v1.36.2)、[W3C Web Crypto Level 2](https://www.w3.org/TR/WebCryptoAPI/)、npm [`ssri` v14.0.0](https://github.com/npm/ssri/tree/v14.0.0) 与 [Hono `4.13.7` / `eebdf7be`](https://github.com/honojs/hono/blob/eebdf7be39abf0a872671835ccce0c4f03ea497a/src/middleware/etag/index.ts) | IETF Trust；Apache-2.0；W3C Software and Document License；ISC；MIT | 采用强 `ETag`/`If-Match`、`428`、不透明过期版本交互，以及浏览器原生 SHA-256 对实际响应字节复核。复用规范构建器；不新增 Hono 缓存中间件或面向 Node 的 `ssri`。未复制上游源码，见[调研证据](research/employee-export-review-binding.md)。 |
| 浏览器电脑 | [CopilotKit/OpenBot `agent-computer` `257c1280`](https://github.com/CopilotKit/openbot/tree/257c1280d684089be9adb0b35cce262efc7064bf/agent-computer) | MIT | 通过薄 Provider 使用其 Token HTTP 接口，上游进程独立运行，不复制控制面。 |
| 跨平台电脑操作 | [Cua `986b6f25`](https://github.com/trycua/cua/tree/986b6f257b1afddef0cbd4815bb2744eab7eadba) | MIT；可选组件另有许可证 | 计划用于 Windows、macOS、Linux Provider；未经独立分发审查不启用可选 AGPL 或模型组件。 |
| Provider 一致性场景 | [MCP Conformance `74edef34`](https://github.com/modelcontextprotocol/conformance/tree/74edef34d674f563537be8c6587cebaa58e830ca) | 许可证迁移中：新代码 Apache-2.0，剩余历史代码 MIT，文档 CC-BY-4.0 | 采用具名可执行场景、按版本冻结要求、显式预期失败和连接两端分别检查的方式。OpenBot 使用本地 Vitest 编写自身协议 fixture，没有复制 MCP 代码或文档。 |
| 平台合规声明 | [OCI runtime-spec `6999a89a`](https://github.com/opencontainers/runtime-spec/tree/6999a89a76a0329f440d5740497bedb9dd431297) | Apache-2.0 | 采用“合规必须绑定明确 OS/架构，任一必需行为失败就不能宣称支持”的原则。本切片不实现或复制 OCI runtime 契约。 |
| 一致性证据打包 | [CNCF Kubernetes Conformance `6fc6e660`](https://github.com/cncf/k8s-conformance/tree/6fc6e66092075b7443c9259629b607c15b7876b9) 与 [OCI runtime-tools `8a4db579`](https://github.com/opencontainers/runtime-tools/tree/8a4db579f5c88af5a0d036fad34bddc9c1f703f3) | Apache-2.0 | 采用明确产品/目标元数据、人工可复现说明、机器可读结果和按平台校验。OpenBot 用有界 JSON 作为 Provider 公共契约，不直接采用 JUnit 或 TAP；没有复制上游源码。 |
| Provider 一致性 runner | [MCP Conformance `74edef34`](https://github.com/modelcontextprotocol/conformance/tree/74edef34d674f563537be8c6587cebaa58e830ca)、[OCI runtime-tools `8a4db579`](https://github.com/opencontainers/runtime-tools/tree/8a4db579f5c88af5a0d036fad34bddc9c1f703f3)、[Sonobuoy `v0.57.2`](https://github.com/vmware-tanzu/sonobuoy/tree/v0.57.2) 与 [Vitest `5.0.0` / `f441c6fa`](https://github.com/vitest-dev/vitest/tree/f441c6fab25e579c5b7dd3dd50538416f415fbae) | Apache-2.0/MIT 迁移中；Apache-2.0；Apache-2.0；MIT | 采用稳定场景 ID、生命周期/超时、显式预期失败债务、绑定目标的执行和独立证据收集。它们都不能执行 OpenBot 的 `ComputerProvider` 契约，因此只在现有 SDK 和 Node runtime 上补有界编排器。它在 Server 外运行、丢弃原始异常，且不能自授支持标签。根测试运行器固定为 Vitest 5.0.0；没有复制上游源码；见[调研证据](research/provider-conformance-runner.md)与 [Vitest 5 迁移](research/vitest-5-migration.md)。 |
| Agent/UI 事件协议候选 | [AG-UI `faee4b13`](https://github.com/ag-ui-protocol/ag-ui/tree/faee4b13eabee191d9974f6b19a91b5668268995) | MIT | 已评估未来 Agent 与用户界面的事件互操作，当前延期：这次加固的是安全敏感的 Server/工作主机协议，不迁移 UI 传输。没有增加依赖或源码。 |
| 员工主页导航与模态弹窗 | [WAI-ARIA APG `7e4034b2`](https://github.com/w3c/aria-practices/tree/7e4034b262bc0d25332e330d8a582aaf34113829)、[React Spectrum `50279a10`](https://github.com/adobe/react-spectrum/tree/50279a10ab998572e240e44aa36f84a15c7c4f99) 与 [WCAG 技术 H102](https://www.w3.org/WAI/WCAG22/Techniques/html/H102) | W3C Software and Document License；Apache-2.0 | 采用标准 Tab 角色/键盘模型和浏览器原生模态生命周期。固定控件不值得引入第二套组件与样式栈，因此只保留薄 React 桥接；没有复制上游源码。 |
| 贡献入口与审查证据 | [OpenClaw `41344e0b`](https://github.com/openclaw/openclaw/tree/41344e0b7dbd5629f797c535c985fd87a323abe5)、[Hermes Agent `63279301`](https://github.com/NousResearch/hermes-agent/tree/63279301bcbdc185c1b07b98a9312eb0c862f26d)、[MCP `d4a6fc63`](https://github.com/modelcontextprotocol/modelcontextprotocol/tree/d4a6fc63648798ad6dc6daab6f79e73c9df14699) 与 [GitHub Issue Forms](https://docs.github.com/zh/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms) | MIT；Apache-2.0/CC-BY-4.0；仅参考文档 | 将 Issue 优先路由、贡献优先级、平台证据、结构化表单和 AI 辅助披露适配到 OpenBot 安全边界；没有复制模板或源码。 |
| 先调研再实现门禁 | [Rust RFC 模板 `f17e8623`](https://github.com/rust-lang/rfcs/blob/f17e8623ee2e2854570dcdb936a9f4ab08c0fcd4/0000-template.md)、[Kubernetes KEP 模板 `6ab9bf71`](https://github.com/kubernetes/enhancements/blob/6ab9bf717d1228928740bdbfe761b6e62b870902/keps/NNNN-kep-template/README.md)、[OpenSSF Scorecard workflow `54d8e4d3`](https://github.com/ossf/scorecard-action/blob/54d8e4d3c579f74e35c422a0a18e16bb58ad9426/.github/workflows/scorecards.yml)、[actions/checkout `3d3c42e5`](https://github.com/actions/checkout/tree/3d3c42e5aac5ba805825da76410c181273ba90b1) 与 [actions/setup-node `82076278`](https://github.com/actions/setup-node/tree/820762786026740c76f36085b0efc47a31fe5020) | Apache-2.0/MIT；Apache-2.0；Apache-2.0；MIT；MIT | 将可追溯的先例、替代方案、验证、兼容性和生命周期证据适配成较小的 OpenBot 调研记录；增加仓库指令和本地 PR 正文门禁，并按 commit 固定现有 CI Action。checkout 与 setup-node 固定值已分别完成 [checkout v7 调研](research/actions-checkout-v7.md)和 [setup-node v7 调研](research/actions-setup-node-v7.md)。没有复制上游模板或源码。 |
| 跨平台托管 CI | [GitHub runner images `148c0a4a`](https://github.com/actions/runner-images/tree/148c0a4acb53bb2c7c853446a290aec86b61d3c3)、[GitHub matrix 文档](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations)、[actions/checkout `3d3c42e5`](https://github.com/actions/checkout/tree/3d3c42e5aac5ba805825da76410c181273ba90b1)、[actions/setup-node `82076278`](https://github.com/actions/setup-node/tree/820762786026740c76f36085b0efc47a31fe5020)与 Git `2.55.0` `gitattributes` | MIT；GitHub 文档/服务条款；MIT；MIT；GPL-2.0 与 Git 文档许可证 | 使用明确的 GA runner 标签和原生 matrix 契约，执行必需的 Linux x64、Windows x64 与 macOS arm64 可迁移检查。复用已审核的完整 commit Action 固定值和精确 Node 版本；对发布的 systemd unit 窄范围使用 `text eol=lf`，只在语义测试边界归一化行尾。托管 CI 不能证明系统服务、密钥库、GUI 权限或真实设备支持。没有复制上游 workflow 源码；见[基线调研](research/cross-platform-node-ci.md)、[checkout v7 调研](research/actions-checkout-v7.md)和 [setup-node v7 调研](research/actions-setup-node-v7.md)。 |
| 员工包真实性 | [DSSE `1d3370f6`](https://github.com/secure-systems-lab/dsse/tree/1d3370f62565bca041e97c8310b873ac340edc2e)、[Sigstore JS `769a53d8`](https://github.com/sigstore/sigstore-js/tree/769a53d8713248a8bf49edfc2a5d1955b0dcc24d) 与 [in-toto Attestation `2dcd055e`](https://github.com/in-toto/attestation/tree/2dcd055e9f72e746687c306e35f4e59720ff45be) | Apache-2.0 | 采用 DSSE，并固定 `@sigstore/core` 4.0.1 生成预认证编码。OpenBot 只实现员工包特有的 Ed25519 密钥边界和严格解析；in-toto/Sigstore 来源证明及基于 TUF 的分发仍是独立后续适配器。未复制上游源码。 |
| Owner 员工发布密钥生命周期 | [Cosign `v3.0.6`](https://github.com/sigstore/cosign/tree/v3.0.6)、[TUF 规范 `v1.0.35`](https://github.com/theupdateframework/specification/tree/v1.0.35)、[Notary 规范 `v1.1.0`](https://github.com/notaryproject/specifications/tree/v1.1.0) 与 [Node.js `v22.23.2`](https://github.com/nodejs/node/tree/v22.23.2) | Apache-2.0；Community Specification License 1.0；Apache-2.0；MIT | 复用 Node 的 Ed25519 与加密 PKCS#8/SPKI API、Cosign 的公私钥分离、Notary 的带外信任策略以及 TUF 的密钥状态保留概念。OpenBot 只实现文件清单、离线 Owner CLI 和 DSSE HTTP 适配；没有复制上游源码。证据见[调研记录](research/employee-publisher-key-lifecycle.md)。 |
| 浏览器控制面安全 | [Hono `eebdf7be`](https://github.com/honojs/hono/tree/eebdf7be39abf0a872671835ccce0c4f03ea497a) 与 [OWASP Cheat Sheet Series `b8586414`](https://github.com/OWASP/CheatSheetSeries/tree/b8586414a5c47ae68911edb97d4e7b7bc6301035) | MIT；文档 CC BY-SA 4.0 | 复用 Hono 4.13.7 的 `secureHeaders`；采用 OWASP 的 Secure/HttpOnly/SameSite、精确 Origin、TLS 与 `__Host-` 指引。远程错误配置现在启动即失败。未复制上游源码或文字。 |
| 实时过载恢复 | [Hono streaming `eebdf7be`](https://github.com/honojs/hono/blob/eebdf7be39abf0a872671835ccce0c4f03ea497a/src/utils/stream.ts) | MIT | 保留 Hono 感知背压的 writer，只补 OpenBot 缺失的订阅策略：128 事件上限、溢出断开、权威快照恢复。未复制上游源码。 |
| 员工档案实时失效通知 | [Hermes Agent `63279301`](https://github.com/NousResearch/hermes-agent/tree/63279301bcbdc185c1b07b98a9312eb0c862f26d)、[Hono `4.13.7` / `eebdf7be`](https://github.com/honojs/hono/tree/eebdf7be39abf0a872671835ccce0c4f03ea497a) 与 [Kubernetes client-go `v0.35.1`](https://github.com/kubernetes/client-go/tree/v0.35.1) | MIT；MIT；Apache-2.0 | 采用 Hermes 的类型化详情实时刷新与 Kubernetes 的权威重读恢复，并复用已固定的 Hono SSE。Server 提交后只发送 Bot id、白名单分区和时间；Client 再读取鉴权档案。未复制上游源码，证据见[调研记录](research/employee-profile-realtime-invalidation.md)。 |
| Node 通道权威与存活 | [`ws` 8.21.3 `c791e707`](https://github.com/websockets/ws/tree/c791e707eab3c13dd9a261d2479c3cc4a49a6fed)、[Kubernetes Node heartbeat KEP `e849163a`](https://github.com/kubernetes/enhancements/blob/e849163ac4a0a5241ba626bd9a99820bf1dcd279/keps/sig-node/589-efficient-node-heartbeats/README.md) 与 [Nomad `482b49bf`](https://github.com/hashicorp/nomad/tree/482b49bf1aec006f089bcfc7e632d8f6ac303e5e) | MIT；Apache-2.0；MPL-2.0 | 复用 `ws` 消息上限和 ping/pong，把存活报告与 Server 权威任务分配分开。限制消息与登记时间、拒绝重复 hello，并清退失联 socket。没有复制上游源码。 |
| Node 启动身份 | [SPIFFE `99470b9a`](https://github.com/spiffe/spiffe/tree/99470b9abc825f14aa364dfa2c3b53b02ba5db5b)、[SPIRE 1.15.2](https://github.com/spiffe/spire/tree/v1.15.2)、[Tailscale `92ec1026`](https://github.com/tailscale/tailscale/tree/92ec102673bf46d72bab64b0a278b93c01a47f34)、[Headscale 0.29.3](https://github.com/juanfont/headscale/tree/v0.29.3)、[Kubernetes 1.36.2](https://github.com/kubernetes/kubernetes/tree/v1.36.2) 与 [Smallstep Certificates 0.30.2](https://github.com/smallstep/certificates/tree/v0.30.2) | Apache-2.0；BSD-3-Clause | 采用短时单次启动、Server 只存摘要、独立 Node 状态、吊销和只显示一次。HTTP/文件机制复用 Hono 与 `write-file-atomic`；本地只实现 OpenBot 的 PostgreSQL 事务、协议和审计差集。持有证明、PKI、轮换、系统密钥库和防重放另行审查。没有复制上游源码。 |
| Owner Node 管理 | [Headplane `v0.7.0`](https://github.com/tale/headplane/tree/v0.7.0)、[Headscale `v0.29.3`](https://github.com/juanfont/headscale/tree/v0.29.3) 与 [Tailscale `92ec1026`](https://github.com/tailscale/tailscale/tree/92ec102673bf46d72bab64b0a278b93c01a47f34) | MIT；BSD-3-Clause | 采用设备列表、显式添加、单次启动、持久机器状态和独立破坏性操作流程。OpenBot 复用现有原生弹窗、Owner Session、实时投影与 Node 身份服务，因为其他控制平面不能安全成为本地身份权威。没有复制上游源码，证据见[调研记录](research/node-management-console.md)。 |
| 敏感文件原子写入 | [`npm/write-file-atomic` 8.0.0](https://github.com/npm/write-file-atomic/tree/v8.0.0) | ISC | 直接使用发布依赖完成 fsync、原子 rename、同目标串行化和失败临时文件清理，不再本地维护这些机制。Artifact 与 Node 凭证文件均请求 `0600`；最终权限位只在 POSIX 上验证，因为 Windows 不实现 owner/group/other 权限类别。Windows ACL 保护需要另行审查。没有复制上游源码。 |
| Artifact 读取完整性 | [OCI Image Specification `13cff549`](https://github.com/opencontainers/image-spec/blob/13cff54902ec9ad6320cbc487a685b66fcd67171/descriptor.md#verification) 与现有 OpenBot Artifact 元数据 | Apache-2.0；MIT | 返回字节前，对现有权威记录采用先大小、后 SHA-256 的校验。没有新增依赖或复制上游源码；对象存储校验和与修复告警仍是未来适配器。证据见[调研记录](research/artifact-read-integrity.md)。 |
| POSIX 凭证权限漂移 | [OpenSSH portable `1bf5871a`](https://github.com/openssh/openssh-portable/blob/1bf5871aead6d73177d727add15ab0f14c258fdf/authfile.c)、[OpenClaw `095d5220`](https://github.com/openclaw/openclaw/commit/095d522099653367e1b76fa5bb09d4ddf7c8a57c) 与 [`write-file-atomic` 8.0.0](https://github.com/npm/write-file-atomic/tree/v8.0.0) | BSD 风格许可证集合；MIT；ISC | 在现有原子适配器外采用 OpenSSH 的 group/other 权限位 fail-closed 规则和已打开句柄校验。OpenBot 会拒绝暴露的 POSIX Node 与员工发布者凭证而不是静默修复；Windows ACL 与系统密钥库需要另行审查。没有复制上游源码，证据见[调研记录](research/posix-node-credential-permissions.md)。 |
| Windows Node 凭据 ACL | Microsoft Learn icacls; .NET FileSecurity/DirectorySecurity; Desktop windows-native-security.ts @ 729c16431057; write-file-atomic 8.0.0 | Microsoft docs; MIT; ISC | Windows 文件型 Node 凭据目录/文件强制 Owner+SYSTEM DACL；见 research/windows-node-credential-acl.md。 |
| 共享 Windows 机密 ACL（Server model/plugin N2） | 自 Node Windows ACL 抽取至 `@openbot/windows-secret-acl`；Microsoft Learn icacls；.NET FileSecurity/DirectorySecurity；Desktop windows-native-security.ts 谱系 | MIT（OpenBot）；Microsoft docs | 将 Owner+SYSTEM DACL 与重解析边界抽成工作区包，供 Node 凭据存储与 Server model-settings/plugin-store/密钥文件共用。已有目录仅校验；新建专用目录写入前保护。指纹与 Owner SID 缓存避免热路径每次拉起 PowerShell。无新外部依赖。不是 Credential Manager/DPAPI。见[研究记录](research/server-windows-secret-acl.zh-CN.md)。 |
| Windows 原生 ACL 测试夹具（Server + Node） | OpenBot `@openbot/windows-secret-acl` 生产 spawn 卫生（inbox powershell、`shell:false`、`stdin.end()`、15s `execFile`、.NET `GetAccessControl`）；Vitest 单测超时；Node `execFile` timeout | MIT（OpenBot）；Node.js；Vitest MIT | 仅按生产 PowerShell 调用次数 × 15s（+ 小余量）约束原生 Windows ACL Vitest 截止时间。原生否定镜像生产 `broadenAcl` 卫生——不用 `Get-Acl`/`Get-Item`/`Set-Acl`、不用裸 PATH powershell、不无限等待 stdin。保留真实 Owner+SYSTEM 正/负断言；生产 spawn 仍为 15s；`cacheVerifiedState` 保持默认关闭。见[研究记录](research/windows-native-acl-test-budget.zh-CN.md)。 |
| 根 Vitest 测试运行器 | [Vitest `5.0.0` / `f441c6fa`](https://github.com/vitest-dev/vitest/tree/f441c6fab25e579c5b7dd3dd50538416f415fbae)；peer Vite `^6.4 or ^7 or ^8`（仓库提升 Vite 8.2.2）；Node engines 已满足 `^22.22.2 or ^24.15.0 or >=26` | MIT | 精确固定根 `devDependency` vitest 5.0.0 及 lockfile 传递 `@vitest/*` 5.0.0。保留既有断言；除非套件证明需要，否则不设 `clearMocks: false`。可选将 `.vitest/` 加入 gitignore（v5 产物目录）。Dependabot #27 被本调研迁移取代（#27 缺 Open-source research；Windows ACL 60s 为夹具问题，已由 #42 修复）。未复制产品源码；见[调研证据](research/vitest-5-migration.zh-CN.md)。 |
| Linux Worker Host 服务与 Secret Service | [Secret Service API 0.2](https://specifications.freedesktop.org/secret-service/latest-single/)、Ubuntu 24.04 [libsecret `0.21.4` / `6b5a6c28`](https://github.com/GNOME/libsecret/tree/6b5a6c28afc6dd93c232a4907a87c881079ff91b)和当前 [`0.21.7` / `0936f740`](https://github.com/GNOME/libsecret/tree/0936f740c02b60f02657729cd99f581db4517a41)、[systemd `v255` / `db11bab3`](https://github.com/systemd/systemd/tree/db11bab38ccf1ed257f310d29070843d4c58ea01)、[`@napi-rs/keyring` `2.0.0` / `f3449416`](https://github.com/Brooooooklyn/keyring-node/tree/f3449416a1b4bf11b0570f0a49395aacc84c8608) 与已归档 [`node-keytar` `7.9.0` / `5adb540f`](https://github.com/atom/node-keytar/tree/5adb540f8557801c52254e969a6c7ed9ef4d16f0) | 规范；LGPL-2.1-or-later；LGPL-2.1-or-later；MIT；MIT | 只在专用登录用户中采用 Secret Service，在无人值守专用账户中采用 systemd 加固。维护中的 Node 候选会静默退回另一种 Linux keyring，而 keytar 已归档，因此使用有界外部 `secret-tool` 适配器。后端、会话或工具失败都不会退回文件。未复制上游源码，见[调研证据](research/linux-worker-host-service-and-secret-service.md)。 |
| Linux Worker Host 可验证压缩包 | 官方 [Node.js `v22.22.2` / `2645dc73`](https://github.com/nodejs/node/tree/2645dc73720b1b4f27c49f395d3c66025ce126cc)发布压缩包、[`@vercel/ncc` `0.45.0` / `cb1f1f05`](https://github.com/vercel/ncc/tree/cb1f1f058bfa7de4cb63f2411e14a724e714e260)、[npm CLI `10.9.9` / `745d8d90`](https://github.com/npm/cli/tree/745d8d90b5403110d26ba332ba83d8c5a51f0578)、[GNU tar 1.35](https://www.gnu.org/software/tar/manual/html_node/Reproducibility.html)、Ubuntu 24.04 安全修补的 xz 5.4.5、[`actions/attest` `v4.2.2` / `1e69f48a`](https://github.com/actions/attest/tree/1e69f48acb82d1966a394da916b4c1698aa569d6)、[`actions/upload-artifact` `v7.0.1` / `043fb46d`](https://github.com/actions/upload-artifact/tree/043fb46d1a93c77aae656e7c1c64a875d1fc6a0a)与 [`ubuntu-24.04-arm` 清单 `c623f513`](https://github.com/actions/runner-images/blob/c623f51349e6e669403715506fe7f4c63b14e08b/images/ubuntu/Ubuntu2404-Arm64-Readme.md) | Node.js 许可证；MIT；Artistic-2.0；GPL-3.0-or-later；公共领域/LGPL/GPL 组合；MIT；MIT；MIT/工具许可证/服务条款 | 把应用打成一个可审计 JS 入口，与哈希已验证的官方运行时组合，并输出仅含生产依赖的 SPDX SBOM、规范文件清单和校验和。GNU tar/xz 用固定元数据/参数创建压缩包；由于 xz 输出可能随构建变化，同一任务必须做两次字节比对。tag 矩阵会在对应 x64/arm64 托管 CPU 上执行每个包后再做证明。本地产物明确标为未签名；授权 tag workflow 无法生成来源证明时必须失败。直接工作流上传会保留原始字节，但只是临时审查传输，不是 GitHub Release。SEA 仍在实验演进，`pkg` 已归档。未复制上游源码，见[调研证据](research/linux-worker-host-archive.md)。 |
| Linux Worker Host 可恢复安装 | [FHS 3.0](https://refspecs.linuxfoundation.org/FHS_3.0/fhs/index.html)、[POSIX.1-2024 `rename()`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html)、[systemd `v255` / `db11bab3`](https://github.com/systemd/systemd/tree/db11bab38ccf1ed257f310d29070843d4c58ea01)、[GitHub CLI `v2.93.0`](https://github.com/cli/cli/tree/v2.93.0)、GNU tar `1.35`、xz `5.4.5`、未采用的 [`node-tar` `7.5.22` / `2a22bfc5`](https://github.com/isaacs/node-tar/tree/2a22bfc5d3a432a606d9da0e2d87ba634aa3b1cb)、未采用的 [`tar-stream` `3.2.1` / `246572f4`](https://github.com/mafintosh/tar-stream/tree/246572f479d92b0748b21c873e58c64a84a0b826)、[Debian Policy `4.7.4.1`](https://www.debian.org/doc/debian-policy/)与 [OSTree `v2026.1`](https://github.com/ostreedev/ostree/tree/v2026.1) | 标准；LGPL-2.1-or-later；MIT；GPL-3.0-or-later；public-domain/LGPL/GPL 混合；BlueOak-1.0.0；MIT；GPL-2.0-or-later；LGPL-2.0-or-later | 采用版本化 `/opt` 布局、私有且由 root 持有的 `/var/lib` 事务状态、同文件系统原子符号链接替换、精确证书 SAN 来源证明验证、严格 GNU tar 清单/解压与 systemd 健康检查；拒绝 GitHub CLI 的前缀匹配 signer-workflow 参数，node-tar 近期链接/路径安全通告过密，tar-stream 又缺少文件系统策略，因此都不适合该高权限边界。只本地实现 OpenBot 缺失的版本选择、恢复日志和健康检查绑定回滚。通用 systemd-sysupdate/OSTree 部署过宽，Debian 包脚本也不提供应用健康回滚。未复制上游源码，见[调研证据](research/linux-worker-host-install-transaction.md)。 |
| Linux Worker Host 高权限引导边界 | [Node.js `v22.22.2` / `2645dc73`](https://github.com/nodejs/node/tree/2645dc73720b1b4f27c49f395d3c66025ce126cc)、FHS 3.0、POSIX.1-2024 目录操作、[systemd `v255` / `db11bab3`](https://github.com/systemd/systemd/tree/db11bab38ccf1ed257f310d29070843d4c58ea01)、Linux man-pages `6.19` `openat2`、未采用的 [`proper-lockfile` `4.1.2` / `9f8c303c`](https://github.com/moxystudio/node-proper-lockfile/tree/9f8c303c91998e8404a911dc11c54029812bca69)、未采用的 [`fs-ext` `2.1.1` / `aded9760`](https://github.com/baudehlo/node-fs-ext/tree/aded976099c2b06c944f0897a9b004dbf266e234)、未采用的 [`commander` `15.0.0` / `ba6d13dd`](https://github.com/tj/commander.js/tree/ba6d13ddb4243e5913367734f8c159089ffe7834)与未采用的 [`yargs` `18.1.0` / `8878a894`](https://github.com/yargs/yargs/tree/8878a894111e3fe7c98d84af546c0f34fa017492) | Node.js 许可证；标准；LGPL-2.1-or-later；man-pages 许可证集合；MIT；MIT；MIT；MIT | 通过已打开句柄把不可信压缩包只复制一次，放进路径固定、root 持有的私有状态目录；随后只在同一把原子目录锁下对这份导入文件执行来源证明、解压和激活。缺失的固定子目录只会在逐级验证父目录后用 Node 非递归 `mkdir` 创建；已有子目录若所有者或权限不符则绝不改写。两动作命令只用固定 Node core 的严格/token 模式解析，架构与各类 id 均由程序产生，argv 绝不接收凭证；Commander 与 Yargs 会增加高权限交付代码，却不能封闭新的边界缺口。`systemd-tmpfiles` 对错误既有状态的诊断本身不保证命令失败，因此延期采用。高权限陈旧锁不会按时间自动回收。锁身份不能只依赖 overlay 的 `dev`/`ino`/`ctimeMs`；进程私有的独占 token 文件和打开前源摘要用于检测目录替换与等长原地改写（见[身份审查](research/linux-install-fs-identity.md)）。Node core 未暴露 `openat2`；固定目标路径并要求所有可变祖先均由 root 持有且不可被组/其他用户写入，可在不增加原生二进制的情况下封闭第一段引导缺口。未复制上游源码，见[调研证据](research/linux-worker-host-privileged-bootstrap.md)。 |
| Windows Worker Host 服务边界 | [`Microsoft.Extensions.Hosting.WindowsServices` `10.0.11`](https://www.nuget.org/packages/Microsoft.Extensions.Hosting.WindowsServices/10.0.11)，来自 [`dotnet/dotnet` `e2f47b01`](https://github.com/dotnet/dotnet/tree/e2f47b0110ed922f21a1522da67279133ce28f32)；[`Meziantou.Framework.Win32.Jobs` `4.0.0` / `111934ad`](https://github.com/meziantou/Meziantou.Framework/tree/111934ad792cefd946e99bfd1bba71c39e45f163)；Microsoft SCM、重定向输入与 Job Object 契约；[Node.js `v22.22.2` / `2645dc73`](https://github.com/nodejs/node/tree/2645dc73720b1b4f27c49f395d3c66025ce126cc)；拒绝 [WinSW `v2.12.0` / `eef5bade`](https://github.com/winsw/winsw/tree/eef5bade59fca0254e387ac73ed7625ba6aa7147) 和 [`node-windows` `1.0.0-beta.8` / `e60ec01c`](https://github.com/coreybutler/node-windows/tree/e60ec01cb63f73a713581548d24256b25c5f93f8) | MIT；MIT；Microsoft 文档/API；Node.js 许可证；MIT；MIT 与随包组件 | 采用 Microsoft 正式发布的 SCM 生命周期并制作为自包含、单文件的 Windows x64 主机。继承的重定向标准输入只接受精确、有界且按顺序的 `START`、`SHUTDOWN` 协议：Job 分配成功前，已验证的 Node 入口保持休眠，从而在任何客户端或 Provider 副作用前封住 `Process.Start()` 的分配窗口。固定的匿名 Job Object 启用退出即终止且禁止 breakaway，负责强制隔离；普通 Windows 信号和 `Process.Kill(true)` 不能证明优雅或完整进程树退出。本地只补固定且已验证的子进程监管、协作排空、脱敏诊断与安装事务接入。首版采用 LocalService，但任何支持声明前都必须取得原生身份、ACL、停机、重启、升级和凭证拒绝证据。仍拒绝 WinSW 与 `node-windows`。未复制上游源码，见[调研证据](research/windows-worker-host-service.md)。 |
| Windows Worker Host 构建门槛 | [`actions/setup-dotnet` `v5.3.0` / `9a946fdb`](https://github.com/actions/setup-dotnet/tree/9a946fdbd5fb07b82b2f5a4466058b876ab72bb2)、[.NET SDK `10.0.400` / runtime `10.0.11`](https://github.com/dotnet/core/blob/main/release-notes/10.0/10.0.11/10.0.11.md)、NuGet package lock 与 GitHub 托管 `windows-2025` x64 | MIT；MIT；各包许可证；GitHub 服务/工具条款 | 以完整提交固定第一方 action，并通过 `global.json` 选择精确 LTS SDK。只用 `--locked-mode` 恢复精确依赖图，运行纯测试，并输出自包含、单文件 `win-x64` 产物；本门槛检查输出清单但不上传。拒绝可变的镜像预装 SDK、本地重复安装脚本，以及浮动 action 或 SDK 版本。这只是编译证据，不是 SCM、签名、安装器、Credential Manager 或平台支持证据。未复制上游源码，见[调研证据](research/windows-worker-host-build-lane.md)。 |
| Windows Worker Host 安装器契约 | Microsoft Windows Installer 5.0 服务、配置、ACL、组件、升级与回滚表；有条件采用的 [`WiX Toolset v7.0.0` / `b8977d6f`](https://github.com/wixtoolset/wix/tree/b8977d6f88e7b68e000bac226a2814f236770570)；未采用 WiX v6/v3、MSIX 打包服务、自安装/SCM 脚本与 Electron 包装器 | Windows 平台/API 条款；WiX 源码 MS-RL、二进制 OSMF EULA v1.1；各候选自身条款 | 采用系统内置 MSI 标准事务作为打包契约，并禁止自定义动作、下载、凭证、可变路径、关闭回滚或登记前自动启动。WiX v7 是首个技术上可行的构建适配器，但 Owner 明确决定 OSMF EULA 和可能的费用义务前，OpenBot 不会下载、执行或加入它。编译后 MSI 表测试保持与适配器无关。未引入上游源码或二进制，见[调研证据](research/windows-worker-host-installer.md)。 |
| macOS Worker Host launchd 边界 | macOS 13+ `SMAppService`、LaunchAgent、`BundleProgram` 与当前 launchd 契约；未采用 [`node-mac` `1.0.1` / `2bf9e64f`](https://github.com/coreybutler/node-mac/tree/2bf9e64f637f3ab1f036bf69c1205d0f6c227e7b)、[`emorydunn/LaunchAgent` `0.3.0` / `9f6d33ab`](https://github.com/emorydunn/LaunchAgent/tree/9f6d33abfa4a0a45a877e9b884391981c1f4152b)、[Homebrew `6.0.21` / `56014701`](https://github.com/Homebrew/brew/tree/560147012b9678b42ef5e83b690f0895552d1366)与 [Swift Service Lifecycle `2.11.0` / `9829955b`](https://github.com/swift-server/swift-service-lifecycle/tree/9829955b385e5bb88128b73f1b8389e9b9c3191a) | Apple 平台/API 条款；带已审查许可证缺陷的 MIT 声明；MIT；BSD-2-Clause；Apache-2.0 | 为专用标准账号采用用户批准的应用内 LaunchAgent，固定唯一 `BundleProgram` 与 `--worker-host` 模式、仅崩溃重启、私有 umask 与有界 launchd 停机。双模式原生主程序、登记界面、固定子进程监管、plist 契约测试、Swift 原生测试与 arm64 候选构建已完成；Developer ID、登记生命周期与真实设备证据仍是外部门槛。禁止 root daemon、任意命令、旧式 plist 安装器、包管理器依赖、第二套重启循环、含凭证的 plist/argv 或桌面权限。未复制候选源码，见[调研证据](research/macos-worker-host-launchd.md)。 |
| macOS Worker Host 配置与 Keychain | Apple Security 数据保护 Keychain、access group 与受限 entitlement 契约；Node.js [`22.22.2` / `2645dc73`](https://github.com/nodejs/node/tree/2645dc73720b1b4f27c49f395d3c66025ce126cc)；[Zod `4.5.4` / `e8e206fa`](https://github.com/colinhacks/zod/tree/e8e206fa33ac5fe7ce20a2beb12d57b1cb3df653)；未采用 [SwiftSecurity `2.0.0` / `c26f18ad`](https://github.com/dm-zharov/swift-security/tree/c26f18adbb20f9e4e810d3ba7553e095a74ea2c0)、[KeychainSwift `24.0.0` / `5e1b02b6`](https://github.com/evgenyneu/keychain-swift/tree/5e1b02b6a9dac2a759a1d5dbc175c86bd192a608)、[`@napi-rs/keyring` `2.0.0` / `f3449416`](https://github.com/Brooooooklyn/keyring-node/tree/f3449416a1b4bf11b0570f0a49395aacc84c8608)、[Cosmiconfig `10.0.1` / `219805f4`](https://github.com/cosmiconfig/cosmiconfig/tree/219805f445a26a6190d3a46ad43c8b5c3f0a172e)与 [Convict `6.2.5` / `517840e1`](https://github.com/mozilla/node-convict/tree/517840e19681be3ddc1c8f5d47d0e6c781795cf2) | Apple 平台/API 条款；Node.js 许可证；MIT；MIT；MIT；MIT；MIT；Apache-2.0 | 在签名 App 主程序内直接通过 Apple Security 查询唯一、不同步、仅本设备的条目；用 Node opened-handle API 与严格 Zod 读取唯一固定的非执行 JSON 配置。严格配置、绑定 Server 的信封、直接 Security 查询、access group 推导、一次性 `stdio-v3` 交接与有界进程组监管均已实现并通过 Node/Swift 测试；经分发 profile 授权及真实 Keychain 锁定/解锁证据仍待完成。通用包装库、原生 addon、`/usr/bin/security` 与配置搜索/合并库扩大了可调用或可变表面，却不能固定调用关系，因此不采用。未复制上游源码，见[调研证据](research/macos-worker-host-config-and-keychain.md)。 |
| macOS Worker Host 登记与安装包 | Apple `SMAppService`、Security、Developer ID、`codesign`、`productbuild`、`pkgutil`、`notarytool`、`stapler` 与 Gatekeeper；未采用 SwiftPkg [`0.4.1` / `ad0007e7`](https://github.com/codecarton/swiftpkg/tree/ad0007e7263360950c17cca6d0c4b0d3084a9b13)、已退役 MunkiPkg [`7d57d075`](https://github.com/munki/munki-pkg/tree/7d57d0750bd6787838322b7abf02693da033d584)与 Mackage [`1.0.0` / `766db3a8`](https://github.com/tactcomplabs/mackage/tree/766db3a83276d0cc5cd2260471b334295960171a) | Apple 平台/API 条款；Apache-2.0；BSD-style/`NOASSERTION`；Apache-2.0 | 直接使用 Apple 工具制作不含安装脚本的单 App 包。候选 staging、固定 Node、Mach-O 架构、entitlement/profile/Team 绑定、由内到外签名、签名后重算清单、AppleDouble 拒绝、公证/staple/Gatekeeper 门槛及本机 arm64 未签名/ad hoc 机制均已实现。本机没有分发证书与 notary profile，因此签名/公证及安装生命周期声明仍待完成。未复制候选源码，见[调研证据](research/macos-worker-host-package-and-registration.md)。 |
| 不可信 PNG 校验候选 | [`image-js/fast-png` 8.0.0](https://github.com/image-js/fast-png/tree/v8.0.0) 与 [`sharp` 0.35.0](https://github.com/lovell/sharp/tree/v0.35.0) | MIT；Apache-2.0 | 完整解码和归一化暂缓。`fast-png` 没有输入像素资源上限；`sharp` 有上限，但原生包必须先通过 Server 的 Linux x64/arm64 打包矩阵。当前签名检查明确不代表 PNG 完整有效。 |
| Node 协议输入校验 | [Zod 4.5.4 `e8e206fa`](https://github.com/colinhacks/zod/tree/e8e206fa33ac5fe7ce20a2beb12d57b1cb3df653)、[OWASP Cheat Sheet Series `b8586414`](https://github.com/OWASP/CheatSheetSeries/tree/b8586414a5c47ae68911edb97d4e7b7bc6301035) 与 [MCP TypeScript SDK `5119ee7f`](https://github.com/modelcontextprotocol/typescript-sdk/tree/5119ee7fd7790e335a3fb60ef36f85334e2a6326) | MIT；文档 CC BY-SA 4.0；MIT | 复用现有固定版本的 Zod 实现严格消息与字段边界，并采用 OWASP 的白名单和范围原则。OpenBot 只保留协议特有的有界审批证据遍历；MCP 仅作协议校验先例，不共享 Node 权威语义。没有复制上游源码。 |
| Server 有界停机 | [Node.js HTTP 文档 `2645dc73`](https://github.com/nodejs/node/blob/2645dc73720b1b4f27c49f395d3c66025ce126cc/doc/api/http.md)、[`@hono/node-server` `73c03adf`](https://github.com/honojs/node-server/tree/73c03adfb01928fcd5f5b20faebd5d692f83fc93)、[Fastify 生命周期文档 `af079bd4`](https://github.com/fastify/fastify/blob/af079bd4c60c3cbebedc7640517d7288468fb5eb/docs/Reference/Server.md) 与 [`@godaddy/terminus` `aea2f6de`](https://github.com/godaddy/terminus/tree/aea2f6de06dbc9f631dd4ac8a21b91c052add3ce) | MIT | 复用 Hono 已返回的 Node 原生 close/空闲连接/强制关闭生命周期；本地只补 OpenBot 调度尾任务排空。Terminus 无法观察 Server 权威 Run 提交，因此不新增依赖。没有复制上游源码。 |
| Server 生产容器 | [Node.js `v24.21.0` LTS](https://nodejs.org/en/blog/release/v24.21.0)、官方 [`node:24.21.0-bookworm-slim` 源码 `93a7bafc`](https://github.com/nodejs/docker-node/tree/93a7bafc324a85ac1ee461604cff87cffacb6d7a/24/bookworm-slim)与 OCI index `sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553`、[Dockerfile](https://docs.docker.com/reference/dockerfile/)、[构建检查](https://docs.docker.com/reference/build-checks/)及[多平台构建](https://docs.docker.com/build/building/multi-platform/)契约；未采用官方 Node `24.20.0-alpine3.24`；Dependabot Docker 对 `node` 忽略 `version-update:semver-major` | Node.js 许可证；MIT 镜像源码加随附 Debian 组件许可证；Apache-2.0 文档；未采用镜像含随附 Alpine 许可证；GitHub Dependabot 配置条款 | 选择精确的多平台 Bookworm-slim 镜像，因为 Node 24 的 glibc amd64 与 arm64 均为 Tier 1；用薄本地多阶段适配器只保留 Server 生产闭包、migration 和 Node 健康探针，并以无特权 `node` 用户运行。musl 仍为 Experimental，非 x64 musl 镜像也缺少同等级发布前测试，因此不把 Alpine 用作本次生产基线。保持 Node 24 Active LTS；忽略 Dependabot 自动 Docker major（不要经 Dependabot 直接采用仍为 Current 的 Node 26），直至完成 LTS + Corepack/npm 准备 + 双架构健康/migration 复审。必须通过原生托管构建及 PostgreSQL migration、健康、重启和 `SIGTERM` 冒烟，但不发布镜像或宣称平台支持。未复制上游源码，见[调研证据](research/server-node24-production-container.md)。 |
| PostgreSQL migration 完整性 | [Drizzle ORM 0.45.2 `e7dfa145`](https://github.com/drizzle-team/drizzle-orm/tree/e7dfa14519f363229ccc3ead7b1b2f2051937efb)、[Postgres.js 3.4.9](https://github.com/porsager/postgres/tree/v3.4.9)、[PostgreSQL 17 `ec3f6a6a`](https://github.com/postgres/postgres/tree/ec3f6a6a7dd82a8ce455a0710ef75172f9f318d1) 与 [Docker Official Image `2603e26e`](https://github.com/docker-library/postgres/tree/2603e26e245e558218728ee14e0a42dcb020dc7f) | Apache-2.0；Unlicense；PostgreSQL License；MIT 加 PostgreSQL 组件 | 保留 Drizzle migrator，并按上游要求使用独立 `max: 1` Postgres.js 客户端；本地只增加数据库 advisory lock 与精确前缀哈希/时间戳校验，弥补已公开的高水位和并发启动缺口。固定 PostgreSQL 17.11 bookworm，在真实 CI 服务中测试。没有复制上游源码。 |
| Server 权威审批策略 | [CEL 规范 `v0.25.2` / `cb51b417`](https://github.com/google/cel-spec/tree/cb51b4176013ad19bd00df94be273c322916a620)、[OPA `v1.16.2` / `85f6d990`](https://github.com/open-policy-agent/opa/tree/85f6d990d19094da38e829561813e7da7fbae272) 与 [Cerbos `v0.46.0`](https://github.com/cerbos/cerbos/tree/v0.46.0) | Apache-2.0 | 保留现有本地求值器，并补上 Server 拥有的静态 action/target/最低风险目录。CEL 是未来表达式首选候选，但 CEL、OPA 和 Cerbos 都不提供 OpenBot 的签名策略分发或能力租约生命周期，现阶段会过早增加权威与配置面。未复制上游源码，见[调研证据](research/dev-001-short-term-hardening.md)。 |
| Capability lease 协议（DEV-001 H2 设计） | [RFC 9449 DPoP](https://datatracker.ietf.org/doc/rfc9449/)、[RFC 9396 RAR](https://datatracker.ietf.org/doc/rfc9396/)、[RFC 7519 JWT](https://datatracker.ietf.org/doc/html/rfc7519)、选定 [`jose@6.2.12`](https://www.npmjs.com/package/jose/v/6.2.12) / tag 对象 [`99eaf5ed`](https://github.com/panva/jose/tree/v6.2.12) → 提交 [`505a55b8f73536082367b2614cb77e927ba96ec1`](https://github.com/panva/jose/commit/505a55b8f73536082367b2614cb77e927ba96ec1)（[`JWTVerifyOptions`](https://github.com/panva/jose/blob/main/docs/jwt/verify/interfaces/JWTVerifyOptions.md)；[Node alg 表 #262](https://github.com/panva/jose/issues/262) 列出 `EdDSA` + `Ed25519`）、比较 [SPIRE `v1.15.3` / `2f7861ae`](https://github.com/spiffe/spire/releases/tag/v1.15.3)、[PASETO `4.0.1` / `5c7812e818c1`](https://github.com/panva/paseto/tree/5c7812e818c1d50a47ce3baf107614c42ae16c43)、[`macaroons.js` `0.3.9` / `0a036117`](https://github.com/nitram509/macaroons.js/tree/0a0361174a07)、[Branca `0.5.0` / `498bb5f7`](https://github.com/tuupola/branca-js/tree/498bb5f76316)、以及引擎 `^22.22.2 or ^24.15.0 or >=26.0.0` 上的 Node.js `crypto.generateKeyPairSync('ed25519')` | IETF Trust；MIT（jose，无运行时依赖）；比较 Apache-2.0/MIT；Node.js license | Proposed CONVERGE（闸门未关闭）：**选定 jose@6.2.12** 做 JWS Compact JWT 编解码；受保护头 `alg` 固定为完全指定的 **`Ed25519`**（拒绝 `EdDSA`，除非签发 API 被迫改发并文档化单一冻结值）；Server 私钥签发，Node 仅用钉扎公钥/`kid` 校验（禁止 `jku`/`jwk` 远程取钥）；Server 负责 PostgreSQL 原子 approve+issue 与单次 consume/吊销竞态——**「库缺少租约存储语义」不是拒绝 jose 做签名编码的理由**。采纳 RFC 9449/9396 声明/绑定语义；副作用路径必填 `providerId`；拒绝协议降级；令牌 ≤8192 字节。不引入 SPIRE/OAuth/PASETO/macaroons/Branca。Accept 与编码切片前无运行时改动；Provider 保持禁用。见[调研](research/capability-lease-protocol.zh-CN.md)与 [ADR-0045](decisions/0045-capability-lease-protocol.md)。 |
| 持久登录客户端身份与限速 | [RFC 7239](https://www.rfc-editor.org/rfc/rfc7239)、[Hono Node Server `73c03adf`](https://github.com/honojs/node-server/tree/73c03adfb01928fcd5f5b20faebd5d692f83fc93)、[OWASP Cheat Sheet Series `b8586414`](https://github.com/OWASP/CheatSheetSeries/tree/b8586414a5c47ae68911edb97d4e7b7bc6301035)、NIST [SP 800-63B-4](https://doi.org/10.6028/NIST.SP.800-63B-4) 与 [PostgreSQL 17 `ec3f6a6a`](https://github.com/postgres/postgres/tree/ec3f6a6a7dd82a8ce455a0710ef75172f9f318d1) | IETF Trust；MIT；文档 CC BY-SA 4.0；美国政府公共领域作品；PostgreSQL License | 复用 Hono 的直接 socket 地址；只有直接对端等于唯一配置的可信代理时才接受恰好一跳 `Forwarded`；原始地址经域分离摘要后进入原子 PostgreSQL bucket。`hono-rate-limiter` 与 `express-rate-limit` 无法建立缺失的代理信任契约，因此不采用。未复制上游源码，见[调研证据](research/dev-001-short-term-hardening.md)。 |
| 结构化脱敏运行日志 | [Pino `10.3.1` / `6b344980`](https://github.com/pinojs/pino/tree/6b344980eae3ebed904fc87caf4bba0ab9dbe946)、[Winston `3.19.0`](https://github.com/winstonjs/winston/tree/v3.19.0) 与 [OWASP Cheat Sheet Series `b8586414`](https://github.com/OWASP/CheatSheetSeries/tree/b8586414a5c47ae68911edb97d4e7b7bc6301035) | MIT；MIT；文档 CC BY-SA 4.0 | 通过窄小的本地白名单 API 使用 Pino，提供等级、子级关联字段和脱敏；控制面代码不开放任意对象或 Error 日志。Winston 的传输能力对本项目过宽。未复制上游源码，见[调研证据](research/dev-001-short-term-hardening.md)。 |
| Web 组件交互测试 | [jsdom `30.0.1` / `6584485f`](https://github.com/jsdom/jsdom/tree/6584485f094d5b271553005b68804c93a455c002)、[Happy DOM `20.14.0` / `eac5a380`](https://github.com/capricorn86/happy-dom/tree/eac5a38026b0569f2d52b609b2bb4cbaa94d9644) 与 [Vitest `5.0.0` / `f441c6fa`](https://github.com/vitest-dev/vitest/tree/f441c6fab25e579c5b7dd3dd50538416f415fbae)（jsdom 环境；browser mode 仍为未来） | MIT | 在根 Vitest 5.0.0 运行器下仅把精确固定的 jsdom 用作开发测试环境，覆盖 React 表单、焦点、按钮、alert 和异步状态。它与仓库 Node 下限一致，无需下载浏览器或访问应用网络。Happy DOM 仍有与本次 disabled 控件/计时相关的差异；Vitest browser mode 留作未来真实跨浏览器层。未复制上游源码，见[调研证据](research/dev-001-short-term-hardening.md)与 [Vitest 5 迁移](research/vitest-5-migration.md)。 |
| CI 依赖与密钥扫描 | [TruffleHog `3.97.1` / `20652fbb`](https://github.com/trufflesecurity/trufflehog/tree/20652fbbdefffcdaa493a5bf57ab2ac6b1db715b)、[Gitleaks `v8.27.2` / `c7acf33`](https://github.com/gitleaks/gitleaks/tree/c7acf33) 与 [npm CLI `10.9.9` / `745d8d90`](https://github.com/npm/cli/tree/745d8d90b5403110d26ba332ba83d8c5a51f0578) | AGPL-3.0；MIT；Artistic-2.0 | 在 CI 中以只读、digest 固定容器运行 TruffleHog，并关闭验证与更新；它不链接也不随 OpenBot 分发。选择精确审查的 npm CLI，以 `npm ci --ignore-scripts` 校验并构建完整锁定树，再以失败关闭方式只审计生产依赖。Gitleaks 是备用静态候选，不采用其面向组织另行授权的官方 Action。见[调研证据](research/dev-001-short-term-hardening.md)。 通过 [历史测试数据精确判定](research/credential-scan-fixture-triage.zh-CN.md) 中的 JSON 适配器处理唯一误报，继续扫描完整历史并保留所有检测器。 |
| 浏览器出站加固 | [OWASP SSRF Prevention Cheat Sheet `b8586414`](https://github.com/OWASP/CheatSheetSeries/blob/b8586414a5c47ae68911edb97d4e7b7bc6301035/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.md) 与 [CopilotKit/OpenBot `agent-computer` `257c1280`](https://github.com/CopilotKit/openbot/tree/257c1280d684089be9adb0b35cce262efc7064bf/agent-computer) | 文档 CC BY-SA 4.0；MIT | 延期。当前 Docker Provider 的 DNS 预检无法约束另一个浏览器服务的重定向和真实连接。出站控制进入 `agent-computer` 或其网络命名空间前，该适配器仅可用于可信测试目标；不把更多应用层预检宣传成 SSRF 控制。见[调研证据](research/dev-001-short-term-hardening.md)。 |
| 办公室可视化 | 项目所有者提供的腾讯 Marvis 产品图片 | 未找到可复用源码许可证 | 只作视觉启发，不引入 Marvis 代码或资源；办公室继续作为延期插件。 |
| 桌面事件流生命周期 | Electron 44.2.0 / tag object `369b0d9d3afdd5b8c0bdb0ad42391443947a7424`；AbortController | MIT；Node.js license | 单窗口保留一条工作区与一条频道流；替换、导航、关闭时中止。重建响应不能依赖上游协议取消，无源码复制；[研究](research/desktop-stream-lifecycle.md)。 |

## 追溯覆盖图

当前分支已在 2026-09-04 完成代码范围盘点。“已审查”只表示该机制已映射到上方固定版本条目，
不代表已经达到生产可用。“部分”会阻止继续扩展对应边界，直到缺失审查完成。

| 现有代码边界 | 覆盖状态 | 审查结果 |
| --- | --- | --- |
| 员工领域、个人页、进化、技能、记忆和员工包原语 | 已审查 | 已记录 Hermes、Letta、Mem0、LangMem、Agent Skills、OpenClaw、DSSE、Sigstore、in-toto、WAI-ARIA 与 React Spectrum；README、员工规范、ADR-0026 和记忆调研记录明确标注来源。 |
| Server 浏览器会话、Origin、实时投影、文件产物和进程停机 | 已审查 | 已记录 Hono/OWASP、RFC 7239、PostgreSQL 限速、Hono streaming、Node/Hono 停机、`write-file-atomic` 与 PNG 解码候选。登录限速现已跨重启共享状态，但仍只是经摘要化的网络滥用控制而非设备身份；完整 PNG 归一化仍是公开缺口。 |
| Node 协议、能力路由、存活、配置和启动身份 | 已审查 | 已记录 MCP/OCI conformance、`ws`、Kubernetes/Nomad、SPIFFE/SPIRE、Tailscale/Headscale、Kubernetes/Smallstep、Hono 限制、原子存储和严格 Zod 输入。单 Node 登记与吊销已完成；持有证明仍待实现。 |
| Provider SDK 与当前 Docker 浏览器适配器 | 已审查 | 已记录 CopilotKit/OpenBot `agent-computer`、Cua、MCP conformance、OCI 和平台声明等级；原生 Provider 只能按证据宣称。 |
| GitHub 贡献与 CI | 已审查 | 复用 Issue Form 和 RFC/KEP 证据结构；现有 checkout/setup Action 已固定到审查过的 commit，并关闭 checkout 凭证持久化。 |
| PostgreSQL store 与 migration 生命周期 | 已审查 | 已固定 Drizzle/Postgres.js/PostgreSQL 行为；journal 与数据库历史出现漂移时 fail closed，真实 PostgreSQL CI 覆盖首次并发 migration 和重复启动。 |
| PostgreSQL 与 Artifact 备份/恢复 | 部分 | 已选择原生 `pg_dump`/`pg_restore` 配合 Artifact 快照，并提供双语运维说明；定时、加密、保留、异地适配器和可重复完整恢复工具仍需专项上游审查。 |
| 多 Server 调度与事件分发 | 部分 | [周期提交调研](research/server-automations.md)完成有界单 Server 固定时长计划这一部分，覆盖事务领取和普通 Run 提交。多个 Server 副本共享调度及事件分发仍需审查；当前继续保持单进程边界。 |
| 办公室可视化插件 | 延期 | 只有公开产品图，没有找到可复用源码许可证，本版本不继续扩展。 |

## 已落实的审查结果

- 技能名采用 Agent Skills 兼容的“小写、连字符、最多 64 字符”子集，简介上限为 1,024 字符。
- 候选、已验证、暂停、撤销由 Server 明确管理，客户端不能直接创建已验证技能。
- 验证必须由已登录 Owner 明确审核，产生只追加进化事件，且不能修改工作主机能力、策略或授权。
- 并发创建和状态变更以冲突失败，不会静默覆盖审核。
- 当前证据快照有界，完整审核原因继续保存在不可变进化事件中。
- Owner 记忆写入有界、检查 revision、限制在单个员工内并产生无内容审计；凭据样文本和私钥复用
  现有导出扫描器，删除会移除正文，而 v1 员工包继续固定导出零条记忆。
- 员工预览继续执行校验和、严格 schema、只读和隔离规则。激活会重复检查、绑定人工审核过的摘要、
  要求单独接受未签名风险、生成新身份并保存不可变幂等收据。
- 技能来源属于员工赋值而不是共享技能定义，因此复用完全相同的定义时，导入赋值仍会明确显示为
  `imported`。
- Server 已有覆盖实际导入字节的 DSSE/Ed25519 签名验签链路，并增加实验性的加密文件密钥库、
  离线轮换/撤销、外部公钥显式信任、签名导出和验签后隔离预览。系统钥匙串、KMS、公开身份与
  信任分发仍是独立适配器。
- 员工导出文件名遵循 RFC 6266 的建议名称安全规则，并用精确固定、MIT 许可的
  `filename-reserved-regex` 4.0.1 判断 Windows 设备名。由于其发布包遗漏了声明的类型文件，项目
  同时精确固定 MIT 许可的 DefinitelyTyped 3.0.0 声明来恢复严格检查；现有 OpenBot ASCII slug
  和固定 JSON 后缀仍是权威格式。
- 协议 `0.9.0` 在每个 Run offer 中发送精确能力主版本；Server 与工作主机都会拒绝缺失或
  不兼容版本，旧能力别名不能静默降级契约。
- Provider 声明会在 Node 启动前检查；没有 `execute` 的包不会上报为可执行能力。
- Windows、macOS 和 Linux 具名路由场景明确区分模拟契约覆盖与真实设备支持，详见
  [Provider 一致性测试](PROVIDER_CONFORMANCE.zh-CN.md)。
- Provider 报告现在使用共享严格 schema 和确定性构建器，绑定明确目标；预期失败保持可见、会
  过期、仍不合规，并且报告不能自行授予支持或认证标签。
- 员工主页 Tab 已具备 WAI-ARIA 关系和横向键盘行为；创建、导入、导出弹窗使用原生模态、
  Escape 关闭、焦点限制和焦点返回，详见[无障碍基线](ACCESSIBILITY.zh-CN.md)。
- 浏览器会话现在会拒绝不安全的远程 Origin，复用 Hono 安全响应头，在 HTTPS 下使用 `__Host-`
  Cookie，并为每个 SSE 订阅设置有界队列与快照恢复。
- Node WebSocket 现在限制消息体和登记时间、关闭压缩、使用 ping/pong 判断存活并在 socket 错误时
  失败关闭；心跳不能再改写 Server 权威 Run 分配。
- 文件 Artifact 现在复用 `write-file-atomic` 完成 fsync、rename 和失败临时文件清理；POSIX 上的
  最终权限经测试保持为 `0600`。Windows 存储生命周期覆盖不从模拟权限位推断 ACL 保护。
- Node 协议 `0.9.0` 会拒绝未知消息字段、错误或超长身份信息、重复能力、无界审批证据、格式错误
  的登记凭证，以及远程明文 WebSocket 配置。
- Owner 可以为准确 Node id 创建短时单次令牌。真实 PostgreSQL 并发测试证明只有一次兑换成功；
  Server 只保存摘要、支持单节点吊销并断开已吊销在线 Node，Node 在建立 WebSocket 前原子保存凭证；
  如果之后出现 POSIX group/other 可读权限，Node 会拒绝继续加载。
- 仓库指令、功能调研模板、未来 ADR 检查和带测试的 PR 正文门禁，要求行为变化在合入前提供
  固定上游、许可证、复用选择、本地差集和源码引入证据。
- 现有 CI 中的 GitHub Action 已固定到完整 commit，checkout 不再保留仓库凭证。
- Server 停机现在会停止新调度、排空已接收的 Node 消息和进行中的 HTTP 请求、单独关闭已升级的
  Node socket，最后再关闭 PostgreSQL。空闲连接立即关闭，其余 HTTP 连接拥有经过测试的 10 秒宽限期。
- PostgreSQL 启动现在使用 Drizzle 要求的单连接 migration client 和稳定 advisory lock；仓库与
  数据库历史会在 migration 前后按精确前缀验证，CI 在 PostgreSQL 17 上测试首次并发启动。

## 尚未解决

- 当前技能记录只描述员工能力，尚未保存或执行符合开放规范的完整技能目录。
- 自动学习前必须增加提案过期/替代、通知和完整 diff 审核。
- 记忆检索、定时保留、自主写入提案、提示注入防护、版本恢复和选择性导出都必须先单独审查。
- 技能归档必须检查路径穿越、符号链接、解压大小、可执行内容、许可证、来源、签名和静态风险。
- 官方 `skills-ref` 需要 Python 3.11+，应在隔离检查 Worker 中运行，而不是放进权威 Server 进程。
- Provider 独立场景 runner 已实现；具体适配仍需专属隔离场景和可重复真实设备 CI，平台才可标记为
  Supported 或 Certified。
- `npm audit --omit=dev` 当前为零个生产依赖漏洞；完整审计在仅开发使用的
  Drizzle Studio，也不会采用 npm 建议的破坏性强制降级；只有兼容的上游修复版本通过审查后才升级。
- OpenBot 在宣称无障碍合规前，仍需真实屏幕阅读器、强制颜色、缩放/回流和自定义 Overlay
  证据。
- 登录限速现已规范化 IPv4/IPv6，只信任一个准确的单跳代理，并在 Server 进程与重启间共享原子
  PostgreSQL 状态。它仍是经摘要化的网络桶而非可信设备身份；代理网段/链和锁定通知仍未完成。
- Node 启动仍使用可复制 bearer credential，默认保存在 Owner-only 文件；Linux 登录会话的
  Secret Service 适配器已通过契约测试，但还没有真实设备证据。不可导出的持有证明密钥、
  Windows/macOS 密钥库、轮换、mTLS、防重放和持久化对账仍待完成。
- PNG Artifact 已限制大小并检查签名，但还没有解码归一化；未来解码器必须限制像素/通道并通过
  发布架构矩阵。当前本地 Artifact 根目录仍是管理员可信边界，不能与不可信写入者共享。

## Pull Request 必备信息

每个非简单功能 PR 都要链接调研记录或 ADR，并回答：评估了什么上游或标准；为什么选择依赖、
适配、fork 或本地差集；审查了哪个版本和许可证；是否复制/实质改编源码及其 NOTICE 在哪里；
当上游缺失、不兼容或被攻破时如何 fail closed。

## 已审核记忆参与原生任务

已完成复用审查：沿用 PostgreSQL、Owner 记忆生命周期和敏感文本扫描，仅增加默认关闭的模型使用开关、成功任务候选经验及事务审阅。Hermes Agent 的启发归属保留；未复制源码、未新增依赖，不宣称可执行技能或自主学习。 [Research](research/agent-reviewed-knowledge.md).

## OpenRouter 模型入口

复用已发布 @openrouter/ai-sdk-provider 3.0.0 / c1ce69ab（Apache-2.0），以固定端点、严格模型 ID、非推理元数据验证和明确路由策略适配现有循环。未复制源码，不宣称支持所有模型。 [Research](research/openrouter-model-entry.md).

## 第三方 MCP 工具插件

已审查 MCP 2025-11-25 与官方 @modelcontextprotocol/sdk 1.30.0 / `2d889f2b329e46680ec9bdd565de4616c497825a`（MIT）。复用 Streamable HTTP Client、JSON Schema 校验和示例 Server API，仅增加 Server 端点边界、加密安装状态、按 Bot 授权、声明摘要绑定与一次性 Owner 审批。未复制源码，不启动子进程、不加载渲染插件、不信任 annotation 自授权、不自动重放。见[调研](research/third-party-mcp-plugins.md)与[作者手册](PLUGINS.zh-CN.md)。

## Kimi 桌面模型

复用 @ai-sdk/moonshotai 3.0.45 / 8a09c78c039e2c092468eaeff97faaabf3b77366（Apache-2.0），固定国内接口，沿用加密的 Owner 配置；未复制上游源码。[研究](research/kimi-desktop-model.md)。

Desktop 服务预设复用现有 AI SDK 适配器与 Owner 设置，见 [Desktop 接入审查](research/desktop-model-presets.md)和[服务商 API 调查](research/model-service-presets.zh-CN.md)。没有复制上游源码。

Desktop 公开检索复用 ai 7.0.93 / `6359fd58fe68eaade096b5d923bac26de84ca3bd`、@ai-sdk/moonshotai 3.0.45 / `8a09c78c039e2c092468eaeff97faaabf3b77366`（Apache-2.0）、2026-09-08 审查的 Kimi Formula/Tavily 官方契约及现有 DNS 固定读取器。每任务最多四次联网调用，沿用原生 Run 权限、审计和截止时间。未复制上游源码，见[Desktop 联网工具调研](research/desktop-public-web-tools.zh-CN.md)。

频道呈现和插件管理复用 React 19.2.8、原生 HTML 控件与 OpenBot 身份。官方 Grok Bot 对照、界面边界和实际渲染检查见[频道呈现](research/channel-collaboration-presentation.zh-CN.md)和[插件界面](research/plugin-owner-interface.zh-CN.md)；未复制 xAI 图像或源码。

alpha.5 原生参考频道改造继续复用上述已锁定依赖与标准，没有复制专有源码、头像或私人对话。见[原生体验](research/channel-native-reference.md)、[路由与上下文](research/channel-context-routing.md)、[附件展示](research/channel-attachment-presentation.md)和[用户可见行为](CHANNEL_EXPERIENCE.zh-CN.md)。

原生异步协作继续使用 AI SDK 7.0.93 / `6359fd58fe68eaade096b5d923bac26de84ca3bd`（Apache-2.0）、PostgreSQL 17 锁和 Server 自有 RunEvent，没有复制上游源码。非阻塞汇总、鉴权追加指令与真实流适配见[异步协作研究](research/async-collaboration.md)。回应/移除成员复用 PostgreSQL 事务和 React 19.2.8 portal；Matrix v1.17 只作语义参考，不引入联邦依赖。请求限额隔离与气泡侧边可访问操作见[频道交互研究](research/channel-interactions.md)。

本机启动诊断复用 Node v22.22.2 的 `diagnostics_channel`（MIT），只在受信任的 Electron 主进程中传递。默认不记录日志、不向渲染器暴露原因；仅在有订阅者时收集有大小限制的原生命令错误输出。没有复制源码，见 [Windows 验证研究](research/windows-desktop-completion.md)。

Windows 数据库启动复用 PostgreSQL REL_17_11 的 `pg_ctl` 受限令牌机制及 PID 文件/状态契约。薄适配层在清理或停止前核对集群、端口、PID 与启动身份，没有自行实现令牌 API 或复制上游代码，见 [研究](research/windows-desktop-completion.md)。

Windows 桌面版冷启动符合性复用 Electron 44.2.0 `safeStorage`（DPAPI）、`utilityProcess`、既有 `NativeServerController`、Node `process.kill(pid, 0)` 存活探测、PostgreSQL `postmaster.pid`，以及收件箱 PowerShell/`Start-Process` 安装门禁。在一次 bootstrap 生命周期（含一次同进程保留重启，以免削弱历史断言）之后，门禁对自建临时 harness 目录再执行 **十次彼此独立的 Electron 进程** 启动→退出循环。无新依赖、无产品运行时改动；见[研究](research/windows-cold-start-conformance.zh-CN.md)。

## 产品修复适配（2026-09-11）

- Desktop 异步凭据访问和显式发行平台选择复用 Electron 44.2.0 与现有打包适配器：[研究](research/product-repair-startup.md)。
- Bot v2 技能正文分享复用 Agent Skills 和已有摘要审核导入：[研究](research/portable-bot-skills.md)。
- 独立插件生成器复制现有 MIT 示例并固定 MCP SDK 1.30.0：[研究](research/plugin-platform-completion.md)。

Desktop 搜索账号选择复用 Electron 44.2.0 的显式子进程环境映射，没有新增依赖或复制上游代码：
[研究](research/desktop-explicit-search-key.zh-CN.md)。

- Node 环境凭证显式启用复用 Zod 4.5.4 跨字段校验及现有凭据存储，不新增依赖或复制源码。[研究记录](research/node-environment-credential-opt-in.zh-CN.md)。
- 原生 Bot 正文下载在既有 Electron 44.2.0 沙箱桥接中保留审核绑定的可选布尔值：[研究](research/native-bot-export-bridge.zh-CN.md)。不新增依赖或复制源码，保留固定 IPC、摘要和原生路径检查。

H2 v1 补充选定 RFC 8785 JCS 与 `canonicalize@5.0.0` / `7d97c70c79c9f52070e6c24c38a92f0dd9b32a57`（Apache-2.0，无运行时依赖），前置严格有界输入校验。已审源码与 86 项上游测试支持序列化器选型，不代表已有运行时租约。精确类型、指纹向量与连接绑定消费语义见[研究补充](research/capability-lease-protocol.zh-CN.md)。未复制源码、未安装依赖。

## Dependabot 补丁固定版本（2026-09-11）

精确固定的补丁合并（Dependabot #24、#25、#26、#28；排除 Vitest 5 #27）：

| 包 | 固定版本 | 许可证 | 作用 |
| --- | --- | --- | --- |
| hono | [`4.13.7` / `eebdf7be`](https://github.com/honojs/hono/tree/eebdf7be39abf0a872671835ccce0c4f03ea497a) | MIT | Server HTTP；含 `hono/jsx` XSS 修复 GHSA-hxh3-vqpv-xpqv |
| @biomejs/biome | `2.5.12` | MIT OR Apache-2.0 | 仅根目录 lint/format 开发依赖 |
| @types/react-dom | `19.2.7` | MIT（DefinitelyTyped） | Web/Desktop 类型；运行时 `react-dom` 仍为 `19.2.8` |
| filename-reserved-regex | [`4.0.1` / `d267eb9`](https://github.com/sindresorhus/filename-reserved-regex/tree/d267eb977513e8137062ecca53a15fd78d5b6c92) | MIT | 员工导出文件名的 Windows 保留名判断 |

未复制上游源码。证据见[补丁调研](research/deps-patch-hono-biome-types-filename.md)。
| PDF/Office 解析器依赖一致性 | PDF.js 6.3.289 / `1c8020a7d4e43668ac287a3ecf9a8dbea17e4c56`；现有 officeparser 7.8.0、npm 10.9.9 | Apache-2.0；MIT；Artistic-2.0 | 同步直接依赖和全局精确 override，保留工作区解析锚点及有界 Worker。干净安装和真实 PDF/Office 测试为门禁；保留上游印度文字形提取限制。不复制源码。见[研究](research/pdfjs-6.3-lock-coherence.zh-CN.md)。 |
| 9 月 12 日依赖维护 | setup-dotnet 6.0.0 / a98b5685；@types/node 26.5.0；Node 24.21.0 官方镜像；electron-builder 26.16.1 / 7d3b30f3 | MIT；Node 及 Debian 组件许可 | 复用既有上游，同步固定版本、锁文件和严格 smoke 断言；不取消安全门禁，不复制源码，不宣称已正式签名。见[研究](research/dependency-ci-september12.zh-CN.md)。 |

### 附件空文本提取

复用审查完成：PDF.js 6.3.289（`1c8020a7d4e43668ac287a3ecf9a8dbea17e4c56`，Apache-2.0）与
Tesseract.js 7.0.0（`42eae669e4b3a66429d8516f078912cc747a89df`，Apache-2.0）。
Server 在保存成功状态前拒绝仅含空白的提取结果，并在模型调用前拒绝历史空文本记录。
未新增 PDF OCR，也不会自动改为发送原文件。没有复制上游源码，见[研究记录](research/attachment-empty-extraction.md)。

### 附件空提取失败与保存原件的中文文案

复用既有精确键展示映射（`nativeRunFailure`）与 Electron 44.2.0 `showSaveDialog` 的
title/buttonLabel/message（`aa650d74597c652878629df0038a50485e156a09`，MIT）。
仅把 Server 两条空提取英文句子映射为中文；未知、带前缀或相邻失败保持原文，避免被说成扫描件。
原件保存对话框与报告/图片/员工对话框一致使用中文。拒绝为两句文案引入 i18next 26.4.2
（`4dba50f20669c3678db0812255716eb7693ad2da`，MIT）。Server 错误语义、原文件保留、取消/重试、
解析器、OCR 与权限不变。未复制源码，见[研究](research/zh-attachment-copy.zh-CN.md)。

Windows 回执集成复用 PowerShell/.NET System.Text.Json 与现有有界 Node/WinPS 进程观察器，保留原始时间戳精度并等待真正的 NSIS 卸载进程；不新增依赖、不复制上游源码。见[研究](research/windows-receipt-orchestrator-identity.zh-CN.md)。

### Web Vite serve CSP nonce

复用 Vite **8.2.2** / `de1111ab0be00879b404e7ed3b2a80e264edddc1`（MIT）的 `html.cspNonce`，使本地
`vite` serve 可为 script/style 与 `csp-nonce` meta 盖章，而无需 `'unsafe-inline'`。
仅 serve 的薄适配等待完整 Vite HTML 流水线后，为每份主文档填入新的 192 位加密随机 nonce，
并将匹配的 CSP 放到注入脚本之前。已验证真实 HTTP 并发/重验与 Chromium CSS/React HMR；
生产和 Desktop 产物保留严格源码策略。保留 Grok PR #62 的初始 Vite API 复用，撤销固定 nonce
结论。无新依赖、未复制上游源码，见[研究](research/web-dev-csp-nonce.zh-CN.md)。

频道成员布局复用原生控件、CSS Flexbox Level 1（2025-10-14 CRD）与 React 19.2.8 的稳定身份。
成员样式归到组件自身，在行容器变化后仍保留头像、有界身份文字、独立移除操作及键盘焦点。
没有新增依赖或复制源码，见[研究](research/channel-member-layout.zh-CN.md)。

原生任务错误分类参考 RFC 9457 的机器类型/人类说明分离原则及 Node.js v22.22.2（2645dc73）
公开错误码约定，沿用现有 Error/Run 目录。无新 HTTP 错误格式、依赖或源码复制，见
[分类复核](research/native-failure-classification.zh-CN.md)。

## React 运行时版本一致性（2026-09-15）

React 与 React DOM 共同采用官方 19.3.0 / `1d34f91dfde6bba84d08b683aaba164c7194dacb`（MIT），类型声明为 `@types/react` 19.3.0 与兼容的现有 `@types/react-dom` 19.2.7。上文 19.2.8 条目保留原始审查背景。通过官方 Dependabot 窄范围组共同提出运行时和声明更新；上游精确版本保护、现有交互测试和生产审计继续有效。未复制上游源码或引入本地渲染器。参见[研究记录](research/react-19.3-version-coherence.zh-CN.md)。

## Vite 8.3 依赖一致性

继续复用 Vite 8.3.0 / `434e8e9495436a60789f2b588a04a6a24a3d1661`（MIT），让 Web 配置
与 React 插件解析同一版本。保留严格类型与既有 CSP 检查；未复制源码或增加依赖。
详见[研究](research/vite-8.3-lock-coherence.zh-CN.md)。

## 依赖审查流程与 9 月 15 日运行时更新

采用官方 Dependabot v2 的零上限配置暂停普通自动版本提议，安全更新仍可提出并须遵守相同
研究和 CI 要求。见[流程决定](research/dependency-update-intake.zh-CN.md)，不增加本地更新服务或机器人豁免。

Electron 44.3.0 / `07e460719c75b2ec5ee4893f7d2192ef31c7b8c2`（MIT）保留既有 Desktop 边界
与打包适配器，见[研究](research/electron-44.3-ci-review.zh-CN.md)。Anthropic 4.0.53 与 Moonshot
3.0.49 / `9ed46d2da5df1394079c66d422bc553fd0c34376`（Apache-2.0）保留受控原生 Provider
适配器，见[SDK 研究](research/ai-sdk-patches-september15.zh-CN.md)。未复制上游源码或新增权限。
较早版本条目保留历史审查上下文，当前选择以锁文件和本次补充记录为准。

React DOM 类型 19.3.0 / DefinitelyTyped `de5e8f01d01a14ae4ae502283d3d09f042f1ad89`
及 Zod 4.6.2 / `e359f7378fe56d695134701cda1e9055a08892dc`（均为 MIT）保留已有渲染和校验契约。
未复制源码，见[研究](research/dependency-types-zod-september15.zh-CN.md)。

## Python 驱动循环的 Server 执行门槛（2026-09-23）

复用 ai 7.0.93 / `6359fd58fe68eaade096b5d923bac26de84ca3bd`（Apache-2.0）的
`generateText`、Schema 校验与单步执行。通过窄范围 Server 适配器保留已绑定工具的执行、权限、
预算、持久用量与审计以及最终提交责任。未复制源码或新增依赖。这尚未实现 Python 通信或切换
生产运行时；见[研究](research/python-runtime-host.md)与[运行时说明](NATIVE_AGENT.zh-CN.md)。

进程适配协议另复用 `@modelcontextprotocol/sdk` 1.30.0 /
`2d889f2b329e46680ec9bdd565de4616c497825a`（MIT）的换行编解码工具及 Node POSIX
子进程接口。窄范围监督器补齐环境、进程组清理与 Server 操作策略，不把完整 MCP 客户端
当作运行时授权协议。实现与集成仍待完成；见[通信研究](research/python-runtime-transport.md)。

## 可选 Python Server 打包（2026-09-23）

复用官方 Python 3.12.13 slim-bookworm，源提交
3362634339580d3232e65a66dd5a36c47ae7ff14（镜像源码 MIT、解释器 PSF、Debian 组件各自许可），
镜像索引 sha256:4766d8b510c428e595d74b9cc5bbb2fae8e26316fffb4adc89908d79aacd58a2，
以及现有 Node 24.21.0、Docker 多阶段目标和 Python venv/metadata 契约。
可选镜像仅保留既有固定版本的运行依赖，在数据库启动前检查完整安装配置。
不增加依赖、不复制源码、不改变权限。见[打包研究](research/python-server-container.zh-CN.md)。

## 源码迁移历史预检（2026-09-23）

复用已安装 Git 2.54.0 的树/对象读取、Node SHA-256 和 c33e03f 的迁移清单验证器，比较已提交源码，
不读取数据库或工作区文件。保留 Drizzle 0.45.2 的 SQL 原文哈希和现有启动历史校验。无新依赖或上游源码复制；
见[研究记录](research/migration-lineage-audit.md)。这是源码历史兼容检查，不是数据迁移证明或修复程序。
