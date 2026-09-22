# Research: fresh contributor login and retained Node identity

[简体中文](2026-09-22-contributor-journey.zh-CN.md)

- Status: Accepted for implementation
- Date: 2026-09-22
- Owner: OpenBot maintainers
- Acceptance journey: from `npm ci` and no build output/private dotenv, start the real Server/Web development entry, sign in, optionally enroll the real development Node, restart the processes and verify the retained Owner session and Node identity.
- Security boundary: synthetic Owner credentials and disposable loopback storage only; enrollment remains an Owner-authorized one-time Server operation. The optional Node has no Provider configuration, performs no task and receives no new authority. Cleanup is limited to this run's process groups, private temporary directory and labelled PostgreSQL container.

## Search evidence

- Search date: 2026-09-22.
- GitHub queries: `repo:vercel/turborepo is:issue is:open shutdown`, fixed-version `graceful_shutdown_test.rs`, `nodejs/node test-child-process-detached`, and `porsager/postgres v3.4.9 connect_timeout end timeout`.
- Primary documentation: [Node child-process lifetime](https://nodejs.org/docs/latest-v22.x/api/child_process.html#optionsdetached), [Turbo run](https://turborepo.dev/docs/reference/run), [Postgres.js connection/shutdown](https://github.com/porsager/postgres/tree/v3.4.9), and [Docker run](https://docs.docker.com/reference/cli/docker/container/run/).
- Existing reviewed entries: contributor startup/clean-checkout verification, Node bootstrap identity, migration integrity and the headless Runtime journey in `docs/OPEN_SOURCE_REUSE.md`. Inspected `scripts/smoke-dev-startup.mjs`, `scripts/test-runtime-headless.mjs`, Node runtime/client/file credential adapter/tests, Server enrollment routes/tests and [ADR-0023](../decisions/0023-one-time-node-enrollment.md) at OpenBot `2cc32d04d08b1c7e70288b326b990762e0db27aa`.
- Reuse the [existing Turbo startup review](2026-09-15-contributor-startup.md). Rechecked the exact [Turbo 2.10.12 graceful-shutdown tests](https://github.com/vercel/turborepo/blob/53752d452049bdda47698354b16a83d7ce92ced0/crates/turborepo/tests/graceful_shutdown_test.rs): Unix process-group signals, Node-wrapper shutdown and retained child lifetime are explicitly tested. The open `shutdown` issue query returned no matches on this date. No scheduler replacement is indicated.
- Inspected the fixed [Node v22.22.2 detached-child test and embedded MIT notice](https://github.com/nodejs/node/blob/v22.22.2/test/parallel/test-child-process-detached.js); release target `2645dc73720b1b4f27c49f395d3c66025ce126cc` is already reviewed in the [Linux archive record](linux-worker-host-archive.md). Official docs warn that killing a parent alone does not terminate descendants. Keep the current POSIX process-group boundary and test cleanup rather than claiming Windows support.
- Postgres.js remains installed `3.4.9` (Unlicense); inspected installed connection/timeout/end implementation and existing integration tests. [Release 3.4.9](https://github.com/porsager/postgres/releases/tag/v3.4.9) fixes issue 1143. Open [issue 988](https://github.com/porsager/postgres/issues/988) concerns multi-host failover; this fixture accepts only one loopback host and does not claim failover. Bound connection, statement and shutdown waits.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance/tests | Platform and security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| Existing OpenBot smoke and official Turbo scheduler | OpenBot `2cc32d0`; Turbo `2.10.12` / `53752d452049bdda47698354b16a83d7ce92ced0` | MIT | Existing fresh-start CI smoke plus upstream Unix shutdown regressions | Executes the contributor's actual root commands with their real dependency ordering | Extend the current adapter |
| Existing Node process/HTTP/filesystem APIs | Node `22.22.2` / `2645dc73720b1b4f27c49f395d3c66025ce126cc` | Node.js license, predominantly MIT | Official detached-child test and lifecycle documentation inspected | Bounded loopback HTTP, explicit process groups, private temporary paths; POSIX scope only | Reuse; no new runner dependency |
| Existing disposable PostgreSQL fixture | Postgres.js `3.4.9`; PostgreSQL `17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0` | Unlicense; PostgreSQL and bundled Debian component licenses | Existing Runtime Docker journey and migration CI cover this exact image | Random loopback port, random synthetic password, tmpfs data and run-owned label; explicit external empty fixture still supported | Reuse the reviewed fixture pattern |
| New test framework or custom Node identity implementation | Not selected | Not applicable | Would duplicate existing production paths and lifecycle tests | Neither is required for orchestration of the existing entrypoints | Reject; only the acceptance driver is missing |

## Reuse decision

Keep `dev:smoke` as the existing clean-checkout entry and add `--with-node` for optional enrollment/restart. Reuse `npm run dev` and `npm run dev:node`; do not import the client or Server implementation into a simulated smoke. Verify the real HTTP proxy, authentication, one-time enrollment, Server connected identity and exact retained file digest after restarting without bootstrap credentials. The file uses the production atomic credential adapter; the fixture only checks its results.

The local gap is fixture lifecycle, stage-specific bounded diagnostics and retention assertions. The default container path removes only a container matching this run's private ownership label. An explicitly supplied empty `_dev_smoke` database remains caller-managed and is never dropped; its service must be disposable, as in the existing CI job. Private files and child processes are always removed. No personal `.env`, model key, OS keyring or installed app profile is used.

Upgrade/exit: preserve the fixed image, existing npm/Turbo pins and credential contract. Tool, port, dirty-fixture, authentication or identity failures exit nonzero with a named stage; never silently downgrade a requested Node journey. Keep the POSIX limitation visible until separately reviewed native Windows process-tree evidence exists.

## Source incorporation

- Source copied or substantially adapted from upstream: no.
- Existing OpenBot startup and Runtime fixture code is reused/refactored within the same MIT repository.
- No new dependency, protocol, exported credential value or upstream notice is introduced.

## Verification plan

- Focused tests for URL/fresh-checkout rejection, environment isolation, secret-safe diagnostics, identity invariants and process-group cleanup.
- Real fresh-checkout Docker-backed Server/Web login and retained-session restart; repeat with optional Node enrollment, one-time-token rejection and retained credential reconnect.
- Verify no owned container, process or private directory remains after success and a controlled failure/interruption.
- Run repository checks after the fresh journey, since they intentionally create build output.
- Dedicated English/Chinese usage/evidence document; root command, CI and reuse-ledger wiring is handled by integration.
- Evidence establishes local POSIX contributor lifecycle, not native host installation, Provider authority, computer-operation conformance or paid-model quality.

## Unresolved questions

- None for this bounded journey. Native Windows execution remains a separate acceptance lane.

## Shutdown correction: Darwin exited process groups (2026-09-22)

The final integrated cold checkout at `88fbce0` reached Node disconnect, then failed with
`kill EPERM` after Turbo had stopped its tasks. The previous passing run did not cover this race.
An independent local macOS probe created one owned detached child, observed `ps` state `Z`, and
received `EPERM` from signal zero; after `waitpid` reaped that same child, the result was `ESRCH`.

Inspected Apple's [kill(2) documentation](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/kill.2.html)
and exact [XNU `kern_sig.c` at `f6217f891ac0bb64f3d375211650a4c1ff8ca1ea`](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/kern_sig.c).
`killpg1` excludes `SZOMB` group members and returns POSIX `EPERM` when no eligible member remains;
an absent group returns `ESRCH`. This explains the reproduced OS behavior; the public source is
not asserted to be the exact installed kernel revision. XNU is Apple Public Source License 2.0;
no implementation is copied. Node's existing child-process exit notification remains the owned
leader's reap evidence. No process-tree dependency is required.

Keep signaling only the detached child's known PGID. On `EPERM`, obtain a bounded OS snapshot
containing PID, PGID, UID and state only (no commands or environment). Only no members or exclusively
zombie members establish that execution has ended; a live member or failed inspection remains an
explicit cleanup failure. Wait for the direct child's exit notification as well. Share concurrent
stop calls, mark stopped only after successful verification, and allow a failed stop to be retried
by the driver's final cleanup. Verify the actual zombie race, live-descendant cleanup, real
permission denial with retry, concurrent stop and the final integrated cold journey.

Validation: ten focused fixture tests passed, including the real macOS `Z`/`EPERM` case and a
SIGTERM-resistant orphan descendant requiring SIGKILL. A new `88fbce0` archive with only this helper
correction and its tests replaced passed `npm ci --ignore-scripts` and the full
`npm run dev:smoke -- --with-node` (exit zero). Subsequent cwd-process, port, labelled-container and
private-directory inspection found no remaining fixture resources. The original failure log,
independent kernel probe, successful smoke log and cleanup evidence were retained for integration
review; no unrelated process or container was signaled or removed.
