# 研究：Windows 安装门禁 receipt↔orchestrator 身份一致性

- 状态：已接受，待实现合入验证
- 日期：2026-09-13
- 负责人：@yxflc11
- 相关问题：托管 CI 上 Windows Desktop 冷启动安装门禁失败
- 验收旅程：NSIS 安装后，PowerShell 编排器用与 smoke 相同的 .NET 字段记录并严格比对
  所持 Electron 进程身份（路径仅大小写不敏感），证据只投影 `pid` /
  `startTimeUtc` / `executablePath` 三字段。
- 安全边界：只观察自有/持有句柄的进程；拒绝仅凭 PID 杀进程；失败诊断不含密钥、原始配置或密文。

## 检索证据

- 检索日期：2026-09-13
- CI 任务：https://github.com/yxflc11/openbot/actions/runs/34747105460/job/103696935315
  - 失败：`Round receipt does not match the Electron process held by the orchestrator.`（bootstrap；
    smoke 退出码 0；`rounds=[]`）
  - 次要：`Remove-Item -Recurse` 在卸载后清理时出现 `Could not find file …elicitationUrlExample.d.ts.map`
- Smoke 观察（基线）：WinPS 5.1 + `GetProcessById` + `.Handle` +
  `ToString('o', InvariantCulture)` + `MainModule.FileName`
- 编排器修复前：`ToString('o')`（无 InvariantCulture）+ `[string]$smoke.Path`
- pwsh **7.4.6** 实测：`ConvertFrom-Json` 将 ISO 转为 `DateTime`；`[string]` 变成
  `09/13/2026 08:25:04`（丢失 7 位小数）；`ToString('o', InvariantCulture)` 可还原；
  `-DateKind String` 在 7.4.6 不可用；`System.Text.Json` `GetString()` 可保留原文。

## 复用决定

- 选中：仅改安装门禁脚本 — 规范进程观察器 + **STJ 保留原文**为主路径读取已知身份字段
  （`ConvertTo-IsoStartTimeUtc` 仅作已是 DateTime 时的回退）+ 共享 helpers +
  弹性目录删除 + 可在 Linux pwsh 运行的独立测试（直接点源生产 helpers，不复制函数）。
- 归一化 DateTime 不作主路径；Json.NET `DateParseHandling.None` 同思路但此处用 STJ 即可。
- 预检改为对持有句柄的两次 canonical 读取（有界），不再 `&` 无超时 WinPS 子进程。
- 不可只改 Path→MainModule：receipt / summary 的 `[string]$DateTime` 仍会永久写入错误时间戳。
- 不放宽相等性；不改 smoke/harness/产品代码。

## 验证计划

- `scripts/check-windows-receipt-identity.ps1`：Linux 上断言 STJ 主路径往返保留 ISO-7，并拒绝
  末位小数/错误 PID/错误路径；Windows 上再跑有界 held-handle 预检。
- 托管 Windows CI 重跑安装门禁确认 bootstrap receipt 与 held Electron 一致。
- NSIS 静默卸载：官方 FAQ（ExecWait uninstaller）说明普通 `/S` 只等 stub；门禁将
  `Uninstall OpenBot.exe` 复制到安装目录外并以 `/S _?=<install-dir>`（`_?` 最后、路径不加引号）
  有界等待后再置 `uninstallPassed` / 删目录。


## 集成验证

Codex 在 macOS PowerShell 7.5.4 独立复现 JSON 日期比对失败；进程字段差异本身尚未被证明是本次故障原因。同一 .NET 运行时读两次不能证明与实际 smoke 观察器一致。集成复用已固定版本的 Node 22.22.2 observeProcessIdentity（WinPS 15秒/输出上限），观察持有句柄的 PowerShell 主进程，通过 .NET ProcessStartInfo.ArgumentList 传参并增加20秒外层进程时限、关闭标准输入和响应大小校验。官方契约：https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.processstartinfo.argumentlist 。不增加依赖、不复制上游源码。共享回归入口在 Windows 原生打包前运行，完整安装门禁仍执行实际观察器验证。

NSIS _?= 使持有进程覆盖真正卸载，官方契约：https://nsis.sourceforge.io/Docs/Chapter3.html#uninstallerusage 。卸载超时后如不能确认进程已退出，摘要必须标记 cleanupVerified=false。

