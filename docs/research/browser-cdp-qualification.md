# Research: fixed-image CDP browser qualification

- Status: offline boundary candidate; Linux browser acceptance remains open
- Date:2026-09-25
- Owner: OpenBot contributors
- Related records: [Linux browser review](linux-browser-qualification.md), [browser sessions](python-browser-sessions.md), [reuse ledger](../OPEN_SOURCE_REUSE.md)
- Acceptance journey: one separately authorized native180-second case retains synthetic DOM/PNG, closes and reopens the same profile, proves internal namespace/seccomp diagnostics, then proves original Invocation cleanup and unchanged production state.
- Security boundary: Server authority is unchanged. Models/webpages/browser/worker output remain untrusted; this grants no product capability. No new syscall permission, capability, network access or sandbox-disabling option.

## Search evidence

Research preceded the temporary candidate implementation. This change integrates that frozen work without another runtime dependency. Exact public URLs, source byte counts and SHA256 values are in [UPSTREAM_SOURCES.json](../../experiments/browser-execution/UPSTREAM_SOURCES.json); the guessed Chromium browser-test URL that returned404 is explicitly excluded from evidence. Queries on2026-09-25 included GitHub `repo:google/gvisor chromium hang`, `repo:microsoft/playwright dump-dom screenshot`, fixed Chromium command/CDP source, fixed Playwright image/transport/launch/tests and Node zlib. Existing browser/egress/Linux reuse entries were read.

