# Read-only browser VPS review

2026-09-25. No repository writes, dependency installs, VPS connection, browser or service launch. Current candidate has parent482bdc5; SOURCE-SHA256SUMS identifies the inspected uncommitted files. Existing OPEN_SOURCE_REUSE rows and linux-execution-boundary / linux-vps-qualification / controlled-browser-click / python-browser-sessions are the primary local decision records. No new runtime/protocol is selected.

Retain these reviewed pins: agent-computer257c1280d684089be9adb0b35cce262efc7064bf (MIT), Playwright1.62.1 (Apache-2.0), Bun1.4.2 (MIT), Moby29.8.1/464cd50c3d9e92877d56940ea160de6fca7bea23 (Apache-2.0), containerd2.3.5 (Apache-2.0), gVisor release-20260914.0/95eb5d5930b0e7736826cc2cb949ba9d2c4d5d29 (Apache-2.0), Squid7.7/173863d3ec547d7fc5227ddbb5d8093c88b4842f (GPL-2.0 separate process), systemd255/db11bab38ccf1ed257f310d29070843d4c58ea01 (LGPL-2.1-or-later). Existing standard-first / released-dependency / thin-adapter choice remains viable; OpenSandbox/Playwright MCP would add a second service layer without closing actual profile authority/egress. Existing Firecracker1.17.0 is a fallback candidate only after demonstrated runsc incompatibility, not silently selected here.

The exact agent-computer profiles.ts, control.ts, index.ts, control/authorization tests, package.json, Dockerfile and LICENSE were downloaded directly from the fixed official GitHub commit and actually read. Paths/URLs/digests are in upstream/SOURCES.json; source is research material only, not incorporated into OpenBot. It confirms persistent contexts, basic password-store, optional proxy, default Chromium sandbox off, mutable Bun install/root Dockerfile, per-Bot in-process state, initial holder=bot and shared token for /exec and /files. Official control tests are isolated state-machine tests, not Linux/gVisor runtime proof.

Official sources checked again:
- [Fixed browser source](https://github.com/CopilotKit/openbot/tree/257c1280d684089be9adb0b35cce262efc7064bf/agent-computer)
- [Playwright1.62.1 release](https://github.com/microsoft/playwright/releases/tag/v1.62.1) and [Docker guidance](https://playwright.dev/docs/docker): matched package/image version; root disables Chromium sandbox; its image alone is not qualified for untrusted websites. The documentation's current1.63.0 examples are not an implicit upgrade of the retained pin.
- [gVisor pinned release](https://github.com/google/gvisor/releases/tag/release-20260914.0), [network stack](https://gvisor.dev/docs/user_guide/networking/): host-network passthrough reduces isolation, network-none blocks external access; its default stack does not define application destination authorization.
- [Docker firewall guidance](https://docs.docker.com/engine/network/packet-filtering-firewalls/): bridge/host mode and backend differences matter; published ports bypass UFW assumptions. Do not modify production daemon-owned rules for this qualification.
- [Squid7.7 release](https://github.com/squid-cache/squid/releases/tag/SQUID_7_7), [official ACL reference](https://www.squid-cache.org/Doc/config/acl/): dstdomain/dst/port plus final deny are reusable destination policy, with packet enforcement still required. No proxy image digest or completed runtime test is invented.

Maintenance/issues: official API now reports OpenBot v0.0.15 released2026-09-22 (metadata only inspected, not a replacement-source audit). Issue424 is now CLOSED and identifies fix422 for punctuation/paste; earlier retained research called it open. This report does not assume every upstream viewer fix applies to OpenBot's different /human/type surface, so actual `a.b`, Unicode/paste and shortcut checks remain. GitHub search `repo:google/gvisor chromium sandbox` returned open1906 (/proc/self/cgroup) and closed3942 (host thread/pids behavior); neither establishes compatibility or a current blocker for this exact browser. Runtime measurement remains the earliest decisive gate. Public JSON snapshots are in upstream/.

A new specific implementation gap was reproduced against current provider source: whole-run serialization spans the120-second approval await, so queued human take does not reach upstream until after an approved click. approval-takeover-repro.mts ran through the actual Provider with only synthetic in-memory HTTP responses, no network/browser. Python's existing35-second gate similarly cannot encompass approval waiting. Split observation/approval/commit using existing structures; do not loosen actual effect serialization or authority. REPRO.json records only observed public facts. This experiment uses the workspace's already installed tsx and Node22.23.2, not a new dependency or platform qualification.

No upstream implementation is copied into the candidate. Public source snapshots retain the downloaded MIT LICENSE. A later derived runtime image must preserve upstream/Playwright/Chromium notices; a distributed Squid binary brings its applicable GPL source obligations. The historical OpenBot image pins base digest dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e and upstream archive3c90d2a820ac602af4a3a3bdb2c10b54ad4472770d174a7741acf0dc7b5a6cd6, but its mutable apt/Bun installer and missing hardening still require a small packaging revision and measured Linux image digest.

## Root checkpoint

Root accepted checkpoint A: measure the pinned Chromium binary under runsc, non-root and the
browser's own sandbox before restoring the complete upstream server/image. Official image
preparation and source review do not establish runtime compatibility. Root separately assigned
a narrow Provider prepare/approval/commit correction for the reproduced takeover queue defect.
No browser execution, egress, profile persistence or product authority gate is closed yet.

The reviewed plan retains browser.session@1/three existing Owner routes and the current Node
relay. After runtime compatibility, qualify a separate private proxy/packet-policy namespace
with synthetic canaries and a one-Employee/one-container/one-profile mapping. Unknown input and
restart remain durably paused. Only after actual Human and Work Agent effects share the same
short effect gate may either product feature switch enable takeover. Approval waiting must not
hold that gate; a Control or Node lease is not proof of Chromium egress confinement.
