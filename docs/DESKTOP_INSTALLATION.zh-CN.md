# Desktop 下载与安装

[English](DESKTOP_INSTALLATION.md) · [简体中文](DESKTOP_INSTALLATION.zh-CN.md)

**当前预览版：[Desktop 0.1.0-alpha.9](https://github.com/yxflc11/openbot/releases/tag/desktop-v0.1.0-alpha.9)**，提供 macOS Apple Silicon DMG 与 Windows x64 EXE，随附合并清单和 SHA256SUMS。两者来自同一已通过完整 CI 的源码提交。下表也列出流水线支持的 Linux 构建目标；alpha.9 未发布 Linux 安装器。

alpha.9 恢复频道成员菜单的姓名、头像与操作，保证插件权限编辑始终对应所选 Bot，并将任务状态或资源变化与真实频道权限丢失分开提示。中文界面的空白 PDF 提取失败和原始附件保存对话框也改为中文。升级流程保留已有工作区数据和模型配置。

[固定版本发行页](https://github.com/yxflc11/openbot/releases/tag/desktop-v0.1.0-alpha.9)记录源码提交和已通过的 main CI；随附的 [desktop-manifest.json](https://github.com/yxflc11/openbot/releases/download/desktop-v0.1.0-alpha.9/desktop-manifest.json)记录准确源码、所含平台和安装器摘要。请使用 [SHA256SUMS](https://github.com/yxflc11/openbot/releases/download/desktop-v0.1.0-alpha.9/SHA256SUMS)核对下载文件。Windows 安装与数据保留证据来自托管运行器，见[发行源码冷启动证据](WINDOWS_DESKTOP.zh-CN.md#发行源码冷启动证据)。正式签名、公证和用户 Windows 真机界面验收仍未完成。

| 平台 | Release 中的文件 | 安装方法 | 实际组合能力 |
| --- | --- | --- | --- |
| macOS Apple Silicon | `openbot-desktop-<version>-darwin-arm64.dmg` | 打开磁盘映像，将 OpenBot 拖入 Applications | 客户端、内置 Server/PostgreSQL、可选随包 Worker companion |
| Windows x64 | `openbot-desktop-<version>-win32-x64.exe` | 打开安装器，安装到当前用户并创建开始菜单入口 | 内置本地 Server/PostgreSQL，或连接已有 Server |
| Linux x64 | `openbot-desktop-<version>-linux-x64.deb` | 使用发行版的软件包管理器安装 | 连接已有 Server 的客户端 |
| Linux x64 便携版 | `openbot-desktop-<version>-linux-x64.AppImage` | 添加可执行权限后运行；仍需系统 AppImage 依赖 | 连接已有 Server 的客户端 |

首批安装器是**未签名开发构建**，不会绕过 Gatekeeper、SmartScreen、Linux 沙箱要求或组织安装
策略。构建成功不等于完成签名、公证或真实设备安装验证。目前没有自动更新器。普通卸载保留应用
数据；手动升级前请备份。macOS Intel、Windows/Linux ARM 不在此矩阵内。

## 命令安装入口

选定版本公开发布后，仓库脚本会下载该版本对应的平台文件，先核对 `SHA256SUMS` 再安装。
校验值证明文件与该 Release 一致，不能替代发布者签名。可按环境要求先阅读脚本。两份脚本只访问
固定 OpenBot GitHub 仓库，保留操作系统信任检查，不会启用模型推理或登记 Worker。

macOS arm64（Linux 请改用包含 AppImage 的已发布版本）：

```bash
curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/yxflc11/openbot/main/scripts/install-desktop.sh \
  -o /tmp/openbot-install-desktop.sh
bash /tmp/openbot-install-desktop.sh 0.1.0-alpha.9
```

macOS 安装到 `~/Applications/OpenBot.app`，拒绝覆盖已有应用；需要升级时使用 DMG 审查操作。
Linux 安装到 `~/.local/opt/openbot/<version>/openbot.AppImage`，保留已有版本。完成后可删除
下载的脚本。这两条路径不请求 root 权限，也不启动 Server/Worker 服务。

Windows x64，在 PowerShell 中执行：

```powershell
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/yxflc11/openbot/main/scripts/install-desktop.ps1 -OutFile "$env:TEMP\openbot-install-desktop.ps1"
& "$env:TEMP\openbot-install-desktop.ps1" -Version 0.1.0-alpha.9
```

PowerShell 脚本打开当前用户安装器并等待结果。如果系统执行策略禁止脚本，直接下载并打开 EXE；
此流程不要求修改执行策略。

## 第一次实际使用

1. macOS 或 Windows x64 选择“作为服务电脑”初始化本地服务，或连接已有 Server。Linux 使用连接流程。
2. 以 Owner 登录，在“Owner → 设置 → 模型服务”配置 Server 唯一默认提供方、模型与密钥，
   准备好后明确启用原生 Agent。
3. 使用 OpenBot 文字右侧的 **+** 创建 Bot 或频道。点击 Bot 单独对话，或在频道中 **@** 它，
   然后提交 `none` 配置任务。模型元数据检查不能证明推理可用；第一次真实任务成功
   才是实际模型验收。
4. 退出后重新打开 Desktop，确认工作区与模型摘要仍存在。退出 Desktop 会停止 macOS/Windows 本地服务；
   无人值守定时任务需要持续运行的 Server。

Desktop 支持受限频道协作、更丰富附件、经审核 MCP 资料与应用、语音草稿和恢复启动。分享导出可复用 Bot 档案/已验证技能并下载成果，不发布私人记忆或聊天记录。Windows 本地服务证据见 [Windows 桌面版](WINDOWS_DESKTOP.zh-CN.md)。macOS 随包 PostgreSQL 为 17.10，Windows 为 17.11。

完整能力边界见 [Desktop 引导](DESKTOP_ONBOARDING.zh-CN.md)、[原生 Agent](NATIVE_AGENT.zh-CN.md)
和 [Server 容器](SERVER_CONTAINER.zh-CN.md)。

## 构建与准备发布

```bash
npm ci
npm run check
npm run package:installers --workspace @openbot/desktop
```

在目标操作系统上构建。安装器阶段之前仍运行现有 Packager/ASAR/fuse 检查，随后使用固定的
`electron-builder` 26.16.1、`prepackaged` 与 `publish: never`。原生 CI 会先构建 macOS Worker
companion，再生成三端安装器。输出目录包含 `manifest.json` 与 `SHA256SUMS`；本机构建的
`sourceCommit: null`，不能进入 CI 发布门槛。

**Prepare Desktop release** 工作流接收成功的 main push CI 运行编号与对应 Desktop 版本，验证
仓库/运行身份、选定目标及所有校验值，然后创建包含相应安装文件、合并清单与校验值的草稿预发行。
工作流默认选择 macOS arm64 和 Windows x64，也可选择仅 Windows 或全部三个平台。
它不会公开草稿，也不会覆盖已有 Release。公开前仍需完成原生依赖声明/源码对应核对与签名分发
审查。草稿仅仓库维护者可见，不是公开下载渠道。

Windows 命令安装器按流限制校验表为 16 KiB、安装器为 2 GiB，并只允许至多 5 次 HTTPS GitHub 发布域名重定向。取消、超限或失败会清理本次部分下载。Linux 先在私有暂存目录完成复制，再发布到版本目录；复制失败可重试，并发出现的目录保持原样，不会被覆盖或嵌套安装。

桌面主窗口各保留一条工作区和频道事件流。刷新、切换频道、切换 Server 或关闭窗口会中止过期连接，避免反复导航占满 Server 连接槽位。

macOS/Linux 命令安装要求 curl 8.4.0 或更新版本，以便未知长度下载也受限。旧版本或无法识别的版本会在网络访问前停止；此时使用上面的原生安装器下载路径。
