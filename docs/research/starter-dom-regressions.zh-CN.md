# 研究：Owner 对话框与员工主页 Tab 的入门级 DOM 回归

- 状态：已接受，用于测试交付
- 日期：2026-09-23
- 维护人：OpenBot 贡献者
- 关联：依赖 D3 / 拆分入门卡片的提交（`7b9b930140db8a3318c5d192ae8adf394385109e`）；本 Draft 基于该 tip
- 验收：四张入门卡获得可在文档反例下失败的 jsdom 回归；不宣称 WCAG、axe CI 或真实浏览器证据
- 安全边界：仅 Web Vitest/jsdom 测试与双语状态文档；不改 Server 权威、Runtime/Worker/快照/审批、
  包装或贡献政策

本记录复用仓库已审查的 React 19.3.0、Vitest 5.0.0、jsdom 30.0.1 与
`docs/ACCESSIBILITY.md` 中的 WAI-ARIA / 原生 `<dialog>` 基线；`npm ci` 后锁定版本已核对。完整检
索、候选比较、验收命令与产品缺陷说明见[英文记录](starter-dom-regressions.md)。

未复制或实质改编上游源码。

## 产品缺陷（D4 未改产品）

`CreateBotDialog` 与 `NodeManagerDialog` 在对话框内使用 `autoFocus`，可能与 `useModalDialog` 记
录 opener 的时机竞态，导致关闭后焦点无法回到打开按钮。D4 仅完成不依赖该缺陷的回归，并留下可复
现说明；不跨文件改写产品以“迁就测试”。
