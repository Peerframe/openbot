# Protected offline command host: bounded implementation review

2026-09-25. Scope: actual candidate adapter and local Unix tests, no Linux unit/VPS execution here.
Research precedes implementation. The accepted readiness design/139 tests, WORK_COMMAND_COMPONENTS,
REAL_HOST_DEADLINE.json, deadline_probe.py, sandbox.py, output_capacity.py and linux-vps-qualification
were read. Existing exact pins are retained: systemd255 db11bab38ccf1ed257f310d29070843d4c58ea01
(LGPL-2.1-or-later), Docker29.8.1/Moby464cd50c3d9e92877d56940ea160de6fca7bea23 (Apache-2.0),
containerd2.3.5, runsc release-20260914.0/95eb5d5930b0e7736826cc2cb949ba9d2c4d5d29 (Apache-2.0),
current locked Python JOSE/JCS. Their releases, tests, issue/advisory and platform fit reviews are
reused from those records, not re-asserted from package popularity. No new dependency/install.

Additional primary documents checked now: Python3.12 socket and os.setns
(https://docs.python.org/3.12/library/socket.html and https://docs.python.org/3.12/library/os.html#os.setns),
Linux man-pages6.19 unix(7) SO_PEERCRED (https://man7.org/linux/man-pages/man7/unix.7.html),
and pinned systemd service semantics
(https://github.com/systemd/systemd/blob/db11bab38ccf1ed257f310d29070843d4c58ea01/man/systemd.service.xml).
Python's released standard library is the first viable framing/socket/file primitive; no separate
RPC service/framework is warranted. Actual Linux SO_PEERCRED uid is mandatory; macOS local tests use
its native peer credential reader only for the test socket boundary, not Linux qualification.

Reuse: import the accepted sandbox for immutable create/start ledger, Docker command/resource/readback,
no-follow collection and subprocess capture; import output_capacity for real ext4 bound. Reuse pure
v2 schemas/JOSE/causal pending book without another cryptographic implementation. Native adapter is a
small per-Action systemd wrapper around these APIs, with fixed daemon/helper modes and no arbitrary
executable method. No upstream source is copied. OpenBot-specific additions bind current signed
messages to one protected directory/nonce/native unit, implement fixed 4-byte BE framing and sequential
bounded manifest transfer, and keep the signing key outside the whole-producer unit.

Security decisions: root-owned fixed configuration, binary/source/archive SHA pins, low-privilege
nonzero Node uid, dedicated group-traversable socket directory, SO_PEERCRED uid check, root private
state/secrets; no credential or filesystem path supplied by wire. Startup guard in fixed daemon mode
reads actual CLOCK_BOOTTIME/boot ID and current protected instance identity before any producer and
again before spawning daemon children. Fixed <=50s native runtime plus <=5s observed stop allowance;
short roots are allocated independently from the full protocol UUID unit name, and every private
Unix path including docker-exec/libnetwork/<12hex>.sock is checked before reservation side effects.
Persistent O_EXCL/fsync reservations precede unit/create/start, unknown never retries. No scheduler,
automatic cleanup loop, clock service or replacement approval plane is introduced.

Focused evidence will cover real local sockets/strict raw bytes plus fake native command/readback
boundaries. Real systemd/native namespace/cgroup/runsc behavior, producer output and stop latency need
root's subsequent exact-owned Linux qualification; test fakes cannot claim those gates passed.

Additional runtime compatibility: root's actual Moby29.8.1 pre-Sentry browser probe found local
logging max-file=1 incompatible with default compression. The same daemon option is relevant here:
explicit compress=false is added without raising storage limits, and actual per-container typed
LogConfig.Config.compress must equal the string false before start. The existing precursor's
per-container max-file=2 bound remains unchanged. Primary source is the same pinned Moby
`daemon/logger/local/config.go` (lines61–63); no alternative logger implementation is introduced.
Containerd2.3.5 `pkg/shim/util_unix.go` was also inspected for its 106-byte socket limit and hashed
socket-root names; libnetwork's unhashed ExecRoot path is preflighted separately. No source copied.

The integrator accepted one fixed namespace prerequisite before freeze: pinned systemd255
[TemporaryFileSystem](https://github.com/systemd/systemd/blob/db11bab38ccf1ed257f310d29070843d4c58ea01/man/systemd.exec.xml)
mounts /run/containerd as a private 16MiB tmpfs with nodev/nosuid/noexec and root mode0700. This masks
containerd's fallback shim socket directory only inside this unit's mount namespace. The fixed
helper validates descriptor mount identity, exact path/type/options/private propagation, owner/mode
and actual statvfs total capacity before spawning containerd. It neither manually mounts over nor
cleans the host /run/containerd. This newly requested namespace property is not covered by the older
REAL_HOST_DEADLINE evidence and requires fresh actual Linux qualification.
# Completed control exchange lifecycle (2026-09-25)

Product integration exposed a boundedness/liveness mismatch in the existing exchange book:
completed readbacks retained one of the64 live slots forever. Waiting on a legitimate original
command could exhaust them. Reuse the existing HostExchangeBook and reviewed JOSE nonce/binding
checks; no transport, crypto algorithm or third-party dependency is added. Release only a
successfully consumed control exchange after its stop, no-byte observation, or final output ACK.
Retain a bounded set of4096 completed request IDs in that Host instance so the same ID cannot
create another exchange. Original preparation/Action reservations remain retained, as do durable
observation/stop records. A disconnected or incomplete output is never treated as completed.
The64 live-exchange and64 durable-Action bounds remain unchanged. This is local lifecycle glue
around the existing pinned implementation, with no copied upstream source.
