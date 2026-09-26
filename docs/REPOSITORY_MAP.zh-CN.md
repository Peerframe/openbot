# 仓库地图

[English](REPOSITORY_MAP.md) · 简体中文

从[根规则](../AGENTS.zh-CN.md)开始，只选下面相关路线和局部规则。命令都从仓库根目录运行。
以当前 checkout 核对路径；不足时沿调用、import 或失败测试继续查，不预加载整个研究库。
启动见[贡献指南](../CONTRIBUTING.zh-CN.md)，升级状态只在[交接](REPOSITORY_UPGRADE_PLAN.md)维护。

Python 是产品控制默认实现，`apps/server` 仅保留退役说明 README；[冻结 oracle](../tests/oracles/legacy-server/AGENTS.md)
只作比较输入。核心仍在 `apps/agent-runtime-python`，`packages/harness` 和 wheel 是 C2 目标。

## UI 交互

- 规则：[Web AGENTS](../apps/web/AGENTS.md)、[设计入口](design/README.zh-CN.md)。
- 实现：[ChannelMembersMenu](../apps/web/src/components/ChannelMembersMenu.tsx)、
  [CSS](../apps/web/src/components/ChannelMembersMenu.css)、[测试](../apps/web/src/components/ChannelMembersMenu.test.tsx)，
  当前产品父级是 [App](../apps/web/src/App.tsx) 工具栏，绑定加入/移除/打开档案。
  [ChannelWorkspace](../apps/web/src/components/ChannelWorkspace.tsx) 仅在无 `globalHeader` 时内嵌菜单，
  当前 App 传入 `globalHeader`。焦点/导航修改需读取两处。
- 状态/消费者：[workspace hook](../apps/web/src/use-workspace-state.ts)、[API](../apps/web/src/api.ts)
  把 Server 事实投影到 Web 和 Desktop 共用 renderer；Work 使用
  [work-api](../apps/web/src/work-api.ts) 和 [WorkTasksScreen](../apps/web/src/components/WorkTasksScreen.tsx)。
- 检查：`npm exec -- turbo run build --filter=@openbot/web^...`，然后
  `npm exec --workspace @openbot/web -- vitest run src/components/ChannelMembersMenu.test.tsx`、
  `npm run typecheck --workspace @openbot/web`；按改动选择真实组件测试。
- 环境：`npm ci`；真实页面使用文档中的 Python Server/Web 开发入口和临时 Owner/数据库，
  检查宽窄视口及受影响状态，不需要付费模型。组件测试不等于渲染验收。桥接改动另读
  [Desktop 规则](../apps/desktop/AGENTS.md)。

## Python 核心

- 规则/契约：[runtime AGENTS](../apps/agent-runtime-python/AGENTS.md)、
  [contracts](../apps/agent-runtime-python/src/openbot_agent_runtime/contracts.py)、
  [现有研究](../apps/agent-runtime-python/RESEARCH.md#9-real-server-catalog-and-tool-correlation-integration)。
  第 9 节取代原 4/4a 节的 catalog 选择，应以当前实现为准。
- 实现：[executor](../apps/agent-runtime-python/src/openbot_agent_runtime/executor.py)、
  [catalog](../apps/agent-runtime-python/src/openbot_agent_runtime/catalog.py)、
  [bounds](../apps/agent-runtime-python/src/openbot_agent_runtime/bounds.py)。
- 消费者：控制层 [host](../apps/server-python/src/openbot_server/runtime_host.py)、
  [process](../apps/server-python/src/openbot_server/runtime_process.py)、
  [Work runtime](../apps/server-python/src/openbot_server/work_product_runtime.py) 和
  [Desktop 打包](../apps/desktop/scripts/prepare-native-server.mjs)。可选
  [Temporal 组装](../apps/agent-runtime-python/src/openbot_agent_runtime/temporal_agent.py)有独立生命周期；
  [可信端口](../apps/server-python/src/openbot_server/work_runtime_ports.py)由控制层拥有。
- 测试：[catalog/limits](../apps/agent-runtime-python/tests/test_catalog_and_limits.py)、
  [authority](../apps/agent-runtime-python/tests/test_authority.py)、
  [lifecycle](../apps/agent-runtime-python/tests/test_lifecycle.py)、
  [Temporal](../apps/agent-runtime-python/tests/test_temporal_agent.py)。
- 命令：`apps/agent-runtime-python/scripts/bootstrap.sh`，再执行
  `apps/agent-runtime-python/scripts/check.sh -k catalog`；全包检查去掉 `-k`，核对实际收集数量。
  需要 Python 3.12+；只有锁定安装联网，基础测试无需 DB、Electron、Temporal 或模型账户。
  Worker 环境见[控制层 README](../apps/server-python/README.zh-CN.md)，基础测试不证明 replay。

## 跨语言契约

- 读[协议规则](../packages/protocol/AGENTS.md)和[控制规则](../apps/server-python/AGENTS.md)。
  [protocol/src](../packages/protocol/src/index.ts)拥有 Node Zod 契约，实际消费者包括
  [Node client](../apps/node/src/client.ts)，不得另造 DTO 权威。
- Python HTTP 当前用 [work routes](../apps/server-python/src/openbot_server/work_routes.py) 与
  [work values](../apps/server-python/src/openbot_server/work_values.py)显式投影；TS 消费者是
  [work-api](../apps/web/src/work-api.ts)、[测试](../apps/web/src/work-api.test.ts)与
  [WorkTasksScreen](../apps/web/src/components/WorkTasksScreen.tsx)。Python→TS 自动生成仍是 C2 待办。
- Runtime wire：[控制校验](../apps/server-python/src/openbot_server/runtime_wire.py) ↔
  [核心 wire](../apps/agent-runtime-python/src/openbot_agent_runtime/wire.py)；
  [比较脚本](../apps/server-python/scripts/compare-runtime-wire.mjs)对照冻结 TS oracle，不能把它当活跃 Server。
  保留 missing/null、错误码、大小限制和未知字段拒绝。
- 命令：`npm run oracle:build`、`apps/server-python/scripts/bootstrap.sh`，再运行
  `node apps/server-python/scripts/compare-runtime-wire.mjs`（合成数据，无 DB/模型）。HTTP 改动另跑
  `npm exec --workspace @openbot/web -- vitest run src/work-api.test.ts` 及控制层相关测试；Node wire 跑
  `npm run test --workspace @openbot/protocol`。`npm run test:control:python` 增加临时 PostgreSQL 与差分，
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
