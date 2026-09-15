# 研究：在读取过程中限制 JSON 请求大小

[English](2026-09-15-request-body-limits.md) · [简体中文](2026-09-15-request-body-limits.zh-CN.md)

- 状态：接受实施
- 日期：2026-09-15
- 负责人：OpenBot 维护者
- 验收流程：超大的流式登录请求在认证前、读完整个请求前被拒绝；正常登录和较大的员工包仍可用。
- 安全边界：每条路由的字节上限由 Server 决定。客户端长度声明不能允许多读数据；权限、状态码和现有上限保持不变。

## 搜索依据

- 搜索日期：2026-09-15。
- GitHub 查询：`repo:honojs/hono body-limit`、`repo:honojs/node-server body-limit`；检查固定版本的中间件源码、测试、MIT 许可证、发布记录及当前正文／流相关开放问题。
- 检查 [node-server #327](https://github.com/honojs/node-server/issues/327) 中提前拒绝时的连接重置问题，以及已修复的[分块正文安全公告](https://github.com/honojs/hono/security/advisories/GHSA-9vqf-7f2p-gf9v)。
- 一手资料：[Hono 正文限制](https://hono.dev/docs/middleware/builtin/body-limit)、[WHATWG Streams 固定快照](https://streams.spec.whatwg.org/commit-snapshots/b9ba9f49d95b4280be0dc2372377a006c3a91c18/) 的读取／取消／释放规则，以及 [RFC 9110 第 8.6 节](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.6) 的字节长度定义。
- 核对 `docs/OPEN_SOURCE_REUSE.md` 中浏览器控制面安全、员工导出／导入记录，以及 `app.ts` 的两个 JSON 读取入口。附件和模型元数据已有的受限读取器采用各自的错误类型，且等待取消完成，不能原样用于公开请求的快速拒绝。

## 候选比较

| 候选 | 固定版本或提交 | 许可证 | 维护与测试 | 接口与安全适配 | 决定 |
| --- | --- | --- | --- | --- | --- |
| WHATWG Streams reader 和原生 `TextDecoder` | Streams `b9ba9f49d95b4280be0dc2372377a006c3a91c18`；现有受支持 Node 运行时 | WHATWG 标准条款；Node.js license | 标准关联 web-platform-tests；受支持 Node 自带 | 先统计原始字节，再解码；保留跨块 UTF-8／BOM 行为；取消剩余数据并释放锁 | 采用标准，仅补充路由策略适配 |
| 已有 Hono `bodyLimit` | [4.13.7 / `eebdf7be39abf0a872671835ccce0c4f03ea497a`](https://github.com/honojs/hono/tree/eebdf7be39abf0a872671835ccce0c4f03ea497a/src/middleware/body-limit) | MIT | 已发布依赖；测试覆盖分块正文、冲突长度头和处理函数绕过 | 固定版本信任单独的 `Content-Length`；超限分支没有取消和释放 reader；中间件通常返回 413 | 保留原有用途，不能原样满足本次读取和清理契约 |

## 复用决定

- 采用开放标准并增加薄适配层，不加依赖、不维护分支、不复制框架实现。
- 本地缺口仅为统一现有 JSON 读取器的路由字节上限和 `RequestValidationError`。每块解码前统计字节，首次超限即停止；长度头只用于提前拒绝。
- 发起取消，但不等待不可信源的取消承诺完成；所有路径释放 reader 锁。
- 保留默认 64 KiB、更小的显式路由上限、员工预览 2 MiB、员工激活 2 MiB + 64 KiB；附件继续沿用自己的限制。
- 后续 Hono 公共接口满足长度和清理契约时重新评估替换；保留真实路由回归测试。
- 超限保持现有 422 错误；通用 JSON 的格式错误或读取失败仍返回校验错误，不进入认证或存储。此限制约束应用读取量，不约束传输层已缓冲的数据或慢请求持续时间。

## 源码引入

- 复制或实质改写上游源码：否。
- `apps/server/src/app.ts` 及路由测试使用标准公共接口。
- 无需新增版权声明；已有 Hono 依赖保留其 MIT 声明。

## 验证计划

- 通过实际 `createApp` 登录入口检查缺失、少报、超大长度头，确认读取量、取消、锁释放、错误兼容和超限时不调用登录。
- 检查恰好达到字节上限、BOM、跨块多字节 UTF-8、无效 JSON、读取失败，以及取消拒绝或永不结束。
- 检查更小的显式路由上限、超过 64 KiB 的有效员工预览／激活和流式员工包超限；只用有界合成数据，不需要凭据或数据库。
- 执行针对性 Server 路由测试及仓库总检查，不增加平台支持声明；中英文记录同步。

## 未解决问题

- 提前拒绝时的网络表现取决于 HTTP 适配器；客户端仍在上传时可能看到连接关闭。应用层测试不构成网络层抗拒绝服务保证。
