# Output capacity prerequisite review — 2026-09-24

Status: experiment-only prerequisite check; no Linux/runsc qualification.

The existing candidate records `output_mib` but mounts an ordinary host directory writable.
Collection detects excess bytes only after the write. The smallest independent correction is
to refuse create/start unless the trusted host has provisioned a separate, persistent, bounded
filesystem for that Action. This implements a prerequisite for the fixed-size-filesystem
fallback already described in README.md. It neither provisions a filesystem nor adds authority.

## Reused sources and fixed review

- Existing selection: Docker Engine 29.8.1 / Moby
  `464cd50c3d9e92877d56940ea160de6fca7bea23`, runsc release-20260914.0 /
  `95eb5d5930b0e7736826cc2cb949ba9d2c4d5d29`, as reviewed in
  [the Linux boundary research](../../docs/research/linux-execution-boundary.md).
- Linux **v6.12** source release: [proc documentation](https://github.com/torvalds/linux/blob/v6.12/Documentation/filesystems/proc.rst),
  [ext4 statfs](https://github.com/torvalds/linux/blob/v6.12/fs/ext4/super.c),
  [VFS statfs](https://github.com/torvalds/linux/blob/v6.12/fs/statfs.c).
  `fdinfo` identifies the open descriptor's mount; mountinfo identifies its device, filesystem
  root and mountpoint. ext4 statfs reports data capacity after overhead and can apply project
  quotas, so statvfs alone is insufficient to prove a dedicated device's total capacity.
- Python **3.12.13**, already used by the repository, exposes `os.open`, `fstat`, `fstatvfs`
  and descriptor-relative proc inspection through its standard library. No new dependency.
- Linux [genhd.c `part_size_show`](https://github.com/torvalds/linux/blob/v6.12/block/genhd.c)
  exports device `size` as `bdev_nr_sectors`; [blk_types.h](https://github.com/torvalds/linux/blob/v6.12/include/linux/blk_types.h)
  defines a sector as 512 bytes. Check both the device size and filesystem capacity
  against the admitted bound. Do not mistake free space for a write-time quota.
- [Docker tmpfs documentation](https://docs.docker.com/engine/storage/tmpfs/) confirms loss on
  stop/restart; tmpfs remains suitable for temporary scratch, not durable output.

Searches: `Linux mountinfo fdinfo mnt_id statvfs`, `Linux ext4_statfs f_blocks project quota`,
`Linux sysfs-block size 512`, `Docker tmpfs contents lost`. Reviewed the existing XFS proposal;
its provisioning and quota-control path still requires a Linux host and privileges. The narrow
check uses native Linux filesystem facts instead of adding a quota daemon or implementing a
filesystem. Linux is GPL-2.0; Python is PSF licensed; no source is copied or substantially adapted.
No claim about an arbitrary filesystem follows from the v6.12 ext4 review.

## Check and limits

Open the output directory without following its final symlink, bind all observations to that
descriptor, require its exact mountpoint and filesystem root, and permit only ext4. Refuse
volatile/overlay/network filesystems, shared propagation, nested/aliased mounts, read-only mounts,
missing device information, or a device larger than the Action's output limit. The device,
inode, mount and total capacities are recorded before create and read again before start.
A missing or changed record cannot start. There is no CLI flag that bypasses this prerequisite.

This check relies on a trusted host owning provisioning and the mount namespace throughout the
Action, including persistent backing storage (ext4 on a RAM-backed loop device is not durable).
Filesystem type alone does not prove durability. The check does not prove that the Docker daemon
resolves the same path/mount namespace, prevent
a privileged host from resizing or replacing it, or make host storage crash-proof. The existing
final-mount race remains open. Device capacity limits allocated storage, while sparse files can
have larger apparent sizes; collection must still check deliverable sizes. No positive capacity
claim is accepted until exhaustion/restart tests run on the reviewed Linux/runsc profile.

## Available environment

On this task's Mac, the existing Docker Desktop reports LinuxKit `6.12.76-linuxkit`, aarch64,
cgroup v2, Engine `29.5.2`, overlayfs/containerd image storage and runc only. It is not the target
Linux x86-64/runsc profile. It can run disposable synthetic filesystem negative probes without
host provisioning, devices, capabilities, network, user data or Docker socket in the probe.
The cached repository-pinned Python image is
`python:3.12.13-slim-bookworm@sha256:6e13e65c55e33adf203d77ee371cf8bf5d81bd4902ef07565721f46bf44917af`
(linux/amd64, emulated on the arm64 host). Positive bounded-ext4 and runsc tests remain blocked.

## Focused evidence

The real child process wrote and fsynced 2 MiB in an ordinary output directory despite the
Action's 1 MiB limit. The new verifier refused that directory and the surrounding tmpfs mount
using actual `/proc/self/fdinfo` and mountinfo, without mocked host facts. See the exact
[probe output](evidence/output-capacity-linuxkit-20260924.json). This only establishes negative
filesystem evidence: it is not a real CommandSandbox create/start run or a quota exhaustion test.
The pinned Python image does not include the Docker CLI. An attempted lifecycle extension to
the probe correctly failed at CLI construction; that extension was removed, not bypassed.

The default suite passes 139 lifecycle cases with a scripted Docker boundary and an explicit
capacity fixture, plus 16 verifier cases with injected ext4/kernel observations. These cover
unverified storage before any create/ledger write, changed or missing proof before start,
durable proof instead of caller-supplied capacity, one consumed start attempt on refusal,
oversized devices despite little free space, unsafe/nested mounts, missing kernel facts,
symlinks and mount topology changes. They do not qualify a real ext4 device.

The previous full `npm run check` passed at `f9ebb1a`. This follow-up changes only this experiment;
the affected Python suite and repository documentation checks are rerun, while unrelated long
product tests reuse that recorded result as requested.
