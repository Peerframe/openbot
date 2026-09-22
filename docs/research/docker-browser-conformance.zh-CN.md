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
