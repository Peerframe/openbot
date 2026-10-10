# Research: Node 24 production Server container

- Status: Baseline implemented and verified on native Linux amd64 and arm64; nested dependency packaging and Node-major policy updates await integrated native CI
- Date: 2026-09-05; policy re-review note 2026-09-11
- Owner: @yxflc11
- Related issue: 8-hour Server deployment milestone
- Acceptance journey: Build the same reviewed Server image for native Linux amd64 and arm64,
  start it as a non-root process against PostgreSQL 17, observe a healthy response only after
  migrations complete, and stop it through `SIGTERM` with exit code zero.
- Security boundary: The Server remains the only identity, policy, routing, approval, audit, and
  persistence authority. The image must contain no credentials, build toolchain, unrelated
  workspaces, or development dependencies; runtime configuration enters only through the existing
  strict environment schema. Missing dependencies, migrations, writable storage, database access,
  or a clean shutdown fail the verification instead of weakening the image or support claim.

## Search evidence

- Search date: 2026-09-05
- GitHub queries: `repo:nodejs/docker-node 24.20.0 bookworm-slim`,
  `repo:nodejs/docker-node is:issue architecture support alpine arm64`, and
  `repo:nodejs/node is:issue alpine tier 2`.
- Standards and primary documentation queries: Node.js `v24.20.0` LTS release and platform list;
  the official Node Docker image source, best practices, license, supported architectures, and
  manifest; Dockerfile multi-stage/digest syntax, build checks, and multi-platform builds.
- Existing OpenBot issue, ADR, and reuse-ledger entries checked: `deploy/server/Dockerfile`,
  `deploy/server/compose.yaml`, `.dockerignore`, `docs/TECHNOLOGY.md`, `docs/ROADMAP.md`,
  `docs/CROSS_PLATFORM.md`, bounded Server shutdown, PostgreSQL migration integrity, and the
  current reuse traceability table. No complete Server-image entry existed.
