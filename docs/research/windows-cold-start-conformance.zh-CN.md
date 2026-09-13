# 研究：Windows 桌面版冷启动符合性

- 状态：已接受实现；仍需原生 Windows 验证
- 日期：2026-09-13
- 负责人：@yxflc11
- 相关议题：alpha.8 Windows 冷启动验收
- 验收旅程：在 Windows x64 完成首次本机初始化后，再进行十次彼此独立的 Electron 进程生命周期：每次启动已安装的本机 Server，以启动时间与可执行路径证明新的进程身份，核对保留的 PostgreSQL 行与 DPAPI bootstrap 密文摘要，完成 Owner 登录，然后正常退出，并确认上一轮子进程已结束。
- 安全边界：验证仅使用自建临时目录，从不读取交互用户真实的 Desktop 数据目录；不改产品运行时路径。失败时仅在核对记录的启动时间与可执行路径（或持有的 Start-Process 句柄）后清理本轮 Electron/Server/PostgreSQL 子进程——禁止仅凭 JSON PID 杀进程——并留下不含密钥的简短摘要。

## 检索证据

- 检索日期：2026-09-13
- 主要来源：Electron `v44.2.0` / `safeStorage`（Windows DPAPI）、既有 PowerShell `Start-Process` 安装门禁、PostgreSQL `postmaster.pid` / `pg_ctl`、以及 `windows-desktop-completion.md` 中的安装后冒烟回执约定。
- 既有复用账本与冒烟脚本仅在同一 Electron 进程内 stop/start 一次，不能作为跨进程冷启动证据。

## 候选对比

| 候选 | 结论 |
| --- | --- |
| 同一进程内控制器 stop/start ×10 | 拒绝作为冷启动证据；最多保留一次同进程重启以免削弱历史断言 |
| 安装门禁编排的十次独立 Electron 进程生命周期 | 采纳 |
| Playwright 驱动完整 UI | 本切片拒绝 |
| 新的进程监督依赖 | 拒绝（禁止新依赖） |

## 复用决定

在已固定的 Electron、Node、PowerShell、`NativeServerController`、`utilityProcess`、`safeStorage` 与 Windows PostgreSQL PID 契约上，只补 OpenBot 编排与断言缺口。不复制上游源码。

## 验证计划

- 可移植 Vitest 覆盖 harness 状态/进程身份/回执助手（含真实子进程负例：错误身份不得杀、EPERM/ESRCH）；完整十次冷启动仍以 Windows CI 为准。
- 每轮回执仅含进程身份字段、loginCount 与密文 digest，不含密码或原始密文；不放宽既有 install/uninstall/encryption 断言；Linux 仅可跑助手单测，完整证据标记为 pending CI。

## 未决问题

- 本分支仍需托管 Windows CI 实际跑完十次冷启动。

## 集成复核：进程句柄与证据留存

2026-09-13 的 alpha.8 集成复核沿用复用清单中的 Windows Desktop 与 CI 条目：

- 使用系统 .NET `Process.Handle`：先持有句柄，再核对启动时间和路径，随后通过同一个进程对象结束进程。禁止核对后重新按 PID 发出结束请求。官方依据：https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.handle 。
- 使用仓库已固定的 MIT `actions/upload-artifact` v7.0.1，提交 `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`，不增加依赖、不复制源码。仅保存逐轮明确选定的证据字段，不上传测试配置、密码、密文或原始日志。
- 在 Electron 44.2.0 的 `utilityProcess` spawn 事件后、就绪之前记录身份，覆盖启动中途失败的清理路径。
- 原生 PowerShell 负例会实际创建一个测试进程，验证错误启动时间或路径不会结束它，再通过正确身份清理。
- 全仓检查、Windows 原生进程检查与安装后的十轮启动均需实际运行；本地 helper 单测不能证明 DPAPI 或原生安装成功。

### Windows CI 失败后的修正

PR60 的 CI `34746719361` 在两项进程观察测试中遇到 PowerShell 15 秒超时，尚未进入安装。
新 helper 未沿用仓库现有 Windows ACL 调用约定；修正复用固定系统 PowerShell 路径、
UTF-16LE 编码命令、关闭标准输入、限制输出及直接 .NET 调用，避免命令模块自动加载。
单次失败不能证明究竟是输入管道还是模块初始化造成阻塞，需以修正后的原生 CI 验证。
本轮不增加依赖。直接持有的 Start-Process 对象本身就是清理权限依据；缺少路径元数据
不应阻止结束自己启动的进程，来自 JSON 的身份仍需先持有句柄再完整核验。
