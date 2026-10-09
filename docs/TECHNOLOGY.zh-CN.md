# 技术基线

[English](TECHNOLOGY.md) · [简体中文](TECHNOLOGY.zh-CN.md)

审查日期为 2026-09-28，对照本检出中的 lockfile 与清单。精确版本是本次审查快照；升级必须通过
单独、经过测试的依赖变更，不能静默浮动。关于现行布局与本地搭建，优先阅读
[仓库地图](REPOSITORY_MAP.zh-CN.md)、[贡献指南](../CONTRIBUTING.zh-CN.md) 以及各入口 README，
而不要在本文件中重复容易过期的安装或平台状态。

## 一句话决定

OpenBot 以 Python 实现产品 Server 控制面与有界 Agent harness，以 TypeScript 实现 Web、Electron
Desktop 外壳、保留的 Node 辅助逻辑，以 React 与 Vite 共享界面，以
PostgreSQL 保存权威状态，并且只在操作系统确实需要时使用很薄的 Swift 或 C# 适配器。

## 当前技术栈与历史决定

| 关注点 | 当前产品默认 | 说明 |
| --- | --- | --- |
| 业务 Server | `apps/server-python` 中的 Python（FastAPI/Starlette/Uvicorn） | `apps/server` 已退役；见其 README。 |
| Agent 执行 harness | Python 包 `packages/harness`（`openbot-agent-runtime`） | 提出工作；控制面保留权威与持久事实。 |
| 共享 UI | `apps/web` 中的 TypeScript、React、Vite | 同时作为 Desktop renderer。 |
| Desktop 外壳 | Electron main/preload，围绕共享 Web UI | 在受支持的 Desktop 路径上监督 Python 产品载荷。 |
| 保留的 Node 面 | Node Worker Host、Providers、协议辅助与工具链 | 不是第二个业务 Server。 |
| 冻结的 TypeScript Server | `tests/oracles/legacy-server` | 仅作比较输入；绝不是产品回退。 |
| 持久化 | PostgreSQL，迁移位于 `packages/db` | 持久状态权威不变。 |
| 可选持久 Work 引擎 | 显式配置时的 Temporal 组合 | 普通 API 启动不会创建该引擎。 |

历史 Desktop 基础 ADR 与调研仍是那些决定的记录；它们并不表示 Node/Hono Server 仍是现行控制面。
长期保留向 TypeScript
收敛的方向，先完成有实际收益的外围替换。核心替换需要单独经过验证的切换；本轮清理不迁移
Python Server 或 harness 核心。

## 产品入口

| 入口 | 用户安装或打开的内容 | 角色 |
| --- | --- | --- |
| OpenBot Desktop | 在 Windows、macOS 或 Linux 上安装各平台对应的软件包，但使用同一个 OpenBot 产品 | 始终是 Client；在受支持的前提下也可以把这台电脑配置成 Server、Worker Host 或同时承担两者 |
| OpenBot Web | Server 托管的响应式 Web 应用 | 完整的远程 Client，也是没有安装 Desktop 的模块化自部署用户的主要 Client |
| OpenBot Server | 由 Desktop 引导安装，或由用户独立部署的服务 | 身份、频道、路由、策略、审批、审计和持久状态的唯一权威 |
| OpenBot Worker Host | 由 Desktop 引导安装，或由用户独立部署的服务 | 向 Server 提供已经声明的电脑能力；永远不会成为第二个权威 |
| Agent 适配器 | 由 Server 管理的 OpenBot、Hermes、Pi、OpenClaw 或未来 Agent 连接 | 执行有界委派任务；不能自行取得频道、电脑、凭证或审批 |
| 插件 | Server 管理且经过明确授权的 MCP 连接 | 当前工具、资源、提示词和隔离 App 遵循[插件契约](PLUGINS.zh-CN.md)；未来扩展方向不表示已经实现 |

