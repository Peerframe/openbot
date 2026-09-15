# 研究：Electron 44.3.0 依赖审查

[English](electron-44.3-ci-review.md) · [简体中文](electron-44.3-ci-review.zh-CN.md)

- 状态：已审查，最终组合 CI 仍须通过
- 日期：2026-09-15
- 相关 PR：#81
- 验收：现有 Desktop 打包、插件隔离与原生安装流程在更新后通过。
- 边界：保留 Server 权限来源、上下文隔离、sandbox、禁用渲染器 Node、会话权限规则和 fuses。

## 证据与决定

阅读现有 Desktop 基础研究和复用记录、2026-09-08 官方 44.3.0 发布、标注标签 `a5d1c52118831d762385f34c1b3ffbcc4d99de58` 及对应提交 `07e460719c75b2ec5ee4893f7d2192ef31c7b8c2`、该提交 MIT 许可和上游 #53691 的权限生命周期实现与回归断言。继续复用现有 Electron 44 与打包适配器，不引入框架替换或 fork。

该版本保留内嵌 Node 24.20.0，Chromium 更新至 152.0.7977.78。审查覆盖文件权限作用域和请求 frame 身份、原生对话框与进程修复、Worker 的 Node 权限继承收紧。OpenBot 已关闭 frame/worker Node 集成并限制会话权限；不启用新的调试变量或 API。

精确包为 Electron 44.3.0，npm integrity 为 `sha512-St9EV7F2VtYaYWD2qaAjBwUgKxx39eJOUsUJ5+/1113sqbVfNqv4Dbm/W1rN7qmYSPa+mWwR6yr+b7MfgjgVfQ==`。锁文件 workspace 声明应与精确 manifest 一致。保留 Electron 和打包组件许可；未复制或实质改写上游源码。

## 已知限制与验证

搜索 `repo:electron/electron is:issue is:open 44.3.0` 返回 #53887（标准自定义协议与 PAC）、#30650（Linux 文件传输 portal）、#52024（Linux X11 无边框窗口）。#53887 中渲染器远程请求失败，而 `session.fetch` 成功，未提供最后可用版本。OpenBot 使用标准自定义协议，因此记录这一相关风险；已查源码未配置自定义 PAC 适配器，现有 CI 也不能证明企业 PAC 支持。其余问题未证明当前测试路径新增阻塞回归，不扩大平台声明。

上游源码和测试仅阅读，未运行。原 #81 八项非研究任务已通过，但研究及汇总失败；最终组合须重新验证。执行干净安装、精确声明检查、`npm run check`，以及云端 Linux/macOS/Windows 打包、真实插件隔离、Windows 安装和十次冷启动。若失败应拒绝或回退升级，保留全部安全与原生断言。

主源：[发布](https://github.com/electron/electron/releases/tag/v44.3.0)、[运行时组件](https://releases.electronjs.org/release/v44.3.0)、[固定许可](https://github.com/electron/electron/blob/07e460719c75b2ec5ee4893f7d2192ef31c7b8c2/LICENSE)、[权限源码与测试](https://github.com/electron/electron/pull/53691/files)、[PAC 问题](https://github.com/electron/electron/issues/53887)。
