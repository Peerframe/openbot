# 研究：贡献者入门任务切片

- 状态：已接受，用于文档调整
- 日期：2026-09-23
- 维护人：OpenBot 贡献者
- 验收：新贡献者可以只选一张「入门」卡片，针对一项已有行为补齐回归/文档缺口，并独立提交可审查
  PR，而不必先搭跨工具 CI 门禁。
- 安全边界：仅文档与入门级测试任务说明；不改动 Server 权威、凭证、登记、Runtime/快照/收据/恢复
  源码或贡献政策文件。

在基线提交 `ebce9950b2bde2c44d88d1d3d1902b9e27ba9eb8` 上核对了
`docs/CONTRIBUTOR_TASKS.md`、`docs/OPEN_SOURCE_REUSE.md`、
`docs/research/2026-09-15-contributor-startup.md`、`docs/ACCESSIBILITY.md`，以及 Web 侧已有实现与
测试：`useModalDialog.ts`（无专用测试）、`CreateBotDialog.tsx`（无测试）、
`AttachmentsManager.test.tsx`（Escape/焦点恢复范例）、`EmployeeProfileView`（仅有纯函数与静态
markup 测试）、`RunInspector`（源码已处理 Escape/焦点，集成测试未覆盖）、
`NodeManagerDialog`（仅有身份列表静态测试）、`MobileNavigation.tsx`（无测试且未接 Escape，留在
ACCESSIBILITY 已知缺口，不作为本次虚构产品行为的入门卡）、`scripts/check-docs.mjs`（尚不构成翻译
一致性门禁）。

结论：把「无障碍回归检查器」和「翻译一致性检查」从入门降为中级；新增四张 grounded 入门卡——创建
Bot 对话框生命周期回归、员工主页 Tab 键盘 DOM 回归、RunInspector Escape/焦点恢复回归、Node 管理
对话框生命周期回归。不发明贡献者 churn 指标，也不把已在「优先共建」中的全新克隆 smoke 重复写成
入门任务。

未复制或实质改编上游源码。完整检索、候选比较与验收反例见[英文记录](contributor-starter-slices.md)。