[Chromium command JS](https://github.com/chromium/chromium/blob/151.0.7922.34/components/headless/command_handler/headless_command.js#L315) races only page loading against `--timeout`, separately awaits virtual-time expiry, then handles DOM/screenshot. The [C++ handler](https://github.com/chromium/chromium/blob/151.0.7922.34/components/headless/command_handler/headless_command_handler.cc#L384) awaits the complete promise before printing DOM. This is an observation gap, not proof of b2's stall cause.

The [Playwright final image](https://github.com/microsoft/playwright/blob/v1.62.1/utils/docker/Dockerfile.noble) removes its temporary SDK. [Pipe selection](https://github.com/microsoft/playwright/blob/v1.62.1/packages/playwright-core/src/server/browserType.ts#L278), [framing](https://github.com/microsoft/playwright/blob/v1.62.1/packages/playwright-core/src/server/pipeTransport.ts), [Chromium pipe](https://github.com/chromium/chromium/blob/151.0.7922.34/content/browser/devtools/devtools_pipe_handler.cc), fixed PDL and released protocol types establish stdio3/4 ASCII-NUL CDP. Fixed [Chromium tests](https://github.com/microsoft/playwright/blob/v1.62.1/tests/library/chromium/chromium.spec.ts) and launch source were read; the candidate does not copy default flags that disable the sandbox.

Maintained issues [gVisor7416](https://github.com/google/gvisor/issues/7416), [gVisor14408](https://github.com/google/gvisor/issues/14408) and [Playwright41532](https://github.com/microsoft/playwright/issues/41532) were read. They neither establish incompatibility of this exact combination nor guarantee screenshot success. Fixed [systrap source](https://github.com/google/gvisor/blob/95eb5d5930b0e7736826cc2cb949ba9d2c4d5d29/pkg/sentry/platform/systrap/sysmsg_thread.go) was checked, but b2 has no syscall/stack attribution. The observed [netlink bind error](https://github.com/chromium/chromium/blob/151.0.7922.34/net/base/address_tracker_linux.cc#L243) takes `AbortAndForceOnline()` and returns; it does not justify widening network permissions.

## Candidate comparison

| Candidate | Exact pin | License | Maintenance/tests and security fit | Decision |
| --- | --- | --- | --- | --- |
| Chromium CDP pipe |151.0.7922.34 | BSD and bundled notices | Released protocol, fixed PDL/native source; same private pipes, no new port | First viable standard interface; thin bounded adapter |
| Playwright SDK |1.62.1 | Apache-2.0 | Maintained source/tests; SDK removed from final image | Reuse framing; do not install another SDK just for this probe |
| CLI aggregate | same Chromium | Same | Maintained, but DOM output follows complete aggregate | Replace diagnostic orchestration; do not label flags invalid |
| Existing runsc/Node | runsc release-20260914.0 /95eb5d5930b0e7736826cc2cb949ba9d2c4d5d29; image Node24.18.1 | Apache-2.0; Node license | Reviewed isolation and built-in CRC32/bounded inflate | Retain; no new dependency or permission |

## Reuse decision

Selected option: released CDP interface plus thin adapter. The gap is stage diagnosis and failure artifact retention inside the existing180-second qualification, not another browser framework. Closed methods bind actual session/frame/loader, enforce absolute budgets and bounded JSON/PNG/DOM, and never resend. The official profile stays distinct from the previously tested clone3/chroot experimental derivative; its bytes remain unchanged.

Repository helpers resolve from exactly two layouts: complete adjacent `reviewed/` for an explicitly packaged remote candidate, otherwise sibling `experiments/linux-execution`. An incomplete local packet fails rather than searching elsewhere. Helpers are not copied. The historical V3 oracle becomes a small MIT construction-data fixture, not another executable. Forty existing boundary checks use Node tests/Python unittest via an independent npm script and one existing Python/Linux CI step; no dependency/lockfile changes.

Upgrade/exit: retain pins until separately reviewed updates and actual Linux conformance. Retire the temporary probe when product/SDK qualification provides equivalent evidence; it is not a product API. Missing helper, digest drift, protocol failure, insufficient budget, unknown start or missing artifacts fail closed. Unknown effects never renew identity or trigger resend.

## Source incorporation

Yes: ASCII-NUL framing narrowly adapts Playwright1.62.1 `pipeTransport.ts`, with Google2018/Microsoft Apache notices in `probe.mjs`, `playwright-LICENSE`, `playwright-NOTICE`, and `DERIVATIVE_NOTICE.md`. The seccomp derivative retains its applicable notices. Chromium/gVisor/Node source was research evidence, not copied implementation. Native helpers and V3 construction data originate from OpenBot MIT. No new binary/package is distributed by this change.

Fixed [Node zlib](https://github.com/nodejs/node/blob/v24.18.1/doc/api/zlib.md#L1152) documents CRC32 and bounded inflate `maxOutputLength`, avoiding a new PNG package. The probe checks bounded1280x800 pixel data; it is not a general image sanitizer.

## Verification plan

`npm run test:browser:boundary` runs15 Node synthetic-stream and25 Python command/readback/budget/unknown checks without browser/container/SSH effects. Coverage includes malformed/bounded frames, session mismatch, no resend, lifecycle IDs, immediate DOM retention on PNG failure, actual diagnostic-session selection, CRC/pixels, fixed sandbox configuration, frozen helper hashes, Unix path bounds, partial-layout refusal and timed receipts.

English/Chinese [README](../../experiments/browser-execution/README.md) and [translation](../../experiments/browser-execution/README.zh-CN.md) separate offline tests from Linux proof. Prior b2 reached Chrome but its25-second CLI was killed without render acceptance. A separate Mac CDP check reached viewport but navigation timed out; no Linux compatibility or cause is inferred. Missing old timestamps/artifacts are never reconstructed.

## Unresolved questions

The explicitly authorized single `deadline-a1-cdp1` case now qualifies fixed-image Linux/runsc CDP
readiness, DOM/PNG, same-profile reopen and inner sandbox diagnostics. Egress, product authority/profile
mapping and human takeover remain separate gates. This evidence does not authorize future runs.

## Actual bounded Linux evidence — 2026-09-25

[Safe result](../../experiments/browser-execution/REAL_CDP_RESULT.json): both browser launches closed
gracefully within14,957ms total guest time, without forced termination, external sites or model calls.
The first produced658-byte DOM and a15,240-byte1280x800 PNG; the second produced656-byte DOM and
confirmed the expected same-profile synthetic state. Namespace/PID/network/seccomp diagnostics passed;
sampled processes reported NNP1/Seccomp2 with no sandbox-disabling arguments. The experimental derivative
profile and actual OCI/Sentry flags matched the original pins. Seven transient runtime argument
observation errors remain in the receipt; the final required argument verification passed.

The original180-second native Invocation expired; stop was observed54ms later, cgroup/unit/runtime
directories were absent, and cleanup reported zero problems. The original10 production containers
and semantic firewall rules matched both before/after proofs. Only safe metadata and hashes are
published; no DOM body, PNG content, raw stderr or full argv is exported. This is component conformance
on the fixed synthetic page, not complete product-browser or host-platform certification. The earlier
b2 failure remains evidence for that different CLI attempt; no cause is retroactively inferred.
