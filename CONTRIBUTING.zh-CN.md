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

如果想直接领取范围清晰的工作，请从[贡献者任务包](docs/CONTRIBUTOR_TASKS.zh-CN.md)开始。

## 从哪里开始

| 情况 | 入口 | 必须提供的证据 |
| --- | --- | --- |
| 可复现缺陷 | Bug report | 实际/预期行为、最小复现、脱敏环境 |
| 产品或架构变化 | Feature request | 验收路径、上游审查、权限边界 |
| 新运行时或电脑集成 | Provider integration | 固定上游、精确能力、负向测试、目标平台证据 |
| 安全漏洞 | Private Security Advisory | 影响和最小安全复现；不要创建公开 Issue |
| 只是安装疑问 | 现有文档；启用后使用 Discussions | 没有可复现缺陷时不要创建 Bug |

主要代码区域：产品和移动端体验在 `apps/web`；控制平面与实时同步在 `apps/server-python`、
`packages/db`；Node 协议在 `apps/node`、`packages/protocol`；电脑集成在 `providers/*` 与
`packages/provider-sdk`；策略和安全在 `packages/policy`、`docs/SECURITY.md`；可选体验在
`packages/office-plugin`。当前 Python 执行核心在 `packages/harness`，验证及真实消费者安装同一 wheel；聚焦命令见该包 README。

## 本地开发

需要 Node.js 22.22.2（CI 基线）、npm 10.9.9、Python 3.12+、Docker 和 Docker Compose。其他 Node.js 版本必须满足 `package.json` 的精确 engines 范围。使用 `npm ci` 复现已提交的锁文件。模块职责、扩展入口和定向检查见[仓库地图](docs/REPOSITORY_MAP.zh-CN.md)。

```bash
git clone https://github.com/Peerframe/openbot.git
cd openbot
cp .env.example .env
```

先替换 `.env` 中的 `OPENBOT_CONTROL_OWNER_PASSWORD`，再运行：

```bash
npm ci
apps/server-python/scripts/bootstrap-worker.sh
npm run db:up
npm run dev
```

保持终端运行。`scripts/dev-python.mjs` 先校验锁定 Worker 环境，通过 Turbo 构建共享包，再启动 Python Server/Web。打开 `http://localhost:5173`，
使用 `.env` 中的 Owner 密码登录；Server 使用端口 `3001`。这已足够进行前端和控制平面开发。
执行 Work 另需明确的模型设置与 mTLS Temporal 配置；启动 API 不会创建引擎。已有 checkout 应保留原 `.env` 和数据目录。
使用临时数据库复现 CI 的全新启动流程，见 [Server 启动冒烟说明](apps/server-python/README.zh-CN.md)。

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
npm run dev:node
```

登记成功后只删除 `.env` 中的一次性 token 行，保留已保存的身份凭据。示例配置下文件是
`apps/node/data/node/identity.json`，因为 Node 开发命令的工作目录为 `apps/node`；切换工作目录
时应使用绝对路径。重启会复用凭据，无需重新签发 token。token 过期或被拒绝时由 Owner 重新
签发，不得用任意 bearer 凭据绕过登记。未配置兼容 Provider 的 Node 不上报执行能力，适配器
说明见 [Provider 符合性](docs/PROVIDER_CONFORMANCE.zh-CN.md)。根目录 `npm run dev` 只启动
Server/Web；Node 完成登记后按需另启。前端和控制平面开发不要求启动 Node。

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

- 普通修复和接线复用已有决定。新增依赖/版本、公共协议、授权/安全或持久数据边界及重大架构
  选择，才在实现前补针对性证据。按[根触发规则](AGENTS.zh-CN.md#实现前调研)和
  [研究指南](docs/research/README.zh-CN.md)只审查受影响的决定。
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
[追溯复用账本](docs/OPEN_SOURCE_REUSE.zh-CN.md)找到对应条目；缺失或不完整时只补本次相关证据，不重复全栈调查。

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

范围基于 npm 锁文件的传递消费者图及少量 Python、Desktop 动态和打包映射。
`npm run ci:check` 包含选择/汇总反例和真实缓存/零测试验证。无局部测试的包不再暴露虚假的
测试成功任务，明确依靠消费者覆盖及局部缺口。职责和产物归属见[唯一交接](docs/REPOSITORY_UPGRADE_PLAN.md#c3-check-duties-and-artifact-ownership)。

使用 npm 入口（`npm run` / `npm exec -- turbo`），让缓存通过 `npm_config_user_agent`
纳入实际 npm、Node、OS、架构身份，以及源码、锁依赖图、生成器、配置和声明的运行环境。
没有该身份的独立 Turbo 调用不作为资格证据。CI 仅复用 npm 下载缓存，不恢复过去的 Turbo 测试
成功结果；本地缓存结果须明确标注。根级门和真实 Python、Temporal、安装物探针在此缓存之外。
并行 job 各有 checkout，同一 job 先构建再打包并复用产物；过时 PR 可取消，main 与标签发行保留各自生命周期。

安全检查覆盖 `npm audit --omit=dev --audit-level=high` 及 `sh scripts/audit-python.sh`。
后者用隔离、固定版本工具审计精确 Python 生产闭包，拒绝遗漏、跳过和已知公告；网络失败不算
干净审计。普通 PR 通过不代表已有无签名安装物、签名/公证或发行资格；载荷变化仍需在受支持目标
验证真实包的启动、拒绝和清理。

### 依赖更新流程

npm、GitHub Actions 和 Docker 通过 `open-pull-requests-limit: 0` 暂停普通版本自动提议。
安全更新不受该上限限制，仍可提出；它们同样需要研究和完整的受保护 CI。仓库安全更新
开关与此配置文件分开管理。

普通更新先选择有限批次，审查精确上游版本和已有复用记录，写入研究证据，再同步修改
manifest 与锁文件。触发 CI 前填写 PR 的七项研究字段，执行干净安装和 `npm run check`，
等待最新云端 `check` 通过后合并。Dependabot 自动发布说明是待审提议，不能视为已完成研究。
参见[流程决定](docs/research/dependency-update-intake.zh-CN.md)。

具备持续维护的研究流程后再恢复普通自动提议。修改 Dependabot 配置会立即扫描；上限指
同时开放的 PR 数量，并非每周总量。恢复时保留安全更新和既有主版本限制。

### 研究依据与文档豁免

根据实际差异选择 PR 证据，不能只看“修复”标题：

| 变化 | 证据 |
| --- | --- |
| 既定决定内的普通修复/接线 | 引用原决定、范围、不变假设及相关回归，不新做候选调查 |
| 新依赖/版本、公共协议、授权/安全、持久数据边界或重大架构 | 受影响选择的针对性审查、版本固定和负向/兼容测试 |
| 纯拼写、忠实翻译、段落排版 | 以下有界文字豁免，行为和主张不变 |

已有 Web 组件、runtime `bounds.py`/`catalog.py`/`errors.py` 或测试中的合格修复，可将
`## Open-source research` 下七项替换为：

