# Protected offline command Host — inactive Linux candidate

This is an executable candidate for the reviewed command-only path. It adds a protected Unix Host
and fixed native helper; it does not register a product tool or grant Work authority. Node remains
an untrusted relay. Control must supply the existing v2 approval/admission/online-consume/lookup
proofs. Browser is outside this host. Actual Linux/systemd/runsc acceptance is still required.

## Files and entry points

- `protected_host.py --config /operator/chosen/root-owned/config.json`: the only Unix service. It holds
  the enforcement private key and Control public pins outside every per-Action unit.
- `protected_native.py`: fixed `daemon`, `execute`, `lookup`, `lookup-output` helper modes, invoked
  only by the protected Host. It uses the existing `sandbox.py`, `output_capacity.py` and the narrow
  readback helpers in `deadline_probe.py`. It does not run the old qualification workload.
- `protected_io.py`: bounded raw framing and exclusive no-follow/fsync records; no execution policy.
- `LinuxNative.cleanup(original_record)`: explicit trusted-operator cleanup after stopping the Unix
  transport and the original unit. It is not exposed on the Node socket. It verifies the terminal
  original invocation, empty original cgroup, exact loop backing/inode/device before detach, and
  retains the original reservation/ledger. Unknown unit/loop identity refuses cleanup.

Use the existing Python 3.12 environment with the already locked pure command dependencies and
`apps/server-python/src` on PYTHONPATH. No model, PostgreSQL, Temporal service or provider account is
required by the Host. Its pure v2 modules must be the integrated readiness version. The fixed native
source directory must contain the three new source files plus existing sandbox, output_capacity
and deadline_probe. Do not install a second execution framework or dynamically generate helper code.

## Protected configuration and host prerequisites

Configuration is operator supplied, root-owned, mode0600, in a root-owned mode0700 directory. All
ancestors must be real directories with root ownership and no group/world write; symlink paths are
refused. The key is mode0600 with one link in the configured private secrets directory. State and
secrets directories must be distinct. The socket lives in a dedicated root-owned mode0750 directory
with the configured Node group; its mode is0660. Node must run as the explicit nonzero nodeUid,
without root, sudo, Docker, key, ledger, input-ancestor or native-helper privileges. Linux SO_PEERCRED
must match that uid; filesystem group access alone is insufficient.

The exact top-level configuration keys are:

```
state, socket, nodeUid, nodeGid, route, policy, controlIssuer, enforcementIssuer,
native, privateKey, controlPins
```

`route` is the trusted Server-selected `{nodeId,providerId,enforcementKeyId,ledgerId}`.
`policy` is the exact reviewed v2 TimingPolicy; this candidate accepts runtimeMaxMs<=50000 and
stopAllowanceMs=5000, with no implicit clock qualification. `controlPins` is a nonempty list of at
most eight `{kid,path}` public PEM entries for controlIssuer. No key/token is sent in producer env.
Every incoming signed record must match this fixed route and its own original binding.

`native` has exactly these keys:

```
base, binaries, archive, archiveSha256, image, imageTag, sources, sourceHashes,
binaryHashes, python, pythonPath, secretsDirectory
```

The base is a short, actual private directory such as `/opt/obh`; the full UUID maps to a protected
12-hex subdirectory, while the protocol unit name retains the full UUID. Socket paths are checked
before unit submission, including Docker ExecRoot/libnetwork/<12hex>.sock and containerd shim
paths. A long base fails rather than silently using a shared path. `binaries`, `sources` and
`secretsDirectory` are real root-owned mode0700 directories. `python` is an operator-selected trusted
root-owned interpreter from the existing pinned environment; pythonPath contains trusted root-owned
source roots. `sourceHashes` must name exactly protected_native.py, protected_io.py, sandbox.py,
output_capacity.py and deadline_probe.py, with SHA256s of the deployed copies. `binaryHashes` must
match the ten published REAL_HOST_DEADLINE binary hashes (also fixed in this adapter).

The admitted offline image/archive are the exact prior reviewed Python image and archive digest from
REAL_HOST_DEADLINE; there is no registry pull or arbitrary image import. `imageTag` names that same
repository's local tag for the loaded untagged OCI archive; preflight independently checks the
repository digest. This first native profile uses a dedicated64MiB ext4 output filesystem, so a
command requesting a different outputMiB is refused. Per-container output disclosure is <=1MiB of
one strict UTF-8 text/plain or text/csv file; NUL, symlinks, sparse oversize and extra outputs refuse.

