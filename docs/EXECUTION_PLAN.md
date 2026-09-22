# Goal-mode execution plan

Current development and acceptance are tracked in [Independent development tracks](DEVELOPMENT_TRACKS.md). Historical milestones below remain as recorded.

[English](EXECUTION_PLAN.md) · [简体中文](EXECUTION_PLAN.zh-CN.md)

## Objective

Deliver the next OpenBot foundation in a dependency-safe order: prove the current security baseline,
establish repeatable Windows/macOS/Linux evidence, ship native Worker Hosts with protected local
credentials, replace copyable Node identity, then add executable skills, governed memory and
distribution, and finally real desktop control.

The Server remains the only authority for Employee identity, authorization, routing, approvals, and
audit. Worker Hosts, Providers, models, webpages, imported skills, and messages remain untrusted.
The office visualization remains a deferred optional plugin.

## Native Agent loop — current delivery objective

The immediate user goal is a working native Agent, not only orchestration infrastructure. Before
expanding executable skills or desktop authority, deliver the Server-owned cycle:

```text
channel task -> claim Run -> model plans/selects tool -> Server checks scope
                              ^                          |
                              +---- bounded observation <- read-only tool
                              |
                         final Bot reply / explicit failure
```

| ID | Status | Deliverable | Exit gate |
| --- | --- | --- | --- |
| A0 | Implemented and locally verified | Reuse the pinned released Agent SDK and existing OpenAI/Anthropic settings | [Research](research/native-agent-loop.md), exact dependencies/licenses, Owner opt-in and no historical task replay |
| A1 | Implemented and locally verified | Real model/tool/observation iteration with current-channel read tools | Real SDK multi-step HTTP fixtures; strict tool scope; step/time/token/output limits; no raw reasoning or secrets in progress |
| A2 | Implemented and locally verified | Durable Run lifecycle and visible Bot results | Atomic claim/completion, same-channel serialization, restart interruption, settings-change/shutdown abort and PostgreSQL tests |
| A3 | Implemented; hosted CI required before merge | Deliver through shared Desktop/Web and GitHub | UI opt-in, bilingual docs, full check and Windows/macOS/Linux package CI; live paid-provider evidence explicitly distinguished from hermetic tests |

The initial loop serves `none` computer-profile Bots. Existing Worker execution remains separate;
this goal does not authorize new desktop writes, memory retrieval, executable skills or external
Agent delegation. The trust/distribution waves below continue with their existing acceptance gates.

## Why the order matters

```text
secure baseline
      |
      v
hosted CI matrix --> repeatable real-device evidence
      |                         |
      +------------+------------+
                   v
       native hosts + OS keyrings
                   |
                   v
       proof-of-possession Node identity
                   |
          +--------+--------+
          v                 v
 safe executable skills   governed memory
          +--------+--------+
                   v
        registry and ownership transfer
                   |
                   v
      real input and desktop takeover
```

Later stages carry more authority and a larger blast radius. They cannot use documentation claims,
simulated fixtures, or capability declarations as substitutes for the evidence gates below.

## Status legend

- **Complete:** implemented and verified at the stated evidence level.
- **Active:** the current bounded implementation slice.
- **Blocked:** requires named user authority or external infrastructure.
- **Planned:** ordered but not started.
- **Deferred:** intentionally excluded from this goal.

## Execution waves

### Wave A — establish trustworthy feedback

| ID | Status | Slice | Why now | Deliverable and benefit | Exit gate |
| --- | --- | --- | --- | --- | --- |
| G0 | Complete at hosted-PR evidence level | Publish and observe the hardened baseline | Local success does not prove a clean GitHub runner can install, build, test, and scan the branch. | A remote, reviewable security baseline. Later failures can be attributed to new work instead of an unknown starting state. | The focused baseline PR ran its full remote suite successfully. It remains an Owner-reviewed, unmerged checkpoint and does not authorize release. |
| G1 | Complete at hosted-CI evidence level | Windows/macOS/Linux hosted CI matrix | Cross-platform implementation without cross-platform feedback accumulates path, shell, permission, and runtime regressions. | Every portable protocol, Node, Provider SDK, config, and Web change is checked on explicit runner families. | Pinned runner families and Node version plus deterministic portable and Desktop-package jobs passed on the three explicit hosted OSes. This is not real-device support. |
| G2 | Active locally; real-device suites and evidence pending | Provider conformance runner and real-device evidence contract | Hosted VMs cannot prove service recovery, keyring access, GUI permissions, hardware isolation, or desktop behavior. | One repeatable scenario runner and bounded evidence format that makes platform claims reproducible instead of anecdotal. | Hermetic negative fixtures; expiring target-bound reports; no secrets in artifacts; named OS/version/architecture/hardware for real-device reports; no self-certification. |

