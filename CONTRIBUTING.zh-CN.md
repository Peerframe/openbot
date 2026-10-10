# 参与 OpenBot 共建

[English source](CONTRIBUTING.md) · [简体中文](CONTRIBUTING.zh-CN.md)

感谢你帮助建设 OpenBot。项目仍处于 pre-alpha，小而边界清楚、带验收证据的修改比大规模重写
更有价值。较大的功能开始前，请先创建 Issue，说明用户结果、所属里程碑与权限边界。

英文是源码、注释、Issue、Pull Request 和项目文档的权威语言。翻译可以使用其他语言，但应与
英文原文保持一致。

## 贡献者体验

OpenBot 必须方便多位独立开发者参与，不能形成只有项目负责人才能操作的流程。新开发者应能在
不依赖个人机器和口头背景的情况下，找到模块、启动相关本地服务、复现问题、运行定向检查并提交
可审阅的 PR。

- 启动和验证命令应适用于全新克隆。常规检查使用合成数据和确定性模型，不要求维护者的私人路径、
  凭证或付费模型账户；可选真实服务检查单独说明条件。
- 在共用契约和贡献文档附近说明 API 保证、支持的数据格式子集及失败行为，优先使用已有扩展入口。
- 回归测试保留在仓库内。需要 PostgreSQL 等环境时，提供运行命令和隔离 CI 入口；跳过的测试或
  只在维护者机器上的报告不能替代持续验证。
- 工作包保持小而清楚，说明可观察结果和可复现验证路径。沿用现有 PR 模板和检查，不增加只有
  负责人才能完成的审批环节。
- 交付时区分已实现、已验证、已合并、已发布，附上 PR 与最终检查结果，让贡献者看得到改动去向。

## 当前贡献优先级

1. 可复现 Bug、数据丢失和安全加固；
2. 带真实设备证据的 Windows、macOS、Linux 兼容性；
3. 可靠性、恢复、可观测性和 fail-closed 行为；
4. 路线图中已经定义的小型产品闭环；
5. 文档、无障碍证据和忠实翻译；
6. 只有完成 Issue 级设计对齐后，才接受宽泛的新子系统。

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
`packages/provider-sdk`；策略和安全在 `apps/server/src`、`docs/SECURITY.md`；可选体验在
`packages/office-plugin`。执行核心在 `apps/server/src/work-runtime.ts`，耐久工作流在 `packages/work`。

## 本地开发

TS 开发需要 Node.js 22.22.2（CI 基线）、npm 10.9.9、Docker、Docker Compose 和明确的 mTLS Temporal 配置。其他 Node.js 版本必须满足 `package.json` 的精确 engines 范围。使用 `npm ci` 复现已提交的锁文件。模块职责、扩展入口和定向检查见[仓库地图](docs/REPOSITORY_MAP.md)。

```bash
git clone https://github.com/Peerframe/openbot.git
cd openbot
cp .env.example .env
```

先替换 `.env` 中的 `OPENBOT_TS_OWNER_PASSWORD`，将 `OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH` 指向
已有 [Temporal 服务](deploy/temporal/README.md) 的自有配置，再运行：

```bash
npm ci
npm run db:up
npm run dev
```

保持终端运行。`scripts/dev-server.ts` 通过 Turbo 构建共享包，再启动单一 Server 和 Web。
打开 `http://localhost:5173`，使用 Owner 密码登录；Server 使用端口 3001。API 启动需要 Temporal，
不会创建引擎；执行模型任务时另需模型设置。保留已有 checkout 的 `.env` 和数据目录。
冷启动检查从没有构建产物的 checkout 运行 `npm run dev:smoke`；`OPENBOT_DEV_SMOKE_DATABASE_URL`
须指向空的本机临时数据库，名称以 `_dev_smoke` 结尾。检查自建临时 Temporal，验证真实 Web、代理和 Owner 登录。

做一次小型 UI 修改时，先通过[仓库地图](docs/REPOSITORY_MAP.md)定位组件，在开发命令
运行期间修改并检查真实页面。例如频道右栏位于
`apps/web/src/components/ContextRail.tsx`；另开终端运行定向测试：

```bash
npm exec --workspace @openbot/web -- vitest run src/components/ContextRail.test.tsx
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
npm run dev:node
```

