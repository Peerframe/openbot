# Research: optional remote product command qualification controller

- Status: integrated; local product composition passes, first remote product attempt failed before execution.
- Date: 2026-09-25.
- Acceptance: preserve the existing actual Owner/Work/approval/receipt/output/review/Replay journey,
  substituting the already reviewed single-Action Host fixture for the local synthetic Native.
- Boundary: explicit operator target and fresh upload authorization; local Control private key,
  Owner cookie, PostgreSQL URL and Temporal TLS remain local. This is a qualification script,
  not a production deployment path or an additional executor.

## Evidence and reuse

Read `OPEN_SOURCE_REUSE.md` (POSIX credential/OpenSSH, Linux qualification, protected Host),
`linux-vps-qualification.md`, the accepted `product_command_probe.py`, and the separately reviewed
`product_host_fixture.py`/INTERFACE. Keep their image, policy, 50-second native runtime,
5-second stop allowance and 150-second remote wrapper; no dependency or protocol change.

The existing OpenSSH review pins portable commit `1bf5871aead6d73177d727add15ab0f14c258fdf`
(BSD-style collection). The available macOS client reports **OpenSSH_10.3p1, LibreSSL 3.3.6**.
Read its installed `ssh_config(5)` plus the official [ssh(1)](https://man.openbsd.org/ssh.1) and
[ssh_config(5)](https://man.openbsd.org/ssh_config.5), retrieved 2026-09-25. The exact older GitHub
raw manual requests failed (cache/network); do not claim those pages were inspected. The stable
options used here are documented in the available official manuals: explicit `-F none`, `-S none`,
`-T`, `-a`, `-x`, strict known hosts, no agent, and explicit loopback `-R`. OpenSSH supplies encrypted
transport and host verification. `ExitOnForwardFailure` checks forwarding setup, not product health.
The remote fixture separately checks the actual listener. A TCP failure is never permission to
repeat an execution request.

Selected: thin adapter over the installed OpenSSH executable and Python asyncio subprocess API,
not Paramiko/another SSH implementation. The missing logic is exact public staging/pinning,
once-only stdin enrollment, finite capture and joining remote cleanup to the original SQL binding.
Existing command `strict_json`, `CommandRoute`, `TimingPolicy`, `PreparationBinding` and cryptography
Ed25519 parsing are reused. No upstream source is copied or redistributed, no new notices/deps.

## Decisions

A finite `stage` SSH call precedes Serve startup. Exactly one foreground `run` SSH process owns
both the reverse tunnel and the original remote runner. A separate, once-only, fixed read-only
SSH check immediately before approval requires the single-Action tombstone to be absent and the
same staged route/run reservation to exist. This fixed read-only check is included in the proposed execution scope;
it does not execute a second runner. No discovery, SCP/upload, retry, reconnect or recovery start.

Remote stage itself refuses until the existing case2 `safe-result.json` says success, and validates
the accepted Host/Native/crypto pins. The CLI additionally requires a fresh explicit upload approval
acknowledgment. This switch is an operator precondition, not a way to obtain authorization. An old
successful qualification is not a new upload authorization. Prepared code does not itself authorize
or perform upload. Run failures leave remote reservations intact; cleanup is observed from the original bounded run.
If stage was attempted but run was never attempted, one fixed operator cleanup included in the proposed scope
may remove only that unused enforcer key after exact completed public stage and Control public-key
checks plus absence of both run/Action reservations. Missing/partial records leave cleanup uncertain;
no reservation is ever removed and no new unit or execution is started.

## Verification

Only local schema/command construction and fake subprocess streams. Cover credential separation,
strict host/tunnel flags, malformed pins/duplicate JSON, bounded streams, timeout/disconnect,
no repeated stage/run/check, remote cleanup/production negatives and every binding field mismatch.
An integration-shaped synthetic test preserves the original product journey assertions and proves
ordering/revocation/key cleanup on failure. No real SSH, provider, Linux isolation or remote product
success is claimed by these tests. Real qualification still requires case2 success, explicitly
approved uploaded bytes, operator-selected connection inputs, and the complete original journey.

## Reviewed remote fixture source

The exact remote host fixture and its no-process tests are retained in
`experiments/work-journey/product_host_fixture.py` and `test_product_host_fixture.py`.
The original product1 fixture source SHA256 was
`24cc9b41c4c6e6adc3bbb28cbb923ce37b670ae49793e15dc0d64ebdaabe4add`.
It reuses the protected Host/Native/crypto pins qualified by case2, the existing production comparison,
and Linux credential dropping. Its exclusive single-Action reservation only narrows admission.
No dependency or upstream source is added. The fixed `/opt` fixture paths identify a disposable
qualification installation; this is not a production provisioning service. The staged `.cjs` suffix
matches the existing esbuild CommonJS bundle and released Node module rules.

## Integration and first remote attempt

The actual local Owner/Work/PostgreSQL/mTLS/Node/Unix journey passed on canonical schema43;
its Native boundary and model HTTP are synthetic. The explicitly authorized four-file product1
package was uploaded with exact hashes. Stage completed, but the original run exited before
run/Action reservation or Node startup. The original collector lost stderr, so the root cause
remains unclassified. Read-only evidence and exact staged public pins subsequently permitted
cleanup of the unused ephemeral Enforcer key and public Node copy. The ten existing containers
and dual-stack firewall semantics were unchanged. Keep its stage tombstone; never repeat product1.
The public safe projection is
`experiments/work-journey/evidence/product-command-remote-attempt.json`.

The integrated controller now retains bounded private stderr after stdout failure. The fixture
records a bounded error category and trusted source location, independently cleans only an
unreserved ephemeral key, and requires an explicit canonical fresh directory; see
[fixture identity research](product-command-fixture-identity.md) and
[capture research](product-command-failure-capture.md). Their 155 local checks pass.
No accepted Native/Host/crypto pin or 50/150-second limit changes. The new product2 package is
prepared separately; it has not been uploaded or qualified by the product1 authorization.

## Product3 acceptance — 2026-09-26

The Owner explicitly approved the fresh four-file product3 manifest, 1,278,959 bytes. Its archive
and all uploaded bytes were verified. One real product journey passed with current canonical44:
actual Owner HTTP approval, Python product entry, PostgreSQL/mTLS Temporal, enrolled Node WebSocket,
Unix relay, protected Host signatures and real Linux native isolation. One original command yielded
the exact CSV, separate result review, two artifact downloads and offline history replay. Model
HTTP remains synthetic; no paid-model claim is inferred. The probe now reads the actual migration
count instead of reporting a stale literal43; 161 controller/Host tests passed with this change.

The original50-second native lifetime and150-second runner bound held. Original cgroup emptiness,
unit release, runtime/backing removal, ephemeral-key removal and socket absence passed. Control
revoked this Node and removed its private key. The exact owned public bundle was removed after
identity/hash/process checks; consumed reservations and evidence remain. All ten pre-existing
containers and IPv4/IPv6 firewall semantics were unchanged. No earlier case was retried.
See [bounded public evidence](../../experiments/work-journey/evidence/product-command-remote-product3.json).
This closes the Linux product-command gate, while browser and final replacement gates remain distinct.