### Wave B — make Worker Hosts installable and trustworthy

Each platform slice includes its system credential store. This avoids shipping a service that asks
operators to leave long-lived secrets in ordinary configuration files. The common credential-store
interface must also be able to hold a future proof-of-possession private key.

| ID | Status | Slice | Why this order | Deliverable and benefit | Exit gate |
| --- | --- | --- | --- | --- | --- |
| G3 | Active locally; archive, dormant provenance workflow, native smoke, and install-transaction design implemented | Linux Worker Host, installer, systemd, Secret Service | Linux has the simplest daemon and packaging path, so it establishes the shared lifecycle with the least platform-specific surface. | Signed archive first, then deb/rpm; dedicated service account; predictable install/start/stop/upgrade/rollback; protected credentials. This becomes the reference host implementation. | Tested systemd lifecycle and recovery; x64/arm64 evidence; permissions and keyring failure close safely; no inbound public control port. |
| G4 | Windows host and build gate implemented locally; hosted and native evidence pending | Windows Worker Host, installer, Service, Credential Manager | Windows service identity, ACLs, installers, and session isolation differ substantially; the shared lifecycle should exist before solving those differences. | A signed installer and recoverable Windows Service with credentials outside plain files. Enterprise deployment and uninstall become auditable. | Real Windows x64 evidence first; ARM64 remains unclaimed until tested; service-account ACL tests; install/upgrade/uninstall/rollback; Credential Manager denial fails closed. |
| G5 | Source-complete locally, including Desktop-guided setup; hosted nested-package and controlled-device gates pending | macOS Worker Host, Desktop companion, installer, launchd, Keychain | macOS can reuse the host protocol but adds signing, notarization, Keychain access groups, launchd, and privacy permissions. | A signed/notarized package and launchd service with Keychain-backed credentials, one-install Desktop guidance, and truthful permission diagnostics. | Native core, dual-mode app/Host, Keychain transaction, LaunchAgent registration, strict Desktop control protocol, exact candidate, nested-package gate, package/signing/notary gates, Swift tests, and local arm64 compile/link evidence are implemented. Hosted nested packaging, Developer ID profiles, notarization, install lifecycle, locked-Keychain, and declared real-device evidence remain required. |
| G6 | Planned | Node proof of possession, mTLS, rotation, revocation, and replay defense | Native services increase the value of a stolen bearer token. Real input must not be enabled while a copied credential can impersonate a Worker Host. | A Node proves possession of its device key, connections authenticate both directions, credentials rotate, compromised Nodes can be revoked, and captured messages cannot be replayed. | Preserve one-time enrollment; non-exportable-key adapter where the OS permits; bounded challenge/response; short-lived credentials; rotation and overlap rules; replay tests; Server-owned audit; fail-closed clock/storage/network behavior. |

### Wave C — expand Employee capability without importing authority