- The official Node.js release is [`v24.20.0` Krypton LTS](https://nodejs.org/en/blog/release/v24.20.0),
  published 2026-08-26.
- The reviewed official-image source is signed commit
  [`c4eb0858f5c522521768d5b6dc1d9f1631d4854d`](https://github.com/nodejs/docker-node/tree/c4eb0858f5c522521768d5b6dc1d9f1631d4854d),
  which generated Node `24.20.0` images and has successful upstream build checks. The project is MIT
  licensed; bundled Node and Debian components retain their own licenses and notices.
- Registry inspection of `node:24.20.0-bookworm-slim` returned OCI index
  `sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e`, with native
  `linux/amd64` manifest
  `sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa` and native
  `linux/arm64/v8` manifest
  `sha256:e9b5516b06baeaea9a8e65a7aec6a85fbb960a30b52b66968f2c8092b3e2a3eb`.
- Node's [`v24.20.0` platform table](https://github.com/nodejs/node/blob/v24.20.0/BUILDING.md#platform-list)
  classifies GNU/Linux glibc x64 and arm64 as Tier 1 and says production applications should use
  Tier 1 or Tier 2 platforms. Linux x64/musl remains Experimental. The official Docker image
  documentation also states that non-x64 musl builds, including arm64, are not tested before
  release. The open Node issue
  [`#62764`](https://github.com/nodejs/node/issues/62764) confirms that promoting Alpine beyond
  Experimental is still unresolved.
- The official [Node Docker best practices](https://github.com/nodejs/docker-node/blob/c4eb0858f5c522521768d5b6dc1d9f1631d4854d/docs/BestPractices.md)
  recommend an unprivileged runtime user, an exec-form Node command for signal delivery, and
  multi-stage separation of build tools. Docker documents immutable `FROM name:tag@digest` syntax,
  [multi-platform builds](https://docs.docker.com/build/building/multi-platform/), and
  [Dockerfile build checks](https://docs.docker.com/reference/build-checks/). The
  [Compose service contract](https://docs.docker.com/reference/compose-file/services/#stop_grace_period)
  documents a 10-second default before `SIGKILL`; OpenBot therefore configures 20 seconds so the
  Server's 10-second HTTP drain still leaves bounded time to close the dispatcher and database.
  The same contract supplies `read_only` and a private UID/GID-owned `tmpfs`; Compose applies these
  already-smoke-tested restrictions while leaving only the object-store volume writable.
- Policy re-review date: 2026-09-11. Official Dependabot options reference for
  `package-ecosystem: docker`, `open-pull-requests-limit`, and `ignore` /
  `update-types: version-update:semver-major` (version updates; security updates remain separate).
  Node.js Release schedule lists **24.x Active LTS (Krypton)** and **26.x Current** with Active LTS
  start planned 2026-10-28—so as of this note Node 26 is not yet LTS. Corepack distribution removal
  for Node 25+ is recorded in the Node.js TSC vote and distribution docs (`nodejs/TSC` PR 1697;
  `nodejs/node` distribution history / Corepack API notes).

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| Official Node Debian Bookworm slim image | Node `24.20.0`; docker-node `c4eb0858`; OCI index `sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e` | MIT image source; Node.js license; bundled Debian component licenses | Current LTS image generated by the maintained official-image project; upstream build checks passed; registry publishes native amd64 and arm64 manifests | glibc x64 and arm64 are Node Tier 1. The slim base retains Node/npm and CA certificates while excluding the broad default-image tool set. Exact tag plus index digest gives one reviewed multi-platform input | Select |
| Official Node Debian Bookworm default image | Node `24.20.0`; docker-node `c4eb0858` | Same as above | Same maintained release line and Tier 1 architectures | Viable but includes a wider common Debian tool set that the Server does not need. It does not close an acceptance gap that slim plus runtime smoke tests leaves open | Reject for this bounded runtime image |
| Official Node Alpine image | Node `24.20.0-alpine3.24`; docker-node `c4eb0858` | MIT image source; Node.js license; bundled Alpine component licenses | Maintained and published for amd64/arm64, but Node classifies musl x64 as Experimental and the Docker image project says non-x64 musl builds are not tested before release | Smaller image, but it cannot support the intended production amd64/arm64 evidence level while its libc targets remain below Tier 1/2 | Reject; reconsider only after upstream support and OpenBot evidence change |
| Custom scratch/distroless runtime | No reviewed release | Varies | Would introduce another image producer and a custom Node/runtime assembly and notice path | Removing npm is attractive, but health checks, CA roots, Node patching, provenance, and notices would become OpenBot-specific before the official slim image has failed an acceptance requirement | Reject as premature custom implementation |

## Reuse decision

- Selected option: released dependency plus a thin local packaging adapter.
- Selected upstream or standard: official Node.js `24.20.0` LTS Docker image at docker-node commit
  `c4eb0858f5c522521768d5b6dc1d9f1631d4854d`, pinned by the exact Bookworm-slim OCI index digest;
  Docker multi-stage, non-root, digest, build-check, and multi-platform contracts.
- Why this is the first viable option: It supplies a maintained LTS runtime on Node Tier 1 amd64 and
  arm64 targets without adding a runtime dependency or a second release system. OpenBot only needs
  to assemble its already-built Server closure and enforce its own configuration/lifecycle gates.
- Exact OpenBot-specific gap: The existing Dockerfile uses mutable, below-engine
  `node:22.22.0-alpine`, copies the whole repository, retains all development dependencies, and runs
  as root. No test currently proves the production dependency closure, migration presence,
  writable object storage, container health, native architecture, or clean Docker stop. Compose
  also requires the removed `OPENBOT_NODE_TOKEN` Server variable.
- Upgrade, replacement, or exit plan: Keep the production Server image on Node **24 Active LTS**
  (`24.20.0-bookworm-slim` pin) until a deliberate, reviewed migration. Dependabot is configured to
  **ignore automatic Docker `node` SemVer-major version updates** while still allowing patch/minor
  image updates (see `.github/dependabot.yml` and the official Dependabot `ignore` /
  `update-types: version-update:semver-major` option). A future Node 24 patch may refresh the
  upstream docker-node commit and multi-platform digest after the usual dual-arch verification.
  A Node **26+** major must **not** land via an unreviewed Dependabot bump (including the open
  Dependabot PR that proposed `26.x`); supersede that path with this policy rather than merging a
  Current/non-LTS major. The separately attested Worker Host remains on Node `22.22.2` until its
  own release migration regenerates hashes, SBOM, attestations, packages, and rollback evidence.

### Re-review triggers (Node 26+ / next LTS)

Re-open this research and update the reuse ledger **before** changing the Dockerfile `FROM` major
when **all** of the following are true, or when an Owner explicitly schedules a major migration:

1. **Node 26 (or the next even line) has entered Active LTS** on the official
   [Node.js release schedule](https://github.com/nodejs/Release#release-schedule). Until then,
   Node 26 remains Current and is **not** an OpenBot production baseline. Do not force Node 26
   while Node 24 is Active LTS.
2. **Package-manager / Corepack prep is explicit.** Node.js TSC decided to stop distributing
   Corepack on Node **25+** release lines (24.x keeps experimental Corepack). Any migration past
   Node 24 must document how the Server image obtains `npm`/`pnpm`/`yarn` (bundled npm only,
   `npm install -g corepack`, or another reviewed install path) so production installs do not
   assume a Corepack binary that is no longer in the Node distribution.
3. **Dual-arch health + migration tests pass on the candidate image.** Native Linux amd64 and
   arm64 hosted jobs must rebuild the candidate Bookworm-slim (or successor Tier-1) digest,
   start against PostgreSQL 17, observe migration-backed `/health` only after migrations complete,
   restart, verify object-store writes, and require zero-exit `SIGTERM`—the same evidence bar as
   the Node 24 baseline. Alpine/musl remains rejected while below Tier 1/2.
4. Research record, `docs/OPEN_SOURCE_REUSE.md` (+ zh), Dockerfile pin/digest, and static container
   validator fixtures are updated in the same change set.
- Failure behavior when the upstream is missing, incompatible, or compromised: Digest or static
  contract drift fails the local check. Either native image build, dependency inventory, migration,
  health, write, restart, or `SIGTERM` failure blocks the PR and any support claim; there is no
  floating-tag or Alpine fallback.

## Source incorporation

- Source copied or substantially adapted: no.
- Files and upstream locations: The OpenBot Dockerfile and verification scripts are local
  compositions of documented Docker/Node public contracts. No upstream source file is copied.
- Required copyright or license notice location: Existing Node/Debian notices remain in the
  official base image. `docs/OPEN_SOURCE_REUSE.md` records the selected source and licenses; no new
  vendored notice is required.

## Verification plan

- Automated tests: A static, fixture-tested container validator checks the exact base reference,
  required stages, production-only install, explicit migration/runtime copies, non-root user,
  health check, stop signal, and exec-form command. `npm run check` includes this validator.
- Negative and fail-closed tests: Moving/removing the digest, adding a floating `FROM`, omitting
  migrations, restoring root, retaining known development tools, removing health/stop contracts,
  or restoring the legacy Server token must fail a fixture test.
- Platforms and devices: Native `ubuntu-24.04` amd64 and `ubuntu-24.04-arm` arm64 hosted jobs build
  without publication, inspect architecture/user/inventory, start against PostgreSQL 17.11,
  observe migration-backed health, restart, verify object-store writes, and require zero-exit
  `SIGTERM`. The smoke uses the same 20-second stop budget as Compose. Local Docker Desktop is
  development evidence only.
- User-visible documentation and translations: Update English and Simplified Chinese compose and
  contributor guidance. The user separately requested complete Japanese and Brazilian Portuguese
  README translations before this execution goal ends.
- Support level that the evidence permits: A green PR proves the reviewed image builds and passes
  the named hosted/container journeys. It does not publish an image or establish general Linux,
  NAS, cloud, macOS, Windows-container-host, or production support.

## Observed verification

- [PR #15](https://github.com/yxflc11/openbot/pull/15) at source commit
  `7df48634fe34ce28e1ba863786804132940def65` passed all nine jobs in
  [CI run 33938120773](https://github.com/yxflc11/openbot/actions/runs/33938120773).
- Native [amd64 job 101229948183](https://github.com/yxflc11/openbot/actions/runs/33938120773/job/101229948183)
  and [arm64 job 101229948275](https://github.com/yxflc11/openbot/actions/runs/33938120773/job/101229948275)
  each passed Compose parsing, warning-free Dockerfile checks, seven-workspace compilation,
  and the full Server smoke with all 18 migrations. Both logs contain the successful smoke marker.
- `npm run check` passed locally on the same source. The independent review findings and the
  remaining roadmap gates were recorded in review DEV-002. This records hosted test evidence, not a release.


## Nested Server workspace production dependency packaging (2026-09-11)

- Status: Gap observed in hosted dual-arch CI; packaging contract corrected on Draft PR #43
- Trigger: After Dependabot-compatible `filename-reserved-regex` **4.0.1** landed on
  `grok/deps-patch-hono-biome-types-filename`, native Server container jobs failed:
  - amd64 job [`103302795495`](https://github.com/yxflc11/openbot/actions/runs/34611481967/job/103302795495)
  - arm64 job [`103302795510`](https://github.com/yxflc11/openbot/actions/runs/34611481967/job/103302795510)
  - Error: `ERR_MODULE_NOT_FOUND: Cannot find package 'filename-reserved-regex' imported from
    /workspace/apps/server/dist/employee-package.js`
- Root cause (packaging contract, not a one-package hoist accident):
  - npm workspaces may place a Server **production** dependency under
    `apps/server/node_modules/` when another workspace already nests a different major
    (here: Desktop nests `filename-reserved-regex@3` via Electron tooling; Server pins `4.0.1`).
  - The production-dependencies stage correctly ran `npm ci --omit=dev`, which installed the
    nested Server production package.
  - The runtime stage only `COPY`ed root `/workspace/node_modules`, so Node's resolver walking
    from `apps/server/dist/*.js` could not find the nested package.
  - Rearranging the lockfile so this one package happens to hoist would not close the general
    workspace nesting contract and would regress whenever another workspace reintroduces a
    conflicting major.
- Chosen fix:
  1. After `npm ci --omit=dev`, `mkdir -p apps/server/node_modules` so Docker `COPY` always has a
     source even when every Server production dependency is hoisted.
  2. Runtime `COPY`s `/workspace/apps/server/node_modules` from the production-dependencies stage
     alongside root `node_modules`, preserving the real omit-dev production closure and excluding
     Server `devDependencies` (including `@types/filename-reserved-regex`).
  3. Native smoke now resolves modules via `createRequire` anchored at
     `apps/server/dist/employee-package.js`, dynamically imports that module, and calls
     `buildEmployeeTemplate` with Windows reserved stem `CON` expecting
     `con-employee.openbot-employee.json` — coverage that fails closed if the nested production
     package is missing from the image.
- What was rejected: lockfile-only hoist of `filename-reserved-regex` without copying nested
  Server production `node_modules`; copying the full build-stage `node_modules` (would retain
  toolchain / devDependencies); bundling the Server into a single file before this packaging
  contract is proven.
- Verification plan addition: `scripts/check-server-container.mjs` requires the nested `COPY` /
  `mkdir` fragments and the export-filename smoke markers; fixture tests reject their omission.

## Unresolved questions

- The existing PostgreSQL `17.11-bookworm` service tag is version-specific but not digest pinned.
  This slice reuses its already-reviewed database test contract and does not claim the entire
  Compose stack is byte-for-byte reproducible; a database-image provenance migration remains a
  separate release task.
- Docker's image-level health result proves the process is accepting HTTP after startup migration;
  the existing `/health` endpoint is not a continuous database-readiness check and documentation
  must not describe it as one.
- The zero-exit `SIGTERM` smoke covers a healthy, idle Server. Signal handlers are currently
  registered only after migration and dispatcher startup, while dispatcher/database drains do not
  have their own process-level deadline. Startup interruption, busy requests, and a stalled
  database therefore need a separate lifecycle-hardening slice; this container evidence must not
  be described as proving those paths.
- Compose currently interpolates the raw `OPENBOT_POSTGRES_PASSWORD` into a PostgreSQL URI. URL
  delimiter characters can make that URI invalid even though PostgreSQL accepts the raw password.
  A later configuration slice should separate the raw database secret from a validated encoded
  connection value (or deliberately constrain the accepted alphabet) without placing credentials
  on command lines or in image layers.
- Dependabot Docker major ignores apply to **version updates**. Security-driven majors may still
  surface outside the ignore path; treat any such PR as requiring the re-review triggers above,
  not as an automatic pin change. Keep Node `24.20.0` until a reviewed patch/LTS migration updates
  this record.
