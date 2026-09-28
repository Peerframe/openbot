# Windows 桌面版

当前 Windows x64 Desktop 是远程客户端，需要连接已有 OpenBot Server；仅 macOS arm64 随包
提供本地 Python 服务。安装 Desktop 不会注册 Worker Host，也不会授予电脑控制权限。

## 安装与启动

使用带版本号的 `openbot-desktop-<版本>-win32-x64.exe`，并与该版本 `SHA256SUMS` 核对 SHA-256。
NSIS 按当前用户安装，创建开始菜单快捷方式，卸载时保留应用数据。开发安装器保留 Windows
信任提示；OpenBot 不绕过 SmartScreen、系统策略或杀毒软件。

打开 OpenBot，配置已有 Server 地址并登录该 Server。当前 Windows 包不包含本地 PostgreSQL
或 Server 运行时，也不会初始化本机数据库。下载安装包后，安装本身无需网络；使用远程 Server
需要能够访问该 Server。详见[Desktop Server 连接](DESKTOP_ONBOARDING.zh-CN.md)。

## 保留数据

已有安装、加密设置和数据库继续保留。历史本地 Server 配置包含 `local-server/bootstrap.json`、
PostgreSQL 数据、上传对象与模型设置。请在原 Windows 登录身份下成套保留；把 DPAPI 加密的
初始化文件复制到另一登录身份不是已支持的迁移。当前远程客户端不会重启已退役的本地 Server，
也不会自动迁移其数据库。详见[数据库恢复](DATABASE.zh-CN.md)。

DPAPI 的保护边界是 Windows 登录身份，不能防范同一用户身份下的恶意软件。备份与迁移仍须
遵守已有凭据和数据规则。

## 当前安装验收（Windows x64）

当前 [CI 定义](../.github/workflows/ci.yml)构建 NSIS 并运行
[check-windows-desktop-install.ps1](../scripts/check-windows-desktop-install.ps1)，检查当前用户安装、
原位升级、已安装 ASAR 身份、已退役 `native-runtime` 不在安装物中、两个独立 Electron 进程的
真实 DPAPI 加解密与密文保持、进程身份、卸载及测试清理。测试只用一次性配置目录；单独的
原生 ACL 测试继续保留真实 NTFS 反例。

准备已构建的安装器、对应打包目录和固定的开发 Electron：

```powershell
$version = (Get-Content apps/desktop/package.json -Raw | ConvertFrom-Json).version
$electronPathFile = Join-Path $env:TEMP 'openbot-electron-path.txt'
node -e "const r=require('node:module').createRequire(require('node:path').resolve('apps/desktop/package.json'));require('node:fs').writeFileSync(process.argv[1],r('electron'));" $electronPathFile
$electron = Get-Content -LiteralPath $electronPathFile -Raw
$env:RUNNER_TEMP = $env:TEMP
./scripts/check-windows-desktop-install.ps1 `
  -Installer "$PWD/apps/desktop/out/installers/win32-x64/openbot-desktop-$version-win32-x64.exe" `
  -PackagedDirectory "$PWD/apps/desktop/out/OpenBot-win32-x64" `
  -Electron $electron `
  -SmokeScript "$PWD/apps/desktop/scripts/windows-remote-smoke.mjs"
```

验收必须完成两个远程客户端 safeStorage 生命周期及卸载、清理。`summary.json` 只记录允许的
进程身份、密文摘要等字段，不包含原始密文、密码或测试配置目录。CI 产物暂沿用历史名称
`windows-desktop-cold-start-<源码 SHA>`；应读取其中 schemaVersion2 与远程客户端回执，不能
根据名称推断做了十次 PostgreSQL 冷启动。必须查看对应源码的实际执行结果，工作流定义本身
不代表已执行。本轮清理尚未在 Windows 原生环境运行当前源码的安装、DPAPI 或安装后 GUI。

可移植身份辅助测试仍可运行：

```bash
npm test --workspace @openbot/desktop -- scripts/windows-native-smoke-harness.test.mjs
```

## 历史本地 Server 证据与限制

[早期托管验收](https://github.com/yxflc11/openbot/actions/runs/34497646235)和
[主线 CI34768475942](https://github.com/yxflc11/openbot/actions/runs/34768475942)属于历史记录。
后者对应 `64569ece36141fa112266cdf93e2694bc88a632b`：首次启动加十次独立 Electron 冷启动、
十二次 Owner 登录、PostgreSQL 记录和初始化密文保留、进程身份反例及清理。该证据不能用于
证明当前远程客户端源码或其 GUI 通过验收。旧 `windows-native-smoke.mjs` 入口和 Windows
PostgreSQL 构建链已退出；使用上方当前验收入口。旧版本接收者所需的源码构建许可与来源记录
继续保留，详见[历史研究](research/windows-desktop-completion.md)。

Windows ARM64、Windows 10/11 真机 GUI、签名、SmartScreen、无障碍与电脑控制仍是独立验收项。
Windows Worker Host 服务另行审查，Desktop 安装不能证明其 SCM 身份或登记生命周期已合格。
