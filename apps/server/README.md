# OpenBot Server

[简体中文](README.zh-CN.md) · [Repository map](../../docs/REPOSITORY_MAP.md) · [Architecture](../../docs/ARCHITECTURE.md)

The Server owns identity, routing, authorization, task state and audit. `src/index.ts` assembles real services; `src/app.ts` owns HTTP middleware and route mounting. New feature endpoints belong in focused `*-routes.ts` modules mounted after Owner/session/Origin policy. Models, plugins and Nodes never receive control-plane authority.

- Native model work: `native-agent.ts`, `agent-*.ts`, `postgres-agent-*.ts`.
- Channel submission/Worker lifecycle: `postgres-store.ts`, `run-dispatcher.ts`, `node-registry.ts`.
- Extensions: `plugin-service.ts`, `plugin-transport.ts`, `plugin-types.ts`, `plugin-routes.ts`.
- Attachments: `channel-attachments.ts`, `channel-attachment-routes.ts`, `attachment-processing.ts`.
- Channel reactions/membership: `channel-interactions-store.ts`, `channel-interactions-routes.ts`.
- Shared data schema is in `packages/db`, validated wire input in `packages/protocol`.

From the repository root, run `npm ci`, configure the documented development `.env`, start PostgreSQL with `npm run db:up`, and use `npm run dev` for Server and Web together. Use `npm run dev:server` for Server alone; both root commands build shared dependencies first. Neither requires a model account for startup or Owner login. `npm run test --workspace @openbot/server` runs unit/HTTP tests after shared dependencies have been built. Database integration tests require their explicitly named disposable URL variables; CI creates separate databases for startup, automation, direct conversations, collaboration and interactions. Never point those variables at a user database.

CI runs `npm run dev:smoke` immediately after `npm ci` and before builds. To reproduce it on Linux/macOS, use a fresh checkout without `.env` or `dist`, free ports 3001/5173, and an empty loopback PostgreSQL database whose name ends in `_dev_smoke`; set its URL as `OPENBOT_DEV_SMOKE_DATABASE_URL`. The check starts real development processes, verifies the Web proxy and Owner session, and removes its temporary object/model storage when finished. The disposable database is left for the fixture owner to discard.

Run root `npm run typecheck` when shared packages change so Turbo builds dependencies first. End a change with `npm run check`. Prepared external effects must fail closed when audit, membership or approvals fail; network waits must not be hidden inside database transactions. See [contributing](../../CONTRIBUTING.md).