Desktop 首次引导仍提供同一产品的四种组合（仅 Client；Client 加 Worker Host；Client 加 Server 且
Worker Host 可选；高级自部署）。清单上限、Server origin 确认以及原生 Worker 登记细节写在现行
Desktop 文档中，而不是本基线：从 [Desktop 贡献者规则](../apps/desktop/AGENTS.md)、
[Desktop 安装](DESKTOP_INSTALLATION.zh-CN.md) 与 [Desktop 引导](DESKTOP_ONBOARDING.zh-CN.md)
开始。

## 选择的语言与运行时

下表版本对本检出有效；若某入口 README 声明更窄的已证明发布运行时，以该声明为准。

| 边界 | 选择 | 原因 |
| --- | --- | --- |
| 产品 Server / 控制面 | Python `>=3.12`，FastAPI `0.141.1`、Starlette `1.6.0`、Uvicorn `0.53.0`（`apps/server-python`） | 现行受信任业务控制层；Owner 身份、路由、策略、审批、审计与产品 HTTP。 |
| 有界 Agent harness | Python `>=3.12` 包 `openbot-agent-runtime` `0.1.0`（`packages/harness`） | 既有有界执行循环与可选 Temporal 组合；权威留在控制面。 |
| 共享领域、协议、Web、Desktop、Node 辅助面与工具链 | TypeScript `7.0.2` | UI、Electron、保留的 Node 协议与仓库工具链的有类型贡献路径。 |
| 独立 JavaScript 开发运行时 | Node.js `24.20.0`（`.nvmrc` 固定；根 `engines` 仍允许已证明的 `^22.22.2` 线） | 当前仓库开发基线。已证明的 Worker Host 发布运行时只能通过单独的发布迁移升级，并附带哈希、SBOM 与回滚证据。 |
| Desktop 外壳 | Electron `44.3.0` | 复用 Web 技术栈，并在不同桌面系统上交付同一套经过测试的 Chromium/Node 基线。 |
| Desktop 打包与加固 | `@electron/packager` `20.3.0` 与 `@electron/fuses` `2.1.3` | 提供窄打包/ASAR 与严格 fuse API，同时避开 Forge 7 不兼容的开发依赖图。安装器、签名和发布仍使用后续单独审查的发布适配器。 |
| Desktop Server 传输与配置 | Electron `44.3.0` 自定义协议、专用 `Session.fetch`、类型化 IPC、`write-file-atomic` `8.0.0`，以及只在构建时验证清单的 `@electron/asar` `4.3.0` | 安装包 renderer 保持同源；main process 只连接一个已经验证的 Server。归档只携带经过审查的精确运行时依赖闭包。 |
| 共享 UI | React `19.3.0` 与 Vite `8.3.0` | 已在 `apps/web` 中锁定、构建并通过测试，供 Web 与 Desktop renderer 使用。 |
| 权威数据 | PostgreSQL 17 | migration、条件状态变更、调度、审批和审计需要唯一事务真相源。 |
| macOS 专属服务接入 | Swift | 只用于 Keychain、Service Management、与签名绑定的注册和其他 Apple 专属契约。 |
| Windows 专属服务接入 | .NET 上的 C# | 只用于 SCM、Credential Manager、Job Object、安装器接入和其他 Windows 专属契约。 |
| 外部 Agent 内部实现 | 保留上游语言 | Hermes 可以继续使用 Python，其他 Agent 也可以使用 Rust、Go 或 TypeScript；OpenBot 通过有类型的进程或网络适配器接入。 |

Rust 与 Go 不是 OpenBot 产品核心语言。Python 是 Server 与 harness 的核心。TypeScript 仍是 Web、
Desktop 与保留 Node 辅助面的核心。只有调研证明某个持续维护的上游方案比现有技术栈更好地解决了
明确缺口，未来依赖才能引入其他语言。

已退役的 Node/Hono Server 实现细节保留在冻结 oracle 与历史调研中；不要把它当作现行 Server HTTP
运行时。

## Desktop 安全契约

Desktop 是受信任的本地 Client，不是新的权威：

