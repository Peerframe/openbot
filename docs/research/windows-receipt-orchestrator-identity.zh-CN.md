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
