# 功能调研记录

[English source](README.md) · [简体中文](README.zh-CN.md)

按[根触发规则](../../AGENTS.zh-CN.md#实现前调研)：新依赖/版本、公共协议、授权/安全或持久数据
边界及重大架构选择需要针对性证据。普通修复/接线在 PR/交接引用有效决定、固定版本、不变假设与
受影响测试，不新建报告；只补本次相关缺项，不重复全量调查。

只有触发新增/重开决定，且现有 Issue/ADR 不更合适时才用[模板](TEMPLATE.zh-CN.md)。围绕一条
可观察路径，按适配、许可和总交付/维护成本比较可行且维护中的选择，固定实际审查版本/commit。
可在已有记录补变化假设；边界变化仍要针对性审查。等价持久证据可放 Issue，长期契约/架构用 ADR。
没有候选满足需求时记录实际查询、候选和精确缺口，不能省略归因/许可。
[PR 检查](../../CONTRIBUTING.zh-CN.md#研究依据与文档豁免)仅在依赖、协议、安全或持久化变化时要求记录链接和来源行。

已接受记录包括 [Owner 管理员工记忆](owner-managed-employee-memory.md)：明确将进化/记忆方向
归因于 Hermes，并在选择 OpenBot 现有 PostgreSQL 边界前比较 Letta、Mem0 与 LangMem。
另见[员工档案实时失效通知](employee-profile-realtime-invalidation.md)：它复用现有 Hono SSE，
同时让档案正文继续只通过鉴权 REST 获取。
随后，[Owner 技能审核界面](owner-skill-review-surface.md)把已有的权威技能生命周期映射成可检查
的档案流程，但不会安装可执行代码。[员工进化档案](employee-evolution-archive.md)明确注明 Hermes
的启发来源，并把其真实日期旅程交互适配到 OpenBot 仅追加的 Server 记录。
[Owner 管理员工主页详情](owner-employee-profile-details.md)审查继续复用现有 revision 变化路径及
Hermes/Kubernetes 的冲突语义，只开放说明性字段。
[可迁移员工资料审核](portable-employee-profile-review.md)继续补齐传输安全：接收方会在激活前，
从现有摘要绑定的隔离预览中看清员工简介。
[可迁移员工技能披露](portable-employee-skill-disclosure.md)随后采用 Agent Skills 与 OpenClaw 的
审核边界，在所有导入技能仍被禁用时显示技能说明与依赖。
[员工导出内容预览](employee-export-content-preview.md)补齐发送方边界：下载前先看清将要离开
Server 的完整说明性资料和所选技能元数据。
[可迁移员工技能依赖闭包](portable-employee-skill-dependency-closure.md)随后阻止模板静默丢弃
不在已验证导出集合中的依赖。
[员工导出审核绑定](employee-export-review-binding.md)最后采用 HTTP 强校验器，让下载只能返回
Owner 刚刚检查过的同一份包实例。
[跨平台员工导出文件名](cross-platform-employee-export-filenames.md)审查随后采用 RFC 6266 和一个
聚焦、持续维护的设备名判断器，确保建议下载名在 Windows、macOS 与 Linux 上安全可用。
[POSIX Node 凭证权限](posix-node-credential-permissions.md)审查随后把 OpenSSH 的私钥 fail-closed
规则用于现有原子文件适配器，同时明确 Windows ACL 与系统密钥库不在当前声明范围内。
[Artifact 读取完整性](artifact-read-integrity.md)审查把 OCI descriptor 校验用于已有大小和
SHA-256 元数据，使被替换的截图字节在返回前失败。
拟议的[跨平台 Node CI 基线](cross-platform-node-ci.md)记录明确的托管 runner 系列和证据边界，
作为引入 Windows/macOS/Linux 测试矩阵前的依据。
已接受的 [Provider 一致性场景 runner](provider-conformance-runner.md)随后比较 MCP、OCI、
Sonobuoy 与现有 Vitest/Provider SDK 边界，确认只在权威 Server 进程之外补充有界编排。
已接受的 [Linux Worker Host 服务与 Secret Service](linux-worker-host-service-and-secret-service.md)
审查把无人值守系统服务凭证与登录会话 Secret Service 分开，并选择不会静默切换后端的有界
`secret-tool` 适配器。
已接受的 [Linux Worker Host 可验证压缩包](linux-worker-host-archive.md)审查随后在增加安装脚本前，
固定应用打包器、官方 Node 运行时哈希、生产 SBOM、确定性清单、校验和与授权发布来源证明边界。
已接受的 [Linux Worker Host 可恢复安装事务](linux-worker-host-install-transaction.md)审查现在会在
开放高权限安装器前，固定版本化目录、来源证明门禁、原子启用、健康检查回滚、凭证隔离与崩溃恢复
证据。
已接受的 [Linux Worker Host 高权限引导边界](linux-worker-host-privileged-bootstrap.md)随后采用私有
压缩包导入与一把失败关闭的共享 lease，防止用户可写路径替换把已证明字节与最终解压、启用的字节
分离。
已接受的 [Windows Worker Host 服务边界](windows-worker-host-service.md)接着选择第一方 .NET Service
生命周期，而不是通用 WinSW 或 `node-windows` 包装器；LocalService 身份、固定子进程监管和原生
x64 证据仍是必须通过的失败关闭门槛。
本地已实现的 [Windows Worker Host 构建门槛](windows-worker-host-build-lane.md)会围绕实验性主机
源码固定第一方 setup action、精确 .NET 10 SDK、锁定的 NuGet 恢复、明确的 Windows x64 runner，
以及不上传产物的输出形态检查。任何支持声明前，仍必须完成托管与原生 Windows 执行。
已接受平台契约的 [Windows Worker Host 安装器](windows-worker-host-installer.md)调研随后选择
Windows Installer 5.0 标准事务，并禁止凭证、下载、自定义动作、可变路径或登记前自动启动。WiX v7
在技术上可行，但 Owner 明确决定其 OSMF EULA 和可能的费用义务前不会使用。
已接受的 [macOS Worker Host launchd 边界](macos-worker-host-launchd.md)选择 macOS 13+、由专用
标准用户批准的 `SMAppService` LaunchAgent。后续
[macOS Worker Host 配置与 Keychain](macos-worker-host-config-and-keychain.md)审查选择直接使用
Apple Security 与现有 Node core/Zod，并用私有凭证管道和有界固定子进程监管取代立即 `exec`。
随后接受的 [macOS 注册与安装包](macos-worker-host-package-and-registration.md)审查让登记保持在
专用用户权限内，将身份绑定到精确 Server，并选择带失败关闭 Developer ID/公证门槛的纯应用 Apple
安装包。TCC 与真实设备证据仍是独立门槛。

已接受的 [Desktop 应用基础](desktop-application-foundation.md)调研选择 Electron 与直接使用的稳定版
Packager/Fuses 适配器，交付同一个可安装的 TypeScript/React/Vite Client，同时保留完整 Web Client、
Server 唯一权威，并把 Swift 与 C# 限制在很薄的平台适配器内。实现验证发现稳定版 Forge 7 存在
Fuses 不兼容和未解决的开发依赖漏洞，因此不采用；签名、更新和真实设备支持仍是后续门槛。
[Desktop 本地内容协议](desktop-local-content-protocol.md)后续审查采用 Electron 的自定义协议
建议，通过专用 Session 和精确安装包资源白名单加载界面；`file://` 额外权限保持关闭，并在读取
文件前拒绝路径穿越。
已经实现的 [Desktop Server 连接](desktop-server-connection.md)审查随后让本地 Client 保持同源，
并通过有界主进程适配器使用 Electron 专用 Session 连接唯一已验证 Server。它只保存经确认的公开
origin，让 HttpOnly Cookie 留在 preload 之外，拒绝不透明 origin、重定向、过大请求体和远程可执行
UI，并在 ASAR 打包后校验精确运行时依赖闭包。
已接受的 [Desktop 安装意图](desktop-setup-plan.md)审查接着使用现有 React、原生表单语义、类型化
Electron IPC 和受限原子 JSON 持久化表达四种产品组合及有上限的计划 Worker 数量。它不增加状态机
或表单依赖，并把计划与安装、登记、授权、服务状态和支持声明严格区分。
已接受的 [Desktop 引导 macOS Worker 配置](desktop-macos-worker-onboarding.md)审查随后把已经审查的
Swift Worker Host 复用为一个独立签名的 Desktop 内嵌 companion。Desktop 只在已经鉴权的 main
process 申请短期 token，通过一条有界私有 stdin 请求传递，并投影真实原生登记状态；renderer 不会
获得 token、进程桥或可能漂移的成功标记。

[Server Windows 机密 ACL](server-windows-secret-acl.zh-CN.md) 将 Node Owner+SYSTEM 辅助逻辑抽取为 `@openbot/windows-secret-acl`，供 model-settings 与 plugin-store 复用（DEV-005 / N2）。
[Windows 原生 ACL 测试超时预算](windows-native-acl-test-budget.zh-CN.md) 随后按调用次数为托管原生套件给出有界截止时间（Server ≤9 次 PowerShell × 15s + 余量 → 180s；Node 凭据原生否定 ≤7 × 15s + 余量 → 120s），并镜像生产 `broadenAcl` 启动卫生，不 mock ACL，也不改生产 spawn 超时。
