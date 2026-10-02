# OpenBot 共享客户端

[English](README.md) · [仓库地图](../../docs/REPOSITORY_MAP.zh-CN.md)

React 客户端同时用于 Web 和 Electron Desktop。`App.tsx` 协调导航及登录后的工作区状态。功能组件展示受控数据并调用 Server API，不授予工具、决定授权或读取模型凭据。

`api.ts` 是 HTTP/SSE 边界；`conversation-session.ts` 管理频道草稿和发送连续性；`run-output-state.ts` 投影临时流式正文。`ChannelWorkspace.tsx` 组合消息与输入框；消息操作、回应、附件和插件面板分别放在 `components`。

启动文档要求的 Server 后，从根目录运行 `npm run dev:web`。组件/状态测试使用 `npm run test --workspace @openbot/web`；依赖顺序的类型检查使用根 `npm run typecheck`。界面修改还需宽窄窗口的真实渲染操作，JSDOM 不能证明像素布局、Electron 焦点或原生媒体权限。

复用组件样式、`tokens.css` 中的令牌和 `primitives.css` 中的基础组件。全局样式表只在 `global-styles.ts` 里按层叠顺序列一次，不要再叠加另一代全局覆盖。

**设计预览。** `npm run design:preview -w @openbot/web` 在 http://127.0.0.1:5179 提供 `preview.html`，用模拟数据渲染真实界面，方便与画布画板并排对比（`?scene=channel`、`profile`、`new`、`launch` 等）。它只用于开发：没有构建步骤、`connect-src 'none'`，`src/preview` 里的传输层对未知请求一律拒绝。它不能证明后端行为。渲染器只调用已声明的 Desktop 桥接，原生授权与生命周期属于 `apps/desktop`；插件网页遵守现有沙箱和 host 协议。