The host must provide the reviewed Linux x86-64/cgroup-v2/systemd255 environment and exact Docker
29.8.1/containerd2.3.5/runsc release-20260914.0 systrap binaries. All new per-Action units use private
mount/network namespaces, delegated supervisor subgroup, fixed2500MiB memory/zero swap,150% CPU and
1536 host tasks, no restart, control-group SIGKILL and no stop hooks. RuntimeMax is fixed before
submission and never exceeds50s. Guest resource/read-only/non-root/network/mount/PID checks are
reused from the precursor. The daemon sets local logging compress=false explicitly; typed container
readback must preserve it before start, without increasing log capacity.

The namespace prerequisite is explicit: systemd mounts `/run/containerd` as a fresh private tmpfs,
16MiB, root0700, nodev/nosuid/noexec, inside this unit only. The daemon helper verifies the actual
mount descriptor/type/path/propagation/owner/mode and total capacity before spawning containerd.
It never mounts over or cleans the host's shared /run. This property needs fresh Linux acceptance;
the older native deadline evidence did not test it.

## Once-only lifecycle and wire behavior

The raw Unix stream has a four-byte unsigned big-endian length followed by1..32768 bytes of strict
UTF-8 JSON. Duplicate keys, invalid UTF-8/surrogates, nonfinite values, wrong fields/version/direction,
oversize and unknown correlation fail closed. Protocol is0.10.0. Exactly one relay connection is
accepted per Host process; timeout/disconnect closes all live nonce/output scopes, with no reconnect
or replay. The protected durable records remain. A later Host instance may only query existing
Actions using a fresh signed control challenge, never restore preparation/consume slots or re-arm.

After prepare_open, the Host emits its <=5s BOOTTIME/boot/instance challenge. Only the exact approved
Server authorization may reserve the original protected directory and unit. O_EXCL plus file and
parent-directory fsync precede external unit/create/start effects; failure or lost ACK leaves the
slot consumed. The fixed daemon helper checks actual CLOCK_BOOTTIME, boot ID and protected current
Host instance before containerd and again before dockerd. No model argv is present in preparation.
All producers belong to the original unit; a Host timeout is not the native kill guarantee.

Send input_chunk after prepare_authorize, without waiting for ready. The Host acknowledges each
continuous offset; at most eight flat files and20MiB total are accepted, each chunk<=16KiB. Ready is
sent only after original length/hash verification and actual protected runtime/unit/cgroup/namespace
readback. Empty manifests need no chunk. Dispatch must bind that ready digest and immutable operation.
A fresh online consume challenge precedes the sole permit. The Host derives a conservative fixed
local BOOTTIME launch bound from its causal interval and persists it before invoking execute. The
fixed execute helper joins the original namespaces/cgroup and rechecks the original guard immediately
before create and start. The precursor separately fsyncs each create/start reservation. Unknown
execution never repeats either verb and never proves success.

Lookup/stop use control_open/control_challenge and a current Server-signed exact nonce/request/digest
reply. Stop never grants output. Lookup signs a bounded observation with a persistent sequence and
original dispatch/epoch/permit. Each output chunk requires the same live includeOutput permission
and fixed causal interval; changed/expired/closed scope prevents further disclosure. The live book
has64 slots with no eviction; durable action roots also cap at64. Up to4096 observation records per
Action are retained. Exhaustion refuses; cleanup does not reopen the original Action or ledger.

## Validation and remaining acceptance

Focused tests run without native effects:

```sh
PYTHONPATH=apps/server-python/src:experiments/linux-execution \
  apps/server-python/.worker-venv/bin/python -m pytest -q \
  experiments/linux-execution/protected_host_test.py \
  experiments/linux-execution/protected_native_test.py
```

The packet runner accepts the checkout path and uses the same files.58 tests passed, including a
complete signed preparation→ready→dispatch→consume→receipt/output flow over a real local Unix socket,
actual local peer credentials and disconnect. Native clocks, subprocess/readback and command effect
are explicit fakes. Negative coverage includes input/offset/hash/links, replay/restart, route/epoch,
late lookup/output expiry, durable fsync failure, limits, wrong invocation, final guard after create,
UTF-8/raw lengths, and private shim-mount readback. No Linux unit, daemon, mount, workload, VPS, real
provider, user profile, database or model request ran in these tests.

Before enabling: run the original command workload through the actual Linux adapter with configured
low-privilege Node and protected Unix endpoint; check fresh systemd mount/resource/native guard
readback, one unit/create/start under dropped ACKs and restart, deadline cessation, exact bytes and
signed receipt/artifact review, expired/cancelled/revoked refusal, and exact-owned cleanup. The Host
must be qualified as non-suspending with the accepted timing/stop allowance; this is not unconditional
hard real-time scheduling. After native death or unavailable original daemon, lookup reports unknown
and does not offline-parse Docker state or remount old output to invent a successful receipt. Preserved
output/backing data and unknown loop ACKs require explicit operator reconciliation. Product current-
authority issuance, Work settlement and artifact/result review remain separate integration gates.
