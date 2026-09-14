# Research: reproducible contributor startup

- Status: Accepted for implementation
- Date: 2026-09-15
- Owner: OpenBot maintainers
- Acceptance journey: after `npm ci` in a fresh checkout, a contributor starts Server and Web, opens the development page and signs in without a preliminary build or model account.
- Security boundary: the Server retains identity and session authority. Verification uses a dedicated loopback PostgreSQL database, synthetic credentials and temporary object/model storage; it does not enroll a Worker or invoke a model.

## Search evidence

- GitHub queries: `vercel/turborepo 2.10.12`, repository tree paths for persistent tasks and graceful shutdown; open issues and release notes checked on 2026-09-15.
- Primary documentation: [run options](https://turborepo.dev/docs/reference/run), [task configuration](https://turborepo.dev/docs/reference/configuration), and the matching [versioned run reference](https://github.com/vercel/turborepo/blob/53752d452049bdda47698354b16a83d7ce92ced0/apps/docs/content/docs/reference/run.mdx).
- Exact upstream: Turborepo `2.10.12`, commit `53752d452049bdda47698354b16a83d7ce92ced0`, released 2026-08-25. Reviewed the MIT license, `crates/turborepo-lib/src/run/mod.rs`, persistent-dependency fixtures and `crates/turborepo/tests/graceful_shutdown_test.rs`. The release includes process-shutdown test improvements and Windows command handling; current open work includes native workspace metadata and environment documentation. No reviewed issue requires replacing the scheduler for this change.
- Existing repository entries: `docs/OPEN_SOURCE_REUSE.md` has no dedicated Turbo startup review; its migration/enrollment workflow entry does not cover dependency ordering. The current `turbo.json` already declares `dev.dependsOn: ["^build"]`, but root commands bypass it. This record completes that missing review before implementation.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| Existing Turborepo | `2.10.12` / `53752d452049bdda47698354b16a83d7ce92ced0` | MIT | Maintained released scheduler; persistent-task fixtures and graceful-shutdown integration tests inspected | Already installed, understands workspace dependencies and persistent processes; development configuration must explicitly pass Server/Node environment variables | Selected released dependency |
| npm workspace forwarding | Existing npm `10.9.9` | Artistic-2.0 | Existing repository CLI, already reviewed in the reuse ledger | Runs a package script but does not execute the Turbo dependency graph | Retain as package-level primitives, not root startup entrypoints |
| New local dependency builder/process runner | Not selected | OpenBot MIT | No existing independent implementation is needed | Would duplicate Turbo scheduling and package selection | Rejected: the installed dependency supplies the required behavior |

## Reuse decision

Use Turbo filters for root startup, preserving its existing `^build` task graph. `npm run dev` selects Server and Web; independently usable `dev:server`, `dev:web` and `dev:node` select one application. Node remains an explicit enrollment-dependent action. Remove `--parallel`, whose documented contract discards dependency ordering. Permit `OPENBOT_*` and `TAVILY_API_KEY` only in the uncached development task so switching from direct npm forwarding preserves documented process-environment configuration without broadly weakening strict environment filtering.

The only local gap is an application-specific smoke journey using Node's existing process, network and Fetch APIs and the already-reviewed Postgres.js `3.4.9` client from `@openbot/db`: require a fresh checkout, an empty loopback database named `*_dev_smoke`, free development ports and no local `.env`; start the real root command; inspect health, the Web development document, the proxied Owner login and authenticated API; stop the child process group and remove temporary storage. The fixture does not drop databases or delete build output. The CI database job creates a dedicated `openbot_dev_smoke` database after `npm ci`, runs this smoke before `db:verify` builds, and discards its existing PostgreSQL `17.11` service. The POSIX process-group fixture is scoped to Linux/macOS and adds no Windows support claim. A failing startup, occupied port or invalid fixture configuration exits nonzero.

Keep the current pinned dependency; future Turbo upgrades must retain this real startup check. No new runtime or build dependency is introduced.

## Source incorporation

- Source copied or substantially adapted: no.
- Files: root startup scripts, `turbo.json`, `scripts/smoke-dev-startup.mjs` and bilingual setup documentation.
- Notices: upstream remains an installed MIT dependency with its existing package license; no copied-source notice is required.

## Verification plan

- Execute `npm run dev:smoke` immediately after `npm ci`, before any build/test task generates shared `dist` files; use `OPENBOT_DEV_SMOKE_DATABASE_URL` for the dedicated fixture.
- Verify the real Server startup/migration, Web HTTP response/proxy and Owner login/session with synthetic credentials; reject reused output, `.env`, non-loopback databases and occupied ports before startup.
- Run normal repository checks separately. This HTTP startup check does not establish rendered-browser, native Desktop, model-provider or Worker execution coverage.
- Update English/Chinese README, Server README and contributor instructions in the same change.

## Unresolved questions

- None for the startup-ordering fix. Native Windows process-tree verification remains outside this POSIX smoke fixture.
