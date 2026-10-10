# OpenBot 仓库地图

[English](AGENTS.md) · 简体中文

这是给编码智能体和贡献者的地图。先读这里，再只读你要改的路径的本地规则和代码。子目录里的 `AGENTS.md`
对该目录生效。环境搭建和完整贡献流程见[贡献指南](CONTRIBUTING.zh-CN.md)。以英文版为准。

## 东西在哪里

| 路径 | 是什么 |
| --- | --- |
| `apps/web` | React 网页界面（[规则](apps/web/AGENTS.md)、[设计入口](docs/design/README.md)） |
| `apps/desktop` | 在本机运行产品的轻量 Electron 外壳（[规则](apps/desktop/AGENTS.md)） |
| `apps/server-ts` | TypeScript 控制面，所有接口的迁移目标（[规则](apps/server-ts/AGENTS.md)、[ADR-0050](docs/decisions/0050-typescript-control-plane.md)） |
| `apps/server-python` | Python 控制面，按 ADR-0050 逐组退役（[规则](apps/server-python/AGENTS.md)） |
| `apps/node`、`providers/*` | 工作节点和执行提供方 |
| `packages/protocol` | 共享的接口契约（[规则](packages/protocol/AGENTS.md)） |
| `packages/db` | PostgreSQL 表结构和迁移 |
| `packages/harness` | Python 智能体运行时（[规则](packages/harness/AGENTS.md)） |
| `experiments/*` | CI 仍在运行的探针和测试夹具，不是产品代码 |
| `tests/oracles/legacy-server` | 冻结的对照输入，绝不作为产品后备（[规则](tests/oracles/legacy-server/AGENTS.md)） |
| `docs/decisions` | ADR：已采纳的架构决定 |
| `docs/research` | 单个决定的依据；只打开你需要的那一篇 |

`apps/server` 只剩一份退役说明。[REPOSITORY_MAP](docs/REPOSITORY_MAP.md) 列出常见任务的入口和代表性测试。

## 工作流程

按任务选一个读：[openbot-change](.agents/skills/openbot-change/SKILL.md)（实现一项改动）、
[openbot-check](.agents/skills/openbot-check/SKILL.md)（选择检查、排查失败）、
[openbot-ui](.agents/skills/openbot-ui/SKILL.md)（网页或桌面界面）、
[openbot-review](.agents/skills/openbot-review/SKILL.md)（审查改动）。它们是贡献流程，不是 Employee 技能或产品资源。

## 检查

- 开发中，跑你所改包的相关测试。
- 交付代码前，跑 `npm run check`。
- 改界面或控制面时，再跑 `npm run ui:acceptance -- --entry ts`，必须显示 `PASS 12/12`。
- 只改文档时，跑 `npm run docs:check` 即可。

## 先调研再实现

新依赖或新版本、公开协议、授权或安全边界、持久化数据、重要的架构选择，都要先有依据再写代码：比较仍在维护的方案，
固定所审查的版本，优先用标准或已发布的组件而不是自己写，并把决定记在 ADR、调研记录或 PR 里，说明是否复制了源码。
扩展现有代码前先查 [OPEN_SOURCE_REUSE](docs/OPEN_SOURCE_REUSE.md)。细节见[贡献指南](CONTRIBUTING.zh-CN.md)。

## 产品和安全边界

- Server 是 Employee 身份、授权、路由、审批和审计的唯一可信来源。
- 模型、网页、导入的技能、消息、Worker Host 和 Provider 都不可信。
- 能力不等于授权。新的副作用需要明确的策略、失败即拒绝、有界的输入输出和测试。
- 平台、无障碍和安全支持，只按一致性文档里的证据声明。
- Employee 的学习方向受 Hermes Agent 启发，保留这一出处说明。
- 办公室可视化是延后的可选插件，只有里程碑要求时才扩展。

## 工作规则

- 代码、注释、ADR 和文档以英文为准。只有这些保留中文翻译：面向用户的文档（根目录 README、`THIRD_PARTY_NOTICES`，
  以及 `docs/` 里的安装、新手引导、Windows 桌面版、节点注册、插件和跨平台说明）、贡献入口（`AGENTS`、`CONTRIBUTING`）
  和 `docs/design`。
- 注释解释权限、安全、并发、生命周期和上游约束，不复述语法。
- 迁移用的临时代码要在代码注释里写明退出条件，例如 `// Remove in P5`。
- 每个新源文件开头写一句注释，说明它是做什么的。计划、进度和交接写在 PR 或 issue 里；调研记录必须被它支撑的决定、
  代码或文档链接到。`npm run docs:check` 会自动检查这些（[整洁度检查](scripts/check-hygiene.ts)）。
- 同一时间一个文件只有一个人在改。绝不提交凭证、私人记录、本机路径或含用户数据的截图。
- 推送、合并、发布、付费模型调用和改动生产数据，都需要所有者明确要求。
