# TypeScript 控制平面：P0 审阅与基线

[English](typescript-control-plane-p0.md) · 简体中文

- 状态：P0 已接受；核心依赖、原生服务和 GUI 启动基线已完成
- 日期/检索日期：2026-10-06
- 负责人：@yxflc11
- 决策：[ADR-0050](../decisions/0050-typescript-control-plane.zh-CN.md)
- 相关：[PR #192](https://github.com/Peerframe/openbot/pull/192)
- 触发：重要架构及后续依赖/运行时变更
- 验收路径：保持 Web/Desktop/API、数据和恢复能力，最终退役 Python
- 安全边界：Server 管理会话、授权、预算、审计和效果准入；Temporal 调度恢复；
  客户端、模型输出与 executor 报告仍不受信任。

## 既有决策与检索证据

审阅[复用账本](../OPEN_SOURCE_REUSE.zh-CN.md)中 PostgreSQL 迁移、Zod、
Desktop 打包、Python control/runtime、模型传输和 Temporal 的相关条目；
保留 [ADR-0046](../decisions/0046-temporal-as-recovery-owner.md) 的授权/恢复分工。
改变的前提是所有者要求统一语言并最终去掉 Python。

P0 测量时的检出：`codex/c22-c24-storage-follow-ups`，
`010439bb9002fabb7e1facd8450ee85edbafa309`，已有其他未提交改动。
#192 的文档已在上游合并，本检出尚未包含；ADR 引用其固定 PR head，没有拉取覆盖现有改动。
工作区当前 control 为 173 模块、31,743 物理行；`packages/harness` 另有 13 模块、3,476 行。
这些包含未提交改动，不是重新估算 #192 中有日期的各领域占比。

检查了真实 `packages/db` 驱动/迁移器、protocol 规则、Python 路由注册、
Work 类型生成器/Web 契约入口、harness 规则、原生启动器/controller 和已安装桌面包的 provenance。
当前 Work OpenAPI 导出仍要启动 Python；数据库/迁移与解析器可以复用，
但不能认为所有公开契约已经由 TS 定义。

GitHub/主要来源检索：`fastify/fastify releases v5`、`honojs/hono releases`、
`temporalio/sdk-typescript releases`；进一步读了这些仓库以及
`openai/openai-node`、`anthropics/anthropic-sdk-typescript`、
`porsager/postgres`、`brianc/node-postgres` 的固定版本源码、package 和发布记录。
问题检索包括 Fastify/Hono 的 `is:issue is:open stream`，
Temporal 的 `is:issue is:open replay` 和 `... electron`。
没有搜到 Electron 问题不等于支持 Electron。
还检查了官方 Fastify 校验/Server 和 Temporal TS 测试文档；具体决定尽量引用固定源码。

## 候选与依赖对照

以下是确切的**审阅版本**。P0 未安装候选；P2 已在项目中安装选定的 Fastify/reply-from，
并修补保留 MCP 示例的一个间接依赖。Provider/Temporal 候选仍待对应阶段。
使用上游公开 API 不能代替 OpenBot 的授权保护和测试。

| 当前 Python 职责/版本 | TS 候选与固定来源 | 许可 | 维护、适配和判断 |
| --- | --- | --- | --- |
| HTTP：FastAPI 0.141.1、Starlette 1.6.0、Uvicorn 0.53.0 | [Fastify 5.12.5 / ba235fd](https://github.com/fastify/fastify/tree/ba235fdcd9a83a4c7ccf793f7b2596a8f65389b6) | MIT | 选用 Node 生命周期、显式限制/hook 与流。发布包含 content-type 安全修复；检查了流测试和校验文档。用严格 Zod 和既有错误语义替代默认强制转换。 |
| HTTP 替代 | [Hono 4.13.13](https://github.com/honojs/hono/tree/v4.13.13) | MIT | 维护中的 Web 标准接口，历史夹具熟悉；检查发布/package/流问题。Node 需 adapter，Fastify 更直接匹配当前生命周期，因此本提案不选 Hono；不复活 oracle。 |
| DB：psycopg 3.3.6 | 既有 [Postgres.js 3.4.9](https://github.com/porsager/postgres/tree/v3.4.9) + [Drizzle 0.45.2 / e7dfa145](https://github.com/drizzle-team/drizzle-orm/tree/e7dfa14519f363229ccc3ead7b1b2f2051937efb) | Unlicense；Apache-2.0 | 选现有产品 DB/迁移适配及既有事务决策；仍需真实 PG 锁/CAS/审计测试，ORM 移植不等于 SQL 对等。 |
| DB 替代 | [node-postgres pg 8.23.1 / 0980cefe](https://github.com/brianc/node-postgres/tree/0980cefebe0ae461da8883703be049fe13ca96cf) | MIT | 持续维护的连接池驱动，读了 package/测试入口。可用，但会同时改变驱动、池、类型和取消语义；当前没有必须换驱动的缺口。 |
| DTO：Pydantic 2.13.5 | 既有 [Zod 4.6.2 / e359f737](https://github.com/colinhacks/zod/tree/e359f7378fe56d695134701cda1e9055a08892dc) | MIT | 选当前共享契约包并复用既有输入审阅；通过跨语言反向夹具保留缺失/null、未知字段、上限和归一化。 |
| OpenAI：3.17.0 | [openai 7.28.0 / fb695562](https://github.com/openai/openai-node/tree/fb6955621e1cf6653659adb75094ebace83ebfe9) | Apache-2.0 | 官方 SDK，2026-10-04 发布；读了 package/README；要求 Node >=22。提供传输、流、取消/重试配置；只选传输层。 |
| Anthropic：1.8.0 | [@anthropic-ai/sdk 0.131.0 / d49bdab4](https://github.com/anthropics/anthropic-sdk-typescript/tree/d49bdab458000bcdffe77bd84b03293f31824fb3) | MIT | 官方核心 `sdk-v0.131.0`，2026-09-30 发布；读了 package/README/client。不能把仓库最新的 Google Cloud SDK tag 当作核心 SDK；只选传输层。 |
| 恢复：temporalio 1.33.0 | [@temporalio/{client,worker,workflow,activity,common,testing} 1.24.0 / 1fd1c81](https://github.com/temporalio/sdk-typescript/tree/1fd1c81a0383f5f5c7923dd735472c7d1ffdc867) | MIT | 官方已发布版本，读了要求、许可、重放测试源码。使用真正受支持的 Node 20/22/24；默认远程 Activity 和排空旧任务；测试依赖与产品闭包分开。 |
| 策略：pydantic-ai-slim / pydantic-graph 2.47.0 | 上述官方传输 + 现有有界 harness 契约的移植 | 上述上游许可；OpenBot MIT | SDK 调用不能替代策略、receipt 与审批。P4 必须迁真实消费者并验证失败路径；不新增自主调度器。 |
| 策略替代 | 既有 [AI SDK 7.0.93 / 6359fd58](https://github.com/vercel/ai/tree/6359fd58) | Apache-2.0 | 复用既有研究；通用模型抽象不能自行替换 Pydantic 消息 receipt、控制端 fence 或细粒度持久化检查点，不自动新增该高层运行时。 |

SDK 源码显示默认两次重试及较长超时。应显式设定期限与取消；
由 control/Temporal 管重试或结果未知时，不能保留隐藏的传输重试。
导入的 tool schema 不能成为 Fastify 编译执行的代码。
[固定校验文档](https://github.com/fastify/fastify/blob/v5.12.5/docs/Reference/Validation-and-Serialization.md)
说明默认转换和 compiler 行为；继续使用严格校验，不静默删字段/转换输入。

检查的上游测试/源码：
[Fastify stream](https://github.com/fastify/fastify/blob/v5.12.5/test/stream.1.test.js)、
[Temporal replay/flags](https://github.com/temporalio/sdk-typescript/blob/v1.24.0/packages/test/src/test-integration-replay-and-flags.ts)、
[OpenAI retry/timeout](https://github.com/openai/openai-node/blob/v7.28.0/README.md)、
[Anthropic client](https://github.com/anthropics/anthropic-sdk-typescript/blob/sdk-v0.131.0/src/client.ts)。
本轮**没有执行**这些上游测试。

检索当天相关的未关闭问题：
[Fastify stream/Buffer 类型 #7009](https://github.com/fastify/fastify/issues/7009)、
[Hono HTTP/2 adapter 流 #4041](https://github.com/honojs/hono/issues/4041)、
[Temporal 并发 local-activity 重放 #2455](https://github.com/temporalio/sdk-typescript/issues/2455)、
[Temporal Node 26 确定性 #2269](https://github.com/temporalio/sdk-typescript/issues/2269)。
保持远程 Activity 和受支持 Node LTS；固定版本不能自行证明产品重放、流或安全。
[Worker 要求](https://github.com/temporalio/sdk-typescript/blob/v1.24.0/README.md)也未验证 Electron 可替代 Node。

辅助对照：已审阅的 `jose 6.2.12`、`canonicalize 5.0.0`、`yaml 2.9.0`、
MCP `@modelcontextprotocol/sdk 1.30.0`、wire 与解析适配可作为当前
Python JOSE/JCS/YAML/MCP/WebSocket 路径的候选。
Python JSON Schema 的 dialect/ref 边界、BeautifulSoup/SoupSieve HTML 提取，
仍需在 P3/P4 选替代前按消费者验证。它们是已识别的缺口，不能跳过。
其他 provider 的兼容接口也要逐夹具验证。这份核心对照没有冒充全部未来依赖的完整资格验证。

## 复用与源码

优先使用已发布依赖和窄适配，不新增 Web 框架、数据库驱动或持久化调度器。
OpenBot 缺口是完整共享契约夹具、私有转发/归属，以及有界 TS 策略；
接口退役后临时转发退出，P5 必须去掉 Python 转发路径。
上游不可用时失败关闭，不能切换授权依据。

未复制或大幅改写上游实现；源码和测试只作为证据阅读。
P0/P1 未增加运行时依赖。安装 P2 建议版本时保留传递/原生许可声明，并拆分产品/测试闭包。

## P2 转发适配审阅（2026-10-06）

检索 `repo:fastify/fastify-http-proxy is:issue is:open websocket`、官方 proxy/reply-from 发布与
安全公告、固定源码/测试/包文件及 Node22 HTTP upgrade/stream API。公开问题检索返回0项，不能证明完整 WS 支持。

| 候选 | 固定源码/许可 | 决定与具体缺口 |
| --- | --- | --- |
| `@fastify/http-proxy`11.6.4 | [1bf6131](https://github.com/fastify/fastify-http-proxy/tree/1bf6131e1967afc783eb92d402af8a9af79e6afd)，MIT；2026-10-04 发布 | 维护中的 Fastify5 集成，提供原始 payload 流与 HTTP/WS prefix 安全修复。查询重写会归一化字节；WS 消息等待上游连接后调用 `send`，没有 stream 背压。默认集成不能满足原始查询/有界队列门槛。 |
| `@fastify/reply-from`12.6.5 | [5422fd6](https://github.com/fastify/fastify-reply-from/tree/5422fd681132d53a7f058b8b4f55e49ff5345dc3)，MIT | 在已批准 Fastify5.12.5 下选择其已发布 HTTP 适配。源码接受原始 body stream、保留未改写查询并复制响应头/流；包含连接头及取消请求修复测试。OpenBot 只负责固定目标/路由准入、有界生命周期和脱敏传输失败。 |
| 原有 Desktop 代理 | 既有源码和 C19/Desktop 决策 | 保留 renderer 角色。它提供 Desktop 凭据和有界 fetch 投影，不承担产品 HTTP/Worker 传输或另一份授权。 |

先查上一安全下限11.6.0，再固定11.6.4。
[prefix 逃逸公告](https://github.com/fastify/fastify-http-proxy/security/advisories/GHSA-7hrw-592w-9wh2)
要求至少11.6.0。源码/发布审阅不等于生产漏洞扫描；安装仍要求精确 lockfile、许可声明、
`npm audit --omit=dev --audit-level=high` 及局部门槛。P2 已在 workspace lock 精确安装 Fastify5.12.5/reply-from12.6.5，
没有复制/改写上游实现。生产审计按 high 阈值退出0，0项 high/critical、2项 moderate（fast-uri、原有 ip-address）；
不冒称完全无漏洞，也未升级无关依赖。

Reply-from 默认重试 GET503；单独设置 `maxRetriesOn503:0` 无效，所查源码按 falsy 值取默认。
必须配置 `retryMethods:[]`、`retriesCount:0` 及返回 `null` 的显式重试回调，并验503/socket 丢失/变更失败的派发次数。
使用原始 stream parser，让无效 JSON 和整数 token 拼写原样到 Python 的授权/body parser；
不解析/重编码转发 JSON，也不添加身份头。

`/ws/nodes` 优先用 [Node22.23.2 HTTP API](https://github.com/nodejs/node/blob/v22.23.2/doc/api/http.md)
及 [stream 背压](https://nodejs.org/docs/latest-v22.x/api/stream.html#readablepipedestination-options)
做窄原始 upgrade/双向流适配：保留握手/帧字节与 close/error/abort，限制握手前生命周期，
固定目标、有界缓冲、禁止自动重连。这是 API 集成，不另写 WS 协议；真实验收尚待执行。

关键前提：真实 `serve.py` 没有开放可信代理 peer 配置，但已有 Worker 路由具有明确的单代理身份策略。
拒绝调用者提供的转发/身份元数据；对外绑定的混合服务必须先通过既有策略验收 peer/限流保持。
首个本机候选必须强制 loopback 范围，不能暗示已支持公开部署。组切换过关前只有一份 Python 后台写入者/迁移器。
P5 去掉临时转发。

P2 的客户端身份衔接复用 C19 的单跳 RFC7239 边界。只有显式配置的数字 loopback 地址能访问
私有 Python 入口，Python 必须监听127.0.0.1。ASGI 适配器用现有解析器校验单个有界
`Forwarded` 值，再把原始地址交给登录限流；Node 注册通过内部 scope 保留 forwarded 来源与摘要。
公开 scheme/Host 来自固定配置，TS 拒绝请求携带的转发或身份头，并从直接 socket 生成 `for`。
缺少或错误元数据、错误私有 peer、配置不完整时拒绝；Uvicorn 通用代理头解析仍关闭。
这里不增加身份、会话授权、数据库写入者或持久化结构，直接 Python 入口行为保持不变。

原生 P2 组合扩展现有 Desktop Python 启动器、父进程管道监督和生产 lock 闭包。
只有一份 PostgreSQL 监督器和受保护的迁移器；Python 使用独立私有端口和原有 bootstrap/key/object 根，
TS 使用公开端口。严格的安装资源标记决定组合，错误或不完整的 TS 资源不得回退。
两份子进程各自持有父进程管道；任一份退出即停止另一份，正常关闭顺序为 TS、Python、PostgreSQL。
共存阶段复用 Node24.21.0，Electron ABI/额外 Node 移除属于 P4/P5。
独立 TS Preview 身份、配置与输出目录保护原有安装版。这不增加 renderer 命令、数据格式、服务注册或依赖，
不复制上游源码。生命周期依据为 [Node24.21.0 子进程 API](https://github.com/nodejs/node/blob/v24.21.0/doc/api/child_process.md)
和 [Fastify5.12.5 close API](https://github.com/fastify/fastify/blob/v5.12.5/docs/Reference/Server.md)。

## 实测基线

对象是已安装 **OpenBot 0.1.0-alpha.9**，macOS 27.0.1 / 26A434，arm64。
包未内嵌 source commit；[脱敏原始数据](typescript-control-plane-baseline.json)
记录 ASAR、requirements 和 harness wheel 的 SHA-256。
已安装 `serve.py` 与工作区哈希不同，因此本轮明确测已安装版本。

将 ASAR 解到临时目录，使用其未修改的编译版 `NativeServerController` /
`launchPythonProductServer`，配安装包里的 Node 24.21.0 / CPython 3.12.13 / PostgreSQL 17.10。
只使用独立私有配置和数据库；加密回调沿用仓库 smoke 夹具的合成约定，不验证 Keychain。
不读取 dotenv、既有配置或凭据，不调用付费模型。
没有 Temporal 配置，因此测的是受支持的 API-only 组合。

| 指标 | 实测 |
| --- | ---: |
| 新配置就绪：initdb + PostgreSQL + 迁移/preflight + Python HTTP + Owner 登录 | 中位数 4,954 ms；4,897–5,594 ms，3 次 |
| 同一个临时配置重启到相同就绪状态 | 中位数 3,992 ms；3,966–4,003 ms，3 次 |
| Python 启动/preflight/迁移/health 子步骤，新配置 / 重启 | 中位数 3,879 / 3,688 ms |
| 原生子进程 RSS，新配置 / 重启 | 中位数 166.00 / 161.83 MiB |
| Python 进程 RSS，新配置 / 重启 | 中位数 117.38 / 117.34 MiB |
| 已安装 app 的常规文件字节，不重复计 symlink | 1,211,381,873（1.128 GiB） |
| 原生 payload 常规文件字节 | 766,100,210（730.61 MiB） |
| CPython / 额外 Node / PostgreSQL | 256,379,737 / 196,895,972 / 135,051,359 字节 |
| 同一 app 的参考 ZIP | 467,530,551 字节（445.87 MiB） |
| 同一 app 加 Applications 链接的参考 UDZO DMG | 653,513,894 字节（623.24 MiB），校验和验证通过 |

RSS 是所有子进程之和，不包含测量 controller 和 `ps`；
PostgreSQL 共享页面可能重复计算。它不等于物理占用、峰值、Electron 总内存或活跃 Work/Temporal 内存。
每次就绪后空闲两秒，间隔 500 ms 取三份样本，原始 JSON 保留全部 18 份。
“新配置”不是清空 OS 文件缓存。后续比较应使用相同机器、负载、运行时和范围；
本轮未声称任何百分比改善。

ZIP/DMG 是本地生成的测量参照，不是签名/公证的正式发布安装器。
DMG SHA-256：`042ce41132fbd35d9c1ac74ebc9644cf741434e7b15ab785c792c2b0a760efa6`。
没有安装或发布。记录观察后清理临时配置、解包源码和大型参照产物。

## 复现与限制

从锁定的检出开始，使用 `OPENBOT_BASELINE_APP` 指定已安装 bundle。
复现命令与完整 `measure.mjs` 见
[英文文档的复现段](typescript-control-plane-p0.md#reproduction-and-limits)；
使用已有 `@electron/asar` 解到临时 `p0_root`，
用安装包 Node 执行测量脚本，传入解包目录、原生 payload 与结果 JSON。
不能传入用户已有数据目录。脚本只输出测量，凭据留在内存，`finally` 清理私有临时配置。

初次沙箱执行因启动器有界的 `Native operation failed` 诊断失败，没有产生样本；
同一个临时命令获得本地进程权限后成功。
六次成功启动均完成登录，随后停止；确认原 health 不可达且无原生子进程残留。
这是真实执行，不是缓存或模拟的时延。

所有者于 2026-10-06 批准全部阶段及重启正在运行的 Desktop。
先确认旧桌面/原生进程退出，再通过 CUA 启动同一安装包：**1,628 ms** 观察到渲染窗口，
**18,743 ms** 观察到已连接工作区（单次成功样本，178 次 AX 观察）。
就绪条件是实际实时连接状态出现、打开工作区的加载状态消失。
时延包含启动、自动化和 AX 开销，是观察边界，不是埋点测得的首帧时刻。
没有发送消息或执行数据变更；应用保留运行，私有 AX 文本和截图未写入仓库。
活跃 Temporal 工作负载和其他平台仍属于后续阶段资格验证。

## 实施前的 P0 验证

实际执行 `npm run docs:check`：退出 0，12/12 测试、582 份 Markdown 检查通过，无测试跳过。
实际执行 `npm run research:check`：退出 0，27/27 测试通过，无测试跳过；
PR-event 校验明确因不处于 `pull_request` 事件而跳过，不能声称远程 PR 研究关卡通过。
JSON 样本数/中位数和空白检查通过。原有 tracked diff 的 SHA-256 保持为
`05f77d2bc527a08dd90fc8f33077fee91ea0361ff266c7724f7bb201b62db710`。
这些是本轮实际执行，不是缓存。未修改产品/脚本源码或依赖；没有运行 `npm run check`、产品契约或上游测试。
参考归档/镜像命令见英文复现段，使用同一个临时副本，不安装或发布；P5 字节清单须继续排除符号链接。

P1 先把当前 Python 的完整公共契约测到通过；
P2 测私有转发、头/cookie/流/Worker transport、冷打包、失败与开销；
P3 逐写入方验证正反切换及身份安全；P4 验证真实引擎/executor 恢复、harness 对等和排空；
P5 核对安装/CI 依赖清单，并同口径比较最终资源。
完整关卡与所有者批准边界见 ADR-0050。


## 当前迁移检查点（2026-10-08）

目录 `/Users/yxflc/.codex/worktrees/ts-control-plane-p2/openbot`，分支
`codex/ts-control-plane-p3-completion`。[PR209](https://github.com/Peerframe/openbot/pull/209)和
[PR208](https://github.com/Peerframe/openbot/pull/208)均保留面向 main 的草稿。已发布 `bdadf851`
在[运行37747409393](https://github.com/Peerframe/openbot/actions/runs/37747409393)通过17项托管检查。
用户要求全部P3完成后再整理给Claude的汇报，评估后统一合并；不安装应用、不修改生产数据。

本地模型/设置候选新增11个操作：模型服务列表、连接增改删/验证/发现/探针、Employee模型选择、
通用设置与转写设置PUT。TS选择范围为121个默认操作中的34个。Python对应入口隔离、版本冲突与原子
审计、停止Python后的操作及双向密钥反切换均通过。**P3尚未完成**：身份创建/删除、审批、工作区/
SSE/进度/审计、文件、Employee知识与导入导出、自动化、插件、Node/浏览器仍需完成。执行/harness/
Temporal属于P4，退役Python属于P5。Claude第43步界面不在本轮范围。

Node24真实HTTP270及额外附件19、受信CA HTTPS control50与各组所有权检查通过；模型SDK合成传输
18项通过（10次发现、4次显式探针、零外部模型调用）。精确模型候选界面12/12，104次响应，异常响应、
页面错误、workspace503均为0。v6运行资源和实际预览包均通过重启、密钥/配置/密码保留及进程清理。
修复打包依赖断言及脚本类型后完整 `npm run check` 通过（TS79含5项未选择的审计/进度测试，
Desktop578及3项平台跳过）；已发布CI不代表这些本地代码。当前状态统一维护在
[收据](typescript-control-plane-p2-native.json)的 `currentP3CompletionCandidate`，旧检查点只保留历史证据。

### P3 会话与身份编辑决策（2026-10-08）

复用ADR0050已审阅的Fastify5.12.5、Postgres.js3.4.9、PostgreSQL17.11及P1契约，移植当前Python事务，
不恢复冻结旧服务。保留Unicode码点限制、同一事务内的更新/审计/最终过期检查及阻止撤销越过写入的SHARE锁。
不新增数据库结构或依赖。

第一轮真实控制契约复现了TS重命名后SSE缺失刷新的问题：原Python通用产品路由只更新本进程版本。
立即迁移整个工作区事件流会耦合Node在线状态与Work进度；新建共享计数表会增加持久化迁移状态。
选择PostgreSQL事务NOTIFY：仅迁走的通用产品写操作发送空载荷 `openbot_product_changed`，提交才通知，
回滚不通知。资料、外观和创建等独立路由继续依赖快照变化，保留无变化外观更新的静默行为。
Python仍是唯一SSE发布者，一个随产品启动/关闭的自动提交监听器只触发现有轮询刷新；监听失效则流失败关闭。
它不授予权限、不执行任务、不重放写入、不传业务数据；SSE迁入TS后移除。Python显式停止期间TS写入仍可用，
重连读取最新事实。没有复制或大幅改编上游源码。

核对了[PostgreSQL17 NOTIFY文档](https://www.postgresql.org/docs/17/sql-notify.html)的提交、合并和队列语义，
以及已锁定[Psycopg3.3.6异步连接源码](https://github.com/psycopg/psycopg/blob/3.3.6/psycopg/psycopg/connection_async.py)
的通知生成器和取消行为。沿用现有许可证声明。真实SSE慢消费、无变化及重连契约与监听失效单测共同验证。

### P3 主 Bot 选择决策（2026-10-08）

下一候选仅迁移 Owner `PUT /api/v1/workspace/primary-bot`，承接 PR205 的 `b62c22fe`。
PR205 在托管17/17与界面12/12通过后，所有者另行批准合并；2026-10-08 已合入 main `fe1520dc`。转写 PUT 依赖现有模型凭证解析，
留到模型组一起迁移；本轮不增加模型密钥/凭证访问，也不改 Claude 负责的第43步界面。

复用严格共享主 Bot 命令/投影、Python 的 Origin→会话→请求体校验顺序、Postgres.js3.4.9，
以及 Owner READ COMMITTED、会话 SHARE 锁和提交前过期复查。保留 workspace-settings FOR UPDATE
先于 Bot SHARE 的锁顺序、版本冲突/无变化/耗尽处理和原子 `SETTINGS_PRIMARY_BOT_UPDATED` 审计。
身份创建/导入/删除仍由 Python 写入，遵循同一工作区优先顺序；主收件人选择不授予权限。
[PostgreSQL17 行锁](https://www.postgresql.org/docs/17/explicit-locking.html)与
[Fastify 请求体生命周期](https://fastify.dev/docs/v5.6.x/Reference/ContentTypeParser/)支持现有事务顺序和
原始流入口。只有这一接口在 Origin/会话校验后解析最多1024字节 JSON，其他请求体原样转发。
不增加依赖、结构/数据迁移或复制上游源码。

继续转发 Python PUT 无法交付这一迁移；另加偏好服务/缓存会增加权限与失效成本。因此在现有 TS
入口增加限定 SQL 写入方。两边明确选定 `primary-bot` 写入组后，私有 Python 拒绝手动保存；默认和
成对反向切换保留 Python 原实现与更新后的事实。正反例、并发/回滚/审计、真实 TS 界面12/12和原生
候选门槛通过前，不公开切换；不自动回退、重试或启动新后台写入方。整合验收和有界回退窗口后退役
Python 手动接口，身份生命周期中的自动更新保留到对应接口组迁移。

主 Bot 候选本地验收：Node24.21.0 下 `npm run check` 以0退出。最终 Turbo 成功/缓存数为
前置构建10/2、类型33/10、测试27/12、构建19/13；此前同一产品源码的成功运行实际执行
TS41、Desktop578（3项跳过）、Web692、protocol461，不把缓存输出当作新执行。
私有代理22和 Desktop 资源选择5通过。混合 all 通过270契约+19制品+14读取+17写入，包含
MCP30和实际 Web/Desktop 主 Bot PUT。临时 CA 的 HTTPS control 通过50+14+17。最终 control
补充真实未配对代理字符/NUL 拒绝，仍通过50+14+17，产品代码没有改变。

真实 TS 整体界面12/12通过，共101响应（94×200、7×201），豁免、未预期响应、页面错误及
workspace503均为0。使用现有下拉框保存另一个主 Bot，并在 TS 入口重启后读回一致。
报告和截图：`/private/tmp/openbot-p3-primary-ui/openbot-ui-acceptance-1791400019338`。
此前10/12暴露新增保存按钮定位保留了外层 dialog 前缀；保留失败报告，改成已观察的最近 section
后重新运行，未放宽错误门槛。没有改产品界面文件，也不宣称此前间歇 workspace503 已修复。

staging 与实际未签名、未安装 macOS arm64 API Preview 均通过主 Bot 保存/重启、原转写读取、
父进程 EOF/任一子进程失败时成对退出及 PostgreSQL 清理。59个 Python 锁定分发与 pip 完整性通过。
v2 标记明确选择写入方，staging/包内模块逐字节相同；ASAR SHA256 为
`5b1b63b8962d037d1a85c9b32296c9f1f2fcdc26e4d98172dd9157eef02c95e8`。
先核验 PR205 HTTP 模块指纹，再把其完整 API 预览保留到 `apps/desktop/out/ts-product-read-baseline`；
完整 P2 Worker-companion 基线另存保留。已安装应用、原 dirty 文件、Claude 第43步、用户配置及系统信任未改。

[唯一收据](typescript-control-plane-p2-native.json)当前指向 `currentP3PrimaryBotCandidate`，含源码指纹和
准确报告。这是本地已验收、待发布候选，不代表阶段完成。所有者已明确批准新分支推送、以
`main` 为目标创建草稿 PR，并另行批准先合并 PR205。整合提交 `ed568b80` 与本地已验收
`a0189dc0` 的文件树完全相同，21份源码指纹再次核验通过；随后只更新本检查点与授权记录，
原 HTTP/界面/包内证据仍保持其准确范围。新候选仍需托管检查，合并新 PR 须另行授权；Python
手动写接口保留在有界反向切换窗口。准确托管源码与运行结果记录在新 PR 检查及正文。其他 P3 接口组及 P4/P5 继续待迁。

### P3 转写读取决策与安全检查（2026-10-07）

复用 P0 数据库决策和既有 Unlicense Postgres.js3.4.9。审阅标签对象
`b70a8219c25ca3c79d54b27ff24dcdef6df4ab40`，实际提交
[`e7dfa14519f363229ccc3ead7b1b2f2051937efb`](https://github.com/porsager/postgres/tree/e7dfa14519f363229ccc3ead7b1b2f2051937efb)。
查阅 README/类型/源码中的连接池、事务、关闭与取消限制，
[PostgreSQL17 行锁](https://www.postgresql.org/docs/17/explicit-locking.html)、
[RFC6265 cookie](https://datatracker.ietf.org/doc/html/rfc6265#section-4.2.1)，以及现有 Python
OwnerTransactions、Starlette cookie 和 CPython 引号转义行为。沿用 P0 对 pg8.23.1 的比较：
这一读取没有必须换驱动的缺口，换驱动会改变连接池/类型/取消假设。转发仍是 P2，不完成实际迁移；
代理或缓存增加生命周期与一致性成本。没有复制或大幅改写上游源码；小型 cookie 兼容实现独立编写，
按保留的线格式验证。既有运行时许可包含同一固定驱动。

TS 仅验证选定的 HTTP/HTTPS Owner cookie、43位 ASCII token 和 SHA256 摘要。有界 READ COMMITTED
事务先锁现有会话 `FOR SHARE`，再锁设置行，验证共享 DTO，提交前用 `clock_timestamp()` 复查有效期
与撤销。这阻止撤销竞争，不声称 TS 签发身份。缺失、未知、过期、撤销会话返回既有401 `error` 包；
数据库或投影问题返回脱敏503，拒绝放行。提交的身份和 Origin 提示不授予权限；明确 CORS 来源与
Python 对齐，HEAD/OPTIONS/PUT 保留 Python 行为。

最多4个 SQL 请求，6秒总期限，连接/语句3秒、锁1秒、空闲事务5秒。断开或超时后丢弃晚到结果，
实际事务结束前不释放名额。未使用驱动取消：其独立连接可能误取消后续复用的查询。连接池归现有
入口生命周期管理并限时关闭；不输出 SQL/DSN/token/模型错误。启动仅检查所需列，配置/结构不符时
不开放监听。

临时 SQL/真实 HTTP 检查覆盖安全/回环 cookie、撤销/过期、阻塞中到期、撤销顺序、并发/锁超时、
客户端断开、缺失行、读取不写审计/数据、Python 隔离、停掉自管 Python 后 TS 仍可读取，以及新数据
的双向切换。完整资源契约发现401包使用了 `detail`，已改成 Python 的 `error`，没有放宽契约。
单元夹具仅作补充。常规设置等待独立的 ZoneInfo 兼容决定，本轮不削减既有时区或模型选择契约。

每组仍须实际运行 `npm run ui:acceptance -- --entry ts`，达到 PASS12/12，未预期响应和页面错误都为0。
任何 workspace503 再现都会阻断门槛，按步骤检查两边日志，不加豁免或重试。当前结果与源码限定的
证据保存在[同一收据](typescript-control-plane-p2-native.json)。这一读取是候选检查点，不代表
P3/P4/P5 完成，也不验证原生 Keychain 或 Temporal。


HTTP 生命周期修正前的首份 P3 源码检查：`npm run check` 通过（TS37、Desktop578/3项平台跳过、Web692、协议461；任务/缓存
数量留在收据），Python 私有代理/配置20项通过，真实混合 all270+19项附件+14项读取、HTTPS
control50+14、直接 Python all270+19 均通过。最终界面运行 PASS12/12，99次响应（92×200、7×201），
豁免、异常响应、页面错误、workspace503 都为0；报告为
`/private/tmp/openbot-p3-ui-final/openbot-ui-acceptance-1791374856477/receipt.json`。
运行时当前源码基于 main 且尚未提交；同一收据保存源码指纹限定范围，不把结果归到旧 P2 提交。
所属临时进程和数据已清理。当前未签名、未安装 macOS arm64 TS Preview 已通过装配与实际包内的
启动/重启/父 EOF/配对退出/读取；5份启动器、3份入口模块与构建相同。
ASAR 为 `a1f098f8d9d025ea4fcf84ba30b72c38f6debade86c3559e0befda6f0583c7af`。
此 API 候选不含 Worker 伴随包，不验证 Keychain/GUI/Temporal 或公开 PKI。发布后的 CI 再现了
MCP 超时；下方共享 HTTP 生命周期修正提供本地原因及回归证据，修正源码的必需托管验收仍是合并
门槛。通过前不切换下一组，保留既有完整伴随包基线。

产品源码已提交为 `4764d5d3edf129489fd2509a5dec32ad917a0918`。2026-10-08（Asia/Singapore），
所有者明确批准推送 `codex/ts-control-plane-p3-settings` 并创建公开草稿 PR。
[草稿 PR205](https://github.com/Peerframe/openbot/pull/205) 已发布，初始 head 为
`d38646c2c6496b6bbe2062bbf3bee35997bbd7b7`，基于 main `d747a327`。
[CI37656292955](https://github.com/Peerframe/openbot/actions/runs/37656292955) 已在该 head 启动；
最新提交的托管结果以 PR205 的必需检查及正文为准。此前自动审批拒绝是历史记录，已由这次明确批准解除。
本次未授权合并。这份发布记录不改变已验收产品源码、安装版应用或 Claude 负责的界面。

### 发布后的 HTTP 生命周期修正（2026-10-08）

[PR205 CI37657377771](https://github.com/Peerframe/openbot/actions/runs/37657377771) 在直接 Python 的
普通 MCP 读取（`plugins.ts:296`）超时，尚未开始 TS 组检查。临时诊断也在本机真实 HTTP 夹具中重现了
无需调用 MCP 的输入拒绝超时：`http_input.watch` 的 `Task.cancelling()==1`，仍继续轮询，响应清理
等待该任务退出。这定位了与托管现象一致的共享 HTTP 生命周期缺陷，不能据此归因于 TS 转发或 SDK 传输。

复用既有轮询/Owner 取消契约和不变的 Starlette1.6.0、AnyIO4.15.1。查阅
[Starlette 轮询取消域](https://github.com/Kludex/starlette/blob/1.6.0/starlette/requests.py)和
[AnyIO 取消计数](https://github.com/agronholm/anyio/blob/4.15.1/src/anyio/_backends/_asyncio.py)。
ASGI 轮询中的取消域可能吞掉任务取消；在取消并等待自有监测任务前设置明确的停止条件。真实断线仍
设置原信号，正常结束、错误和外层取消保留原结果；轮询间隔及产品/消费者期限不变。直接读取 ASGI
可能与上传正文消费者竞争，替换或升级 SDK 不解决已观测的清理缺口。未增加依赖、权限、持久格式，
没有复制或大幅改写上游实现。

两项确定性回归在修正前失败，修正后生命周期22项通过；此前失败的带诊断真实插件组随后通过30项。
独立 SDK 连接/读取诊断在 macOS 通过40次，在现有隔离 Linux arm64 产品镜像通过40次；这些窄范围
诊断不替代真实 HTTP/SQL 或托管 Linux amd64 验收。修正源码的检查、界面报告和刷新后的未安装原生
资源单独记录于[同一收据](typescript-control-plane-p2-native.json)的
`currentP3Candidate.httpLifetimeCorrection`。旧源码、包和 CI 保留原范围；最新托管提交以 PR205 的
必需检查/正文为准。本轮不盲目重跑失败任务，不放宽期限，也未授权合并。

### 合并前已验证的 P2 候选

当前工作树为 `/Users/yxflc/.codex/worktrees/ts-control-plane-p2/openbot`，分支
`codex/ts-control-plane-p2`。当前产品源码为
`2c3dd553ec9d465749fbce6a014373285d169c4f`，已整合接受的 main
`44d13f963e1e4b029746b7aa32a611234a531f7a`（Claude PR204 自动验收及两处界面修复）。
此前 `dc0bf05ad12ac2cea4d4d4a2994c6ab4981143ed` 的审阅修复、PR202 SDK 修复及 PR203
中文文案继续保留。
目录冲突保留 main 的第3版、中文名称/说明和审核记录；五份已审核文件指纹与原迁移候选完全相同。
中文许可声明保留 TS 转发依赖条目。原 dirty 目录、已安装 OpenBot 和用户数据保持原样。

所有者要求每次 HTTP 接口组切换前运行
[PR204 整体界面自动验收](ui-acceptance-automation.zh-CN.md)：使用当前 TS 构建，执行
`npm run ui:acceptance -- --entry ts`，达到 `PASS 12/12`。当前产品源码在已安装 Chrome、
1440×900 浅色模式、临时 PostgreSQL 和当前 Python 产品上实际运行一遍通过：104次已完成
API 响应（97×200、7×201），没有触发豁免、未预期响应或页面错误。覆盖改名后编辑头像、
跳过分工卡两处修复，以及重启真实公开入口后保持 Owner 登录。报告与截图保留在输出目录
`/private/tmp/openbot-p2-ui204-acceptance/openbot-ui-acceptance-1791339492444`；临时数据、容器、
浏览器及自管服务进程已清理。运行时只有迁移关卡文档未提交，产品代码来自上述已提交源码。

所有者报告此前四次 TS 验收中有一次 `503 GET /api/v1/workspace`；本次未复现，不代表已修复。
任何再现都会阻断验收，须根据报告步骤和成对 TS/Python 日志检查。这一本地关卡补充既有事务、
权限、桌面及反向切换关卡；这12步不验证付费模型、Worker 执行、原生 Electron 或读屏器。
参数/响应/脱敏检查通过3/3；缺少浏览器时在启动产品前以2退出。此前
[CI37537366648](https://github.com/Peerframe/openbot/actions/runs/37537366648) 的17项任务全部通过，
对应分支 `c8e1dbcf`、实际合并引用 `760e4848`、main `3bb6365c`；验证的是此前审阅修复，
不覆盖新合入的 PR204。本次整合的托管结果记入 PR200 检查及说明，旧收据保留原范围。


[Claude 整体界面验收](https://github.com/Peerframe/openbot/pull/200#issuecomment-6024172791)
在准确源码 `23a2916d2aa141e1fa4f52391f21b90c2184a520` 通过：经过 TS 入口验证 Owner 会话、
Bot/频道创建、档案编辑、消息/附件、任务提交和取消、插件、15个设置区域、SSE 断线恢复及两种主题。
范围不含付费模型回复、Worker/电脑执行、第三方安装和读屏器。这关闭了缺失的 P2 界面门槛，
不代表 P3 所有权切换或后续全部改动已通过。
[CI37514672455](https://github.com/Peerframe/openbot/actions/runs/37514672455) 的17项必需任务全部通过；
对应上述分支源码，实际 PR 合并引用为 `2536122d81c390102e60287950cde6d319e7a65a`，基线 main 为
`8a50575aa89e9c6ab35a6e90440d46a5ac7e4abe`。本次修复仍须独立完成托管检查。

此前四项审阅修复复用既有 Zod4.6.2 网页投影、Owner 有界审计读取和 Python 频道恢复流程；没有新增依赖、
公共路由、持久化格式或复制外部源码：

- 主 Bot、语音转写的网页响应忽略新增字段，共享 Server schema 和提交数据仍严格校验；已知字段类型继续检查。
- 主 Bot 审计标题从有界 Bot 记录填入既有 `from`/`to` 字段，包含已改名、已软删除的 Bot。
  这与其他审计主体一样显示当前保留名称，不是历史名称快照。持久事件及导出详情保留原 ID；
  找不到主体时显示“未知 Bot”，标题不回退为内部 ID，也不采用事件内的名称提示。
- 删除网页对不存在的 `GET /api/v1/runs/{id}/output` 的请求。当前 Python 模型传输不流式返回，
  频道恢复读取已提交消息和任务事实。保留原 SSE 临时输出处理，不声称可恢复产品从未保存的部分草稿。
- 第43步侧栏、王冠、头像动画继续由 Claude 在 PR200 合并后负责；过渡下拉框保持现状。

此前审阅修复的网页定向验收实际执行84项（Node26.0.0），覆盖新增/错误响应字段、额外提交字段拒绝、审计名称及
断线后消息恢复。实际 TS→Python→临时 PostgreSQL lifecycle 契约执行21项（Node22.22.2）。
既有 Python/control 门槛实际通过1,073项、跳过2项可选检查，包含新增保留名称/伪造提示审计回归、
CAS/删除并发和回滚。本地 base 命令不执行 Worker 检查；托管 Worker 验证单独记录。

当前全仓检查、刷新后的消费者清单、原生验证和托管 CI 结果统一记入
[现有当前收据](typescript-control-plane-p2-native.json)。PR200 保持为可审阅 P2 候选，尚未进行
P3–P5 所有权切换；下一组是 ADR-0050 下的小型设置/读取模块，仍需真实 PostgreSQL、权限及正反切换门槛。
没有新增 provider、注册 Worker 或系统应用。


干净源码 `a8489172` 新执行未签名、未安装 macOS arm64 候选的 staging、打包及真实服务启动/重启、
成对退出、父进程 EOF 和进程清理 smoke。59项锁定 Python 分发及 pip 完整性通过；包内审计源码和
第3版目录与仓库一致，五份审核指纹全部匹配。同一已打包 TS/Python 配合临时 PostgreSQL 的实际生产
网页，在1440×900和640×900显示两位 Bot 名称，键盘焦点正常，重载后消息和排队任务恢复。
94次已完成 API 响应全部成功，没有 Run-output 请求。临时夹具、网页和 profile 已清理。

本次完整 Electron GUI 启动停在系统凭据读取，产品服务尚未启动，不计为验收；菜单退出未完成后，
只向准确的4个本次 PID 发送 SIGTERM，确认停止并移除临时 profile。未改变钥匙串权限。此前
84184d46 的 safeStorage 流程保留原范围，本次不替代它或 Claude 已通过的整体验收。当前 native smoke
使用合成凭据回调，不代表钥匙串通过。

### Claude 审阅修复前已验证的 P2 整合

当前工作树为 `/Users/yxflc/.codex/worktrees/ts-control-plane-p2/openbot`，分支
`codex/ts-control-plane-p2`；准确、干净的产品源码为
`37e8d7fe65a7b4e588861dee0b2770bdda23e9f0`，整合接受的 main
`8a50575aa89e9c6ab35a6e90440d46a5ac7e4abe`（Claude PR194/PR198及已批准的 PR201安全修复）。
两次界面整合均自动合并，Codex未新增页面实现。此前唯一冲突是双语历史扫描说明：核对不可变
记录一致后保留已接受的 main版本。原 dirty目录、已安装 OpenBot及用户 profile保持不变。

下述 SDK审计失败已通过审阅的1.32.1固定版本修复，生产 npm审计为零漏洞；两项真实脚手架测试及
oracle guard通过，59份冻结源码/夹具哈希保持原样。锁文件仅改三份 workspace引用及一份去重 SDK。
SDK代码源码 `10f64b7a`的 `npm run check` exit0，protocol461、TS入口33、Web672、Desktop578/3项
平台跳过及 Node129/3项跳过均实际执行；lint10/0、类型33/10、测试27/12、build19/12表示总任务/缓存。
PR198整合后最终全检查 exit0，Web677及 Desktop578/3项跳过实际执行；lint10/10、类型33/30、
测试27/25、build19/18，其余未变项复用上述 SDK已验证缓存。
目录元数据修复后的完整检查也退出0：lint10/10、类型33/33、测试27/27、build19/19，Turbo任务
全部复用缓存。新执行目录 focused检查：Python6项通过／1项数据库跳过、TS2项及真实 Python
HTTP／MCP30项通过；后者实际验证数据库支持的目录发布。

SDK修复后的真实混合 HTTP及验证 CA的 HTTPS各执行270项整合及19项 staged检查，含30项真实 MCP，
以及当前 Web/Desktop设置和附件、持久化、私有 Node来源/摘要、安全 cookie及混合→Python直连→
混合回退。PR198未改后端或 HTTP消费者代码，因此复用准确 SDK源码范围，不把旧结果写作重复执行。
Python仍是唯一产品写入方。

当前未签名、未安装完整 macOS arm64包保留已验收的准确 ASAR
`dcbe7010501f5a859a762d4103f10a0c90381fb2dd1a7cac2e7a032b834df692`，37份 Desktop模块及5份
渲染文件复用字节匹配证据。应用普通文件1,230,254,531字节，原生 payload783,640,739字节。
干净源码 `37e8d7fe`新执行暂存、完整打包及生命周期 smoke均通过；全部27,820份原生文件／32个
链接与暂存一致，修订目录与仓库字节相同。相较84184d46只改变已审核目录元数据，实现、依赖与许可
不变。既有辅助程序保留源码 `6e9d13ed`；CLI Node22.22.2构建 Node24.21.0/Python3.12.13，
核对59个锁定 Python依赖并通过 pip完整性检查。

准确源码84184d46的正式身份 Electron／原生 `safeStorage`启动及重启通过，使用明确的一次性
profile；本轮复用未改 ASAR的 GUI证据，不计作重新执行。
准确合成 Bot名称、实时连接和主 Bot设置恢复，随后从侧栏打开恢复的 Bot。未配置模型时会再次显示
模型设置，既有跳过操作进入工作区。重启初始可访问性树为空、实际页面可见；键盘聚焦后文档出现，
继续使用既有按钮。这仅是限定流程观测，不代表整体可访问性或 Claude界面验收。两次正式菜单退出
均为0，各13个所属进程及 PostgreSQL PID文件均消失；三份私有文件保持哈希/0600，临时 profile已删。
此前一个欢迎窗口在打包报告完成前提前打开，不计入验收：快捷键仅关闭窗口，随后按明确所属 PID
完成清理，当时未启动产品服务。

[CI37506404433](https://github.com/Peerframe/openbot/actions/runs/37506404433)已结束，branch9dc564c6、
实际合并1ee8730c、真实 main基线8a50575a。15项任务通过，安全及汇总 check因新入库的旧 SDK公告
失败；凭证及 Python审计未执行，不冒充 SDK修复验收。随后 CI37511515733已通过安全任务：
精确23条历史样例、npm审计0、58个外部 Python依赖完整审计，无已知漏洞或跳过；但发现下述
旧目录哈希和一次 MCP超时，不代表目录修复验收。当前候选 hosted CI是下个有界检查点。
既有[原生回执](typescript-control-plane-p2-native.json)的 `currentP2Candidate`保留本轮准确范围，
此前各项保持日期记录。[PR200](https://github.com/Peerframe/openbot/pull/200)仍为 Draft且未合并。
Claude的 P2整体界面验收仍缺失，P3–P5尚未切换所有权。没有增加模型、已注册 Worker或系统应用；
安装版 ASAR保持 P0哈希。

### MCP SDK公告修复（2026-10-07）

当前候选 [CI37506404433](https://github.com/Peerframe/openbot/actions/runs/37506404433)在生产 npm审计
失败，尚未扫描凭证：锁定的 MCP SDK1.30.0处于
[GHSA-6qxp-vccf-f47h](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h)
范围；公告于2026-10-06进入审计数据库。此前 main/PR的 audit0仍是日期观测。候选9dc564c6本机完整
历史扫描通过严格适配器，25条发现均为已有精确审阅，本次提交没有发现，私有原始结果已清理。

已查阅官方 npm发布信息、源码/许可、版本差异及对应测试：1.31.0的准确源码
`4b0051f400219f8d8855f9a5433c6df35f15a639`首次绑定 OAuth凭证 issuer；1.32.1为
`ff07b001194fe60ee9deb2121cf119057565796d`，均为 MIT、Node>=18且依赖范围一致。
[1.31差异](https://github.com/modelcontextprotocol/typescript-sdk/compare/2d889f2b329e46680ec9bdd565de4616c497825a...4b0051f400219f8d8855f9a5433c6df35f15a639)
还包含请求体/批次数量上限及 issuer拒绝测试；
[1.32.1差异](https://github.com/modelcontextprotocol/typescript-sdk/compare/4b0051f400219f8d8855f9a5433c6df35f15a639...ff07b001194fe60ee9deb2121cf119057565796d)
进一步默认限制 HTTP同源且保留方法的重定向，并修复实验性任务/session隔离。因此选已发布1.32.1，
不保留1.31，也不引入2.x分拆 client/server API的迁移成本。既有有界 endpoint/session消费者兼容
默认值；不增加依赖种类、OAuth provider/凭据存储或重定向放宽配置，没有复制上游源码。
查阅上游测试仅作为源码证据，不冒充 OpenBot已执行测试。

Web仅使用 SDK的类型导入；示例/脚手架使用 MCP Server，冻结 TS对照用有界 HTTP client且未配置
OAuth provider。当前产品 MCP权限仍归 Python，因此这些 TS消费者不需要迁移已存 OAuth凭据。
本次明确审阅的 oracle例外仅更新开发依赖：55份冻结源码及 provenance哈希保持原样，仍须通过
oracle guard及对照检查。同步更新两个产品消费者、oracle元数据、脚手架既有版本断言和双语许可
声明；历史日期记录保持原版本。发布前重建并验证真实 MCP契约、依赖审计和原生生产闭包。

修复 SDK 后的首次 CI37511515733 已通过安全任务，但发现内置插件目录仍绑定旧模板清单
哈希：SDK1.32.1 改动了 `packages/mcp-example/package.json`。将目录的五个文件与准确源码
`10f64b7a03e24c6b56003dedf5ca051d6458ea64` 重新核对，只有清单哈希改变。目录 revision2
同时更新源码 URL／提交和审核记录，保留另外四份源码／许可证／来源文件的原哈希；
2026-10-01 的首次目录审核保留为历史证据。同一 CI 另有一次 MCP 内容读取超时；不改代码，
使用 Node22.22.2 本地执行插件30项和完整 Python270项加19项独立制品检查，均退出0。
未放宽超时、断言或产品传输边界；仍需当前提交的远程 CI 复核。

### 保留此前整合及托管验收记录

当前实现目录是受管理的隔离工作区 `/Users/yxflc/.codex/worktrees/ts-control-plane-p2/openbot`，
分支 `codex/ts-control-plane-p2`，基于准确的 main 提交
`a8302c2d7252273ccb292f9fc5202beae4e165b6`（[PR #193](https://github.com/Peerframe/openbot/pull/193)）。
保留原 dirty 目录及其中的原生 Preview。此前已验证的 P1/P2 源码基于 `010439bb`；下文的检查、
ASAR 和性能记录仍是对应旧源码的日期证据，不能视作本次整合验收。

候选机械整合已有迁移及 C28/C26 改动，保留已接受的 C9/C11/C25 和 Claude 界面实现，
不新增页面设计。共享契约已包含 C9 外观 PATCH 与 C11 可选的 greeting origin。
已发布 `0052_bot_greeting_origin.sql` 与 main 字节一致；只把尚未发布的 C28/C26 迁移改为 `0053/0054`。
新建的锁定 npm/base/Worker 环境均在隔离目录里。没有向 Applications 安装应用；已安装 OpenBot
及用户 profile 保持不变。

完整源码检查点已保存在本地提交 `a240b810ea08bde29004e947b0ffc0298ad8dd1a`（217份改动文件）。
随后只读核对 GitHub，发现 main 已合并
[依赖补丁 PR196](https://github.com/Peerframe/openbot/pull/196)，提交为
`a544a40d045a1e99e512b3282a8805c7f4ca39e0`。自动整合只改两条已有锁记录：
fast-uri3.1.8、ip-address10.7.3；proxy-addr2.0.8已一致，没有改页面或产品源码。
[按消费者核对的记录](retained-developer-tools.md#integration-of-accepted-advisory-patches-2026-10-06)
说明 TS原生闭包包含 fast-uri；其增量资源刷新、包内 smoke及真实 TLS契约已通过。
下方日期证据仍保留实际执行范围。
下方保留 PR196之前的依赖范围，不将旧结果改称本次执行。
已接受的 [C29规划 PR195](https://github.com/Peerframe/openbot/pull/195)现已合并到 main，
准确提交为 `2bc698932596698d36e08f20bb4e26e9568b125c`，本地整合 merge为
`8152dd8ac77083b6d86a22913ec86ab1c685f5d6`。只改变十份文档/设计记录；产品、package、脚本、CI
及贡献规则路径与 `b466d758`字节一致。C29仍是提议，本次迁移没有实现它。此次纯文档整合的
`docs:check`通过12项、检查599份 Markdown，`research:check`通过27项；两者 exit0、测试无跳过。
PR-event检查因不处于 `pull_request`事件而跳过。产品源码未改，复用此前全门槛/原生证据的准确范围，
不为文档整合重建二进制。原生验收保留准确产品源码 `dfc8475f`。Claude仍开放的界面 PR194/PR198及调研 PR199不提供本候选的整体界面验收。
2026-10-06，所有者在此前已准备好的分支/Draft PR发布请求后回复“继续执行”，授权推送这条迁移
分支并创建 Draft PR来运行必需的 GitHub CI。已发布
[Draft PR #200](https://github.com/Peerframe/openbot/pull/200)，分支 head为
`49dac0186fa6a127dffc0b079458fca30ac54352`，base为 main `2bc69893`。
首次[托管 run37470541095](https://github.com/Peerframe/openbot/actions/runs/37470541095)检查 PR合并
检出 `7a16bc1`，生产 npm审计零命中。已观察快照为11项任务成功、4项失败，Temporal验收仍运行。
Linux Python/Worker、三个平台的保留客户端/Python Desktop、macOS混合 TS Preview、Windows Worker
构建、浏览器代理/恢复、合成迁移、scope与 validate通过。这些托管构建/测试只保留各自声明范围，
不证明发行签名、整体界面或 P4的 TS持久执行所有权。整体界面验收仍由 Claude负责，通过后才切换
P3写入方。

首次失败是实际门槛：精确扫描器拒绝五条未登记的历史合成 URI样例；两条容器 lane仍读取 C28已退役
的单例模型接口；installed harness质量检查停在一份 Work夹具的格式问题。本地继续跑该门槛，又发现
同一夹具的结构/动态类型缺口。限定修复只改测试、smoke client、扫描器精确记录及本记录，产品所有权、
公共路由、依赖与安全 workflow不变。

- [精确扫描记录](credential-scan-fixture-triage.zh-CN.md#ts-契约与私有-peer-样例2026-10-06)
  沿用固定完整历史扫描，不验证/上传，不按路径或检测器排除，不绕过错误。26项安全/工作流检查通过，
  27条不可变记录逐字段匹配，实际23条离线结果通过。TS入口33项、proxy peer17项、contract target11项
  定向检查通过。刷新全部远端历史后，在仅本地临时提交
  `db804e2d4d1777341d9394bb10722b456c6a1922`中包含候选修复，固定扫描器返回183、24条已审核历史
  命中；严格适配器以0退出，临时提交自身没有命中。随后只补入证据段落，最终 head仍须托管扫描。
- 已锁定 `harness:quality`通过 Ruff检查/格式与真实 SDK的 mypy，共24份源码；夹具改用真实
  `ReadStore`/`ReadResult`形状及准确 Pydantic样例字典类型，完整 JSON输出不变。
  新执行 `contracts:test`通过1,342项真实 DTO/Web对照和15项 client/target检查，无跳过。
- 固定源码 `49dac018`构建的 Linux arm64产品镜像实际重现旧 smoke在
  `/api/v1/settings/model`返回404。新 client检查该接口已退役、当前模型连接列表为空及转录选择为 null。
  同一镜像通过一次性容器的 schema前拒绝、55项迁移、Owner HTTP/已构建 Web、PDF/DOCX与离线 OCR
  初始化、重启保留密钥/文件、SIGTERM及所属资源清理。未配置模型或 Temporal。
  首次本地镜像继承私有 clone文件模式，入口拒绝读取；恢复正常 Git检出模式后重建，源码字节不变。
  本机 Docker arm64证据不替代两条托管 Linux平台门槛。

修复候选的 `npm run check`以0退出：lint10任务/0缓存、类型检查33/10缓存、测试27/12缓存、
build19/12缓存。protocol461、TS入口33、Web676、Desktop578通过/3项平台跳过为实际重跑；
未改缓存结果保留原范围。随后文档检查通过12项/599份 Markdown，研究检查通过27项，无测试跳过；
PR-event检查仍须在托管事件中执行。

修复已作为 `5ee5b3d72d65a596ea52f85956dc895ef32f60e6`发布到
[Draft PR #200](https://github.com/Peerframe/openbot/pull/200)。新
[CI run37475123514](https://github.com/Peerframe/openbot/actions/runs/37475123514)实际检查 PR合并源码
`002d938113f9cd1f3b71a88a17fef809f0558d73`，两个父提交是准确 main `2bc69893`及该分支 head。
完整运行已成功，17项任务全部通过，包含安全、两平台 Linux产品容器、installed harness/HTTP契约、
macOS混合 Preview、Python/Worker及持久 Temporal验收。托管扫描精确匹配23条历史样例，
生产 npm审计为0，58个外部 Python产品锁定依赖完整审计，没有已知漏洞或跳过。
本地24条回放保留不同 fetched-history范围。

未签名、独立身份的 macOS TS Preview及生命周期/性能证据分别位于
[CI候选工件11418388810](https://github.com/Peerframe/openbot/actions/runs/37475123514/artifacts/11418388810)与
[证据工件11419211146](https://github.com/Peerframe/openbot/actions/runs/37475123514/artifacts/11419211146)。
它们绑定上述 PR合并源码，只是自动化 Preview证据；没有下载或安装工件。
此前已验证的正式身份完整候选仍位于 `apps/desktop/out/ts-product/OpenBot-darwin-arm64/OpenBot.app`，
保留单独的准确产品源码 `dfc8475f`及真实 Electron/safeStorage回执。上述证据都不代替整体界面验收、
受限签名/access group配置或已注册 Worker执行。

托管 Python整合实际通过 base1,072项/2项可选 Temporal跳过、Worker1,589项/1项缺少历史的 replay
跳过，随后真实 SQL/HTTP读回及会话签发/撤销通过。准备流程还记录451通过/1跳过，以及一次性目标
建立前1,450通过/596跳过；跳过项不算已执行验收。持久 lane验证其单独的 Python/Temporal恢复及
相邻版本升级，不证明 P4的 TS所有权。

收尾核对发现 Claude界面 [PR194](https://github.com/Peerframe/openbot/pull/194)已新合并到 main，
准确提交为 `bc2b2e7e5960912d8a1033c74233e43f5c75a1e7`，涉及51份 UI/文档。
上述已完成 CI只证明准确 base `2bc69893`，不冒充这次后来界面整合的验收。
所有者随后要求修复历史 `a240b810`造成的全仓凭据扫描阻断。Codex已将五条精确记录、测试和双语
审阅发布为独立 [PR201](https://github.com/Peerframe/openbot/pull/201)，准确源码为
`190a196db3b224bd2743c0ce01fb004d678589c4`，基于 main
`bc2b2e7e5960912d8a1033c74233e43f5c75a1e7`；工作树 `credential-fixture-history`、分支
`codex/credential-fixture-history`。该小补丁自己的26项 focused测试、全仓检查及独立离线23条
发现回放通过；原 main适配器拒绝同一份真实扫描结果。Hosted运行
[37481999400](https://github.com/Peerframe/openbot/actions/runs/37481999400)全部17项任务通过，
包括安全任务和受保护 `check`；实际测试合并提交为 `0bdb8b3ede18aff3186419c02f130af2f7adcf88`，
两个父提交与上述准确 main/源码一致。
2026-10-07（Asia/Singapore），所有者明确批准此次 main合并。PR201已合入为
`a6ec303054c69429aabb0a09c972d5dd87ace941`（GitHub回执2026-10-06T17:00:20Z）。
其 tree `ea1aaa293250f3a4e87752a6821c6af612331e3e`与17项合入前 CI全绿的源码、实际测试合并内容一致。
新的 main [运行37500153005](https://github.com/Peerframe/openbot/actions/runs/37500153005)已独立通过
[安全任务](https://github.com/Peerframe/openbot/actions/runs/37500153005/job/112394782241)：23条精确
历史样例、生产 npm依赖零漏洞、全部58项外部 Python产品依赖已审计，无已知漏洞或跳过。
main全部17项现已完成并通过。main现在已有五条精确审阅；已有失败运行保留原源码范围，
新 PR运行应使用修复后的 main，不把原有失败回执改称通过。
独立补丁不实现 Claude页面；上面的当前检查点已完成接受的 PR194/main整合本机验证，当前候选
hosted CI和整体界面验收仍是 P3前置门槛。PR200尚未合并。

2026-10-06，所有者明确回复 Claude尚无 P2整体界面验收记录。该外部门槛仍待完成；Python仍是唯一
产品写入方，P3–P5尚未开启。上一轮只关闭 hosted CI修复，保留完整迁移已授权目标。已安装 ASAR仍与
P0基线一致，没有安装系统应用、修改已有 profile，或实现 Claude页面/C29功能。
此前两份交接回执是 Codex所有的本地文档修改，与当时已发布/已测代码 head区分；未改产品、依赖、
workflow或夹具源码。

当前整合证据（macOS arm64，CLI Node26.0.0，不是此前包内 Node24）：

- TS 生成及真实 Python/Web DTO 对等通过1,342项，契约 client/target通过15项。
  实际默认注册清单共121个操作，包含 C9 外观接口。
- Python 直连与 TS HTTPS 混合入口分别通过270项整合检查和19项 staging artifact检查，
  各289次执行，覆盖真实 Web/Desktop 请求组装及私有 Python 唯一写入方组合。
  TLS signed publisher通过12项、模拟模型通过18项；模型回执为10次发现、4次显式探测，
  未出现未授权派发、重试或回退。
- 迁移检查通过13项、无跳过、55份 SQL；新 S7通过40项，另一次真实已发布53→55升级
  保留预置偏好、profile、greeting记录及唯一约束，交付/清理通过20项。
  已发布前53项迁移记录和 SQL 与 main 字节一致。
- base/Worker闭包核对52/64个版本，harness及 wheel build环境也均位于项目目录。
  真实 Python base通过1,072项、跳过2项；首次整合 Worker确实失败两项发布测试
  （另1,587项通过、1项跳过）。C7改用 Chat Completions 后，模拟 handler仍写旧 Responses字段。
  共享夹具改为按协议填充文本，保留真实 SQL、receipt和发布断言；针对 runtime/model/result/profile
  的复查通过97项。完整重跑 exit0：base1,072项通过/2项跳过（149.44秒），
  Worker1,589项通过/1项跳过（631.04秒），之后真实 TS读回、会话签发/撤销也通过。
  base跳过的两个可选 Temporal模块已在 Worker执行；Worker的一项跳过需要保留的模拟
  deadline历史才能做真实 SDK replay，不能视作 replay或 P4验收。
- 生产依赖审计最初检出 proxy-addr2.0.7的一项严重漏洞；
  [已审阅补丁](retained-developer-tools.md#express-proxy-trust-transitive-patch-2026-10-06)
  只将这一条锁定记录更新为2.0.8。安装后信任范围正反检查通过，高危阈值审计 exit0
  （严重0、高危0、中等2）。受影响的 TLS MCP通过30项，既有 scaffold在全仓库检查中通过。
  此前全检查先因旧 S7 target pin、后因120接口数量断言失败，两者已修复；
  `npm run check`现已 exit0：protocol461、TS入口33、Web676、
  Desktop575通过/3项平台跳过；类型检查33任务/11缓存、测试27任务/12缓存、
  build19任务/12缓存。缓存结果保留对应范围，不能当作本次新执行。

本次 staging确实因固定 Node归档下载120秒超时失败，校验和与时限不变。
随后 curl完整下载通过同一个固定 SHA-256；staging复用这份已校验的官方发布字节，
核对59个锁定产品依赖。第一轮 Electron打包下载进程主动停止（exit143），再复用已核对校验和的
同版44.3.0发布缓存，重新打包当前源码的未签名 Preview。新 ASAR：
`a460a3676b64d03a6e7cd373d9fab5d94c3e650ed7b2cb77caddb51867388565`；
263份原生源码/迁移及5份编译后 Desktop启动器匹配。包内普通文件共1,115,397,045字节，
其中 native为783,638,392字节。真实包内 API smoke通过双服务退出、父进程 EOF、初始化 SQL、
重启保留数据及不安全目录/缺少 engine时拒绝，并清理所属进程。
这一无头 smoke的加密仍是模拟。另在这份精确 ASAR上实际运行 Electron，完成原生 Owner登录、
创建并命名 Bot、正常退出，再重启恢复已保存 Bot和实时连接。真实原生 `safeStorage`完成
bootstrap加密/解密；加密 bootstrap、私有模型密钥与 setup plan保持哈希和0600权限。
两次启动都以0退出，各13个已记录所属进程均结束，一次性 profile已清理。没有配置或调用模型。
界面树和持久文件提供功能证据；截图工具仍停在此前画面，像素/视觉验收尚未通过。
[当前回执](typescript-control-plane-p2-native.json)保留并分开此前证据。
没有包含 macOS Worker companion，也没有安装应用。

同源码 Node24.21.0原生开销已测完：3轮交替、每种组合 fresh/restart，共12次所属进程启动，
2,400次计时读取、240次预热。当前中位数 Python→TS：fresh5,264→5,672毫秒，
restart4,104→4,624毫秒；原生子进程 RSS165,792→269,936KiB（约增加101.7MiB），
health0.566→0.994毫秒、channels10.234→11.292毫秒。
两种组合使用同一份本次资源；[开销回执](typescript-control-plane-p2-overhead.json)保留全部原始观测，
确认所属进程停止、临时 profile清理。此前源码测量仍是单独的日期证据。
这只证明 API-only本机环回行为，不证明 renderer/Keychain、活跃 Work/Temporal或公开 TLS容量。

已接受依赖补丁的新增实证：安装后的12项依赖回归通过，生产依赖审计所有等级均为0。
`npm run check` exit0：类型检查33任务/28缓存、测试27任务/23缓存、build19任务/16缓存；
TS33、Web676、Desktop575/3项平台跳过及 MCP scaffold2为实际执行。完整混合 HTTPS通过
270项整合及19项暂存检查。只在此前已冷暂存验收的资源中刷新 fast-uri3.1.7→3.1.8，
核对91个适用 Node依赖和192份未改编译文件，再打包并执行原生生命周期 smoke。
ASAR仍为上述 `a460a367`前缀，变化在 ASAR外的 fast-uri资源。这个未签名 API-only Preview
普通文件共1,115,399,312字节，其中 native为783,640,659字节。新12次启动开销中位数
Python→TS：fresh5,508→6,162毫秒、restart4,423→4,864毫秒，子进程 RSS168,192→270,560KiB
（约增加100MiB）、health0.618→1.072毫秒、channels11.014→11.845毫秒。所属进程已停止，
临时数据已清理。回执同时保留原结果和补丁后观测；此前实际 Electron/safeStorage流程
只作为未改 ASAR组件的复用证据。

已安装基线还包含既有 macOS Worker辅助程序。API-only Preview按设计排除共享的生产服务身份，
所以它不能证明完整桌面资源相同。完整 macOS arm64 TS打包新增显式 `--ts-product`入口，
保留正式应用身份，并在打包之前要求提供已验证的辅助程序。`--preview --ts-product`
继续使用隔离身份、拒绝共享辅助程序。复用
[既有 C19打包决策](macos-worker-host-package-and-registration.md)和已审阅
Node22.22.2/npm10.9.9构建器，没有新增服务、依赖版本、权限或注册路径。
针对打包政策的39项检查通过，包含缺少辅助程序时在实际打包前拒绝。源码改动的
`npm run check`也通过：类型检查33任务/31缓存、测试27任务/25缓存、build19任务/17缓存，
Desktop576通过/3项平台跳过及 TS33为实际执行。完整资源检查点现已通过，源码为干净的固定提交
`6e9d13edc77e0bb4b1aa797a9701cf16cd7a877c`，双父提交保留迁移检查点与 main已接受的 PR196。
既有构建器使用官方 Node22.22.2/npm10.9.9和 SDK27.0；辅助程序元数据和包内运行时清单匹配
该提交。未签名完整候选位于 `apps/desktop/out/ts-product/OpenBot-darwin-arm64/OpenBot.app`，
ASAR为 `ce65a5f77610129f5b903e150d09129efe807127dc9da655a9b5c55e3c301b7e`。
普通文件共1,230,271,274字节，辅助程序占114,866,973字节。全部27,820份原生普通文件、32个
链接与暂存一致，37份编译后的 Desktop模块与 ASAR一致。包内原生 smoke exit0，覆盖 SQL初始化、
重启保留数据、双服务退出、父进程 EOF、不安全目录/缺少 engine拒绝及所属进程清理。
它使用合成加密和临时数据，不证明正式身份的界面或 Worker注册。此前 Preview的 safeStorage
证据仍保留独立身份和依赖范围。Electron打包跳过可选 `.icon`格式，既有 `.icns`仍保留。
没有安装应用、启用 Worker或访问用户 profile；已安装 ASAR仍与 P0哈希一致。
发行签名、受限 Keychain和整体界面验收仍须分别核对。


验证正式身份候选的实际启动前，源码核对发现既有 macOS旧配置兼容 helper可能覆盖显式的
Electron `--user-data-dir`，从而选中已安装的旧配置而非一次性测试目录。继续沿用已审阅
Electron44.3.0及既有 Desktop目录/加密身份政策，但显式目录必须在任何旧配置文件探测前优先。
默认启动仍先保留正式配置，必要时兼容旧配置。这是既有原生入口修复，没有新增页面或配置框架。
新增两种拒绝切换检查：旧 Preview存在时，分别显式选择独立目录和正式目录；既有默认/残缺配置
检查仍保留。

定向一手证据：[Electron路径 API](https://www.electronjs.org/docs/latest/api/app#appgetpathname)，
以及44.3.0的 MIT固定源码提交 `07e460719c75b2ec5ee4893f7d2192ef31c7b8c2`中的
[main delegate](https://github.com/electron/electron/blob/07e460719c75b2ec5ee4893f7d2192ef31c7b8c2/shell/app/electron_main_delegate.cc)
和[路径 provider](https://github.com/electron/electron/blob/07e460719c75b2ec5ee4893f7d2192ef31c7b8c2/shell/common/electron_paths.cc)。
原生 delegate在 JS入口之前应用非空 CLI目录，路径 API与单实例锁沿用这个选择。给现有 helper
加一个前置条件即可保留这一语义；测试专用 bootstrap会绕过真实入口、留下产品问题。
没有复制上游源码、改依赖版本、加密格式、数据迁移或权限。针对性检查通过7项。
首次全门槛 exit1：已完成辅助程序构建的 `.build/release`缓存链接被源码链接安全检查拒绝。
核对已复制的辅助程序后，只清理本次忽略的 Swift缓存，安全检查保持不变。全门槛重跑 exit0：
类型检查33任务/32缓存、测试27任务/26缓存、build19任务/18缓存；Desktop578通过/3项平台跳过
为实际执行。辅助程序源码及依赖闭包与6e9d13ed字节一致，可复用已验证的固定组件。
重新打包后的正式身份候选已通过实际启动与重启检查，准确产品源码为
`dfc8475f1412a7742b40f99ce6b720f3a428afee`，ASAR为
`f3f7edc56109338e53918a5ece92b60bd5bd4b2781232515d534df5851ff5e94`，
37份编译后的 Desktop模块与包一致。未改辅助程序保留6e9d13ed源码；此前资源及生命周期回执
仍对应各自的固定源码。

实际运行正式身份 Electron，显式一次性目录被正确保留，真实原生 `safeStorage`完成 Owner登录。
创建并重命名一个合成 Bot，正常退出并重启后，准确名称与实时连接均恢复。两个工作区检查点的
截图与界面树一致；这只是限定流程的功能观测，不代表 Claude的整体界面验收。
加密 bootstrap（JSON密文字符串）、32字节模型密钥和 setup plan保持哈希及0600权限。
两次启动均以0退出，各13个已记录所属进程均结束，PostgreSQL PID文件消失，一次性目录已清理。
没有配置/调用模型、选择/注册 Worker或安装应用。原有应用仍在运行，ASAR仍与 P0哈希一致。
受限 Keychain访问组配置、签名/公证、hosted/deployment及活跃 Work/Temporal门槛尚未通过。
既有[原生回执](typescript-control-plane-p2-native.json)将本次实际流程与此前 Preview及无头验收分开记录。

整合后正式身份 Electron/safeStorage功能检查点已关闭。下一有界检查点是核对 P2剩余的 hosted CI
和 Claude整体界面验收，通过后才切换 P3写入方。Python仍是唯一产品写入方，P3–P5尚未启用，
完整迁移仍已授权；未将剩余门槛改称通过。已安装 OpenBot的 ASAR仍与 P0基线一致：
`e1effed06195fed8bd9269b2a7c8447562156ac8a216ae4b81ae35cc316432e0`；Applications中没有安装 Preview。

### 保留此前候选的验收记录

所有者已批准 P0–P5，完整 TS 迁移及 Python/多余运行时退役目标保持 active。
P1 本地契约门槛已通过，P2 的转发与 macOS arm64 原生候选已通过本机检查，P3–P5 尚未开始。目录 `/Users/yxflc/Project/openbot`，分支 `codex/c22-c24-storage-follow-ups`，
HEAD `010439bb9002fabb7e1facd8450ee85edbafa309`。保留原有 C28/model、workspace-primary 改动、
用户数据/配置及已安装 Desktop。安装版仍是 Python 基线；已新增 `apps/server-ts`，没有删除 Python 路由。
未提交、推送、发布或调用付费/真实模型。

一位实现者拥有未提交迁移内容：共享 HTTP/OpenAPI/native/Work 定义、domain 别名、Web Work/native/
存储/附件/插件/浏览器/portable 投影、生成/对照脚本、`packages/contract-tests` CLI/client/target 与合成 DOCX/Node/产物/MCP 夹具、
`test-contracts-python.ts`（含独占单组/publisher 选择）、实际 Web/Desktop 传输夹具和精确代理修复、既有 CI
选择/安全扩展及双语记录/地图，含五个 Python 契约/夹具脚本，其中一个是合成模型入口。
接续前核对实际 dirty 文件。
P2 还拥有 `apps/server-ts`、Python 私有 peer 适配/原解析器衔接、混合夹具/CI 命令、生产闭包选择及许可声明。
原生启动器/暂存/探针、同源码开销/CI 与直接 TLS 入口扩展也属于迁移范围。

当前分工：Claude 负责页面实现和整体界面验收；迁移实现者负责后端、契约及原生启动链路。
P1 已修改的 Web API/类型适配属于必要契约迁移，保留这些改动，不扩展成页面开发，也不撤回无关 Claude 改动。
原生启动/重启冒烟只作为迁移范围证据，不代表页面已验收。
没有往 Applications 安装应用。锁定的项目依赖与一份独立 TS Preview 包留在仓库输出目录，保留已安装 OpenBot
及用户 profile。

TS 主导全部真实默认120个 HTTP 定义：Work8、核心 control24、resource32、lifecycle17、
Employee10、automation4、Node5、plugin12、browser4、portability4。
[Control OpenAPI](../../packages/protocol/generated/control-openapi.json)与 Work 兼容类型生成无需 Python。
Web 插件类型来自严格 HTTP schema，并明确保留可选结果投影；原有 Node 插件 schema 仍是兼容定义。
[真实清单](typescript-control-plane-route-inventory.json)记录默认注册、Web/Desktop/Node/原生 Host 消费者源码摘要
及注册/组装边界，不能代表完整条件执行或迁移验收。产品模式已包含全部注册器；可选 publisher、Temporal/
browser/command 配置改变既有服务行为和 wire 通道，不是缺失的默认 HTTP 路由。

复用 Zod4.6.2、openapi-typescript7.13.0、生成器 TypeScript5.9.3；测试本地 JSON Schema 引用和带标记的
递归 JSON-value 映射，仍保留运行时 refinements。沿用[复用记录](../OPEN_SOURCE_REUSE.zh-CN.md)中
C7/C19/C21/C22–24/C28、C3 审计、C49 审批、ADR-0047 身份、Employee profile/记忆/技能/知识、
自动化、Node 身份、Run 文件、官方 MCP SDK1.29.0 与 C8 目录决定。P1 未增加运行时依赖；
P2 按审阅版本安装 Fastify/reply-from，没有复制上游代码。
浏览器/portable 沿用原 Host/pause gate、审阅绑定导出、Agent Skills 闭包及审阅激活/DSSE 决定。
Employee 演化/学习保留 Hermes Agent 归属。

保留产品 `{error}`、独立 Work `{detail}`、Work/存储/审批设置原始整数 token 拒绝、模型/Employee 版本及
自动化间隔的数学整数小数表示。保留 UUID/default/trim/码点/UTF-8 适配。
一般可选 DTO null 省略，必需模型用量/进度、知识拒绝 `memoryId` 和自动化历史 null 保留；
SSE ready 无 `occurredAt`。密码保留空白、拒绝孤立 surrogate；连接/PDF/记忆/自动化按 UTF-16，导入 Markdown 按 UTF-8。
保留原始 URL 控制字符检查、未 trim 数字 semver、产品17项与保留 Node20项 capability 区别及记忆 surrogate503。
引用身份、IANA 时区、YAML/凭据扫描、合并记忆策略及依赖仍由服务校验；审计保留字段白名单、码点截断及偏好 ID null。
Node bootstrap 不要求 Owner/Origin，签发/撤销要求；保留凭据轮换、socket 断连、8192字节及限流 Retry-After。
产物保留 PNG/Markdown 字节、disposition 和键/大小/digest/no-follow 检查。

插件 UUID 保留大小写/非版本布局，版本比较区分大小写；Python trim 包含0085/C0、保留FEFF。
受约束直接文本按 UTF-16、拒绝孤立 surrogate，集合文本按码点；无约束 createdAt 可保留 surrogate 序列化。
地址语法/DNS/HTTPS/精确本机白名单、声明 digest、已声明授权及频道成员仍由服务校验。
no-op 轮换版本，更新始终禁用/清空授权，公开记录省略 token。HTTP 上限24576字节，内部内容输入/普通结果12KiB，
已声明 app 结果160KiB。独占 MCP 控制端使用不同秘密，只接受有界声明/内容调整，不执行工具。
默认 PluginService 无旧式 Run guard，旧式决定 HTTP 只验证 Owner/Origin/形状/未知调用拒绝；
成功旧式决定和原生持久化审批仍须单独验收。

浏览器 HTTP 保留码点/原始 AnyUrl、严格动作和必需 controlAvailable，Web 明确保留可选标记投影。
原 Host 凭据/socket 绑定、默认关闭的人控及 PNG 字节/尺寸由服务验证。真实客户端取消在当前产品入口
不会立即释放等待，而是保留 gate 至原命令25秒期限；黑盒验证有界释放、零自动重试，不冒称即时断连取消。
合成协议端在清理前停止并等待结束。

portable 保留分钟精度 UTC 时间，区别于浏览器秒精度；严格外观、受限 Markdown/license 和 DSSE null 扩展省略
不改变编码 payload 字节；浏览器日历允许 year 0000，包只允许1–9999。激活内部 JSON 由服务解析，checksum/信任/扫描/闭包/审阅由服务授权。
强审阅标签保留412/428。真实未签名 v1/v2 下载、隔离预览、分别保持 checksum 有效的阻止包和并发激活证明
只产生一份新身份/回执，技能 candidate、模型使用关闭、不导入记忆/Host 权限。
独立 publisher 组装使用现有 CLI 的临时加密 keyring，通过12项真实 HTTP 检查：已审阅 v1/v2 下载字节、
独立 Ed25519 核验、可信隔离预览、裸签名文档/篡改/自带非可信公钥拒绝、不具有授权效力的提示及一份并发签名回执。
夹具只接收公开公钥/指纹；私钥/口令随本次根目录清理，不加载 `.env` 或输出秘密。
导入只接受 JSON。Web 原先误发下载 MIME 导致422，现以 application/json 上传同样字节。
激活注册200、首次创建201/重放200；清单保留注册证据，TS 明确发布实际两种成功响应。

上一检查点 `contracts:test` 通过1283项未变 Web/Python/TS 用例（其中一项执行171项冻结比较器），本轮复用该证据。
当前15项客户端/目标测试通过，含限定 Work 发布状态、仅公开 publisher 元数据及4项合成 SSE UTF-8/帧/字节负例；复用既有生成/OpenAPI 证据。
新执行的完整 all/inventory 使用真实独占 `serve.py`/PostgreSQL/私有 MCP CLI，通过
Work29、resource34、lifecycle21、Employee30、automation10、Node/socket18、集成 Run/native 产物17、插件/MCP30、
browser/socket14、portability/bytes13、核心/SSE49：集成265项。分阶段产物通过19项含两条本次链接，
共267项不同检查、284次执行；复用上一检查点单独签名 publisher 的12项结果，受影响 resource 两次均通过34项并复验实际 Web/Desktop 组装。
此前已验证未知/重复参数和部分清单请求在创建夹具前拒绝。单组不能重写完整清单，新 all 更新120条真实注册
和34份消费者源码摘要。[测试说明](../../packages/contract-tests/README.zh-CN.md)定义可复现输入。

单独 models 组装通过18项真实 Owner HTTP 检查：真实 `serve.py`/PostgreSQL、既有可信 transport factory 和 SDK，
覆盖 OpenAI Chat/Anthropic 发现/探测成功、256项过滤/去重、未保存验证、凭据失败、跳转、无效 JSON、
过大声明响应及提供商不可用，不泄露私密诊断/凭据。仅次数回执确认恰好10次发现、4次无工具探测，
越权派发/重试/回退均为零；产品配置/请求头/路由不能选择夹具，不使用真实提供商、`.env` 或付费调用。
首次失败来自测试基线错误：第二次未保存验证仍与初始空快照比较，忽略第一个已保存的夹具连接。
改为请求前后比较后通过，最后删除本次保存记录并恢复初始连接快照。

Work 新增7项，验证成功原生批准/拒绝、一条并发决定/事件、过期/代际/digest 保护、一条待处理查询命令及
重放/CAS/取消。使用合成 SQL 发布状态；未知结果、空证据/用量及撤权保留，不准入 executor 或解决结果。
现有安装 TS Node/Worker 对照 pytest 通过1/1，现有比较器通过48项 runtime wire、34项 Owner 命令、40项
执行值及20种失败码。CI 独立要求未签名 all、签名 publisher、models；增加变体发现原先按子串检查可能
用变体冒充 all，现改为完整命令行，局部目标/工作流26/26通过。

追踪消费者发现两处真实 Desktop 失败：Owner 上传丢失必需文件名头，六类已有 PUT（设置、主 Bot、插件授权）
被只允许反应 PUT 的代理拒绝。现已保留两类精确原始上传入口及全部七类已声明 PUT，不扩大其他路径/方法
或凭据、Origin、字节、跳转边界。Desktop 局部45项检查通过；独占 Node-Fetch 夹具调用实际 Web 模块经实际
代理到真实 Python，五类设置 PUT、Owner 上传/列表/原始下载/删除及删除后拒绝通过。
其他消费者以源码摘要列入清单，不冒称全部执行。原生 Work 动作/产物在现有 Web 只显示；安装版 Electron、
Swift URLSession、Windows 监督/运行时仍单独验收。

原生 Work 使用现有私有8MiB 内容寻址根：原始 PNG/Markdown/空二进制、UTF-8 文件名、sandbox 头及严格快照
摘要/大小/下载链接通过；摘要/大小不一致、缺失、过大物理文件及目标内容有效的链接拒绝。
存储整根测量拒绝链接，因此先验两条本次链接，再仅移除这些链接。合成 SQL 预置不证明 Worker 发布，
没有 executor/Temporal/浏览器/真实提供商执行证据；MCP 声明/内容/session 清理真实、工具零调用、无 bearer 泄露。

SSE 是无内容、无 replay ID 的轮询失效通知。真实消息变更通知工作区/频道，多次变更加慢速读取合并后刷新权威状态。
频道墓碑和密码撤权关闭频道流并拒绝重连，工作区撤权也关闭；客户端另拒绝不完整帧/UTF-8 和实际 UTF-8 超过4MiB。
低量慢速读取和合成分帧不证明饱和压力，该项归 P2 混合转发验收。单请求仍10秒、DOCX35秒；独占全部180秒、
单组120秒，失败时停止并回收。

保留真实失败与修正：普通文本提取返回415，成功路径改为现有发布版 DOCX；故意创建的链接正确导致整根存储统计503，
因此先验链接再仅删除本次链接进入集成。DOCX 超过旧10s客户端限时，仅两次提取改35s，对应产品30s上限；
其余请求10s，后续全部套件预算含浏览器/SSE 期限。插件对照纠正 surrogate/直接字段与集合/createdAt 假设，显式场景解析修复 CLI 联合类型收窄。
浏览器/portable 对照纠正严格外观、DSSE null 扩展及 year-zero 日历假设。首轮总检查发现清单 Work/HTTP 联合类型
收窄错误，修正后 scripts typecheck 通过；MIME422、注册200/实际201 假设均已纠正。
control 夹具 Ruff check/format 再次通过；未变化的 MCP/Work/export Ruff 复用上一检查点证据。

model/native-action 检查点的 `npm run check` 退出0：docs12/12、585份 Markdown，research27/27（非 PR 跳过 PR-event）；
前置10/10（缓存1）、类型32/32（缓存10）、测试26/26（缓存12）、构建18/18（缓存12）。
protocol460、Web650、Desktop555、客户端/目标15项测试通过；8项既有跳过（release2、Desktop Windows3、Node 凭据存储3）；Node129项本轮重新执行。
首次沙箱总检查在5项既有本机监听测试因 `listen EPERM` 停止，获测试权限的重跑完成这些检查及完整总检查。
既有 lint/chunk/Vite 及 MCP SDK settings 警告不阻断。最后纯交接文案执行 docs/research/空白检查。
本次 HTTP/MCP 子进程、Docker、私有凭据和临时目录已清理，该检查点没有本次产品/夹具写入者在运行；model/native-action 总检查已完成，安装版仍是已验证 Python 基线。

P1 退出范围是全部默认公开注册/已核对消费者、共享 schema/Python/Web 对等、当前 Node/Worker wire 及配置的
publisher/provider HTTP。本地门槛已关闭，远程 CI 尚未执行。可选 Temporal/browser/command 改变既有接口的执行，
不是缺失注册。缺少 Run guard 的成功旧式调用、可信浏览器/工具执行和引擎发布保留对应 P3/P4 验收；
不增加产品回退或把 P1 延长为引擎重写。饱和压力/转发/反向切换属于 P2，原生打包属于 P2/P5。
固定上游 TS 入口与混合契约已完成以下本机检查。下一检查点：对外/TLS peer 及必需远程目标检查；
这些过关前不切换 P3 操作归属。冷原生打包、独立 Desktop 启动/重启与同源码 API-only 转发开销已完成下方本机验收。
继续所有已批准阶段直到退役及原生/远程目标验证；
完整目标 active，无需用户输入才能继续。

P2 入口检查点：`apps/server-ts` 是实际运行的 Fastify5.12.5/reply-from12.6.5 服务，只有一个数字 loopback
HTTP 上游，不转换 body、不隐式重试、不跟随跳转或使用替代授权。Worker 用原始 upgrade/双向字节 pipe，
握手等待、流缓冲和关闭有界；Python 原 registry 继续认证每个 Host。显式 ASGI 单跳适配复用 C19 网络身份，
向既有登录提供原始地址，向 Node 注册提供私有来源/摘要，公开 scheme/Host 固定配置，不开启 Uvicorn 通用代理解析。
配置成对且错误时拒绝，代理模式禁止 Python 公开监听。

本轮传输26/26（真实 loopback 合成 HTTP/WS）、Python 原路由/peer 局部43/43（无跳过）、工作流/选择37/37、
生产闭包6/6通过。覆盖原始无效 JSON/整数 token、重复 query、多个 cookie、原始/gzip 字节、307、凭据/Origin/
If-Match/文件名、伪造元数据、固定目标、503/socket 丢失/写操作零重试、响应头前取消、128请求饱和/释放、
SSE 背压/取消、WS 二进制/ping/close/即时 head/非101拒绝与握手中断。慢速客户端让256MiB 合成源在完成前因
背压停止，不代表安装版/原生/公开吞吐。只对有界8KiB WS 拒绝 body 重设 chunk framing，接受的流保持原样。

混合 all 通过265项集成加19项分阶段产物检查（267个不同检查/284次执行），实际 Web→Desktop 代理→TS→Python
设置/Owner 附件字节也通过；签名 publisher12、models18复用相同真实 HTTP/SQL 夹具，计数仍10次发现/4次探测。
独立 Node18检查真实 SQL 注册来源为 forwarded、摘要来自直接客户端。最后 all 在同一个 URL/SQL 库上执行
mixed→direct→mixed，每步先等待旧服务结束；原会话和 Bot 投影保留、每步一个写入者，然后完整契约与 SQL 来源通过。
没有搬数据或增加产品回退。

保留并修复真实失败：完成的 HTTP 响应仍触发 abort，影响重用 socket，导致浏览器清理时 TS 崩溃；改为只取消
提前关闭。握手前暂停原始 socket 漏掉 FIN，改为有界 PassThrough 并读取 end；复制 chunked 头但发送解码后拒绝
字节使客户端 aborted，改为有界重新 framing。首轮总检查发现夹具误用数据库 `.sql`，改为真实 `.client`。
修正后的 `npm run check` 退出0：docs12/12、588份 Markdown，research27/27（非 PR 跳过 PR-event）；前置10/10
（缓存2）、类型33/33（缓存10）、测试27/27（缓存12）、构建19/19（缓存13）。其中传输24实际执行；未变缓存套件
保留原证据及8项既有平台/release/凭据跳过。新源/夹具 Ruff check 通过，未批量格式化旧 Python；未运行远程 CI。
精确 npm lock、许可声明和生产闭包已接入；high 阈值生产审计退出0，仍报告上面2项 moderate。本机候选不关闭 P2，
该入口检查点时原生/公开/TLS 打包与开销仍待验；原生候选现已完成下方验收，已安装 Python 保持不变。

最后补充2项拒绝 upgrade 的生命周期检查：错误 Host/伪造 peer 在上游派发前关闭，入口仍可用；被拒绝 socket
也负责 error/end 清理。最终总检查退出0，传输26本轮执行；前置10/10（缓存10）、类型33/33（缓存32）、
测试27/27（缓存26）、构建19/19（缓存18），先前成功套件复用而非重跑。四类缺失/错误/重复/TS-inventory CLI
在创建夹具前拒绝。更新后的直接 Python all 通过同样265+19项及真实 Web/Desktop 传输，SQL 注册来源/摘要验证
为 direct。该检查点自有进程/容器、临时私有凭据与夹具根已回收，没有本次夹具写入者或长进程仍在运行。

### P2 原生候选验收

独立 macOS arm64 `OpenBot TS Preview` 通过严格资源标记选择 TS/Python 共存。保留一个原 PostgreSQL
监督者/迁移器，Python 是唯一数据库写入方且私有监听，TS 占用公开端口，只接收传输配置。
资源缺失/错误在启动写入者前拒绝；任一子进程退出会停止另一方，正常停止按 TS、Python、PostgreSQL 顺序进行。
共存阶段仍需要保留的 Node 运行时。

最终编译源码的冷暂存、打包和包内原生冒烟均通过。冒烟验证真实 Owner 登录、数据库初始化/数据保留、
父进程 EOF、两种子进程崩溃顺序、不安全目录拒绝、缺少引擎的执行配置拒绝及全部自有进程退出。
其中加密回调是合成夹具。另用一次性 profile 实际运行 Electron，验证原生启动、Owner 登录、保存 Bot、
重启/实时连接恢复，以及真实 `safeStorage` 加密/解密后 bootstrap/key 文件保持不变。
最终安装包恢复同一 profile 并以0退出，自有 API/数据库进程确认已结束。没有模型调用；没有修改或停止
原有已安装 OpenBot，也没有修改其数据/配置。

候选入口：`apps/desktop/out/ts-product/OpenBot TS Preview-darwin-arm64/OpenBot TS Preview.app`。
最终 ASAR SHA-256 为 `9464016f705a9bfe942586ce47474d0a0badcd206f9f80cdfbb946e749b3a60f`；
五个编译启动模块与包内字节完全相同。排除链接的普通文件大小：整个 app1,115,059,373字节，
native783,415,863字节。历史 P0 安装版源码/构建不同，这些数字不证明迁移后变小；Python 与额外 Node
保留到约定退役关卡。[脱敏原生证据](typescript-control-plane-p2-native.json)区分早先首次运行/重启的包、
最终包的恢复和合成冒烟。

最终 `npm run check` 在清空继承环境并限制 worker 后退出0：
`env -i PATH="$PATH" LANG=en_US.UTF-8 TURBO_ENV_MODE=loose VITEST_MAX_WORKERS=2 npm run check`。
docs12/12覆盖588份 Markdown，research27/27（非 PR 跳过 PR-event），前置10/10（缓存0）、类型33/33
（缓存10）、测试27/27（缓存12）、构建19/19（缓存12）。Desktop565通过、3项既有平台跳过，Web650及
TS 传输26实际执行通过。保留此前沙箱 `listen EPERM` 与并发压力下三项既有 Desktop 超时的失败记录；
这些未修改测试单独6/6通过，最终总检查也通过，没有放宽超时或关卡。原生策略/生命周期及移除 CI 阶段的
负面检查通过。既有 macOS preview CI 增加混合冷暂存、冒烟、打包和包内冒烟；远程执行尚未验收。
最终仅记录改动运行 docs/research/链接检查。

这是未签名的本机 API-only 候选。对外/TLS 部署、远程目标检查、签名/公证及
Work/Temporal 执行仍待验证，P2 和完整迁移目标保持 active；仅凭这些证据不能切换 P3 写入方。

### P2 TLS 前的同源码转发开销

[可复现探针](../../apps/desktop/scripts/measure-ts-product.ts)在 macOS27.0.1/26A434 arm64 上，使用保留的
Node24.21.0、当前已编译 Desktop 启动器和同一份新暂存原生资源运行两种组合。每种组合三轮，交替执行顺序，
每轮首次初始化 profile 后重启。原生/API 范围及等待2s、间隔500ms采样三次 RSS 与 P0 相同；比较的是当前
Python 直连与当前 TS 转发，不是历史 P0 安装版源码，也不是渲染器启动时间。每种组合包含600次 health、
600次已认证频道读取，串行执行，每个目标/启动先预热10次；完整读取并核对响应，请求和整组均有限时。

| 指标 | Python 直连 | TS → Python | 差值 |
| --- | ---: | ---: | ---: |
| 首次 profile 就绪中位数 | 3,551ms | 3,596ms | +45ms |
| 重启就绪中位数 | 2,424ms | 2,563ms | +139ms |
| 原生子进程 RSS 中位数 | 156,504KiB | 256,128KiB | +99,624KiB（97.3MiB） |
| health 延迟中位数 / p95 | 0.571 / 0.930ms | 0.935 / 1.430ms | +0.364 / 0.500ms |
| 频道读取延迟中位数 / p95 | 8.788 / 11.299ms | 9.990 / 12.602ms | +1.202 / 1.303ms |

[原始观测和源码摘要](typescript-control-plane-p2-overhead.json)保留全部12次启动，包括首次 Python 初始化的
16,453ms，没有丢弃异常点；三次启动观测不足以可靠估计尾部。RSS 每种组合共18个样本，排除观察者的 `ps`
子进程；原有安装版 OpenBot 不在本次后代树中。TS 进程 RSS 中位数99,544KiB。这些是串行本机/API-only 成本，
不证明工作负载容量或公开网络性能；运行中的 Work/Temporal、渲染器/Keychain 和远程平台单独验收。
共存阶段仍保留 Python 与额外 Node，没有达成 P5 的体积/运行时退役目标。

实际探针核对一或两个本次产品 PID，每次启动后停止全部产品/PostgreSQL 进程，确认 health 不可达且无自有
后代，再移除私有目录。未使用原有 profile、配置的外部传输或真实模型。第一次输入检查在创建数据库前发现
包内 lifetime 模块的排版漂移并拒绝；当前构建/冷暂存通过严格摘要校验。历史包内原生记录保留自己的 ASAR
身份，没有冒称是这次暂存资源测量。三项归属检查通过；工作流11项检查现也拒绝移除既有 macOS Preview 通道
的新同源码开销阶段/产物生成命令。远程执行仍待验收。

CI 改动后的最终集成 `npm run check` 使用上面相同的清空继承环境、两个 worker 命令，退出0：docs12/12
覆盖588份 Markdown；research27/27（非 PR 跳过 PR-event）、前置10/10（缓存0）、类型33/33（缓存10）、
测试27/27（缓存12）、构建19/19（缓存12）。Desktop568通过、3项既有平台跳过，Web650及 TS 传输26再次
实际执行。CI 修改前的一次集成也通过，未冒称其覆盖后来的工作流改动。新增探针的 scripts 类型检查及格式
检查通过；最终纯记录改动运行 docs/research/链接检查，不仅为文案重跑未变化的全套。

### TLS 组合决定与本机验收

作决定时，入口允许 HTTPS 公开 origin 字符串，却没有配置 TLS 监听器；字符串本身不提供传输安全。入口还拒绝外部
转发头，因此额外 TLS 代理需要新的可信组合才能保留原始客户端身份。实现复用已审查的 Fastify5.12.5/
Node24.21.0 直接 HTTPS。[Fastify HTTPS API](https://github.com/fastify/fastify/blob/v5.12.5/docs/Reference/Server.md#https)
及[官方 HTTPS 测试](https://github.com/fastify/fastify/blob/v5.12.5/test/https/https.test.js)提供发布版 key/cert
服务路径；其关闭证书验证的测试客户端不能作为 OpenBot 验收方式。保留显式数字 IPv4 监听；
[issue7043](https://github.com/fastify/fastify/issues/7043)涉及默认双栈的第二监听器，支持保留当前约束的判断，
不是 OpenBot TLS 已通过的证据。

备选 [Caddy2.11.7/72dd0fb](https://github.com/caddyserver/caddy/releases/tag/v2.11.7)采用
[Apache2.0](https://github.com/caddyserver/caddy/blob/v2.11.7/LICENSE)，持续维护并提供 TLS/代理生命周期，以及
[头部](https://github.com/caddyserver/caddy/blob/v2.11.7/modules/caddyhttp/reverseproxy/headers_test.go)和
[流测试](https://github.com/caddyserver/caddy/blob/v2.11.7/modules/caddyhttp/reverseproxy/streaming_test.go)。该版本
修复流/HTTP2 超时回归；既有[代理头语义](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)仍需
明确可信边界。当前固定入口无需新增 Go 服务及第二层 peer，因此不选择或安装它。复用 Node/Fastify 许可，
没有复制上游源码。

现有实现监听前验证操作者提供的有界 key/cert 文件，要求实际 scheme/Host 与证书一致，最低 TLS1.2、握手5秒、
最多192个 TCP 连接。文件必须为规范 POSIX 路径、当前 UID 所有的单链接普通文件；密钥0600，证书链禁止组/其他用户
写入，分别限制16KiB/64KiB。检查叶证书不是 CA、SAN、私钥匹配、有效期及受限扩展用途。
Node24.21.0 的 [TLS](https://github.com/nodejs/node/blob/v24.21.0/doc/api/tls.md) 与
[X509 API](https://github.com/nodejs/node/blob/v24.21.0/doc/api/crypto.md#class-x509certificate) 提供这些公开 API。
[RFC5280 §4.2.1.12](https://www.rfc-editor.org/rfc/rfc5280#section-4.2.1.12) 定义扩展用途限制。
没有启用通用代理信任、ACME 服务或部署。

当前源码传输测试33项通过，包括真正开启证书验证的 HTTPS/WSS、不可信 CA/明文/伪造 peer 头拒绝、原始字节与
安全 cookie 转发、停滞握手超时，以及关闭时清理未完成 socket 和活跃隧道。操作者测试在监听前拒绝错误 SAN、
私钥不匹配、CA/仅客户端用途证书、无效日期、权限、畸形/过大文件及链接。一次性 OpenSSL 签发沿用现有
work-journey 夹具；不随产品交付 CA/密钥，不关闭客户端证书验证或更改系统信任。

`contracts:http:tls` 在真实 Python/一次性 PostgreSQL 上通过 all 组（265项集成＋19项分阶段产物），执行实际
Web→Desktop→TS→Python 设置与附件传输，验证 `__Host-` cookie 属性、HTTPS 标准重定向、私有直接请求拒绝、
同 URL/同会话入口重启与 Node 身份来源/摘要。独立签名 publisher12项、合成 SDK model18项通过；provider receipt
记录10次 discovery/4次显式 probe，没有未授权派发、重试、fallback 或真实模型调用。当前 HTTP all 也重新通过
284次执行及 mixed→direct→mixed 会话/SQL 反向切换；HTTPS 重启不能替代移除入口检查。既有 Pydantic settings
前向引用警告仍非致命且未变化。

8种无效 TLS/driver 参数在产品/数据库启动前拒绝。脚本类型检查通过；既有 workflow11项正反测试要求契约 lane
保留3个 HTTPS 变体。Desktop 启动链局部检查53项通过、2项既有平台跳过，包括缺少 TLS 资源时在 Python 启动前
拒绝。以上为本轮执行，未把旧 HTTP 结果标成 TLS 证据。文件策略的证据属于 POSIX，不证明 Windows ACL。
TLS 测试只在存在 POSIX UID 支持时执行；本机负向测试验证缺失 UID 支持时在文件访问前拒绝 TLS。
既有 HTTP 传输测试保留可迁移范围。

以上使用本机 CA/loopback 和一次性数据，不证明公开 DNS/生产 PKI、托管 CI、签名或运行中的 Work/Temporal。
ADR 的 P2 关卡仍是混合入口/Desktop、实测开销、私有上游与反向切换，不扩展成未经请求的生产部署。
集成/发布结论仍须满足必需托管 CI。

最终含 TLS 模块的原生资源按既有 lock 重新构建/暂存/打包，包内 smoke 通过父进程 EOF、两种子进程崩溃顺序、
私有配置/目录拒绝、Owner 登录、SQL 持久化/重启与产品/PostgreSQL 完全退出。当前 ASAR 为
`9db8fae930241a5d6a9dac7422469041d803453cc02ee6a87d61ac197a02fd76`；5个已编译 Desktop 启动模块、
6个 TS 传输模块都匹配暂存/包内资源。原生组合仍用 loopback HTTP，HTTPS/WSS 另按上方验证。
较早的实际 Electron/safeStorage 流程仍对应原 ASAR，不冒称本包或整体界面验收。
[原生记录](typescript-control-plane-p2-native.json)保留原观测，并新增独立 `subsequentTlsQualification`。
当前应用普通文件合计1,115,071,028字节，原生资源783,426,291字节；不能与旧源码比较后宣称 P5 缩包。

最终同源码原生 HTTP 测量使用这份精确传输/启动器资源，在完整检查结束后运行。每种组合3轮交替顺序，保留全部
12次首次/重启、2,400次串行计时读取及预热；没有删除异常值，包括首次 direct 启动17,567ms。
启动只有3轮，仍为描述性观测。[最新开销记录](typescript-control-plane-p2-overhead.json)的 `previousRuns`
保留前两次的原源码摘要和结果，没有合并采样。

| 最终指标 | Python 直连 | TS → Python | 差值 |
| --- | ---: | ---: | ---: |
| 首次 profile 就绪中位数 | 3,247ms | 3,604ms | +357ms |
| 重启就绪中位数 | 2,264ms | 2,596ms | +332ms |
| 原生子进程 RSS 中位数 | 158,464KiB | 259,248KiB | +100,784KiB（98.4MiB） |
| health 延迟中位数 / p95 | 0.568 / 0.916ms | 0.890 / 1.246ms | +0.322 / 0.330ms |
| 频道读取延迟中位数 / p95 | 9.089 / 11.156ms | 9.913 / 11.600ms | +0.824 / 0.444ms |

POSIX 范围/负向测试后的最终 `npm run check` 通过：docs12/12（588份 Markdown）、research27/27
（非 PR 环境跳过事件门槛）、前置10/10（缓存10）、类型33/33（缓存31）、测试27/27（缓存25）、构建19/19
（缓存17）。Desktop568通过/3项既有平台跳过、TS33为本轮执行；Web650复用本检查点较早成功完整检查的缓存。
较早完整检查实际执行 Web650/TS32，不包含后续缺失 UID 用例。仓库 Biome 格式与空白检查通过；较早 sandbox
中的 npx 查找因 DNS 失败，不计为通过。

两份测量均核对所属进程退出并删除临时数据。候选包留在 `apps/desktop/out`，未往 Applications 安装或新增常驻服务。
P2 后端/原生本机候选已准备好；必需托管 CI 与 Claude 的整体界面验收仍是独立待验证证据。
下一检查点核对这些既有关卡，并准备一组 P3 设置/读取的真实 SQL 正反切换；当前未启用 P3 写入方。

### P3 Owner 身份认证决策（2026-10-08）

#206 已合入 `41a1a5b57b258e5b34d9c4ef80096b69b376930f`，源码树与已验收候选一致。下一组一次迁移
登录、登出、会话读取、会话列表、撤销其他会话和修改密码六个操作，由两端显式选择 `owner`。
本地验收见当前检查点；发布、生产选择与 P3 完成是后续门槛。其他 Python 权限与 CLI 恢复入口保留。

复用 Node 内置异步 scrypt、randomBytes、timingSafeEqual 和现有 Postgres.js3.4.9/PostgreSQL17.11。
已查阅 Node22.22.2 提交 `2645dc73720b1b4f27c49f395d3c66025ce126cc` 的官方 crypto 文档、RFC7914 和 OWASP
密码存储指南；链接见同名英文决策。对比 MIT 的 @noble/hashes2.4.0（提交
`663c2aeeffc308ac0cded59bd32f7c212adacfc2`）的发布、测试、安全说明及 UTF-8/异步循环问题后，
选择内置接口，避免新增密码学依赖和 JS 调度适配。该库旧版独立审计不代表此版本已审计。
没有复制或实质改编上游实现，也不安装新依赖。

保持现有加盐 scrypt 格式与 N32768/r8/p3、64MiB 内存上限、32 字节结果和 UTF-8 标量校验。
数据库密码优先于启动配置，不改表或重写凭证。原生计算即使超时/断连仍占用名额直至实际结束。
验收须覆盖认证全局锁先于会话锁、共用网络节流、计算后密码版本复核、提交后发 Cookie、
会话过期/撤销、审计失败原子回滚、输入/计算/SQL 有界和禁止回退重试；失败尝试必须提交。
真实 SQL HTTP/受信 CA HTTPS、并发旧密码拒绝、两端密码与会话反向切换、UI12/12、完整检查及原生
暂存/打包启动重启均是门槛。只在实际运行后更新现有验收记录。

### P3 频道读取组决策（2026-10-08）

本地候选迁移 Bot 列表、频道列表、消息分页、运行列表 4 个读取接口，基于保留为草稿的 #208。
用户只授权继续本地迁移。两端通过 `OPENBOT_TS_CHANNEL_READ_GROUP=channels` 与
`OPENBOT_CONTROL_TS_CHANNEL_READ_GROUP=channels` 明确配对选择；写入、问候、任务调度和 Temporal
仍由 Python 负责。复用 Fastify5.12.5、Postgres.js3.4.9、PostgreSQL17.11，无新依赖、表结构或外部源码复制。
只读 READ COMMITTED 事务在查询后复查会话，消息游标保留微秒精度、重复键拒绝和频道绑定，
保留 SQL 与最终响应大小上限。通过真实 HTTP/HTTPS、撤销并发、较新数据反向切换、Python 停机读取、
UI12/12 和原生包验证后才可认定候选合格；本轮不推送、不合并。

### P3 受保护文件与模型凭证决定（2026-10-08）

沿用 Python 的逐段禁止符号链接、文件描述符相对访问、进程间 flock、0600 原始32字节密钥和 v1 AES-256-GCM 格式。Node24 核心没有 openat/flock；fs-ext2.1.1 只有锁，另写 Node-API 扩展会增加构建维护成本。采用 MIT 的 Koffi3.3.2（提交390a0abb8b240188695084fb5662b965783e4e78，2026-09-25发布）作为固定私有 libc 调用的窄适配器，密码算法仍用 Node 内置 crypto。HTTP、模型、插件和网页都不能提供库路径、符号、指针或调用签名。仅限现有 Linux/macOS64位服务端，Windows 仍是远程客户端，不安装应用或系统服务。

已审阅发布源码、许可证、加载方式、ABI 测试、平台预编译包及 issue274；该问题涉及会启动后台线程的 Go 库，我们仅绑定系统文件调用，仍须验证真实退出。生产包必须带入对应平台可选二进制和许可声明。没有复制上游源码。原始密钥禁止覆盖，有密文却没有有效密钥时拒绝启动；锁和密文均须与 Python 互通。

本决定还不是验收通过。选用新接口组前，必须通过双语言并发初始化、权限和符号链接拒绝、路径替换、锁超时、Linux/macOS、受限模型传输、混合 HTTP/HTTPS、界面12/12及原生包验收。来源、备选方案和边界详见[英文记录](typescript-control-plane-p0.md#p3-protected-files-and-model-credentials-decision-2026-10-08)。不调用付费模型。

### P3 模型与设置所有权（2026-10-08）

复用ADR0050已审核的OpenAI7.28.0、Anthropic0.131.0和当前Python事务/DTO。双方显式配对选择
`identity-models`，不迁移表、不重新加密旧数据、不引入环境密钥回退。保留advisory锁、CAS、Bot先于
连接的锁顺序和原子审计；远程发送前及结果发布前都重查权限。最多2个检查，取消后要等实际传输结束才
释放名额。SDK重试、跳转、日志、环境头、组织/项目和代理回退均禁用；固定HTTPS传输限制头和正文大小并
验证提供商响应。合成传输仅存在于一次性测试进程的私有构造参数。

保护文件层保留Python的AES-GCM格式/AAD及32字节密钥。v6桌面标记固定SDK和Koffi版本，启动双方前
检查原生二进制完整性；依赖仅放在候选目录。时区使用POSIX系统TZif目录并精确核对大小写，以兼容
`Intl.supportedValuesOf`未列出的旧别名；依据[Python ZoneInfo系统数据约定](https://docs.python.org/3.12/library/zoneinfo.html#data-sources)，不声称本地Server支持Windows。
移植当前OpenBot Python行为并调用发行SDK，没有复制上游源码。模型18项、密钥互通/并发初始化、权限/
CAS/审计失败及原生重启证据写入当前收据；其余P3与最终托管检查仍是完成条件。


### P3 附件与存储接管扩展（2026-10-08，进行中）

复用前述保护文件决策及 Koffi 3.3.2 固定版本。目录遍历只使用 Linux/Darwin 64 位头文件中
已核对的固定 ABI，通过独立的 `openat(fd, ".")` 文件描述符保留遍历位置隔离；Darwin x64
选用 INODE64 符号，arm64 原生只有该 ABI。不复制头文件或库源码，也不增加依赖。来源见
[英文记录](typescript-control-plane-p0.md#p3-attachment-and-storage-ownership-extension-2026-10-08-in-progress)。

沿用现有附件布局、跨进程 flock、内容摘要、Owner/频道命名空间以及 C19/C21 清理恢复协议。
先持久化日志再暂存文件，提交结果不明时查询 SQL 删除凭据决定删除或还原；还原前检查全部
目标，拒绝覆盖。最终引用检查到提交之间持有消息/任务表 SHARE 锁，阻止新增引用穿过检查。
请求取消时先等待实际 SQL 结束，再释放文件锁或还原元数据。自动清理默认关闭；显式 P3
候选接管周期任务，同时禁用配对 Python 后台循环，P4 内部读取仍遵守同一锁和恢复协议。
验收只使用临时数据，不修改生产数据或已安装应用。附件/存储仍待资源契约、故障用例、界面
与原生包验收，不能据此宣布 P3 完成。


处理接口复用现有 `parser_worker.ts` 字节协议和已审核的解析器、语言包版本。共存期间它仍是
Python 源包内的共享 Node 辅助程序；P5 删除源包前必须移动该文件和原生清单引用。TS 使用
Node 24.21.0、固定权限参数、私有临时目录和无凭证环境；超时或取消后终止所属进程组，并等到
进程及管道关闭后才释放并发名额和删除临时目录。这不构成操作系统沙箱保证，也不增加依赖或
复制解析器实现。Node 的固定版本依据见[英文补充](typescript-control-plane-p0.md#p3-attachment-and-storage-ownership-extension-2026-10-08-in-progress)。

转写复用 OpenAI 7.28.0 SDK 的真实 multipart 接口，固定官方地址和 whisper-1，禁用重试、重定向
及环境附加头，限制 90 秒和 2 MiB 原始响应。发送前重新核对 Owner、频道、附件摘要/删除状态和
凭证版本/密钥。派生文字保持 262144 个 UTF-16 单元上限，不把原始文件或密码写进派生元数据。
验证使用合成文件与仅可在构造时注入的 SDK 传输夹具，没有在线模型调用或费用。

### P3 Employee 知识复用补充（2026-10-08）

复用已接受的[技能内容审阅决策](reviewed-skill-content.md)及固定 yaml 2.9.0，通过 Employee publisher 包的两个纯函数入口复用现有 Agent Skills 解析器与本地敏感内容检查，不引入另一套解析器，也不加载发布者密钥库或 CLI。依赖版本和权限不变。保留 Python 知识存储的 Owner 事务、不可变技能定义、摘要审阅、依赖状态、修订 CAS 和不含内容的事件。学习方向继续注明受 Hermes Agent 启发。

原生提案审阅保持 P4 的来源频道或原生根锁、根到子任务的加锁顺序、来源/档案/范围/摘要检查，之后才锁定 Bot 和提案。它仅审阅已完成任务的事实，不受理、执行或调度 Work；P4 执行仍由 Python/Temporal 负责。TS 保留这些本地检查以及 PostgreSQL 返回数据前的投影大小限制。通过跨语言 HTTP、Python 停机所有权、过期修订/摘要/回滚验收后继续迁移。未复制新的上游源码。

来源完整性测试发现驱动精度边界：PostgreSQL 时间参数先按 `text` 传入再转换，避免 JavaScript `Date` 丢失微秒导致截止时间比较失真。原生范围及认领事件的整数保留 JSON 原始词法检查。反向切换时，Python 原生提案审阅的 WorkConflict/WorkNotFound 现映射为契约内的 409/404，而非未捕获的 500；权限与 SQL 回滚边界不变。

### P3 审批与自动化管理补充（2026-10-08）

复用 ADR-0049 的额外确认策略、共享 TS 精确目标与已有 SQL/附件锁。TS 负责设置 CAS 和旧 Run 的一次性审批事务；过期决定先提交 `expired`/`blocked` 与事件，再返回 409。Work 动作受理、适配器最低权限和持久执行仍属于 P4，例外不会获得新能力。

Owner 自动化管理复用已接受的[定期任务提交决策](server-automations.md)。两边使用同一 PostgreSQL 记录；TS 在既有“文件锁后 SQL”顺序内校验附件字节和派生文本摘要，保留数量上限串行化与按固定间隔跳过错过时点的恢复逻辑。Python 的单一 `ProductWorkService._pass` 仍明确负责 P4 Work 受理和 Temporal 生命周期，包括 `PostgresAutomations.submit_due`；TS 不增加另一个定时器或 Workflow 启动器。通过真实保留受理路径、并发领取和反向切换验证 TS 新建自动化；P3 HTTP 所有权不宣称完成任务执行引擎迁移。不增加依赖、不复制新上游源码、不修改生产数据。

### P3 MCP 插件所有权决定（2026-10-08）

十二个插件公开操作复用已审核的 MCP SDK1.32.1（`ff07b001194fe60ee9deb2121cf119057565796d`，MIT）和已有 Ajv8.20.0 依赖。替换 MCP 或增加子进程协议会扩大兼容与权限工作。检查本地固定 SDK 的 `client/streamableHttp`、`client/index`、`validation/ajv-provider` 后，确认可注入 fetch、关闭重连、清理会话并限制 Schema 验证。SDK 默认 `validateSchema:false` 不等价于 Python 的 draft-07 检查，因此显式开启，并在编译前保留引用、正则和不支持关键字的拒绝规则，以及深度、节点数、字节上限。不复制上游源码。依据为[既有插件决定](third-party-mcp-plugins.md)、[MCP 传输规范](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2025-11-25/docs/specification/2025-11-25/basic/transports.mdx)和 [Ajv 验证选项](https://ajv.js.org/options.html#validateschema)。本轮浏览器未能获取固定 GitHub SDK 源码，实际检查的是已安装、锁定的源码，没有改用未经核实的新版本。

HTTP 适配器用 Node24 的独立 Agent，解析并检查所有地址、固定连接地址，保持精确端点与 Host/TLS 身份；拒绝跳转、代理和压缩，限制请求、响应与时间。特殊用途网段依据[CPython3.12.13 ipaddress](https://raw.githubusercontent.com/python/cpython/v3.12.13/Lib/ipaddress.py)核对，不复制 Python 实现。仅保留由可信构造参数明确配置的本地端点名单。导入工具不能决定传输目的地。

复用 AES-256-GCM `openbot.plugins/v1` 文件格式、私有目录描述符、Python 命名 `flock` 锁与恢复日志。公开修改持有文件锁直到 Owner SQL 最终提交；P4 的保留 Work 读取也使用该锁及当前 revision。目录第3版、中文内容和审核指纹按原字节保留。当前 `serve.py` 构造 `PluginService` 时没有提供旧 `assert_run_scope`，不能创建内存中的旧插件待审批调用；保持空待审批列表及认证后的 `not_found`。原生插件执行与持久审批继续属于已声明的 P4 Work 接口，并验证实际授权和 revision。以上不代表插件执行、旧回调组合或 P3 已完成；接受候选前仍须通过跨语言加密状态、HTTP/HTTPS、负向传输、当前界面与原生依赖检查。
