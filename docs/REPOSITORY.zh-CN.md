# 仓库策略

[English](REPOSITORY.md) · [简体中文](REPOSITORY.zh-CN.md)

## 决定

基础产品采用**单一 monorepo**。构建和验证初始 Server–Node 协议与产品界面无需上游 fork。

| 仓库 | 当前必需 | 职责 |
| --- | --- | --- |
| `openbot` | 是 | Web、Server、Node、共享契约、Provider、部署和文档 |
| `openbot-node` | 否 | Node 需要独立发布／安全边界时再拆分 |
| `openbot-site` | 否 | 公开网站拥有独立生命周期时再拆分 |
| 上游 fork | 否 | 实验确认必须修改源码后，才建立小范围 fork |

当前最少需要 1 个仓库；若 Node daemon 需要独立签名和发布，未来可能增加为 2 个。
文档／营销仓库可独立存在，但不属于产品基础的要求。

## 工作区地图

| 位置 | 当前职责 |
| --- | --- |
| `apps/web` | Web／PWA 工作、监督和产物界面 |
| `apps/desktop` | 薄 Electron 客户端及打包运行环境生命周期 |
| `apps/server` | 过渡期 TypeScript 业务 Server／默认实现 |
| `apps/server-python` | 候选 Python 权威层、API 和可信服务 |
| `apps/agent-runtime-python` | 可独立验证的 Python Agent Runtime |
| `apps/node` | 可替换的执行节点 daemon |
| `packages/config` | 经验证的环境契约 |
| `packages/db` | PostgreSQL schema 和迁移 |
| `packages/domain` | 产品实体 |
| `packages/policy` | 默认拒绝的策略求值 |
| `packages/protocol` | 有版本的 Server–Node 和事件契约 |
| `packages/provider-sdk` | 执行 Provider 接口 |
| `packages/python-node-runtime` | 保留的 Node 解析依赖闭包 |
| `packages/employee-publisher` | 保留的 publisher 密钥与签名包辅助工具 |
| `packages/mcp-example` | 保留的 MCP 脚手架实现 |
| `providers` | Docker、CUA、Lume、Coder 等执行适配 |
| `deploy` | Server 和 Node 部署 |
| `docs` | 项目文档 |
| `tests/oracles` | 冻结的迁移比较输入，禁止用于产品运行 |
| `.github` | 仓库自动检查与协作配置 |

本表说明迁移主要路径的职责，不穷举目录。[迁移计划](ARCHITECTURE_MIGRATION_PLAN.zh-CN.md)
与[交接](MIGRATION_HANDOFF.zh-CN.md)区分已整合候选和已验收默认实现。
无论使用何种语言，Server 始终是身份、策略、路由、审批和审计的唯一权威。
Web 使用契约，Provider 实现执行接口。应用组装保持明确，只在本次行为变化需要时拆分已有模块。
office 可视化继续作为延后可选插件。

## 拆分条件

以下条件至少满足两项时，才把 Node 移入独立仓库：

- Node 与 Server 需要独立发布节奏；
- macOS 签名／公证不能共用主流水线；
- 外部 Provider 维护者需要更窄的权限边界；
- 协议已覆盖多个受支持版本的兼容测试；
- 用户需要安装 Node，而不获取 Server／Web 源码或依赖。

在此之前，一次提交应能同时更新协议、Server 与 Node。