| ID | Status | Slice | Why now | Deliverable and benefit | Exit gate |
| --- | --- | --- | --- | --- | --- |
| G7 | Planned | Executable Agent Skills quarantine and sandboxed installation | A Skill is untrusted code, not descriptive metadata. It is unsafe to distribute or learn executable skills before inspection and containment exist. | Full archive inventory and file diff, provenance/license/signature checks, malicious-content findings, isolated validation, explicit grants, rollback, and audit. Users can extend Employees without silently installing arbitrary code. | Path traversal, symlink, expansion, executable-content, dependency, validator, scanner, and sandbox failures all close safely; no inspection runs in the Server process; activation remains a separate Owner action. |
| G8 | Planned | Memory retrieval, retention, and employee skill proposals | Automatic retrieval and proposals widen data access and autonomous behavior. They require the established review and sandbox boundaries. | Relevant memory can be retrieved with visible provenance; retention and deletion are enforceable; Employees can propose—but cannot self-approve—new Skills. This reduces repeated setup without surrendering Owner control. | Prompt-injection tests; scoped retrieval; expiry/deletion jobs; version restoration; content-free audit; proposals expire/supersede and require Owner review; Hermes Agent inspiration remains attributed. |
| G9 | Planned | Employee registry, public distribution, selective clone, ownership transfer | Distribution multiplies any package or authority mistake across people and machines, so it follows safe packages, skills, memory policy, and Node identity. | Versioned discovery and updates, publisher trust/revocation, selective data copying, and authenticated two-party transfer receipts. Teams can reuse Employees without copying machine authority or all private memory. | Server-authoritative registry records; signed immutable package versions; rollback/revocation; destination creates fresh local bindings; transfer cannot leave both owners with the same authority; explicit privacy review. |

### Wave D — enable high-impact computer control

| ID | Status | Slice | Why last | Deliverable and benefit | Exit gate |
| --- | --- | --- | --- | --- | --- |
| G10 | Planned | Continuous desktop view, exclusive takeover, and real write/click Providers | This is the highest-impact capability: it can disclose screens and change external systems. It needs every earlier identity, policy, audit, packaging, and evidence boundary. | Bounded frame transport, short-lived view access, mutually exclusive human/Agent control, emergency stop, and narrow Windows/macOS/Linux Providers using prepare/approve/commit. OpenBot can finally operate software without APIs while the Owner retains control. | Target fingerprint is rechecked at commit; single-use capability lease; no input before approval; redirects/window changes fail safely; one controller at a time; immediate revoke/stop; bounded artifacts; real-device conformance per Provider and OS. |
| G11 | Deferred | Office visualization plugin | It improves presentation, not the security or execution foundation, and building it now would consume effort while its underlying Employee/Run models are still evolving. | Deferral reduces rework and keeps the core independently usable. | Reconsider only under a separately requested milestone after G10's core workflow is mature. |

## Per-slice execution contract

Every non-trivial slice follows the same sequence:

1. Define one observable acceptance journey and its authority/data/side-effect boundary.
2. Search GitHub plus official standards and primary platform documentation.
3. Compare maintained candidates, releases, tests, issues, platform fit, security boundary, and
   license; pin the reviewed release or commit.
4. Complete or add the `docs/OPEN_SOURCE_REUSE.md` entry and a research record before behavior or
   dependency changes.
5. Implement the smallest fail-closed vertical slice with bounded inputs and outputs.
6. Add positive, negative, concurrency/lifecycle, and failure-path tests appropriate to the risk.
7. Update canonical English documentation and matching Simplified Chinese user-visible documents.
8. Run focused tests and `npm run check`; run database, packaging, security, or real-device gates
   when the slice touches them.
9. Create one focused commit. A completed slice is a checkpoint, not permission to skip the next
   dependency.

## Evidence and claim rules

- A simulated fixture proves only the protocol contract.
- A hosted CI runner proves only portable build/test compatibility on that runner image.
- A hermetic integration proves only the named Provider and environment.
- A real-device report must name the target, OS version, architecture, hardware, Provider version,
  scenario version, time, and reproducible evidence.
- `Supported` and `Certified` labels require maintainer-reviewed real-device and security evidence.
- Missing credentials, permissions, signatures, scanners, keyrings, clocks, stores, or policy data
  fail closed; they never silently downgrade authority.

## Current checkpoint

- The DEV-001 security baseline is complete at the hosted-PR evidence level: Server-owned approval
  policy, durable throttles, dependency/history scanning, redacted structured logs, safe failures,
  dispatch audit, and Web interaction tests passed locally and in the focused remote suite.
- The work remains in focused stacked review branches ahead of `origin/main`; a green PR is an Owner
  checkpoint, not permission to merge or release.
