# C22–C24：存储清理的后续

[English](storage-cleanup-follow-ups.md) · 简体中文

- 状态：接口已实现；C23 Owner 批准的窄分支已验证
- 日期：2026-10-03
- 负责人：@yxflc11
- 相关：C21（#164）及其界面（#169）的后续
- 验收路径：Owner 在「设置 › 存储空间」里确认一次就能清空所有频道的回收站；能看到每个 Bot
  在工作电脑上保存了多少浏览器数据；在回收站里对还被引用的文件，能打开引用它的消息和任务。
- 安全边界：只有 Owner 能读取；只有 Owner 能执行删除，而且要先确认。是否可删、引用情况和审计
  仍然只由服务电脑决定。远程工作电脑报告的是实测数字，不做估算，也不能当作删除的依据。

## 触发原因与已有决定

- 触发：公开接口（新增或扩展三个命令），以及 [C21](channel-storage-purge.zh-CN.md) 的持久数据边界。
- 已有决定：C21 的私有文件目录、暂存日志、逐个文件审计和 `attachment_cleanup_receipts`；
  C19 在一个快照里有上限的[引用计数](channel-attachment-reference-counts.zh-CN.md)；C6 的浏览器维护
  （基于 MIT 许可的 `agent-computer`，固定版本 `257c1280`，见 [C6 记录](desktop-browser-management.md)）。
- 缺口：SettingsStorage 和 ChannelFilesTrash 两张画板需要三项信息，现有接口都不提供。所以第 25 步
  （#169）带着三处已写明的差异上线：只能按频道清空回收站；没有「浏览器数据」；没有「查看引用」。
- 本次范围：只针对这三处缺口。C21 的删除安全、幂等凭证和审计都不变。

## 发现

1. **全局清空回收站。** `StorageService.cleanup` 已经能在同一个 Owner 事务里、持有私有文件锁的
   情况下，删除一组回收站里的文件。它只是按单个频道筛选，幂等凭证以 `(channel_id, request_key)`
   为键。每天的 30 天自动清理本来就会遍历所有活跃频道。如果改成界面逐个频道调用，每个频道都要
   单独的请求和标识，可能做到一半就停下，没有统一的结果，确认框里也给不出准确数字。另外
   `/storage` 只给了被引用文件的个数，没给这些会保留的文件有多大。
2. **浏览器数据。** 每个 Bot 的 Chromium 资料是 `agent-computer` 存储卷上的一个目录
   （`profileDirectoryFor(botId)`，每个 Bot 一个，在工作电脑上）。固定版本的上游只提供
   `/health`、`/computers/stop`、`/computers/reset`，没有接口报告目录大小。Docker Provider 通过
   HTTP 和它通信，碰不到存储卷。服务电脑量不了别的机器上的磁盘，所以 C21 返回
   `workingComputerBrowserData: null` 是对的。
3. **引用。** C19 的查询按设计只计数：在频道的消息和任务指令里匹配
   `[OpenBot attachment: <id>]`。要显示具体是哪些消息和任务，需要一个列表接口。界面已经能往前
   翻更早的消息（C18）、能滚动到已载入的消息（`showMessage`），也能按任务标识打开任务详情。

## 方案比较

| 缺口 | 方案 | 评估 | 结论 |
| --- | --- | --- | --- |
| 全局清空 | 界面逐个频道调用现有清理 | 没有统一的凭证和结果；可能只做一部分；确认数字不准 | 不采用 |
| 全局清空 | `POST /api/v1/storage/trash/cleanup`，对所有活跃频道复用 `_remove`，用一个全局凭证 | 一次确认、一个可重放的结果、安全性不变 | **采用（C22）** |
| 浏览器数据 | Docker Provider 自己去量存储卷 | 它碰不到存储卷；接 Docker socket 会扩大权限 | 不采用 |
| 浏览器数据 | 在工作电脑上跑 `docker system df -v` | 只有存储卷的总量，没有每个 Bot 的数字；慢；需要 Docker socket | 不采用 |
| 浏览器数据 | 上游 `agent-computer` 报告有上限的单个 Bot 资料大小，`browser.maintenance@1` 的状态结果带上它 | 每个 Bot 单独量、在数据所在的机器上量、不增加权限 | **采用（C23）**：现在采用 Owner 批准的窄分支；上游合并并验证后切回 |
| 引用 | 在 C19 计数结果里直接带上消息内容 | 每次列文件都变得很重 | 不采用 |
| 引用 | 按附件的 Owner 专用列表，带简短预览 | 有上限、按需读取、权限和读频道一样 | **采用（C24）** |
| 引用 | 新增 `around=<消息标识>` 用于跳转 | 对话窗口要处理中间断开的情况 | 暂缓；界面改为往前翻有限页数的 C18 分页 |

