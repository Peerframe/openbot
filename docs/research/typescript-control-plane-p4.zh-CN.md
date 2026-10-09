# P4：TypeScript 任务执行与 Python 排空

[English](typescript-control-plane-p4.md) · 简体中文

- 状态：完整 P4 候选已在本机安装；真实隔离执行端与托管验收仍待完成
- 日期：2026-10-09
- 负责人：@yxflc11
- 决策：[ADR-0050](../decisions/0050-typescript-control-plane.zh-CN.md)
- 验收链路：现有 Owner 任务接口 → 独立版本的 TS Temporal 工作流 → 有界模型与报告 Activity
  → 不可变回执 → 校验与原子发布 → 产物下载。Worker 重启和响应丢失不得重复执行未知副作用。

P4 沿用 P0 已批准的官方 Temporal TS SDK `1.24.0`，固定提交
`1fd1c81a0383f5f5c7923dd735472c7d1ffdc867`（MIT）。2026-10-09 复核了官方发布、npm 元数据、
重放测试和 TypeScript 文档；仓库公开安全公告 API 未返回公告，这不等于完整漏洞审计。
原生模块已实际加载通过，依赖闭包审计结果见下文。采用已有 Node 24.21.0 和已缓存的 Temporal Server
1.32.0 镜像；禁用安装脚本，不自动下载测试服务器，不安装桌面应用，不调用付费模型。
具体来源、对比和验证边界见同版本英文记录。

现有 Python 会扫描所有待启动任务。因此先在现有任务交接事实中增加不可变执行归属；历史记录
默认归 Python。扫描和加锁后的预留、确认都必须核对归属；不能用环境变量或工作流名称替代持久
事实。新根任务在插入前选定归属，子任务继承根任务。Python 继续处理旧历史，TS 使用独立版本的
工作流与队列。保留 Python 只用于过渡和排空；没有跨语言历史重放证据时不直接接管旧历史，
不增加第二个调度器或通用自主代理框架。

P4 集中在一个分支推进。首个完整检查点是现有空资源范围的原生任务及报告工具；扩大资源范围、
频道任务、Worker 连接、命令/浏览器/媒体/插件、协作以及 Python 排空仍属于 P4 必需范围。
候选必须显式启用，目前支持附件、知识、插件、网页和原生协作范围，拒绝尚未接入的资源能力；不会以测试夹具输出代替真实产品行为。切换验收前
不改变公共默认入口。Server 继续独占身份、权限、根预算、执行占用、审批和发布；模型使用已有
受审阅连接与精确端点，发送前复核权限，SDK 零重试，传输有界。测试使用可控模型替身。
请求回执未确定时只能查询，不能重发；工作流代码不能访问数据库、文件、凭据、环境或网络。

未复制或改编上游源码；沿用上游 MIT 声明。以当前 Python 行为为兼容依据，退役 TS 代码仍只是
测试参照。不改写数据库迁移历史、不搬数据。排空必须同时检查完整分页的 Temporal 与 SQL 事实，
包括未确认启动、运行/续接链和尚未对账的副作用；引擎结束不能成为重试副作用或发布产物的授权。

必需验收包括真实 PostgreSQL 并发与跨归属拒绝、真实 HTTP 与现有网页请求、真实 Temporal
启动/历史绑定、Worker 重启与响应丢失、TS 历史重放、不可变报告与原子发布、显式回切与临时夹具
清理，以及 `npm run check`。接口组切换前必须界面验收 `PASS 12/12`。P4 全部完成还要求全部运行时
工具、真实隔离执行链路及 Python 排空证据；当前检查点不代表 P4 完成、生产排空、安装发布或 P5 退役。

## 当前实现边界与依赖审计

本地 `OPENBOT_TS_WORK_GROUP=reports` 候选已接通真实 Owner HTTP、版本化 TS Temporal Worker、
既有 OpenAI7.28.0 / Anthropic0.131.0 SDK 传输、不可变模型/工具回执、报告准备、独立审核、原子完成和
产物下载。模型回执保留工具 ID、签名思考内容与实际用量；迁移0056 显式增加
`openbot-ts-model-response-v1`，保留 Python 格式及全部旧迁移字节。沿用 P3 已审核 SDK 和端点决策，
没有新增模型依赖或自动备用服务。

原生附件保留文件锁先于 SQL 的顺序、固定元数据指纹、UTF-16 分页、读取预算和 ADR-0049 的额外
Owner 确认。模型发送和发布前都会复核已消费资源。知识工具复用技能审核、Owner 模型使用开关、
有界近期记录选择、来源和敏感文本检查；私有 TS 回执绑定实际任务、纠正上下文和执行占用。
记忆提案只在任务验证完成的同一事务中进入待审核表，不能直接启用。Employee 学习方向继续注明
受 Hermes Agent 启发。

引擎终态核对从 SQL 已确认的首个 Run 沿不可变 Continue-As-New 链前进，最新 Run 只能否决，不能
单独证明终态；缺失历史时保留不确定状态。终态投影关闭权限并保留未知结果预算，不结算副作用。
关闭后的对账使用 `OpenBotClosedRepairTsV1` 和真实远程 Activity，核对持久化 Owner 命令和原始
关闭链，只读已有回执，不调用模型或工具。SQL 修订唤醒只是提示，不授予权限。Worker SDK 日志
不输出任务令牌、参数或原始异常元数据。

插件复用 P3 加密存储与官方 MCP1.32.1：先取得文件读租约再锁 SQL，将授权修订、声明指纹、
来源证明绑定到原 Action。DNS 检查后、真正 POST 前提交一次性派发标记和私有审计。模型读取和
发布均重新验证已消耗的授权；已验证回复保留到 SDK 清理之后，缺失回复仍未知且不重发。
真实 MCP 验收覆盖读授权/确认审批、资源读取、审核中撤权和丢失回复。

公开网页/搜索沿用每任务四次尝试上限、来源 URL 与 Owner 搜索配置。Node HTTPS 固定已验证
公网地址，在发送前重新读取 SQL 权限；网页无凭据，只有选定的 Tavily/Kimi 端点能收到显式密钥。
重定向、压缩、混合/私有 DNS 和超限响应均拒绝；下述隔离 Node 解析器不继承凭据环境。
一次性真实 HTTPS 验收覆盖网页/搜索审批到审核发布及第五次请求被拒；定向检查覆盖 TLS、
解析上限、Unicode、取消及两种搜索回复。这些夹具不代表外部服务当前可用。