- The current Desktop onboarding work implements the four documented compositions, a bounded
  Worker-computer checklist, strict public-intent persistence, and restart recovery. The next local
  slice now adds Desktop-guided macOS Worker setup: only the authenticated main process can issue a
  short-lived enrollment token, the renderer sends only a bounded Node id, and the fixed Swift
  companion reports actual Keychain and `SMAppService` state. Local Desktop and Web suites pass
  with 120 and 54 tests. The unsigned Desktop package, including a locally built fixed companion,
  passes its nested inventory gate and launches after the V8-snapshot regression fix. Hosted nested
  packaging, signed distribution, and controlled-device service evidence remain pending; no macOS
  support claim is permitted yet.
- G1's explicit Linux x64, Windows x64, and macOS arm64 jobs have all been observed successfully,
  including the unsigned Desktop development-package matrix. This proves only compatibility with
  those hosted runner images, not installation or operation on user devices.
- G2's strict scenario runner and real-device report contract are implemented locally. Tests cover
  deterministic lifecycle order, abort deadlines, cleanup failures, untrusted-result rejection,
  secret suppression, expected-failure expiry, required device metadata, and non-overwriting private
  evidence files. Provider-specific suites and controlled real-device reports remain outstanding.
- G3 now implements the two explicit systemd profiles and the bounded Linux Secret Service adapter.
  Tests cover exact non-fallback selection, helper stdin, timeout/output limits, missing/error
  outcomes, wrong identities, write verification, and unit hardening. The first archive slice now
  stages a clean-source, unsigned x64/arm64 candidate with a hash-pinned Node runtime, allowlisted
  ncc output, production-only SPDX SBOM, canonical manifest, and checksums. Its Ubuntu 24.04 packer
  revalidates the candidate, pins GNU tar/XZ behavior, records package revisions, refuses overwrite,
  and emits an unsigned deterministic archive plus sidecars. Two emulated Ubuntu 24.04 amd64 builds
  were byte-identical and passed SHA-256/XZ integrity checks; this is packaging evidence, not a real
  host support claim. A tag-only workflow is now locally implemented with exact action pins, least
  privilege, main-ancestry/SemVer gates, two-build comparison, build and SBOM attestations, and
  direct temporary review uploads. It has not run remotely and cannot create a GitHub Release.
  The matrix now assigns x64 and arm64 to matching hosted CPU runners and requires the packaged Node
  plus application to complete a schema-valid least-authority loopback handshake before attestation.
  The x64 path passed under local Ubuntu container emulation; both native hosted jobs remain
  unobserved. A rootless install transaction core now binds the accepted provenance result, stages
  immutable versions, atomically switches `current`, restores the prior active version on failure,
  and retains a recovery journal if rollback also fails. Its explicit recovery operation validates
  canonical private state and both release directories, restores only the recorded previous target,
  rechecks only a previously active service, and preserves failed-retry evidence. Its fourteen tests
  pass on real temporary filesystem state. One opaque fail-closed directory lease can now span a
  future bootstrap and activation without automatic stale takeover. A private-import adapter now
  copies the untrusted archive once through an opened handle into an exclusive `0600` file, binds
  cleanup to its digest and the same lease, and rejects path/source changes before provenance. Its
  four real-byte tests pass. A fixed privileged-layout validator now requires effective root,
  root-owned ancestry that ordinary users cannot write, exact child modes, and the required
  same-filesystem relationships. Its fail-closed initializer checks every ancestor before writing,
  creates only fixed children non-recursively, normalizes new directories through no-follow opened
  handles, and never changes unsafe existing paths; eight policy/provisioning tests pass. A dormant
  wrapper now composes preflight,
  import, provenance, extraction, activation, cleanup, and recovery under the fixed layout and one
  lease; four order/fail-closed tests pass. Its strict two-operation command derives architecture and
  ids, rejects unknown/duplicate input, excludes credentials from argv, and emits only allowlisted
  success or generic failure records; five contract tests pass. A bounded verifier adapter now
  requires the exact
  `gh 2.93.0` binary contract,
  certificate identity, tag, source commit, GitHub issuer, hosted runner, one matching statement,
  and stable archive digest; seven fail-closed tests pass. A safe-extraction adapter adds strict
  inventory, stream, private-root, tree, and final digest gates; six tests and a corrected real
  extraction of the existing x64 archive in the pinned Ubuntu container pass. It is not a privileged
  installer. Authorized provenance observation, trusted bootstrap distribution, and real x64/arm64
  operator-command/privileged-layout/systemd plus
  locked/unlocked keyring evidence remain in progress under ADR-0033 and ADR-0034. The system-profile
  adapter itself now has three fail-closed command/state tests but no native systemd evidence.
