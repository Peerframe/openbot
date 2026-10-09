# 仓库地图

[English](REPOSITORY_MAP.md) · 简体中文

从[根地图](../AGENTS.zh-CN.md)开始，只选下面相关路线和它的局部规则。命令都从仓库根目录运行。
路线答不上来时，沿 import、调用或失败的测试继续查。环境搭建见[贡献指南](../CONTRIBUTING.zh-CN.md)。

控制面正按 [ADR-0050](decisions/0050-typescript-control-plane.zh-CN.md) 逐组从 Python（`apps/server-python`）
迁到 TypeScript（`apps/server-ts`）；改这个边界前先读 [TS 规则](../apps/server-ts/AGENTS.md)。`apps/server`
只剩退役说明，[冻结 oracle](../tests/oracles/legacy-server/AGENTS.md) 只作比较输入。Python 智能体运行时在 `packages/harness`。

## UI 交互

- 规则：[Web AGENTS](../apps/web/AGENTS.md)、[设计入口](design/README.zh-CN.md)。
- 实现：频道右栏 [ContextRail](../apps/web/src/components/ContextRail.tsx) 及其
  [测试](../apps/web/src/components/ContextRail.test.tsx)，由 [WorkspaceHeader](../apps/web/src/components/WorkspaceHeader.tsx)
  的标题胶囊打开；[App](../apps/web/src/App.tsx) 绑定加入/移除/打开档案。焦点/导航修改需读取两处。
- 状态/消费者：[workspace hook](../apps/web/src/use-workspace-state.ts)、[API](../apps/web/src/api.ts)
  把 Server 事实投影到 Web 和 Desktop 共用 renderer；Work 使用
  [work-api](../apps/web/src/work-api.ts) 和 [WorkTasksScreen](../apps/web/src/components/WorkTasksScreen.tsx)。
- 检查：`npm exec -- turbo run build --filter=@openbot/web^...`，然后
  `npm exec --workspace @openbot/web -- vitest run src/components/ContextRail.test.tsx`、
  `npm run typecheck --workspace @openbot/web`；按改动选择真实组件测试。
- 环境：`npm ci`；真实页面使用文档中的 Python Server/Web 开发入口和临时 Owner/数据库，
  检查宽窄视口及受影响状态，不需要付费模型。组件测试不等于渲染验收。桥接改动另读
  [Desktop 规则](../apps/desktop/AGENTS.md)。

## Python 核心

