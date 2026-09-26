# Research: isolated qualification on an existing Linux VPS

Date: 2026-09-25. Status: implementation and real-host qualification in progress;
no Linux capability is enabled by this record.

The Owner supplied an existing Ubuntu VPS for testing and authorized completion of
the migration, with dsh assistance. Read-only SSH established Ubuntu 24.04.4,
kernel 6.8.0-136-generic, x86-64, cgroup v2, systemd 255.4-1ubuntu8.17,
2 CPUs, about 8 GiB RAM, and an existing Docker 29.7.1 serving live applications.
The host address, keys, private inventories and connection details stay outside Git.

## Decision and reviewed sources

Reuse the exact [Linux execution review](linux-execution-boundary.md) pins:
Docker 29.8.1 / Moby `464cd50c3d9e92877d56940ea160de6fca7bea23`, gVisor
release-20260914.0 / `95eb5d5930b0e7736826cc2cb949ba9d2c4d5d29`, and the accepted
OpenBot command precursor at `bb37d57f21f7df964ff07be4033b6008c45e1b37`.
The precursor's prior 155 scripted/negative checks are not real-host acceptance.

The [Docker daemon reference](https://docs.docker.com/reference/cli/dockerd/)
marks multiple daemons experimental and requires distinct bridges, data/exec roots,
PID files, sockets and configurations. The [official binary installation guide](https://docs.docker.com/engine/install/binaries/)
supports a fixed static bundle for this disposable test. Replacing or reloading the
production daemon is unnecessary. No Docker/Moby source is copied; Apache-2.0 applies.
Official release metadata and the pinned release's integration tests were reviewed
in the existing Linux record; this qualification adds no competing execution platform.

Use systemd v255, already reviewed at
`db11bab38ccf1ed257f310d29070843d4c58ea01` (LGPL-2.1-or-later), with its native
[PrivateNetwork and PrivateMounts settings](https://github.com/systemd/systemd/blob/v255/man/systemd.exec.xml).
The former creates a network namespace with loopback only. The latter prevents
mount propagation back to the host; each Exec process has a distinct mount namespace,
so preparation must join the actual daemon namespace, not ExecStartPre. Verify
namespace identities and observed interfaces, because a requested setting alone is
not proof. No systemd source is copied. This uses a released dependency and thin
test provisioning, not a new sandbox or scheduler.

The [gVisor install guide](https://gvisor.dev/docs/user_guide/install/) supports the
host architecture/kernel. The exact GitHub release API reports the x86-64 archive
digest `94a1b9716797efcb0b348fc3283ddaa1ee5c7898b61eeccb08ee9ac7dc903c15`
and SHA256SUMS file digest
`9f3ea43fd4a01f67fc21ddab1d312b5c94a275fdf219957b1f461a51b1d22cd0`.
Verify both before extraction/execution, then record actual runsc binary identity.
Docker's official HTTPS static archive is downloaded into the task-owned directory;
record its measured digest separately from any upstream-published checksum. Do not
mislabel a locally measured digest as upstream attestation.

## Bounded host changes

Create a root-owned qualification directory and a transient systemd service with
private network/mount namespaces, delegated cgroups and bounded CPU/memory/tasks.
Use only the private Unix socket and separate data-root, exec-root, PID/config and
containerd state. Disable bridge, iptables, ip6tables, IP forwarding and masquerading
for the command profile. Preload pinned synthetic images offline; the test daemon
has no Internet route. Record production container ID/start/status and firewall
configuration before/after. Do not upgrade/restart existing containers or services,
edit host firewall/SSH, publish ports or use production data/credentials as fixtures.

Provision per-Action <=64 MiB persistent ext4 loop output inside the daemon's actual
mount namespace, nodev/nosuid/noexec, private propagation and UID 10001. The trusted
helper owns source ancestors and binds; untrusted workloads receive only approved
input/output, never daemon sockets or control keys. A separate browser profile still
requires its own network/proxy and authority qualification; command success does
not qualify browser takeover.

## Review and acceptance

dsh reviewed a bounded source-only packet without VPS or credentials. Its report is
advisory. Independently verify explicit daemon binding, created resource/mount shape,
durable ledger directory entries, bounded no-follow collection, crash recovery and a
supervisor-independent deadline. Do not adopt its suggested retry of a consumed
start reservation: unknown commands keep the original reservation and never resend.
An unstarted object can be reconciled/removed without silently granting a new launch.

Positive tests must measure actual runsc execution, output exhaustion/sparse rejection,
resource bounds and PID semantics, no-network canaries, one start under ACK loss,
daemon/controller interruption, deadline expiry and exact-owned cleanup. Product
authenticated admission/epoch fencing/receipt publication remain distinct gates.
Safe evidence will record exact binaries, commands, outcomes and limitations; private
inventory, host identity and keys remain in the task's temporary evidence directory.

Actual first create refused before start because Moby29.8.1 stores `--tmpfs` in
`HostConfig.Tmpfs`, absent from `Mounts`. Checked the exact pinned
[inspect source](https://github.com/moby/moby/blob/464cd50c3d9e92877d56940ea160de6fca7bea23/daemon/inspect.go):
HostConfig is copied separately and Mounts comes from GetMountPoints. The adapter
now validates the exact bounded Tmpfs map and rejects any conflicting explicit
mount, instead of demanding a synthetic Mounts entry. This fixes a real compatibility
refusal without relaxing the requested temporary-storage bound.

The second real attempt failed at runtime creation: cgroup v2 refuses enabling
subtree controllers while the daemon occupies that inner node. Reviewed systemd255
[`DelegateSubgroup`](https://github.com/systemd/systemd/blob/v255/man/systemd.resource-control.xml),
available since254. Move only this disposable service’s supervisor processes into
its native delegated subgroup, leaving the parent empty for per-container child
groups. Restart only the owned test service; preserve fixed daemon data/identity.
No cgroup limit is removed and no production cgroup is modified.

A deeper actual `docker info.Containerd` check found that the static daemon had
autodetected the host `/run/containerd/containerd.sock`; a distinct Docker socket
alone was insufficient. Only disposable creates occurred (no successful workload
start), but the offline Python image entered the shared cache. Do not delete that
cache blindly. Stop only the test daemon, remove exact-owned unstarted objects, and
start pinned containerd2.3.5 with independent root/state/gRPC socket in the same test
service namespace; set Docker’s containerd socket and namespaces explicitly. Verify
all production container IDs/start times/status and firewall hashes unchanged.
Reviewed [containerd2.3.5 operations/configuration](https://github.com/containerd/containerd/blob/v2.3.5/docs/ops.md)
and the pinned Docker daemon reference before this correction. The test wrapper
enables only delegated cpu/memory/pids/io/cpuset controllers before either daemon
initializes, so capability detection sees actual child controls. No upstream source
is copied. The earlier daemon-network check was real but did not prove complete
containerd isolation; this additional gate must pass before a positive claim.

Independent review reproduced two adapter defects before real acceptance: tmpfs
set inclusion admitted conflicting exec/dev/suid/size options, and generic float
formatting rounded a valid nine-decimal CPU request before NanoCpus readback. Require
an exact, duplicate-free tmpfs option set and a finite CPU value exactly expressible
in integer nanocpus before any reservation. Use standard-library Decimal for the
existing Docker numeric contract; reject non-integer values in the seven integer
limit fields. No added dependency/source copy. Independent directory-fsync failures
confirmed that no external create/start occurs and consumed slots cannot reopen.

### Actual bounded command cases and guest process limit

The isolated private-containerd configuration passed one CSV proof and then five real
runsc cases: read-only/non-root and network canaries; ext4 ENOSPC at57,327,616 bytes;
100GiB sparse output rejected before hashing in0.002 seconds; real start response
discarded followed by controller reconstruction with one original effect and no restart;
and a guest process-limit measurement. Every owned container, mount and loop attachment
was removed. [Sanitized evidence](../../experiments/linux-execution/REAL_HOST_BOUNDARY.json)
records source hashes. This does not qualify product authority or independent hard deadlines.

The guest set RLIMIT_NPROC32 and created31 children; the next fork failed with EAGAIN.
The pinned gVisor [`kernel.go:UserCounters.incRLimitNProc`](https://github.com/google/gvisor/blob/95eb5d5930b0e7736826cc2cb949ba9d2c4d5d29/pkg/sentry/kernel/kernel.go)
atomically enforces ProcessCount.Cur by real-user counter, except privileged capabilities
which this profile drops. Pinned Moby [`withRlimits`](https://github.com/moby/moby/blob/464cd50c3d9e92877d56940ea160de6fca7bea23/daemon/oci_linux.go)
maps explicit HostConfig.Ulimits to OCI POSIX rlimits, and inspect merges daemon defaults.
Therefore also request nproc=Limits.pids:Limits.pids and verify unique, strict integer
soft/hard values before start. Retain the separate host cgroup pids.max; guest processes
and gVisor host implementation threads are different counters. No source copied.

### Independent native lifetime, actual four-case acceptance

The separate per-Action wrapper reuses the already reviewed systemd255
[service lifetime and restart settings](https://github.com/systemd/systemd/blob/v255/man/systemd.service.xml)
and [whole-cgroup kill settings](https://github.com/systemd/systemd/blob/v255/man/systemd.kill.xml).
Each fresh transient unit owns private Docker/containerd/runsc state and all possible late-start
producers, has RuntimeMaxSec60, Restart=no, KillMode=control-group, initial/final SIGKILL and no
stop hooks. PrivateNetwork/PrivateMounts, delegated subgroup,2500MiB memory/zero swap,150% CPU
and1536 host tasks bound the supervisor tree. Guest limits and64MiB output remain separately
checked. Offline image load/preparation consume the same lifetime; recovery cannot re-arm it.
This is a thin qualification wrapper, not another recovery engine. No upstream source copied.

Actual preflight first refused the gVisor archive's `gvisor-bin` directory shape; validation now
checks the trusted directory plus every executable separately. Two subsequent fresh cases
refused before image/workload because systemctl255 omits empty ExecStop/ExecStopPost even with
`--all`. Read typed properties through native busctl and require exact empty `a(sasbttttuii)`
arrays; absent or nonempty values remain a refusal. Original negative receipts are retained.
Their unattached64MiB backing files were later removed only after proving exact ownership,
inactive original unit, empty cgroup and no loop association. A further preflight refused the
unlabelled offline OCI import. Give the verified loaded digest its exact local tag and still
check RepoDigest independently; no pull or invented digest is used.

[REAL_HOST_DEADLINE.json](../../experiments/linux-execution/REAL_HOST_DEADLINE.json) records the
same final source hashes and four actual fresh units: baseline, dead controller, SIGSTOP private
Docker daemon, and one queued Unix-HTTP start behind a paused daemon. All original invocations
ended with Result=timeout, Restart count0 and empty original runtime trees before any cleanup
verb. The first three contained supervisor/shim/sentry/gofer; the queued case produced neither
start nor heartbeat marker. Each durable start reservation remained consumed, with no resend
and unknown business outcome. Native cessation is not an effect receipt.

Observed stop latency after the nominal deadline was0.300188,0.259318,0.118147 and0.165902
seconds. The predeclared observation allowance was5 seconds. Ordinary systemd timer coalescing
and kernel scheduling do not establish an exact hard real-time boundary or guarantees for
untested hosts. Every owned tree, mount and loop device was cleaned; original10 production
container identities/start times/restart counts/state matched, and IPv4/IPv6 firewall rules
matched after removing packet counters/comments and normalizing whitespace. Original
counter-sensitive hashes alone were inconclusive. The final comparison is semantic evidence.

Product Work admission/online consumption, exact Node connection identity, signed receipts,
artifact verification, partition behavior and browser/takeover remain separate acceptance gates.
The standalone sandbox's best-effort deadline claim is intentionally unchanged.
