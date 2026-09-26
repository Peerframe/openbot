# Chromium/runsc boundary experiment

**The fixed-image Linux/runsc CDP component passed on2026-09-25.** The authorized single case produced real synthetic-page DOM and PNG, reopened the same browser profile, observed inner sandbox diagnostics and verified native expiry/cleanup. See [actual bounded evidence](REAL_CDP_RESULT.json). This does not enable product browser capabilities or qualify egress, Employee-profile authority or human takeover. See the [research](../../docs/research/browser-cdp-qualification.md) and [earlier actual b2 failure](../linux-execution/REAL_BROWSER_CHROOT_ATTEMPT.json).

## Fresh-checkout boundary tests

Requirements: a repository-supported Node version with built-in `node:zlib` CRC32 and Python3.9+. No npm dependencies, credentials, browser download, Docker, SSH or root privileges are needed for this command:

```sh
npm run test:browser:boundary
```

It runs15 Node synthetic CDP/artifact tests and25 Python command/authority/budget tests. The existing Python/Linux CI runs the same command. It never invokes the wrapper's executable entry point or launches a browser/container. The wrapper resolves native helpers from a complete adjacent `reviewed/` directory when explicitly packaged for the remote test; otherwise it uses the exact sibling `../linux-execution`. An existing incomplete `reviewed/` is rejected. It does not search arbitrary directories. The three helpers are not duplicated here and their reviewed hashes remain checked.

`fixtures/v3-construction.json` is data generated from the previous OpenBot MIT wrapper's pure construction methods, with source/hash provenance. It replaces a duplicate historical executable in the original temporary test packet. The check preserves the prior command/configuration boundary, apart from the already reviewed explicit `compress=false` log option.

## Candidate contract

The image is Playwright1.62.1 noble, fixed linux/amd64 manifest, with Chromium151.0.7922.34 and the already observed Node24.18.1. Complete pins are in [PINS.json](PINS.json). The image's final layer removes its temporary Playwright SDK. The probe uses Chromium's existing ASCII-NUL CDP pipe on child stdio3/4 through Node built-ins; no new SDK, debug TCP port or custom wire protocol.

The fixed synthetic page inside the network-none guest tests arithmetic25, Chinese text, cookie and localStorage. The first Chrome must produce actual DOM and a1280x800 PNG, expose the internal namespace/PID/NET/seccomp diagnostic, and close gracefully. Only then may a second launch confirm same-profile persistence. Failure or unknown status prevents that second launch and never repeats a timed-out request. The internal diagnostic is another target in the first browser.

Retained isolation: nonroot UID/GID1001, capability drop-all, NNP, read-only root, private IPC, network=none, fixed resource/logging bounds, systrap and **actual** OCIseccomp=true readback. The profile remains the reviewed experimental clone3/chroot derivative, SHA256 `d00ad84f5a67031fe2bb64de8d77a5ad9c06adb82935ebdb3c18b5f7ba60a5d0`; it adds guest syscall permissions over the official profile and is not approved production policy. No permission is added by the CDP candidate. See [the derivative notice](DERIVATIVE_NOTICE.md).

The original native unit has a180-second hard deadline. Immediately before the single container start at least85 seconds must remain:10 for start,65 for guest work/settlement and10 for final inspection/logs. All main phases share58 seconds, failure observations stop at62 seconds and the guest watchdog is65 seconds. Insufficient time refuses start; neither deadline nor identity is renewed. The wrapper always verifies the original Invocation's expiry and cleanup.

## Actual evidence and limits

The previous b2 run reached15 sampled Chrome processes with NNP1/Seccomp2 and no disabled-sandbox switches. Its25-second CLI timer killed the first launch without retained DOM/PNG, so rendering was not accepted. Source shows the CLI prints DOM only after aggregate virtual-time/screenshot processing; this is an observation gap, not proof of b2's cause. A separate real Mac CDP check received responses through viewport, but localhost navigation timed out; DOM, PNG and profile reopen did not pass. Mac display diagnostics do not identify a Linux cause.

This candidate emits one `openbot-browser-runsc-compatibility-CDP`, version1 record. Safe collectors must recognize it, rather than the old three-run CLI schema:

- `stages[]` holds actual monotonic start/elapsed offsets, status, fixed error code and optional numeric CDP error code.
- `runs[]` has at most indices0/1, actual exit/close information and bounded process roles/NNP/seccomp/prohibited-switch observations, without full argv.
- `runs[].artifacts.page` and `.sandbox` retain DOM/PNG immediately, including after later failure: attempt flag, actual body, bytes and SHA256; PNG adds dimensions. Missing evidence stays missing.
- `screenshot` is metadata; `sandboxText` is the actual normalized internal diagnostic. Inherited process seccomp alone does not prove Chromium's inner sandbox.
- Host command receipts add elapsed time and offset from validated native activation; the offset is null before activation. Old b2 timings/artifact bytes are not invented.

Bounds are DOM16KiB, PNG192KiB with CRC and bounded exact pixel-decompression validation, CDP frame384KiB, per-browser CDP wire2MiB, stderr tail8KiB, child output128KiB and final JSON512KiB. Overflow fails closed. Final-record overflow drops artifact bodies but preserves their metadata and refuses acceptance. Only separately approved safe fields may be exported from remote receipts; do not export raw stderr, full argv, credentials or production content.

## Real execution is a separate gate

These files do not provision a host or authorize an execution. The wrapper intentionally retains the fixed qualification site's reviewed paths and original single-use identity/reservation rules; it is not a general installer. A real case requires a separately authorized isolated host, exact image/archive/binary pins, root-owned inputs, exclusive window, capacity and production before/after comparison, then original Invocation/cgroup cleanup. A partial/unknown case must never be retried under another name or by relaxing sandbox permissions. No remote command is part of npm/CI.

The CDP framing narrowly adapts Playwright v1.62.1 transport behavior. Required [Apache license](playwright-LICENSE), [notice](playwright-NOTICE), [modification notice](DERIVATIVE_NOTICE.md) and [primary-source hashes](UPSTREAM_SOURCES.json) are retained. OpenBot orchestration and tests remain under the repository MIT license.
