# 研究：MCP 工具插件的 Owner 界面

- 状态：接受实施
- 日期：2026-09-10
- 维护者：OpenBot contributors
- 验收路径：Owner 检查准确工具声明，以停用状态安装，明确分配给 Bot，在调用发生前查看具体参数并决定。
- 安全边界：界面仅转义显示文本并调用固定认证管理 API，不执行插件 HTML/JavaScript，不根据注解授予权限，不直接连接插件地址。

## 来源与候选

查阅 [MCP 2025-11-25 工具规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)中的确认与注解信任边界。协议、维护版本、GitHub 源码、测试、问题和安全检查沿用[第三方插件研究](third-party-mcp-plugins.md)：官方 SDK 1.30.0，提交 `2d889f2b329e46680ec9bdd565de4616c497825a`，兼容 MCP 2025-11-25。

界面标准和已有 React 19.2.8 依据[频道协作研究](channel-collaboration-presentation.zh-CN.md)。核对已有技能广场、原生表单与弹窗复用条目。工具插件与 SKILL.md、Employee 模板包分开管理。

Bot 选择在保存后被重置（F05，2026-09-13）的补充检索：官方 React 文档[保留并重置 state](https://react.dev/learn/preserving-and-resetting-state)与[你可能不需要 Effect](https://react.dev/learn/you-might-not-need-an-effect)；GitHub 固定 `react` **19.2.8**，提交 `1dd4ecbdabf826f527fc9a58c05ea70375b7d170`（MIT）。不需要新的 UI 依赖。须如实记录：该授权 Bot 选择修复的**首个 PR 修订**遗漏了本条研究扩展与 PR 的开源研究字段，已在后续修订补齐后再送审。同 PR #64 后续跟进（2026-09-13）：实机 GUI 在 tip `bef3243` 仍复现第二 Bot 保存后跳回首项；独立 React 用例证明 `selectionRef` 仅跟踪 `{botId, revision}` 时「已保存」会在可用性/清权同步后残留。本跟进将成功反馈绑定到 Bot + 可用性 + 权威授权快照，details 首次展开后保持 PluginManager 挂载并按 `plugin.id` 持久化 Bot 选择，mutate 在 resolve 前等待 GET，并覆盖 A/B/C 与 Panel keep-alive 回归。无新依赖；不改后端/权限模型/发行版本。

| 候选 | 固定版本 | 许可、维护与验证 | 适配与决定 |
| --- | --- | --- | --- |
| 原生表单、展开控件与已有 React | React **19.2.8** / 提交 `1dd4ecbdabf826f527fc9a58c05ea70375b7d170`；WAI-ARIA 1.2，2023-06-06 | MIT、W3C 条款；已有组件测试；已核对保留 state 与避免多余 Effect 的官方说明 | 首个可行标准；`key={plugin.id}`、details keep-alive 与按插件持久化 Bot 选择保留 sticky Bot；「已保存」绑定 Bot + 授权权威快照；仅在 Bot 或 grant revision 真正变化时同步草稿 |
| 插件自身渲染的嵌入界面 | 不采用 | 本次不需要 | 会扩大渲染执行和信任边界，不引入 |

## 实现决定

界面只是 Server 插件 API 的薄适配层。名称、地址或令牌改变后，预览及审核立即失效；安装携带准确的已审核摘要，初始停用。每项工具默认不授权，由 Owner 手动选择逐次确认或持续只读许可。`readOnlyHint` 不会自动选中权限。

调用确认显示 Bot、插件服务地址、工具名、完整 JSON 参数和过期时间。地址缺失、记录过期或刷新失败时禁用决定。可见频道每两秒轮询一次，不重叠请求；页面隐藏暂停，卸载终止。状态不确定时显示失败，不自动重试写操作。

错误文案不回显密钥或不可信服务载荷。令牌和调用参数不写入 URL 或 localStorage。权限和审计始终由 Server 判定，前端的能力展示不授予权限。

授权编辑器（F05）：不要用 `plugin.revision` 作为 `PluginGrantEditor` 的 `key`。授权 PUT 导致 revision 变化后，应按[保留并重置 state](https://react.dev/learn/preserving-and-resetting-state)用稳定的 `plugin.id` 保持同一位置上的 sticky Bot。`<details>` 首次展开后保持 `PluginManager` 挂载（折叠仅隐藏），并按 `plugin.id` 在 SPA 会话级 Map 中持久化 Owner 所选 Bot（离开技能页再进入仍保留），避免回落到 `bots[0]`。仅在所选 Bot 或插件 grant revision 真正变化时同步草稿；同一 revision 下父组件重渲染必须保留未保存草稿。按[你可能不需要 Effect](https://react.dev/learn/you-might-not-need-an-effect)，避免在每次新的 `plugin` 对象引用上都用 Effect 重置。将「已保存」绑定到当前 Bot **以及**权威授权快照（可用性 + enabled/grants 身份），而非仅 `botId`+`revision`：用待确认写入与 mutation 后 GET 快照对照，使正常保存成功反馈保留，而清权/Bot 不可用会清除「已保存」（用例 A/B/C）。父级 mutate 在 resolve `onSave` 前等待插件 GET。迟到的 `.then()` 成功还要求 pending 写入仍有效，且在 revision 已前进时现场 grant 签名必须匹配提交内容——避免清权快照在 PUT 仍挂起时误标「已保存」。本切片不改变权限模型、后端语义或发布版本号。

## 代码与许可

没有复制或实质改写上游源码。复用现有 React 和样式约定，没有新增前端依赖。React 仍精确固定为 **19.2.8**（`1dd4ecbdabf826f527fc9a58c05ea70375b7d170`，MIT）；仅引用官方学习文档中的 key/state 指引，不复制 React 源码。

## 验证与限制

覆盖编辑导致预览失效、准确摘要提交、注解不会自动授权、确认/拒绝绑定具体调用、过期/不可用状态禁用、同频道过滤和恶意说明/参数的文本转义。

授权 Bot 选择：覆盖 revision 递增后 sticky Bot、缺失 Bot 不可用态、消失的授权目标被丢弃、同一 revision 下脏草稿保留、迟到异步的「已保存」绑定、用例 A/B/C/D（清权快照 / 成功后 bots=[] / 保存挂起时 bots=[] / 清权快照后 resolve）、正常保存 reload 仍保留「已保存」，以及 PluginManager GET→延迟 PUT→revision GET 与 PluginManagerPanel keep-alive 回归。分支上运行 `npm run check`；无新依赖。

使用合成数据做桌面与窄屏真实浏览器预览；不据此声称完整第三方服务或所有平台均通过验收。插件公开市场、OAuth 和插件渲染资源不在本次范围。英中文操作说明与后端交付共同维护。

## 2026-09-10 真实渲染结果

沿用频道研究中记录的合成 Vite/Chrome 环境，在 1280 × 900 与 390 × 844 检查已安装插件、添加表单和权限控件。点击添加工具插件能展开连接表单。窄屏审批显示准确目标地址和完整测试参数，点击拒绝后该待确认项消失。没有相关控制台/页面错误或文档横向溢出。这只验证渲染器及模拟 API 交互，真实传输、持久化和权限由后端测试覆盖。截图保存在仓库外，只有合成数据。
