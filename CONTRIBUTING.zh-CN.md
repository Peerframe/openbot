# 参与 OpenBot 共建

[English source](CONTRIBUTING.md) · [简体中文](CONTRIBUTING.zh-CN.md)

感谢你帮助建设 OpenBot。项目仍处于 pre-alpha，小而边界清楚、带验收证据的修改比大规模重写
更有价值。较大的功能开始前，请先创建 Issue，说明用户结果、所属里程碑与权限边界。

英文是源码、注释、Issue、Pull Request 和项目文档的权威语言。翻译可以使用其他语言，但应与
英文原文保持一致。

## 当前贡献优先级

1. 可复现 Bug、数据丢失和安全加固；
2. 带真实设备证据的 Windows、macOS、Linux 兼容性；
3. 可靠性、恢复、可观测性和 fail-closed 行为；
4. 路线图中已经定义的小型产品闭环；
5. 文档、无障碍证据和忠实翻译；
6. 只有完成 Issue 级设计对齐后，才接受宽泛的新子系统。

如果想直接领取范围清晰的工作，请从[贡献者任务包](docs/CONTRIBUTOR_TASKS.zh-CN.md)开始。

## 从哪里开始

| 情况 | 入口 | 必须提供的证据 |
| --- | --- | --- |
| 可复现缺陷 | Bug report | 实际/预期行为、最小复现、脱敏环境 |
| 产品或架构变化 | Feature request | 验收路径、上游审查、权限边界 |
| 新运行时或电脑集成 | Provider integration | 固定上游、精确能力、负向测试、目标平台证据 |
| 安全漏洞 | Private Security Advisory | 影响和最小安全复现；不要创建公开 Issue |
| 只是安装疑问 | 现有文档；启用后使用 Discussions | 没有可复现缺陷时不要创建 Bug |

主要代码区域：产品和移动端体验在 `apps/web`；控制平面与实时同步在 `apps/server`、
`packages/db`；Node 协议在 `apps/node`、`packages/protocol`；电脑集成在 `providers/*` 与
`packages/provider-sdk`；策略和安全在 `packages/policy`、`docs/SECURITY.md`；可选体验在
`packages/office-plugin`。

## 本地开发

需要 Node.js 22.22.2（CI 基线）、npm 10.9.9、Docker 和 Docker Compose。其他 Node.js 版本必须满足 `package.json` 的精确 engines 范围。使用 `npm ci` 复现已提交的锁文件。模块职责、扩展入口和定向检查见[仓库地图](docs/REPOSITORY_MAP.zh-CN.md)。

```bash
git clone https://github.com/yxflc11/openbot.git
cd openbot
cp .env.example .env
```

先替换 `.env` 中的 `OPENBOT_OWNER_PASSWORD`，再运行：

```bash
npm ci
npm run db:up
npm exec -- turbo run dev --filter=@openbot/server --filter=@openbot/web
```

保持终端运行。Turbo 会先构建所需共享包，再启动 Server/Web。打开 `http://localhost:5173`，
使用 `.env` 中的 Owner 密码登录；Server 使用端口 `3001`。这已足够进行前端和控制平面开发。
原生 Agent 需要在模型设置里明确启用。已有 checkout 应保留原 `.env` 和数据目录。

做一次小型 UI 修改时，先通过[仓库地图](docs/REPOSITORY_MAP.zh-CN.md)定位组件，在开发命令
运行期间修改并检查真实页面。例如频道成员菜单位于
`apps/web/src/components/ChannelMembersMenu.tsx`；另开终端运行定向测试：

```bash
npm exec --workspace @openbot/web -- vitest run src/components/ChannelMembersMenu.test.tsx
```

### 按需启动开发 Node

全新 Node 必须先登记。保持 Server/Web 运行，在仓库根目录另开终端：

```bash
npm run node:enrollment-token -- local-development-node
```

该命令以配置的 Owner 身份认证，输出短期有效的 `OPENBOT_NODE_ENROLLMENT_TOKEN=...`。
将该行放入私有 `.env`，确认 `OPENBOT_NODE_ID=local-development-node`，然后构建所需共享包
并启动 Node：

```bash
npm exec -- turbo run dev --filter=@openbot/node
```

登记成功后只删除 `.env` 中的一次性 token 行，保留已保存的身份凭据。示例配置下文件是
`apps/node/data/node/identity.json`，因为 Node 开发命令的工作目录为 `apps/node`；切换工作目录
时应使用绝对路径。重启会复用凭据，无需重新签发 token。token 过期或被拒绝时由 Owner 重新
签发，不得用任意 bearer 凭据绕过登记。未配置兼容 Provider 的 Node 不上报执行能力，适配器
说明见 [Provider 符合性](docs/PROVIDER_CONFORMANCE.zh-CN.md)。根目录 `npm run dev` 会启动
所有开发 workspace，前提是所需 Node 身份已就绪；它不作为全新克隆的第一步。

修改 schema 前运行只读命令
`npm run migration:plan --workspace @openbot/db -- --name describe_change`，并遵循
[手写迁移契约](docs/DATABASE.zh-CN.md#编写迁移)。自动 `generate` 已停用。

提交 PR 前运行：

```bash
npm run check
npm audit
```

开发数据库暂时不用时运行 `npm run db:stop`。

## 工程规则

- 非简单功能先查维护中的 GitHub 仓库与开放标准，在 Issue、ADR 或
  [功能调研记录](docs/research/README.zh-CN.md)中写明搜索词、候选、固定版本、许可证和选择，
  完成记录后才能开始实现。
- 选择顺序是开放标准、正式依赖、薄适配器、向上游贡献、窄 fork，最后才是有文档依据的本地
  差集。
- Server 始终保存任务、审批、身份、策略和审计的唯一真相。
- 模型、网页、技能、外部消息和执行环境默认都不可信。
- 新能力必须同时给出默认拒绝行为、失败模式和验证计划。
- 注释使用英文，只解释安全边界、并发不变量、协议顺序、回滚或不明显的上游约束；不要复述
  下一行代码。
- 不提交凭证、Cookie、私人对话、含秘密截图或真实用户数据。
- README 不堆大型架构图；使用简短文本流程、表格和专门文档链接。

根目录的 [AGENTS.md](AGENTS.md) 同时约束人工和自动化贡献者。扩展旧代码前，先在
[追溯复用账本](docs/OPEN_SOURCE_REUSE.zh-CN.md)找到对应条目；缺失或标记不完整时先补审查。

## 提交 Pull Request

1. Fork 仓库并建立单一目的分支，例如 `fix/dialog-focus`。
2. 一个 PR 只解决一条验收路径，并关联对应 Issue。
3. 在最低有效边界加测试；跨组件行为再补集成测试。
4. 运行 `npm run check`，并记录真实设备、浏览器或辅助技术证据。
5. 用户可见行为变化时，同步英文权威文档和维护中的翻译。
6. 填完 PR 模板中所有适用部分。
7. 保留上游版权和许可证声明，并说明是否复制或实质改编源码。
8. 披露 AI/自动化辅助工具以及人工复核范围；生成结果本身不能代替验收证据。

所有新源码按仓库 MIT 许可证贡献，除非对应目录包含更具体的上游声明。
