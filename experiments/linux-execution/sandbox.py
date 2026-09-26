"""Command-only Linux execution boundary: explicit conformance precursor.

This module is an experiment, not product code. It owns no Server authority: it does not admit
actions, reserve budget, publish artifacts or decide policy. It demonstrates one narrow thing —
that a bounded, immutable, single-launch command container can be created, observed and cleaned
up only through the reviewed Docker OCI lifecycle verbs, with an append-only ledger that makes a
duplicate launch visible instead of assuming it did not happen.

Design constraints taken from docs/research/linux-execution-boundary.md and recorded again in
README.md: one container per immutable Action, non-root UID, read-only root and input, no
network, bounded tmp/memory/PIDs/descriptors, host-enforced wall time, no runtime download and
no runc fallback. The Docker CLI is invoked as a fixed argv list through a single adapter; no
shell is involved, so a command argument can never be re-interpreted as a second command.

Lifecycle invariants enforced here (each has a unit case in test_sandbox.py):

* the container ID is persisted to the ledger, and flushed, before ``start`` is issued;
* a second ``start`` for the same Action and epoch is refused, never retried;
* an unknown Action is inspected, never re-created, and absence of daemon records is reported as
  unknown rather than as proof that nothing ran;
* the exit code is read back from ``inspect``; if the blocking ``wait`` primitive disagrees, the
  outcome is recorded as conflicting and no success is claimed;
* cleanup removes only objects carrying this experiment's owner label and attempts every owned
  object even when an individual removal fails.

Output storage must pass a read-only kernel capacity prerequisite before create and start.
Provisioning and Linux/runsc exhaustion/restart qualification remain unavailable, so collection
still reports output size as an observation, not an accepted write-time enforcement claim.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform as host_platform
import re
import selectors
import shutil
import signal
import stat
from decimal import Decimal
import math
import subprocess
import sys
import threading
import time
from typing import Any, Callable, Iterable, Mapping, Sequence

from output_capacity import OutputCapacityRefused, verify_output_capacity

try:  # POSIX advisory locking; the reviewed host is Linux and the default tests run on POSIX.
    import fcntl
except ImportError:  # pragma: no cover - no Windows host is claimed or tested
    fcntl = None  # type: ignore[assignment]

# Fallback only for a platform without ``fcntl``. The real cross-process serialization is the
# file lock below; this process-local lock at least keeps two threads in one process ordered.
_FALLBACK_CREATE_LOCK = threading.Lock()

# --- Reviewed pins -----------------------------------------------------------------------------
# Source of the component decisions: docs/research/linux-execution-boundary.md (Docker Engine
# 29.8.1 / gVisor runsc release-20260914.0 / OCI runtime spec v1.3.0). These constants repeat the
# values the preflight compares, so a host that does not match fails instead of silently
# running a different runtime.
REVIEWED_DOCKER_ENGINE_VERSION = "29.8.1"
REVIEWED_DOCKER_ENGINE_COMMIT = "464cd50c3d9e92877d56940ea160de6fca7bea23"
REVIEWED_RUNTIME_NAME = "runsc"
REVIEWED_HOST_SYSTEM = "linux"
REVIEWED_HOST_MACHINES = ("x86_64",)
REVIEWED_CGROUP_VERSION = "2"

# Lifecycle and ownership labels. Ownership is a label, not a name prefix alone: cleanup checks
# both, because a name is guessable while the owner label is written by this experiment only.
EXPERIMENT_OWNER = "linux-execution-precursor"
OWNER_LABEL = "openbot.experiment.owner"
ACTION_LABEL = "openbot.action.id"
DIGEST_LABEL = "openbot.action.digest"
EPOCH_LABEL = "openbot.action.epoch"
CONTAINER_NAME_PREFIX = "openbot-linux-exec-"

# Container-side paths are fixed by this module. No caller-supplied container path is accepted,
# so a spec cannot ask for a bind mount over /etc, the Docker socket or another Action's output.
INPUT_DESTINATION = "/input"
OUTPUT_DESTINATION = "/output"
TMP_DESTINATION = "/tmp"
NON_ROOT_USER = "10001:10001"

# The precursor never forwards environment variables into the workload: the reviewed envelope has
# no admitted way to inject them, and an inherited secret is exactly what must not happen. The
# deny list below is a second, independent check on environment variables the *image* declares.
SECRET_ENV_PREFIXES = (
    "OPENBOT_",
    "AWS_",
    "AZURE_",
    "GOOGLE_",
    "OPENAI_",
    "ANTHROPIC_",
    "GITHUB_",
    "DOCKER_",
    "PG",
    "POSTGRES",
)

ACTION_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
IMAGE_DIGEST_PATTERN = re.compile(r"^[^@\s]+@sha256:[0-9a-f]{64}$")
DIGEST_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
# A container ID is the daemon's immutable object identity: bare 64-character lowercase hex. An
# image digest is a different type: content-addressed and prefixed with ``sha256:``. Applying the
# digest shape to a container rejects every real container, and treating a digest as an ID accepts
# an object identity that was never a container. The two validators are deliberately separate.
CONTAINER_ID_PATTERN = re.compile(r"^[0-9a-f]{64}$")
MAX_COMMAND_ARGUMENTS = 64
MAX_COMMAND_ARGUMENT_CHARACTERS = 4096

# Agreed initial ceilings from the research document. They are validation bounds, not measured
# capacity: a command needing more must be admitted with a new resource envelope.
LIMIT_CEILINGS = {
    "cpus": 1.0,
    "memory_mib": 512,
    "pids": 512,
    "nofile": 256,
    "tmp_mib": 32,
    "wall_seconds": 60,
    "output_mib": 64,
    "captured_output_kib": 1024,
}

# Bounded capture. The CLI adapter retains at most this many bytes of combined stdout/stderr
# (derived from the admitted ``captured_output_kib`` ceiling), and each container is created with a
# per-container bounded Docker log driver so the daemon does not keep an unbounded json-file log.
# ``captured_output_kib`` therefore bounds both in-memory capture and the daemon-side retention; a
# rotated daemon log is never read back as if it were the command's complete stdout/stderr.
DEFAULT_CAPTURE_LIMIT_BYTES = LIMIT_CEILINGS["captured_output_kib"] * 1024
CAPTURE_READ_CHUNK_BYTES = 64 * 1024
OUTPUT_HASH_CHUNK_BYTES = 1024 * 1024
DOCKER_LOG_DRIVER = "local"
DOCKER_LOG_MAX_FILE = 2
DOCKER_LOG_MIN_MAX_SIZE_KIB = 8

# What this precursor actually enforces, and what it does not. ``describe_support`` publishes this
# table so an unimplemented bound cannot be mistaken for a working one.
ENFORCED_BOUNDS = {
    "read_only_root": "Docker --read-only",
    "non_root_uid": "Docker --user 10001:10001",
    "dropped_capabilities": "Docker --cap-drop ALL plus --security-opt no-new-privileges",
    "network_none": "Docker --network none",
    "memory_mib": "Docker --memory/--memory-swap",
    "cpus": "Docker --cpus",
    "pids": "Docker --pids-limit (host cgroup pids.max)",
    "nofile": "Docker --ulimit nofile",
    "tmp_mib": "Docker --tmpfs size= (kernel-enforced at write time)",
    "daemon_log_retention": (
        "Docker local log driver with per-container max-size/max-file read back from the daemon "
        "before start; the daemon default (json-file, no rotation) is never used"
    ),
}
UNAVAILABLE_BOUNDS = {
    "output_write_time_bound": (
        "Create/start require verified dedicated ext4 device capacity, but host provisioning, "
        "daemon mount identity and Linux/runsc exhaustion/restart qualification remain open. "
        "Collection alone cannot stop the command from filling host storage; its output size "
        "is still an observation, not a qualified write-time enforcement claim."
    ),
    "guest_process_limit": (
        "Explicit guest RLIMIT_NPROC matches the admitted pids value and is read back before "
        "start; full runtime qualification is separate from the host cgroup pids bound."
    ),
    "independent_wall_deadline": (
        "The standalone Python deadline and docker kill do not survive controller failure. "
        "An independently qualified native unit must enclose all late-start producers."
    ),
    "network_canary_proof": (
        "This precursor does not place live canaries on forbidden routes, so it does not prove a "
        "firewall. It only asserts that the container is created with no network."
    ),
    "final_mount_race": (
        "The input manifest and data paths are re-confined and re-hashed immediately before the "
        "create verb, but this is a point-in-time check. The daemon resolves the bind source after "
        "this process returns, so a host actor that can rewrite the path in that last window is "
        "not closed out. This precursor is not host isolation and makes no such claim; a reviewed "
        "privileged helper that owns the path is required to remove that race."
    ),
}


class ExecutionError(Exception):
    """Base class for every refusal this experiment can raise."""


class InvalidAction(ExecutionError):
    """Malformed or out-of-envelope input. Raised before any Docker command is issued."""


class UnsupportedCapability(ExecutionError):
    """A bound the precursor does not implement, requested explicitly."""


class PreflightRefused(ExecutionError):
    """The host does not satisfy the reviewed profile. No container is created."""


class DockerUnavailable(ExecutionError):
    """The Docker CLI could not be reached or answered unexpectedly."""


class AlreadyStarted(ExecutionError):
    """A start was already recorded for this Action and epoch."""


class CreateAlreadyReserved(ExecutionError):
    """A create attempt is already on disk for this Action and epoch.

    Raised before any Docker command is issued. The reservation is durable and is written before
    the external create, so this also holds across competing callers, separate ledger instances,
    and a restart after a crash whose Docker response was never seen.
    """


class UnknownAction(ExecutionError):
    """No owned ledger record exists for the Action; nothing may be created for it."""


class OwnershipRefused(ExecutionError):
    """An object does not carry this experiment's owner label and will not be removed."""


# --- Command boundary --------------------------------------------------------------------------


@dataclass(frozen=True)
class CommandResult:
    """One completed Docker CLI invocation.

    ``output_truncated`` records that the combined stdout/stderr exceeded the bounded capture
    limit. Such a result is never ``ok`` and its status is unknown: retained bytes are an excerpt,
    not the command's complete output, so a caller must not infer success or absence from them.
    """

    argv: tuple[str, ...]
    status: int | None
    stdout: str
    stderr: str
    timed_out: bool = False
    output_truncated: bool = False
    captured_bytes: int = 0

    @property
    def ok(self) -> bool:
        return (not self.timed_out and not self.output_truncated and self.status == 0)

    @property
    def uncertain(self) -> bool:
        """True when the CLI outcome is unknown because capture was cut short or timed out."""
        return self.timed_out or self.output_truncated

    def excerpt(self, limit: int = 400) -> str:
        text = (self.stderr or self.stdout or "").strip().replace("\n", " ")
        return text[:limit]


class Commander:
    """The only way this module touches Docker. Tests replace it with a scripted fake."""

    def run(self, argv: Sequence[str], *, timeout: float) -> CommandResult:  # pragma: no cover
        raise NotImplementedError


class _BoundedCapture:
    """Retain at most ``limit`` bytes shared across stdout and stderr, flagging overflow.

    Each stream keeps its own buffer so stdout and stderr stay distinguishable, but the combined
    retention is capped. Exceeding the cap sets ``truncated`` instead of silently dropping bytes,
    so a caller can never mistake a cut-short capture for the command's complete output. The
    retained bytes are an excerpt; the flag is the only statement about completeness.
    """

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.buffers = [bytearray(), bytearray()]
        self.seen = 0
        self.truncated = False
        self._lock = threading.Lock()

    def add(self, index: int, chunk: bytes) -> bool:
        """Retain what fits and return True once the combined cap has been exceeded."""
        with self._lock:
            self.seen += len(chunk)
            room = self.limit - len(self.buffers[0]) - len(self.buffers[1])
            if room > 0:
                self.buffers[index].extend(chunk[:room])
            if self.seen > self.limit:
                self.truncated = True
                return True
            return False

    def text(self, index: int) -> str:
        return _decode(bytes(self.buffers[index]))

    @property
    def retained_bytes(self) -> int:
        return len(self.buffers[0]) + len(self.buffers[1])