一次性真实 HTTP/SQL/Temporal/mTLS 验收已覆盖报告发布/下载、幂等、独立审核拒绝、发送后取消、
重启与丢响应查询、附件审批和审核中撤权、技能/记忆读取、只生成待审提案，以及发布前撤销技能。
关闭对账探针要求真实修复 Activity 成功，不能只凭命令显示未解决判定通过。模型使用确定性传输
替身，不代表付费模型或公网验收。附件/文件/模型定向检查已通过；包含原生协作的完整候选已通过全仓检查。canonical57 迁移资格
40 项通过，完整 Python 检查通过，详见下文。打包和 UI 门禁仍待执行；下方底座证据保留原始范围。

用户已选择本机安装的 OpenBot 作为 P4 最终验收环境。只读查询确认其 Temporal namespace 没有
运行中的执行，但 SQL 待启动、未确认和未知结果尚未核对；没有改动已安装应用或用户数据。
完成 P4 仍需媒体/隔离命令与浏览器、频道协作、频道和自动化提交、Worker 注册表与连接归属、
真实进程死亡恢复、完整分页排空、打包、UI12/12 及安装应用验收。当前原生任务候选不代表 P4 完成。

`npm audit --omit=dev` 首次发现 GHSA-68fv-2mgg-jv7q：SDK 的 source-map-loader 会使用已有锁定
版本 source-map-js1.2.1。已审核[公告](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)、
[1.2.2 发布](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2)及
[修复与测试 PR79](https://github.com/7rulnik/source-map-js/pull/79)。兼容的 BSD-3-Clause 补丁
限制索引 source-map 偏移并包含回归测试。只更新这一已有解析版本，其余原有依赖版本保持不变，
保留 LICENSE。复查生产依赖为零已知漏洞。实际工作流打包和回放覆盖此加载器，完整仓库检查覆盖
已有 Web 消费者。

`npm run test:work:ts` 使用已有且锁定验证的 Worker 环境。归属明确的夹具启动 PostgreSQL 持久化
Temporal1.32.0 与 mTLS，运行 TS/SQL 探针并清理资源；现有托管 Temporal 验收作业执行相同命令。
没有新增常驻服务、超出测试生命周期的容器、桌面应用或付费模型调用。原生 SDK 已在 macOS arm64
实际加载通过。

## 本地底座验证（2026-10-09）

- `npm run test:work:ts`：macOS arm64 上真实 PostgreSQL/Temporal1.32.0 与 mTLS 通过。
  覆盖并发预留/归属隔离、取消后的丢响应恢复、Worker 替换、旧栅栏拒绝、Continue-As-New 和前后
  两段导出历史回放，以及 Activity 提前执行的确认竞态。Activity 为合成控制探针，不代表产品
  模型/工具执行完成。
- `npm test --workspace @openbot/work`：9 项通过。最终源码 `npm run check` 通过；未变的 Turbo
  任务复用缓存，此前完整运行实际执行受影响 Work/Server/Desktop/Web 消费者。初次检查正确拒绝
  旧迁移/闭包指纹，已更新为实际验收目标，没有放宽门禁。
- 指定已验证 Worker 解释器的 `npm run test:control:python`：控制面1,077 通过，基础环境的2 项
  可选 Temporal 测试跳过；Worker1,589 通过，1 项外部历史输入跳过。两个新增跨归属 PostgreSQL
  拒绝测试均实际执行通过。既有 harness quality 通过，跳过项不算通过。
- 既有合成迁移/配对恢复验收：canonical56 的40/40 通过。新增 SQL SHA-256 为
  `9c54411cde1c4a0779b077c956765ff4848a82998e9d1268b0ba7166895150d1`，journal SHA-256 为 `6aa92977510c6a9297f54847b7d4627df9fe2f575b140f787332e92a0e046a41`。
  target-history 保留 main 集成基线与精确的未提交追加后缀，未修改旧 SQL 字节。
- macOS arm64 TS/Python 运行时暂存成功。既有 P3 原生检查覆盖重启/会话/模型设置、34 项资源和
  13 项可携带性合同、子进程/父进程退出与停止；模型联网次数0。暂存包自带 Node 实际加载
  Temporal SDK/原生桥成功。这不代表 P4 桌面执行、已安装 Keychain 或 P4 安装包发布。
- 生产依赖审计为0 已知漏洞。本轮 P4/PostgreSQL/Temporal 测试容器均已清理，没有安装应用或使用
  生产数据。本轮未切换公开接口组，因此不声称新的 UI12/12 结果；产品切换前仍须完成该门禁、
  真实端到端执行和 Python 排空。

## 公开网页提取决定（2026-10-09）

沿用已接受的公开 HTTPS/搜索策略及 P3 地址分类：网页读取不携带凭据，不重定向、重试、
访问私有地址或读取环境代理。将仍依赖 Python 的 HTML 转换器替换为已在锁文件中的 MIT
`htmlparser2` **10.1.0**，提交 `57ace50bf6eb3bfab0468deafe10d0a8a2f233aa`。已检查
[发布记录](https://github.com/fb55/htmlparser2/releases/tag/v10.1.0)、
[固定源码与测试](https://github.com/fb55/htmlparser2/tree/v10.1.0/src)、MIT 声明及公开问题。
隐式 HTML 修复存在已知差异，因此只提取不可信文本，不宣称与浏览器 DOM 等价。

比较了保留 Beautiful Soup 4.15.0（阻碍 TS 运行时退出 Python）、已审核的 html-to-text
10.0.1（增加 DOM 和格式化行为）及直接事件解析器，选择后者。保持 512KiB 输入、深度/子节点/
节点总数限制，去除脚本等不可见内容，并将最终文本限制在 6,000 UTF-8 字节。固定 Node
子进程限制堆内存、时长和文件读取范围，不继承凭据；HTML 只经 stdin 传入。无上游源码复制。
启用 web 范围前须通过等价提取与恶意输入检查；不安装新应用或系统服务，不引入外部账户或付费请求。

## 协作移植与截止计时决定（2026-10-09）

复用 Python 的 work_collaboration、work_native_collaboration、work_product_collaboration
及0039/0040数据库契约：最多两层、四个后代，根先于子任务加锁，不可变创建回执，原生授权逐级收窄，
根任务首次领取起300秒截止。原生子任务不伪造频道或旧 Run；只有真实执行/修复 Activity 可从既有 SQL
回执恢复原子任务，绝不再次创建。当前纠正语义的汇合先于重新起草、独立审核及发布。父任务关闭级联
撤销授权，保留未知结果与真实模型用量。TS 还在同一根锁内执行 ADR0050 的整树令牌预算；Python 现有
Work 用量投影是逐任务的，不能当成已验证整树预算的证据。公开的逐任务用量保持不变。

沿用已审核 SDK1.24.0，核对其[取消文档](https://docs.temporal.io/develop/typescript/workflows/cancellation)
和[固定版本源码](https://github.com/temporalio/sdk-typescript/blob/1fd1c81a0383f5f5c7923dd735472c7d1ffdc867/packages/workflow/src/cancellation-scope.ts)。
Workflow 持有截止闹钟，远程 Activity 发心跳并等待取消完成。准入后短读判断不可变范围是否允许创建
协作树；只有这类任务每两秒查询首次子任务提交，普通任务不轮询。查到后用原始 SQL 截止时间创建持久
计时器，Worker 丢失或 Continue-As-New 均不延长时限。比 Python 的模型提案钩子略早启动，可覆盖子任务
已创建却丢失 Activity 回复的窗口，无须新增调度或回执框架。截止时先关闭 SQL 授权再取消执行；所有新
效果与最终写入也校验时钟。真实一次性 HTTP/PG/Temporal 验收已通过委派、自动汇合、越权拒绝、SQL 创建回执恢复、父任务
取消后保留用量、持久化截止，以及纠正后重新汇合同一子任务。截止夹具仅在创建子任务前调整
首次领取时间，产品300秒规则保持原样。这是原生协作证据，不代表频道协作或 P4 完成。

Python 兼容检查通过基础1078项和 Worker1589项，分别明确跳过2项与1项，包含新增的 Python
修复扫描排除 TS 任务回归。模型仍使用可控测试传输，没有付费调用或使用已安装应用的数据。

## Canonical57 迁移资格

既有 S7 一次性夹具在 macOS arm64 / PostgreSQL17.11 上通过全部40项。
[验收记录](../../experiments/s7-migration/evidence/ts-work-result.json)固定57条目标迁移、journal
及0055/0056 SQL 指纹，没有改写历史 SQL。证据仅覆盖既有合成历史升级、备份与转移场景，不代表
模型密钥、附件日志或活动 Work/Temporal 历史已能恢复，也不代表已安装应用排空或 P4 完成。


## 频道提交、自动化与媒体集成（2026-10-09）

沿用当前 Python 的消息/Run 提交、频道协作、自动化和[原始媒体合同](work-product-media.md)，
接入同一 P4 候选与队列，不新增调度器、表、公共协议或依赖。`work_sources` 保留真实频道消息和
Run 身份；频道 advisory/source 锁先于根到叶 Task 锁，多接收者原子提交。上下文以最初根请求的
消息/Run 时间为界，并校验回复来源和当前成员资格。取消、引导和用量沿用同一 Work 权限；验证
完成后在同一 SQL 事务发布 Bot 消息。原生 Task 不虚构频道/Run，也不扩大资源授权。

Python 配对 `ts_work_group=reports` 隔离已迁11个操作并关闭旧自动化提交器，保留旧 Python
历史供排空。TS 沿用每次最多10条的 SQL 到期声明，跳过仍活跃的前次任务，精确跨过错过的周期，
不补跑积压；目标不可用时停用计划。这些接口证据尚不等于已安装服务配对或最终排空通过。

一次性真实 PostgreSQL/Temporal/mTLS/HTTP/MCP/HTTPS 流程已通过频道提交、固定上下文、原子
发布、取消/引导、真实委派 Run 与等待、成员撤权、附件/知识/插件/网页组合及自动化提交/跳过/停用。
Python 隔离相关23项通过且无警告；加入媒体前的完整仓库 check 通过。此前一次频道父任务引擎
失败在补充历史诊断后未复现，根因仍未确认，继续作为集成疑点保留。随后一次插件 unknown 来自
测试 peer 持续丢响应的故障注入；在“不重发”断言后恢复响应，修正测试隔离，未改产品超时或重试。

媒体保留 PNG/JPEG 单个5 MiB、PDF 单个10 MiB、最多8项合计20 MiB、每个原始二进制8192
预留 token 和12 KiB 清单限制。显式提取仍读已验证的派生文字，不自动改为 OCR 或上传模型文件。
首个 Action 前固定来源、Run、原始元数据与派生指纹；纠正、恢复、披露和最终发布都在现有文件锁/
来源/执行占用下复核。只有已准入模型 Activity 才读取原始媒体；Work 存储、引擎历史和 Action
只携带描述，独立审核接收同一原始媒体。未知结果仍只能查询，不能重发。

沿用 P0 审核的 OpenAI7.28.0（Apache-2.0，`fb6955621e1cf6653659adb75094ebace83ebfe9`）
和 Anthropic0.131.0（MIT，`d49bdab458000bcdffe77bd84b03293f31824fb3`），复核本地精确版本
的媒体类型和 Anthropic 固定源码；OpenAI 固定网页读取缓存缺失，使用已安装源码及已有 P0 证据。
窄适配器提供内联字节和文件名/标题，SDK 编码后逐项核对才允许单次发送；拒绝 URL、远端文件 ID、
其他 preset 和未审核格式。未复制上游实现。两种现有协议与仓库媒体参照、20 MiB 原始输入及既有
模型/附件聚焦检查共10项通过；真实产品媒体验收和其余 P4 门槛仍在进行。

原始媒体现已通过真实 HTTP/PG/Temporal/mTLS 流程：生产者与独立复核收到相同 PNG/JPEG/PDF 字节，
清单和历史可回放，撤权阻止发布并保留用量。组合回归也通过两棵并发频道协作、自动化、MCP 和
HTTPS；模型提供方为可控夹具，不能代替已安装应用或付费模型证据。媒体版本完整 `check` 已通过。

一次与完整检查并行的回归出现 Task GET 503。后续数据库诊断记录到频道 advisory 锁等待
200–233ms，没有锁错误；两棵并发协作超过原先单任务40秒夹具等待。这尚不能确认原503或更早
引擎失败的确切原因。现让同一事务内只读资源检查复用已锁定的 Task/来源信息，结束即清除，
执行或写入前重新读取；文件、授权、回执、子任务检查保持即时，最后仍复核执行时限。边界测试
覆盖跨事务、检查结束后撤权及过期。新增用例后的总夹具时限为600秒，并发两棵树为90秒；产品
SQL、HTTP、Activity 和协作截止时间均保持原样。最终组合回归通过且未出现503。早期失败证据
保留；界面12/12、Worker实际执行、已安装应用排空与最终 P4 验收仍未完成。

## 原生 Worker 与审批浏览器任务接入（2026-10-09）

显式启用进程内 Worker 后，TS 接管在线注册表、注册/撤销断连及人工浏览器传输，替换 P3 的
Python 私有端口。复用 P0 已审核的 ws8.21.3（MIT，固定提交
`c791e707eab3c13dd9a261d2479c3cc4a49a6fed`）；只把已有测试依赖提升为生产依赖，没有安装或升级。
保留原凭证/连接绑定、身份锁1326850643、公共入口检查、有界消息和队列，以及浏览器一次性发送
凭据。未选择的环境继续使用原私有端口，不增加自动故障回退。

任务适配沿用 Python 浏览器 profile、capture 和 page action 的既有决策。只有部署配置明确
路由的 docker-linux Bot 频道任务，且配置了模型，才能创建不可变浏览器身份与可选站点范围。
复用原表和摘要格式，通过 Work scope 显式传递可信配置；缺配置即拒绝。浏览器任务仅获得频道
读取、附件、报告及明确启用的浏览器工具，频道成员身份不会附带插件、知识、网页搜索或协作权限。

截图与页面操作分别要求新的 Owner 审批。共享人工接管锁1326850642覆盖发送和回执保存；发送前
在身份锁内复核原连接、凭证、人工控制版本、来源、任务/执行时限及审批。先记录唯一尝试，命令
截止取25秒、原 claim、Action 和任务树截止的最早者。输入必须绑定同一权限代次下已经应用的
观察及原页面/截图摘要，返回页面再次检查允许站点。私有 PNG 原始字节和严格页面数据持久化；
不声称模型已理解图像，也不把页面响应当业务成功证明。仍限制每任务4次截图、16次页面操作，
截图产物在独立审核后才发布。丢回执保持 unknown，恢复只查原回执，不重新截图或重发输入。

完整真实 HTTP/PostgreSQL/mTLS Temporal/WebSocket/MCP/HTTPS 组合验收已通过，覆盖已有原生、
频道、媒体与自动化场景，以及4次分别审批的浏览器操作、PNG下载、审批前人工接管/释放、断线
重连后只读对账且仅发送一次、返回页面越域拒绝。人工浏览器和注册/撤权也使用唯一 TS 注册表。
新增浏览器页面/截图来自可控 peer，不能代替真实浏览器引擎或 Linux 隔离证据。来源、参数、回执
及只读验证范围聚焦检查5项通过。该候选随后通过完整仓库检查：Server153项、Desktop578项/3个平台跳过、Web695项，最终构建20/20，
其中15项缓存。两处旧打包检查改为要求已有固定版本的 ws，并继续排除已退役 oracle。尚未切换
公共接口组或安装应用。

只读核对：本机 OpenBot 为0.1.0-alpha.9，已有 Temporal 配置，没有浏览器/命令安装配置；当前
Docker 只有 runc，没有 runsc。最终隔离命令验收明确依赖已配置的 Linux Worker Host，不能自行
寻找私人 SSH 目标或复用已消费的历史远端标识。剩余命令权限/传输、真实进程死亡恢复、配对打包、
UI12/12、已安装环境完整 SQL/引擎排空及应用最终验收仍未完成。


## 审批命令集成（2026-10-09）

P4 显式 Worker 配置已接入原有私有命令安装文件，沿用命令权限、SQL 事务、v2 readiness 和
protected Host 决策。已审核的 jose6.2.12（MIT）、canonicalize5.0.0（Apache-2.0）增加 Server
生产依赖边，没有安装或改版本。签名与规范化由原发布库负责，没有复制上游源码或自写密码算法。
严格适配层拒绝重复 JSON 键、非整数数字写法、额外签名头和密钥角色混淆。真实 Python/TS API
已经互验九种 v2 用途、查询/停止变体及原操作指纹。

部署路由明确的 docker-linux Bot 频道/自动化任务沿用不可变命令 profile。模型只看到原输入
描述、离线策略和有界命令提案工具，每次命令重新审批。准备阶段固定原 Activity claim、审批、
来源/文件、profile、连接及 native 截止；SQL 接纳与派发记录同事务提交，只消费一次许可并先
记录摘要再回复。真实 Node/Unix 通道保留不可伪造原连接、4 帧/64KiB 压力上限、5 秒待处理时限；
身份锁和 SQL 事务内不发送网络帧。重连、进程替换或提交结果不明不能重新准备、派票或发许可。
尝试结束即释放进程内时钟与 Activity 权限，历史回执不能恢复执行权。

120 秒 claim 用于已绑定命令 profile 的 proposed 动作，覆盖审批在 Activity 内读取期间提交的时序；准备仍需新鲜审批，旧 claim 不续期，其他仍为60秒。首个任务树截止、Action
有效期、原 readiness 绑定的 native 生命周期和5秒启动窗口均不延长。原签名观察与有界 UTF-8
输出字节验证后记录，独立审核获得完整文本，随后才原子发布；本地回执恢复不重新执行命令。

第一轮真实 PostgreSQL/Temporal/Owner HTTP/Node/WebSocket/Unix 组合已执行审批命令并下载
准确的审核后 CSV。最初失败是夹具错误期待任务关闭后再次审批成功，产品正确返回409；修正后
完整组合通过，包括随后新增的拒绝及执行后真实 Unix 回执丢失。Node 重连和 Owner 对账后仍为
unknown，没有第二次准备、发许可或产物；SQL 确认每个已执行动作仅一次准备/消费/许可，拒绝时
没有准备。三个聚焦文件共10项通过。完整仓库检查通过：Server159、Desktop578/3个平台跳过、
Web695、Node129/3个平台跳过；最终构建20/20，其中16项缓存。native 隔离及 Unix peer 身份
仍明确为合成夹具；真实 Linux/runsc、桌面接入、进程死亡窗口、UI12/12与安装环境排空尚未完成。


## 安装组合与 Python 排空（2026-10-09）

复用安装目录已有的私有 `temporal.json`、`browser.json` 和 `command.json`，不改写凭证或旧队列。
显式 `OPENBOT_TS_WORK_GROUP=p4` 要求全部已验收 P3 选择器，建立唯一 TS Worker 注册表，并根据
旧 Python 队列派生独立的版本化队列。配对 Python 不再启动 Work 监督器、Worker 套接字或私有运行时
端口。Desktop v8 要求已有 Temporal 配置和真实 SDK/native 资源；缺少或损坏配置会拒绝启动，
不会自动退回仅 API 模式。Python 仍打包保留至 P5，并支持显式停机后成对回切。

已查阅官方 [Temporal Visibility 文档](https://docs.temporal.io/visibility) 与上文固定提交的
SDK1.24.0 `workflow-client` 源码。Visibility 是最终一致的，列表中没有任务不能证明排空。
比较仅查第一页（证据不足）、仅改队列（遗留 SQL 义务）与完整 SQL 加逐 ID 权威引擎检查，选择
最后一种，使用已发布 SDK API，没有复制上游源码或引入新依赖。

在 TS Work 服务或自动化启动前，以 keyset 遍历所有 Python 所有的 SQL 行，包括未确认提交、
已接纳/结果未知副作用和未完成的关闭后对账。逐个 Describe 确定的旧 workflow ID，核实队列、
类型、首个 Run 和不可变终结历史，再次 Describe 排除并发续链。遍历所有正在运行的 Visibility 页，
发现仅引擎存在的义务。已超过保留期的历史缺失单独计数；通信失败、续链、引用不匹配和不完整历史
均拒绝切换。二次读取全部 SQL 并比对摘要，拒绝并发变化。检查只读，不取消、重试、结算或退款。
执行门禁前必须停止旧接纳进程；空列表、引擎关闭和夹具结果本身都不能授权生产切换。

一次性环境通过105行 SQL（含第一页之后的活跃行）、未确认/未知/未完对账拒绝、三个真实未被
Worker 领取的 Python 类型 Temporal 执行、多页 Visibility、真实终结历史与并发 SQL 变更检查。
Desktop 定向检查36项通过、2项平台跳过。这些是门禁实现证据，不代表已安装应用排空。
完整 P4、界面、原生包和安装环境验收仍待完成；当前本地交接记录保留对应日志与版本范围。


## macOS 原生验收引擎（2026-10-09）

现有 macOS 托管打包作业没有 Docker 引擎，因此复用官方 Temporal Server1.32.0 的原生临时进程，
使用其文档中的 SQLite 初始化和相同 mTLS 策略。此处验证安装包原生加载及配对生命周期；
PostgreSQL 持久化、结构与升级验收仍保留在现有真实 PostgreSQL/mTLS 通道。产品不选择该夹具、
明文、SQLite 或隐式测试服务器，安装包也不包含它。

已审阅 [Server1.32.0 发布](https://github.com/temporalio/temporal/releases/tag/v1.32.0)、
校验归档中的 `config/development-sqlite-file.yaml`、`config/docker.yaml` 和
[TLS 配置](https://docs.temporal.io/references/configuration#tls)。macOS arm64 归档
SHA-256 为 `f95748376241f5941327fa4c4e8e76641e8c4a9acabf77de9c86eb3d8238f4d7`，
大小96,287,042字节。复用既有有界归档/成员校验，二进制大小和指纹保存在
`experiments/work-journey/release_archive.py`。没有复制上游源码；声明式配置使用公开结构，
Server 保留 MIT 许可。没有 SDK 自动下载或新增产品依赖：CI 显式下载固定归档，本地须提供路径。
临时进程、凭证和 SQLite 文件在结束后清理；安装包自身的数据仍使用真实原生 PostgreSQL。

另已审阅 MIT [CLI1.9.1](https://github.com/temporalio/cli/releases/tag/v1.9.1)，提交
`1de87a9f26991bf4f5c0a5ff96f2cea8d7a3cbde`、start-dev 实现/测试及未关闭问题。
其开发命令未暴露所需服务器 TLS 配置，因此未采用。为 macOS 托管机器额外安装 Docker/VM 会增加
不必要的环境依赖；官方 Server 资产满足此项门禁而不改变生产架构。


## 集成恢复与安装验收证据（2026-10-09）

实际 TS 产品入口作为独立子进程，连接一次性 PostgreSQL 和双向 TLS Temporal。在五个已提交边界发送
SIGKILL：预留提交但尚未启动、引擎已接收但尚未确认、已准入副作用但未返回响应、原始回执已保存、
产物已原子发布但 Activity 尚未完成。替代进程使用同一数据库、队列、密钥和文件。未确认提交不重发，
未知副作用不重复执行或发布；可恢复的启动与原始回执最终完成，回执指纹、三次模型步骤与唯一最终
发布均保持不变。五个窗口全部通过。模型响应与暂停钩子为合成，进程终止、HTTP、SQL、文件与引擎
恢复为真实执行。整套验收预算为1200秒，产品各自的截止时间不变。

现有 TS 界面命令拥有同一一次性双向 TLS 引擎，并要求 P4 健康阶段和 TS 执行归属。原有12步全部通过，
共112个响应，零非预期响应、零页面错误、零 workspace503，包括重启与重连。未修改网页源码。暂存
原生负载也通过34项资源和13项导入导出检查，使用真实原生 PostgreSQL 与固定版本双向 TLS 引擎。
这些检查使用一次性用户目录和合成加密回调；已安装 Electron/Keychain 验收单独记录。

对于用户指定的已安装 OpenBot，先复制其已停止的 PostgreSQL 集群，在副本上运行目标增量迁移，
再只读查询安装配置指定的 Temporal。副本有两个 Python Run；活跃 Run、未确认提交、未知副作用、
未完成对账和引擎运行中执行均为零。一个终结历史不存在，单独计数。源集群1292个文件、62,318,329
字节的完整指纹保持不变，临时副本已停止并删除。这只是只读预检查，实际切换启动仍须在旧双进程
停止后再次执行门禁。Linux/runsc 执行、安装后应用验收与托管 CI 仍不能宣称完成。


未签名的完整 macOS arm64 应用也通过相同的34项资源、13项导入导出检查，以及真实双向 TLS Worker
启动、密码与数据重启保留、任一子进程退出、父进程管道关闭清理和无效执行配置拒绝。包内81个
Desktop 编译文件与当前构建一致，ASAR SHA-256 为
`504141e2fded74e151de9e6998df5edd17f7ccb322fcd004abbeca9082843885`。
macOS Worker companion 复用已验证来源 `6e9d13edc77e0bb4b1aa797a9701cf16cd7a877c` 的未变产物，
完整包清单仍由打包器校验。

同源原生测量每种组合交替执行三轮，每轮均有全新配置启动和重启，使用真实原生 PostgreSQL 与
已连接的测试引擎；各端点预热10次后测量100次请求，RSS 只统计自身子进程。Python 单服务首次/重启
就绪中位数为10,917/8,938毫秒，RSS为248,096KiB；完整 P4 为6,696/5,302毫秒、650,096KiB。
P4 健康/频道接口中位延迟为0.306/0.815毫秒，Python为0.580/9.889毫秒。现有测量标签
`ts-forwarding` 在本次代表完整 v8 P4 组合。引擎进程、Electron 页面、Keychain 和在途执行成本
不在这些采样内。这是单台 macOS arm64 机器的数据，不能当作普遍性能承诺。Python 保留至 P5，
当前共存阶段没有降低内存和包体积。测量进程已全部停止，一次性数据已删除。


## 已安装候选验收（2026-10-09）

整套 `npm run test:work:ts` 的48个命名检查全部通过，包含五个真实进程终止窗口。完整
`npm run check` 退出0：Server162项、Desktop579项并有3项平台跳过、Web695项、Node129项并有3项
平台跳过；最后20项构建全部通过，其中16项使用缓存。构建后再次确认包内81个 Desktop 编译文件
一致。没有付费模型调用。

按用户指定的最终环境，先把原应用和完整配置保存在私有回滚目录，再用这个未签名开发候选替换
本机现有 OpenBot。实际 Electron 应用读取既有 Keychain 凭据，完成认证，恢复工作区和实时连接。
真实健康接口报告 `typescript-product-candidate`，执行归属为运行中的 `typescript-v1`；
这要求安装环境 SQL/Temporal 排空门在 Worker 准入前通过。正常退出停止了两个服务和原生 PostgreSQL；真实重启再次通过排空门，恢复 TS Worker、工作区和实时连接。

退出后的只读副本审计确认已有57项规范迁移（原为53项），仍为相同两个旧 Run，没有活跃、未确认
或未解决的义务，启用的自动任务为零；旧 Work SQL 指纹未变。18个既有配置、对象和产物文件
共3,610,608字节，与回滚副本逐字节一致。没有在真实数据中提交 Work 或调用模型。这个安装候选
没有补齐缺失的 Linux/runsc 部署或浏览器配置，也不能把合成执行端证据当作原生验收。完整 P4
资格验收与托管 CI 仍待完成；Python 删除、包体积缩减和 P5 不在本轮范围内。


## 托管跨平台与真实 Chromium 验收（2026-10-09）

草稿 PR #212 的首轮 `e5f807fc` 托管检查除 Windows 保留客户端测试及依赖它的汇总外均通过。
5 个配对测试模拟 macOS，却在 Windows 上调用了真实 POSIX 私有文件检查。修复只替换这些配对
测试中的配置边界，保留产品权限检查及原生验收，并验证配置拒绝时两个产品进程均不启动。
本地相关检查37通过、2平台跳过；不能称修复后的 Windows 托管作业已经通过。

现有 `product_browser_probe.py` 增加显式 `--entry ts --recovery pages` 与 `response-loss`。
复用已审核浏览器上游 `29a83c1932fb67398dd7a36fa80c473e0230a637`、Playwright1.62.1 和真实 Node
夹具，仅模型 HTTP 为合成响应。TS 使用生产配置、Owner 登录、标准 PostgreSQL 迁移、双向 TLS
Temporal、浏览器审批/回执及发布流程。未支持的 TS 恢复模式在创建资源前拒绝；没有把 Python
Worker 暂停或远程 Linux 替换列为已迁移证据。不增加产品依赖、不复制上游实现。官方 SDK1.24.0
使用自带 Protobuf 解码器重放二进制引擎历史；先前 JSON 转换失败不能计为重放通过。

本机页面流程通过：4 次独立审批，导航、中文输入、点击和读取各一次，含独立报告审核的7次模型
步骤各一次，报告下载、页面独立状态及离线重放均通过，测试资源已关闭。此前有一次导航在 Node
Provider 调用前变为 unknown。保留的私有证据显示时钟不一致：数据库生成的模型请求与 Temporal
UUIDv7 均指向07:45:37 UTC，而 Mac 在08:00:10 UTC 写入模型回执，Action 的到期时间为
07:50:38 UTC。`WorkBrowser.authorized` 按数据库时间限制许可，`WorkerHostRegistry.browserCommand`
按发送进程时间检查到期，在 socket 写入前拒绝。已有真实 WebSocket 到期与权限负向检查再次通过
（整组6项）；原始 Node 调用记录和浏览器 profile 均为空。这解释了派发前的拒绝，没有延长许可或
重试 Action。原始捕获异常未被保存，因此此归因来自独立时间戳和已验证拒绝路径的推断，不能冒充
原始异常追踪。后续成功仍不能抹去这次观察。真实响应丢失检查也通过：页面记录一次点击，随后响应连接被销毁；取消关闭权限，
显式查询原回执后仍未解决，点击与模型均不重复，无产物发布。按原有 TS 账本契约，未知任务继续
待核对，引擎等待；重放覆盖开放历史，不能伪称成功终结。首次夹具断言误以为工作流会立即关闭，
已按现有契约修正。新托管结果仍须单独报告。这是真实本机 Chromium 证据，不代表公网出口、Linux 隔离、安装环境浏览器配置
或 P4 隔离执行端门槛完成。

共享脚本的 Python Worker 停止/审批/恢复流程也在真实 Chromium 上通过，含7次模型步骤、报告
下载和终结历史重放。4种未支持组合在启动资源前拒绝。工作流102项及完整 `npm run check` 通过：
Desktop580加3平台跳过、Server162、Web695、Node129加3平台跳过；30个测试任务复用14项缓存，
20个构建任务复用16项缓存。此次只改测试、验收和 CI，已安装候选的产品字节保持不变。


## 新的一次性原生 CI 验收与审批竞态（2026-10-09）

前一固定 HEAD `3ac5e34eb75615f2a5d6a41c66f589fd247c944a` 的17项托管检查已在
[CI37904521785](https://github.com/Peerframe/openbot/actions/runs/37904521785) 全部通过；该结果不覆盖
本轮新改动。剩余真实执行端现接入既有 Ubuntu24.04 browser-product CI 通道。`p4_native_ci.py`
只在一次性 runner 创建 root 私有包，复用原 Host/原生执行算法；Docker29.8.1、
gVisor release-20260914.0 的归档与关键成员哈希均匹配已审核版本。沿用
[Docker 官方二进制测试方式](https://docs.docker.com/engine/install/binaries/)，从临时固定路径运行，
不把运行时注册到宿主 daemon。

命令验收保留真实 SO_PEERCRED、无附加组/能力的 UID62425、root 私有签名密钥、单次原始 unit、
无网络、受限 ext4 输出盘与原始到期/清理。浏览器复用原600秒 composition、分离的 Squid/浏览器
网络、自有 HTTPS 页面、13项套接字检查、证书负例、优雅替换、私有 profile 连续性及已建立隧道撤销。
使用新身份；不重用已消费的 product3/comp5 或旧 SSH 授权。执行 daemon 没有外部路由；
普通 runner daemon 仅在执行前取得并导出固定镜像。

新 Docker 导出 tar 可能与旧包字节不同：先验证已审核镜像 config、架构与层，再对完整导出取哈希。
仅在 root 私有副本重绑定传输哈希、新路径、复制源码哈希、重建 Squid 与既有 CI Bun1.3.14，
并记录清单。Playwright1.62.1 镜像及 seccomp 固定策略不变。新测试证书与固定 Ubuntu NSS3.98
构建工具只建立容器内的空信任库；不读取个人或宿主信任、不忽略证书错误。保留上游源码/依赖声明，
没有新增产品依赖或复制第三方实现。

TS 命令入口已通过真实 HTTP/PostgreSQL/mTLS Temporal/Node/WebSocket/Unix、完整 CSV/报告下载、
独立复核和官方二进制历史重放；该本机证明的 Native/peer 身份仍为合成。随后用真实 SDK 的受控
时序稳定复现快速审批竞态：审批前已获取的 Activity claim 只剩约59.8秒，无法容纳既有准备/运行/停止
预算。修复让新建的待审批命令 claim 预留既有120秒预算，不续期旧 claim，也不授予审批权限。
相同时序回归现已通过，执行和发布各一次，重放不改变计数；原生 CI 同时覆盖该竞态。
166项包完整性/远程边界/Host聚焦检查通过。当时原生命令/浏览器 CI 与此次修正打包待验证；后续证据见下节。

### 原生准备失败与关闭回执竞态修正

`15203a45` 的首轮原生尝试在 [CI37914182843](https://github.com/Peerframe/openbot/actions/runs/37914182843)
执行前停止：归档读取把 Docker 顶层目录误认为二进制。修复后逐个检查普通成员、长度和哈希；
Worker 解释器保留软链接所在 venv 前缀。`57520ba9` 的下一轮在
[CI37915993633](https://github.com/Peerframe/openbot/actions/runs/37915993633) 的原生准备处停止：
混淆了 Python manifest `6e13e65c…` 与 config `64d91f7b…`。官方 registry 原固定 manifest 已核验
后者；不同 Docker 存储返回的 inspect ID 不同。两轮都不能证明真实原生命令/浏览器通过。

原生 preflight 还要求离线载入后保留 registry digest。已审核
[Skopeo 拷贝契约](https://github.com/containers/skopeo/blob/9e29e4cede9bdaa4a54aa5b0af86efedb823bde4/docs/skopeo-copy.1.md)
支持 `--preserve-digests`、OCI 归档、明确平台和匿名 TLS 校验读取；
[上游问题2222](https://github.com/containers/skopeo/issues/2222) 说明旧 Docker 归档无法保留原 registry digest。
选择 Ubuntu24.04 的安全维护包 `skopeo=1.13.3+ds1-2ubuntu0.24.04.3`，上游1.13.3 commit
`9e29e4cede9bdaa4a54aa5b0af86efedb823bde4`（Apache-2.0），仅用于一次性 CI runner。
[官方包目录](https://archive.ubuntu.com/ubuntu/pool/universe/s/skopeo/) 保留该精确 amd64 包。
此传输拒绝旧 `docker save`；已有 CLI 能保留所需字节，不新增自制 registry 客户端。
独立校验 OCI manifest/config 哈希、长度与 Linux amd64，再记录归档哈希；重建 Squid 的 config
与 manifest 均记录。不复制 Skopeo 源码、不新增产品依赖或用户安装，保留原 Host/镜像 preflight。
同一原生通道现先于普通浏览器场景执行，尽早暴露剩余门槛的实际失败。

该轮还发现产品 Workflow 竞态：SQL 关闭整棵树后，并发 Activity 可能先拒绝，早于 `closeWorkTree`
回执。工作流现在只在原关闭已经发起时等待其结果，再判定该拒绝或取消监视器；300秒权限限制
不变，不重发副作用。真实 SDK/mTLS 受控时序在修复前失败，修复后成功关闭通过，关闭失败仍传播，
两份历史均可重放；此排序探针的权限回调是合成。随后完整真实 SQL/Temporal Work 套件49项通过，
包括实际协作截止期和5个进程 SIGKILL 窗口。包/Host聚焦170项通过；完整仓库检查通过，执行受影响
构建并复用未变化缓存。当前 HEAD 的托管与原生验收仍是必需门槛。

claim 修正版的 macOS 包已通过34资源/13导入导出与双服务生命周期 smoke；同一已安装应用恢复
Keychain 登录、工作区和实时连接，正常退出后双服务/PostgreSQL 均停止，重启再次通过。
Workflow 修正版45daf316现已依次完成暂存与完整打包。第二次实际 smoke 通过34资源/13导入导出、
真实 PostgreSQL/mTLS 原生 Temporal 双服务生命周期和无效配置拒绝，模型调用为零。首次 smoke
确实在 Node24.21.0 HTTP 驱动的 `setTypeOfService EINVAL` 处失败，日志保留，与
[上游记录](https://github.com/nodejs/undici/issues/5544) 一致。没有加入 HTTP 驱动补丁，后续通过
不抹去首次失败。smoke 使用合成加密回调；实际已安装应用界面另行验证了原 Keychain 登录。
同一已安装应用现包含两项修正，恢复认证工作区与实时连接，正常退出后双服务/PostgreSQL 停止，
再次启动成功。源码/包/安装文件哈希一致：work-execution
`f59d018c0f539bfa317a1ee63d69bf82bfd30580f50c7d28fd1cba51d68c65b1`，Work workflow
`2a2a405e72dfd3dc1ce181195127da517d8432b8f1806d56928d988a400a9747`。原 profile 和所有应用/profile
回滚副本继续保留。

### 第三轮准备失败与真实 OCI 传输预检

45daf316 的 [CI37918849225](https://github.com/Peerframe/openbot/actions/runs/37918849225) 同样在
两种原生流程前失败：Skopeo1.13 拒绝同时包含 tag 与 digest 的 registry 引用。现只用固定 digest；
重建 Squid 还在 OCI index 保留原 tag，满足未变的原生离线 loader。
[固定版本传输语法](https://raw.githubusercontent.com/containers/image/v5.26.1/docs/containers-transports.5.md)
说明这两个限制/注解；不放宽镜像内容固定值或原生执行约束。同一轮 Windows 缺失资源测试在
约80次完整文件 preflight 后超过5秒默认时间；只给该测试15秒有界 I/O 时间，逐项拒绝启动与
双服务清理断言保留，产品截止期不变。

再次托管前，已在 Mac 上一个自动删除的 Ubuntu24.04 amd64 容器内，用固定 Skopeo 包实际复制
不可变公开 Python 与 Chromium 镜像；原 manifest/config、平台与层身份独立 OCI 检查通过。
此仿真预检只证明传输，不证明 Linux/runsc 验收。首个容器 TLS unknown-authority 失败保留；
重试只挂载主机已有公共系统信任证书并保留 TLS 校验，没有 Docker socket、用户 profile 或凭据
挂载。真实原生命令/浏览器和最终 HEAD 的全部检查仍待通过。


### 首次真实原生 staging 尝试

`0b718481` 的 [CI37921320288](https://github.com/Peerframe/openbot/actions/runs/37921320288) 已通过
新鲜原生包准备，含两份不可变 OCI 复制和重建 Squid 导出。真实命令步骤随后在 Host staging
以 `native_stage_failed` 拒绝；清理未确认，隔离浏览器跳过。私有子进程 stderr 未上传，因此底层
原因仍未确定；保留该失败。同轮 Windows 客户端作业在资源夹具时间修正后已通过。

固定且经哈希核验的 root launcher 现只返回白名单错误码/类型及最多四处公开包源码位置；父进程
在 staging/ready 前失败时保留这些无内容 JSON 诊断，不公布异常值、局部变量、密钥、注册凭据或
私有 stderr。正负脱敏检查通过；此改动只补定位，不授予通过、不重试。新鲜真实原生 staging、
命令、隔离浏览器与完整托管检查仍待通过。


`1b5da7fd` 的 [CI37923141565](https://github.com/Peerframe/openbot/actions/runs/37923141565) 诊断
保留了原 Host staging 安全目录检查的 `unsafe_directory`，同一检查也阻止密钥清理验证；原生命令
与浏览器均未通过。新建 root 目录使用私有权限，共享 `/opt` 祖先是剩余权限嫌疑，但此前未保留
其元数据。准备现只在明确的一次性 GitHub runner 收紧这个固定祖先为 root:root0755，记录前后
UID/GID/权限与 inode 未变，并在原生准入前执行原目录检查。不递归、不改已有工具子目录、不改用户
主机，也不放宽原生门槛。仍须实际记录的元数据与新原生结果才能关闭该缺口。


### 已确认的 CI 祖先权限缺口与同机 Node 连接

`d15d8d95` 的 [CI37924247192](https://github.com/Peerframe/openbot/actions/runs/37924247192) 实际记录
`/opt` 从 root:root0777 收紧为 root:root0755，inode 不变；原 staging 随后通过，真实 PostgreSQL/mTLS
Temporal 启动。Node 未进入注册表，runner 清理仍未成功，命令与隔离浏览器均未验收通过。
适配原先给 Node 一个单独 loopback TCP 中转端口，原样转发 HTTP Host 到 TS 入口；入口要求准确的
标准 Host，端口不同即拒绝。没有公开保留原 Node 异常，此归因基于实际拓扑与入口契约。
同机适配现直接使用 Server 选定的 loopback 端口，在 root staging 前绑定它，并在发送注册前拒绝
端口变化；不增加代理或允许的 Host。产品入口检查、一次注册凭据、真实低 UID/Unix peer 和原生
预算不变；远端 SSH 与默认验收保留原 staging/生命周期。仍需新鲜实际结果。


直连端口尝试 `a9ad854a` 的 [CI37927173904](https://github.com/Peerframe/openbot/actions/runs/37927173904)
在原生 staging 前失败：提前创建 API 时，拥有的 PostgreSQL 还未通过 `ControlDatabase.start`
分配 DSN。该次已创建资源清理通过，命令和浏览器均未运行。原生 CI 现先启动该拥有数据库，再
创建 API 并保留标准端口；迁移与引擎启动仍在实际 API/Node 启动前，普通与远端路径顺序不变。
新增合成启动顺序回归执行真实 journey 入口，并验证 staging 拒绝后的清理，不执行 Docker、
模型或特权操作；此回归不能代替原生验收。


### 真实原生命令通过；隔离浏览器 OCI 命名缺口

`63ccf725` 的 [CI37928387456](https://github.com/Peerframe/openbot/actions/runs/37928387456)
已通过真实 TS 保护 Linux/runsc 命令：原占用跨审批保留，命令一次，精确 CSV/报告下载、独立审核
与二进制历史重放。公开结果包含实际 SO_PEERCRED UID62425、一次预留、原单元 `timeout`、空
cgroup、五秒余量内停止、单元释放、私有运行时与输出 backing 消失、密钥/socket 删除，以及前后
三个宿主容器/防火墙状态一致与控制器完整清理。Native 和 peer 身份均为真实，模型仍为可控夹具。

随后隔离浏览器在首次 Squid 名称检查拒绝，尚未就绪或产生产品效果；两个 OCI 装载和 Chromium
身份检查已经完成。Skopeo OCI ref-name 不能可靠建立 Docker 标签；固定的
[Skopeo 传输契约](https://github.com/containers/skopeo/blob/v1.13.3/docs/skopeo.1.md)
区分 OCI-layout 标签和 Docker-archive 引用，因此沿用离线绑定提供 Docker 本地名称，内容不变。失败原单元已关闭、其运行时
已移除，零容器/防火墙宿主基线一致；P4 仍未完成。私有 packet 现给独立固定的已装载 Squid
manifest 绑定原本地标签，再保留原 config/manifest/平台门槛；沿用既有命令的
[离线装载绑定](../../experiments/linux-execution/deadline_probe.py)，不改变镜像内容、源码隔离、
路由、原生预算或宿主 daemon。未公开保留原 daemon 错误，传输命名归因仍基于实际操作与装载
契约，而非原异常。仍须新的真实隔离浏览器及当前 HEAD 全部 CI。