登记成功后只删除 `.env` 中的一次性 token 行，保留已保存的身份凭据。示例配置下文件是
`apps/node/data/node/identity.json`，因为 Node 开发命令的工作目录为 `apps/node`；切换工作目录
时应使用绝对路径。重启会复用凭据，无需重新签发 token。token 过期或被拒绝时由 Owner 重新
签发，不得用任意 bearer 凭据绕过登记。未配置兼容 Provider 的 Node 不上报执行能力，适配器
说明见 [Provider 符合性](docs/PROVIDER_CONFORMANCE.md)。根目录 `npm run dev` 只启动
Server/Web；Node 完成登记后按需另启。前端和控制平面开发不要求启动 Node。

修改 schema 前运行只读命令
`npm run migration:plan --workspace @openbot/db -- --name describe_change`，并遵循
[手写迁移契约](docs/DATABASE.md#author-a-migration)。自动 `generate` 已停用。

提交 PR 前遵循[适用验证规则](#ai-开发入口与验证)：实现和脚本修改须运行 `npm run check`，
文字与贡献指令修改运行适用的文档和工作流检查。运行 `npm audit` 并满足必要的安全和托管 CI 门；
定向验证不豁免这些要求。

开发数据库暂时不用时运行 `npm run db:stop`。

## 工程规则

- 普通修复和接线复用已有决定。新增依赖/版本、公共协议、授权/安全或持久数据边界及重大架构
  选择，才在实现前补针对性证据。按[根触发规则](AGENTS.zh-CN.md#实现前调研)和
  [研究指南](docs/research/README.md)只审查受影响的决定。
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
[追溯复用账本](docs/OPEN_SOURCE_REUSE.md)找到对应条目；缺失或不完整时只补本次相关证据，不重复全栈调查。

### 必要 CI 全部完成

受保护的 `check` 把选择器的必需/不适用集合与真实 job 结果比对。安全和仓库校验始终执行；
必需项只有 success 满足，失败、取消、缺失和意外跳过均失败。main 推送保持全量资格验证。
合并前等待最终候选的云端结果；本地成功不代替原生平台、恢复或打包验证。

开发时先用 `npm run ci:scope -- --local` 查看范围，再运行 `npm run check:affected -- --local`。
本地已跟踪和未跟踪变化分别报告；PR 使用已核实的 40 位不可变提交：

```sh
npm run ci:scope -- --base "$BASE_SHA" --head "$HEAD_SHA"
npm run check:affected -- --base "$BASE_SHA" --head "$HEAD_SHA"
```

提交范围采用真实 merge base，不混入未提交文件；缺失/浅历史时失败，不猜 `origin/main`。
`check:affected` **只执行校验 lane**，另列需要的集成资格，不代表全部 CI 已通过。
实现/脚本交接前 `npm run check` 仍承担完整仓库校验。文字使用定向仓库门；AGENTS、skills、
提示词还需真实发现/读取验收。契约、锁、生成器、构建、CI 和未知输入保守选择全部集合。

范围基于 npm 锁文件的传递消费者图及少量控制面、Desktop 动态和打包映射。
`npm run ci:check` 包含选择/汇总反例和真实缓存/零测试验证。无局部测试的包不再暴露虚假的
测试成功任务，明确依靠消费者覆盖及局部缺口。

使用 npm 入口（`npm run` / `npm exec -- turbo`），让缓存通过 `npm_config_user_agent`
纳入实际 npm、Node、OS、架构身份，以及源码、锁依赖图、生成器、配置和声明的运行环境。
没有该身份的独立 Turbo 调用不作为资格证据。CI 仅复用 npm 下载缓存，不恢复过去的 Turbo 测试
成功结果；本地缓存结果须明确标注。根级门和真实控制面、Temporal、安装物探针在此缓存之外。
并行 job 各有 checkout，同一 job 先构建再打包并复用产物；过时 PR 可取消，main 与标签发行保留各自生命周期。

锁定安装后通过 `npm audit --omit=dev --audit-level=high` 审计生产依赖。
生产包依赖图和安装物检查拒绝缺失、开发专用或陈旧依赖；网络失败不算干净审计。普通 PR 通过不代表已有无签名安装物、签名/公证或发行资格；载荷变化仍需在受支持目标
验证真实包的启动、拒绝和清理。

### 依赖更新流程

npm、GitHub Actions 和 Docker 通过 `open-pull-requests-limit: 0` 暂停普通版本自动提议。
安全更新不受该上限限制，仍可提出；它们同样需要研究和完整的受保护 CI。仓库安全更新
开关与此配置文件分开管理。

普通更新先选择有限批次，审查精确上游版本和已有复用记录，写入研究证据，再同步修改
manifest 与锁文件。触发 CI 前填写 PR 的研究部分，执行干净安装和 `npm run check`，
等待最新云端 `check` 通过后合并。Dependabot 自动发布说明是待审提议，不能视为已完成研究。
参见[流程决定](docs/research/dependency-update-intake.md)。

具备持续维护的研究流程后再恢复普通自动提议。修改 Dependabot 配置会立即扫描；上限指
同时开放的 PR 数量，并非每周总量。恢复时保留安全更新和既有主版本限制。

### 研究依据与文档豁免

仅当 PR 修改依赖（`package.json` 依赖字段、锁文件、Python requirements 或 `pyproject.toml`）、
容器基础镜像，或协议、安全、持久化契约（`packages/protocol/`、迁移、schema、entitlements）时，
CI 才要求 PR 正文包含 `## Open-source research`：其中需链接一份研究记录、ADR 或此前的 PR，
并写明 `Source copied or substantially adapted: yes|no`。其他 PR 自动豁免。

重要且持久的决定确需 ADR 时，按决定调整[提纲](docs/decisions/TEMPLATE.md)。审查理由、后果及
必要来源，不按编号或目录要求固定标题；现有 ADR 无须迁移格式。

### AI 开发入口与验证

[开发入口](.agents/README.zh-CN.md)链接已有工作流与职责。
按[AGENTS](AGENTS.zh-CN.md) → [仓库地图](docs/REPOSITORY_MAP.md)相关路线 → 局部规则、契约、
消费者和测试阅读。`.agents/skills` 提供 `openbot-change`、`openbot-check`、`openbot-ui`、
`openbot-review`，只选择当前工作流。这些是仓库开发指令，不是 Employee 技能，不得打进产品载荷。

Codex 从当前目录向仓库根查找 skills；启动规则按根到当前目录加载 AGENTS。编辑更深路径时显式
读取局部文件。客户端未刷新目录时，在该 checkout 重开会话并调用 `$openbot-change`，或读取根
AGENTS 链接的 SKILL.md，记录实际生效方式。这里未配置 Claude 集成，不复制第二套规则；未来兼容
入口必须指向 canonical AGENTS，并在实际工具中验证。

工作流修改运行 `npm run docs:check`、`npm run research:check` 和真实发现/读取验收，Markdown
不代表纯文字。纯文字/指令运行适用检查；脚本/实现修改交接前仍须 `npm run check`。必要云端及
发布/迁移/安全门不变，仅通过反例验证的 CI 选择器可以声明某 lane 不适用。记录测试数、缓存、跳过和缺失环境。

以当前请求和 checkout 为起点，保留本地结案记录。UI 使用
[既有设计索引](docs/design/README.zh-CN.md)、现有 tokens/组件及受影响状态。
发现/读取验收只证明可以找到职责和检查，不代表实现、渲染验收或托管 CI 已完成。

整体界面验收运行 `npm run ui:acceptance`，默认使用 TS，`--entry python` 会被拒绝。
先构建 `@openbot/server`、`@openbot/web` 并启动 Docker。命令自建临时 PostgreSQL 和 mTLS Temporal，
由真实 Server 提供构建后的 Web，驱动已安装 Chrome（`--browser` 可指定其他浏览器），输出收据和截图。
每次较大退役改动后，当前候选须达到 `PASS 12/12`。非预期 503 会使验收失败，应检查对应步骤及自有服务日志。
此流程无需 Python 环境；见[验收记录](docs/research/ui-acceptance-automation.md)。

## 提交 Pull Request

1. Fork 仓库并建立单一目的分支，例如 `fix/dialog-focus`。
2. 一个 PR 只解决一条验收路径；已有 Issue 时关联。可复现的小修复或文档纠正可以直接提交 PR，
   较大功能先用 Issue 对齐范围。
3. 在最低有效边界加测试；跨组件行为再补集成测试。
4. 运行[适用检查](#ai-开发入口与验证)，实现/脚本修改包含 `npm run check`；
   记录真实设备、浏览器或辅助技术证据。
5. 用户可见行为变化时，同步英文权威文档和维护中的翻译。
6. 填完 PR 模板中所有适用部分。
7. 保留上游版权和许可证声明，并说明是否复制或实质改编源码。
8. 披露 AI/自动化辅助工具以及人工复核范围；生成结果本身不能代替验收证据。

所有新源码按仓库 MIT 许可证贡献，除非对应目录包含更具体的上游声明。
