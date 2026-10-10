# Technology baseline

Reviewed on 2026-09-28 against this checkout's lockfiles and manifests. Exact versions are review
snapshots and must be updated through a focused, tested dependency change rather than silently
floated. For live layout and setup, prefer [the repository map](REPOSITORY_MAP.md),
[CONTRIBUTING](../CONTRIBUTING.md), and the linked surface READMEs over restating install or
platform status here.

## One-sentence decision

OpenBot uses Python for the product Server control plane and the bounded Agent harness, TypeScript
for Web, the Electron Desktop shell, retained Node helpers, React and
Vite for the shared interface, PostgreSQL for authoritative state, and narrow Swift or C# adapters
only where the operating system requires them.

## Current stack vs historical decisions

| Concern | Current product default | Notes |
| --- | --- | --- |
| Business Server | TypeScript in `apps/server` (Fastify) | Single trusted product authority. |
| Agent execution | TypeScript Server runtime and `packages/work` | Control retains authority and durable facts. |
| Shared UI | TypeScript, React, Vite in `apps/web` | Also the Desktop renderer. |
| Desktop shell | Electron main/preload around the shared Web UI | Supervises the Python product payload where that Desktop path is supported. |
| Retained Node surfaces | Node Worker Host, Providers, protocol helpers, tooling | Not a second business Server. |
| Frozen TypeScript Server | `tests/oracles/legacy-server` | Comparison input only; never a product fallback. |
| Persistence | PostgreSQL with migrations under `packages/db` | Unchanged authority for durable state. |
| Optional durable Work engine | Explicit Temporal composition when configured | Not created by ordinary API startup. |

Historical Desktop foundation ADRs and research remain the record of those decisions; they are not
a claim that the Node/Hono Server is still the live control plane. Longer-term TypeScript consolidation remains a
direction, starting with useful peripheral replacements. A core replacement needs its own verified
cutover; this cleanup does not migrate the Python Server or harness core.

## Product surfaces

| Surface | What the user installs or opens | Role |
| --- | --- | --- |
| OpenBot Desktop | The same OpenBot product, installed from the package for each Windows, macOS, or Linux platform | Always a Client; may also configure this computer as a Server, Worker Host, or both where supported |
| OpenBot Web | The Server-hosted responsive web application | A full remote Client and the primary Client for modular self-hosters who do not install Desktop |
| OpenBot Server | A service installed by Desktop onboarding or deployed independently | The only authority for identity, channels, routing, policy, approvals, audit, and durable state |
| OpenBot Worker Host | A service installed by Desktop onboarding or deployed independently | Supplies declared computer capabilities to the Server; it never becomes a second authority |
| Agent adapters | Server-managed connections to OpenBot, Hermes, Pi, OpenClaw, or later agents | Perform bounded delegated work; they cannot grant themselves a channel, computer, credential, or approval |
| Plugins | Server-managed MCP connections with explicit grants | Current tools, resources, prompts and isolated Apps follow [PLUGINS](PLUGINS.md); future extension directions are not current capabilities |

Desktop onboarding still presents four compositions of the same product (Client only; Client plus
Worker Host; Client plus Server with Worker Host optional; advanced self-host). Checklist bounds,
Server origin confirmation, and native Worker enrollment details live in the current Desktop docs
rather than this baseline: start from [Desktop contributor rules](../apps/desktop/AGENTS.md),
[Desktop installation](DESKTOP_INSTALLATION.md), and [Desktop onboarding](DESKTOP_ONBOARDING.md).

## Selected languages and runtimes

Versions below match this checkout unless a surface README states a narrower attested release.

| Boundary | Selection | Why |
| --- | --- | --- |
| Product Server / control plane | TypeScript / Fastify (`apps/server`) | Owner identity, routing, policy, approvals, audit and product HTTP. |
| Bounded Agent execution | `apps/server/src/work-runtime.ts`, `packages/work` | Bounded execution and Temporal continuation; control retains authority. |
| Shared domain, protocol, Web, Desktop, Node helpers, and tooling | TypeScript `7.0.2` | Typed contribution path for UI, Electron, retained Node wire, and repository tooling. |
| Standalone JavaScript development runtime | Node.js `24.20.0` (pinned in `.nvmrc`; root `engines` also allow the attested `^22.22.2` line) | Current repository development baseline. Attested Worker Host release runtimes upgrade only through a separate release migration with hashes, SBOMs, and rollback evidence. |
| Desktop shell | Electron `44.3.0` | Reuses the Web stack and ships one tested Chromium/Node baseline across desktop systems. |
| Desktop packaging and hardening | `@electron/packager` `20.3.0` and `@electron/fuses` `2.1.3` | Narrow package/ASAR and strict fuse APIs without Forge 7's incompatible development graph. Installers, signing, and publishing remain separately reviewed release adapters. |
| Desktop Server transport and configuration | Electron `44.3.0` custom protocol, dedicated `Session.fetch`, typed IPC, `write-file-atomic` `8.0.0`, and `@electron/asar` `4.3.0` for build-time inventory validation | Packaged renderer stays same-origin; main process connects only to one verified Server. Archive carries the reviewed runtime dependency closure. |
| Shared UI | React `19.3.0` and Vite `8.3.0` | Locked, built, and tested in `apps/web` for Web and the Desktop renderer. |
| Authoritative persistence | PostgreSQL 17 | Migrations, conditional transitions, scheduling, approvals, and audit need one transactional source of truth. |
| macOS-only service integration | Swift | Keychain, Service Management, signing-aware registration, and other Apple-only contracts. |
| Windows-only service integration | C# on .NET | SCM, Credential Manager, Job Objects, installer integration, and other Windows-only contracts. |
| External agent internals | Upstream language | Hermes may remain Python and another agent may use Rust, Go, or TypeScript; OpenBot integrates through a typed process or network adapter. |

