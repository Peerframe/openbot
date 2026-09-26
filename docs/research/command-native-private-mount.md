# Explicit private propagation for the bounded native command unit

2026-09-25. Research precedes implementation. Reuse the existing protected native adapter,
protected_io, output_capacity mountinfo parser, and fixed systemd 255 release commit
`db11bab38ccf1ed257f310d29070843d4c58ea01` (LGPL-2.1-or-later). No dependencies, framework,
upstream runtime code, or new execution authority are added.

Actual diagnosis: the separately authorized original 5-second mount-only unit observed a private
mount namespace with `/run/containerd` tmpfs, root uid, mode 0700, exactly 16 MiB,
rw/nosuid/nodev/noexec, and the optional field `shared:409`. It failed the existing empty-propagation
assertion before any Docker or guest. That unit ended by its original timeout, its cgroup emptied,
and all ten production containers and IPv4/IPv6 firewall semantics were unchanged. The original
failed command case and this observer are immutable evidence, not reusable execution slots.

Primary sources checked:

- [systemd 255 namespace.c](https://github.com/systemd/systemd/blob/db11bab38ccf1ed257f310d29070843d4c58ea01/src/core/namespace.c):
  setup_namespace first makes the namespace slave recursively; the final default is shared,
  applied recursively after new tmpfs mounts. Explicit private changes that final propagation.
- [systemd 255 systemd.exec](https://github.com/systemd/systemd/blob/db11bab38ccf1ed257f310d29070843d4c58ea01/man/systemd.exec.xml):
  PrivateMounts and propagation are distinct. MountFlags=private prevents incoming host unmounts,
  so upstream discourages it for general long-lived services. This candidate uses fixed preloaded
  paths, a non-restarting per-Action unit, RuntimeMax<=50 seconds and a five-second observation
  allowance. It does not rely on receiving subsequent host mounts. Retention is bounded by that
  original unit's verified termination, not a reusable daemon or child outside its cgroup.
- [systemd 255 dbus-execute.c](https://github.com/systemd/systemd/blob/db11bab38ccf1ed257f310d29070843d4c58ea01/src/core/dbus-execute.c):
  the Service execution context exports MountFlags with D-Bus signature `t` (uint64), not `s`.
  The transient setter validates a mount propagation flag. The reviewed readback therefore requires
  exactly `{type: "t", data: 262144}` with a real JSON integer, not a boolean or textual substitute.
- [systemd 255 bus-unit-util.c](https://github.com/systemd/systemd/blob/db11bab38ccf1ed257f310d29070843d4c58ea01/src/shared/bus-unit-util.c):
  systemd-run's MountFlags property is parsed with mount_propagation_flag_from_string and encoded
  as uint64. The request stays `MountFlags=private`; the readback does not guess systemctl formatting.
- [systemd 255 busctl.c](https://github.com/systemd/systemd/blob/db11bab38ccf1ed257f310d29070843d4c58ea01/src/busctl/busctl.c):
  get-property JSON uses json_transform_variant: signature plus a scalar integer. The Manager
  GetUnit method result uses the message tuple: signature `o` plus a one-element path array.
- [Linux v6.8 UAPI mount.h](https://github.com/torvalds/linux/blob/v6.8/include/uapi/linux/mount.h):
  the stable MS_PRIVATE ABI is `1<<18` (262144); shared/slave and recursive combinations differ.
- [proc_pid_mountinfo(5)](https://man7.org/linux/man-pages/man5/proc_pid_mountinfo.5.html):
  the existing exact descriptor mount-ID and optional propagation validation is retained.

Decision: set the one fixed unit property, validate its typed D-Bus value before producer creation
and on live-unit checks, and retain the actual tmpfs empty-propagation check. A flag/readback error
fails before containerd. No automatic retry, fallback propagation, alternate unit, or changed nonce
is introduced. The separately approved complete case2 now passed on the actual Linux Host:
typed MountFlags readback was `t:262144`, the16MiB shim tmpfs had empty propagation fields,
and the enforcer key was hidden from the unit. Exactly one original start produced the expected
18-byte CSV with a verified signed receipt. Original50-second expiry was observed155ms later,
within the unchanged five-second margin; the original cgroup emptied, private runtime/backing
resources were removed, keys deleted and the unit released. All10 existing containers and both
firewall rule sets were unchanged. [Public evidence](../../experiments/linux-execution/REAL_PROTECTED_COMMAND.json)
retains the synthetic Control boundary: this is not the full real Work/Temporal product chain.

The first case2 staging attempt refused the original package's stale whole-manifest pin before
creating any reservation/key/unit. Read-only comparison showed exactly the two previously
accepted stage/qualification layout fixes, with every other entry unchanged. Only that expected
manifest pin was corrected; Host, Native and crypto implementation hashes remained unchanged.
The original failed staging record and original case evidence were retained.

The qualification evidence serializer changes the fractional delay field to integer milliseconds;
its strict canonical JSON boundary stays unchanged. That corrects recording only, not the original
failure or any execution result. Root owns an independent Host live-control-slot fix; its finalized
hashes will be reviewed into the same original payload categories before a new upload list freezes.
