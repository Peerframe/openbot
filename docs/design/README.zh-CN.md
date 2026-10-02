# 设计素材状态

[English](README.md) · [简体中文](README.zh-CN.md)

- [办公室概念图](m0-office-concept.png)：仅作 M0 历史探索留档，不是当前实施要求；办公室插件继续延后。
- [组合头像参考图](openbot-avatar-system.png)：之前的组合式机器人参考图，已被 [Avatars 画板](desktop-ui-2026-10/Avatars.dc.html) 中无外框的头像取代；它引入的外观分层数据仍然兼容。
- [头像源文件](avatars/README.zh-CN.md)：所有者的无框头像作品（v2 SVG），应用里的 v3 头像据此绘制。
- [README 横幅](openbot-readme-banner.png)和[频道示意图](openbot-channel-demo.png)：当前 README 展示素材。
- [Desktop 界面设计契约（2026-10）](desktop-ui-2026-10/README.zh-CN.md)：所有者确认的画板，所有界面都按它重建；
  另见[实施计划与分工](desktop-ui-2026-10/IMPLEMENTATION.zh-CN.md)。

旧 public 像素机器人 PNG/SVG 及无使用方的登录/成员样式已从应用资源移除。旧用途保留在 Git 历史，不应为了历史留档重新放进运行时资源包。

## UI 修改前的阅读路线

先读 [INTERFACE](../INTERFACE.zh-CN.md) 的相关段落，再按[UI 路线](../REPOSITORY_MAP.zh-CN.md#ui-交互)
阅读实际组件和测试。INTERFACE 同时包含现状和未来意图，范围以当前实现、测试及本次任务为准。
布局与视觉以 [2026-10 设计契约](desktop-ui-2026-10/README.zh-CN.md)为准，保留 RobotAvatar 等资产；[tokens.css](../../apps/web/src/tokens.css) 拥有 `--ob-*` 令牌，
[primitives.css](../../apps/web/src/primitives.css) 拥有焦点和全局基础样式，局部布局属于组件 CSS。复用附近原生按钮、表单和
对话框，不新建与契约 tokens 重叠的主题，不把历史 office 图当作重设计要求。

| 状态/术语 | 实际阅读入口 | 应保留的含义 |
| --- | --- | --- |
| 加载/空 | [ContextRail.tsx](../../apps/web/src/components/ContextRail.tsx)、[WorkTasksScreen.tsx](../../apps/web/src/components/WorkTasksScreen.tsx) | 等待不代表任务完成；空数据不等于读取失败 |
| 等待/审批 | [WorkTasksScreen.tsx](../../apps/web/src/components/WorkTasksScreen.tsx)、[ApprovalCard.tsx](../../apps/web/src/components/ApprovalCard.tsx) | attention 由控制层报告；看到审批不代表获得权限 |
| 失败/未知 | [WorkTasksScreen.tsx](../../apps/web/src/components/WorkTasksScreen.tsx)、[work-api.ts](../../apps/web/src/work-api.ts) | 明确拒绝与结果未确认分开，不盲目重提 |
| 断线/过期 | [WorkTasksScreen.tsx](../../apps/web/src/components/WorkTasksScreen.tsx)、workspace hooks | 清除 freshness 并禁用危险操作；停止观察不取消任务 |
| 只读/不可用 | [NativeTaskScopeView.tsx](../../apps/web/src/components/NativeTaskScopeView.tsx)、控制层 authority 模式 | 禁用按钮不等于授权，Server 仍执行边界 |
| 交付/产物 | [WorkTasksScreen.tsx](../../apps/web/src/components/WorkTasksScreen.tsx)、[ApprovalCard.tsx](../../apps/web/src/components/ApprovalCard.tsx)、[ArtifactCard.tsx](../../apps/web/src/components/ArtifactCard.tsx) | 动作持久化、产物发布和下载成功是不同事实 |

组件均位于 `apps/web/src/components`，按本次流程沿 import 展开。WorkTasksScreen 当前只报告产物
登记，未提供该入口下载，不得将登记称为交付成功。Employee/Bot 是身份，Node 是执行机器，
Task 是持久意图，Run 是执行尝试；INTERFACE 旧措辞不构成新的状态模型，以实际契约标识为准。

检查宽窄视口、键盘/焦点、既有减少动效行为及受影响状态，记录实际视口和入口。界面夹具测试不
证明原生 Desktop 打包、真实模型结果或新增平台支持。
