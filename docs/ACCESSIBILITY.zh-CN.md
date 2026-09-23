# 无障碍基线

[English](ACCESSIBILITY.md) · [简体中文](ACCESSIBILITY.zh-CN.md)

OpenBot 目前不宣称已经符合 WCAG。本页只记录已经实现的交互模式、遵循的上游依据、实际执行
过的检查，以及贡献者不能误写成“已完成”的缺口。

## 上游审查

2026-09-04 的员工流程审查在修改本地代码前检查了这些持续维护的来源：

| 来源 | 固定基线 | 许可证 | 决定 |
| --- | --- | --- | --- |
| [WAI-ARIA Authoring Practices](https://github.com/w3c/aria-practices/tree/7e4034b262bc0d25332e330d8a582aaf34113829) | `7e4034b2` | W3C Software and Document License | 采用 Tab 和模态弹窗的标准角色、状态关系、游标式焦点与键盘行为；没有复制示例源码。 |
| [Adobe React Spectrum](https://github.com/adobe/react-spectrum/tree/50279a10ab998572e240e44aa36f84a15c7c4f99) | `50279a10` | Apache-2.0 | 作为成熟 React 实现参考；当前固定员工 Tab 和原生弹窗不引入其完整组件/样式栈，也没有复制源码。 |
| [HTML `dialog` WCAG 技术 H102](https://www.w3.org/WAI/WCAG22/Techniques/html/H102) | 2026-01-12 更新 | W3C 文档许可证 | 使用浏览器 `showModal()` 提供焦点限制、背景不可操作、Escape 关闭和焦点返回，不自行重写 focus trap。 |

本地差集保持很小：员工主页只保存 OpenBot 特有的 Tab 状态；一个薄 React Hook 把原生 Dialog
生命周期接回应用状态。如果未来需要嵌套 Overlay、异步集合、方向切换或虚拟化 Tab，应先重新
评估 React Aria Components，再扩展本地实现。

## 已实现基线

- 员工主页导航暴露一个 `tablist`、七个 `tab`、一个有标签的 `tabpanel`，且只有当前 Tab
  进入顺序焦点。
- 左右方向键、Home 和 End 会移动焦点并同步激活视图，首尾能够循环。
- 创建 Bot、创建频道、员工导出和员工导入使用浏览器原生模态弹窗。
- 弹窗打开时焦点进入其中，Tab 不会离开弹窗，Escape 可以关闭，关闭后焦点返回打开按钮。
- 既有表单错误使用 `role="alert"`；弹窗打开后背景不可操作；只有图标的关闭按钮有可访问名称。
- 已在 Codex 内置浏览器的桌面三栏状态和 `390 × 844` CSS 像素手机状态手工检查员工主页与
  导出预览。手机页面没有文档级横向溢出，导出弹窗保持在视口内。

## 复现检查

先运行确定性仓库检查：

```bash
npm --workspace @openbot/web test
npm --workspace @openbot/web run typecheck
npm run lint
```

再验证浏览器行为：

1. 打开任意 Bot 的员工主页。
2. 聚焦“概览”，分别使用左右方向键、Home 和 End，确认焦点、选中状态和可见面板一起变化。
3. 打开“导出模板”，确认焦点进入弹窗，背景控件无法取得焦点。
4. 按 Escape，确认弹窗关闭，焦点返回“导出模板”。
5. 在 390 像素手机视口重复主页与导出流程，确认页面没有文档级横向滚动。



确定性入门级 DOM 回归（jsdom；不是真实浏览器或辅助技术证据）：

```bash
npm exec --workspace @openbot/web -- vitest run src/components/CreateBotDialog.test.tsx
npm exec --workspace @openbot/web -- vitest run src/components/EmployeeProfileView.test.tsx
npm exec --workspace @openbot/web -- vitest run src/components/RunInspector.integration.test.tsx
npm exec --workspace @openbot/web -- vitest run src/components/NodeManagerDialog.test.tsx
```

分别覆盖：创建 Bot 对话框标注 / cancel 卸载 / 创建失败 `role="alert"`；员工主页 Tab 键盘焦点与
`aria-selected` 同步；RunInspector Escape/焦点恢复；Node 管理对话框 `showModal` / cancel 卸载
（含吊销确认文案）。

## 已知缺口

- 尚未在真实操作系统上完成 VoiceOver/Safari、NVDA/Firefox 或 Chrome、Orca/Firefox 的人工
  屏幕阅读器矩阵。
- 尚未选定和接入自动化无障碍回归工具。
- 对比度、强制颜色、减少动态效果、文字缩放和 200%/400% 回流仍需明确证据。
- Run Inspector 与移动端导航 Sheet 仍使用自定义 Overlay，需要接受同样的开源优先焦点管理
  审查。
- 界面目前以中文为主；语言切换、翻译后的可访问名称、文字方向和伪语言测试仍待实现。

无障碍贡献必须说明实际测试的浏览器/辅助技术组合、修改前后行为，并在仓库工具能够表达时
增加回归测试。
