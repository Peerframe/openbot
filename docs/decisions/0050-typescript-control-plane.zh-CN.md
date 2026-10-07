# ADR-0050：按接口组把控制平面迁回 TypeScript

[English](0050-typescript-control-plane.md) · 简体中文

- 状态：已接受；所有者于 2026-10-06 批准 P0–P5 执行
- 日期：2026-10-06
- 负责人：@yxflc11
- 输入：[PR #192](https://github.com/Peerframe/openbot/pull/192)；
  固定于 [`d6d383ee137f501248f8d2431d5d9f2c7bd0acee`](https://github.com/Peerframe/openbot/blob/d6d383ee137f501248f8d2431d5d9f2c7bd0acee/docs/research/typescript-control-plane-plan.zh-CN.md) 的规划
- 证据：[P0 依赖审阅与基线](../research/typescript-control-plane-p0.zh-CN.md)
- 验收：Web/Desktop 的使用流程及公开契约保持兼容，通过一个 TS 入口运行；数据和授权不变；产品安装、必需的开发设置及 CI 不再需要 Python。

## 背景与方案比较

所有者依次重视统一语言、简化安装、实测启动与内存收益。换语言不会缩短模型、PostgreSQL 或 Temporal 的服务延迟。
当前产品仍由 Python 承担；不能把退役的 `apps/server` 或冻结 TS oracle 重新用作产品捷径。
本工作区已有未提交改动，归原作者所有，不属于本 ADR 的修改范围。

本规划重新讨论 [ADR-0046](0046-temporal-as-recovery-owner.md) 和
[架构迁移记录](../ARCHITECTURE_MIGRATION_PLAN.zh-CN.md) 中的语言选择；保留 Temporal 作为唯一恢复调度者，
Server 作为唯一授权依据。批准改变的是目标方向；各组替代实现过关前，Python 继续提供当前产品。

| 方案 | 首个可用成果 | 整合与运维 | 维护与目标符合度 |
| --- | --- | --- | --- |
| 保持 Python | 当前产品直接可用 | 改动最少，迁移风险最低 | 仍需两套核心工具链与 Python 分发，不能实现统一语言 |
| 完整重写后一次切换 | 整体移植完成后才有对等产品 | 行为、数据与恢复风险集中在一个切换点 | 最终统一，但增量交付与回退困难 |
| 单入口后逐组替换 | 先统一契约，再形成能转发 Python 的可用入口 | 暂时携带两个服务，逐组验证事务与回退 | 满足目标，检查点可用；推荐 |
| 永久 TS/Python 分工 | 可较早上线部分 TS 接口 | 永久维护进程间契约和两套运行时 | 不能完成 Python 退役，不作为最终架构 |

## 决策

新建 `apps/server-ts`，使用 **Fastify 5.12.5** 管理 Node HTTP 生命周期，
复用 `packages/protocol` 的 **Zod 4.6.2** 定义公开契约，
复用 **Postgres.js 3.4.9 + Drizzle 0.45.2** 持久化。
规划中的 node-postgres 是候选方案；迁语言没有必要同时替换当前可用驱动。
候选比较、确切版本、许可、源码与待验证条件见 P0 证据。

模型传输采用已审阅的 **OpenAI 7.28.0**、**@anthropic-ai/sdk 0.131.0**；
恢复采用 **Temporal TS SDK 1.24.0**。
这些是已批准的目标固定版本，尚未安装，也未完成产品集成验证。仅在已批准的对应阶段安装，
同时更新锁文件、许可声明、漏洞检查与受影响验收；到时版本变化应定向重审。

### P1：统一契约，保持行为

`packages/protocol` 统一管理公开请求、响应、错误与事件，包括现有 Node/Worker wire 契约。
从真实产品路由、Web/Desktop/Node 消费者、SSE、WebSocket、二进制上传下载列出完整清单；
冻结 oracle 只补充兼容证据。P0 时 TS 只主导保留的 wire schema，Work HTTP 类型从 Python 生成。
P1 已把 Work/native Task、身份/认证/工作区/读取、模型/存储/附件/产物、生命周期/审批/审计及 Employee/自动化/Node/插件、浏览器与导入导出 HTTP 定义和生成移到 TS，覆盖默认121个真实操作（含整合后的 C9 外观接口）；
domain 的身份、会话、消息、Run、模型、Employee、Node 和 portable 类型来自共享校验器。
Web 插件 HTTP 类型由严格共享 schema 推导，并明确保留可选结果投影；浏览器有严格会话类型及明确的 Web 宽松投影。
签名 publisher HTTP 已由另行配置的真实临时 keyring 套件验证；实际 Web/Desktop 设置 PUT 和 Owner 附件
组装通过 Node Fetch 到真实 Python。清单保存已核对的消费者源码摘要及注册/组装边界。
另行组装的合成模型传输已验证 OpenAI Chat/Anthropic 发现及显式 SDK 探测 HTTP，保留有界回执。
原生 Work 决定和对账使用真实 HTTP/SQL 发布状态夹具验收，不能把已有 TS 类型视作完整覆盖。

P1 门槛覆盖全部真实默认公开注册、已核对消费者、现有 Node/Worker wire 定义，以及另行配置的
publisher/provider HTTP 变体。产品模式已提供全部注册器；可选 Temporal/browser/command 组装
改变这些既有接口的执行。保留默认禁用或不可用行为，不为获得成功测试增加产品回退。
可信浏览器执行、原生工具执行和缺少当前 Run guard 的旧式调用执行仍属于相关 P3/P4 组的执行验收。
混合入口流转发/饱和压力/反向切换属于 P2，安装版/原生打包属于 P2/P5；保留这些门槛，
不以任务执行重写延长 P1。

使用严格 Zod 校验并生成 JSON Schema、OpenAPI 和 API 文档。
JSON Schema 不能表达所有 transform/refinement；trim、Unicode、缺失/null、安全整数和字节上限
需要有名称的适配与夹具，不能通过改变 Python 校验来“对齐”。
TS 覆盖完整前保留 Python 投影；消费者过关后才移除旧生成链。共享包不能导入 apps。

新增 `packages/contract-tests`，按可配置 base URL 运行黑盒测试。
同一批用例分别测 Python、直连 TS 接口组与混合入口，使用相同夹具初始化各自的临时数据库。
覆盖状态、错误、响应头、cookie、并发、审计/回滚、流重连/中断、WebSocket 边界、
授权失败与未知字段。遗漏应失败；仅按声明的规则归一化动态 ID/时间。
schema 快照或旧 oracle 通过不能替代这些验收。

### P2：受限转发，每个操作只有一个授权与写入归属

TS 入口把尚未接管的方法/路径组转给一个固定私有 Python upstream。
保留真实公共 Origin、凭据语义、Set-Cookie、状态/错误、事件 ID、SSE 背压/中断、
上传下载字节及 Worker WebSocket 生命周期。不能接受任意目标 URL、开放重定向、
凭据日志或通用 renderer 代理。

Python 继续验证其接口的身份与权限。P2 可为入口自己的接口校验现有会话，
但不能靠“可信用户”请求头替代 Python 决策、签发第二套会话或重复审计。
拒绝伪造的转发/身份头；只有明确配置的基础设施能提供代理元数据。
upstream 不可用时有界失败，不能启用另一个实现，也不能自动重试写请求。

路由归属清单还包括事件投影、后台定时器和相关写入口；每个操作只由一个实现负责。
共用 PostgreSQL 不会自动协调重复的定时器、派发器、清理器或工作流启动者。
迁移仍留在 `packages/db`，由一个带保护的迁移入口执行；
保持历史、ID、加密/密钥格式、会话撤销、revision/CAS 与锁顺序兼容。
共存期间只做兼容的增量数据库迁移，不双写、不复制数据库、不破坏性回滚数据。

### P3：逐组切换和退役

按小设置/读取 → 身份安全 → 产品功能 → 模型传输推进。
审批设置较早迁走也不能改变实际授权与效果准入的现有 Server 事务。
本检出正在修改 C28；接入其已接受且验证过的退役结果，避免重复实现或迁移。

每组切换前必须证明公开行为和反向用例一致、真实 PostgreSQL 事务/审计正确、
受影响桌面流程通过，并在较新的数据上演练反向切换。
回退窗口内保留上一份可运行发布物和兼容迁移；之后才从当前源码删除不再可达的 Python 组。
不能在“切换即删除”后把回退指向已经消失的代码。反向切换不恢复旧事实、不重放未知写入。
开放 TS 写入前先完成后台任务归属转交。

每次 HTTP 接口组切换前，在确切候选及其最新 Web、TS 构建上运行
`npm run ui:acceptance -- --entry ts`。必须达到 `PASS 12/12`，且没有未预期的 API
响应或页面错误；保留输出目录里的报告、截图及候选版本。这是
[已接受的本地整体界面关卡](../research/ui-acceptance-automation.zh-CN.md)，仍需同时通过
上述事务、权限、桌面和反向切换关卡。如果再次出现 `503 GET /api/v1/workspace`，
根据报告步骤和成对的 TS/Python 进程日志，区分上游响应与入口转发失败后再验收候选。

新功能随当时的接口组负责方开发。某组迁移前直接写 TS，也要明确路由归属并通过相同关卡；
“快要迁移”本身不授予任何权限。

### P4：Work、harness 与 Temporal

迁移工作流、Activity、运行时监督，以及 **`packages/harness`**，不能只迁 `apps/server-python`。
官方模型 SDK 替换传输，不能直接替代 Pydantic AI 的有界策略、消息/媒体序列化、
延后审批、工具关联、纠正采纳或控制端准入/fencing。
用受信端口组合一个窄的 TS 策略实现，保持这些契约；
不新增第二套 Agent/重试循环，不把无限循环塞进一个可重试 Activity。

为新任务使用版本化 TS 工作流类型和独立队列；保留 Python Worker 及其依赖完成旧任务。
新队列不会迁移 history，也不会转换 payload。
旧任务的 signal、取消、审批、timer、子工作流与 Continue-As-New 链仍须能送达原 Worker。
在声明排空前约束启动/派发归属，并停止旧准入。

默认**排空**所有 Python 未结束 execution，通过 Temporal 与控制端事实核对，
包括会产生下一 run 的链。直接用 TS 重放 Python history 是例外，
需要该类型/版本的导出 history 重放、payload/错误/failure、Activity 名称/结果兼容，
以及重启和恢复验证。TS SDK 示例重放通过不等于跨语言重放通过。
引擎 history 结束不能授权重复未知效果或发布 Artifact。

保持根预算、审批、来源 revision、Worker claim、取消/撤权、仅查询的对账和事务性发布。
沿真实公共 HTTP → Temporal → runtime → 隔离 executor → 重连/下载路径，
在既有准入、效果和发布边界验证进程退出与响应丢失；合成 provider 夹具避免付费调用。

### P5：退役与仓库

共存时新增 `apps/server-ts`、`packages/contract-tests`；只在 P4 引入 `packages/work`。
DB、protocol、domain、Web/Desktop、Node/Worker 与 provider 保持现有角色。
P5 才将已验证的 TS 服务改名为 `apps/server`。

消费者迁完后移除 Python control、Python harness/wheel、旧 `packages/python-node-runtime`、
锁文件、启动器与打包依赖闭包。把其文档/OCR 库和现有迁移行为保留到 TS 闭包。
还需列出探针、实验、生成器、开发命令和必需 CI 对 Python 的依赖；
逐项移植或退役，并保留替代证据。历史输入可作为不执行的来源记录保留，
但不能让必需的设置和检查仍然依赖 Python。

去掉 CPython 是必需目标。去掉额外独立 Node 也是请求的打包目标，**尚未验证**：
所审阅的 Temporal Worker 支持真正的 Node 20/22/24，依赖原生模块、线程与 VM。
承诺用 Electron 替代之前，必须验证具体 utility-process ABI、Worker 生命周期、
解析辅助程序和原生加载。如果验证失败，保留 Node 是需要所有者决定的目标变更，
不能悄悄当作 P5 已完成。简化 PostgreSQL/Temporal 部署不在本轮范围内。

## 阶段关卡与批准边界

| 阶段 | 进入下一阶段前的证据 |
| --- | --- |
| P0 | 审阅本 ADR、依赖证据和基线限制，记录所有者决定 |
| P1 | 路由/消费者清单完整；共享契约测当前 Python 全通过，行为不变 |
| P2 | 混合入口契约和桌面流程通过；测得转发延迟/内存；私有 upstream 与反向切换验证通过 |
| 每个 P3 组 | 正向/反向/并发/审计测试，确切候选的 TS 界面 `PASS 12/12`，身份安全审查，正反切换通过，后台任务唯一归属 |
| P4 | 真实恢复与重放通过，运行时打包受支持，Python history/链全部排空，无旧授权或失联操作路径 |
| P5 | 全新产品安装/开发设置及必需 CI 无需 Python；同口径比较 P0 的包大小/启动/RSS；适用平台打包通过 |

所有者于 2026-10-06 批准 ADR、桌面重启测量和 P0–P5 持续实施。
阶段验收仍须通过；常规执行不重复请求同一批准。授权覆盖实施和验证后的退役，
不覆盖付费调用、无关生产数据写入或发布。新归属实际落地时同步生效的仓库/局部规则，
保留有日期的升级记录，不能改成此次迁移已经完成的样子。

## 影响与剩余证据

P2–P4 包会暂时更大。每份共存版本都需保留自己的基线和支持范围；节省空间由 P5 的实测证明。
本轮使用实际安装的 macOS arm64 alpha 包，没有把脏工作区冒充已安装版本。
测量覆盖原生 PostgreSQL/API/登录启动及参考分发归档/镜像，
后续已获准重启，观察到真实渲染窗口与已连接工作区；该独立时延包含自动化开销。
这些测量不代表活跃 Temporal 内存或 Windows/Intel Mac 验证，具体范围见 P0 证据。

本 ADR 没有复制或大幅改写上游源码。保留现有许可声明；
新增产品依赖的声明随实际安装它的阶段交付。