## 提议的约定（交给 Codex）

- **C22——全局清空回收站。**
  - `POST /api/v1/storage/trash/cleanup`，请求体 `{requestKey}`；返回
    `{removed, retained, retainedCount, retainedHasMore, freedBytes, channelCount}`，条目格式沿用 C21。
  - 只清理活跃频道回收站里的文件。被引用的文件保留；每个删除的文件单独审计，原因记为
    `empty_trash_all`。
  - 幂等凭证只以 `requestKey` 为键：用同一个标识重试，会返回同样的结果，不会多删。上限沿用
    C21；只要有引用情况不明，就整次拒绝。
  - `/storage` 的 `trash` 增加 `referencedSizeBytes`，让确认框区分实测的被引用与未引用字节；
    并发变化和最小删除标记会影响最终释放量。
- **C23——浏览器资料大小。**
  - 上游 `agent-computer` 报告单个 Bot 的资料大小：遍历有上限、不跟随链接，返回内容里不出现
    路径；量不出来时返回 `null`。
  - `browser.maintenance@1` 的状态结果增加 `profileBytes: number | null`。
  - 在 `OPEN_SOURCE_REUSE.md` 记录上游 PR 或窄分支的固定版本。
- **C24——附件引用列表。**
  - `GET /api/v1/channels/:channelId/attachments/:id/references?limit=20`，只有 Owner 能读，返回：
    - `messages: [{id, createdAt, author: {kind: "owner" | "bot" | "system", botId?}, preview}]`，其中
      `preview` 最多 120 个字符，并去掉附件标记；
    - `tasks: [{runId, title, status, createdAt}]`；
    - `messageCount`、`taskCount`、`hasMore`。
  - 按时间从新到旧，匹配规则与 C19 相同。回收站里的文件也适用；不返回其他频道的引用；文件已被
    永久删除时不返回任何内容。

## 界面计划（Claude，在对应约定合并后做）

- **C22：** 「设置 › 存储空间」恢复「清空回收站…」，确认框和画板一致，删完后显示结果和保留了哪些。
- **C23：** 「设置 › 员工浏览器」在查看状态后显示每个 Bot 的资料大小。「存储空间」单独加一行
  「工作电脑上的浏览器数据」，需要时才测量。它不计入服务电脑的总量，因为数据在别的机器上。
- **C24：** 在保留下来的文件上点「查看引用 ›」打开列表。点消息会关闭弹窗并滚动到那条消息，
  必要时往前加载有限页数；点任务会打开任务详情。

## 复用决定

- 选择：在现有约定上扩展（C22、C24），采用 Owner 批准的窄分支（C23）。
- OpenBot 特有的缺口：就是上面三项信息；C21 和 C19 都不改。
- 退出方案：#730 保持开放；上游合并后审阅并验证固定版本及镜像，切回上游并退休窄分支。
- 失败时的行为：量不出或被拒时显示「量不出」，不显示 0；引用情况不明就拒绝删除；清理结果不明时
  只能用同一个标识重试。

## 源码引入

- 复制或实质改编源码：是，独立部署的 MIT agent-computer 窄分支保留 CopilotKit 源码及 LICENSE；
  本仓库不引入上游控制面。

## 验证计划

- 自动化测试：C22 的 Python 接口测试（重放、保留文件、引用不明时拒绝、逐个文件审计）；C24 的测试
  （上限、范围、预览截断）；C23 的上游和 Provider 测试；每项界面改动的 Web 测试。
- 拒绝与失败关闭测试：频道不对、文件已永久删除、limit 超上限、Owner 会话过期或缺失、工作电脑
  不具备该能力。
- 平台：本地 macOS arm64；托管 CI 的 Linux 任务。
- 文档与翻译：`docs/API.md`（中英文）、DESIGN 的界面对照表。
- 可以声明的支持程度：每项约定和它的界面都合并后，标为「已接入」。

## 未决问题

- 本轮没有。Owner 已于 2026-10-03 批准窄分支；上游接受是退出条件，不是阻塞。

## 实现检查点（2026-10-03）