```markdown
- Research reuse: docs/research/channel-member-layout.md
- Reuse scope: Restore focus after the existing member menu closes.
- Unchanged assumptions: Same event contract; dependency, protocol, authority, persistence and architecture boundaries unchanged.
- Source copied or substantially adapted: no
```

引用实际相关决定，不默认套用示例。CI 读取实际提交 base/head 的不可变 blob；缺证据、混用表单、
新产品文件、import 变化、依赖、边界所有者、规则/提示词及未知路径均不能走捷径。这是保守便利，
不是语义证明或审批；审查仍需追到消费者，识别合格路径内隐藏的权限或协议变化。

其他普通修复（包括边界文件）仍可填写原七项，引用已有审查与固定版本，**不要求新开研究循环**。
只有假设变化才重开相关决定；新增边界使用同一表单提供新针对性证据，源码引入保留许可/声明。
研究模板先判断触发与复用，不因行为变化就新建报告。

普通文字行为/主张不变时，可替换为：

```markdown
- Research exemption: spelling
- Exemption reason: Correct the README introduction's spelling; instructions and product claims are unchanged.
```

类别为 `spelling`、`translation`、`mechanical-formatting`。CI 验证实际 diff，仅根 README、普通
`docs/` Markdown 和 workspace README 可用，命令、代码、链接、标记和元数据不变。规则、skill、
提示词、ADR/研究、源码、配置、依赖和可执行位不能豁免。翻译忠实与主张不变由审查负责。表单不得
混用；只编辑 PR 正文不触发 CI；历史缺失/浅克隆时失败关闭。

### AI 开发入口与验证

按[AGENTS](AGENTS.zh-CN.md) → [仓库地图](docs/REPOSITORY_MAP.zh-CN.md)相关路线 → 局部规则、契约、
消费者和测试阅读。`.agents/skills` 提供 `openbot-change`、`openbot-check`、`openbot-ui`、
`openbot-review`，只选择当前工作流。这些是仓库开发指令，不是 Employee 技能，不得打进产品载荷。

Codex 从当前目录向仓库根查找 skills；启动规则按根到当前目录加载 AGENTS。编辑更深路径时显式
读取局部文件。客户端未刷新目录时，在该 checkout 重开会话并调用 `$openbot-change`，或读取根
AGENTS 链接的 SKILL.md，记录实际生效方式。这里未配置 Claude 集成，不复制第二套规则；未来兼容
入口必须指向 canonical AGENTS，并在实际工具中验证。

工作流修改运行 `npm run docs:check`、`npm run research:check` 和真实发现/读取验收，Markdown
不代表纯文字。纯文字/指令运行适用检查；脚本/实现修改交接前仍须 `npm run check`。必要云端及
发布/迁移/安全门不变，仅通过反例验证的 CI 选择器可以声明某 lane 不适用。记录测试数、缓存、跳过和缺失环境。

升级只维护[一份交接](docs/REPOSITORY_UPGRADE_PLAN.md)。UI 使用[既有设计索引](docs/design/README.zh-CN.md)、
tokens/组件及受影响状态。C1 新会话验收定位 UI、Python 核心和跨语言任务；C3 才执行完整贡献流程，
不能把定位成功当作后者完成。

## 提交 Pull Request

1. Fork 仓库并建立单一目的分支，例如 `fix/dialog-focus`。
2. 一个 PR 只解决一条验收路径；已有 Issue 时关联。可复现的小修复或文档纠正可以直接提交 PR，
   较大功能先用 Issue 对齐范围。
3. 在最低有效边界加测试；跨组件行为再补集成测试。
4. 运行 `npm run check`，并记录真实设备、浏览器或辅助技术证据。
5. 用户可见行为变化时，同步英文权威文档和维护中的翻译。
6. 填完 PR 模板中所有适用部分。
7. 保留上游版权和许可证声明，并说明是否复制或实质改编源码。
8. 披露 AI/自动化辅助工具以及人工复核范围；生成结果本身不能代替验收证据。

所有新源码按仓库 MIT 许可证贡献，除非对应目录包含更具体的上游声明。
