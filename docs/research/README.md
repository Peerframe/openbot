# Feature research records

[English](README.md) · [简体中文](README.zh-CN.md)

Follow [root research triggers](../../AGENTS.md#research-before-implementation): new dependencies or
versions, public protocols, authorization/security or persistent-data boundaries, and material
architecture choices need targeted evidence. Ordinary fixes and wiring cite the existing decision,
reviewed pins, unchanged assumptions and affected tests in the PR/handoff; do not create a new report.
Complete only missing evidence relevant to the touched choice. No broad survey is required again.

Use [the template](TEMPLATE.md) only for a triggered new/reopened decision when an existing issue or
ADR is not a better home. Keep one observable acceptance journey, compare viable maintained choices
by fit, license and total delivery/maintenance cost, and pin the reviewed release/commit. An existing
record may be amended with the changed assumption; a boundary change still needs targeted review.
An issue can hold equivalent durable evidence. Use an ADR for a long-lived contract or architecture.
No candidate fitting the requirement means recording the actual queries/candidates and precise gap,
not dropping attribution/license review. [PR evidence paths](../../CONTRIBUTING.md#research-evidence-and-documentation-exemptions)
retain the seven-field form, existing-decision reuse and the narrow unchanged-prose exemption.

Accepted records include [Owner-managed Employee memory](owner-managed-employee-memory.md), which
attributes the evolution/memory direction to Hermes and compares Letta, Mem0, and LangMem before
selecting the existing OpenBot PostgreSQL boundary, and
[Employee profile realtime invalidation](employee-profile-realtime-invalidation.md), which reuses
the current Hono SSE transport while keeping profile content behind authenticated REST. The
[Owner skill review surface](owner-skill-review-surface.md) then maps the already-authoritative
skill lifecycle into an inspectable profile workflow without installing executable code. The
[Employee evolution archive](employee-evolution-archive.md) explicitly credits Hermes and adapts
its truthful dated-journey interaction to OpenBot's append-only Server records. The
[Owner-managed Employee profile details](owner-employee-profile-details.md) review then reuses the
existing revision mutation path and Hermes/Kubernetes conflict semantics for descriptive fields.
The [Portable Employee profile review](portable-employee-profile-review.md) closes the matching
transfer-safety gap by showing that biography inside the existing digest-bound quarantine before
activation.
The [Portable Employee skill disclosure](portable-employee-skill-disclosure.md) then applies the
Agent Skills and OpenClaw review boundary so descriptions and dependencies are visible while every
imported skill remains disabled.
The [Employee export content preview](employee-export-content-preview.md) applies the corresponding
sender-side rule: the exact profile and selected skill metadata are visible before download.
The [Portable Employee skill dependency closure](portable-employee-skill-dependency-closure.md)
then prevents that package from silently dropping a dependency outside the verified export set.
The [Employee export review binding](employee-export-review-binding.md) finally applies HTTP strong
validators so download can serve only the exact package instance the Owner just inspected.
The [Cross-platform Employee export filename](cross-platform-employee-export-filenames.md) review
then applies RFC 6266 and a focused maintained device-name predicate so the advisory download name
remains safe and usable across Windows, macOS, and Linux.
The [POSIX Node credential permission](posix-node-credential-permissions.md) audit then applies
OpenSSH's fail-closed private-key invariant to the existing atomic file adapter, while explicitly
leaving Windows ACLs and native keyrings outside the claim.
The [Artifact read integrity](artifact-read-integrity.md) audit applies OCI descriptor verification
to the already-stored size and SHA-256 so changed screenshot bytes fail before delivery.
The proposed [Cross-platform Node CI baseline](cross-platform-node-ci.md) records explicit hosted
runner families and the evidence boundary before a Windows/macOS/Linux matrix is introduced.
The accepted [Provider conformance scenario runner](provider-conformance-runner.md) then compares
MCP, OCI, Sonobuoy, and the existing Vitest/Provider SDK boundary before adding bounded orchestration
outside the authoritative Server process.
The accepted [Linux Worker Host service and Secret Service](linux-worker-host-service-and-secret-service.md)
review separates headless system service credentials from login-session Secret Service, selecting
a bounded `secret-tool` adapter without a silent backend fallback.
The accepted [Linux Worker Host verifiable archive](linux-worker-host-archive.md) review then fixes
the application bundler, official Node runtime hashes, production SBOM, deterministic manifest,
checksums, and authorized release-provenance boundary before installation scripts are added.
The accepted [Linux Worker Host recoverable install transaction](linux-worker-host-install-transaction.md)
review now fixes the versioned layout, provenance gate, atomic activation, health-bound rollback,
credential separation, and crash-recovery evidence before a privileged installer is exposed.
The accepted [Linux Worker Host privileged bootstrap boundary](linux-worker-host-privileged-bootstrap.md)
then selects a private archive import and one fail-closed shared lease so user-writable path swaps
cannot separate the bytes proved from the bytes extracted or activated.
The accepted [Windows Worker Host service boundary](windows-worker-host-service.md) next selects the
first-party .NET Service lifetime over generic WinSW and `node-windows` wrappers, while keeping
LocalService identity, fixed-child supervision, and native x64 evidence as explicit fail-closed
gates.
The implemented-local [Windows Worker Host build lane](windows-worker-host-build-lane.md) pins the
first-party setup action, exact .NET 10 SDK, locked NuGet restore, explicit Windows x64 runner, and
non-uploading artifact-shape gate around the experimental host source. Hosted and native Windows
execution remain required before any support claim.
The accepted-platform [Windows Worker Host installer](windows-worker-host-installer.md) review then
selects Windows Installer 5.0 standard transactions and prohibits credentials, downloads, custom
actions, mutable paths, or pre-enrollment auto-start. WiX v7 is technically viable but remains
unused until the Owner explicitly decides its OSMF EULA and any fee obligation.
The accepted [macOS Worker Host launchd boundary](macos-worker-host-launchd.md) next selects a
user-approved macOS 13+ `SMAppService` LaunchAgent for the dedicated standard account. A narrow
app-relative native Host remains responsible for Keychain and child containment. The follow-on
[macOS Worker Host configuration and Keychain](macos-worker-host-config-and-keychain.md) review
selects direct Apple Security plus existing Node core/Zod, and replaces immediate `exec` with a
private credential handoff and bounded fixed-child supervisor. The accepted
[macOS registration and package](macos-worker-host-package-and-registration.md) review then keeps
enrollment/registration user-scoped, binds each identity to its exact Server, and selects an
app-only Apple package with fail-closed Developer ID and notarization gates. TCC and real-device
evidence remain separate gates.

The accepted [Desktop application foundation](desktop-application-foundation.md) review selects
Electron with direct stable Packager/Fuses adapters for one installable TypeScript/React/Vite
Client, retains Web as a full Client, keeps Server as the only authority, and limits Swift and C#
to narrow platform adapters. Stable Forge 7 is rejected after implementation validation exposed its
Fuses incompatibility and unresolved development advisories; signing, updates, and real-device
support remain later gates.
The accepted [Desktop local content protocol](desktop-local-content-protocol.md) follow-on applies
Electron's custom-protocol guidance to a dedicated session and an exact packaged-resource
allowlist, keeping `file://` extra privileges disabled and rejecting traversal before file access.
The implemented [Desktop Server connection](desktop-server-connection.md) review then keeps that
local Client same-origin while a bounded main-process adapter uses Electron's dedicated Session to
reach one verified Server. It persists only the confirmed public origin, retains HttpOnly cookies
outside preload, rejects opaque origins, redirects, excess bodies, and remote executable UI, and
validates the exact runtime dependency closure after ASAR packaging.
The accepted [Desktop setup intent](desktop-setup-plan.md) review next uses existing React, native
form semantics, typed Electron IPC, and restricted atomic JSON persistence for the four documented
compositions and a bounded planned Worker count. It rejects additional state/form dependencies and
keeps the plan distinct from installation, enrollment, authorization, service status, and support.
The accepted [Desktop-guided macOS Worker onboarding](desktop-macos-worker-onboarding.md) review
then reuses the already reviewed Swift Worker Host as one independently signed nested companion.
Desktop requests a short-lived token only in its authenticated main process, passes it through one
bounded private stdin request, and projects actual native registration state without exposing the
token, a process bridge, or a persisted success flag to the renderer.

The [Server Windows secret ACL](server-windows-secret-acl.md) note extracts the Node Owner+SYSTEM helper into `@openbot/windows-secret-acl` for model-settings and plugin-store (DEV-005 / N2).
The [Windows native ACL test timeout budget](windows-native-acl-test-budget.md) then bounds the hosted native suite (Server ≤9 PowerShell spawns × 15s + margin → 180s; Node credential native negatives ≤7 × 15s + margin → 120s) and mirrors production `broadenAcl` spawn hygiene, without mocking ACL or changing production spawn timeouts.