## Get-Command Application 多匹配（Node FileName）

- CI 证据（身份比对前即失败）：
  https://github.com/yxflc11/openbot/actions/runs/34748591201/job/103701010236
  - `Start process 'C:\hostedtoolcache\windows\node\22.22.2\x64\node.exe C:\Program Files\nodejs\node.exe'`
  - 原因：存在多个 Application 匹配时，`(Get-Command node -CommandType Application).Source`
    变成 `Object[]`，字符串化后空格拼接成多路径，不能作为 `ProcessStartInfo.FileName`。
- 官方语义：
  https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/get-command?view=powershell-7.5
  - `-CommandType Application` 在 `$Env:PATH` 中搜索可执行文件。
  - `-TotalCount <int>` 限制返回条数。
  - 使用 `-TotalCount 1` 取 PATH 上第一个命中（实际会运行的命令 / 优先级首位）作为唯一
    `.Source` 字符串 — 由 `scripts/windows-receipt-identity-helpers.ps1` 中的
    `Get-NodeApplicationPath` 实现。
- 回归：`scripts/check-windows-receipt-identity.ps1` 双 Node PATH 夹具（Linux/Windows 可跑）。

集成回归覆盖带空格路径。Unix 测试目录链接到现有 Node，Windows 复制可执行文件以免要求符号链接权限。版本检查对持有进程的输出及退出均有等待上限；临时目录删除错误会让检查失败。本机沙箱内运行不能替代 Windows 原生证据。

## 启动期间的进程映像身份

