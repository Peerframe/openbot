# Command-only Linux execution precursor

Status2026-09-25: **real Linux/runsc command boundary and independent native lifetime tested; product execution remains disabled**.
This standard-library experiment owns no Task identity, authorization, budget, approval or
Artifact publication. Its append-only ledger prevents another create/start for a consumed
Action/epoch; it is not an authenticated admission service or a replacement recovery engine.

## Reviewed implementation and actual evidence

Reuse Docker29.8.1 / Moby `464cd50c3d9e92877d56940ea160de6fca7bea23`, gVisor
release-20260914.0 / `95eb5d5930b0e7736826cc2cb949ba9d2c4d5d29` and OCI1.3.0 /
`92249139eea7161e13745abd4cb6d0ea02a3227a`. No upstream source is copied and no Python
dependency is added. Host provisioning uses the released Docker/containerd/runsc/systemd
binaries, not a new sandbox implementation. Exact primary-source decisions and host pins are
in [boundary research](../../docs/research/linux-execution-boundary.md) and
[VPS qualification](../../docs/research/linux-vps-qualification.md).

[REAL_HOST_BOUNDARY.json](REAL_HOST_BOUNDARY.json) records the tested source hashes and five
actual private-daemon cases on Linux x86-64/cgroupv2:

- UID10001, read-only root/input, only loopback, refused supervisor canary and external route;
  actual cpu.max, memory.max, zero swap and host pids.max readback.
- A64MiB dedicated ext4 output device returns ENOSPC before exceeding its capacity.
- A100GiB sparse logical file is rejected before hashing its holes.
- A real successful start whose response is discarded recovers the original result; a new
  controller is refused another start and the command creates its one effect once.
- Guest RLIMIT_NPROC is512/512, cannot be increased by the workload, and a narrowed32 limit
  allows31 children before EAGAIN. Guest real-user counters differ from host cgroup tasks.

Exact-owned containers, private mounts and loop attachments are cleaned up after each case.
The separate [REAL_HOST_DEADLINE.json](REAL_HOST_DEADLINE.json) qualifies four fresh per-Action
systemd units: baseline, controller death, paused private Docker daemon, and a queued start.
Each original Docker/containerd/runsc process tree ended with native `timeout`, without controller
cleanup causing the verdict or another start. Observed cessation was0.12–0.31 seconds after the
nominal60-second lifetime, within the declared five-second observation bound. This is ordinary
systemd/kernel scheduling, not a hard real-time guarantee. Every business outcome remains unknown.
All owned trees/mounts/loop devices were cleaned;10 production container identities/start/state
and semantic IPv4/IPv6 firewall rules remained unchanged. Authenticated product admission,
image-general confinement, browser networking and takeover remain separate gates.

## Files and checks

The protected command Host also passed its first full native case; see
[REAL_PROTECTED_COMMAND.json](REAL_PROTECTED_COMMAND.json). An actual unprivileged Node relay,
private namespaces, signed readiness/receipt, one original start and exact18-byte CSV passed.
The original50-second unit stopped within its five-second observation margin (155ms observed);
owned resources and ephemeral keys were cleaned and existing services/firewalls were unchanged.
The signer in this case is synthetic Control. Real Work/Temporal authority through the product
entry remains a separate required integration gate.

[REAL_BROWSER_CHROOT_ATTEMPT.json](REAL_BROWSER_CHROOT_ATTEMPT.json) records the separate failed
Chromium b2 attempt. The prior chroot fatal disappeared, but the first Chrome process reached the
probe25-second limit without accepted render evidence. Fifteen sampled Chrome processes retained
NoNewPrivs and seccomp; the original180-second unit expired and its resources were cleaned. Existing
services/firewalls were unchanged. These observations do not qualify browser use or takeover.

| File | Purpose |
| --- | --- |
| `sandbox.py` | Explicit daemon binding, immutable command validation, single start, bounded observation/collection and exact-ID cleanup |
| `output_capacity.py` | Read-only Linux mount/device/capacity prerequisite |
| `qualify_running_host.py` | Real bounded cases inside an already isolated, explicitly selected test daemon |
| `deadline_probe.py` | Fresh native per-Action unit, original cgroup identity and four lifetime failure cases |
| `compare_production.py` | Compare supplied identity/state and precomputed semantic firewall hashes |
| `test_*.py` | Scripted/kernel-observation regressions; no daemon/container |
| `probe_output_capacity.py` | Earlier LinuxKit negative proving an ordinary directory/tmpfs is not a durable capacity bound |

From the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s experiments/linux-execution -p 'test_*.py'
```

The CLI requires an explicit private Unix socket, expected daemon ID/data root and already
loaded digest. It never uses an implicit default Docker context. A preflight example:

```sh
python3 experiments/linux-execution/sandbox.py check \
  --docker-host unix:///owned-test/docker.sock \
  --docker-binary /reviewed/bin/docker \
  --daemon-id '<observed-reviewed-id>' --daemon-root /owned-test/docker-data \
  --work-root /owned-test/work \
  --image 'repository@sha256:<reviewed-digest>' \
  --admitted-image 'repository@sha256:<reviewed-digest>'
```

For real boundary qualification, the trusted operator first provisions the reviewed isolated
service and offline image. Join that daemon's **actual** network/mount namespaces, then run
`qualify_running_host.py --root /owned-test --unit openbot-qualification-<name>.service
--prefix <fresh-case-prefix>`. The helper requires an owned0700 root, pinned binaries/image,
private `daemon.json` identity evidence, private containerd and matching namespaces. It creates
only new synthetic Action subtrees and bounded ext4 files. Never run against a production or
shared daemon. Its provisioning interface is a qualification fixture, not a product API.

For native lifetime qualification, invoke `deadline_probe.py --help` on the reviewed Linux
host. This frozen host fixture uses `/opt/openbot-qualification-20260925-c8b2`; it must already
contain the reviewed offline archive/binaries and a root-owned `units` directory. It is not a
general host installer. Run `python3 deadline_probe.py run --name deadline-<fresh-id>
--case baseline` (or another listed case). Each invocation uses
a fresh unit name and cannot reuse a consumed Action. Internal `--root` modes are not the public
run interface. A new host/path requires explicit provisioning/review and fresh evidence. Preparation and offline load consume the
same original native lifetime. The helper checks empty stop hooks through typed systemd D-Bus
properties (the text CLI omits empty arrays), no restart, whole-cgroup SIGKILL and the original
invocation/cgroup. Exact temporary resource reconciliation happens after recording the verdict.

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
remaining time, including delayed start acknowledgement. Python's later kill/observation is
best effort; it does not survive controller death or an unreachable Docker daemon. A separately
qualified native per-Action unit contains every late-start producer. `deadline_probe.py`
qualifies that separate wrapper; calling `sandbox.py` alone does not acquire its guarantee. Recovery only inspects;
it cannot re-arm a deadline, replace a container or resend a command.

Collection hashes no-follow, single-link regular files incrementally, limits tree entries and
apparent bytes before reading sparse data, and rejects concurrent identity/size changes. Its
`enforced:false` describes collection itself: a digest/size check is not storage enforcement or
an authorized Artifact publication. Files and image/device evidence remain separate.

Python control must still consume the exact Task/Run/Action epoch, approval and resource grant,
serialize cancellation/revocation, and publish verified artifacts. Temporal retains continuation;
the host helper owns only execution/receipts. Browser sessions, supervised writes, takeover,
downloads and document/code deliverables need their separate contract journeys. No capability
is enabled merely because these command tests passed.
