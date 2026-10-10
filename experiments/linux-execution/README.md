# Command-only Linux execution precursor

Status 2026-09-25: **real Linux/runsc command boundary and independent native lifetime tested; product execution remains disabled**.
This standard-library experiment owns no Task identity, authorization, budget, approval or
Artifact publication. Its append-only ledger prevents another create/start for a consumed
Action/epoch; it is not an authenticated admission service or a replacement recovery engine.

## Reviewed implementation and actual evidence

Reuse Docker 29.8.1 / Moby `464cd50c3d9e92877d56940ea160de6fca7bea23`, gVisor
release-20260914.0 / `95eb5d5930b0e7736826cc2cb949ba9d2c4d5d29` and OCI 1.3.0 /
`92249139eea7161e13745abd4cb6d0ea02a3227a`. No upstream source is copied. Host provisioning uses the released Docker/containerd/runsc/systemd
binaries, not a new sandbox implementation. Exact primary-source decisions and host pins are
in [boundary research](../../docs/research/linux-execution-boundary.md) and
[VPS qualification](../../docs/research/linux-vps-qualification.md).

[REAL_HOST_BOUNDARY.json](REAL_HOST_BOUNDARY.json) records the tested source hashes and five
actual private-daemon cases on Linux x86-64/cgroupv2:

- UID 10001, read-only root/input, only loopback, refused supervisor canary and external route;
  actual cpu.max, memory.max, zero swap and host pids.max readback.
- A64MiB dedicated ext4 output device returns ENOSPC before exceeding its capacity.
- A100GiB sparse logical file is rejected before hashing its holes.
- A real successful start whose response is discarded recovers the original result; a new
  controller is refused another start and the command creates its one effect once.
- Guest RLIMIT_NPROC is 512/512, cannot be increased by the workload, and a narrowed 32 limit
  allows 31 children before EAGAIN. Guest real-user counters differ from host cgroup tasks.

Exact-owned containers, private mounts and loop attachments are cleaned up after each case.
The separate [REAL_HOST_DEADLINE.json](REAL_HOST_DEADLINE.json) qualifies four fresh per-Action
systemd units: baseline, controller death, paused private Docker daemon, and a queued start.
Each original Docker/containerd/runsc process tree ended with native `timeout`, without controller
cleanup causing the verdict or another start. Observed cessation was 0.12–0.31 seconds after the
nominal 60-second lifetime, within the declared five-second observation bound. This is ordinary
systemd/kernel scheduling, not a hard real-time guarantee. Every business outcome remains unknown.
All owned trees/mounts/loop devices were cleaned;10 production container identities/start/state
and semantic IPv4/IPv6 firewall rules remained unchanged. Authenticated product admission,
image-general confinement, browser networking and takeover remain separate gates.

## Files and checks

The protected command Host also passed its first full native case; see
[REAL_PROTECTED_COMMAND.json](REAL_PROTECTED_COMMAND.json). An actual unprivileged Node relay,
private namespaces, signed readiness/receipt, one original start and exact 18-byte CSV passed.
The original 50-second unit stopped within its five-second observation margin (155ms observed);
owned resources and ephemeral keys were cleaned and existing services/firewalls were unchanged.
The signer in this case is synthetic Control. Real Work/Temporal authority through the product
entry remains a separate required integration gate.

[REAL_BROWSER_CHROOT_ATTEMPT.json](REAL_BROWSER_CHROOT_ATTEMPT.json) records the separate failed
Chromium b2 attempt. The prior chroot fatal disappeared, but the first Chrome process reached the
probe 25-second limit without accepted render evidence. Fifteen sampled Chrome processes retained
NoNewPrivs and seccomp; the original 180-second unit expired and its resources were cleaned. Existing
services/firewalls were unchanged. These observations do not qualify browser use or takeover.

The Python qualifiers that produced this evidence (`sandbox.py`, `qualify_running_host.py`,
`deadline_probe.py`, `output_capacity.py` and their tests) were deleted after P5 retired Python;
read them at [the last revision that had them](https://github.com/Peerframe/openbot/tree/50837bea7bf63290aab250f84fe1b705f942efdb/experiments/linux-execution). The TS
protected Host, command sandbox and native helpers in this directory replace them; run their
contracts with:

```sh
npm run test:linux:contracts
```

## Authority, persistence and remaining gates

Create/start verify a dedicated private ext4 root with nodev/nosuid/noexec, fixed total device
capacity and no nested/duplicate mount. The trusted operator controls the source ancestors;
untrusted workloads receive only input/output, no daemon socket or credentials. The input
manifest and actual daemon mount/resource shape are checked before start. See
[output-capacity review](OUTPUT_CAPACITY_REVIEW.md) for the historical XFS alternative and
[LinuxKit negative](evidence/output-capacity-linuxkit-20260924.json).

The start reservation and directory entries are fsynced before the external verb. A consumed
start with Docker status `created` is **unknown**, because an earlier request may still be
queued. No-record/absent state never proves non-execution. Exact-ID cleanup requires the
original durable association; a same-name replacement is refused. Missing/failed cleanup
remains visible.

The caller freezes one monotonic deadline before create/start. Waiting consumes only its
remaining time, including delayed start acknowledgement. The former Python helper's later kill/observation was
best effort; it does not survive controller death or an unreachable Docker daemon. A separately
qualified native per-Action unit contains every late-start producer. The deleted `deadline_probe.py`
qualified that separate wrapper; the deleted `sandbox.py` alone did not acquire its guarantee. Recovery only inspects;
it cannot re-arm a deadline, replace a container or resend a command.

Collection hashes no-follow, single-link regular files incrementally, limits tree entries and
apparent bytes before reading sparse data, and rejects concurrent identity/size changes. Its
`enforced:false` describes collection itself: a digest/size check is not storage enforcement or
an authorized Artifact publication. Files and image/device evidence remain separate.

The Server must still consume the exact Task/Run/Action epoch, approval and resource grant,
serialize cancellation/revocation, and publish verified artifacts. Temporal retains continuation;
the host helper owns only execution/receipts. Browser sessions, supervised writes, takeover,
downloads and document/code deliverables need their separate contract journeys. No capability
is enabled merely because these command tests passed.