2026-09-13 先完成研究再实施。[Windows CI 34748988049](https://github.com/yxflc11/openbot/actions/runs/34748988049/job/103701932039)（PowerShell 7.6.5）已通过 bootstrap，但第一次冷启动失败：持有对象与回执的 PID、启动时间完全一致，立即读取的可执行路径为空。卸载、清理及测试目录删除均通过，不能据此放宽身份比对。

- [Microsoft MainModule 契约](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.mainmodule?view=net-10.0) 明确允许主模块加载前返回 null。[Refresh 契约](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.refresh?view=net-10.0) 说明会清除缓存。
- 已审 dotnet/runtime **v10.0.9**，Git ref `5eaa18a9f3398d54ba9b8c0974d88171663be892`：Refresh 与 Windows RefreshCore 不释放或替换已持有句柄；Close 才释放。这仅证明句柄保留，不证明第一个非空主模块就是可执行文件。
- 已审 PowerShell **v7.6.5**，Git ref `8d7d14a86bf05f45ed163b1b1fbfde1ac4682bac`；[global.json](https://github.com/PowerShell/PowerShell/blob/v7.6.5/global.json) 固定 SDK 10.0.303。旧 CI 未输出实际加载的 .NET 补丁版本，新增回归直接输出框架标识，不从 PowerShell 版本推断。

初版采用5秒空模块重试、不增加原生互操作；**该决定已被新原生证据修订**。[CI 34750084879](https://github.com/yxflc11/openbot/actions/runs/34750084879) 在 PowerShell 7.6.5 / .NET 10.0.11 上，第9次启动先读到 `ntdll.dll`、刷新后读到 `node.exe`；PID 6716、UTC 时间 `2026-09-13T09:44:03.3549414Z` 和句柄2216完全未变。[上游 #14652](https://github.com/dotnet/runtime/issues/14652) 有同类故障；[Microsoft 模块枚举文档](https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-enumprocessmodulesex) 明确允许初始化期间返回错误信息，非空不能作为就绪条件。

已审实际框架 **dotnet/runtime v10.0.11**，提交 `79d0c463f1b55624c874a11585f7e47731e8d675`：[Process.Windows.cs](https://github.com/dotnet/runtime/blob/79d0c463f1b55624c874a11585f7e47731e8d675/src/libraries/System.Diagnostics.Process/src/System/Diagnostics/Process.Windows.cs) 仍选首个枚举模块；[Interop.GetProcessName.cs](https://github.com/dotnet/runtime/blob/79d0c463f1b55624c874a11585f7e47731e8d675/src/libraries/Common/src/Interop/Windows/Kernel32/Interop.GetProcessName.cs) 内部使用 QueryFullProcessImageNameW，但公开 Process API 不提供完整映像查询。[Microsoft 推荐该 API 查询其他进程的可执行文件](https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-getmodulefilenameexw)。

改为标准 [QueryFullProcessImageNameW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-queryfullprocessimagenamew) 薄绑定，直接传入现有 Process.SafeHandle，flags=0 返回 Win32 路径；marshaller 在调用期间保留借用句柄，适配层不按 PID 打开、不关闭该句柄。固定32768字符 Unicode 缓冲区，结果必须非空、未截断且返回长度一致；原生错误立即失败。前后检查同一持有对象存活，保留 PID/启动时间/路径严格比较；清理复用同一观察方法。不叠加等待、不筛 DLL 名、不按回执补路径。

复用清单已链接本研究。仓库未找到可复用的 QueryFullProcessImageName/Win32 绑定；沿用 `scripts/install-desktop-download.test.ps1` 的 Add-Type 编译惯例，单个标准 API 绑定比引入通用互操作依赖或按 PID 调 WMI 更窄。运行库源码只作核对，未复制或实质改编，无新增依赖或许可证声明。

回归反复创建真实 Node 子进程后立即调用共享 helper，比较子进程自行报告的 PID/可执行文件、确认刷新保留句柄，并在确认退出后拒绝同一对象；读取和清理均有时间上限。macOS/Linux 结果只能证明该主机上的流程，不能替代 Windows 原生或完整 Electron/NSIS 验收。无新增依赖，无复制或实质改编上游代码；MIT 运行库源码仅用于核对 API 行为。

旧版空模块重试曾在 macOS PowerShell 7.5.4 / .NET 9.0.10 通过，但不能预测 Windows 模块枚举行为。新版绑定需验证编译及拒绝无效/已关闭句柄；保留的10次真实生命周期和详细诊断必须在原生 Windows 通过，再执行完整安装门禁。非 Windows 测试明确不证明 Windows API 的成功调用。

## 确认退出后的双 Node 夹具清理

2026-09-13 实现前研究：[main CI 34766658986](https://github.com/yxflc11/openbot/actions/runs/34766658986/job/103748719956)，源码 `546127e1b70bf39bac9b87a522834233be0e1b93`，已通过 JSON、双 PATH 断言及真实 `node --version` 子进程检查。等待退出并释放进程对象后，删除复制的 `first node/node.exe` 时仍因其他进程占用失败；日志不能确定持有者，不能归因于杀毒软件。

已核对复用清单与现有 `Remove-FixtureTreeResilient`：后者处理安装测试中路径消失，不处理本独立预检的共享冲突。[Microsoft DeleteFile](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-deletefilea) 规定不兼容的已打开句柄会阻止删除。GitHub 检索 `PowerShell Remove-Item file in use retry`，包括[文档问题6625](https://github.com/MicrosoftDocs/PowerShell-Docs/issues/6625)。检查受维护的 **PowerShell v7.6.5**，提交 `8d7d14a86bf05f45ed163b1b1fbfde1ac4682bac`，MIT；[FileSystemProvider.RemoveFileSystemItem](https://github.com/PowerShell/PowerShell/blob/8d7d14a86bf05f45ed163b1b1fbfde1ac4682bac/src/System.Management.Automation/namespaces/FileSystemProvider.cs) 在错误记录中保留原 `IOException`。已有原生 Windows CI 预检会先验证子进程退出。

选择标准 `Remove-Item -LiteralPath` 加有限重试：仅重试 `IOException` 共享/锁冲突（Win32 32/33），最多8次删除，7次退避等待共7.1秒；永久错误和最后一次失败仍抛出。只清理由本次检查创建且子进程已停止并释放的夹具。拒绝吞掉错误或减弱身份断言；无需新增通用清理依赖或改变无关安装脚本。无复制或实质改编上游源码，无新依赖，无产品运行时或权限变更。

验证现有真实子进程预检；对提取出的清理块注入临时占用、持续占用及其他错误，检查恢复与失败上限；发行前要求原生 Windows 身份及安装生命周期门禁通过。注入测试只证明分支和上限，不等于 Windows 原生锁验收。
