# OpenBot Server

[English](README.md) · [仓库地图](../../docs/REPOSITORY_MAP.zh-CN.md) · [当前架构](../../docs/ARCHITECTURE.zh-CN.md)

Server 负责身份、路由、授权、任务和审计。`src/index.ts` 组装真实服务，`src/app.ts` 管理 HTTP middleware 和挂载。新功能端点放在独立 `*-routes.ts`，必须经过 Owner/session/Origin 策略。模型、插件和 Node 不获得控制面权威。

- 原生模型：`native-agent.ts`、`agent-*.ts`、`postgres-agent-*.ts`。
- 频道提交/Worker：`postgres-store.ts`、`run-dispatcher.ts`、`node-registry.ts`。
- 扩展：`plugin-service.ts`、`plugin-transport.ts`、`plugin-types.ts`、`plugin-routes.ts`。
- 附件：`channel-attachments.ts`、`channel-attachment-routes.ts`、`attachment-processing.ts`。
- 回应/成员：`channel-interactions-store.ts`、`channel-interactions-routes.ts`。
- 数据 schema 在 `packages/db`，外部协议校验在 `packages/protocol`。

根目录运行 `npm ci`，按文档配置开发 `.env`，使用 `npm run db:up` 启动 PostgreSQL，再运行 `npm run dev` 同时启动 Server 和 Web。仅需 Server 时运行 `npm run dev:server`；两个根目录命令都会先构建共享依赖。启动和 Owner 登录不需要模型账号。共享依赖已构建后，`npm run test --workspace @openbot/server` 覆盖单元/HTTP；数据库集成测试需要准确命名的临时数据库 URL，CI 分别创建 startup、automation、direct、collaboration 和 interactions 测试数据库。禁止使用用户数据。

CI 在 `npm ci` 后、构建前运行 `npm run dev:smoke`。在 Linux/macOS 复现时，使用没有 `.env` 和 `dist` 的全新检出、空闲的 3001/5173 端口，以及回环地址上名称以 `_dev_smoke` 结尾的空 PostgreSQL 数据库，将其 URL 设为 `OPENBOT_DEV_SMOKE_DATABASE_URL`。检查会启动真实开发进程，验证 Web 代理和 Owner 会话，结束时删除本次临时对象/模型存储；临时数据库由提供测试环境的一方销毁。

改动共享包后运行根目录 `npm run typecheck`，由 Turbo 先构建依赖。交付前运行 `npm run check`。审计、成员或审批失败必须阻止相应外部效果，数据库事务不等待外部网络。详见[贡献指南](../../CONTRIBUTING.zh-CN.md)。
