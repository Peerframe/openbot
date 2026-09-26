# Repository map

[简体中文](REPOSITORY_MAP.zh-CN.md)

Read [architecture](ARCHITECTURE.md) for current authority boundaries and [CONTRIBUTING](../CONTRIBUTING.md) for the reproducible setup. Commands below run from the repository root. Use a focused change with its negative tests; avoid adding another state authority or an overlapping global stylesheet.

| Area | Main paths | Extend here | Focused checks |
| --- | --- | --- | --- |
| Server API | `apps/server-python/src/openbot_server/app.py`, feature `*_routes.py` | Register feature routes after Owner/Origin middleware; validate input before mutation | `apps/server-python/scripts/check.sh -q` |
| Persistence | `packages/db/src/schema.ts`, `packages/db/migrations`, Server `*_store.py` | [Hand-written SQL and read-only migration plan](DATABASE.md#author-a-migration); conditional transactions; never regenerate applied history | `npm run migration:plan --workspace @openbot/db -- --help`; `npm run migrations:check`; disposable PostgreSQL suite |
| Native Agent | `apps/agent-runtime-python/src`, `apps/server-python/src/openbot_server/work_*.py` | Scoped tools, bounded inputs, pre-effect audit, task identity and cancellation | Native Agent/mock-stream tests and collaboration PostgreSQL tests |
| MCP extensions | Server `plugin_*.py`, Web `Plugin*` components | Manifest-reviewed tools/resources/prompts and sandboxed app presentation | Plugin service/content/transport and sandbox tests |
| Shared product types | `packages/domain/src` | Stable public product DTOs without app imports | `npm run typecheck --workspace @openbot/domain` |
| Wire contracts | `packages/protocol/src` | Strict external schema and negative tests; keep internal product types separate | `npm run test --workspace @openbot/protocol` |
| Channel experience | Web `ChannelWorkspace`, `MessageActionBar`, `MessageReactions`, attachment components | One visual/interaction concern per component; controlled callbacks to Server state | Component tests plus actual wide/narrow rendered acceptance |
| Web data/session | Web `use-workspace-state.ts`, `api.ts`, `conversation-session.ts`, `run-output-state.ts` | Authenticated requests, draft ownership, exact-channel event updates | API/session/event tests and Web typecheck |
| Desktop boundary | `apps/desktop/src/main.ts`, `preload.cts`, `native-server.ts` | Narrow typed bridge and trusted-frame checks; host lifecycle outside renderer | Desktop tests; native install/start/stop on target OS |
| Node execution | `apps/node/src/client.ts`, `runtime.ts`, `providers.ts` | [Enroll a development Node](../CONTRIBUTING.md#start-an-optional-development-node) before connecting; assignment and capability/runtime validation | Node lifecycle/transport tests |
| Providers | `providers/*`, `packages/provider-sdk`, `packages/provider-conformance-runner` | Maintained upstream adapter with executable capability and conformance evidence | Provider tests and applicable conformance suite |
| Security/policy | `packages/policy`, `docs/SECURITY.md`, Server auth/approval modules | Default denial, bounded authority and explicit audit | Policy/negative auth tests and `npm run security:config-check` |
| Packaging/CI | `scripts`, Desktop `scripts`, `.github/workflows`, `deploy` | Reproducible build/install with pinned artifacts; no machine-private assumptions | `npm run release:check`, platform CI and native smoke |
| Website/manual | [openbot-website](https://github.com/yxflc11/openbot-website), `docs`, root READMEs | Link to canonical current docs; distinguish implemented, tested and planned | Site build, `npm run docs:check`, real browser check |

## Change flow

Start the [minimal Server/Web development loop](../CONTRIBUTING.md#local-development) before
enabling optional execution. For recovery, use the [complete persistent-asset inventory](DATABASE.md#backup-boundary),
including model keys/settings and plugin state. Retained third-party runtime notices and their
version/hash inventory live in [licenses/runtime](../licenses/runtime/README.md).

1. Identify the module and current reuse entry in [OPEN_SOURCE_REUSE](OPEN_SOURCE_REUSE.md).
2. For nontrivial behavior, record the primary-source review before coding.
3. Change the smallest feature module. Keep authority in the Server and use shared schemas for external contracts.
4. Add a meaningful failure or race test where a boundary changes. Use disposable databases, never a user profile.
5. Build changed shared packages before invoking an individual downstream typecheck, or use root Turbo scripts to order dependencies.
6. Update current English docs and the maintained Chinese translation, then run `npm run check`.

## Source and generated data

`dist`, `node_modules`, `.turbo`, Desktop `out`/`native-runtime`, private `.env`, database files and logs are generated or local and must remain untracked. A packaged app is not the source of truth for its code. The [design asset index](design/README.md) separates current references from historical concepts. Research records under `docs/research` explain decisions; product manuals should link to them instead of repeating historical implementation notes.

Keep each package's dependency direction explicit: apps depend on shared packages; shared packages must not import apps. Plugin authors should begin with [PLUGINS](PLUGINS.md); computer-backend authors should begin with [Provider conformance](PROVIDER_CONFORMANCE.md). A skill is one kind of content, not the complete extension protocol.

Task-flow entrypoints: `task-attachment-references.ts` owns new-reference policy; `postgres-task-submission.ts` owns the existing atomic Message/Run submission; `postgres-task-records.ts` contains pure row projections; `postgres-attachment-references.ts` checks durable owners for cleanup. Shared protocol files `attachments.ts`, `automations.ts` and `plugins.ts` contain data contracts only. Web `use-workspace-state.ts` reconciles snapshot requests, mutation responses and realtime events. See [task research](research/task-flow-refactor.md) and [workspace research](research/workspace-state-refactor.md).
