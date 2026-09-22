# 研究：Docker 浏览器一致性场景

- 状态：接受实施；日期：2026-09-22；主线：B1a；实现基线：`86223c6`。
- 验收：生产 Server、Node、Docker Provider 通过真实 HTTP 与已认证 WebSocket 执行受控
  点击，生成严格的 hermetic 报告，故障必须失败，结束后清理全部自有资源。
- 边界：Server/PostgreSQL 继续掌握身份、路由、批准和审计。电脑服务是无用户数据的合成
  loopback fixture，不能据此声称真实 Chromium、原生输入或跨平台认证。

完整固定来源、许可证与对比见[英文研究](docker-browser-conformance.md)。已复核复用登记表的
Provider SDK/浏览器、conformance runner、Node 身份、Server 关闭和 PostgreSQL fixture 条目，
以及既有受控点击、runner 和贡献者旅程研究。

2026-09-22 实际检索 GitHub：`repo:CopilotKit/openbot is:issue is:open browser`、
`CopilotKit openbot agent-computer click snapshot control`、`nodejs node destroyed socket response`。
复核上游 `257c1280d684089be9adb0b35cce262efc7064bf` 的 API、profile/control 源码、
package.json、测试和 MIT 许可证；它固定 Playwright 1.62.1（Apache-2.0）。开放 issue #86
讨论更广的内容、费用和注入治理，不能替代 OpenBot 的批准测试，也不能证明没有其他缺陷。

复用仓库已有 runner 的稳定场景、必须通过的检查、期限、取消、清理和独占报告写入。
MCP 先例仍为 `74edef34d674f563537be8c6587cebaa58e830ca`（Apache-2.0/MIT 过渡，文档 CC-BY-4.0）。
实际启动生产应用和 Node 类，以 Owner API 签发 enrollment token，通过认证 WebSocket 执行。
仅合成外部电脑服务，按固定上游 token/Bot、snapshot/ref、control 和 click 契约注入故障。
无需新依赖、协议或生产行为变化。

Node 22.22.2 固定提交 `2645dc73720b1b4f27c49f395d3c66025ce126cc` 的 HTTP 文档和
`test-http-destroyed-socket-write2.js` 支持在记录点击后销毁响应连接，模拟执行结果未知；
`closeAllConnections` 不会关闭升级后的 WebSocket，所以单独关闭 Node/registry。
复用既有 `SmokeDatabase` 和 PostgreSQL 17.11 bookworm 固定 OCI digest；只移除名称和随机
标签都确认属于本次的容器，数据库使用临时存储。不复制或实质改写任何上游源码。

批准过期通过修改本 fixture 的 PostgreSQL 截止时间，再调用真实 Owner 决策接口验证，
明确披露这不是等待两分钟的时钟测试。HTTP 超时使用生产期限。在已有 fetch 接口边界延迟
reader 取消完成，验证同 Bot 锁直到清理完成才释放；不替换 Server 策略或批准结果。

必测：精确 ref/snapshot 批准一次、重复决定拒绝、拒绝、过期、Node stop、撤销凭据导致
断线、证据变化、人工接管、HTTP 超时、点击后回执丢失仅一次尝试、清理期间同 Bot 互斥。
检查真实 Run/批准/审计/产物和帧。执行 fixture 回归、真实 Docker suite、资源清理核查及
`npm run check`；缺失前置条件或清理失败必须非零退出，不能 skip。报告只允许 hermetic。

B1b 保留缺口：当前 Owner cancel 仅支持 native Run。Node stop 不能冒充 Owner Worker-run
cancel；断线目前只结束 running，waiting_approval 可能仍待定，离线批准才明确失败。
后续修复这两个产品入口时复用本 suite。Capability lease 和跨进程资源锁另行实现。

## 验证证据（本地日期 2026-09-23）

实际主机报告 `macos`、`arm64`、`osVersion: 27.0.0`，运行 Node `v26.0.0`。
最终报告为 **15 success、0 failure、0 skipped**：11 个必需浏览器场景和 4 个声明/目标检查，
无预期失败，`summary.conformant: true`，证据级别严格为 `hermetic`。7 个 focused fixture
回归通过。合成 PNG 的 chunk CRC 有效，没有采集真实用户截图。

点击断言对照**已持久化批准**的 before-state，不依赖可变的当前电脑状态。每次合成 snapshot
都会递增世代，额外观察不能悄悄替代 Owner 批准的 snapshot。首次开发运行中的 fixture Bot
重名使必需 setup 检查正确失败、驱动非零退出；改为随机名称后通过，没有改生产逻辑。

`npm run check` 已通过文档、研究、配置、发布、lint、typecheck、测试和构建。普通门禁原有的
可选 PostgreSQL/原生平台测试仍按配置跳过；本 Docker suite 的每个场景都使用真实 PostgreSQL，
**没有跳过**。

另一次真实中断测试在 Node 已登记、进入 `browser.approve-once: run` 后向自有驱动发送 SIGTERM：
退出码 1，没有生成报告，子进程已回收，带标签 Docker 容器和私有 fixture 目录清单回到运行前。
成功运行也已清理容器和私有文件；fixture 清理还断言电脑 socket 已关闭、Provider 执行数为零。

根集成主线另行把共享数据库 readiness 改为 TCP `pg_isready -h 127.0.0.1`，避免官方镜像初始化
阶段的临时 Unix-socket PostgreSQL 被误判为最终可用。本主线没有重复修改共享 helper。
上述结果不增加真实浏览器或其他原生平台支持声明。

独立审查实际复现了驱动期限缺陷：`execFile({timeout})` 只发送 SIGTERM，子进程忽略后 Promise
不结束，`catch` 内的强杀无法到达。已核对固定 Node 提交的 [child-process 文档](https://github.com/nodejs/node/blob/2645dc73720b1b4f27c49f395d3c66025ce126cc/doc/api/child_process.md)：
timeout 发信号与 AbortSignal 回调错误是不同语义。专用 helper 改为独立 `AbortSignal.timeout`
合并外部取消，再仅对自己的确切 child 在短暂宽限后发 SIGKILL，并等待 `close`。
忽略 SIGTERM 的 deadline 和外部 abort 两条回归均通过，包含于 7 个 fixture/driver 测试。
没有新增通用进程管理框架、依赖或复制源码。
