# Research: Integrated Desktop onboarding

- Status: Implemented preview; public distribution gates remain
- Date: 2026-09-05
- Owner: @yxflc11
- Related issue: Desktop onboarding request; issue pending
- Acceptance journey: choose an installation plan, complete its actual setup, configure model access,
  and revisit configuration from settings in a macOS window with integrated native controls.
- Security boundary: Server remains authoritative. A saved plan is not installation evidence.
  Keep native window controls, sandboxed renderer, bounded IPC, and OS permission prompts.

## Search evidence

- Search date: 2026-09-05.
- GitHub queries: `electron v44.2.0 BrowserWindow titleBarStyle hidden issues`.
- Primary documentation: Electron custom title bar and custom window interactions.
- Reviewed existing ledger entries: Desktop shell, setup intent, Server connection, macOS Worker
  onboarding; ADR-0043 and ADR-0044. Server installation and model configuration are absent.
- Inspected Electron v44.2.0 `docs/tutorial/custom-title-bar.md` and
  `spec/api-browser-window-spec.ts` (trafficLightPosition get/set tests), release notes, and issues
  [#39885](https://github.com/electron/electron/issues/39885),
  [#39959](https://github.com/electron/electron/issues/39959), and
  [#27882](https://github.com/electron/electron/issues/27882).

## Candidate comparison

| Candidate | Exact release | License | Maintenance and tests | Platform/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| Electron native hidden title bar | [44.2.0](https://github.com/electron/electron/releases/tag/v44.2.0) | MIT | Existing pinned release; upstream native position tests | macOS native controls without extra renderer authority | Adopt `hidden` and fixed traffic-light inset |
| Fully frameless/custom controls | Electron 44.2.0 | MIT | Same upstream | Requires recreating OS behaviors and new window IPC | Reject; native option satisfies request |
| React native forms and details | 19.2.8, existing lockfile | MIT | Existing component and integration tests | Progressive disclosure without extra dependency or authority | Reuse |
| Existing OpenBot app icon | origin/main 0a5b72d | Repository MIT | Existing icon packaging tests | Reuse the exact reviewed asset in renderer | Adopt via Vite asset import |

## Reuse decision

Use the first viable released API, Electron's native controls, on macOS only. Keep a reserved
traffic-light area even in fullscreen because upstream reports hit-test issues when placing controls
there. Do not combine transparent window/vibrancy with the custom title bar. Other platforms retain
native chrome. Apply draggable regions only to empty chrome and explicitly exclude controls.

The local gap is layout and flow orchestration between existing components. Installation and model
credential adapters require their own fixed-version evidence before implementation.

## Source incorporation

No upstream source copied or substantially adapted. Existing OpenBot icon is reused unchanged;
renderer imports that single source rather than introducing a divergent duplicate. Existing Electron
MIT notices remain in the third-party inventory.

## Verification plan

- Validate plan persistence errors, flow ordering, revisitable settings and native IPC boundaries.
- Render at desktop and compact sizes, check icons, clipping, focus, drag-safe controls and errors.
- Run `npm run check`. Check the real macOS window; report unsupported/unobserved installation
  states without substituting saved intent for completion.
- Update English and Chinese Desktop documentation with actual capabilities and limitations.

## Unresolved questions

- Resolved: native bundled runtime without Docker; OpenAI and Anthropic metadata APIs.
- Remote provisioning, inference execution, Intel testing and signed distribution remain outside
  the currently verified slice; see the bilingual capability document.

## Native Server adapter decision (2026-09-05)

The Owner selected native macOS installation without Docker, OpenAI plus Anthropic, and exactly two
first-run roles: service computer or remote client. Advanced deployments belong in GitHub docs.

- PostgreSQL 17 `initdb`, SCRAM authentication and loopback listen settings are the open-standard/
  upstream executable boundary. Reviewed
  [connection settings](https://www.postgresql.org/docs/17/runtime-config-connection.html) and
  [password authentication](https://www.postgresql.org/docs/17/auth-password.html).
- Selected binary-only `@embedded-postgres/darwin-arm64` and `darwin-x64`
  **17.10.0-beta.17**, upstream commit **c23ad8a026c711c8666c3c2596d0fde643cf378a**.
  npm package contents, `gitHead`, hydration script, bundled libraries and upstream three-OS CI
  were inspected. This is a prerelease packaging adapter for PostgreSQL 17.10; no production
  platform-support claim follows from its inclusion.
- Rejected the `embedded-postgres` wrapper at the same release after reading `dist/index.js`:
  it writes passwords to temporary files with default permissions, accepts unbounded flags,
  installs global exit hooks and lacks bounded lifecycle promises. Open upstream issues
  [#33](https://github.com/leinelissen/embedded-postgres/issues/33),
  [#34](https://github.com/leinelissen/embedded-postgres/issues/34),
  [#35](https://github.com/leinelissen/embedded-postgres/issues/35), and
  [#38](https://github.com/leinelissen/embedded-postgres/issues/38) corroborate the mismatch.
- Zonky's Java adapter requires a JVM absent from Desktop and shares the binary lineage; use the
  platform package rather than adding Java. Docker conflicts with the accepted installation UX.
- Reuse existing Electron **44.2.0** utilityProcess for the existing Server, and synchronous
  safeStorage after app readiness for encrypted local bootstrap secrets. Reviewed official
  [utility-process](https://github.com/electron/electron/blob/v44.2.0/docs/api/utility-process.md),
  [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage), startup issue
  [#51759](https://github.com/electron/electron/issues/51759), and signing caveats.
- Reuse the repository's production lockfile graph traversal for Server staging; preserve its
  Node default. Keep compiled Server, migrations, dependencies and notices together; do not bundle
  the renderer into a privileged process or enable RunAsNode.

The exact local gap is an app-owned, non-root, bounded installation/start/stop transaction: fixed
bundled binaries, private data directory, password input via stdin, SCRAM, loopback-only ephemeral
ports, verified Server readiness, auto-connection/login, and persisted encrypted bootstrap state.
Nothing is downloaded on first launch; missing bundled resources fail visibly. Existing clusters
are retained and never silently reset; invalid state fails closed. Quitting Desktop stops its local
Server; login/reboot service persistence is not implied. No upstream wrapper source is copied.

## Owner model configuration decision (2026-09-05)

- Adopt the published HTTPS model-metadata APIs: OpenAI `GET /v1/models/{model}` and Anthropic
  `GET /v1/models/{model_id}` with `anthropic-version: 2023-06-01`. Official references:
  [OpenAI](https://developers.openai.com/api/reference/resources/models/methods/retrieve) and
  [Anthropic](https://platform.claude.com/docs/en/api/models/retrieve).
- Compare official OpenAI SDK **7.10.0** and Anthropic SDK **0.124.0** (Apache-2.0), versus the existing
  Node **22.22.2**/**Electron 44.2.0** Fetch and crypto APIs. For one non-generating metadata check,
  the standard HTTP API is the first viable option. SDKs would add a second networking/retry layer;
  no SDK implementation is copied. Revisit SDK adoption before adding model inference.
- Use Node's standard AES-256-GCM with a random 96-bit nonce and a 256-bit bootstrap key, existing
  write-file-atomic **8.0.0**, and Zod **4.5.4** strict schemas. Desktop seals the bootstrap key via
  macOS safeStorage; Server receives it only in the child environment. A separately deployed Server
  requires explicit path/key configuration and otherwise reports this feature unavailable.
- Server alone stores/validates model configuration behind existing Owner authentication, CSRF
  origin checks and bounded request parsing. Only the two official HTTPS hosts are allowed; no
  renderer-controlled URL, redirect, automatic retry, transcript upload or inference during setup.
  Metadata responses are size/time bounded and discarded except for a bounded model identifier.
- Persist a default provider/model with an encrypted API key and optimistic revision. Never return
  the key in API responses or diagnostic errors. Save only after metadata validation; stale or
  simultaneous writes reject. This config does not itself add an agent inference/execution loop.

Verification covers authentication/origin checks, stale revisions, wrong keys, missing models,
redirects, malformed/oversized metadata, ciphertext tampering and absence of secrets in summaries.

The binary package does not include `pg_isready`. Readiness therefore reuses the existing
**Postgres.js 3.4.9** (Unlicense) client with an authenticated `select 1`, bounded connection timeout,
and explicit close. It does not infer readiness from an open TCP port. The utility process reports
its actual successful HTTP bind over parent IPC before Desktop sends its bootstrap password.
Initialization uses macOS `/dev/stdin` (PostgreSQL does not treat `-` as stdin), stages in an app-owned
temporary directory, and renames the completed cluster into place. Failed staging never replaces an
existing cluster. Switching to the remote-client role stops the app-owned local services.

Electron 44.2.0 `app.requestSingleInstanceLock` serializes the profile bootstrap across app instances;
second launches focus the existing window. Changing roles clears the stopped local connection in UI.

## Binary notice audit

The binary lineage's `scripts/repack-postgres.sh` was inspected: it repacks EnterpriseDB archives
and omits most documentation. The official `postgresql-17.10-1-osx-binaries.zip` central directory
and license files were read with HTTP byte ranges; pgAdmin is not included in OpenBot. Retained
upstream license texts and exact source/hash inventory live in
`apps/desktop/resources/native-notices`. No executable source is incorporated. Runtime strings
and file names confirm PostgreSQL/OpenSSL/ICU/LZ4/Zstandard/zlib versions. Exact binary/source
correspondence for the other bundled libraries and LGPL source/relinking distribution obligations
remain unresolved public-release gates; the packager produces an unsigned development artifact.

## Observed verification

On macOS arm64: a real PostgreSQL install, Server readiness, private Owner login, persisted
channel across restart and bounded shutdown passed in a temporary profile. Real Electron with
safeStorage/utilityProcess passed service installation → model prompt → workspace → Settings,
with no page errors. Native traffic-light position was read as (20,20). The UI was also checked at
960×640. API tests use fake provider metadata, not a live paid key or inference request.

All workspace test tasks passed sequentially after parallel process-start timeouts in existing
Node helper tests. Packaging produced the unsigned arm64 app and passed ASAR dependency/fuse
inventory checks. The installed user's application and another task's checkout were not changed.

Final `npm run check` passed, including documentation, research policy, release/security checks,
lint, type checking, all workspace tests and production builds. Three pre-existing lint warnings
remain in the Node release workflow tests. Browser-plugin tooling was unavailable; renderer QA
used the available Playwright Electron runtime instead.

## Onboarding documentation reconciliation (2026-09-13)

Reviewed OpenBot `9c39395fae4fc5caa05adce6ff9676cf5c7dae0f` before correcting the bilingual
onboarding page. GitHub queries covered this repository's releases and Electron `v44.2.0`
`safe-storage.md`; the GitHub release API confirms that
[desktop-v0.1.0-alpha.7](https://github.com/yxflc11/openbot/releases/tag/desktop-v0.1.0-alpha.7)
is a published prerelease with macOS arm64 DMG, Windows x64 EXE, manifest and checksums, without
Linux installers. No later release is implied.

The existing [Windows review](windows-desktop-completion.md), Desktop installation documents,
`native-server.ts` and `main.ts` establish local loopback Server support on macOS/Windows,
platform-specific window-close behavior and retained data. The native runtime staging script
and Desktop manifest retain Darwin package `17.10.0-beta.17` / upstream
`c23ad8a026c711c8666c3c2596d0fde643cf378a`; Windows uses the pinned official PostgreSQL 17.11
source build documented in that review. Rechecked the official
[17.11 release notes](https://www.postgresql.org/docs/release/17.11/) and
[Electron 44.2.0 safeStorage platform boundaries](https://github.com/electron/electron/blob/v44.2.0/docs/api/safe-storage.md).
Hosted Windows installation/runtime evidence does not establish manual GUI, SmartScreen or
real-device acceptance; unsigned/unnotarized distribution boundaries remain.

`channel-attachments.ts` and the existing [attachment proxy review](desktop-attachment-proxy.md)
confirm that bounded PDF, image, Office/OpenDocument and media uploads supersede the old text-only
statement. `SkillLibraryScreen.tsx` renders `PluginManagerPanel` above the Skills/Bots tabs; the
panel exposes **Add tool plugin** and Server-owned MCP review/grants. This retains the existing
[MCP review](third-party-mcp-plugins.md), SDK 1.30.0 / `2d889f2b329e46680ec9bdd565de4616c497825a`
and [2025-11-25 transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
No new implementation, dependency, copied source or license notice is introduced. Verify the
focused bilingual diff, documentation links and `npm run check`; no new platform acceptance is claimed.
