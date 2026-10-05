# 控制平面迁回 TypeScript：任务与仓库规划

[English](typescript-control-plane-plan.md) · 简体中文

- 状态：提议（作为 Codex 写 ADR 的输入；所有者批准前不改产品代码）
- 日期：2026-10-05
- 负责人：@yxflc11
- 相关：所有者 2026-10-05 的要求；[架构迁移计划](../ARCHITECTURE_MIGRATION_PLAN.zh-CN.md)；
  [Temporal ADR 0046](../decisions/0046-temporal-as-recovery-owner.md)
- 验收路径：桌面应用和网页客户端连到 TypeScript 控制平面后照常使用，安装包里不再带 Python；所有公开的 HTTP 和
  事件契约，都通过和 Python 时一样的契约测试。
- 安全边界：不变。服务电脑仍是身份、授权、路由、审批和审计的唯一依据；迁过去的每个接口必须保留完全相同的检查。

## 为什么

所有者的原因，按重要程度：

1. **统一语言**：网页、桌面、Node 辅助程序、Provider 和数据库结构都已经是 TypeScript，只有控制平面是 Python。
   统一后类型直接共享，不用再从 Python 生成 TS；只剩一套工具链；前后端改动可以放在同一个 PR 里。
2. **部署更简单**：桌面应用现在要打包 Electron、一整套独立的 CPython 3.12 和 63 个包、额外的 Node 24、PostgreSQL。
   Electron 本身就带 Node，换成 TypeScript 后可以去掉 Python 和额外的 Node。这项收益要等最后一个 Python 模块
   退出后才兑现。
3. **性能**：控制平面大部分时间在等模型、PostgreSQL 和 Temporal，换语言不会让这些变快。预计改善的是启动时间和
   内存。要实测，不要凭印象。

## 现在有什么

`apps/server-python/src/openbot_server`：175 个模块约 32,000 行（加上 141 个测试文件约 80,000 行）。按领域：

| 领域 | 行数 | 模块 |
| --- | ---: | ---: |
| 任务执行与恢复（Temporal） | 14,300 | 73 |
| Bot 档案、知识、导入导出 | 2,500 | 12 |
| HTTP、数据库和通用代码 | 2,300 | 14 |
| 模型连接与调用 | 2,200 | 9 |
| 任务与运行 | 1,900 | 15 |
| 身份与安全 | 1,600 | 12 |
| 运行时宿主 | 1,500 | 6 |
| 插件 | 1,400 | 5 |
| 工作主机 | 1,200 | 5 |
| 附件与存储 | 1,100 | 6 |
| 员工浏览器 | 700 | 4 |
| 对话与消息 | 500 | 7 |
| 例行任务、审批、审计 | 600 | 4 |

已经是 TypeScript、可以直接复用的：PostgreSQL 结构和迁移（`packages/db`，Drizzle）、契约（`packages/protocol`）、
领域类型、网页和桌面客户端、Node 与工作主机、Provider、文档和 OCR 解析（pdf.js、tesseract.js、officeparser）。
`tests/oracles/legacy-server` 里冻结的旧 TS 服务只当测试输入，不会复活。

## 推荐做法：按接口分组逐组替换

一次性重写会让交付停几个月，而且没有可以对照的东西。改为：新的 TypeScript 服务一次接管一组接口，其余仍由 Python
处理；两边共用同一个数据库；由一套共享的契约测试决定某组什么时候可以切换。

- **契约优先**：`packages/protocol`（zod）成为所有公开请求、响应、错误和事件的唯一定义。JSON Schema 和 API 文档由它
  生成；开始迁移任何接口之前，先用契约测试检查 Python 符合它。
- **一个入口**：尽早让 TypeScript 服务成为 HTTP 入口，它还没接管的接口全部转给 Python。客户端地址不变；切换一组接口
  只是改一条路由，随时可以撤回。
- **共用数据，不复制**：两边用同一个 PostgreSQL 和同一套 `packages/db` 迁移。会话、版本号和审计都在数据库里，所以
  请求由哪一边处理都可以。
- **Temporal 按任务队列切换**：新的工作流类型由 TypeScript worker 在自己的队列上处理；Python worker 把已经在跑的工作流
  做完。只有当某类工作流在 Python 上没有未结束的记录，或者重放测试证明兼容时，才整类迁走。
- **先删再迁**：不再需要的先退役（例如 C28 的旧版单一模型设置），就不用迁了。

## 阶段与任务

除非注明，每项任务是一个 PR。「关卡」是进入下一阶段前必须满足的条件。