C22、C24 后端接口基于 `dafc2e13` 实现在 `codex/c22-c24-storage-follow-ups`。
迁移 `0051_global_trash_cleanup` 新增独立的 `storage_cleanup_receipts` 表，只按 UUID 为键，
限制 JSON 响应大小，不设频道外键；C21 原凭证的命名空间和生命周期保持不变。
`channelCount` 统计有候选回收站文件的有效频道，包括全部保留的频道。
引用文件大小包含元数据及派生文本；所有暂存、引用复核、SQL 守卫、删除凭证和逐文件审计复用 `_remove`。
测得大小不授予清理权限。

C24 在同一 SQL 语句内获取有界计数和两个新到旧的列表。ASCII `limit` 默认 20、范围 1–100，
分别限制各列表；同时间按 ID 的 C 排序规则降序。任务标题最多 160 个码点。
Owner 已于 2026-10-03 同意增加 `author.kind: "system"`：C19 已经统计自动系统消息，不能冒充 Owner。
这是上文作者类型的已批准补充。

C23 已提交 [CopilotKit/OpenBot #730](https://github.com/CopilotKit/OpenBot/pull/730)，
审阅上游版本 `cb5dc32a44517622c6db4e527e61d3abb389b43c`，贡献提交
`46eb7af817027c5de4202846c73c43bbb2fa67b7`。MIT 贡献在创建会话前提供已认证的 `GET /computers/profile-usage`，只选择校验后的 `Bot-Id`。
Linux 遍历使用 `/proc/self/fd` 锚定目录及 `O_NOFOLLOW`，跳过符号链接，拒绝硬链接、特殊文件、
跨设备目录，并检查观察时目录被替换的情况。最多 10,000 项、16 层、2 秒协作式期限
（在文件系统操作前后检查）、同时一次测量。确认 Bot 目录不存在返回零；错误、拒绝、不支持的平台
或根目录缺失返回 null。普通文件在观察期间可能变化，不承诺原子快照。

依据：[Node 文件系统接口](https://nodejs.org/api/fs.html)及
[Linux open(2)](https://man7.org/linux/man-pages/man2/open.2.html)。`O_NOFOLLOW` 只保护最后一个
路径分量，因此使用目录描述符锚定，不能直接递归拼接不可信路径。有限遍历和 Provider 请求期限
限制通常的工作量；协作式期限不保证抢占阻塞中的内核文件系统操作。

之前等待上游的决定已被下方 Owner 决定取代。Provider 与状态接线不变；安全整数校验与
未知或拒绝测量归一为 null 保持不变。

已执行证据：真实 PostgreSQL／HTTP 的存储清理、附件引用和浏览器会话共 52 项 Python 测试；
3 项协议测试及 35 项 Docker 浏览器／维护测试通过。上游 Linux 测试 46 项通过、1 项非 Linux 测试跳过，
包括不启动 Chromium 的真实认证 HTTP 接口，使用现有 `openbot-browser:257c1280` 镜像及 Bun 1.4.2。
macOS Bun 1.3.14 的不支持平台用例通过，4 项 Linux 专用用例跳过。
没有访问用户数据库、调用付费模型或修改生产数据。完整集成、迁移验证及限制记录在下方。

迁移验证：已提交的 52 条 SQL 来源 `8946a480542683cb85bf1b6ebc7c4134a9b27630` 通过全部
40 项历史升级／恢复及 8 项清理检查。[入库结果](../../experiments/s7-migration/evidence/global-trash-result.json)
保存精确 SQL／journal 哈希，封存历史和测试逻辑未修改。

实际 Linux arm64 产品镜像
`sha256:059fef02e0a3ea0a9b599953c6df20d1612ea34f74358e91a86181914c8e04b8`
通过 `deploy/server/smoke-product.py`：52 条迁移、真实 Owner HTTP、构建后的 Web、DOCX／PDF 与
空白 OCR 初始化、错误启动在创建 schema 前拒绝、SIGTERM 和重启后原文件／密钥保留。
所有专属容器、网络及卷已清理。这是本地 Docker VM 证据，不是托管平台资格验证；未配置 Temporal，
未调用真实模型。

集成结果：`npm run check` 完成此前各门槛及 lint／typecheck，随后在未修改的发布密钥 CLI
30 秒超时处失败；该文件单独运行 3 项全过。串行 Turbo 补跑通过 Web 644 项、Docker Provider
67 项及其他已完成包；Desktop 的三份未修改文件出现 4 项超时（530 项通过、3 项跳过）。
这三份文件以 `--maxWorkers=1` 单独重跑，15 项全过。被中断的 Node 测试另以单 Worker 执行：
Vitest 129 项通过、3 项跳过，另有 54 项有界传输 Node 测试全过。最终 `npm run build`
18 个任务成功（5 个实际执行、13 个缓存）。复用已通过的前置门槛，原整套命令仍记录为失败，
不改称一次全绿。

`npm run test:control:python` 两次超过既定 300 秒套件期限。第一次并发负载下还出现 4 项 SDK
失败，第二次这 4 项均通过；第二次完成 789 项且无测试失败，在员工导入导出模块超时
（收集 1,039 项、另跳过 2 项）。被中断模块及之后所有模块另在专属 PostgreSQL 补测 301 项：
初次 288 项通过，13 项因临时诊断夹具漏了原有基础 Bot／Channel 而失败；补齐原夹具格式后，
这 13 项重跑全过。这些是补充证据，不代表默认完整命令及 pytest 之后的 TS 回读断言通过。
独立 Worker／Temporal 和托管 CI 未执行。文档检查通过（12 项测试、576 份 Markdown）；
研究检查的 27 项单元测试通过，PR 事件检查因不在 pull_request 事件内而跳过。

交付状态：上述本地分支的后端、协议、中英文文档及测试可供审阅，迁移提交固定在验证清单中。
本轮 C22–C24 未创建产品 PR 或部署；明确要求的上游 PR 已开放，尚无评审。
原有无关 `output/` 目录未改动，没有仍在运行的测试或实现写入者。
C23 不再等待上游 #730 接受／拒绝，界面保持为另一个计划切片；默认整套命令超时仍是明确的验收限制。

## C23 Owner 批准的窄分支和镜像（2026-10-03）

Owner 明确决定不再等上游 #730，自行维护窄分支。仓库为
[yxflc11/openbot-agent-computer-upstream](https://github.com/yxflc11/openbot-agent-computer-upstream)，
分支 `codex/c23-profile-usage-production`，提交 `29a83c1932fb67398dd7a36fa80c473e0230a637`。
唯一父提交为生产 `257c1280d684089be9adb0b35cce262efc7064bf`，唯一变化为移植贡献
`46eb7af817027c5de4202846c73c43bbb2fa67b7`。

冲突处理：保留生产的 `sessionFor`、profile 释放回调与 `PROFILES_DIR ?? "/profiles"` 行为。
只新增 usage import、根目录别名与创建会话前的认证路由，不引入新版 session、secret-masking、
virtual-display 或 egress。生产没有新版 `control-http.test.ts`，因此只提取 usage 用例和有界
子进程夹具到 `profile-usage-http.test.ts`。测量实现、单元测试与 usage 文档同贡献版本完全一致。
fork 没有依赖、锁文件或 Dockerfile 变化。

MIT：Copyright (c) 2026 CopilotKit；保留 fork 根 `LICENSE`，并在镜像中保存完整声明
`/app/THIRD_PARTY_LICENSES/agent-computer.MIT`。本地 Linux arm64 镜像为
`openbot-browser:29a83c1`，digest
`sha256:2efa5b5dd9edd7a37357413e7091f27c34e3e37eeb63d3643e5ddc8249dc5019`。
在确切 fork checkout 执行 `docker build -t openbot-browser:29a83c1 -f agent-computer/Dockerfile .`，
再加下方仅声明和来源标签的层：

```dockerfile
FROM openbot-browser:29a83c1
COPY LICENSE /app/THIRD_PARTY_LICENSES/agent-computer.MIT
LABEL org.opencontainers.image.source="https://github.com/yxflc11/openbot-agent-computer-upstream"
LABEL org.opencontainers.image.revision="29a83c1932fb67398dd7a36fa80c473e0230a637"
```

生产源码清单与下载夹具固定到此仓库、提交，新增 usage 的 SHA-256，其余源码哈希与依赖 pin 不变。
实际最终镜像（Bun 1.4.2）通过 45 项 Linux 测试，跳过 1 项非 Linux 用例。未改动的 Docker Provider
连接实际镜像：合成 Bot 返回 8 字节，硬链接资料返回 null，不存在的 Bot 返回 0，均未启动 Chromium。
已核对认证与镜像 MIT 声明。Provider／状态接线不变，null 仍显示「量不出」，远端字节不加入服务电脑总量。

退出条件：[#730](https://github.com/CopilotKit/OpenBot/pull/730) 保持开放。上游合并后审阅并验证
精确提交及镜像，把生产与夹具切回上游，再退休窄分支。本轮证据为本地 Linux arm64 镜像与 Provider；
托管 Linux amd64 资格及现有工作电脑部署另行完成，没有使用用户资料。