- G4 service research now selects the first-party .NET `10.0.11` Windows Service lifetime for a
  self-contained x64 host and rejects WinSW plus `node-windows` at the privileged boundary. The
  first prototype must run as LocalService, launch only a fixed verified release, drain then bound
  the child process tree, and fail closed on identity, ACL, release, or credential uncertainty.
  Redirected child standard input is the exact bounded lifecycle channel, and a pinned maintained
  Job Object package supplies forced process-tree containment. Implementation review found that
  post-start Job assignment otherwise leaves a scheduling window, so `stdio-v2` now keeps the Node
  inert until the service assigns it and sends `START`, then accepts only `SHUTDOWN`. Four parser
  tests prove ordered fragmented frames and fail-closed malformed, out-of-order, excessive, EOF,
  and detach behavior; two client lifecycle tests prove that repeated stop waits for Provider
  cleanup and identity loading. The Node/config suites pass with 30/10 tests.
- G4 now includes the experimental .NET host and locked build gate. The exact SDK restored the
  checked-in graph, built with zero warnings, passed six pure supervision contracts, and
  cross-published one 76,277,833-byte `win-x64` PE plus the matching third-party notice. CI pins
  `actions/setup-dotnet` `v5.3.0` by full commit, rejects unlocked dependency or artifact-shape
  drift, and uploads nothing. The current macOS host has no PowerShell or Windows SCM, so the hosted
  job, real Job Object/SCM lifecycle, installer, ACL, and support evidence are still pending.
- G4 installer research selects Windows Installer 5.0 standard transactions so file, service,
  repair, upgrade, and rollback state remain operating-system managed. It prohibits custom actions,
  downloads, credential properties, mutable install paths, and auto-start before enrollment. WiX
  `v7.0.0` is the first viable technical authoring candidate, but its OSMF EULA/fee decision requires
  separate Owner authorization; no tool or MSI has been added.
- G5 service research selects a macOS 13+ user-approved `SMAppService` LaunchAgent for the dedicated
  standard account and rejects a root daemon plus third-party supervisors. The first static plist
  now fixes one app-relative launcher, unsuccessful-exit restart, a 30-second retry throttle,
  background resource class, 25-second stop bound, and private umask without credentials or mutable
  arguments. Four fail-closed contract tests and local native `plutil` validation pass; the hosted
  macOS lane will rerun both after an authorized push. The launcher, registration app, package,
  Keychain, native lifecycle, signing, and notarization remain pending, so no service or platform
  support is claimed.
- G5 configuration and Keychain research selects direct Apple Security plus the existing Node core
  and Zod. It supersedes the immediate-`exec` clause: a signed native Host must keep the credential
  inside the data-protection Keychain, hand one bounded identity to an inert fixed Node through
  private child stdin, and supervise the whole process group. General Keychain/config wrappers,
  `/usr/bin/security`, exported environment/argv values, and file fallbacks are rejected. This is an
  accepted design. The strict fixed-file loader and one-shot `stdio-v3` identity gate are now
  implemented with 37 focused passing tests; native Host source, entitlement, registration, and
  real Keychain evidence remain pending.
- G0 is externally gated: pushing requires explicit Owner authorization. PR creation, merge,
  release, and repository-setting changes are separate actions and are not authorized.
- While G0 awaits that decision, repository-local planning, research, and verification may continue;
  no hosted-matrix or platform-support claim may be made until the corresponding remote evidence is
  observed.