| 阶段 | 任务 | 谁做 | 关卡 |
| --- | --- | --- | --- |
| **P0 · 决定** | ADR：比较保持 Python、一次性重写、本方案的逐组替换、长期分工四种方案；依赖对照表（确切版本和许可）：FastAPI → Fastify 或 Hono，psycopg → node-postgres 加 Drizzle，Pydantic AI 和各家 SDK → Anthropic、OpenAI 等官方 TS SDK，Temporal Python → Temporal TS；测出现在桌面版的启动时间、内存和安装包大小作为基线 | Codex | 所有者批准 ADR |
| **P1 · 契约** | 把所有公开的 DTO、错误和事件移到 `packages/protocol` 的 zod；由它生成 JSON Schema 和 `docs/API.md`；新建 `packages/contract-tests`，一套可以对任何服务地址运行的黑盒测试；先对 Python 跑到全部通过 | Codex；Claude 把网页客户端换成新类型 | 测试在 Python 上全部通过，行为不变 |
| **P2 · 入口** | `apps/server-ts`：健康检查、日志、配置、Owner 会话校验；其他接口（和事件流）全部转给 Python；桌面应用同时启动两个；测出转发带来的额外开销 | Codex；Claude 检查每个界面都正常 | 全部测试和桌面使用流程不变；开销已测出 |
| **P3a · 小模块** | 例行任务、审批设置、审计、Owner 偏好、存储设置和读取类接口 | Codex | 这组在 TypeScript 上通过契约测试；切换；删除 Python 里对应的代码 |
| **P3b · 身份** | 登录、会话、密码、Origin 检查、Owner 安全 | Codex，做安全审查 | 同 P3a，并通过身份验证的反向测试 |
| **P3c · 产品功能** | 对话与消息、频道、Bot 档案外观知识、插件、附件与存储、员工浏览器、工作主机 | Codex，分多个 PR | 每组都同 P3a |
| **P3d · 模型** | 模型连接、验证和调用，换成官方 TS SDK（在 C28 去掉旧版单一设置之后） | Codex | 同上，并使用录制好的模型回放；CI 里不产生付费调用 |
| **P4 · 任务执行与运行时** | 任务与运行、Temporal 工作流和活动（TS SDK）、运行时宿主和 Worker 协议；把 Python 上的工作流跑完 | Codex，最大的一段 | 重放和恢复测试在 TypeScript 上通过；Python 上没有未结束的工作流 |
| **P5 · 退役 Python** | 删除 `apps/server-python`、`packages/python-node-runtime` 和 CI 里的 Python 流程；桌面打包去掉 CPython 和额外的 Node；`apps/server-ts` 改名为 `apps/server`；更新全部文档 | Codex；Claude 更新文档和设计说明 | 安装包大小、启动时间、内存与 P0 的基线对比 |

迁移期间新的后端功能照常开发，放在当时负责那组接口的服务里；如果某组马上要迁移，新功能要么等迁完再做，要么直接
用 TypeScript 写一次。

## 仓库结构

迁移期间：

```text
apps/
  server-ts/          新的 TypeScript 控制平面（先是入口，再逐组接管）
  server-python/      逐组变小；P5 删除
  server/             现在只有退役说明；P5 时变成 TS 服务
  web/ desktop/ node/ worker-host-*/   不变
packages/
  protocol/           契约的唯一定义（zod）→ JSON Schema、API 文档
  contract-tests/     新增：黑盒测试，可以对任何服务地址运行
  db/                 不变：共用的结构和迁移
  work/               P4 新增：Temporal 工作流和活动（TypeScript）
  domain/ provider-sdk/ …    不变
tests/oracles/legacy-server/  不变，只作测试输入
```

P5 之后：`apps/server`（TypeScript），没有 `apps/server-python`，没有 `packages/python-node-runtime`，安装和 CI 都不再
需要 Python。

## 风险和应对

- **行为不一致**：契约测试和逐组切换能发现，切换也能撤回。
- **安全退步**：身份单独作为一个阶段，有安全审查，并沿用 Python 现有的反向测试。
- **进行中的任务**：Temporal 工作流按任务队列迁移，只在 Python 上的记录结束或重放测试通过后才迁。
- **P2–P4 期间同时运行两个服务**：桌面应用暂时会同时带两个；安装包要到 P5 才变小，所以 P5 是必做阶段，不是可选的
  收尾。
- **范围膨胀**：每组按现状迁移，改进放在切换之后。

## 待定问题（留给 ADR）

- HTTP 用 Fastify 还是 Hono（都在维护；Fastify 插件生态更大，Hono 更小、能在任何环境运行）。
- 桌面端以后能否更简单地内置 PostgreSQL 或 Temporal；不在本次范围内。
