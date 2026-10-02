# C15：独立页面退出后的服务端接口调用方

2026-10-03，基线 `cbf1700bf596f8f06f202005123e6d92cf7d59a1`。
本轮只读核对、列清单，**没有删除任何接口、服务方法或界面代码**。
具体调用链、搜索范围和测试出处见[英文清单](C15-route-caller-inventory.md)。

| 接口 | 当前调用方 | 结论 |
| --- | --- | --- |
| GET／POST `/api/v1/automations`；PATCH／DELETE `/api/v1/automations/:id` | 设置 → 例行任务 → SettingsAutomations → AutomationsScreen → destination-api | 全部保留 |
| GET `/api/v1/bots/:id/profile` | 设置 → 技能、Bot 档案、消息输入技能选择 | 保留 |
| POST `/api/v1/bots/:id/skills/import` | 设置技能安装、Bot 技能安装 → EmployeeSkillImport | 保留 |
| POST `/api/v1/bots/:id/skills/:skillId/state` | 设置技能审核、Bot 档案审核 → EmployeeSkillReview | 保留 |
| POST `/api/v1/bots/:id/skills` | 没找到当前产品 HTTP 调用方；公开的手动候选元数据创建接口仍有文档和服务端测试 | 唯一待确认删除候选 |

独立「例行任务」导航虽然退出，AutomationsScreen 组件仍在设置中复用，
因此没有例行任务接口因撤页变成无调用方。技能库组件已退出，但安装、审核接口仍用。
最后一项也不能归因于本次撤页：当前安装本来就使用 `/skills/import`。

如批准删除，仅移除最后一项的 HTTP 路由和文档。**不能删 `create_skill` 服务方法**，
因为 `import_skill` 仍调用它。没有额外的全局 GET `/skills` 或独立页面专属接口可删。
测试与协议类型不算实际产品 HTTP 调用方；此清单不声称审计了生产访问日志。

等待 Owner 确认保留还是删除这个公开手动创建接口。之后的删除 PR 要同步修改
`docs/API.md` 和 `docs/API.zh-CN.md`。本轮运行文档与研究门禁，不重建无关二进制；
C9/C11 不动，不自动合并。