- 规则/契约：[runtime AGENTS](../packages/harness/AGENTS.md)、
  [contracts](../packages/harness/src/openbot_agent_runtime/contracts.py)、
  [现有研究](../packages/harness/RESEARCH.md#9-real-server-catalog-and-tool-correlation-integration)。
  第 9 节取代原 4/4a 节的 catalog 选择，应以当前实现为准。
- 实现：[executor](../packages/harness/src/openbot_agent_runtime/executor.py)、
  [catalog](../packages/harness/src/openbot_agent_runtime/catalog.py)、
  [bounds](../packages/harness/src/openbot_agent_runtime/bounds.py)。
- 消费者：控制层 [host](../apps/server-python/src/openbot_server/runtime_host.py)、
  [process](../apps/server-python/src/openbot_server/runtime_process.py)、
  [Work runtime](../apps/server-python/src/openbot_server/work_product_runtime.py) 和
  [Desktop 打包](../apps/desktop/scripts/prepare-native-server.ts)。可选
  [Temporal 组装](../packages/harness/src/openbot_agent_runtime/temporal_agent.py)有独立生命周期；
  [可信端口](../apps/server-python/src/openbot_server/work_runtime_ports.py)由控制层拥有。
- 测试：[catalog/limits](../packages/harness/tests/test_catalog_and_limits.py)、
  [authority](../packages/harness/tests/test_authority.py)、
  [lifecycle](../packages/harness/tests/test_lifecycle.py)、
  [Temporal](../packages/harness/tests/test_temporal_agent.py)。
- 命令：`packages/harness/scripts/bootstrap.sh`，再执行
  `packages/harness/scripts/check.sh -k catalog`；全包检查去掉 `-k`，核对实际收集数量。
  需要 Python 3.12+；只有锁定安装联网，基础测试无需 DB、Electron、Temporal 或模型账户。
  Worker 环境见[控制层 README](../apps/server-python/README.zh-CN.md)，基础测试不证明 replay。

## 跨语言契约

- 读[协议规则](../packages/protocol/AGENTS.md)和[控制规则](../apps/server-python/AGENTS.md)。
  [protocol/src](../packages/protocol/src/index.ts)拥有 Node Zod 契约，实际消费者包括
  [Node client](../apps/node/src/client.ts)，不得另造 DTO 权威。
- Python HTTP 当前用 [work routes](../apps/server-python/src/openbot_server/work_routes.py) 与
  [公共 Work DTO](../apps/server-python/src/openbot_server/work_models.py)显式投影；TS 消费者是
  [work-api](../apps/web/src/work-api.ts)、[测试](../apps/web/src/work-api.test.ts)与
  [WorkTasksScreen](../apps/web/src/components/WorkTasksScreen.tsx)。按已接受的
  [ADR-0050](decisions/0050-typescript-control-plane.zh-CN.md)，Work/native Task HTTP 定义已移入
  [共享 TS](../packages/protocol/src/work-http.ts)；身份/认证/工作区/读取组在
  [control HTTP](../packages/protocol/src/control-http.ts)；
  [模型/存储/附件操作](../packages/protocol/src/model-storage-openapi.ts)使用
  [模型输入](../packages/protocol/src/model-services.ts)和[存储/附件 schema](../packages/protocol/src/storage-http.ts)。
  [生命周期/审批/审计操作](../packages/protocol/src/lifecycle-http.ts)复用现有输入/wire 校验器，并明确公共响应投影。
  [Employee HTTP](../packages/protocol/src/employee-http.ts)负责 profile/知识/技能/记忆投影；
  [自动化 HTTP](../packages/protocol/src/automation-http.ts)在[自动化 DTO](../packages/protocol/src/automations.ts)上
  保留产品的 UTF-16/UTC/更新字段处理规则。
  [Node HTTP](../packages/protocol/src/node-http.ts)复用保留的注册 wire 输入和公共元数据；resource 注册表
  还负责 PNG/Markdown Run 产物下载。
  [插件 HTTP](../packages/protocol/src/plugin-http.ts)复用保留的声明/目录，
  保留 Python trim、大小写敏感 UUID 版本比较及直接字段/集合 Unicode 限额；
  [Web 插件类型](../apps/web/src/plugin-api.ts)由这些 HTTP 定义推导。
  [浏览器 HTTP](../packages/protocol/src/browser-http.ts)保留严格动作/会话投影；
  [导入导出 HTTP](../packages/protocol/src/portability-http.ts)负责预览、包、激活和回执。
  domain 的身份、会话、消息、Run、模型及 portable 类型来自共享校验器；默认注册及消费者已列入清单，
  混合入口转发和真实引擎/原生执行保留对应迁移阶段门槛。
- Runtime wire：[控制校验](../apps/server-python/src/openbot_server/runtime_wire.py) ↔
  [核心 wire](../packages/harness/src/openbot_agent_runtime/wire.py)；
  [比较脚本](../apps/server-python/scripts/compare-runtime-wire.mjs)对照冻结 TS oracle，不能把它当活跃 Server。
  保留 missing/null、错误码、大小限制和未知字段拒绝。
- 命令：`npm run oracle:build`、`apps/server-python/scripts/bootstrap.sh`，再运行
  `node apps/server-python/scripts/compare-runtime-wire.mjs`（合成数据，无 DB/模型）。HTTP 改动跑
  `npm run contracts:test` 及控制层相关测试；该命令在 Python HTTP→Web 夹具前构建共享依赖，
  冷 checkout 也走此入口。只查 Web 局部回归时，
  `npm exec --workspace @openbot/web -- vitest run src/work-api.test.ts` 要求已构建这些依赖。
  Node wire 跑 `npm run test --workspace @openbot/protocol`。
  `npm run contracts:http:python` 对真实 `serve.py` 产品入口和本次独占 PostgreSQL 执行
  [Work/resource/lifecycle/Employee/automation/browser/portability/Node/artifact/plugin/control 黑盒测试](../packages/contract-tests/README.zh-CN.md)，同时使用私有本机 MCP 夹具，不调用 Temporal/模型服务/插件工具。
  旧式插件决定只有 HTTP 拒绝路径证据；成功决定和原生持久化审批仍待验证。
  合成浏览器端验证原绑定/观察/维护及取消后有界等待；可信人控/Provider 执行仍另行验收。
  `-- --suite publisher` 用临时离线密钥和仅公开信任元数据验证签名 v1/v2 HTTP。
  `-- --suite models` 用合成 OpenAI Chat/Anthropic 传输验证真实 Owner HTTP/SQL/SDK，
  仅次数回执拒绝越权派发/重试/回退。原生 Work 决定/对账成功、取消/重放使用合成发布状态验证真实 HTTP 事务。
  真实清单保存消费者源码摘要及服务组装；实际 Web/Desktop 设置 PUT 和 Owner 文件传输以 Node Fetch 复验，
  不代表安装版 Electron/目标平台执行。
  合成等待审批/未读/审计发布状态只用于验证真实 HTTP 事务。
  产物夹具还验证原生 Work 独立8MiB 文件、空二进制下载、快照链接及完整性/no-follow 拒绝。
  SSE 验证持久变更、慢速读取合并、删除和撤权，饱和压力仍待验。用 `-- --suite control` 独占单组复验；
  `--inventory` 仍要求全部套件。
  `npm run test:control:python` 增加临时 PostgreSQL 与差分，
  Worker 覆盖还要按文档配置 `OPENBOT_TEMPORAL_TEST_PYTHON`。

## 控制与持久化

[局部规则](../apps/server-python/AGENTS.md) → [app](../apps/server-python/src/openbot_server/app.py) →
[product 组装](../apps/server-python/src/openbot_server/product_control.py)。控制层拥有身份、授权、
路由、审批、预算、Task/Action 事实与审计；[task store](../apps/server-python/src/openbot_server/task_store.py)
处理保留的提交，[Work store](../apps/server-python/src/openbot_server/work_store.py)处理持久 Work 事实。
Web/Desktop/Node 消费这些事实，SQL 历史保留在 `packages/db/migrations`。

执行 `apps/server-python/scripts/bootstrap.sh` 和 `apps/server-python/scripts/check.sh -q`；互操作
测试先 `npm run oracle:build`。基础脚本明确委派 Worker 文件，DB 测试需要临时夹具。
Schema 变化使用 `npm run migration:plan --workspace @openbot/db -- --name describe_change`、
`npm run migrations:check` 与[迁移契约](DATABASE.zh-CN.md#编写迁移)。不改已应用 SQL，不使用用户数据库验收。

## 其他局部路线

| 范围 | 所有者/入口及消费者 | 验证/环境 |
| --- | --- | --- |
| MCP 扩展 | Python `plugin_*.py`、[PLUGINS](PLUGINS.md)、Web `Plugin*` | 控制插件、Web sandbox 测试，合成 MCP 夹具 |
| Node / Provider | `apps/node/src/runtime.ts`、`providers/*`、`packages/provider-sdk`；Server 分派 | Node/Provider 测试及[一致性](PROVIDER_CONFORMANCE.zh-CN.md)；真实 Node 流程才登记 |
| 产品类型 | `packages/domain/src`；Web/Node | `npm run typecheck --workspace @openbot/domain` 和消费者构建 |
| Desktop | [局部规则](../apps/desktop/AGENTS.md)、main/preload/native-server | Desktop 测试；载荷变化需目标系统打包/安装/启停 |
| 打包/CI | `scripts`、`.github/workflows`、`deploy`；安装物和 CI | `npm run release:check`、受影响原生任务；`npm run check` 保持总检查 |
| 规则/开发 skill | 根/局部 AGENTS、`.agents/skills`、贡献/研究门 | docs/research 检查和真实发现/读取；脚本变化另跑完整 check |

## 修改与生成物

只查相关[复用条目](OPEN_SOURCE_REUSE.zh-CN.md)，按[触发规则](../CONTRIBUTING.zh-CN.md#研究依据与文档豁免)
决定是否补针对性研究；普通修复复用有效决定。追到消费者，补有意义的失败测试，同步英文和维护中的翻译。
依赖方向保持 apps → shared packages。检查取证见 [openbot-check](../.agents/skills/openbot-check/SKILL.md)。

`dist`、`node_modules`、`.turbo`、venv、Desktop `out`/`native-runtime`、`.env`、数据库和日志为生成/私有内容。
开发 skills 不进入产品资源。备份按[持久资产清单](DATABASE.zh-CN.md#备份边界)，许可见
[licenses/runtime](../licenses/runtime/README.md)；迁移历史仅为相关决定按需读取。


### 安装物与 Work HTTP 贡献检查

用 `npm run harness:check`／`npm run harness:wheel`；普通核心在 `bootstrap-quality.sh` 后运行
包内 `scripts/quality.sh --core`，默认 `quality.sh` 增加真实 Temporal／控制类型并需要 Worker 环境。
`sh apps/server-python/scripts/bootstrap-worker.sh` 把同一 wheel 安装到 Worker 环境。
构建／质量／产品依赖有独立精确锁，见[harness 设置](../packages/harness/README.zh-CN.md)。

Work/native Task、核心 control 及模型/存储/附件的公共契约来自共享 TS，Python DTO/路由保留作对照。
`npm run contracts:generate` 从共享 TS 定义生成
[Control OpenAPI](../packages/protocol/generated/control-openapi.json)、
[Work OpenAPI](../packages/protocol/generated/work-openapi.json)和[兼容类型](../apps/web/src/generated/work-contract.ts)，
`npm run contracts:check` 无需 Python 即可检查新鲜度。
[work-api](../apps/web/src/work-api.ts)使用共享校验器及推导类型，保留允许新增字段的响应投影。
先用 `apps/server-python/scripts/bootstrap.sh` 准备控制层基础环境，再运行 `npm run contracts:test`，
该命令会构建冷环境缺少的共享依赖，验证真实 Python HTTP 序列化及状态到 Web 的兼容性。
直接调用 Vitest 依赖已有构建输出；正式命令无需 DB 或模型。Node wire 契约仍归 `packages/protocol`。

### CI 选择与安装物资格

本地已跟踪/未跟踪变化用 `npm run ci:scope -- --local`；已提交 PR 用已核实的 `--base SHA --head SHA`。
`npm run check:affected` 接受同样的显式参数，只跑校验 lane，并列出其他必需 job；`npm run check`
仍是仓库总检查。策略在 [ci-selection](../scripts/ci-selection.ts)，[汇总](../scripts/ci-results.ts)只接受必需项成功；
反例用 `npm run ci:check`。CI 改动先读[贡献规则](../CONTRIBUTING.zh-CN.md#必要-ci-全部完成)。
当前适用检查由实际脚本和工作流决定。