class SubprocessCommander(Commander):
    """Runs a fixed argv list with no shell, a minimal environment and a bounded capture.

    ``shutil.which`` resolves the binary once at construction; the caller cannot substitute a
    different program later, and no argv element is ever interpreted by a shell. The child only
    receives ``PATH`` plus anything the operator passed explicitly, so daemon-selection variables
    such as ``DOCKER_HOST`` or ``DOCKER_CONFIG`` are not inherited from an unrelated shell.

    Output is read incrementally and at most ``capture_limit_bytes`` (combined stdout+stderr) is
    retained, so a CLI or daemon that emits arbitrarily much text cannot grow process memory. When
    the cap is exceeded the child is killed, the result is marked ``output_truncated`` and its
    status is left unknown; a truncated result is never ``ok`` and is never read as a definite
    failure or as an absent object.
    """

    def __init__(
        self,
        *,
        binary: str = "docker",
        extra_environment: Mapping[str, str] | None = None,
        capture_limit_bytes: int | None = None,
        global_arguments: Sequence[str] = (),
    ) -> None:
        resolved = shutil.which(binary)
        if resolved is None:
            raise DockerUnavailable(
                f"the {binary} CLI is not on PATH; this precursor never installs or downloads a "
                "runtime and will not fall back to another executable"
            )
        if capture_limit_bytes is None:
            capture_limit_bytes = DEFAULT_CAPTURE_LIMIT_BYTES
        if (isinstance(capture_limit_bytes, bool) or not isinstance(capture_limit_bytes, int)
                or capture_limit_bytes <= 0):
            raise ValueError("capture_limit_bytes must be a positive integer")
        self.binary = resolved
        self.capture_limit_bytes = capture_limit_bytes
        self.global_arguments = tuple(global_arguments)
        environment = {"PATH": os.environ.get("PATH", "/usr/bin:/bin")}
        environment.update(extra_environment or {})
        self.environment = environment

    def run(self, argv: Sequence[str], *, timeout: float) -> CommandResult:
        command = (self.binary, *self.global_arguments, *argv)
        deadline = time.monotonic() + timeout
        try:
            process = subprocess.Popen(
                list(command),
                env=self.environment,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=(os.name == "posix"),
            )
        except OSError as error:
            raise DockerUnavailable(f"could not execute the {self.binary} CLI: {error}") from error

        capture = _BoundedCapture(self.capture_limit_bytes)
        streams = (process.stdout, process.stderr)
        timed_out = False
        completed = False
        selector = selectors.DefaultSelector()
        try:
            for index, stream in enumerate(streams):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, index)
            while True:
                if process.poll() is not None and not selector.get_map():
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    # The deadline covers output drain as well as CLI exit. A descendant holding
                    # a pipe open cannot turn incomplete output into a successful result.
                    timed_out = True
                    break
                if not selector.get_map():
                    try:
                        process.wait(timeout=remaining)
                    except subprocess.TimeoutExpired:
                        timed_out = True
                    break
                for key, _ in selector.select(timeout=min(remaining, 0.1)):
                    try:
                        chunk = os.read(key.fileobj.fileno(), CAPTURE_READ_CHUNK_BYTES)
                    except BlockingIOError:
                        continue
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    if capture.add(key.data, chunk):
                        break
                if capture.truncated:
                    break
            completed = True
        finally:
            if not completed or timed_out or capture.truncated:
                # The CLI runs in its own process group on POSIX. Stop descendants that inherited
                # a capture pipe; neither their output nor their later side effects are trusted.
                try:
                    if os.name == "posix":
                        os.killpg(process.pid, signal.SIGKILL)
                    elif process.poll() is None:  # pragma: no cover - Linux is the target host
                        process.kill()
                except ProcessLookupError:
                    pass
            selector.close()
            for stream in streams:
                stream.close()
            if process.poll() is None:
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:  # pragma: no cover - kill is immediate
                    pass

        return CommandResult(
            argv=tuple(command),
            status=None if (timed_out or capture.truncated) else process.returncode,
            stdout=capture.text(0),
            stderr=capture.text(1),
            timed_out=timed_out,
            output_truncated=capture.truncated,
            captured_bytes=capture.retained_bytes,
        )


