# C22–C24：存储清理的后续

[English](storage-cleanup-follow-ups.md) · 简体中文

- 状态：提议
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
| 浏览器数据 | 上游 `agent-computer` 报告有上限的单个 Bot 资料大小，`browser.maintenance@1` 的状态结果带上它 | 每个 Bot 单独量、在数据所在的机器上量、不增加权限 | **采用（C23）**：先向上游提交；被拒再做窄分支 |
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
  - `/storage` 的 `trash` 增加 `referencedSizeBytes`，让确认框能写出准确的删除大小。
- **C23——浏览器资料大小。**
  - 上游 `agent-computer` 报告单个 Bot 的资料大小：遍历有上限、不跟随链接，返回内容里不出现
    路径；量不出来时返回 `null`。
  - `browser.maintenance@1` 的状态结果增加 `profileBytes: number | null`。
  - 在 `OPEN_SOURCE_REUSE.md` 记录上游 PR 或窄分支的固定版本。
- **C24——附件引用列表。**
  - `GET /api/v1/channels/:channelId/attachments/:id/references?limit=20`，只有 Owner 能读，返回：
    - `messages: [{id, createdAt, author: {kind: "owner" | "bot", botId?}, preview}]`，其中
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

- 选择：在现有约定上扩展（C22、C24），向上游提交改动（C23）。
- OpenBot 特有的缺口：就是上面三项信息；C21 和 C19 都不改。
- 退出方案：如果上游不接受 C23，就固定一个只加了大小接口的窄分支。在约定合并之前，第 25 步的
  差异继续写在 DESIGN 里。
- 失败时的行为：量不出或被拒时显示「量不出」，不显示 0；引用情况不明就拒绝删除；清理结果不明时
  只能用同一个标识重试。

## 源码引入

- 复制或实质改编源码：否。

## 验证计划

- 自动化测试：C22 的 Python 接口测试（重放、保留文件、引用不明时拒绝、逐个文件审计）；C24 的测试
  （上限、范围、预览截断）；C23 的上游和 Provider 测试；每项界面改动的 Web 测试。
- 拒绝与失败关闭测试：频道不对、文件已永久删除、limit 超上限、Owner 会话过期或缺失、工作电脑
  不具备该能力。
- 平台：本地 macOS arm64；托管 CI 的 Linux 任务。
- 文档与翻译：`docs/API.md`（中英文）、DESIGN 的界面对照表。
- 可以声明的支持程度：每项约定和它的界面都合并后，标为「已接入」。

## 未决问题

- 上游 `agent-computer` 是否接受新增大小接口，这决定 C23 用上游版本还是窄分支。