Rust and Go are not OpenBot product core languages. Python is core for Server and harness. TypeScript
remains core for Web, Desktop, and retained Node helpers. A future dependency in another language
needs research that proves a maintained upstream closes a concrete gap better than the selected
stack.

Retired Node/Hono Server implementation details stay in the frozen oracle and historical research;
do not treat them as the live Server HTTP runtime.

## Desktop security contract

The Desktop application is a trusted local client, not a replacement authority:

- it packages local renderer assets instead of loading executable UI code from a Server;
- every renderer uses `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`;
- the preload bridge exposes small typed operations, never raw `ipcRenderer`, filesystem, shell,
  process, environment, or unrestricted network primitives;
- the main process validates the sender, schema, size, state, and authority for every IPC request;
- navigation, new windows, permissions, downloads, and external URL opening deny by default;
- a restrictive Content Security Policy permits renderer connections only to the packaged
  application origin; the main process separately enforces the one declared Server connection;
- Server, Worker Host, external Agent, and plugin actions remain subject to Server policy and
  approval even when Desktop starts their local processes;
- secrets stay in the platform key store or a dedicated service boundary, never renderer state or
  browser local storage;
- local Worker setup preflights actual native state before token issuance, never persists an
  `enabled` flag, and treats macOS approval as incomplete until `SMAppService` reports enabled;
- packaging disables unused Electron fuses, verifies ASAR integrity, and signs before release;
- unsigned local builds are development evidence only and cannot be described as distributable.

Untrusted webpages used by an Agent run inside a Worker Provider boundary. They are never rendered
inside the privileged OpenBot Desktop window.

## “Best current” policy

“Best” means the newest stable or LTS release that satisfies OpenBot's compatibility, security,
maintenance, contributor, and evidence requirements. It does not mean automatically selecting a
prerelease or changing every dependency on publication day.

- Check Node.js LTS and supported Electron majors at least monthly and before every Desktop release.
- Apply supported-line Electron security patches through an expedited, tested pull request.
- Review a new Electron major before the current major becomes the oldest supported line.
- Keep every dependency exact in the lockfile; no release build may resolve a floating version.
- Re-run packaging, IPC-negative, update, rollback, and real-device checks after a runtime change.
- Reconsider the shell only if measured package size, memory, accessibility, security maintenance,
  or platform behavior fails an accepted requirement.
- Runtime pin changes require focused PRs, lockfile evidence and the affected product checks.

## Contributor impact

Contributors need the repository Node.js/npm versions and the services described in
[CONTRIBUTING](../CONTRIBUTING.md) and [Server setup](../apps/server/README.md). Desktop work also needs the
platform packaging toolchain; see [Desktop contributor rules](../apps/desktop/AGENTS.md). Swift is
required only for macOS adapter work, and .NET only for Windows adapter work. External Agent
adapters do not require contributors to rewrite those agents in TypeScript.

The durable Desktop foundation decision and candidate evidence remain in
[ADR-0041](decisions/0041-desktop-application-foundation.md) and the
[Desktop foundation research](research/desktop-application-foundation.md). The implemented Server
connection boundary is recorded in [ADR-0042](decisions/0042-desktop-server-connection.md) and its
[research evidence](research/desktop-server-connection.md). The four-mode setup intent and its
no-side-effect boundary are recorded in [ADR-0043](decisions/0043-desktop-setup-intent.md) and the
[setup-plan research](research/desktop-setup-plan.md).
The macOS effectful follow-on is recorded in
[ADR-0044](decisions/0044-desktop-macos-worker-onboarding.md) and the
[Desktop-guided Worker research](research/desktop-macos-worker-onboarding.md).
