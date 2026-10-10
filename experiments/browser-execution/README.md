# Chromium/runsc boundary experiment

The CDP qualification entry is `probe.ts`, with typed transport and artifact modules. The egress
guest runs `egress_probe.ts`; both use existing guest Node type stripping. The Python qualifiers
that pinned and launched them (`browser_a1.py`, `qualify_egress.py`) were deleted after P5; read
them at [the last revision that had them](https://github.com/Peerframe/openbot/tree/50837bea7bf63290aab250f84fe1b705f942efdb/experiments/browser-execution).
The TS entry at `d426715` passed the authorized single fixed Linux/runsc case on 2026-09-30
(`deadline-a1-ts0930a`): both browsers closed, the profile reopened, synthetic DOM and 1280×800 PNG
were independently checked, and original 180-second Invocation expiry emptied the cgroup and
removed owned runtime directories. Production container/network state was unchanged. The case
uses the same fixed image, native binaries and policies.

**The prior MJS fixed-image Linux/runsc CDP component passed on 2026-09-25.** The authorized single case produced real synthetic-page DOM and PNG, reopened the same browser profile, observed inner sandbox diagnostics and verified native expiry/cleanup. See [actual bounded evidence](REAL_CDP_RESULT.json). This does not enable product browser capabilities or qualify egress, Employee-profile authority or human takeover. See the [research](../../docs/research/browser-cdp-qualification.md) and [earlier actual b2 failure](../linux-execution/REAL_BROWSER_CHROOT_ATTEMPT.json).

## Fresh-checkout boundary tests

Requirements: a repository-supported Node version with built-in `node:zlib` CRC32. No npm dependencies, credentials, browser download, Docker, SSH or root privileges are needed for this command:

```sh
npm run test:browser:boundary
```

It runs the Node synthetic CDP/artifact, egress-policy and egress-argument tests in `experiments/browser-execution/*.test.ts`. `npm run check` and the affected-path CI selection run the same command. It never invokes the wrapper's executable entry point or launches a browser/container. The wrapper resolves native helpers from a complete adjacent `reviewed/` directory when explicitly packaged for the remote test; otherwise it uses the exact sibling `../linux-execution`. An existing incomplete `reviewed/` is rejected. It does not search arbitrary directories. The three helpers are not duplicated here and their reviewed hashes remain checked.

`fixtures/v3-construction.json` is data generated from the previous OpenBot MIT wrapper's pure construction methods, with source/hash provenance. It replaces a duplicate historical executable in the original temporary test packet. The check preserves the prior command/configuration boundary, apart from the already reviewed explicit `compress=false` log option.

## Actual egress proxy policy

The strict compiler and real Debian Squid 7.7-1 passed 20 cases in a disposable Linux amd64
`network=none` container: HTTP over IPv4/IPv6 and CONNECT reached owned canaries;17 wrong-source,
host, port, protocol, numeric-host and forbidden-destination cases returned 403 with zero target
requests. Private, metadata, management and IPv6 canaries were directly reachable before the proxy
checks. Parse warnings/coercions fail the test. The proxy exited cleanly and its container was removed.
See [safe evidence](REAL_EGRESS_RESULT.json) and [research](../../docs/research/browser-egress-policy.md).
This is proxy-only evidence; direct sockets, DNS rebinding, actual host packet rules and revoke of
preexisting tunnels are separate gates. No production browser scope is widened.

With Docker and network access for the build, a fresh checkout can reproduce it without credentials:

```sh
docker build --platform linux/amd64 -f experiments/browser-execution/egress-fixture.Dockerfile \
  -t openbot-egress-fixture:local experiments/browser-execution
node experiments/browser-execution/qualify-egress.ts \
  --fixture-image "$(docker image inspect openbot-egress-fixture:local --format '{{.Id}}')" \
  --output /tmp/openbot-egress-result
```

The fixture keeps exact packages and the signed Debian `20260926T022600Z` snapshot, including
their dependency closure. Historical metadata expiry is scoped to that snapshot; signature and
package-hash verification remain enabled. See the research for the reproducibility repair.

Choose a new output directory. The runner uses only synthetic inputs,150-second execution and
bounded cleanup; NET_ADMIN applies only inside its own disconnected network namespace to add
loopback canary addresses. It publishes no ports and changes no host/VPS networking. Required CI
runs this actual proxy fixture separately from browser recovery. Keep Squid/Debian and Node notices
with the image; this fixture image is not the production browser/Host image.

## Native kernel routing and connection revocation

The supplied Ubuntu 24.04/nftables 1.0.9 host passed 23 forwarding cases plus client-to-proxy
connection/revocation. All canaries were reachable before filtering; forbidden paths then produced
zero target receipts, and the already-open socket stopped delivering after admission was removed.
The original 150-second systemd unit and all children closed. Existing 9 containers, firewall semantics
and host forwarding settings were unchanged. See [safe result](REAL_KERNEL_NETWORK_RESULT.json).
These are TCP/UDP echo canaries, not a replacement proxy. Squid composition, actual Chromium/runsc
and product authorization remain separate acceptance gates.

The required egress CI job reproduces the native fixture on a disposable Ubuntu 24.04 systemd
runner with nft/iproute2/iptables and Docker's snapshot-only CLI. It stages the three files in
`native-network/` at the fixed, single-use root-private directory declared by the fixture, then
invokes `run_probe.py --docker /usr/bin/docker`. No Docker container or outside route is created by
this native check. Do not run it over an existing result directory or reuse a consumed unit identity.
The exact deployment and resource arguments live in the launcher and CI. The kernel probe refuses
any process outside its original unit or in PID 1's network namespace before changing links/rules.

## Candidate contract

The image is Playwright 1.62.1 noble, fixed linux/amd64 manifest, with Chromium 151.0.7922.34 and the already observed Node 24.18.1. Complete pins are in [PINS.json](PINS.json). The image's final layer removes its temporary Playwright SDK. The probe uses Chromium's existing ASCII-NUL CDP pipe on child stdio 3/4 through Node built-ins; no new SDK, debug TCP port or custom wire protocol.

The fixed synthetic page inside the network-none guest tests arithmetic 25, Chinese text, cookie and localStorage. The first Chrome must produce actual DOM and a 1280x800 PNG, expose the internal namespace/PID/NET/seccomp diagnostic, and close gracefully. Only then may a second launch confirm same-profile persistence. Failure or unknown status prevents that second launch and never repeats a timed-out request. The internal diagnostic is another target in the first browser.

Retained isolation: nonroot UID/GID 1001, capability drop-all, NNP, read-only root, private IPC, network=none, fixed resource/logging bounds, systrap and **actual** OCIseccomp=true readback. The profile remains the reviewed experimental clone3/chroot derivative, SHA256 `d00ad84f5a67031fe2bb64de8d77a5ad9c06adb82935ebdb3c18b5f7ba60a5d0`; it adds guest syscall permissions over the official profile and is not approved production policy. No permission is added by the CDP candidate. See [the derivative notice](DERIVATIVE_NOTICE.md).

The original native unit has a180-second hard deadline. Immediately before the single container start at least 85 seconds must remain:10 for start,65 for guest work/settlement and 10 for final inspection/logs. All main phases share 58 seconds, failure observations stop at 62 seconds and the guest watchdog is 65 seconds. Insufficient time refuses start; neither deadline nor identity is renewed. The wrapper always verifies the original Invocation's expiry and cleanup.

## Actual evidence and limits

The previous b2 run reached 15 sampled Chrome processes with NNP 1/Seccomp 2 and no disabled-sandbox switches. Its 25-second CLI timer killed the first launch without retained DOM/PNG, so rendering was not accepted. Source shows the CLI prints DOM only after aggregate virtual-time/screenshot processing; this is an observation gap, not proof of b2's cause. A separate real Mac CDP check received responses through viewport, but localhost navigation timed out; DOM, PNG and profile reopen did not pass. Mac display diagnostics do not identify a Linux cause.

This candidate emits one `openbot-browser-runsc-compatibility-CDP`, version 1 record. Safe collectors must recognize it, rather than the old three-run CLI schema:

- `stages[]` holds actual monotonic start/elapsed offsets, status, fixed error code and optional numeric CDP error code.
- `runs[]` has at most indices 0/1, actual exit/close information and bounded process roles/NNP/seccomp/prohibited-switch observations, without full argv.
- `runs[].artifacts.page` and `.sandbox` retain DOM/PNG immediately, including after later failure: attempt flag, actual body, bytes and SHA256; PNG adds dimensions. Missing evidence stays missing.
- `screenshot` is metadata; `sandboxText` is the actual normalized internal diagnostic. Inherited process seccomp alone does not prove Chromium's inner sandbox.
- Host command receipts add elapsed time and offset from validated native activation; the offset is null before activation. Old b2 timings/artifact bytes are not invented.

Bounds are DOM 16KiB, PNG 192KiB with CRC and bounded exact pixel-decompression validation, CDP frame 384KiB, per-browser CDP wire 2MiB, stderr tail 8KiB, child output 128KiB and final JSON 512KiB. Overflow fails closed. Final-record overflow drops artifact bodies but preserves their metadata and refuses acceptance. Only separately approved safe fields may be exported from remote receipts; do not export raw stderr, full argv, credentials or production content.

## Real execution is a separate gate

These files do not provision a host or authorize an execution. The wrapper intentionally retains the fixed qualification site's reviewed paths and original single-use identity/reservation rules; it is not a general installer. A real case requires a separately authorized isolated host, exact image/archive/binary pins, root-owned inputs, exclusive window, capacity and production before/after comparison, then original Invocation/cgroup cleanup. A partial/unknown case must never be retried under another name or by relaxing sandbox permissions. No remote command is part of npm/CI.

The CDP framing narrowly adapts Playwright v1.62.1 transport behavior. Required [Apache license](playwright-LICENSE), [notice](playwright-NOTICE), [modification notice](DERIVATIVE_NOTICE.md) and [primary-source hashes](UPSTREAM_SOURCES.json) are retained. OpenBot orchestration and tests remain under the repository MIT license.

## Native browser product composition

The separate 600-second composition passed actual HTTPS Chromium/runsc/Squid, product approvals,
report/replay, private-profile container replacement and established TLS tunnel revocation, with
original native expiry and unchanged production state. See [paired evidence](../work-journey/evidence/product-browser-linux.json)
and the [fixture and scope](composition/README.md). Earlier component results retain their original
scope. This adds no general public egress or production Host installation claim.