def _decode(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


class DockerCli:
    """Thin adapter over the reviewed lifecycle verbs: create/start/wait/inspect/kill/rm."""

    def __init__(self, commander: Commander, *, default_timeout: float = 30.0) -> None:
        self.commander = commander
        self.default_timeout = default_timeout

    def version(self) -> str:
        result = self.commander.run(("version", "--format", "{{.Server.Version}}"),
                                    timeout=self.default_timeout)
        if not result.ok:
            raise DockerUnavailable(f"docker version failed: {result.excerpt()}")
        return result.stdout.strip()

    def info(self) -> dict[str, Any]:
        result = self.commander.run(("info", "--format", "{{json .}}"), timeout=self.default_timeout)
        if not result.ok:
            raise DockerUnavailable(f"docker info failed: {result.excerpt()}")
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise DockerUnavailable(f"docker info did not return JSON: {error}") from error

    def image_inspect(self, reference: str) -> dict[str, Any] | None:
        result = self.commander.run(
            ("image", "inspect", reference, "--format", "{{json .}}"), timeout=self.default_timeout
        )
        if result.uncertain:
            raise DockerUnavailable("docker image inspect outcome is unknown: " + result.excerpt())
        if result.status != 0:
            return None
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise DockerUnavailable(f"docker image inspect did not return JSON: {error}") from error

    def create(self, arguments: Sequence[str], *, timeout: float | None = None) -> CommandResult:
        return self.commander.run(("create", *arguments), timeout=timeout or self.default_timeout)

    def start(self, name: str, *, timeout: float | None = None) -> CommandResult:
        # Detached: the blocking primitive is ``wait``, so the wall deadline stays host-owned.
        return self.commander.run(("start", name), timeout=timeout or self.default_timeout)

    def wait(self, name: str, *, timeout: float) -> CommandResult:
        # Reviewed against docker/cli cli/command/container/wait.go (last touching commit
        # 053aa376ea1d224318d8361c5e3bf6bff612a30c): the command prints result.StatusCode to
        # stdout and returns joined API errors, so a non-zero *process* status means the wait
        # itself failed rather than that the container exited non-zero. The container's exit code
        # is nevertheless authoritative only from inspect; see wait_for_exit.
        return self.commander.run(("wait", name), timeout=timeout)

    def inspect(self, name: str, *, timeout: float | None = None) -> dict[str, Any] | None:
        result = self.commander.run(
            ("inspect", name, "--format", "{{json .}}"), timeout=timeout or self.default_timeout
        )
        if result.status != 0:
            if _is_absent(result):
                return None
            raise DockerUnavailable(f"docker inspect failed: {result.excerpt()}")
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise DockerUnavailable(f"docker inspect did not return JSON: {error}") from error

    def kill(self, name: str, *, timeout: float | None = None) -> CommandResult:
        return self.commander.run(("kill", name), timeout=timeout or self.default_timeout)

    def remove(self, name: str, *, timeout: float | None = None) -> CommandResult:
        return self.commander.run(("rm", "--force", name), timeout=timeout or self.default_timeout)


def _is_absent(result: CommandResult) -> bool:
    # A timed-out or capture-truncated result leaves the status unknown. The retained tail may
    # happen to contain "no such", but that is an excerpt of an incomplete capture, not evidence
    # that the object is absent, so a truncated result is never treated as absence.
    if result.uncertain:
        return False
    text = f"{result.stdout} {result.stderr}".lower()
    return result.status in (1, 127) and ("no such" in text or "no such object" in text)


# --- Ledger ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Counters:
    """Counts derived from the append-only ledger, never from a workload self-report."""

    start_attempts: int
    launches: int
    exits_observed: int
    outputs_collected: int
    kills: int


# Every event that proves a Docker create may have been issued for an Action/epoch. A later
# create must fail closed on any one of them; ``container_create_reserved`` is written before the
# external call so a crash before the response is still visible after a restart.
CREATE_ATTEMPT_EVENTS = (
    "container_create_reserved",
    "container_created",
    "container_create_unverified",
    "container_create_failed",
)


class EventLedger:
    """Append-only JSONL ledger. Every append is flushed and fsynced before the caller proceeds.

    The ledger is the record of what this experiment did to the host. It is deliberately not a
    claim about whether an unknown Action ran: a missing record means the Action is unknown, and
    unknown is never treated as "did not execute".
    """

    def __init__(self, path: Path) -> None:
        self.path = path

    def append(self, *, action_id: str, action_epoch: int, event: str,
               detail: Mapping[str, Any] | None = None) -> dict[str, Any]:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "action_id": action_id,
            "action_epoch": action_epoch,
            "event": event,
            "detail": dict(detail or {}),
        }
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        # A durable reservation needs the directory entry as well as the file's bytes.
        # Flush existing ancestors too: mkdir(parents=True) may have created several of them.
        for directory in (self.path.parent, *self.path.parent.parents):
            descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        return record

    @contextmanager
    def _ledger_guard(self) -> Any:
        """Serialize a durable ledger decision across instances, processes and restarts.

        The generalized create-slot guard (formerly ``_create_guard``); it now serializes both the
        create slot and the start slot. A sidecar lock file rather than the ledger itself, so a
        slow append never blocks an unrelated reader. ``flock`` is released by the kernel if the
        process dies, so a crash cannot leave a slot permanently locked; the durable record written
        inside the guard is the part that must survive, and it is fsynced before the lock is
        released. ``flock(2)`` locks are associated with the open file description, so separate
        ``open()`` calls contend even within one process.
        """
        if fcntl is None:  # pragma: no cover - the reviewed host and the default tests are POSIX
            with _FALLBACK_CREATE_LOCK:
                yield
            return
        lock_path = self.path.parent / (self.path.name + ".lock")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = lock_path.open("a+", encoding="utf-8")
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            yield
        finally:
            handle.close()  # closing the descriptor releases the advisory lock

    def reserve_create(self, *, action_id: str, action_epoch: int, container_name: str,
                       intent_digest: str) -> dict[str, Any]:
        """Durably claim the single create slot for an Action/epoch before Docker is called.

        The check and the append happen under one exclusive lock, so two callers cannot both
        observe an empty slot, and the record is fsynced before the lock is released. Fail
        closed: once *any* create attempt is on disk for this Action/epoch, no caller may reserve
        the slot again. A known Docker create failure is not reopened for retry here; a later
        attempt would be a second external create for the same Action/epoch, which is the exact
        duplicate this guard exists to stop. Recovery may inspect and reconcile, never create.
        """
        with self._ledger_guard():
            attempted = [
                record for record in self.for_action(action_id, action_epoch)
                if record["event"] in CREATE_ATTEMPT_EVENTS
            ]
            if attempted:
                events = ", ".join(sorted({record["event"] for record in attempted}))
                raise CreateAlreadyReserved(
                    f"action {action_id} epoch {action_epoch} already has a recorded create "
                    f"attempt ({events}); this precursor never issues a second container create "
                    "for the same Action and epoch, even when the daemon no longer reports the "
                    "original object"
                )
            return self.append(
                action_id=action_id,
                action_epoch=action_epoch,
                event="container_create_reserved",
                detail={"container_name": container_name, "intent_digest": intent_digest},
            )

    def reserve_start(self, *, action_id: str, action_epoch: int, container_id: str,
                      container_name: str, intent_digest: str) -> dict[str, Any]:
        """Durably claim the single start slot for an Action/epoch, after proving ownership.

        The ownership proof and the check-and-append happen under one exclusive lock, so two
        callers cannot both observe an empty start slot and both issue ``docker start``. Only the
        caller that finds the durable ``container_created`` association intact *and* no prior
        ``start_attempt`` writes the fsynced attempt; every other caller is refused before any
        Docker verb. The lock is released before the Docker API call: the durable, fsynced
        ``start_attempt`` record is the serialization point, not the external call.

        Fail closed. A missing, ambiguous or mismatched ``container_created`` association -- or a
        record that does not carry the same immutable intent digest -- raises ``OwnershipRefused``
        without writing anything. A prior attempt raises ``AlreadyStarted`` and is never retried,
        so a crash or a lost/failed start response cannot become a second start.
        """
        with self._ledger_guard():
            proof_failure = self.proves_created_association(
                action_id=action_id,
                action_epoch=action_epoch,
                container_id=container_id,
                container_name=container_name,
                intent_digest=intent_digest,
            )
            if proof_failure is not None:
                raise OwnershipRefused(
                    f"refusing to start action {action_id!r} epoch {action_epoch}: {proof_failure}"
                )
            attempts = self.counters(action_id, action_epoch).start_attempts
            if attempts > 0:
                raise AlreadyStarted(
                    f"action {action_id} epoch {action_epoch} already has {attempts} start "
                    "attempt(s); an exited command is never restarted because Docker would run "
                    "the command again"
                )
            return self.append(
                action_id=action_id,
                action_epoch=action_epoch,
                event="start_attempt",
                detail={"container_id": container_id, "container_name": container_name},
            )

    def read(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        records = []
        for line in self.path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                records.append(json.loads(line))
        return records

    def for_action(self, action_id: str, action_epoch: int | None = None) -> list[dict[str, Any]]:
        return [
            record
            for record in self.read()
            if record["action_id"] == action_id
            and (action_epoch is None or record["action_epoch"] == action_epoch)
        ]

    def proves_created_association(self, *, action_id: str, action_epoch: int,
                                   container_id: str, container_name: str,
                                   intent_digest: str | None = None) -> str | None:
        """Return ``None`` only when a durable ``container_created`` record proves ownership.

        A well-formed 64-character container ID is not ownership: any caller can supply an ID that
        belongs to another work root. Ownership is proved only when this append-only ledger holds
        exactly one ``container_created`` record for the same Action, epoch, container name and
        container ID. A missing, mismatching or duplicated (ambiguous) record returns a refusal
        reason, and the caller refuses before making any daemon call. A shared owner label or a
        matching mutable name is never accepted as a substitute.

        When ``intent_digest`` is provided, the durable record must also carry that exact immutable
        intent digest; a record whose intent is absent, empty or different is refused. The start
        path passes it, so a record cannot be started for a different immutable intent than the one
        the container was created for. Cleanup leaves it ``None`` and keeps the association proof.

        A ledger that cannot be read, parsed or shaped is also a refusal: an unreadable or
        unverifiable proof is not proof, and it must fail closed rather than permit a removal.
        """
        try:
            records = self.read()
            created = [
                record for record in records
                if isinstance(record, Mapping)
                and record.get("event") == "container_created"
                and record.get("action_id") == action_id
                and record.get("action_epoch") == action_epoch
            ]
            if not created:
                return (
                    f"no durable container_created record exists for action {action_id!r} epoch "
                    f"{action_epoch}; the container ID is not proven to be owned by this "
                    "invocation"
                )
            if len(created) > 1:
                return (
                    f"the durable ledger holds {len(created)} container_created records for "
                    f"action {action_id!r} epoch {action_epoch}; ownership is ambiguous"
                )
            detail = created[0].get("detail")
            detail = detail if isinstance(detail, Mapping) else {}
            recorded_id = str(detail.get("container_id", ""))
            recorded_name = str(detail.get("container_name", ""))
            if recorded_id != container_id or recorded_name != container_name:
                return (
                    "the durable container_created record does not match this exact "
                    f"(action, epoch, container ID, name) association for action {action_id!r} "
                    f"epoch {action_epoch}"
                )
            if intent_digest is not None:
                recorded_intent = str(detail.get("intent_digest", ""))
                if not recorded_intent or recorded_intent != intent_digest:
                    return (
                        "the durable container_created record does not carry the immutable intent "
                        f"digest of this start for action {action_id!r} epoch {action_epoch}"
                    )
            return None
        except Exception as error:  # noqa: BLE001 - an unreadable proof must fail closed
            return (
                f"the durable ledger could not be read to prove ownership "
                f"({type(error).__name__}: {error})"
            )

    def counters(self, action_id: str, action_epoch: int | None = None) -> Counters:
        events = [record["event"] for record in self.for_action(action_id, action_epoch)]
        return Counters(
            start_attempts=events.count("start_attempt"),
            launches=events.count("start_succeeded"),
            exits_observed=events.count("exit_observed"),
            outputs_collected=events.count("output_collected"),
            kills=events.count("kill_issued"),
        )


# --- Action specification ----------------------------------------------------------------------


@dataclass(frozen=True)
class Limits:
    """Admitted resource envelope. Every field is checked against LIMIT_CEILINGS."""

    cpus: float = 1.0
    memory_mib: int = 512
    pids: int = 512
    nofile: int = 256
    tmp_mib: int = 32
    wall_seconds: int = 60
    output_mib: int = 64
    captured_output_kib: int = 1024

    def validate(self) -> None:
        for name, ceiling in LIMIT_CEILINGS.items():
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise InvalidAction(f"limit {name} must be a number")
            if not math.isfinite(value):
                raise InvalidAction(f"limit {name} must be finite")
            if name != "cpus" and type(value) is not int:
                raise InvalidAction(f"limit {name} must be an integer")
            if name == "cpus":
                nanos = Decimal(str(value)) * 1_000_000_000
                if nanos != nanos.to_integral_value() or nanos < 1:
                    raise InvalidAction("CPU limit must be exactly expressible in positive nanocpus")
            if value <= 0:
                raise InvalidAction(f"limit {name} must be positive")
            if value > ceiling:
                raise InvalidAction(
                    f"limit {name}={value} exceeds the admitted ceiling {ceiling}; a larger "
                    "envelope needs a new admission, not a wider default"
                )


def _docker_log_options(limits: Limits) -> tuple[int, int]:
    """Return ``(max_size_kib, max_file)`` for the bounded per-container Docker log driver.

    The retention is derived from the admitted ``captured_output_kib`` budget so one Action cannot
    leave an unbounded daemon log behind. ``max-file`` is fixed and ``max-size`` is the budget
    split across those files, with Docker's documented 8 KiB per-file floor when the admitted
    budget is smaller than that. The daemon's global logging configuration is never touched; these
    are per-container ``--log-opt`` values fixed at ``create`` and read back before any ``start``.
    """
    budget_kib = int(limits.captured_output_kib)
    per_file_kib = -(-budget_kib // DOCKER_LOG_MAX_FILE)  # ceiling division
    per_file_kib = max(DOCKER_LOG_MIN_MAX_SIZE_KIB, per_file_kib)
    return per_file_kib, DOCKER_LOG_MAX_FILE


@dataclass(frozen=True)
class ActionSpec:
    """One immutable command action, as this experiment needs to see it.

    Host paths are carried for the container mounts but never become part of the intent digest:
    the digest binds what runs, not where this host keeps the files.
    """

    action_id: str
    action_epoch: int
    image: str
    command: tuple[str, ...]
    input_dir: Path
    output_dir: Path
    limits: Limits = field(default_factory=Limits)
    environment: tuple[tuple[str, str], ...] = ()

    def describe(self, *, input_digest: str) -> dict[str, Any]:
        """The canonical, host-independent description whose digest is the intent identity."""
        return {
            "action_id": self.action_id,
            "action_epoch": self.action_epoch,
            "image": self.image,
            "command": list(self.command),
            "input_digest": input_digest,
            "limits": asdict(self.limits),
            "network": "none",
            "rootfs": "readonly",
            "user": NON_ROOT_USER,
            "runtime": REVIEWED_RUNTIME_NAME,
            "mounts": {"input": INPUT_DESTINATION, "output": OUTPUT_DESTINATION},
            "environment_names": [name for name, _ in self.environment],
        }

    def intent_digest(self, *, input_digest: str) -> str:
        canonical = json.dumps(self.describe(input_digest=input_digest), sort_keys=True,
                               separators=(",", ":"))
        return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class InputManifest:
    """Content-addressed description of the immutable input tree."""

    entries: tuple[dict[str, Any], ...]
    digest: str

    def as_detail(self) -> dict[str, Any]:
        return {"digest": self.digest, "entries": [dict(entry) for entry in self.entries]}


@dataclass(frozen=True)
class PreparedAction:
    """A validated action: spec, input manifest and intent digest. No Docker call has happened.

    ``input_identity``/``output_identity`` are the ``(st_dev, st_ino)`` pair of the confined data
    directories at prepare time. They are re-read immediately before create so a directory that
    was swapped for another one with the same path fails closed.
    """

    spec: ActionSpec
    manifest: InputManifest
    intent_digest: str
    container_name: str
    input_identity: tuple[int, int] | None = None
    output_identity: tuple[int, int] | None = None


# --- Validation --------------------------------------------------------------------------------


def prepare_action(spec: ActionSpec, *, work_root: Path,
                   control_paths: Iterable[Path] = ()) -> PreparedAction:
    """Validate a spec and freeze its input. Raises InvalidAction before any Docker call.

    ``control_paths`` names the control-plane files (the ledger and its lock) that no data subtree
    may contain. The CLI passes them; a caller that omits them still gets the root and overlap
    refusals and the create-time revalidation against this sandbox's own ledger.
    """
    if not isinstance(spec.action_id, str) or not ACTION_ID_PATTERN.match(spec.action_id):
        raise InvalidAction(
            f"action_id {spec.action_id!r} must match {ACTION_ID_PATTERN.pattern}"
        )
    if isinstance(spec.action_epoch, bool) or not isinstance(spec.action_epoch, int):
        raise InvalidAction("action_epoch must be an integer")
    if spec.action_epoch < 1:
        raise InvalidAction("action_epoch must be at least 1")

    if not isinstance(spec.image, str) or not IMAGE_DIGEST_PATTERN.match(spec.image):
        raise InvalidAction(
            "image must be pinned by digest as repository@sha256:<64 hex>; a floating tag would "
            "let the workflow run different bytes than the reviewed ones"
        )

    _validate_command(spec.command)

    if spec.environment:
        raise InvalidAction(
            "this precursor forwards no environment variables: there is no admitted policy for "
            "injecting them, and an inherited secret is the failure this boundary exists to stop"
        )

    spec.limits.validate()

    input_dir = _confined_directory(spec.input_dir, work_root=work_root, label="input")
    output_dir = _confined_directory(spec.output_dir, work_root=work_root, label="output")
    _reject_data_overlap(input_dir, output_dir)
    for label, directory in (("input", input_dir), ("output", output_dir)):
        _reject_control_overlap(directory, control_paths, label=label)
    if any(output_dir.iterdir()):
        raise InvalidAction(
            f"output directory {output_dir} is not empty; this precursor refuses to reuse a data "
            "path that may already hold stale output, and it never clears existing files to force "
            "a pass"
        )

    manifest = hash_input_tree(input_dir)
    return PreparedAction(
        spec=replace(spec, input_dir=input_dir, output_dir=output_dir),
        manifest=manifest,
        intent_digest=spec.intent_digest(input_digest=manifest.digest),
        container_name=f"{CONTAINER_NAME_PREFIX}{spec.action_id}-{spec.action_epoch}",
        input_identity=_directory_identity(input_dir),
        output_identity=_directory_identity(output_dir),
    )


def admitted_wall_seconds(prepared: PreparedAction, *, confirmation: int | None = None) -> int:
    """Return the one admitted wall deadline: the validated, digest-bound Action limit.

    ``wall_seconds`` lives in ``Limits``, which ``prepare_action`` hashes into
    ``intent_digest``, so a prepared Action already carries exactly one deadline. A caller may
    repeat that value as a ``confirmation``, but it can never widen, lower or otherwise replace
    the prepared value: any mismatch is refused here, before a Docker verb is issued. A shorter
    deadline therefore requires preparing the Action with that shorter limit, not overriding a
    digested intent.
    """
    value = prepared.spec.limits.wall_seconds
    if isinstance(value, bool) or not isinstance(value, int):
        raise InvalidAction("wall_seconds in the prepared Action must be an integer")
    if value <= 0:
        raise InvalidAction("wall_seconds in the prepared Action must be positive")
    if value > LIMIT_CEILINGS["wall_seconds"]:
        raise InvalidAction(
            f"wall_seconds={value} exceeds the admitted ceiling {LIMIT_CEILINGS['wall_seconds']}; "
            "a larger envelope needs a new admission, not a post-digest override"
        )
    if confirmation is not None:
        if isinstance(confirmation, bool) or not isinstance(confirmation, int):
            raise InvalidAction("wall_seconds must be an integer")
        if confirmation != value:
            raise InvalidAction(
                f"wall_seconds={confirmation} does not match the prepared Action's digest-bound "
                f"wall_seconds={value}; the prepared immutable intent is the only deadline and a "
                "different value must be admitted by preparing the Action again"
            )
    return value


def _validate_command(command: Sequence[str]) -> None:
    if not isinstance(command, (tuple, list)) or not command:
        raise InvalidAction("command must be a non-empty sequence of argv elements")
    if len(command) > MAX_COMMAND_ARGUMENTS:
        raise InvalidAction(f"command has {len(command)} elements; at most {MAX_COMMAND_ARGUMENTS}")
    for element in command:
        if not isinstance(element, str):
            raise InvalidAction(f"command element {element!r} must be a string")
        if not element:
            raise InvalidAction("command elements must not be empty")
        if "\x00" in element:
            raise InvalidAction("command elements must not contain NUL")
        if len(element) > MAX_COMMAND_ARGUMENT_CHARACTERS:
            raise InvalidAction(
                f"command element exceeds {MAX_COMMAND_ARGUMENT_CHARACTERS} characters"
            )


def _confined_directory(path: Path, *, work_root: Path, label: str) -> Path:
    """Resolve a directory and require it to stay strictly inside the experiment's working root.

    Resolution matters: a symlink inside the root pointing at ``/etc`` or at another Action's
    output must not become a bind mount source. The working root itself is refused as a data
    directory: it also holds the control ledger, so mounting it read-write would expose the
    control record to the workload.
    """
    if not isinstance(path, Path):
        raise InvalidAction(f"{label} directory must be a pathlib.Path")
    root = work_root.resolve()
    try:
        resolved = path.resolve()
    except OSError as error:
        raise InvalidAction(f"{label} directory cannot be resolved: {error}") from error
    if resolved == root:
        raise InvalidAction(
            f"{label} directory {resolved} is the experiment working root itself, which also "
            "holds the control ledger; a data directory must be a distinct subtree, not the root"
        )
    if root not in resolved.parents:
        raise InvalidAction(
            f"{label} directory {resolved} is outside the experiment working root {root}"
        )
    if not resolved.is_dir():
        raise InvalidAction(f"{label} directory {resolved} does not exist")
    return resolved


def _directory_identity(directory: Path) -> tuple[int, int]:
    """The device/inode identity of a directory, used to detect a same-path replacement."""
    info = os.stat(directory)
    return (info.st_dev, info.st_ino)


def _reject_data_overlap(input_dir: Path, output_dir: Path) -> None:
    """Refuse equal or parent/child data directories.

    An input/output parent-child relationship defeats the read-only input mount: whichever side is
    the parent exposes or contains the other. Only exact equality used to be checked.
    """
    if input_dir == output_dir:
        raise InvalidAction("input and output directories must differ")
    if input_dir in output_dir.parents or output_dir in input_dir.parents:
        raise InvalidAction(
            f"input directory {input_dir} and output directory {output_dir} overlap; a parent/"
            "child data relationship would expose one through the other and defeat the read-only "
            "input mount"
        )


def _reject_control_overlap(data_dir: Path, control_paths: Sequence[Path], *, label: str) -> None:
    """Refuse a data subtree that contains, equals, or is contained by a control path.

    The ledger and its lock are control-plane bytes. If any of them lives inside a directory that
    becomes a container bind mount, the workload can read (or, for the writable output, alter) the
    record this experiment depends on.
    """
    for control in control_paths:
        try:
            control_path = Path(control).resolve()
        except OSError:  # pragma: no cover - a control path that cannot be resolved stays literal
            control_path = Path(control)
        if (data_dir == control_path or control_path in data_dir.parents
                or data_dir in control_path.parents):
            raise InvalidAction(
                f"{label} directory {data_dir} overlaps the control path {control_path}; a data "
                "mount must never contain, be contained by, or be the control ledger or its lock"
            )


def _revalidate_prepared(prepared: PreparedAction, *, work_root: Path,
                         control_paths: Sequence[Path]) -> None:
    """Fail closed if the frozen input or the data paths changed after ``prepare_action``.

    This is the check that runs immediately before the create verb. It re-confines both data
    directories, compares their device/inode identity with the prepared values, re-runs the
    overlap and control-path refusals, re-hashes the input tree, and requires the output path to
    still be empty. Any difference refuses before a Docker call. It is deliberately point-in-time:
    the daemon resolves the bind source after we return, so the final path race is recorded in
    ``UNAVAILABLE_BOUNDS['final_mount_race']`` rather than claimed as solved.
    """
    input_dir = _confined_directory(prepared.spec.input_dir, work_root=work_root, label="input")
    output_dir = _confined_directory(prepared.spec.output_dir, work_root=work_root, label="output")
    if input_dir != prepared.spec.input_dir or output_dir != prepared.spec.output_dir:
        raise ExecutionError(
            "an input or output directory was replaced after prepare; refusing to create against "
            "a path whose identity changed"
        )
    _reject_data_overlap(input_dir, output_dir)
    for label, directory in (("input", input_dir), ("output", output_dir)):
        _reject_control_overlap(directory, control_paths, label=label)
    if (prepared.input_identity is not None
            and _directory_identity(input_dir) != prepared.input_identity):
        raise ExecutionError(
            "the input directory identity changed after prepare; refusing to create against a "
            "swapped directory"
        )
    if (prepared.output_identity is not None
            and _directory_identity(output_dir) != prepared.output_identity):
        raise ExecutionError(
            "the output directory identity changed after prepare; refusing to create against a "
            "swapped directory"
        )
    manifest = hash_input_tree(input_dir)
    if manifest.digest != prepared.manifest.digest:
        raise ExecutionError(
            "the input bytes changed after prepare; refusing to create against a manifest that no "
            "longer describes the mounted input"
        )
    if any(output_dir.iterdir()):
        raise ExecutionError(
            "the output directory is not empty at create time; refusing to reuse a path that may "
            "hold stale output, and never clearing it to force a pass"
        )


def _bounded_tree_bytes(directory: Path, *, limit: int) -> int:
    """Sum the apparent sizes of a tree without following symlinks, stopping once over ``limit``.

    Only metadata is read, and the walk does not follow symlinked directories, so a symlink cannot
    pull an arbitrary host tree into the accounting. The early return keeps the check bounded.
    """
    total = 0
    for current, directories, files in os.walk(directory, followlinks=False):
        current_path = Path(current)
        directories[:] = [
            name for name in directories if not (current_path / name).is_symlink()
        ]
        for name in files:
            entry = current_path / name
            try:
                info = os.lstat(entry)
            except OSError:  # pragma: no cover - a vanished entry contributes no bytes
                continue
            total += info.st_size
            if total > limit:
                return total
    return total


def _hash_file_incremental(path: Path, *,
                           chunk_bytes: int = OUTPUT_HASH_CHUNK_BYTES) -> tuple[int, str]:
    """Hash one file in fixed-size chunks and return ``(size_bytes, sha256_hex)``.

    No read is larger than ``chunk_bytes`` and the whole file is never materialized in memory, so
    an untrusted or sparse file of arbitrary apparent size cannot be turned into an allocation of
    that size. The size is counted from the bytes actually read, so a file that changes size while
    it is being hashed is measured consistently with the digest.
    """
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(chunk_bytes)
            if not chunk:
                break
            size += len(chunk)
            digest.update(chunk)
    return size, digest.hexdigest()


def hash_input_tree(directory: Path) -> InputManifest:
    """Hash every regular file in the immutable input tree. Symlinks are refused, not followed."""
    entries: list[dict[str, Any]] = []
    for path in sorted(directory.rglob("*")):
        if path.is_symlink():
            raise InvalidAction(
                f"input tree contains the symlink {path.name}; the input copy must be immutable "
                "and self-contained"
            )
        if path.is_dir():
            continue
        if not path.is_file():
            raise InvalidAction(f"input tree contains a non-regular entry: {path.name}")
        relative = path.relative_to(directory).as_posix()
        size, digest = _hash_file_incremental(path)
        entries.append({"path": relative, "size": size, "sha256": digest})
    canonical = json.dumps(entries, sort_keys=True, separators=(",", ":"))
    return InputManifest(
        entries=tuple(entries),
        digest="sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
    )


# --- Host profile ------------------------------------------------------------------------------


@dataclass(frozen=True)
class HostFacts:
    """Platform facts. Injectable so the Linux branch can be tested without a Linux host."""

    system: str
    machine: str

    @classmethod
    def detect(cls) -> "HostFacts":
        return cls(system=host_platform.system().strip().lower(),
                   machine=host_platform.machine().strip().lower())


@dataclass(frozen=True)
class PreflightReport:
    """Observed host values that the preflight accepted, for the acceptance record."""

    docker_cli: str
    docker_engine: str
    engine_commit_reviewed: str
    ostype: str
    architecture: str
    cgroup_version: str
    runtime: str
    runtimes: tuple[str, ...]
    image_reference: str
    image_id: str
    image_repo_digests: tuple[str, ...]
    host_system: str
    host_machine: str
    kernel: str

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def describe_support() -> dict[str, Any]:
    """Publish enforced and unavailable bounds so neither can be mistaken for the other."""
    return {
        "enforced": dict(ENFORCED_BOUNDS),
        "unavailable": dict(UNAVAILABLE_BOUNDS),
    }


def require_output_write_time_bound() -> None:
    """Explicit refusal for the unresolved design gate."""
    raise UnsupportedCapability(UNAVAILABLE_BOUNDS["output_write_time_bound"])


def _require_container_id(record: Mapping[str, Any]) -> str:
    """Return the exact immutable ID this record owns, refusing a mutable name as a substitute.

    The ledger is written by this experiment, so a lifecycle record that cannot name the exact
    object is not safe to act on: starting, inspecting or removing the recycled name could touch a
    different container. A missing or malformed ID fails closed instead.
    """
    container_id = str(record.get("container_id", ""))
    if not CONTAINER_ID_PATTERN.match(container_id):
        raise ExecutionError(
            f"the ledger record for {record.get('container_name', 'the container')!r} does not "
            "carry an immutable 64-character container ID; refusing to act on a mutable name"
        )
    return container_id


def _parse_create_receipt(stdout: str) -> str | None:
    """Return the immutable ID ``docker create`` printed, or ``None`` when it is not one.

    ``docker create`` prints exactly the created object's bare 64-character lowercase hex ID
    (Moby's ``ContainerCreate`` returns ``InspectResponse.ID``; docker/cli prints
    ``createResponse.ID``). That receipt is the only proof of which object this Action owns, so
    anything else — an image digest, a short/uppercase ID, extra output or nothing — fails closed
    and the caller never falls back to resolving the mutable name.
    """
    lines = [line.strip() for line in (stdout or "").splitlines() if line.strip()]
    if len(lines) != 1 or not CONTAINER_ID_PATTERN.match(lines[0]):
        return None
    return lines[0]


# --- Sandbox -----------------------------------------------------------------------------------


class CommandSandbox:
    """Creates, starts once, observes and removes one bounded command container per Action."""

    def __init__(
        self,
        *,
        cli: DockerCli,
        work_root: Path,
        ledger: EventLedger,
        host_facts: HostFacts | None = None,
        admitted_images: Iterable[str] = (),
        runtime: str = REVIEWED_RUNTIME_NAME,
        expected_engine: str = REVIEWED_DOCKER_ENGINE_VERSION,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        poll_interval: float = 0.25,
        expected_daemon_id: str | None = None,
        expected_daemon_root: str | None = None,
    ) -> None:
        self.cli = cli
        self.work_root = work_root.resolve()
        self.ledger = ledger
        self.host_facts = host_facts or HostFacts.detect()
        self.admitted_images = frozenset(admitted_images)
        self.runtime = runtime
        self.expected_engine = expected_engine
        self.clock = clock
        self.sleep = sleep
        self.poll_interval = poll_interval
        self.expected_daemon_id = expected_daemon_id
        self.expected_daemon_root = expected_daemon_root

    # -- preflight ------------------------------------------------------------------------------

    def preflight(self, reference: str) -> PreflightReport:
        """Refuse loudly instead of running on a host that does not match the reviewed profile.

        The order is deliberate: the platform check happens before the first Docker command, so on
        a non-Linux host this method creates nothing and contacts no daemon.
        """
        if self.host_facts.system != REVIEWED_HOST_SYSTEM:
            raise PreflightRefused(
                f"host system {self.host_facts.system!r} is not {REVIEWED_HOST_SYSTEM!r}. "
                "Docker Desktop on macOS/Windows is not Linux isolation evidence, and this "
                "precursor does not claim it is; run it on the reviewed Linux x86-64 VM."
            )
        if self.host_facts.machine not in REVIEWED_HOST_MACHINES:
            raise PreflightRefused(
                f"host architecture {self.host_facts.machine!r} is not one of "
                f"{REVIEWED_HOST_MACHINES}"
            )
        if not IMAGE_DIGEST_PATTERN.match(reference):
            raise PreflightRefused(f"image {reference!r} is not pinned by digest")
        if reference not in self.admitted_images:
            raise PreflightRefused(
                f"image {reference!r} is not among the explicitly admitted reviewed digests; "
                "admit it with --admitted-image after reviewing it"
            )

        engine = self.cli.version()
        if engine != self.expected_engine:
            raise PreflightRefused(
                f"Docker Engine reported {engine!r}, expected the reviewed "
                f"{self.expected_engine!r} ({REVIEWED_DOCKER_ENGINE_COMMIT}); no automatic "
                "version fallback is performed"
            )

        info = self.cli.info()
        if (self.expected_daemon_id is not None
                and info.get("ID") != self.expected_daemon_id):
            raise PreflightRefused("daemon identity differs from the reviewed daemon")
        if (self.expected_daemon_root is not None
                and info.get("DockerRootDir") != self.expected_daemon_root):
            raise PreflightRefused("daemon data root differs from the reviewed daemon")
        ostype = str(info.get("OSType", "")).lower()
        architecture = str(info.get("Architecture", "")).lower()
        cgroup_version = str(info.get("CgroupVersion", ""))
        runtimes = tuple(sorted((info.get("Runtimes") or {}).keys()))
        if ostype != "linux":
            raise PreflightRefused(f"daemon OSType {ostype!r} is not 'linux'")
        if architecture not in ("x86_64", "amd64"):
            raise PreflightRefused(f"daemon Architecture {architecture!r} is not x86-64")
        if cgroup_version != REVIEWED_CGROUP_VERSION:
            raise PreflightRefused(
                f"daemon reports cgroup version {cgroup_version!r}; the reviewed profile requires "
                f"cgroup v{REVIEWED_CGROUP_VERSION}"
            )
        if self.runtime not in runtimes:
            raise PreflightRefused(
                f"runtime {self.runtime!r} is not registered with the daemon (available: "
                f"{', '.join(runtimes) or 'none'}); install and register the reviewed runsc, and "
                "note that this precursor will not fall back to runc"
            )

        image = self.cli.image_inspect(reference)
        if image is None:
            raise PreflightRefused(
                f"image {reference!r} is not loaded locally; load the reviewed image yourself. "
                "This precursor never pulls or builds (containers are created with --pull=never)"
            )
        repo_digests = tuple(image.get("RepoDigests") or ())
        digest = reference.split("@", 1)[1]
        if not any(entry.endswith("@" + digest) for entry in repo_digests):
            raise PreflightRefused(
                f"loaded image RepoDigests {repo_digests!r} do not contain the requested digest "
                f"{digest}; the loaded bytes are not the reviewed ones"
            )

        return PreflightReport(
            docker_cli=self.cli.commander.__class__.__name__,
            docker_engine=engine,
            engine_commit_reviewed=REVIEWED_DOCKER_ENGINE_COMMIT,
            ostype=ostype,
            architecture=architecture,
            cgroup_version=cgroup_version,
            runtime=self.runtime,
            runtimes=runtimes,
            image_reference=reference,
            image_id=str(image.get("Id", "")),
            image_repo_digests=repo_digests,
            host_system=self.host_facts.system,
            host_machine=self.host_facts.machine,
            kernel=str(host_platform.release()),
        )

    # -- lifecycle ------------------------------------------------------------------------------

    def _control_paths(self) -> tuple[Path, Path]:
        """The control-plane paths no data subtree may contain: the ledger and its sidecar lock."""
        lock_path = self.ledger.path.parent / (self.ledger.path.name + ".lock")
        return (self.ledger.path, lock_path)

    def create(self, prepared: PreparedAction) -> dict[str, Any]:
        """Create the container and persist its immutable ID before anything can start it.

        The create slot is reserved durably *before* the external Docker call and under an
        exclusive lock, so a second caller, a second ledger instance or a post-restart process
        never repeats the create once any attempt is recorded.

        Immediately before any Docker verb, the frozen input manifest, directory identities and
        data-path separation are revalidated against the values ``prepare_action`` produced, and
        the output path must still be empty. A changed input, a swapped directory, an overlap or
        a control-ledger exposure refuses here, before a container is created.
        """
        _revalidate_prepared(prepared, work_root=self.work_root,
                             control_paths=self._control_paths())
        # Fail closed on an invalid wall deadline before the first Docker verb, even for a
        # hand-built PreparedAction that bypassed prepare_action's admission validation.
        wall_seconds = admitted_wall_seconds(prepared)
        try:
            output_capacity = verify_output_capacity(
                prepared.spec.output_dir, prepared.spec.limits.output_mib * 1024 * 1024,
            )
        except OutputCapacityRefused as error:
            raise UnsupportedCapability(f"output capacity prerequisite refused: {error}") from error
        arguments = self._create_arguments(prepared)
        self.ledger.reserve_create(
            action_id=prepared.spec.action_id,
            action_epoch=prepared.spec.action_epoch,
            container_name=prepared.container_name,
            intent_digest=prepared.intent_digest,
        )
        result = self.cli.create(arguments)
        if not result.ok:
            if result.output_truncated:
                # The CLI emitted more text than the bounded capture retains. The create may or
                # may not have happened and its receipt is lost, so this is an unknown object: it
                # is recorded as unverified, never as a definite failure and never retried. The
                # durable create reservation written above already forbids a second create.
                self.ledger.append(
                    action_id=prepared.spec.action_id,
                    action_epoch=prepared.spec.action_epoch,
                    event="container_create_unverified",
                    detail={"container_name": prepared.container_name,
                            "reason": (
                                "docker create output exceeded the bounded capture limit; the "
                                "create result is unknown and the object is not started or "
                                "replaced"
                            )},
                )
                raise ExecutionError(
                    f"docker create for {prepared.container_name} exceeded the bounded capture "
                    "limit; the result is unknown, so the object is not started, not replaced and "
                    "never retried"
                )
            self.ledger.append(
                action_id=prepared.spec.action_id,
                action_epoch=prepared.spec.action_epoch,
                event="container_create_failed",
                detail={"container_name": prepared.container_name, "status": result.status,
                        "stderr": result.excerpt()},
            )
            raise ExecutionError(
                f"docker create failed for {prepared.container_name}: {result.excerpt()}"
            )

        create_receipt_id = _parse_create_receipt(result.stdout)
        if create_receipt_id is None:
            # Without an immutable receipt the created object cannot be identified. Resolving the
            # mutable name here is exactly the handoff race this guard exists to stop.
            self.ledger.append(
                action_id=prepared.spec.action_id,
                action_epoch=prepared.spec.action_epoch,
                event="container_create_unverified",
                detail={"container_name": prepared.container_name,
                        "reason": "docker create did not print an immutable container ID"},
            )
            raise ExecutionError(
                f"docker create for {prepared.container_name} did not return a bare 64-character "
                "container ID; the created object is unknown, so it will not be started and no "
                "replacement will be created"
            )

        # Inspect the exact receipt ID, never the mutable name. Between the create and this lookup
        # the name may already belong to a different object, and that object must not be recorded.
        inspected = self.cli.inspect(create_receipt_id)
        if inspected is None:
            # The object may exist but cannot be identified. Record it and stop: creating a
            # replacement here is exactly the duplicate-execution path this module forbids.
            self.ledger.append(
                action_id=prepared.spec.action_id,
                action_epoch=prepared.spec.action_epoch,
                event="container_create_unverified",
                detail={"container_name": prepared.container_name,
                        "container_id": create_receipt_id,
                        "reason": "the create receipt ID is no longer visible to the daemon"},
            )
            raise ExecutionError(
                f"created {prepared.container_name} (receipt {create_receipt_id}) but could not "
                "read it back; the container ID is unknown, so it will not be started and no "
                "replacement will be created"
            )

        observed_id = str(inspected.get("Id", ""))
        if observed_id != create_receipt_id:
            # The daemon answered the receipt ID with a different object. It is refused rather than
            # treated as this Action's record, and no start/create/remove is issued for it.
            self.ledger.append(
                action_id=prepared.spec.action_id,
                action_epoch=prepared.spec.action_epoch,
                event="container_create_unverified",
                detail={"container_name": prepared.container_name,
                        "container_id": create_receipt_id,
                        "observed_container_id": observed_id,
                        "reason": "inspect of the create receipt ID returned a different object"},
            )
            raise ExecutionError(
                f"docker inspect returned {observed_id or 'no ID'} instead of the create receipt "
                f"ID {create_receipt_id} for {prepared.container_name}; the object is unknown, so "
                "it will not be started and no replacement will be created"
            )

        record = {
            "action_id": prepared.spec.action_id,
            "action_epoch": prepared.spec.action_epoch,
            "container_name": prepared.container_name,
            "container_id": create_receipt_id,
            "intent_digest": prepared.intent_digest,
            "wall_seconds": wall_seconds,
            "output_capacity": output_capacity,
            "image_reference": prepared.spec.image,
            "runtime": str((inspected.get("HostConfig") or {}).get("Runtime", "")),
            "state": str((inspected.get("State") or {}).get("Status", "")),
        }
        self._assert_no_secret_environment(prepared, inspected)
        self._assert_created_shape(prepared, inspected)
        # Flushed and fsynced inside append(): start is never issued for an unrecorded object.
        self.ledger.append(
            action_id=prepared.spec.action_id,
            action_epoch=prepared.spec.action_epoch,
            event="container_created",
            detail=record,
        )
        return record

    def start_once(self, record: Mapping[str, Any]) -> None:
        """Issue exactly one start. A second attempt is refused, never retried.

        The ownership proof and the single start slot are decided together by
        ``EventLedger.reserve_start`` under the ledger guard, so two concurrent callers cannot both
        observe an empty slot and both call ``DockerCli.start``. The caller that loses the race is
        refused before any Docker verb. The fsynced ``start_attempt`` is the serialization point;
        the guard is not held across the Docker API call. A record that does not match a durable
        ``container_created`` association (Action, epoch, exact ID, exact name, immutable intent)
        fails closed, so a forged or mismatched record cannot start any object.
        """
        action_id = str(record["action_id"])
        action_epoch = int(record["action_epoch"])
        name = str(record["container_name"])
        identifier = _require_container_id(record)
        # The proof, the single-slot check and the append are one guarded durable decision. The
        # record is fsynced before this returns, so a crash or a lost response after it still
        # leaves a start_attempt that refuses every later caller.
        self.ledger.reserve_start(
            action_id=action_id,
            action_epoch=action_epoch,
            container_id=identifier,
            container_name=name,
            intent_digest=str(record.get("intent_digest", "")),
        )

        # A caller's copy of the receipt cannot replace the capacity observed at creation. Read
        # the unique durable association, then recheck the kernel immediately before start. A
        # refusal consumes this attempt: repairing storage never silently authorizes a retry.
        try:
            created = [event["detail"] for event in self.ledger.for_action(action_id, action_epoch)
                       if event["event"] == "container_created"]
            if len(created) != 1 or created[0].get("container_id") != identifier:
                raise OutputCapacityRefused("durable output capacity association is ambiguous")
            previous = created[0].get("output_capacity")
            if not isinstance(previous, dict):
                raise OutputCapacityRefused("durable creation record has no output capacity proof")
            current = verify_output_capacity(Path(previous["path"]), previous["limit_bytes"])
            if current != previous:
                raise OutputCapacityRefused("output mount identity or capacity changed after create")
        except (OutputCapacityRefused, OSError, KeyError, TypeError, ValueError) as error:
            self.ledger.append(
                action_id=action_id, action_epoch=action_epoch,
                event="start_refused_output_capacity",
                detail={"container_id": identifier, "reason": str(error)},
            )
            raise UnsupportedCapability(f"output capacity prerequisite refused: {error}") from error

        # Start the exact immutable ID: a recycled name must never be able to stand in for the
        # object this record owns, even if a same-name container has appeared since create.
        result = self.cli.start(identifier)
        if not result.ok:
            if result.output_truncated:
                # The start may have succeeded while its response was lost to the bounded capture.
                # The outcome is unknown, not failed: it is recorded as unverified and the already
                # fsynced start_attempt forbids any retry or replacement.
                self.ledger.append(action_id=action_id, action_epoch=action_epoch,
                                   event="start_unverified",
                                   detail={"container_id": identifier,
                                           "reason": (
                                               "docker start output exceeded the bounded capture "
                                               "limit; the start result is unknown and is never "
                                               "retried"
                                           )})
                raise ExecutionError(
                    f"docker start for {identifier} exceeded the bounded capture limit; the "
                    "outcome is unknown, so the container is left in place and never restarted or "
                    "replaced automatically"
                )
            self.ledger.append(action_id=action_id, action_epoch=action_epoch,
                               event="start_failed",
                               detail={"status": result.status, "stderr": result.excerpt()})
            raise ExecutionError(
                f"docker start failed for {identifier}: {result.excerpt()}. The container is left in "
                "place: it is never restarted or replaced automatically."
            )
        self.ledger.append(action_id=action_id, action_epoch=action_epoch,
                           event="start_succeeded", detail={"container_id": identifier})

    def wait_for_exit(self, prepared: PreparedAction, record: Mapping[str, Any], *,
                      deadline_monotonic: float) -> dict[str, Any]:
        """Observe only for the remaining original deadline, then attempt bounded cleanup.

        The trusted lifecycle caller freezes the same-boot deadline before create/start. Recovery
        must not derive another deadline from the current time. This timestamp bounds Python's
        wait, not daemon-side execution: a separately qualified native supervisor must enforce
        process lifetime if Python or Docker stops responding. The prepared intent still caps
        the wait and supplies the admitted ``wall_seconds`` audit value.
        """
        wall_seconds = admitted_wall_seconds(prepared)
        action_id = str(record["action_id"])
        action_epoch = int(record["action_epoch"])
        name = str(record["container_name"])
        identifier = _require_container_id(record)
        if record.get("intent_digest") != prepared.intent_digest:
            raise ExecutionError(
                "the record's intent_digest does not match the prepared Action; refusing to wait "
                "on an object that is not bound to this immutable intent"
            )

        remaining = _remaining_wall_seconds(prepared, deadline_monotonic, self.clock())
        # Do not enter a fresh wait when the start reply used the last of the budget. The later
        # 30-second wait only observes the kill attempt; it is not additional execution authority.
        waited = self.cli.wait(identifier, timeout=remaining) if remaining > 0 else CommandResult(
            argv=("wait", identifier), status=None, stdout="", stderr="deadline already elapsed",
            timed_out=True,
        )
        if waited.timed_out:
            # Best-effort cleanup is not a supervisor-independent deadline or non-execution proof.
            self.ledger.append(action_id=action_id, action_epoch=action_epoch,
                               event="wall_deadline_exceeded", detail={"wall_seconds": wall_seconds})
            killed = self.cli.kill(identifier)
            self.ledger.append(action_id=action_id, action_epoch=action_epoch, event="kill_issued",
                               detail={"status": killed.status, "stderr": killed.excerpt()})
            waited = self.cli.wait(identifier, timeout=30.0)
            if waited.timed_out:
                return self._record_unknown(
                    action_id, action_epoch, identifier, name,
                    reason="container did not stop after the wall deadline and a kill",
                )
        elif not waited.ok:
            raise DockerUnavailable(f"docker wait failed for {identifier}: {waited.excerpt()}")

        inspected = self.cli.inspect(identifier)
        if inspected is None:
            # Absence is not evidence that nothing ran.
            return self._record_unknown(
                action_id, action_epoch, identifier, name,
                reason="the container is no longer visible to the daemon, so its outcome is "
                       "unknown rather than successful",
            )
        if str(inspected.get("Id", "")) != identifier:
            # A different object cannot answer for the one this record owns.
            return self._record_unknown(
                action_id, action_epoch, identifier, name,
                reason="inspect returned a different object than the recorded immutable container "
                       "ID, so the outcome is unknown rather than successful",
            )

        state = inspected.get("State") or {}
        exit_code = state.get("ExitCode")
        if not isinstance(exit_code, int) or isinstance(exit_code, bool):
            return self._record_unknown(action_id, action_epoch, identifier, name,
                                        reason="inspect returned no integer exit code")

        reported = _parse_exit_code(waited.stdout)
        detail = {
            "exit_code": exit_code,
            "status": str(state.get("Status", "")),
            "oom_killed": bool(state.get("OOMKilled", False)),
            "dead": bool(state.get("Dead", False)),
            "started_at": str(state.get("StartedAt", "")),
            "finished_at": str(state.get("FinishedAt", "")),
            "restart_count": int(inspected.get("RestartCount", 0) or 0),
            "wait_reported_exit_code": reported,
        }
        self.ledger.append(action_id=action_id, action_epoch=action_epoch, event="exit_observed",
                           detail=detail)
        if reported is not None and reported != exit_code:
            # The blocking primitive and inspect disagree. Neither value is trusted; the outcome
            # stays conflicting so no caller can turn it into a success.
            self.ledger.append(action_id=action_id, action_epoch=action_epoch,
                               event="exit_conflict",
                               detail={"inspect_exit_code": exit_code,
                                       "wait_exit_code": reported})
            return {**detail, "outcome": "conflicting", "unknown_reason":
                    "docker wait and docker inspect reported different exit codes"}
        return {**detail, "outcome": "exited"}

    def _record_unknown(self, action_id: str, action_epoch: int, identifier: str, name: str, *,
                        reason: str) -> dict[str, Any]:
        detail: dict[str, Any] = {"container_name": name, "reason": reason}
        if identifier:
            detail["container_id"] = identifier
        self.ledger.append(action_id=action_id, action_epoch=action_epoch, event="exit_unknown",
                           detail=detail)
        return {"outcome": "unknown", "unknown_reason": reason}

    def collect_output(self, prepared: PreparedAction, record: Mapping[str, Any]) -> dict[str, Any]:
        """Measure the isolated output after the fact. This is an observation, not an enforcement.

        The admitted output size is compared here only to report whether the envelope was
        exceeded, and the result is always marked ``enforced: false``. A collection-time check
        cannot prevent the command from filling host storage, which is why the write-time bound
        stays on the unsupported list until a reviewed mechanism is installed. Each file is hashed
        and measured incrementally, so a large or sparse output file is never read whole into
        process memory.
        """
        output_dir = prepared.spec.output_dir
        admitted_bytes = prepared.spec.limits.output_mib * 1024 * 1024
        files: list[dict[str, Any]] = []
        total = 0
        root_fd = os.open(output_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            identity = os.fstat(root_fd)
            if prepared.output_identity != (identity.st_dev, identity.st_ino):
                raise ExecutionError("output directory identity changed before collection")
            entries = 0
            for directory, children, names, dir_fd in os.fwalk(".", dir_fd=root_fd,
                                                              follow_symlinks=False):
                entries += len(children) + len(names)
                if entries > 4096:
                    raise ExecutionError("output tree exceeds the bounded entry count")
                for name in sorted(names):
                    before = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
                    if not stat.S_ISREG(before.st_mode):
                        continue
                    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                                 dir_fd=dir_fd)
                    try:
                        opened = os.fstat(fd)
                        if (not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1
                                or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)):
                            raise ExecutionError("output file identity changed before collection")
                        total += opened.st_size
                        if total > admitted_bytes:
                            break  # Sparse apparent size is rejected before reading its holes.
                        digest = hashlib.sha256()
                        remaining = opened.st_size
                        while remaining:
                            chunk = os.read(fd, min(65536, remaining))
                            if not chunk:
                                raise ExecutionError("output shortened during collection")
                            digest.update(chunk)
                            remaining -= len(chunk)
                        after = os.fstat(fd)
                        if (os.read(fd, 1) or after.st_size != opened.st_size
                                or after.st_mtime_ns != opened.st_mtime_ns
                                or after.st_ctime_ns != opened.st_ctime_ns):
                            raise ExecutionError("output changed during collection")
                        files.append({"path": (Path(directory) / name).as_posix(),
                                      "size": opened.st_size, "sha256": digest.hexdigest()})
                    finally:
                        os.close(fd)
                if total > admitted_bytes:
                    break
        finally:
            os.close(root_fd)
        files.sort(key=lambda item: item["path"])
        canonical = json.dumps(files, sort_keys=True, separators=(",", ":"))
        detail = {
            "action_id": prepared.spec.action_id,
            "files": files,
            "bytes": total,
            "manifest_digest": "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
            "admitted_output_mib": prepared.spec.limits.output_mib,
            "admitted_output_bytes": admitted_bytes,
            "exceeded_admitted_envelope": total > admitted_bytes,
            "enforced": False,
            "enforcement_note": UNAVAILABLE_BOUNDS["output_write_time_bound"],
        }
        # Tied to the container that produced it, so the observation is not an anonymous file dump.
        detail["container_id"] = record["container_id"]
        detail["intent_digest"] = record["intent_digest"]
        self.ledger.append(action_id=prepared.spec.action_id,
                           action_epoch=prepared.spec.action_epoch,
                           event="output_collected", detail=detail)
        return {**detail, "outcome": record.get("outcome", "unknown")}

    def verify_expected_output(self, prepared: PreparedAction, *, expected_name: str,
                               expected_bytes: bytes) -> dict[str, Any]:
        """Prove the current Action wrote exactly its expected bounded, fresh output file.

        A success claim needs a positive proof, not the absence of a contradiction. This refuses
        unless ``expected_name`` is a regular (not symlinked) file inside the Action's confined
        output directory, that directory is still the exact inode ``prepare_action`` recorded, its
        size equals the exact expected length, and the whole output tree is within the admitted
        envelope. Absent, stale, wrong, symlinked, oversized or same-path-replaced output can
        therefore never be published as success.

        The read is bounded: the exact expected length plus one byte is read through an
        ``O_NOFOLLOW`` descriptor relative to the pinned output directory and the size is
        re-checked with ``fstat``, so an oversized file cannot be pulled into memory just to be
        compared. This is a point-in-time host check, not write-time quota enforcement and not
        host isolation.
        """
        if (not isinstance(expected_name, str) or not expected_name
                or Path(expected_name).name != expected_name or expected_name in (".", "..")):
            raise InvalidAction("expected output name must be a single path element")
        if not isinstance(expected_bytes, (bytes, bytearray)) or not expected_bytes:
            raise InvalidAction("expected output bytes must be a non-empty bytes value")
        expected = bytes(expected_bytes)

        output_dir = _confined_directory(prepared.spec.output_dir, work_root=self.work_root,
                                         label="output")
        if output_dir != prepared.spec.output_dir:
            raise ExecutionError(
                "the output directory was replaced after prepare; refusing to accept output from "
                "an unverified path"
            )
        _reject_control_overlap(output_dir, self._control_paths(), label="output")

        admitted_bytes = prepared.spec.limits.output_mib * 1024 * 1024
        tree_bytes = _bounded_tree_bytes(output_dir, limit=admitted_bytes)
        if tree_bytes > admitted_bytes:
            raise ExecutionError(
                f"the output tree is {tree_bytes} bytes, above the admitted {admitted_bytes}-byte "
                "envelope; an oversized output cannot be proof of a bounded successful command"
            )

        # Open the directory itself, not just its pathname, and compare the descriptor's
        # ``(st_dev, st_ino)`` with the identity ``prepare_action`` recorded. A replacement
        # directory created at the same path is a different inode and is refused even when its
        # bytes match exactly. The file is then read through this pinned descriptor, so a rename
        # after the check cannot redirect the proof to some other directory either.
        directory_flags = (os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
                           | getattr(os, "O_NOFOLLOW", 0))
        try:
            directory_fd = os.open(output_dir, directory_flags)
        except OSError as error:
            raise ExecutionError(
                f"the output directory {output_dir} cannot be opened without following a link: "
                f"{error}"
            ) from error
        try:
            pinned = os.fstat(directory_fd)
            if not stat.S_ISDIR(pinned.st_mode):
                raise ExecutionError(f"the output path {output_dir} is not a directory")
            if (prepared.output_identity is not None
                    and (pinned.st_dev, pinned.st_ino) != prepared.output_identity):
                raise ExecutionError(
                    "the output directory was replaced after prepare; a fresh directory at the "
                    "same path is not the Action's output, so bytes found there cannot prove the "
                    "container wrote them"
                )

            path = output_dir / expected_name
            try:
                info = os.lstat(expected_name, dir_fd=directory_fd)
            except FileNotFoundError as error:
                raise ExecutionError(
                    f"expected output {expected_name} is absent; no success may be claimed from "
                    "absent bytes"
                ) from error
            except OSError as error:
                raise ExecutionError(
                    f"expected output {expected_name} cannot be inspected: {error}"
                ) from error
            if stat.S_ISLNK(info.st_mode):
                raise ExecutionError(
                    f"expected output {expected_name} is a symlink; a symlink cannot prove the "
                    "container wrote these bytes"
                )
            if not stat.S_ISREG(info.st_mode):
                raise ExecutionError(f"expected output {expected_name} is not a regular file")
            if info.st_size != len(expected):
                raise ExecutionError(
                    f"expected output {expected_name} is {info.st_size} bytes, not exactly the "
                    f"expected {len(expected)} bytes"
                )

            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            try:
                descriptor = os.open(expected_name, flags, dir_fd=directory_fd)
            except OSError as error:
                raise ExecutionError(
                    f"expected output {expected_name} cannot be opened without following a link: "
                    f"{error}"
                ) from error
            try:
                opened = os.fstat(descriptor)
                if not stat.S_ISREG(opened.st_mode):
                    raise ExecutionError(f"expected output {expected_name} is not a regular file")
                if opened.st_size != len(expected):
                    raise ExecutionError(
                        f"expected output {expected_name} changed size while being verified"
                    )
                chunks: list[bytes] = []
                remaining = len(expected) + 1
                while remaining > 0:
                    chunk = os.read(descriptor, remaining)
                    if not chunk:
                        break
                    chunks.append(chunk)
                    remaining -= len(chunk)
                data = b"".join(chunks)
            finally:
                os.close(descriptor)
        finally:
            os.close(directory_fd)

        if data != expected:
            raise ExecutionError(
                f"expected output {expected_name} does not match the exact expected bytes"
            )
        return {
            "path": str(path),
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "regular_file": True,
            "symlink": False,
            "output_tree_bytes": tree_bytes,
            "admitted_output_bytes": admitted_bytes,
            "enforced": False,
        }

    def recover(self, action_id: str, action_epoch: int) -> dict[str, Any]:
        """Inspect the same object. Never create, never start, never assume.

        Every branch that cannot prove an outcome returns ``unknown`` together with the reason,
        and the caller is expected to reconcile rather than to launch again.
        """
        attempts = [record for record in self.ledger.for_action(action_id, action_epoch)
                    if record["event"] in CREATE_ATTEMPT_EVENTS]
        records = [record for record in attempts if record["event"] == "container_created"]
        if not records:
            if attempts:
                # A create was reserved or issued but no readable object record exists. This is
                # unknown, never "did not run", and it is never repaired by another create.
                return {
                    "action_id": action_id,
                    "action_epoch": action_epoch,
                    "outcome": "unknown",
                    "decision": "reconcile",
                    "reason": (
                        "a create was already attempted for this Action; no readable container "
                        "record exists, so the outcome is unknown and this precursor never "
                        "creates a replacement object"
                    ),
                }
            return {
                "action_id": action_id,
                "action_epoch": action_epoch,
                "outcome": "unknown",
                "decision": "do_not_create",
                "reason": (
                    "no owned ledger record for this Action; absence of a local record is not "
                    "evidence that nothing ran, and this precursor never creates a replacement "
                    "object for an unknown Action"
                ),
            }

        record = records[-1]["detail"]
        recorded_id = str(record.get("container_id", ""))
        if not CONTAINER_ID_PATTERN.match(recorded_id):
            # A record without an immutable ID cannot be matched to an object; a name lookup here
            # is exactly how a same-name replacement would be accepted. Stay unknown.
            return {
                "action_id": action_id,
                "action_epoch": action_epoch,
                "container_id": recorded_id,
                "container_name": str(record.get("container_name", "")),
                "outcome": "unknown",
                "decision": "reconcile",
                "reason": (
                    "the recorded object has no immutable container ID, so a later container "
                    "reusing its name cannot be shown to be the same object"
                ),
            }
        # Inspect the exact immutable ID, never the mutable name: a recycled name is not evidence
        # that this Action's object still exists.
        inspected = self.cli.inspect(recorded_id)
        if inspected is None:
            return {
                "action_id": action_id,
                "action_epoch": action_epoch,
                "container_id": recorded_id,
                "outcome": "unknown",
                "decision": "reconcile",
                "reason": (
                    "the recorded container is no longer visible to the daemon; missing runtime "
                    "records do not prove non-execution"
                ),
            }
        observed_id = str(inspected.get("Id", ""))
        if observed_id != recorded_id:
            # The daemon answered, but for a different object. It is refused rather than treated
            # as this Action's outcome, and no start/create/remove is issued for it.
            return {
                "action_id": action_id,
                "action_epoch": action_epoch,
                "container_id": recorded_id,
                "observed_container_id": observed_id,
                "outcome": "unknown",
                "decision": "reconcile",
                "reason": (
                    "inspect returned a different object than the recorded immutable container ID; "
                    "it is not treated as the same container"
                ),
            }
        state = inspected.get("State") or {}
        status = str(state.get("Status", ""))
        counters = self.ledger.counters(action_id, action_epoch)
        observed = {
            "action_id": action_id,
            "action_epoch": action_epoch,
            "container_id": recorded_id,
            "container_name": str(record["container_name"]),
            "status": status,
            "exit_code": state.get("ExitCode"),
            "restart_count": int(inspected.get("RestartCount", 0) or 0),
            "ledger_start_attempts": counters.start_attempts,
            "ledger_launches": counters.launches,
            "decision": "do_not_start",
        }
        if status == "created":
            if counters.start_attempts:
                observed["outcome"] = "unknown"
                observed["reason"] = (
                    "a start was reserved and may still be queued at the daemon; created status "
                    "does not prove non-execution, and the consumed start is never retried"
                )
            else:
                observed["outcome"] = "created_not_started"
                observed["reason"] = (
                    "the object reported created and no start reservation was observed; this "
                    "snapshot is not a fence against a concurrent start or proof of "
                    "non-execution, and it authorizes no launch"
                )
        elif status == "running":
            observed["outcome"] = "running"
            observed["reason"] = "the command is still running; observation only, no second launch"
        elif status in ("exited", "dead"):
            observed["outcome"] = "exited" if status == "exited" else "unknown"
            observed["reason"] = "exit code read back from the same immutable container ID"
        else:
            observed["outcome"] = "unknown"
            observed["reason"] = f"unexpected container status {status!r}"
        return observed

    def audit(self, action_id: str, action_epoch: int) -> dict[str, Any]:
        """Two independent duplicate-execution signals: the ledger and Docker's restart counter.

        The ledger counts what this experiment issued; ``RestartCount`` is the daemon's own count
        of Docker-initiated restarts. Neither is a workload self-report, so a duplicate shows up
        even if the process that caused it reported nothing.
        """
        counters = self.ledger.counters(action_id, action_epoch)
        records = [record for record in self.ledger.for_action(action_id, action_epoch)
                   if record["event"] == "container_created"]
        restart_count: int | None = None
        if records:
            detail = records[-1]["detail"]
            recorded_id = str(detail.get("container_id", ""))
            if CONTAINER_ID_PATTERN.match(recorded_id):
                inspected = self.cli.inspect(recorded_id)
                if inspected is not None and str(inspected.get("Id", "")) == recorded_id:
                    restart_count = int(inspected.get("RestartCount", 0) or 0)
        duplicate = counters.start_attempts > 1 or counters.launches > 1 or (
            restart_count is not None and restart_count > 0
        )
        return {
            "action_id": action_id,
            "action_epoch": action_epoch,
            "start_attempts": counters.start_attempts,
            "launches": counters.launches,
            "kills": counters.kills,
            "outputs_collected": counters.outputs_collected,
            "docker_restart_count": restart_count,
            "duplicate_execution": duplicate,
        }

    def cleanup(self, records: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
        """Remove exactly the immutable IDs this invocation's durable records prove it owns.

        Ownership is proved in two steps, both required before any daemon call: the durable
        append-only ledger must hold one unambiguous ``container_created`` record for the exact
        ``(action_id, action_epoch, container_id, container_name)`` association, and the daemon
        must then read that same immutable ID back. The owner label and the name prefix are shared
        by other experiment roots, so neither is accepted as a substitute: a forged but well-formed
        64-character ID with no matching ledger record is refused. A record that is missing,
        malformed or ambiguous is refused and its object is left for reconciliation, never removed
        by its mutable name.

        Each record is attempted independently and at most once. An inspect, remove, OS, timeout or
        ledger-read failure for one record is aggregated and never stops the bounded attempts for
        the remaining records, and a removal is reported only when the daemon acknowledged it.
        """
        removed: list[str] = []
        failed: list[dict[str, Any]] = []
        refused: list[dict[str, Any]] = []
        ledger_errors: list[dict[str, Any]] = []
        for record in records:
            name = str(record.get("container_name", ""))
            recorded_id = str(record.get("container_id", ""))
            action_id = str(record.get("action_id", ""))
            raw_epoch = record.get("action_epoch")
            try:
                action_epoch = int(raw_epoch)
            except (TypeError, ValueError):
                action_epoch = 0
            epoch_valid = isinstance(raw_epoch, int) and not isinstance(raw_epoch, bool)

            if not CONTAINER_ID_PATTERN.match(recorded_id):
                # No exact immutable ID was proven by the durable record (a failed create, an
                # unverified receipt/inspect, or a malformed value). Refuse before any daemon
                # lookup: resolving the mutable name or the shared owner label here is exactly how
                # another work root's same-name object would be removed.
                refused.append({
                    "container_name": name,
                    "container_id": recorded_id,
                    "reason": (
                        "the durable record does not carry an immutable container ID; refusing a "
                        "name-or-label based removal and leaving the object for reconciliation"
                    ),
                })
                continue

            if not epoch_valid:
                refused.append({
                    "container_name": name,
                    "container_id": recorded_id,
                    "reason": (
                        "the durable record does not carry a valid integer action epoch; the "
                        "container ID cannot be proven to belong to this invocation, so it is "
                        "left for reconciliation"
                    ),
                })
                continue

            # Exact-ID format alone does not prove ownership: this invocation must have a durable
            # container_created record for this exact association. A forged ID, a record from
            # another Action/epoch, an ambiguous ledger or an unreadable ledger all refuse here,
            # before inspect or remove can touch any object.
            proof_failure = self.ledger.proves_created_association(
                action_id=action_id,
                action_epoch=action_epoch,
                container_id=recorded_id,
                container_name=name,
            )
            if proof_failure is not None:
                refused.append({
                    "container_name": name,
                    "container_id": recorded_id,
                    "reason": proof_failure,
                })
                continue

            try:
                inspected = self.cli.inspect(recorded_id)
                if inspected is None:
                    # Nothing to remove, or nothing we can prove is ours: non-destructive.
                    refused.append({"container_name": name,
                                    "reason": "not visible to the daemon"})
                    continue
                if str(inspected.get("Id", "")) != recorded_id:
                    refused.append({
                        "container_name": name,
                        "container_id": recorded_id,
                        "reason": "inspect returned a different object than the recorded ID",
                    })
                    continue
                result = self.cli.remove(recorded_id)
                if result.ok:
                    removed.append(name)
                    self._append_cleanup_ledger(
                        ledger_errors, action_id=action_id, action_epoch=action_epoch,
                        event="cleanup_removed",
                        detail={"container_name": name, "container_id": recorded_id},
                    )
                else:
                    failed.append({"container_name": name, "status": result.status,
                                   "stderr": result.excerpt()})
                    self._append_cleanup_ledger(
                        ledger_errors, action_id=action_id, action_epoch=action_epoch,
                        event="cleanup_failed",
                        detail={"container_name": name, "container_id": recorded_id,
                                "status": result.status, "stderr": result.excerpt()},
                    )
            except (ExecutionError, OSError) as error:
                # One object's inspect/remove/OS/timeout failure is reported and isolated; the
                # remaining records are still attempted below.
                failure = f"{type(error).__name__}: {error}"
                failed.append({"container_name": name, "container_id": recorded_id,
                               "error": failure})
                self._append_cleanup_ledger(
                    ledger_errors, action_id=action_id, action_epoch=action_epoch,
                    event="cleanup_failed",
                    detail={"container_name": name, "container_id": recorded_id,
                            "error": failure},
                )
        for entry in refused:
            self._append_cleanup_ledger(ledger_errors, action_id="cleanup", action_epoch=0,
                                        event="cleanup_refused", detail=entry)
        return {"removed": removed, "failed": failed, "refused": refused,
                "ledger_errors": ledger_errors}

    def _append_cleanup_ledger(self, ledger_errors: list[dict[str, Any]], *, action_id: str,
                               action_epoch: int, event: str,
                               detail: Mapping[str, Any]) -> None:
        """Best-effort cleanup bookkeeping: a ledger error must not abort the sibling records.

        The failure is collected for the caller to report rather than swallowed, so no removal or
        refusal claim is silently lost.
        """
        try:
            self.ledger.append(action_id=action_id, action_epoch=action_epoch, event=event,
                               detail=detail)
        except Exception as error:  # noqa: BLE001 - reported, never hidden, never fatal here
            ledger_errors.append({
                "event": event,
                "container_name": str(detail.get("container_name", "")),
                "error": f"{type(error).__name__}: {error}",
            })

    # -- argument construction ------------------------------------------------------------------

    def _create_arguments(self, prepared: PreparedAction) -> list[str]:
        """The complete create argv. Fixed shape: no caller-supplied path or flag enters here."""
        spec = prepared.spec
        limits = spec.limits
        for directory in (spec.input_dir, spec.output_dir):
            if any(character in str(directory) for character in (",", "\n", "\r", "\x00")):
                raise InvalidAction("bind paths contain Docker mount delimiters")
        log_max_size_kib, log_max_file = _docker_log_options(limits)
        arguments = [
            "--pull=never",
            "--name", prepared.container_name,
            "--runtime", self.runtime,
            "--restart", "no",
            "--network", "none",
            "--user", NON_ROOT_USER,
            "--read-only",
            "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges",
            "--memory", f"{limits.memory_mib}m",
            "--memory-swap", f"{limits.memory_mib}m",
            "--cpus", _format_cpus(limits.cpus),
            "--pids-limit", str(limits.pids),
            "--ulimit", f"nofile={limits.nofile}:{limits.nofile}",
            "--ulimit", f"nproc={limits.pids}:{limits.pids}",
            "--tmpfs", f"{TMP_DESTINATION}:rw,nosuid,nodev,noexec,size={limits.tmp_mib}m",
            # Per-container bounded daemon log. This module never reads ``docker logs`` back as
            # workload stdout/stderr, so a rotated log is never presented as complete output.
            "--log-driver", DOCKER_LOG_DRIVER,
            "--log-opt", f"max-size={log_max_size_kib}k",
            "--log-opt", f"max-file={log_max_file}",
            "--mount",
            f"type=bind,src={spec.input_dir},dst={INPUT_DESTINATION},readonly",
            "--mount", f"type=bind,src={spec.output_dir},dst={OUTPUT_DESTINATION}",
            "--label", f"{OWNER_LABEL}={EXPERIMENT_OWNER}",
            "--label", f"{ACTION_LABEL}={spec.action_id}",
            "--label", f"{DIGEST_LABEL}={prepared.intent_digest}",
            "--label", f"{EPOCH_LABEL}={spec.action_epoch}",
            spec.image,
        ]
        arguments.extend(spec.command)
        return arguments

    def _assert_created_shape(self, prepared: PreparedAction,
                              inspected: Mapping[str, Any]) -> None:
        """Read the created object back and refuse to start it if the daemon stored less."""
        host = inspected.get("HostConfig") or {}
        problems: list[str] = []
        limits = prepared.spec.limits
        if (inspected.get("Config") or {}).get("User") != NON_ROOT_USER:
            problems.append("non-root user differs from the admitted user")
        for key, expected in (("PidsLimit", limits.pids),
                              ("MemorySwap", limits.memory_mib * 1024 * 1024),
                              ("NanoCpus", int(Decimal(str(limits.cpus)) * 1_000_000_000))):
            if type(host.get(key)) is not int or host[key] != expected:
                problems.append(f"{key} differs from the admitted limit")
        ulimits = host.get("Ulimits") or []
        expected_ulimits = {"nofile": limits.nofile, "nproc": limits.pids}
        if (not isinstance(ulimits, list) or len(ulimits) != len(expected_ulimits)
                or any(not isinstance(item, dict) for item in ulimits)
                or any(sum(item.get("Name") == name for item in ulimits) != 1
                       for name in expected_ulimits)
                or any(type(item.get(field)) is not int
                       or item[field] != expected_ulimits.get(item.get("Name"))
                       for item in ulimits for field in ("Soft", "Hard"))):
            problems.append("file descriptor or guest process limit differs from the admitted limit")
        option_list = str((host.get("Tmpfs") or {}).get(TMP_DESTINATION, "")).split(",")
        options = set(option_list)
        size_options = {f"size={limits.tmp_mib}m", f"size={limits.tmp_mib * 1024}k",
                        f"size={limits.tmp_mib * 1024 * 1024}"}
        if (set(host.get("Tmpfs") or {}) != {TMP_DESTINATION}
                or len(option_list) != 5 or len(options) != 5
                or len(options & size_options) != 1
                or options - size_options != {"rw", "nosuid", "nodev", "noexec"}):
            problems.append("temporary filesystem limits differ from the admitted limits")
        if str(host.get("Runtime", "")) != self.runtime:
            problems.append(f"runtime is {host.get('Runtime')!r}")
        if str(host.get("NetworkMode", "")) != "none":
            problems.append(f"network mode is {host.get('NetworkMode')!r}")
        if not host.get("ReadonlyRootfs"):
            problems.append("root filesystem is not read-only")
        if host.get("Privileged"):
            problems.append("container is privileged")
        if list(host.get("CapDrop") or []) != ["ALL"]:
            problems.append(f"dropped capabilities are {host.get('CapDrop')!r}")
        if "no-new-privileges" not in list(host.get("SecurityOpt") or []):
            problems.append("no-new-privileges is not set")
        if int(host.get("Memory", 0) or 0) != prepared.spec.limits.memory_mib * 1024 * 1024:
            problems.append(f"memory limit is {host.get('Memory')!r}")
        policy = host.get("RestartPolicy") or {}
        if str(policy.get("Name", "no")) not in ("no", ""):
            problems.append(f"restart policy is {policy.get('Name')!r}")
        if list(host.get("CapAdd") or []):
            problems.append(f"added capabilities are {host.get('CapAdd')!r}")
        # The daemon must have stored the bounded per-container log configuration. The user's
        # global daemon logging settings are never changed; if the stored driver is anything but
        # the reviewed bounded one, the object is refused before it can start.
        log_config = host.get("LogConfig") or {}
        if str(log_config.get("Type", "")) != DOCKER_LOG_DRIVER:
            problems.append(f"log driver is {log_config.get('Type')!r}")
        expected_size_kib, expected_max_file = _docker_log_options(prepared.spec.limits)
        log_options = {
            str(key): str(value) for key, value in (log_config.get("Config") or {}).items()
        }
        if log_options.get("max-size") != f"{expected_size_kib}k":
            problems.append(f"log max-size is {log_options.get('max-size')!r}")
        if log_options.get("max-file") != str(expected_max_file):
            problems.append(f"log max-file is {log_options.get('max-file')!r}")
        # Only the three destinations this module fixes may exist. A daemon that stored an extra
        # bind mount would be mounting something the reviewed envelope never admitted.
        allowed_destinations = (INPUT_DESTINATION, OUTPUT_DESTINATION, TMP_DESTINATION)
        mounts = {
            str(entry.get("Destination")): entry for entry in (inspected.get("Mounts") or [])
        }
        input_mount = mounts.get(INPUT_DESTINATION)
        if input_mount is None or input_mount.get("RW"):
            problems.append("the input mount is missing or writable")
        output_mount = mounts.get(OUTPUT_DESTINATION)
        if output_mount is None:
            problems.append("the output mount is missing")
        for mount, directory, writable in ((input_mount, prepared.spec.input_dir, False),
                                            (output_mount, prepared.spec.output_dir, True)):
            if (mount is None or mount.get("Type") != "bind"
                    or mount.get("Source") != str(directory) or mount.get("RW") is not writable
                    or mount.get("Propagation") != "rprivate"):
                problems.append("bind source, writability or propagation differs from admission")
        tmp_mount = mounts.get(TMP_DESTINATION)
        # Moby stores --tmpfs in HostConfig.Tmpfs, outside GetMountPoints(). Its absence
        # from Mounts is normal; if present it must agree with the separately checked map.
        if tmp_mount is not None and str(tmp_mount.get("Type", "")) != "tmpfs":
            problems.append("the bounded tmpfs at /tmp has a conflicting mount")
        for entry in inspected.get("Mounts") or []:
            if str(entry.get("Destination")) not in allowed_destinations:
                problems.append(f"unexpected mount at {entry.get('Destination')!r}")
        if problems:
            raise ExecutionError(
                f"the daemon did not store the reviewed configuration for "
                f"{prepared.container_name}: {'; '.join(problems)}"
            )

    def _assert_no_secret_environment(self, prepared: PreparedAction,
                                      inspected: Mapping[str, Any]) -> None:
        """Fail closed if the reviewed image injects a secret-like variable of its own."""
        declared = list((inspected.get("Config") or {}).get("Env") or [])
        offending = [
            entry.split("=", 1)[0] for entry in declared
            if entry.split("=", 1)[0].upper().startswith(SECRET_ENV_PREFIXES)
        ]
        if offending:
            raise ExecutionError(
                f"image {prepared.spec.image} declares environment variables {offending}; the "
                "precursor forwards none of its own and refuses an image that would expose "
                "control-looking secrets inside the workload"
            )


def _format_cpus(cpus: float) -> str:
    return format(Decimal(str(cpus)).normalize(), "f")


def _parse_exit_code(stdout: str) -> int | None:
    stripped = stdout.strip().splitlines()
    if not stripped:
        return None
    try:
        return int(stripped[-1].strip())
    except ValueError:
        return None


# --- Synthetic probe ---------------------------------------------------------------------------

# The synthetic command from the reviewed design, adapted to the create/start/wait lifecycle. It
# asserts its own boundary from inside the sandbox and writes only a small synthetic output; it
# reads no real user file and carries no secret.
SYNTHETIC_PROBE = r'''
import os, pathlib, socket
assert os.getuid() == 10001, os.getuid()
assert not pathlib.Path("/var/run/docker.sock").exists()
assert not any(k.startswith(("OPENBOT_", "AWS_", "OPENAI_", "ANTHROPIC_")) for k in os.environ), os.environ
assert pathlib.Path("/input/source.csv").read_bytes() == b"row,value\n7,old\n"
for path in ("/input/new", "/etc/openbot-probe", "/output/../escape"):
    try:
        pathlib.Path(path).write_text("forbidden")
    except OSError:
        pass
    else:
        raise AssertionError("unexpected writable path: " + path)
s = socket.socket(); s.settimeout(1)
assert s.connect_ex(("198.51.100.1", 443)) != 0
s.close()
pathlib.Path("/output/result.csv").write_bytes(b"row,value\n7,fixed\n")
'''
SYNTHETIC_INPUT_NAME = "source.csv"
SYNTHETIC_INPUT_BYTES = b"row,value\n7,old\n"
SYNTHETIC_OUTPUT_NAME = "result.csv"
SYNTHETIC_OUTPUT_BYTES = b"row,value\n7,fixed\n"


@contextmanager
def _descriptor_close(descriptor: int) -> Any:
    """Close a raw descriptor exactly once, including when a later step refuses."""

    try:
        yield descriptor
    finally:
        os.close(descriptor)


def _open_directory_no_follow(path: Path, *, label: str) -> int:
    """Open an existing directory without following a final symlink."""
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        return os.open(path, flags)
    except OSError as error:
        raise InvalidAction(
            f"{label} {path} cannot be opened as a real directory without following a link: "
            f"{error}"
        ) from error


def _open_or_create_child_directory(parent_fd: int, name: str, *, label: str) -> int:
    """Open or create one directory component below ``parent_fd`` without following symlinks.

    Every operation is relative to the already-opened parent descriptor and carries ``O_NOFOLLOW``,
    so a symlink at ``actions``, at the per-Action directory, or at an ``input``/``output``
    component fails closed instead of redirecting the synthetic input write outside the working
    root. A path replaced between the open and the write cannot be substituted either, because the
    write is issued on the descriptor that was actually opened.
    """
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        return os.open(name, flags, dir_fd=parent_fd)
    except FileNotFoundError:
        pass
    except OSError as error:
        raise InvalidAction(
            f"{label} {name!r} is not a real directory inside the working root: {error}"
        ) from error
    try:
        os.mkdir(name, dir_fd=parent_fd)
    except FileExistsError:
        # A concurrent creator won the race; the no-follow reopen below still refuses a symlink.
        pass
    except OSError as error:
        raise InvalidAction(f"{label} {name!r} cannot be created safely: {error}") from error
    try:
        return os.open(name, flags, dir_fd=parent_fd)
    except OSError as error:
        raise InvalidAction(
            f"{label} {name!r} is a symlink or not a directory; refusing to write through it: "
            f"{error}"
        ) from error


def _write_new_bytes(directory_fd: int, name: str, payload: bytes, *, label: str) -> None:
    """Create the synthetic input without truncating a pre-existing inode.

    ``O_NOFOLLOW`` blocks symbolic links, but it does not block a hard link to a file outside the
    working root. A re-used file is therefore read-only verified and must have just one link;
    only an exclusively created inode may receive writes.
    """
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(name, flags, 0o644, dir_fd=directory_fd)
    except FileExistsError:
        try:
            descriptor = os.open(name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
                                 dir_fd=directory_fd)
        except OSError as error:
            raise InvalidAction(f"{label} {name!r} cannot be safely reused: {error}") from error
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise InvalidAction(
                    f"{label} {name!r} is not a private regular file; refusing to overwrite a "
                    "shared inode"
                )
            if info.st_size != len(payload) or os.read(descriptor, len(payload) + 1) != payload:
                raise InvalidAction(
                    f"{label} {name!r} already exists with different bytes; refusing to "
                    "overwrite an existing input"
                )
        finally:
            os.close(descriptor)
        return
    except OSError as error:
        raise InvalidAction(f"{label} {name!r} cannot be written safely: {error}") from error
    try:
        if os.fstat(descriptor).st_nlink != 1:
            raise InvalidAction(f"{label} {name!r} became a shared inode before its first write")
        remaining = memoryview(payload)
        while len(remaining):
            written = os.write(descriptor, remaining)
            if written <= 0:  # pragma: no cover - a zero-length write is not expected here
                raise InvalidAction(f"{label} {name!r} was not written completely")
            remaining = remaining[written:]
    finally:
        os.close(descriptor)


def build_synthetic_spec(*, action_id: str, action_epoch: int, image: str, work_root: Path,
                         interpreter: str = "python3", limits: Limits | None = None) -> ActionSpec:
    """Build the synthetic Action in its own per-Action data subtree.

    Each Action/epoch gets distinct input and output directories under ``work_root/actions``, so
    one Action's output can never satisfy another Action's proof. The identity is validated here
    before it is used as a path element, because this builder runs before ``prepare_action`` and
    must not let a caller-shaped id create a directory outside the working root.

    The subtree is created and the input written only through descriptor-relative ``O_NOFOLLOW``
    operations, so a symlinked ``actions`` (or per-Action, ``input``, ``output``) component is
    refused before any byte is written instead of redirecting the file outside ``work_root``. This
    builder runs before ``prepare_action``'s own confinement, so its safety cannot depend on that
    later check. An existing source file is accepted only if private and byte-identical; it is
    never truncated, including when it is a hard link to a file outside the working root.
    """
    if not isinstance(action_id, str) or not ACTION_ID_PATTERN.match(action_id):
        raise InvalidAction(
            f"action_id {action_id!r} must match {ACTION_ID_PATTERN.pattern}"
        )
    if isinstance(action_epoch, bool) or not isinstance(action_epoch, int) or action_epoch < 1:
        raise InvalidAction("action_epoch must be an integer of at least 1")
    if not isinstance(work_root, Path):
        raise InvalidAction("work_root must be a pathlib.Path")

    root = work_root.resolve()
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise InvalidAction(f"working root {root} cannot be created: {error}") from error

    action_directory = f"{action_id}-{action_epoch}"
    with _descriptor_close(_open_directory_no_follow(root, label="working root")) as root_fd:
        actions_fd = _open_or_create_child_directory(root_fd, "actions", label="per-Action root")
        with _descriptor_close(actions_fd):
            base_fd = _open_or_create_child_directory(actions_fd, action_directory,
                                                      label="Action directory")
            with _descriptor_close(base_fd):
                input_fd = _open_or_create_child_directory(base_fd, "input", label="input")
                with _descriptor_close(input_fd):
                    output_fd = _open_or_create_child_directory(base_fd, "output",
                                                                label="output")
                    with _descriptor_close(output_fd):
                        _write_new_bytes(input_fd, SYNTHETIC_INPUT_NAME, SYNTHETIC_INPUT_BYTES,
                                         label="synthetic input")

    base = root / "actions" / action_directory
    return ActionSpec(
        action_id=action_id,
        action_epoch=action_epoch,
        image=image,
        command=(interpreter, "-c", SYNTHETIC_PROBE),
        input_dir=base / "input",
        output_dir=base / "output",
        limits=limits or Limits(),
    )


def _remaining_wall_seconds(prepared: PreparedAction, deadline_monotonic: float,
                            now: float) -> float:
    """Validate a trusted same-boot deadline without treating it as execution authority."""
    wall_seconds = admitted_wall_seconds(prepared)
    try:
        valid = (type(deadline_monotonic) in (int, float)
                 and math.isfinite(deadline_monotonic) and deadline_monotonic >= 0)
    except (OverflowError, TypeError, ValueError):
        valid = False
    if not valid:
        raise InvalidAction("deadline_monotonic must be a finite nonnegative monotonic timestamp")
    return max(0.0, min(float(wall_seconds), deadline_monotonic - now))


def run_action(sandbox: CommandSandbox, prepared: PreparedAction, *, keep_container: bool = False,
               wall_seconds: int | None = None,
               deadline_monotonic: float | None = None) -> dict[str, Any]:
    """Full lifecycle for one Action: create, persist, start once, settle, collect, clean up.

    ``wall_seconds`` is a confirmation, never an override: it must equal the deadline already in
    the prepared, digest-bound Action, and a mismatch (or any invalid value) is refused here,
    before the first Docker verb. To run a shorter deadline, prepare the Action with that limit;
    the value cannot be changed after the intent digest exists.

    A native unit caller supplies its already-armed same-boot ``deadline_monotonic``. The standalone
    precursor freezes a Python wait deadline once before create; neither path grants another full
    budget after the start reply. This local fallback is not native lifetime enforcement and must
    not be used to re-arm a recovered Action.

    Cleanup is attempted on every path, including a failed create and a failed start. Removal
    requires the exact container ID proven by this Action's durable creation record; an unverified
    object is left for reconciliation rather than removed by name or shared owner label.
    """
    wall_deadline = admitted_wall_seconds(prepared, confirmation=wall_seconds)
    if deadline_monotonic is None:
        deadline_monotonic = sandbox.clock() + wall_deadline
    if _remaining_wall_seconds(prepared, deadline_monotonic, sandbox.clock()) <= 0:
        raise ExecutionError("the original wall deadline elapsed before create; refusing to launch")
    record: dict[str, Any] = {
        "action_id": prepared.spec.action_id,
        "action_epoch": prepared.spec.action_epoch,
        "container_name": prepared.container_name,
        "wall_seconds": wall_deadline,
    }
    try:
        record.update(sandbox.create(prepared))
        if _remaining_wall_seconds(prepared, deadline_monotonic, sandbox.clock()) <= 0:
            raise ExecutionError("the original wall deadline elapsed before start; refusing to launch")
        sandbox.start_once(record)
        observation = sandbox.wait_for_exit(prepared, record, deadline_monotonic=deadline_monotonic)
        record["outcome"] = observation.get("outcome", "unknown")
        # Output is measured only when the container actually reached a settled exit: an unknown
        # outcome is not a collection opportunity.
        output = sandbox.collect_output(prepared, record) \
            if observation.get("outcome") == "exited" else None
        return {
            "record": record,
            "observation": observation,
            "output": output,
            "audit": sandbox.audit(prepared.spec.action_id, prepared.spec.action_epoch),
        }
    finally:
        if not keep_container:
            record["cleanup"] = sandbox.cleanup([record])


# --- CLI ---------------------------------------------------------------------------------------


def _main(argv: Sequence[str] | None = None) -> int:
    """Entry point. Refusals are reported as one clear line, never as a traceback."""
    try:
        return _dispatch(argv)
    except (ExecutionError, DockerUnavailable, OSError) as error:
        print(f"refused: {error}", file=sys.stderr)
        return 2


def _dispatch(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="sandbox.py",
        description=(
            "Command-only Linux execution boundary precursor. This experiment never admits "
            "actions, publishes artifacts or decides policy."
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("bounds", help="print which bounds are enforced and which are not")

    check = subparsers.add_parser("check", help="run the host preflight and report the values")
    _add_common(check)

    run = subparsers.add_parser(
        "run",
        help="run the synthetic command Action (requires the reviewed Linux host profile)",
    )
    _add_common(run)
    run.add_argument("--action-id", default="synthetic-001")
    run.add_argument("--action-epoch", type=int, default=1)
    run.add_argument("--interpreter", default="python3",
                     help="in-container interpreter used for the synthetic probe")
    run.add_argument("--wall-seconds", type=int, default=None,
                     help=("wall deadline in seconds for the synthetic Action; it becomes part of "
                           "the prepared immutable intent, must be positive and at most the "
                           "admitted ceiling, and defaults to the admitted limit when omitted"))
    run.add_argument("--keep-container", action="store_true",
                     help="keep the owned container for manual inspection")

    arguments = parser.parse_args(argv)
    if arguments.command == "bounds":
        print(json.dumps(describe_support(), indent=2, sort_keys=True))
        return 0

    work_root = Path(arguments.work_root).resolve()
    host_facts = HostFacts.detect()
    if host_facts.system != REVIEWED_HOST_SYSTEM:
        raise PreflightRefused("this host is not Linux isolation evidence; use the reviewed Linux host")
    ledger_path = work_root / "events.jsonl"
    ledger = EventLedger(ledger_path)
    endpoint = arguments.docker_host
    if (not endpoint.startswith("unix:///") or "," in endpoint
            or not arguments.daemon_id or not Path(arguments.daemon_root).is_absolute()):
        raise PreflightRefused("an explicit reviewed local daemon endpoint and identity are required")
    docker_config = work_root / "docker-client-config"
    docker_config.mkdir(mode=0o700, parents=True, exist_ok=True)
    if docker_config.is_symlink() or any(docker_config.iterdir()):
        raise PreflightRefused("Docker client configuration must be an empty owned directory")
    commander = SubprocessCommander(binary=arguments.docker_binary,
        global_arguments=("--config", str(docker_config), "--host", endpoint))
    sandbox = CommandSandbox(
        cli=DockerCli(commander),
        work_root=work_root,
        ledger=ledger,
        host_facts=host_facts,
        admitted_images=arguments.admitted_image,
        expected_daemon_id=arguments.daemon_id,
        expected_daemon_root=arguments.daemon_root,
    )

    if arguments.command == "check":
        report = sandbox.preflight(arguments.image)
        print(json.dumps(report.as_dict(), indent=2, sort_keys=True))
        return 0

    limits = Limits() if arguments.wall_seconds is None \
        else Limits(wall_seconds=arguments.wall_seconds)
    limits.validate()
    # The synthetic input builder writes under work_root. Refuse unsupported hosts before any
    # local state is created, while keeping invalid envelopes ahead of daemon access.
    sandbox.preflight(arguments.image)
    prepared = prepare_action(
        build_synthetic_spec(
            action_id=arguments.action_id,
            action_epoch=arguments.action_epoch,
            image=arguments.image,
            work_root=work_root,
            interpreter=arguments.interpreter,
            limits=limits,
        ),
        work_root=work_root,
        control_paths=(ledger_path, ledger_path.parent / (ledger_path.name + ".lock")),
    )
    result = run_action(sandbox, prepared, keep_container=arguments.keep_container)
    observation = result["observation"]
    if observation.get("outcome") != "exited" or observation.get("exit_code") != 0:
        print(json.dumps(result, indent=2, sort_keys=True))
        print("the synthetic command did not complete successfully", file=sys.stderr)
        return 1
    try:
        proof = sandbox.verify_expected_output(
            prepared,
            expected_name=SYNTHETIC_OUTPUT_NAME,
            expected_bytes=SYNTHETIC_OUTPUT_BYTES,
        )
    except ExecutionError as error:
        # Absent, stale, wrong, symlinked or oversized output is not proof: refuse without ever
        # printing the success payload or publishing an output claim.
        print(f"the isolated output is not acceptable proof: {error}", file=sys.stderr)
        return 1
    print(json.dumps({
        "config": prepared.spec.describe(input_digest=prepared.manifest.digest),
        "intent_digest": prepared.intent_digest,
        "audit": result["audit"],
        "output": {key: result["output"][key] for key in
                   ("bytes", "manifest_digest", "enforced", "exceeded_admitted_envelope")},
        "output_proof": proof,
        "cleanup": result["record"].get("cleanup"),
        "bounds": describe_support(),
    }, indent=2, sort_keys=True))
    print("synthetic command-only precursor passed on this host", file=sys.stderr)
    return 0


def _add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--docker-host", required=True, help="reviewed private Unix daemon socket")
    parser.add_argument("--docker-binary", default="docker", help="reviewed Docker client binary")
    parser.add_argument("--daemon-id", required=True, help="reviewed docker info ID")
    parser.add_argument("--daemon-root", required=True, help="reviewed DockerRootDir")
    parser.add_argument("--work-root", required=True,
                        help="experiment-owned working root; all mounts stay under it")
    parser.add_argument("--image", required=True,
                        help="already-loaded image pinned as repository@sha256:<digest>")
    parser.add_argument("--admitted-image", action="append", default=[],
                        help="reviewed digest admitted for this run; repeatable")


if __name__ == "__main__":
    raise SystemExit(_main())
