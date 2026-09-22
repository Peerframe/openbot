# 工作区快照契约

[English](WORKSPACE_SYNC.md) · [简体中文](WORKSPACE_SYNC.zh-CN.md)

独立只读客户端可调用已鉴权的 `GET /api/v1/workspace`，或订阅
`GET /api/v1/workspace/snapshots`。Server 始终掌握真实状态。
[`examples/workspace-reader`](../examples/workspace-reader/index.html) 示例不导入 React、Desktop、
数据库或 Server 的内部实现。

## 快照含义

持久化频道、Bot、近期任务、审批、产物、进度和计数来自同一个 PostgreSQL 只读可重复读事务。
连接中的 Node 随后从内存注册表独立采样，`counts.connectedNodes` 等于该数组长度。主机在线状态
与数据库任务状态并不是一次跨系统原子观察。

| 字段 | 范围 |
| --- | --- |
| `channels`、`bots` | 当前完整集合 |
| `runs` | 按创建时间最近 50 条；不包含全部活跃任务 |
| `approvals`、`artifacts` | 各最近 100 条；不代表完整历史 |
| `progress` | 最近 200 条持久化进度，按时间正序展示 |
| `counts.channels`、`counts.bots` | 同一数据库快照内的全局总数 |
| `counts.activeRuns` | queued、assigned、running、waiting_approval、blocked 的全局任务数 |

不要通过近期任务页推算全局活跃数，也不要在不完整的页面上累加事件差值。页面之外的任务完成
仍然会改变全局计数。

## 订阅与恢复

每个 `workspace.snapshot` SSE 事件含 `{type, version: 1, streamId, sequence, snapshot}`，其中
`snapshot` 沿用 GET 响应形状。收到后整体替换旧视图；同一连接内忽略重复或递减的 sequence。
因为每帧完整，跳号不影响恢复。这只是连接内的顺序，不是数据库版本或写入并发控制令牌。

每次连接的第一帧都是新读取；重连后 sequence 从 1 开始，并更换 `streamId`。Server 忽略
`Last-Event-ID`，不保存或重放持久事件日志。断线时保留旧视图并明确标为过期，直到新快照到达。
未知版本必须停止应用数据并显示不兼容。401 表示需要登录，429 表示订阅容量已满。原生
EventSource 不暴露 HTTP 状态，因此参考客户端在重试期间显示过期；需要精确诊断时可另查 GET。
参考客户端连续 35 秒没有新快照时也会标为过期，并在两秒后替换连接，以覆盖代理保留已失效上游
连接的情况；旧连接的晚到帧不能再改变视图。

模型临时文字和旧实体事件属于其他流。快照不包含每个 token，不证明外部动作已成功，也不表示
取消任务能撤回外部影响。

## 资源和兼容边界

每个 Server 进程最多允许 16 个快照订阅。变更通知被合并，每个连接至多每秒读取一次；读取和
写入正常完成时，最迟每 15 秒重新读取一次，也覆盖没有 hub 通知的变更。每次只执行一次读写；
写入阻塞五秒、帧超过 2 MiB 时关闭；连接五分钟后重连并重新鉴权。每条 SQL 有五秒超时。
读取或输出失败会关闭连接，不发送原始错误。

Server 共享读取器最多保留一个真实数据库读取和 32 个等待者。每个调用有十秒总期限，等待连接池
期间也能立即取消。Postgres.js 已在等待连接的事务无法直接取消；超过期限后它仍占用唯一读取位，
直到结束前都拒绝新读取，不堆积后台查询。读取启动后加入的调用会等待下一次新读取。GET 不可用时
返回通用 503；订阅读取失败则关闭连接，由客户端重同步。

此契约限于单 Server。原有 GET 和事件客户端保持兼容；现有 Web 乐观更新与 Desktop 代理白名单
未改变，新快照路由尚未开放给原生代理。大工作区分页、持久版本日志和多 Server 分发仍需独立设计，
不能把 sequence 当作这些能力。

## 运行与验证示例

执行 `npm ci`，按贡献指南在 3001 端口启动本地 Server，然后运行 `npm run dev:reader`，打开
`http://127.0.0.1:5173`，用本地 Owner 密码登录。示例复用 Cookie 登录和同源 Vite 代理，不把密码
保存到本地存储，界面通过文本节点渲染数据。5173 必须空闲；测试期间用此示例替代开发 Web 入口。
登录后只读取，不提交任务或修改数据；无需模型密钥或 Worker。

`npm run test:workspace` 验证 HTTP、订阅及独立消费者。`npm run db:verify` 还会在明确指定的临时
`_test` 数据库运行 `scripts/verify-workspace-snapshot.mjs`：强制在列表和计数查询之间提交一个
频道，检查最近 50 条之外的活跃任务仍被计入，并验证后续快照能看到已提交变更。

参见 [ADR-0046](decisions/0046-workspace-snapshot-stream.md) 与
[固定版本研究记录](research/workspace-snapshot-stream.md)。