- 它只加载安装包内的 renderer 资源，不从 Server 加载可执行 UI 代码；
- 所有 renderer 都启用 `nodeIntegration: false`、`contextIsolation: true` 和 `sandbox: true`；
- preload 只暴露小型、有类型的操作，不暴露原始 `ipcRenderer`、文件系统、Shell、进程、环境变量
  或不受限制的网络能力；
- main process 会检查每个 IPC 请求的发送者、schema、大小、状态和权限；
- 导航、新窗口、权限、下载和打开外部 URL 默认拒绝；
- 严格的 Content Security Policy 让 renderer 只能连接安装包应用 origin；main process 另行强制
  执行唯一已经声明的 Server 连接；
- 即使 Desktop 启动了本地 Server、Worker Host、外部 Agent 或插件进程，它们的动作仍然必须通过
  Server 策略和审批；
- 密钥只保存在平台密钥库或独立服务边界，不进入 renderer 状态或浏览器 local storage；
- 本机 Worker 配置会在签发 token 前检查真实原生状态，不保存可能漂移的 `enabled` 标记；只有
  `SMAppService` 实际返回 enabled，macOS 批准步骤才算完成；
- 发布打包会关闭未使用的 Electron fuse、校验 ASAR 完整性，并在签名后发布；
- 未签名的本地构建只能作为开发证据，不能称为可分发版本。

Agent 使用的不可信网页运行在 Worker Provider 边界内，绝不会放进有权限的 OpenBot Desktop
窗口中渲染。

## “当下最好用”的判断方式

“最好”指满足 OpenBot 兼容性、安全性、维护状态、贡献者体验和证据要求的最新稳定版或 LTS，
不代表自动使用预发布版本，也不代表软件包发布当天就无测试升级。

- 至少每月一次，并在每次 Desktop 发布前检查 Node.js LTS 与仍受支持的 Electron 主版本。
- Electron 受支持版本的安全补丁走加速但仍经过测试的 Pull Request。
- 当前 Electron 主版本成为最老受支持版本前，必须完成下一主版本审查。
- lockfile 中的依赖保持精确；发布构建不能解析浮动版本。
- 每次运行时变更后重新执行打包、IPC 负向、更新、回滚和真实设备检查。
- 只有安装包大小、内存、无障碍、安全维护或平台行为经过测量仍无法达到已接受要求时，才重新
  比较 Desktop 外壳。
- Python Server 与 harness 的固定版本升级同样要求聚焦 PR、lockfile 证据和既有控制面/harness
  检查，不能静默浮动。

## 对贡献者的影响

大部分贡献者需要 `.nvmrc` 固定的 Node.js、npm，以及 Server/harness 工作所需的 Python 3.12+。
请遵循 [贡献指南](../CONTRIBUTING.zh-CN.md)、
[apps/server-python/README.md](../apps/server-python/README.md) 与
[packages/harness/README.md](../packages/harness/README.md)。Desktop 贡献者还需要对应平台的打包
工具链；见 [Desktop 贡献者规则](../apps/desktop/AGENTS.md)。Swift 只用于 macOS 适配器，.NET 只
用于 Windows 适配器。开发外部 Agent 适配器不要求贡献者把 Agent 重写成 TypeScript。

长期 Desktop 基础决定与候选证据仍见 [ADR-0041](decisions/0041-desktop-application-foundation.md)
和 [Desktop 基础调研](research/desktop-application-foundation.md)。已经实现的 Server 连接边界见
[ADR-0042](decisions/0042-desktop-server-connection.md)及其
[调研证据](research/desktop-server-connection.md)。四模式安装意图及其无副作用边界见
[ADR-0043](decisions/0043-desktop-setup-intent.md)和
[安装计划调研](research/desktop-setup-plan.md)。产生真实操作的 macOS 后续见
[ADR-0044](decisions/0044-desktop-macos-worker-onboarding.md)和
[Desktop 引导 Worker 调研](research/desktop-macos-worker-onboarding.md)。
