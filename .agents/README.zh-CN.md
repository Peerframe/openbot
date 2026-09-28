# OpenBot 开发入口

[English](README.md) · 简体中文

本目录保存面向贡献者和编码 Agent 的仓库开发导航与 skills，与 Employee 技能和产品运行资源分开。

先读[根规则](../AGENTS.zh-CN.md)，在[仓库地图](../docs/REPOSITORY_MAP.zh-CN.md)中选择一条相关路线，
再读目标路径的局部规则、契约、消费者和代表测试。环境准备与适用验证统一维护在
[贡献指南](../CONTRIBUTING.zh-CN.md#ai-开发入口与验证)。

## 按任务选择工作流

| 任务 | Skill |
| --- | --- |
| 实施有界修改 | [openbot-change](skills/openbot-change/SKILL.md) |
| 选择检查并定位失败 | [openbot-check](skills/openbot-check/SKILL.md) |
| 修改或检查 Web/Desktop 界面 | [openbot-ui](skills/openbot-ui/SKILL.md) |
| 审查固定 diff 及其证据 | [openbot-review](skills/openbot-review/SKILL.md) |

只读与当前任务有关的工作流。技能仍在 `.agents/skills`；本 README 只提供导航，不是第二份规则源，
也不保证客户端自动加载。实际客户端发现方式与显式读取回退见
[贡献指南](../CONTRIBUTING.zh-CN.md#ai-开发入口与验证)。

## 沿已有职责入口阅读

- UI：[设计入口](../docs/design/README.zh-CN.md)、现有组件及其消费者。
- 架构与复用：[仓库策略](../docs/REPOSITORY.zh-CN.md)、[复用证据](../docs/OPEN_SOURCE_REUSE.zh-CN.md)
  和[研究指南](../docs/research/README.zh-CN.md)。只打开受影响的决定，不预加载整个研究库。
- 产品与平台文档：[文档索引](../docs/README.zh-CN.md)。

[已完成升级记录](../docs/REPOSITORY_UPGRADE_PLAN.md)与[迁移历史](../docs/MIGRATION_HANDOFF.zh-CN.md)
保留带日期的决定、验证和限制，不是常驻待办。开始前核对当前请求、checkout 与版本，保留已有本地
结案记录和用户改动。
