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

- 选中：仅改安装门禁脚本 — 规范进程观察器 + JSON DateTime→ISO-7 归一化（7.4 安全路径）+
  弹性目录删除 + 可在 Linux pwsh 运行的独立测试。
- 不可只改 Path→MainModule：receipt / summary 的 `[string]$DateTime` 仍会永久写入错误时间戳。
- 不放宽相等性；不改 smoke/harness/产品代码。

## 验证计划

- `scripts/check-windows-receipt-identity.ps1`：Linux 上断言 JSON 往返保留 ISO-7；Windows 上再跑
  宿主与 WinPS 5.1 交叉预检。
- 托管 Windows CI 重跑安装门禁确认 bootstrap receipt 与 held Electron 一致。
