"""Default tests for the command-only execution precursor, against a scripted Docker boundary.

These cases never start a container, never contact a daemon and never touch a real file outside
their own temporary directory: the Docker CLI is replaced by ``FakeDockerCommander``, which
records every argv and models just enough of the create/start/wait/inspect/kill/rm state machine
to reproduce the failure modes the lifecycle has to survive.

Two kinds of claim are checked here:

* what the module refuses — malformed input, unpinned images, host paths outside its root,
  environment injection, a second start, a replacement for an unknown Action, an unowned object;
* what the module observes — that the container ID is on disk before ``start`` is issued, that the
  exit code comes back from ``inspect``, that a disagreeing ``wait`` never becomes a success, and
  that a duplicate launch is visible through two independent counters.

The Linux-only preflight branches run against injected host facts, and the output-capacity
verifier is replaced by an explicit fixture. These simulate the host profile; they are not Linux
isolation evidence and say nothing about a real kernel, runsc or cgroup.
"""

from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
from dataclasses import replace
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import tracemalloc
import unittest
from unittest import mock

import sandbox
from sandbox import (
    ACTION_LABEL,
    CONTAINER_NAME_PREFIX,
    DIGEST_LABEL,
    ENFORCED_BOUNDS,
    EPOCH_LABEL,
    EXPERIMENT_OWNER,
    INPUT_DESTINATION,
    OUTPUT_DESTINATION,
    OWNER_LABEL,
    REVIEWED_DOCKER_ENGINE_VERSION,
    TMP_DESTINATION,
    UNAVAILABLE_BOUNDS,
    ActionSpec,
    AlreadyStarted,
    CommandResult,
    Commander,
    CommandSandbox,
    CreateAlreadyReserved,
    DockerCli,
    DockerUnavailable,
    EventLedger,
    ExecutionError,
    HostFacts,
    InvalidAction,
    Limits,
    OwnershipRefused,
    PreflightRefused,
    SubprocessCommander,
    SYNTHETIC_INPUT_NAME,
    SYNTHETIC_INPUT_BYTES,
    SYNTHETIC_OUTPUT_BYTES,
    SYNTHETIC_OUTPUT_NAME,
    UnsupportedCapability,
    admitted_wall_seconds,
    build_synthetic_spec,
    describe_support,
    prepare_action,
    require_output_write_time_bound,
    run_action,
)

ALLOWED_VERBS = {"version", "info", "image", "create", "start", "wait", "inspect", "kill", "rm"}


def fake_digest(seed: str) -> str:
    return "sha256:" + hashlib.sha256(seed.encode("utf-8")).hexdigest()


def fake_container_id(seed: str) -> str:
    """A realistic container ID: bare 64 lowercase hex, with no ``sha256:`` prefix."""
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()


class FakeDockerCommander(Commander):
    """A scripted Docker CLI. Models the daemon state the lifecycle depends on, nothing more."""

    def __init__(
        self,
        *,
        engine: str = REVIEWED_DOCKER_ENGINE_VERSION,
        info: dict | None = None,
        image_present: bool = True,
        repo_digests: list[str] | None = None,
        create_status: int = 0,
        create_stderr: str = "",
        start_status: int = 0,
        start_stderr: str = "driver failed programming external connectivity",
        wait_timeout_attempts: int = 0,
        exit_code: int = 0,
        wait_reported_exit_code: int | None = None,
        oom_killed: bool = False,
        restart_count: int = 0,
        config_env: tuple[str, ...] = (),
        stored_hostconfig: dict | None = None,
        stored_mounts: list[dict] | None = None,
        rm_failures: tuple[str, ...] = (),
        absent: tuple[str, ...] = (),
        create_container_id: str | None = None,
        create_stdout: str | None = None,
        id_aliases: dict | None = None,
        create_output_truncated: bool = False,
        start_output_truncated: bool = False,
        inspect_output_truncated: bool = False,
        on_command=None,
    ) -> None:
        self.engine = engine
        self.info = info if info is not None else {
            "ID": "test-reviewed-daemon", "DockerRootDir": "/test-reviewed-daemon",
            "OSType": "linux",
            "Architecture": "x86_64",
            "CgroupVersion": "2",
            "Runtimes": {"runc": {"path": "runc"}, "runsc": {"path": "/usr/local/bin/runsc"}},
        }
        self.image_present = image_present
        self.repo_digests = repo_digests
        self.create_status = create_status
        self.create_stderr = create_stderr
        self.start_status = start_status
        self.start_stderr = start_stderr
        self.wait_timeout_attempts = wait_timeout_attempts
        self.exit_code = exit_code
        self.wait_reported_exit_code = wait_reported_exit_code
        self.oom_killed = oom_killed
        self.restart_count = restart_count
        self.config_env = tuple(config_env)
        self.stored_hostconfig = stored_hostconfig or {}
        self.stored_mounts = stored_mounts
        self.rm_failures = tuple(rm_failures)
        self.absent = tuple(absent)
        self.create_container_id = create_container_id
        self.create_stdout = create_stdout
        self.id_aliases = dict(id_aliases or {})
        self.create_output_truncated = create_output_truncated
        self.start_output_truncated = start_output_truncated
        self.inspect_output_truncated = inspect_output_truncated
        self.on_command = on_command
        self.trace: list[tuple[str, ...]] = []
        self.timeouts: list[tuple[str, float]] = []
        self.docker_created_containers = 0
        self.docker_started_containers = 0
        self.containers: dict[str, dict] = {}

    # -- fake state ------------------------------------------------------------------------

    def add_container(self, name: str, *, owner: str | None = EXPERIMENT_OWNER,
                      container_id: str | None = None) -> None:
        labels = {"some.other": "experiment"} if owner is None else {OWNER_LABEL: owner}
        self.containers[name] = self._container(name, labels=labels, container_id=container_id)

    def _find_key(self, identifier: str) -> str | None:
        """Resolve a Docker identifier that may be a container name or its immutable ID."""
        alias = self.id_aliases.get(identifier)
        if alias is not None:
            return alias if alias in self.containers else None
        if identifier in self.containers:
            return identifier
        for name, container in self.containers.items():
            if str(container.get("Id", "")) == identifier:
                return name
        return None

    def _find(self, identifier: str) -> dict | None:
        key = self._find_key(identifier)
        return self.containers[key] if key is not None else None

    def _container(self, name: str, *, labels: dict | None = None, environment=None,
                   container_id: str | None = None) -> dict:
        mounts = self.stored_mounts if self.stored_mounts is not None else [
            {"Type": "bind", "Source": "/tmp/input", "Destination": INPUT_DESTINATION, "RW": False},
            {"Type": "bind", "Source": "/tmp/output", "Destination": OUTPUT_DESTINATION, "RW": True},
            {"Type": "tmpfs", "Source": "", "Destination": TMP_DESTINATION, "RW": True},
        ]
        hostconfig = {
            "Runtime": "runsc",
            "NetworkMode": "none",
            "ReadonlyRootfs": True,
            "Privileged": False,
            "Memory": 512 * 1024 * 1024,
            "PidsLimit": 512,
            "RestartPolicy": {"Name": "no", "MaximumRetryCount": 0},
            "SecurityOpt": ["no-new-privileges"],
            "CapDrop": ["ALL"],
            "CapAdd": [],
        }
        hostconfig.update(self.stored_hostconfig)
        return {
            "Id": container_id if container_id is not None else fake_container_id(name),
            "Name": "/" + name,
            "RestartCount": self.restart_count,
            "State": {
                "Status": "created",
                "Running": False,
                "Paused": False,
                "Restarting": False,
                "OOMKilled": self.oom_killed,
                "Dead": False,
                "Pid": 0,
                "ExitCode": 0,
                "Error": "",
                "StartedAt": "0001-01-01T00:00:00Z",
                "FinishedAt": "0001-01-01T00:00:00Z",
            },
            "HostConfig": hostconfig,
            "Mounts": mounts,
            "Config": {"Labels": labels or {}, "Env": list(environment or self.config_env)},
        }

    # -- command boundary ------------------------------------------------------------------

    def run(self, argv, *, timeout: float) -> CommandResult:
        argv = tuple(str(element) for element in argv)
        self.trace.append(argv)
        self.timeouts.append((argv[0] if argv else "", float(timeout)))
        if self.on_command is not None:
            self.on_command(self, argv)
        verb = argv[0] if argv else ""
        if verb not in ALLOWED_VERBS:
            raise AssertionError(f"the adapter issued an unexpected docker verb: {argv!r}")
        handler = getattr(self, f"_handle_{verb}")
        return handler(argv, timeout)

    def _result(self, argv, status=0, stdout="", stderr="", timed_out=False,
                output_truncated=False) -> CommandResult:
        return CommandResult(argv=argv, status=None if (timed_out or output_truncated) else status,
                             stdout=stdout, stderr=stderr, timed_out=timed_out,
                             output_truncated=output_truncated)

    def _handle_version(self, argv, timeout):
        return self._result(argv, stdout=self.engine + "\n")

    def _handle_info(self, argv, timeout):
        return self._result(argv, stdout=json.dumps(self.info))

    def _handle_image(self, argv, timeout):
        if not self.image_present:
            return self._result(argv, status=1, stderr="Error: No such image\n")
        digests = self.repo_digests
        if digests is None:
            reference = argv[2] if len(argv) > 2 else ""
            _, _, tail = reference.partition("@")
            digests = [f"registry.example/openbot-probe@{tail or fake_digest('image')}"]
        return self._result(argv, stdout=json.dumps({
            "Id": fake_digest("image-config"), "RepoDigests": digests,
        }))

    def _handle_create(self, argv, timeout):
        if self.create_status != 0:
            return self._result(argv, status=self.create_status, stderr=self.create_stderr)
        name = _option(argv, "--name")
        labels = {}
        for index, element in enumerate(argv):
            if element == "--label":
                key, _, value = argv[index + 1].partition("=")
                labels[key] = value
        self.docker_created_containers += 1
        self.containers[name] = self._container(name, labels=labels,
                                                container_id=self.create_container_id)
        stored = self.containers[name]
        stored["Config"]["User"] = _option(argv, "--user")
        requested = {"PidsLimit": int(_option(argv, "--pids-limit")),
                     "MemorySwap": int(_option(argv, "--memory-swap")[:-1]) * 1024 * 1024,
                     "NanoCpus": int(float(_option(argv, "--cpus")) * 1_000_000_000),
                     "Ulimits": [{"Name": argv[i+1].split('=')[0],
                                  "Soft": int(argv[i+1].split('=')[1].split(':')[0]),
                                  "Hard": int(argv[i+1].split(':')[1])}
                                 for i, item in enumerate(argv) if item == '--ulimit'],
                     "Tmpfs": {"/tmp": _option(argv, "--tmpfs").split(':', 1)[1]}}
        for key, value in requested.items():
            if key not in self.stored_hostconfig: stored["HostConfig"][key] = value
        if self.stored_mounts is None:
            for index, element in enumerate(argv):
                if element == "--mount":
                    options = dict(item.split('=', 1) for item in argv[index + 1].split(',') if '=' in item)
                    for mount in stored["Mounts"]:
                        if mount["Destination"] == options['dst']:
                            mount.update(Source=options['src'], Propagation='rprivate')
        # Model the daemon storing the per-container log configuration from the create request. A
        # test that passes ``stored_hostconfig={'LogConfig': ...}`` is simulating a daemon that
        # stored something else, so that override wins.
        if "LogConfig" not in self.stored_hostconfig:
            self.containers[name]["HostConfig"]["LogConfig"] = _log_config_from_argv(argv)
        if self.create_output_truncated:
            return self._result(argv, output_truncated=True)
        receipt = self.create_stdout
        if receipt is None:
            receipt = self.containers[name]["Id"] + "\n"
        return self._result(argv, stdout=receipt)

    def _handle_start(self, argv, timeout):
        identifier = argv[1]
        key = self._find_key(identifier)
        if key is None:
            return self._result(argv, status=1, stderr=f"Error: No such container: {identifier}\n")
        container = self.containers[key]
        if self.start_status != 0:
            return self._result(argv, status=self.start_status, stderr=self.start_stderr + "\n")
        self.docker_started_containers += 1
        container["State"].update({"Status": "running", "Running": True,
                                   "StartedAt": "2026-09-23T00:00:00Z"})
        if self.start_output_truncated:
            # The daemon started the container but the CLI response was lost to bounded capture.
            return CommandResult(argv=argv, status=None, stdout="", stderr="",
                                 output_truncated=True)
        return self._result(argv, stdout=identifier + "\n")

    def _handle_wait(self, argv, timeout):
        if self.wait_timeout_attempts > 0:
            self.wait_timeout_attempts -= 1
            return self._result(argv, timed_out=True)
        key = self._find_key(argv[1])
        if key is None:
            return self._result(argv, status=1, stderr="Error: No such container\n")
        container = self.containers[key]
        if container["State"]["Status"] != "exited":
            container["State"].update({"Status": "exited", "Running": False,
                                       "ExitCode": self.exit_code,
                                       "FinishedAt": "2026-09-23T00:00:01Z"})
        reported = self.wait_reported_exit_code
        if reported is None:
            reported = container["State"]["ExitCode"]
        return self._result(argv, stdout=f"{reported}\n")

    def _handle_inspect(self, argv, timeout):
        identifier = argv[1]
        if self.inspect_output_truncated:
            # The retained text looks like "no such object" but the capture is incomplete, so the
            # object's presence is unknown rather than absent. Status stays 1 to model the raw CLI
            # while the truncation flag marks the result as untrustworthy.
            return CommandResult(argv=argv, status=1, stdout="",
                                 stderr=f"Error: No such object: {identifier}\n",
                                 output_truncated=True)
        key = self._find_key(identifier)
        if identifier in self.absent or (key is not None and key in self.absent) or key is None:
            return self._result(argv, status=1, stderr=f"Error: No such object: {identifier}\n")
        return self._result(argv, stdout=json.dumps(self.containers[key]))

    def _handle_kill(self, argv, timeout):
        key = self._find_key(argv[1])
        if key is None:
            return self._result(argv, status=1, stderr="Error: No such container\n")
        self.containers[key]["State"].update({"Status": "exited", "Running": False, "ExitCode": 137,
                                              "FinishedAt": "2026-09-23T00:00:02Z"})
        return self._result(argv, stdout=argv[1] + "\n")

    def _handle_rm(self, argv, timeout):
        identifier = argv[-1]
        key = self._find_key(identifier)
        if key in self.rm_failures or identifier in self.rm_failures:
            return self._result(argv, status=1,
                                stderr=f"Error: cannot remove {key or identifier}\n")
        if key is not None:
            self.containers.pop(key, None)
        return self._result(argv, stdout=identifier + "\n")

    # -- assertions helpers ----------------------------------------------------------------

    def verbs(self) -> list[str]:
        return [argv[0] for argv in self.trace]

    def create_argv(self) -> tuple[str, ...]:
        for argv in self.trace:
            if argv[0] == "create":
                return argv
        raise AssertionError("no create command was issued")


def _option(argv: tuple[str, ...], name: str) -> str:
    for index, element in enumerate(argv):
        if element == name:
            return argv[index + 1]
    raise AssertionError(f"option {name} is missing from {argv!r}")


def _log_config_from_argv(argv: tuple[str, ...]) -> dict:
    """Build the ``HostConfig.LogConfig`` a daemon would store from the create request."""
    driver = ""
    options: dict[str, str] = {}
    for index, element in enumerate(argv):
        if element == "--log-driver":
            driver = argv[index + 1]
        elif element == "--log-opt":
            key, _, value = argv[index + 1].partition("=")
            options[key] = value
    return {"Type": driver, "Config": options}


def _mount_source(commander, destination: str) -> Path | None:
    """Return the host source a scripted ``create`` bound at ``destination``.

    The tests discover the output directory from the issued create argv rather than recomputing
    it, so the same fixture works whether the module uses one shared data directory or a distinct
    per-Action tree.
    """
    for argv in commander.trace:
        if argv[0] != "create":
            continue
        for index, element in enumerate(argv):
            if element != "--mount":
                continue
            fields = {}
            for piece in argv[index + 1].split(","):
                key, _, value = piece.partition("=")
                fields[key] = value
            if fields.get("dst") == destination:
                return Path(fields["src"])
    return None


class SandboxTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.work_root = self.root / "work"
        self.work_root.mkdir(parents=True)
        self.image = "registry.example/openbot-probe@sha256:" + "ab" * 32
        self.ledger = EventLedger(self.work_root / "events.jsonl")
        # Lifecycle tests model an already provisioned mount. The kernel verifier has separate
        # counterexamples; this fixture is never used by the CLI or real Linux probe.
        capacity_patch = mock.patch("sandbox.verify_output_capacity", side_effect=self.capacity)
        self.capacity_verifier = capacity_patch.start()
        self.addCleanup(capacity_patch.stop)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    # -- fixtures --------------------------------------------------------------------------

    @staticmethod
    def capacity(directory: Path, limit_bytes: int) -> dict:
        return {"version": 1, "path": str(directory), "mount_id": 42, "device": "7:0",
                "inode": directory.stat().st_ino, "filesystem": "ext4",
                "device_bytes": limit_bytes, "filesystem_bytes": limit_bytes // 2,
                "limit_bytes": limit_bytes}

    def build(self, *, host_facts: HostFacts | None = None, admitted: bool = True, **kwargs):
        commander = FakeDockerCommander(**kwargs)
        sandbox = CommandSandbox(
            cli=DockerCli(commander),
            work_root=self.work_root,
            ledger=self.ledger,
            host_facts=host_facts or HostFacts(system="linux", machine="x86_64"),
            admitted_images=[self.image] if admitted else [],
            clock=lambda: 100.0,
        )
        return commander, sandbox

    def write_input(self, name: str = "source.csv", payload: bytes = b"row,value\n7,old\n") -> Path:
        input_dir = self.work_root / "input"
        input_dir.mkdir(parents=True, exist_ok=True)
        (input_dir / name).write_bytes(payload)
        return input_dir

    def write_output_dir(self) -> Path:
        output_dir = self.work_root / "output"
        output_dir.mkdir(parents=True, exist_ok=True)
        return output_dir

    def spec(self, *, input_payload: bytes = b"row,value\n7,old\n", **overrides) -> ActionSpec:
        values = {
            "action_id": "action-001",
            "action_epoch": 1,
            "image": self.image,
            "command": ("/usr/bin/probe", "--read", "/input/source.csv"),
            "input_dir": self.write_input(payload=input_payload),
            "output_dir": self.write_output_dir(),
            "limits": Limits(),
        }
        values.update(overrides)
        return ActionSpec(**values)

    def prepare(self, *, input_payload: bytes = b"row,value\n7,old\n", **overrides):
        return prepare_action(self.spec(input_payload=input_payload, **overrides),
                              work_root=self.work_root)

    # -- argument confinement --------------------------------------------------------------

    def test_create_arguments_confine_the_workload(self) -> None:
        commander, sandbox = self.build()
        prepared = self.prepare()
        sandbox.create(prepared)
        argv = commander.create_argv()
        text = " ".join(argv)
        for required in ("--pull=never", "--restart", "no", "--network", "none",
                         "--read-only", "--cap-drop", "ALL", "--security-opt",
                         "no-new-privileges"):
            self.assertIn(required, argv, f"{required} must be part of the create arguments")
        for forbidden in ("--privileged", "--cap-add", "--device", "--pid", "--ipc",
                          "/var/run/docker.sock", "host"):
            self.assertNotIn(forbidden, argv, f"{forbidden} must not appear in the create argv")
        self.assertIn("--runtime", argv)
        self.assertEqual(_option(argv, "--runtime"), "runsc")
        self.assertIn("--user", argv)
        self.assertEqual(_option(argv, "--user"), "10001:10001")
        self.assertIn("--memory", argv)
        self.assertEqual(_option(argv, "--memory"), "512m")
        self.assertEqual(_option(argv, "--memory-swap"), "512m")
        self.assertEqual(_option(argv, "--pids-limit"), "512")
        self.assertEqual(_option(argv, "--ulimit"), "nofile=256:256")
        self.assertEqual(_option(argv, "--cpus"), "1")
        tmpfs = _option(argv, "--tmpfs")
        self.assertTrue(tmpfs.startswith(f"{TMP_DESTINATION}:rw,nosuid,nodev,noexec,size="))
        # Mounts may only point at the two directories this experiment owns.
        mounts = [argv[index + 1] for index, element in enumerate(argv) if element == "--mount"]
        self.assertEqual(len(mounts), 2)
        self.assertIn(f"dst={INPUT_DESTINATION},readonly", mounts[0])
        self.assertTrue(mounts[0].startswith(f"type=bind,src={self.work_root}"))
        self.assertIn(f"dst={OUTPUT_DESTINATION}", mounts[1])
        self.assertTrue(mounts[1].startswith(f"type=bind,src={self.work_root}"))
        self.assertEqual(argv[-3:], ("/usr/bin/probe", "--read", "/input/source.csv"))
        # No environment variable reaches the workload at all.
        self.assertNotIn("--env", argv)
        self.assertNotIn("-e", argv)

    def test_labels_bind_owner_action_digest_and_epoch(self) -> None:
        commander, sandbox = self.build()
        prepared = self.prepare()
        sandbox.create(prepared)
        argv = commander.create_argv()
        labels = [argv[index + 1] for index, element in enumerate(argv) if element == "--label"]
        self.assertIn(f"{OWNER_LABEL}={EXPERIMENT_OWNER}", labels)
        self.assertIn(f"{ACTION_LABEL}=action-001", labels)
        self.assertIn(f"{EPOCH_LABEL}=1", labels)
        self.assertIn(f"{DIGEST_LABEL}={prepared.intent_digest}", labels)

    def test_create_bounds_the_daemon_log_and_reads_it_back(self) -> None:
        commander, sandbox = self.build()
        prepared = self.prepare(limits=Limits(captured_output_kib=256))
        sandbox.create(prepared)
        argv = commander.create_argv()
        self.assertEqual(_option(argv, "--log-driver"), "local")
        log_options = [argv[index + 1] for index, element in enumerate(argv)
                       if element == "--log-opt"]
        # The admitted 256 KiB capture budget is split across the fixed two log files.
        self.assertIn("max-size=128k", log_options)
        self.assertIn("max-file=2", log_options)
        # The daemon must have stored exactly that bounded configuration before any start.
        stored = commander.containers[prepared.container_name]["HostConfig"]["LogConfig"]
        self.assertEqual(stored["Type"], "local")
        self.assertEqual(stored["Config"], {"max-size": "128k", "max-file": "2"})
        self.assertNotIn("start", commander.verbs())

    def test_a_tiny_capture_budget_still_sets_a_bounded_log(self) -> None:
        commander, sandbox = self.build()
        prepared = self.prepare(limits=Limits(captured_output_kib=1))
        sandbox.create(prepared)
        argv = commander.create_argv()
        log_options = [argv[index + 1] for index, element in enumerate(argv)
                       if element == "--log-opt"]
        # Below Docker's documented per-file floor the retention is still a fixed small bound.
        self.assertIn("max-size=8k", log_options)
        self.assertIn("max-file=2", log_options)

    def test_a_daemon_that_stored_a_different_log_driver_is_refused_before_start(self) -> None:
        commander, sandbox = self.build(
            stored_hostconfig={"LogConfig": {"Type": "json-file", "Config": {}}}
        )
        with self.assertRaises(ExecutionError) as caught:
            sandbox.create(self.prepare())
        self.assertIn("log driver", str(caught.exception))
        self.assertNotIn("start", commander.verbs())
        events = [event["event"] for event in self.ledger.read()]
        self.assertNotIn("container_created", events)

    def test_a_daemon_that_stored_wider_log_retention_is_refused_before_start(self) -> None:
        commander, sandbox = self.build(
            stored_hostconfig={
                "LogConfig": {"Type": "local",
                              "Config": {"max-size": "20m", "max-file": "5"}},
            }
        )
        with self.assertRaises(ExecutionError) as caught:
            sandbox.create(self.prepare())
        message = str(caught.exception)
        self.assertIn("log max-size", message)
        self.assertIn("log max-file", message)
        self.assertNotIn("start", commander.verbs())
        events = [event["event"] for event in self.ledger.read()]
        self.assertNotIn("container_created", events)

    def test_the_created_object_is_read_back_before_it_can_start(self) -> None:
        commander, sandbox = self.build(stored_hostconfig={"ReadonlyRootfs": False})
        prepared = self.prepare()
        with self.assertRaises(ExecutionError) as caught:
            sandbox.create(prepared)
        self.assertIn("read-only", str(caught.exception))
        self.assertNotIn("start", commander.verbs())
        # The unverified object is not recorded as an Action this experiment may start.
        self.assertEqual(self.ledger.counters("action-001", 1).launches, 0)

    def test_a_daemon_that_stored_an_extra_mount_is_refused(self) -> None:
        mounts = [
            {"Type": "bind", "Source": "/tmp/input", "Destination": INPUT_DESTINATION, "RW": False},
            {"Type": "bind", "Source": "/tmp/output", "Destination": OUTPUT_DESTINATION, "RW": True},
            {"Type": "tmpfs", "Source": "", "Destination": TMP_DESTINATION, "RW": True},
            {"Type": "bind", "Source": "/var/run/docker.sock", "Destination": "/sock", "RW": True},
        ]
        commander, sandbox = self.build(stored_mounts=mounts)
        with self.assertRaises(ExecutionError) as caught:
            sandbox.create(self.prepare())
        self.assertIn("/sock", str(caught.exception))
        self.assertNotIn("start", commander.verbs())

    def test_image_must_be_pinned_by_digest(self) -> None:
        commander, sandbox = self.build()
        with self.assertRaises(InvalidAction) as caught:
            self.prepare(image="registry.example/openbot-probe:latest")
        self.assertIn("@sha256", str(caught.exception))
        self.assertEqual(commander.trace, [])

    def test_malformed_input_is_refused_before_any_command(self) -> None:
        commander, _ = self.build()
        cases = {
            "action id with a path separator": {"action_id": "../escape"},
            "action id that is empty": {"action_id": ""},
            "epoch below one": {"action_epoch": 0},
            "epoch that is not an integer": {"action_epoch": "1"},
            "empty command": {"command": ()},
            "command element that is not a string": {"command": ("ok", 7)},
            "command element with a NUL byte": {"command": ("/bin/probe", "bad\x00arg")},
            "command with an empty element": {"command": ("/bin/probe", "")},
        }
        for label, overrides in cases.items():
            with self.subTest(label):
                with self.assertRaises(InvalidAction):
                    self.prepare(**overrides)
        self.assertEqual(commander.trace, [])

    def test_command_characters_are_never_shell_interpreted(self) -> None:
        commander, sandbox = self.build()
        hostile = "; rm -rf / #"
        prepared = self.prepare(command=("/usr/bin/probe", hostile, "$(touch /tmp/owned)"))
        sandbox.create(prepared)
        argv = commander.create_argv()
        # The hostile text stays one argv element; no shell program is ever introduced.
        self.assertEqual(argv[-2], hostile)
        self.assertEqual(argv[-1], "$(touch /tmp/owned)")
        self.assertNotIn("sh", argv)
        self.assertNotIn("-c", argv)

    def test_environment_injection_is_refused(self) -> None:
        with self.assertRaises(InvalidAction) as caught:
            self.prepare(environment=(("OPENBOT_CONTROL_TOKEN", "value"),))
        self.assertIn("environment", str(caught.exception).lower())

    def test_an_image_declaring_control_looking_secrets_is_refused(self) -> None:
        commander, sandbox = self.build(config_env=("PATH=/usr/bin", "OPENBOT_API_KEY=abc"))
        with self.assertRaises(ExecutionError) as caught:
            sandbox.create(self.prepare())
        self.assertIn("OPENBOT_API_KEY", str(caught.exception))
        self.assertNotIn("start", commander.verbs())

    def test_input_outside_the_working_root_is_refused(self) -> None:
        outside = self.root / "outside"
        outside.mkdir()
        commander, _ = self.build()
        with self.assertRaises(InvalidAction) as caught:
            self.prepare(input_dir=outside)
        self.assertIn("outside the experiment working root", str(caught.exception))
        self.assertEqual(commander.trace, [])

    def test_a_symlink_escaping_the_working_root_is_refused(self) -> None:
        link = self.work_root / "escape"
        os.symlink("/etc", link)
        commander, _ = self.build()
        with self.assertRaises(InvalidAction) as caught:
            self.prepare(input_dir=link)
        self.assertIn("outside the experiment working root", str(caught.exception))
        self.assertEqual(commander.trace, [])

    def test_a_symlink_inside_the_input_tree_is_refused(self) -> None:
        input_dir = self.write_input()
        os.symlink("/etc/hosts", input_dir / "link")
        with self.assertRaises(InvalidAction) as caught:
            prepare_action(self.spec(input_dir=input_dir), work_root=self.work_root)
        self.assertIn("symlink", str(caught.exception))

    def test_limits_above_the_admitted_ceiling_are_refused(self) -> None:
        commander, _ = self.build()
        for label, limits in {
            "memory": Limits(memory_mib=4096),
            "cpus": Limits(cpus=4.0),
            "pids": Limits(pids=100_000),
            "wall": Limits(wall_seconds=3600),
            "output": Limits(output_mib=1024),
        }.items():
            with self.subTest(label):
                with self.assertRaises(InvalidAction) as caught:
                    self.prepare(limits=limits)
                self.assertIn("ceiling", str(caught.exception))
        self.assertEqual(commander.trace, [])

    # -- lifecycle invariants --------------------------------------------------------------

    def test_the_container_id_is_persisted_before_start_is_issued(self) -> None:
        snapshots: list[tuple[tuple[str, ...], list[dict]]] = []

        def observe(_commander, argv):
            snapshots.append((argv, self.ledger.read()))

        commander, sandbox = self.build(on_command=observe)
        prepared = self.prepare()
        record = sandbox.create(prepared)
        sandbox.start_once(record)

        at_start = [events for argv, events in snapshots if argv[0] == "start"]
        self.assertEqual(len(at_start), 1, "exactly one start must have been issued")
        before = at_start[0]
        created = [event for event in before if event["event"] == "container_created"]
        self.assertEqual(len(created), 1, "the container ID must be on disk before start")
        self.assertEqual(created[0]["detail"]["container_id"], record["container_id"])
        self.assertEqual(created[0]["detail"]["container_name"], prepared.container_name)
        # And the start attempt is recorded before the command is issued, not after it returns.
        self.assertIn("start_attempt", [event["event"] for event in before])

    def test_a_second_start_is_refused_and_the_command_is_not_repeated(self) -> None:
        commander, sandbox = self.build()
        prepared = self.prepare()
        record = sandbox.create(prepared)
        sandbox.start_once(record)
        with self.assertRaises(AlreadyStarted):
            sandbox.start_once(record)
        self.assertEqual(commander.verbs().count("start"), 1)
        self.assertEqual(commander.docker_started_containers, 1)
        # Even after the container exits, a restart is refused: Docker would run the command again.
        sandbox.wait_for_exit(prepared, record, deadline_monotonic=sandbox.clock() + prepared.spec.limits.wall_seconds)
        with self.assertRaises(AlreadyStarted):
            sandbox.start_once(record)
        self.assertEqual(commander.verbs().count("start"), 1)

    def test_recovery_of_an_unknown_action_never_creates_or_starts(self) -> None:
        commander, sandbox = self.build()
        outcome = sandbox.recover("never-recorded", 1)
        self.assertEqual(outcome["outcome"], "unknown")
        self.assertEqual(outcome["decision"], "do_not_create")
        self.assertEqual(commander.trace, [])

    def test_recovery_of_an_absent_container_is_unknown_not_success(self) -> None:
        commander, sandbox = self.build()
        prepared = self.prepare()
        record = sandbox.create(prepared)
        sandbox.start_once(record)
        # The daemon stops reporting the object after the command ran.
        commander.absent = (prepared.container_name,)
        before = len(commander.trace)
        outcome = sandbox.recover("action-001", 1)
        self.assertEqual(outcome["outcome"], "unknown")
        self.assertIn("do not prove non-execution", outcome["reason"])
        self.assertEqual({argv[0] for argv in commander.trace[before:]}, {"inspect"})
        self.assertEqual(commander.verbs().count("start"), 1)

    def test_recovery_of_a_created_but_unstarted_container_does_not_start_it(self) -> None:
        commander, sandbox = self.build()
        sandbox.create(self.prepare())
        outcome = sandbox.recover("action-001", 1)
        self.assertEqual(outcome["outcome"], "created_not_started")
        self.assertEqual(outcome["decision"], "do_not_start")
        self.assertNotIn("start", commander.verbs())

    def test_recovery_reports_an_exited_container_from_the_same_object(self) -> None:
        commander, sandbox = self.build(exit_code=0)
        prepared = self.prepare()
        record = sandbox.create(prepared)
        sandbox.start_once(record)
        observation = sandbox.wait_for_exit(prepared, record, deadline_monotonic=sandbox.clock() + prepared.spec.limits.wall_seconds)
        self.assertEqual(observation["exit_code"], 0)

        before = len(commander.trace)
        outcome = sandbox.recover("action-001", 1)
        self.assertEqual(outcome["outcome"], "exited")
        self.assertEqual(outcome["container_id"], record["container_id"])
        self.assertEqual(outcome["exit_code"], 0)
        # Recovery only looks: no create and no second start appears in the commands it issued.
        self.assertEqual({argv[0] for argv in commander.trace[before:]}, {"inspect"})
        self.assertEqual(commander.verbs().count("start"), 1)

    # -- TASK023: immutable container identity ---------------------------------------------

    def test_create_accepts_a_realistic_bare_container_id(self) -> None:
        realistic = fake_container_id("realistic-container")
        commander, sandbox = self.build(create_container_id=realistic)
        record = sandbox.create(self.prepare())
        self.assertEqual(record["container_id"], realistic)
        self.assertRegex(record["container_id"], r"^[0-9a-f]{64}$")
        self.assertNotIn("sha256:", record["container_id"])
        self.assertNotIn("start", commander.verbs())

    def test_create_refuses_a_container_id_that_is_only_an_image_digest(self) -> None:
        # ``sha256:<64hex>`` is the image digest shape, not a container ID.
        commander, sandbox = self.build(create_container_id=fake_digest("not-a-container-id"))
        prepared = self.prepare()
        with self.assertRaises(ExecutionError) as caught:
            sandbox.create(prepared)
        self.assertIn("container ID", str(caught.exception))
        events = [event["event"] for event in self.ledger.read()]
        self.assertNotIn("container_created", events)
        self.assertNotIn("start", commander.verbs())

    def test_create_refuses_malformed_container_ids(self) -> None:
        malformed = {
            "image_digest_shape": fake_digest("shape"),
            "uppercase_hex": "AB" * 32,
            "too_short": "ab" * 31,
            "too_long": "ab" * 33,
            "not_hex": "zz" * 32,
            "empty": "",
        }
        for label, value in malformed.items():
            with self.subTest(label):
                commander = FakeDockerCommander(create_container_id=value)
                sandbox = CommandSandbox(
                    cli=DockerCli(commander),
                    work_root=self.work_root,
                    ledger=EventLedger(self.work_root / f"events-{label}.jsonl"),
                    host_facts=HostFacts(system="linux", machine="x86_64"),
                    admitted_images=[self.image],
                )
                with self.assertRaises(ExecutionError):
                    sandbox.create(self.prepare())
                self.assertNotIn("start", commander.verbs())

    def test_create_persists_the_create_receipt_when_the_name_is_reused(self) -> None:
        """The ID printed by ``docker create`` is authoritative even if its name is reused.

        The create receipt is the only proof of which object this Action owns. If the read-back
        resolves the mutable name again, a container that reclaimed that name during the handoff
        window would be persisted as this Action's object and could later be started. The receipt
        ID must be inspected and recorded; the name must never be used for the read-back.
        """
        receipt_id = fake_container_id("create-receipt-original")
        replacement_id = fake_container_id("create-receipt-replacement")
        self.assertNotEqual(receipt_id, replacement_id)
        prepared = self.prepare()
        inspected_identifiers: list[str] = []

        def reuse_the_name(commander, argv):
            # Model the handoff race: by the time the created object is read back, its name has
            # been reclaimed by a different container. The original object is still reachable, but
            # only by its immutable ID (as after a rename), never by the reused name.
            if argv[0] != "inspect" or inspected_identifiers:
                return
            inspected_identifiers.append(argv[1])
            original = commander.containers.pop(prepared.container_name, None)
            if original is not None:
                commander.containers[prepared.container_name + "-detached"] = original
            commander.add_container(prepared.container_name, container_id=replacement_id)

        commander, sandbox = self.build(create_container_id=receipt_id,
                                        on_command=reuse_the_name)
        record = sandbox.create(prepared)

        self.assertEqual(inspected_identifiers, [receipt_id],
                         "the read-back must inspect the create receipt ID, never the name")
        self.assertEqual(record["container_id"], receipt_id)
        self.assertNotEqual(record["container_id"], replacement_id)
        persisted = [event for event in self.ledger.read() if event["event"] == "container_created"]
        self.assertEqual(persisted[-1]["detail"]["container_id"], receipt_id)

        sandbox.start_once(record)
        start_targets = [argv[1] for argv in commander.trace if argv[0] == "start"]
        self.assertEqual(start_targets, [receipt_id])
        self.assertNotIn(replacement_id, start_targets)
        # The same-name replacement was never inspected, started or removed.
        self.assertEqual(commander.containers[prepared.container_name]["Id"], replacement_id)
        self.assertNotIn("rm", commander.verbs())

    def test_create_refuses_a_read_back_that_returns_a_different_object(self) -> None:
        """Even the receipt ID lookup is verified: a different object must not be recorded."""
        receipt_id = fake_container_id("create-receipt")
        replacement_id = fake_container_id("create-receipt-different")
        prepared = self.prepare()

        def misdirect_the_receipt(commander, argv):
            if argv[0] != "inspect" or argv[1] != receipt_id:
                return
            # The daemon answers the receipt ID with a different object.
            commander.id_aliases[receipt_id] = prepared.container_name
            commander.add_container(prepared.container_name, container_id=replacement_id)

        commander, sandbox = self.build(create_container_id=receipt_id,
                                        on_command=misdirect_the_receipt)
        with self.assertRaises(ExecutionError) as caught:
            sandbox.create(prepared)
        self.assertIn("instead of the create receipt ID", str(caught.exception))
        events = [event["event"] for event in self.ledger.read()]
        self.assertIn("container_create_unverified", events)
        self.assertNotIn("container_created", events)
        self.assertNotIn("start", commander.verbs())
        self.assertNotIn("rm", commander.verbs())
        self.assertEqual(commander.verbs().count("create"), 1)

    def test_create_refuses_an_absent_receipt_instead_of_falling_back_to_the_name(self) -> None:
        """A created object with no usable receipt ID stays unknown, never identified by name."""
        named_only_id = fake_container_id("named-only-object")
        # The object is created and the name resolves to it, but ``docker create`` printed no ID.
        commander, sandbox = self.build(create_container_id=named_only_id, create_stdout="\n")
        prepared = self.prepare()
        with self.assertRaises(ExecutionError) as caught:
            sandbox.create(prepared)
        self.assertIn("did not return a bare 64-character container ID", str(caught.exception))
        events = [event["event"] for event in self.ledger.read()]
        self.assertIn("container_create_unverified", events)
        self.assertNotIn("container_created", events)
        self.assertNotIn("start", commander.verbs())
        self.assertNotIn("rm", commander.verbs())
        self.assertEqual(commander.verbs().count("create"), 1)
        # The mutable name was never used as a fallback identity.
        self.assertEqual([argv for argv in commander.trace if argv[0] == "inspect"], [])

    def test_recovery_targets_the_exact_owned_container_id(self) -> None:
        commander, sandbox = self.build()
        record = sandbox.create(self.prepare())
        before = len(commander.trace)
        sandbox.recover("action-001", 1)
        issued = commander.trace[before:]
        self.assertEqual({argv[0] for argv in issued}, {"inspect"})
        for argv in issued:
            self.assertEqual(argv[1], record["container_id"])

    def test_recovery_refuses_a_same_name_replacement_object(self) -> None:
        commander, sandbox = self.build(exit_code=0)
        prepared = self.prepare()
        record = sandbox.create(prepared)
        sandbox.start_once(record)
        sandbox.wait_for_exit(prepared, record, deadline_monotonic=sandbox.clock() + prepared.spec.limits.wall_seconds)
        # The name is reused by a different, unstarted object with a different immutable ID.
        replacement_id = fake_container_id("replacement-container")
        self.assertNotEqual(replacement_id, record["container_id"])
        commander.add_container(prepared.container_name, container_id=replacement_id)
        before = len(commander.trace)
        outcome = sandbox.recover("action-001", 1)
        self.assertEqual(outcome["outcome"], "unknown")
        self.assertEqual(outcome["decision"], "reconcile")
        self.assertEqual(outcome["container_id"], record["container_id"])
        self.assertNotEqual(outcome["container_id"], replacement_id)
        issued = {argv[0] for argv in commander.trace[before:]}
        self.assertNotIn("start", issued)
        self.assertNotIn("create", issued)
        self.assertNotIn("rm", issued)

    def test_lifecycle_commands_use_the_exact_owned_container_id(self) -> None:
        commander, sandbox = self.build(wait_timeout_attempts=1, exit_code=137)
        # A one-second deadline is admitted as part of the immutable Action, not overridden later.
        prepared = self.prepare(limits=Limits(wall_seconds=1))
        record = sandbox.create(prepared)
        owned = record["container_id"]
        sandbox.start_once(record)
        sandbox.wait_for_exit(prepared, record, deadline_monotonic=sandbox.clock() + prepared.spec.limits.wall_seconds)
        report = sandbox.cleanup([record])

        def target(argv):
            return argv[-1] if argv[0] == "rm" else argv[1]

        for verb in ("start", "wait", "kill"):
            commands = [argv for argv in commander.trace if argv[0] == verb]
            self.assertTrue(commands, f"no {verb} command was issued")
            for argv in commands:
                self.assertEqual(target(argv), owned)
        removes = [argv for argv in commander.trace if argv[0] == "rm"]
        self.assertEqual(len(removes), 1)
        self.assertEqual(target(removes[0]), owned)
        self.assertEqual(report["removed"], [prepared.container_name])
        self.assertNotIn(prepared.container_name, commander.containers)

    def test_recovery_refuses_an_object_inspected_under_the_wrong_id(self) -> None:
        commander, sandbox = self.build()
        prepared = self.prepare()
        record = sandbox.create(prepared)
        owned = record["container_id"]
        # A daemon that answers the recorded ID with a different object: verification must catch
        # it even though the identifier used for the lookup was the recorded immutable one.
        replacement_id = fake_container_id("replacement-container")
        commander.add_container(prepared.container_name, container_id=replacement_id)
        commander.id_aliases = {owned: prepared.container_name}
        outcome = sandbox.recover("action-001", 1)
        self.assertEqual(outcome["outcome"], "unknown")
        self.assertEqual(outcome["decision"], "reconcile")
        self.assertEqual(outcome["container_id"], owned)
        self.assertEqual(outcome["observed_container_id"], replacement_id)
        self.assertIn("different object", outcome["reason"])
        self.assertNotIn("start", commander.verbs())
        self.assertNotIn("rm", commander.verbs())

    def test_cleanup_does_not_remove_a_same_name_replacement(self) -> None:
        commander, sandbox = self.build()
        prepared = self.prepare()
        record = sandbox.create(prepared)
        replacement_id = fake_container_id("replacement-container")
        commander.add_container(prepared.container_name, container_id=replacement_id)
        report = sandbox.cleanup([record])
        self.assertEqual(report["removed"], [])
        self.assertEqual(report["failed"], [])
        self.assertEqual(len(report["refused"]), 1)
        self.assertEqual(report["refused"][0]["reason"], "not visible to the daemon")
        self.assertNotIn("rm", commander.verbs())
        self.assertIn(prepared.container_name, commander.containers)
        self.assertEqual(commander.containers[prepared.container_name]["Id"], replacement_id)

    def test_a_non_integer_exit_code_stays_unknown_for_the_owned_id(self) -> None:
        commander, sandbox = self.build(exit_code=None)
        prepared = self.prepare()
        record = sandbox.create(prepared)
        sandbox.start_once(record)
        observation = sandbox.wait_for_exit(prepared, record, deadline_monotonic=sandbox.clock() + prepared.spec.limits.wall_seconds)
        self.assertEqual(observation["outcome"], "unknown")
        self.assertEqual(observation["unknown_reason"], "inspect returned no integer exit code")
        unknown = [event for event in self.ledger.read() if event["event"] == "exit_unknown"]
        self.assertEqual(unknown[-1]["detail"]["container_id"], record["container_id"])

    def test_audit_does_not_attribute_a_reused_name_without_an_immutable_id(self) -> None:
        commander, sandbox = self.build(restart_count=1)
        prepared = self.prepare()
        sandbox.create(prepared)
        self.ledger.append(
            action_id=prepared.spec.action_id,
            action_epoch=prepared.spec.action_epoch,
            event="container_created",
            detail={"container_name": prepared.container_name, "container_id": ""},
        )
        before = len(commander.trace)
        report = sandbox.audit(prepared.spec.action_id, prepared.spec.action_epoch)
        self.assertEqual(commander.trace[before:], [])
        self.assertIsNone(report["docker_restart_count"])
        self.assertFalse(report["duplicate_execution"])

    # -- partial failure -------------------------------------------------------------------

    def test_a_failed_create_never_reaches_start_and_is_cleaned_up(self) -> None:
        commander, sandbox = self.build(create_status=125, create_stderr="name is already in use")
        prepared = self.prepare()
        with self.assertRaises(ExecutionError) as caught:
            run_action(sandbox, prepared)
        self.assertIn("docker create failed", str(caught.exception))
        self.assertNotIn("start", commander.verbs())
        self.assertEqual(commander.docker_started_containers, 0)
        events = [event["event"] for event in self.ledger.read()]
        self.assertIn("container_create_failed", events)
        self.assertNotIn("start_attempt", events)
        # Cleanup still ran and reported that there was nothing owned to remove.
        self.assertIn("cleanup_refused", events)
        self.assertNotIn("rm", commander.verbs())

    def test_a_created_object_that_cannot_be_read_back_is_not_started_or_replaced(self) -> None:
        commander, sandbox = self.build(
            absent=(f"{CONTAINER_NAME_PREFIX}action-001-1",))
        prepared = self.prepare()
        with self.assertRaises(ExecutionError) as caught:
            sandbox.create(prepared)
        self.assertIn("no replacement", str(caught.exception))
        self.assertNotIn("start", commander.verbs())
        self.assertEqual(commander.verbs().count("create"), 1)
        events = [event["event"] for event in self.ledger.read()]
        self.assertIn("container_create_unverified", events)
        self.assertNotIn("container_created", events)

    def test_a_failed_start_is_recorded_and_never_retried(self) -> None:
        commander, sandbox = self.build(start_status=125)
        prepared = self.prepare()
        record = sandbox.create(prepared)
        with self.assertRaises(ExecutionError) as caught:
            sandbox.start_once(record)
        self.assertIn("never restarted or replaced", str(caught.exception))
        self.assertEqual(commander.verbs().count("start"), 1)
        events = [event["event"] for event in self.ledger.read()]
        self.assertIn("start_attempt", events)
        self.assertIn("start_failed", events)
        self.assertNotIn("start_succeeded", events)
        # Recovery must not turn a failed start into a retry.
        after = sandbox.recover("action-001", 1)
        self.assertEqual(after["outcome"], "unknown")
        self.assertEqual(after["decision"], "do_not_start")
        self.assertEqual(commander.verbs().count("start"), 1)
        report = sandbox.cleanup([record])
        self.assertEqual(report["removed"], [prepared.container_name])
        self.assertEqual(report["failed"], [])

    def test_a_truncated_create_is_uncertain_and_never_retried(self) -> None:
        commander, sandbox = self.build(create_output_truncated=True)
        prepared = self.prepare()
        with self.assertRaises(ExecutionError) as caught:
            sandbox.create(prepared)
        self.assertIn("unknown", str(caught.exception).lower())
        events = [event["event"] for event in self.ledger.read()]
        self.assertIn("container_create_unverified", events)
        self.assertNotIn("container_create_failed", events)
        self.assertNotIn("container_created", events)
        # The object may exist, so the reservation stands and a second create is refused.
        with self.assertRaises(CreateAlreadyReserved):
            sandbox.create(prepared)
        self.assertEqual(commander.verbs().count("create"), 1)

    def test_a_truncated_start_is_uncertain_and_never_retried(self) -> None:
        commander, sandbox = self.build(start_output_truncated=True)
        prepared = self.prepare()
        record = sandbox.create(prepared)
        with self.assertRaises(ExecutionError) as caught:
            sandbox.start_once(record)
        self.assertIn("unknown", str(caught.exception).lower())
        events = [event["event"] for event in self.ledger.read()]
        self.assertIn("start_attempt", events)
        self.assertIn("start_unverified", events)
        self.assertNotIn("start_failed", events)
        self.assertNotIn("start_succeeded", events)
        with self.assertRaises(AlreadyStarted):
            sandbox.start_once(record)
        self.assertEqual(commander.verbs().count("start"), 1)
        # The daemon did start it; recovery observes that and never issues another start.
        self.assertEqual(sandbox.recover("action-001", 1)["outcome"], "running")
        self.assertEqual(commander.verbs().count("start"), 1)

    def test_a_truncated_inspect_is_not_treated_as_absent(self) -> None:
        commander, _ = self.build(inspect_output_truncated=True)
        with self.assertRaises(DockerUnavailable):
            DockerCli(commander).inspect(self.image)

    def test_the_wall_deadline_kills_and_settles_the_exit_code(self) -> None:
        commander, sandbox = self.build(wait_timeout_attempts=1, exit_code=137)
        # The one-second deadline is admitted in the prepared immutable Action, not overridden.
        prepared = self.prepare(limits=Limits(wall_seconds=1))
        result = run_action(sandbox, prepared)
        self.assertIn("kill", commander.verbs())
        events = [event["event"] for event in self.ledger.read()]
        self.assertIn("wall_deadline_exceeded", events)
        self.assertIn("kill_issued", events)
        self.assertIn("exit_observed", events)
        self.assertEqual(result["observation"]["exit_code"], 137)
        self.assertNotEqual(result["observation"]["exit_code"], 0)

    def test_a_disagreeing_wait_primitive_never_becomes_success(self) -> None:
        commander, sandbox = self.build(exit_code=137, wait_reported_exit_code=0)
        prepared = self.prepare(limits=Limits(wall_seconds=5))
        result = run_action(sandbox, prepared)
        self.assertEqual(result["observation"]["outcome"], "conflicting")
        self.assertIn("different exit codes", result["observation"]["unknown_reason"])
        events = [event["event"] for event in self.ledger.read()]
        self.assertIn("exit_conflict", events)
        # No output claim is made for a conflicting outcome.
        self.assertIsNone(result["output"])
        self.assertNotIn("output_collected", events)

    def test_a_lost_receipt_is_reconstructed_by_inspecting_the_same_object(self) -> None:
        commander, sandbox = self.build(exit_code=0)
        prepared = self.prepare()
        record = sandbox.create(prepared)
        sandbox.start_once(record)
        sandbox.wait_for_exit(prepared, record, deadline_monotonic=sandbox.clock() + prepared.spec.limits.wall_seconds)
        # Model an acknowledgement that never landed: the observation is dropped from the ledger.
        kept = [record_ for record_ in self.ledger.read() if record_["event"] != "exit_observed"]
        self.ledger.path.write_text(
            "".join(json.dumps(entry, sort_keys=True) + "\n" for entry in kept), encoding="utf-8")
        before = len(commander.trace)

        outcome = sandbox.recover("action-001", 1)
        self.assertEqual(outcome["outcome"], "exited")
        self.assertEqual(outcome["container_id"], record["container_id"])
        self.assertEqual(outcome["exit_code"], 0)
        self.assertEqual(self.ledger.counters("action-001", 1).launches, 1)
        for argv in commander.trace[before:]:
            self.assertIn(argv[0], {"inspect"})

    def test_duplicate_execution_is_visible_through_two_independent_counters(self) -> None:
        commander, sandbox = self.build(exit_code=0)
        prepared = self.prepare()
        record = sandbox.create(prepared)
        sandbox.start_once(record)
        sandbox.wait_for_exit(prepared, record, deadline_monotonic=sandbox.clock() + prepared.spec.limits.wall_seconds)
        clean = sandbox.audit("action-001", 1)
        self.assertFalse(clean["duplicate_execution"])
        self.assertEqual(clean["launches"], 1)
        self.assertEqual(clean["docker_restart_count"], 0)

        # Signal one: the ledger. A fabricated extra launch is exposed even though the daemon
        # only ever started one container.
        self.ledger.append(action_id="action-001", action_epoch=1, event="start_succeeded",
                           detail={"container_id": record["container_id"]})
        self.assertTrue(sandbox.audit("action-001", 1)["duplicate_execution"])
        self.assertEqual(commander.docker_started_containers, 1)

        # Signal two: the daemon's own restart counter, which is independent of anything we wrote
        # down. Here the ledger records no launch at all, yet the restart is still visible.
        restarted_ledger = EventLedger(self.work_root / "events-restart.jsonl")
        restarted_commander = FakeDockerCommander(exit_code=0, restart_count=1)
        restarted_sandbox = CommandSandbox(
            cli=DockerCli(restarted_commander),
            work_root=self.work_root,
            ledger=restarted_ledger,
            host_facts=HostFacts(system="linux", machine="x86_64"),
            admitted_images=[self.image],
        )
        restarted_sandbox.create(self.prepare())
        observed = restarted_sandbox.audit("action-001", 1)
        self.assertEqual(restarted_ledger.counters("action-001", 1).launches, 0)
        self.assertEqual(observed["docker_restart_count"], 1)
        self.assertTrue(observed["duplicate_execution"])

    # -- single create slot (TASK022) --------------------------------------------------------

    def test_a_second_create_for_the_same_action_and_epoch_is_refused(self) -> None:
        commander, sandbox = self.build()
        prepared = self.prepare()
        sandbox.create(prepared)
        self.assertEqual(commander.docker_created_containers, 1)
        with self.assertRaises(ExecutionError) as caught:
            sandbox.create(prepared)
        self.assertIn("second container create", str(caught.exception))
        self.assertEqual(commander.docker_created_containers, 1)
        self.assertEqual(commander.verbs().count("create"), 1)
        events = [event["event"] for event in self.ledger.read()]
        self.assertEqual(events.count("container_create_reserved"), 1)

    def test_a_second_create_after_an_unknown_outcome_is_refused(self) -> None:
        commander, sandbox = self.build(exit_code=0)
        prepared = self.prepare()
        record = sandbox.create(prepared)
        sandbox.start_once(record)
        sandbox.wait_for_exit(prepared, record, deadline_monotonic=sandbox.clock() + prepared.spec.limits.wall_seconds)
        # The daemon no longer reports the object; that is unknown, not "did not run".
        commander.absent = (prepared.container_name,)
        outcome = sandbox.recover("action-001", 1)
        self.assertEqual(outcome["outcome"], "unknown")
        self.assertEqual(outcome["decision"], "reconcile")
        with self.assertRaises(ExecutionError):
            sandbox.create(prepared)
        self.assertEqual(commander.docker_created_containers, 1)
        self.assertEqual(commander.verbs().count("create"), 1)

    def test_two_callers_with_separate_ledgers_create_only_once(self) -> None:
        commander = FakeDockerCommander()
        cli = DockerCli(commander)
        prepared = self.prepare()
        barrier = threading.Barrier(2)
        failures: list[BaseException] = []

        def attempt() -> None:
            sandbox = CommandSandbox(
                cli=cli,
                work_root=self.work_root,
                ledger=EventLedger(self.work_root / "events.jsonl"),
                host_facts=HostFacts(system="linux", machine="x86_64"),
                admitted_images=[self.image],
            )
            barrier.wait()
            try:
                sandbox.create(prepared)
            except ExecutionError:
                pass  # the losing caller is refused before any Docker call
            except BaseException as error:  # pragma: no cover - surfaces an unexpected failure
                failures.append(error)

        threads = [threading.Thread(target=attempt) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(failures, [])
        self.assertEqual(commander.docker_created_containers, 1)
        self.assertEqual(commander.verbs().count("create"), 1)
        events = EventLedger(self.work_root / "events.jsonl").read()
        self.assertEqual([event["event"] for event in events].count("container_create_reserved"), 1)

    def test_a_restart_after_reservation_does_not_create_again(self) -> None:
        # A crash after the reservation but before any Docker response leaves this record.
        self.ledger.append(
            action_id="action-001", action_epoch=1, event="container_create_reserved",
            detail={"container_name": f"{CONTAINER_NAME_PREFIX}action-001-1",
                    "intent_digest": self.prepare().intent_digest},
        )
        commander = FakeDockerCommander()
        restarted = CommandSandbox(
            cli=DockerCli(commander),
            work_root=self.work_root,
            ledger=EventLedger(self.work_root / "events.jsonl"),
            host_facts=HostFacts(system="linux", machine="x86_64"),
            admitted_images=[self.image],
        )
        with self.assertRaises(ExecutionError):
            restarted.create(self.prepare())
        # The restarted process issued no Docker command at all.
        self.assertEqual(commander.trace, [])
        self.assertEqual(commander.docker_created_containers, 0)

    def test_recovery_of_a_reservation_without_a_container_record_stays_unknown(self) -> None:
        commander, sandbox = self.build()
        self.ledger.append(
            action_id="action-001", action_epoch=1, event="container_create_reserved",
            detail={"container_name": f"{CONTAINER_NAME_PREFIX}action-001-1",
                    "intent_digest": self.prepare().intent_digest},
        )
        outcome = sandbox.recover("action-001", 1)
        self.assertEqual(outcome["outcome"], "unknown")
        self.assertEqual(outcome["decision"], "reconcile")
        self.assertEqual(commander.trace, [])

    # -- single start slot (TASK027) ---------------------------------------------------------

    def test_a_valid_start_is_issued_once_for_the_created_association(self) -> None:
        commander, sandbox = self.build(exit_code=0)
        record = sandbox.create(self.prepare())
        sandbox.start_once(record)
        events = [event["event"] for event in self.ledger.read()]
        self.assertEqual(events.count("start_attempt"), 1)
        self.assertEqual(events.count("start_succeeded"), 1)
        self.assertEqual(commander.verbs().count("start"), 1)
        self.assertEqual(commander.docker_started_containers, 1)

    def test_two_concurrent_starters_with_separate_ledgers_start_only_once(self) -> None:
        """Two sandbox/ledger instances on two threads cannot both issue ``docker start``.

        The ledger reads the start counter and then waits at a barrier, which forces the exact
        interleaving the defect permitted: both callers observe an empty start slot before either
        appends an attempt. The guarded reservation makes the check-and-append atomic, so exactly
        one caller starts and the other is refused before any Docker verb.
        """
        commander, sandbox = self.build(exit_code=0)
        prepared = self.prepare()
        record = sandbox.create(prepared)
        ledger_path = self.work_root / "events.jsonl"
        barrier = threading.Barrier(2)
        outcomes: list[str] = []
        failures: list[BaseException] = []

        class RacingLedger(EventLedger):
            def counters(self, action_id, action_epoch=None):
                observed = super().counters(action_id, action_epoch)
                if observed.start_attempts == 0:
                    try:
                        # Only one caller can hold the start guard; the wait times out when the
                        # competing caller is blocked on the lock, which is the fixed behavior.
                        barrier.wait(timeout=0.5)
                    except threading.BrokenBarrierError:
                        pass
                return observed

        def attempt() -> None:
            box = CommandSandbox(
                cli=DockerCli(commander),
                work_root=self.work_root,
                ledger=RacingLedger(ledger_path),
                host_facts=HostFacts(system="linux", machine="x86_64"),
                admitted_images=[self.image],
            )
            try:
                box.start_once(record)
                outcomes.append("started")
            except AlreadyStarted:
                outcomes.append("already_started")
            except BaseException as error:  # pragma: no cover - surfaces an unexpected failure
                failures.append(error)

        threads = [threading.Thread(target=attempt) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(failures, [])
        self.assertEqual(sorted(outcomes), ["already_started", "started"])
        self.assertEqual(commander.verbs().count("start"), 1)
        self.assertEqual(commander.docker_started_containers, 1)
        self.assertEqual(EventLedger(ledger_path).counters("action-001", 1).start_attempts, 1)

    def test_a_separate_process_cannot_reserve_the_same_start_slot(self) -> None:
        """``flock`` serializes the reservation across processes, not only threads."""
        commander, sandbox = self.build()
        record = sandbox.create(self.prepare())
        ledger_path = self.work_root / "events.jsonl"
        program = (
            "import sys\n"
            "from pathlib import Path\n"
            "from sandbox import AlreadyStarted, EventLedger\n"
            "ledger = EventLedger(Path(sys.argv[1]))\n"
            "try:\n"
            "    ledger.reserve_start(action_id=sys.argv[2], action_epoch=int(sys.argv[3]),\n"
            "                         container_id=sys.argv[4], container_name=sys.argv[5],\n"
            "                         intent_digest=sys.argv[6])\n"
            "except AlreadyStarted:\n"
            "    print('refused')\n"
            "else:\n"
            "    print('reserved')\n"
        )
        environment = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
        arguments = [str(ledger_path), record["action_id"], str(record["action_epoch"]),
                     record["container_id"], record["container_name"], record["intent_digest"]]
        working_directory = str(Path(__file__).resolve().parent)
        processes = [
            subprocess.Popen(
                [sys.executable, "-c", program, *arguments],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                cwd=working_directory, env=environment,
            )
            for _ in range(2)
        ]
        outputs = [process.communicate(timeout=30) for process in processes]
        for process, (stdout, stderr) in zip(processes, outputs):
            self.assertEqual(process.returncode, 0, stderr)
        self.assertEqual(sorted(stdout.strip() for stdout, _ in outputs),
                         ["refused", "reserved"])
        self.assertEqual(EventLedger(ledger_path).counters(
            record["action_id"], record["action_epoch"]).start_attempts, 1)
        self.assertNotIn("start", commander.verbs())

    def test_a_start_without_a_durable_created_record_is_refused(self) -> None:
        """A valid 64-hex ID with no durable ``container_created`` record is not ownership."""
        commander, sandbox = self.build()
        foreign_id = fake_container_id("forged-foreign-object")
        foreign_name = f"{CONTAINER_NAME_PREFIX}forged-1"
        commander.add_container(foreign_name, owner=EXPERIMENT_OWNER, container_id=foreign_id)
        forged = {
            "action_id": "forged-action",
            "action_epoch": 1,
            "container_name": foreign_name,
            "container_id": foreign_id,
            "intent_digest": "sha256:" + "0" * 64,
        }
        with self.assertRaises(OwnershipRefused) as caught:
            sandbox.start_once(forged)
        self.assertIn("container_created", str(caught.exception))
        self.assertNotIn("start", commander.verbs())
        self.assertNotIn("start_attempt", [event["event"] for event in self.ledger.read()])
        self.assertIn(foreign_name, commander.containers)

    def test_a_start_with_a_changed_intent_digest_is_refused(self) -> None:
        """The durable association must carry the same immutable intent as the start record."""
        commander, sandbox = self.build()
        record = sandbox.create(self.prepare())
        changed = {**record, "intent_digest": "sha256:" + "0" * 64}
        with self.assertRaises(OwnershipRefused) as caught:
            sandbox.start_once(changed)
        self.assertIn("intent", str(caught.exception))
        self.assertNotIn("start", commander.verbs())
        self.assertNotIn("start_attempt", [event["event"] for event in self.ledger.read()])

    def test_a_start_with_a_mismatched_identity_is_refused(self) -> None:
        """A changed container ID or name is not the created association and cannot start."""
        commander, sandbox = self.build()
        record = sandbox.create(self.prepare())
        other_id = fake_container_id("other-object")
        changed_records = (
            ("container_id", {**record, "container_id": other_id}),
            ("container_name", {**record, "container_name": record["container_name"] + "-other"}),
        )
        for label, changed in changed_records:
            with self.subTest(label):
                with self.assertRaises(OwnershipRefused):
                    sandbox.start_once(changed)
                self.assertNotIn("start_attempt",
                                 [event["event"] for event in self.ledger.read()])
        self.assertNotIn("start", commander.verbs())

    def test_a_lost_start_response_is_never_retried(self) -> None:
        """A crash after the fsynced reservation leaves an attempt that refuses every retry."""
        def lose_the_response(_commander, argv):
            if argv[0] == "start":
                raise RuntimeError("simulated process loss after the start was issued")

        commander, sandbox = self.build(on_command=lose_the_response)
        prepared = self.prepare()
        record = sandbox.create(prepared)
        with self.assertRaises(RuntimeError):
            sandbox.start_once(record)
        events = [event["event"] for event in self.ledger.read()]
        self.assertIn("start_attempt", events)
        self.assertNotIn("start_failed", events, "the lost response never reached the ledger")

        restarted = CommandSandbox(
            cli=DockerCli(commander),
            work_root=self.work_root,
            ledger=EventLedger(self.work_root / "events.jsonl"),
            host_facts=HostFacts(system="linux", machine="x86_64"),
            admitted_images=[self.image],
        )
        with self.assertRaises(AlreadyStarted):
            restarted.start_once(record)
        self.assertEqual(commander.verbs().count("start"), 1)
        self.assertEqual(commander.docker_started_containers, 0)

    def test_a_recorded_start_attempt_without_a_result_is_never_retried(self) -> None:
        """An attempt on disk from a crashed process is durable: a restart never starts again."""
        commander, sandbox = self.build()
        prepared = self.prepare()
        record = sandbox.create(prepared)
        # Model a crash after ``reserve_start`` wrote the attempt but before Docker answered.
        self.ledger.reserve_start(
            action_id=record["action_id"],
            action_epoch=record["action_epoch"],
            container_id=record["container_id"],
            container_name=record["container_name"],
            intent_digest=record["intent_digest"],
        )
        restarted = CommandSandbox(
            cli=DockerCli(commander),
            work_root=self.work_root,
            ledger=EventLedger(self.work_root / "events.jsonl"),
            host_facts=HostFacts(system="linux", machine="x86_64"),
            admitted_images=[self.image],
        )
        with self.assertRaises(AlreadyStarted):
            restarted.start_once(record)
        self.assertNotIn("start", commander.verbs())
        self.assertEqual(EventLedger(self.work_root / "events.jsonl").counters(
            record["action_id"], record["action_epoch"]).start_attempts, 1)

    # -- cleanup ---------------------------------------------------------------------------

    def test_cleanup_attempts_every_owned_resource_after_an_individual_failure(self) -> None:
        commander, sandbox = self.build()
        first = self.prepare(action_id="action-001")
        second = self.prepare(action_id="action-002")
        records = [sandbox.create(first), sandbox.create(second)]
        commander.rm_failures = (records[0]["container_name"],)
        report = sandbox.cleanup(records)
        self.assertEqual(report["failed"], [{"container_name": records[0]["container_name"],
                                             "status": 1,
                                             "stderr": f"Error: cannot remove "
                                                       f"{records[0]['container_name']}"}])
        self.assertEqual(report["removed"], [records[1]["container_name"]])
        self.assertEqual(commander.verbs().count("rm"), 2)
        self.assertNotIn(records[1]["container_name"], commander.containers)
        self.assertIn(records[0]["container_name"], commander.containers)
        events = [event["event"] for event in self.ledger.read()]
        self.assertIn("cleanup_failed", events)
        self.assertIn("cleanup_removed", events)

    def test_cleanup_refuses_objects_this_experiment_does_not_own(self) -> None:
        commander, sandbox = self.build()
        foreign_label = f"{CONTAINER_NAME_PREFIX}someone-else-1"
        foreign_name = "openbot-work-journey-runner"
        commander.add_container(foreign_label, owner=None)
        commander.add_container(foreign_name, owner=None)
        records = [
            {"action_id": "action-001", "action_epoch": 1, "container_name": foreign_label},
            {"action_id": "action-002", "action_epoch": 1, "container_name": foreign_name},
        ]
        report = sandbox.cleanup(records)
        self.assertEqual(report["removed"], [])
        self.assertEqual(len(report["refused"]), 2)
        self.assertNotIn("rm", commander.verbs())
        self.assertIn(foreign_label, commander.containers)
        self.assertIn(foreign_name, commander.containers)

    def test_cleanup_reports_an_already_absent_object_without_failing(self) -> None:
        commander, sandbox = self.build()
        report = sandbox.cleanup([{"action_id": "action-001", "action_epoch": 1,
                                   "container_name": f"{CONTAINER_NAME_PREFIX}gone-1"}])
        self.assertEqual(report["removed"], [])
        self.assertEqual(len(report["refused"]), 1)
        self.assertEqual(report["failed"], [])

    def test_a_complete_run_cleans_up_its_own_container(self) -> None:
        commander, sandbox = self.build(exit_code=0)
        prepared = self.prepare(limits=Limits(wall_seconds=5))
        result = run_action(sandbox, prepared)
        self.assertEqual(result["record"]["cleanup"]["removed"], [prepared.container_name])
        self.assertNotIn(prepared.container_name, commander.containers)
        audit = result["audit"]
        self.assertEqual(audit["launches"], 1)
        self.assertFalse(audit["duplicate_execution"])

    # -- cleanup ownership and per-object isolation (TASK024) ------------------------------

    def test_cleanup_refuses_a_name_match_when_the_record_has_no_immutable_id(self) -> None:
        """Finding 4: a shared owner label and name prefix are not ownership proof.

        The record has no immutable ID (as after a failed create), while another work root's
        same-name object carries the shared owner label. Cleanup must refuse instead of removing
        that object by its mutable name, and it must not even inspect it.
        """
        commander, sandbox = self.build()
        prepared = self.prepare()
        foreign_id = fake_container_id("other-work-root-container")
        commander.add_container(prepared.container_name, owner=EXPERIMENT_OWNER,
                                container_id=foreign_id)
        record = {"action_id": prepared.spec.action_id,
                  "action_epoch": prepared.spec.action_epoch,
                  "container_name": prepared.container_name}
        report = sandbox.cleanup([record])
        self.assertEqual(report["removed"], [])
        self.assertEqual(report["failed"], [])
        self.assertEqual(len(report["refused"]), 1)
        self.assertIn("immutable container ID", report["refused"][0]["reason"])
        self.assertNotIn("inspect", commander.verbs())
        self.assertNotIn("rm", commander.verbs())
        self.assertEqual(commander.containers[prepared.container_name]["Id"], foreign_id)

    def test_a_create_conflict_never_removes_the_original_same_name_container(self) -> None:
        """Finding 4: a same-name create conflict must not let ``finally`` cleanup remove it."""
        commander, sandbox = self.build(create_status=125,
                                        create_stderr="name is already in use")
        prepared = self.prepare()
        original_id = fake_container_id("original-running-container")
        commander.add_container(prepared.container_name, owner=EXPERIMENT_OWNER,
                                container_id=original_id)
        commander.containers[prepared.container_name]["State"].update(
            {"Status": "running", "Running": True})
        with self.assertRaises(ExecutionError) as caught:
            run_action(sandbox, prepared)
        self.assertIn("docker create failed", str(caught.exception))
        self.assertNotIn("inspect", commander.verbs())
        self.assertNotIn("rm", commander.verbs())
        self.assertIn(prepared.container_name, commander.containers)
        self.assertEqual(commander.containers[prepared.container_name]["Id"], original_id)
        self.assertEqual(commander.docker_started_containers, 0)
        events = [event["event"] for event in self.ledger.read()]
        self.assertIn("container_create_failed", events)
        self.assertIn("cleanup_refused", events)
        refused = [event for event in self.ledger.read() if event["event"] == "cleanup_refused"]
        self.assertIn("immutable container ID", refused[-1]["detail"]["reason"])

    def test_cleanup_refuses_a_malformed_recorded_id_without_name_fallback(self) -> None:
        """A malformed ID is no more usable than a missing one: refuse, never fall back to name."""
        commander, sandbox = self.build()
        prepared = self.prepare()
        commander.add_container(prepared.container_name, owner=EXPERIMENT_OWNER)
        malformed = {
            "image_digest_shape": fake_digest("image-shape"),
            "uppercase_hex": "AB" * 32,
            "too_short": "ab" * 31,
            "too_long": "ab" * 33,
        }
        for label, bad_id in malformed.items():
            with self.subTest(label):
                record = {"action_id": prepared.spec.action_id,
                          "action_epoch": prepared.spec.action_epoch,
                          "container_name": prepared.container_name,
                          "container_id": bad_id}
                report = sandbox.cleanup([record])
                self.assertEqual(report["removed"], [])
                self.assertEqual(report["failed"], [])
                self.assertEqual(len(report["refused"]), 1)
                self.assertIn("immutable container ID", report["refused"][0]["reason"])
                self.assertNotIn("inspect", commander.verbs())
                self.assertNotIn("rm", commander.verbs())
        self.assertIn(prepared.container_name, commander.containers)

    def test_cleanup_uses_exact_ids_and_never_the_mutable_name(self) -> None:
        commander, sandbox = self.build()
        record = sandbox.create(self.prepare())
        before = len(commander.trace)
        report = sandbox.cleanup([record])
        self.assertEqual(report["removed"], [record["container_name"]])
        self.assertEqual(report["failed"], [])
        self.assertEqual(report["refused"], [])
        # Actual fake command traces: inspect and rm receive the immutable ID, never the name.
        self.assertEqual(commander.trace[before:], [
            ("inspect", record["container_id"], "--format", "{{json .}}"),
            ("rm", "--force", record["container_id"]),
        ])
        self.assertNotEqual(record["container_id"], record["container_name"])

    def test_cleanup_continues_after_the_first_inspect_fails(self) -> None:
        """Finding 5: one inspect/OS failure must not prevent the next owned removal."""
        commander, sandbox = self.build()
        first = sandbox.create(self.prepare(action_id="action-001"))
        second = sandbox.create(self.prepare(action_id="action-002"))
        first_id = first["container_id"]

        def fail_first_inspect(_commander, argv):
            if argv[0] == "inspect" and argv[1] == first_id:
                raise OSError("simulated transient OS failure reading object 1")

        commander.on_command = fail_first_inspect
        before = len(commander.trace)
        report = sandbox.cleanup([first, second])
        self.assertEqual(report["removed"], [second["container_name"]])
        self.assertEqual(len(report["failed"]), 1)
        self.assertEqual(report["failed"][0]["container_name"], first["container_name"])
        self.assertEqual(report["failed"][0]["container_id"], first_id)
        self.assertIn("OSError", report["failed"][0]["error"])
        self.assertEqual(report["refused"], [])
        self.assertEqual(report["ledger_errors"], [])
        issued = [argv for argv in commander.trace[before:] if argv[0] in {"inspect", "rm"}]
        self.assertEqual(issued, [
            ("inspect", first_id, "--format", "{{json .}}"),
            ("inspect", second["container_id"], "--format", "{{json .}}"),
            ("rm", "--force", second["container_id"]),
        ])
        self.assertIn(first["container_name"], commander.containers)
        self.assertNotIn(second["container_name"], commander.containers)

    def test_cleanup_continues_after_the_first_remove_fails(self) -> None:
        """Finding 5: a remove/OS failure on one record must not stop the next attempt."""
        commander, sandbox = self.build()
        first = sandbox.create(self.prepare(action_id="action-001"))
        second = sandbox.create(self.prepare(action_id="action-002"))
        first_id = first["container_id"]

        def fail_first_remove(_commander, argv):
            if argv[0] == "rm" and argv[-1] == first_id:
                raise OSError("simulated OS failure removing object 1")

        commander.on_command = fail_first_remove
        report = sandbox.cleanup([first, second])
        self.assertEqual(report["removed"], [second["container_name"]])
        self.assertEqual(len(report["failed"]), 1)
        self.assertEqual(report["failed"][0]["container_id"], first_id)
        self.assertIn("OSError", report["failed"][0]["error"])
        self.assertEqual(commander.verbs().count("rm"), 2)
        self.assertNotIn(second["container_name"], commander.containers)
        self.assertIn(first["container_name"], commander.containers)

    def test_cleanup_reports_every_failure_in_the_aggregate(self) -> None:
        """Finding 5: failures from separate records are all reported, not just the first."""
        commander, sandbox = self.build()
        first = sandbox.create(self.prepare(action_id="action-001"))
        second = sandbox.create(self.prepare(action_id="action-002"))
        first_id = first["container_id"]
        commander.rm_failures = (second["container_name"],)

        def fail_first_inspect(_commander, argv):
            if argv[0] == "inspect" and argv[1] == first_id:
                raise OSError("inspect failed")

        commander.on_command = fail_first_inspect
        report = sandbox.cleanup([first, second])
        self.assertEqual(report["removed"], [])
        self.assertEqual(len(report["failed"]), 2)
        self.assertEqual({entry["container_name"] for entry in report["failed"]},
                         {first["container_name"], second["container_name"]})
        self.assertTrue(any("OSError" in entry.get("error", "") for entry in report["failed"]))
        self.assertTrue(any(entry.get("status") == 1 for entry in report["failed"]))
        self.assertEqual(report["refused"], [])
        self.assertEqual(commander.verbs().count("rm"), 1)

    # -- durable ledger ownership proof (TASK024 correction) -------------------------------

    def test_cleanup_refuses_a_forged_exact_id_without_a_durable_created_record(self) -> None:
        """A bare 64-hex ID is not ownership proof: the ledger must record this exact object.

        The failed first-submission counterexample: a foreign fake object is inserted under a
        valid bare 64-hex ID and cleanup is handed that exact ID for an Action/epoch with no
        ``container_created`` record in this ledger. Cleanup must refuse before any daemon call
        and leave the foreign object in place.
        """
        commander, sandbox = self.build()
        prepared = self.prepare()
        foreign_id = fake_container_id("foreign-forged-id")
        commander.add_container(prepared.container_name, owner=EXPERIMENT_OWNER,
                                container_id=foreign_id)
        record = {"action_id": "foreign", "action_epoch": 1,
                  "container_name": prepared.container_name, "container_id": foreign_id}
        report = sandbox.cleanup([record])
        self.assertEqual(report["removed"], [])
        self.assertEqual(report["failed"], [])
        self.assertEqual(len(report["refused"]), 1)
        self.assertIn("container_created", report["refused"][0]["reason"])
        self.assertNotIn("inspect", commander.verbs())
        self.assertNotIn("rm", commander.verbs())
        self.assertIn(prepared.container_name, commander.containers)
        self.assertEqual(commander.containers[prepared.container_name]["Id"], foreign_id)
        self.assertNotIn("cleanup_removed",
                         [event["event"] for event in self.ledger.read()])

    def test_cleanup_refuses_an_exact_id_recorded_under_a_different_action_or_epoch(self) -> None:
        """A valid ID recorded for another Action or epoch does not prove ownership here."""
        commander, sandbox = self.build()
        owned = sandbox.create(self.prepare(action_id="action-001"))
        before = len(commander.trace)

        wrong_action = {**owned, "action_id": "action-002"}
        report = sandbox.cleanup([wrong_action])
        self.assertEqual(report["removed"], [])
        self.assertEqual(report["failed"], [])
        self.assertEqual(len(report["refused"]), 1)
        self.assertIn("container_created", report["refused"][0]["reason"])
        self.assertEqual([argv[0] for argv in commander.trace[before:]], [])

        wrong_epoch = {**owned, "action_epoch": 2}
        report = sandbox.cleanup([wrong_epoch])
        self.assertEqual(report["removed"], [])
        self.assertEqual(report["failed"], [])
        self.assertEqual(len(report["refused"]), 1)
        self.assertEqual([argv[0] for argv in commander.trace[before:]], [])
        self.assertIn(owned["container_name"], commander.containers)

        # The genuinely recorded association still cleans safely: old exact-owned cleanup works.
        report = sandbox.cleanup([owned])
        self.assertEqual(report["removed"], [owned["container_name"]])
        self.assertEqual(report["refused"], [])
        self.assertNotIn(owned["container_name"], commander.containers)

    def test_cleanup_refuses_a_valid_id_with_a_malformed_epoch(self) -> None:
        """A valid ID with a missing or non-integer epoch cannot prove this invocation's record."""
        commander, sandbox = self.build()
        owned = sandbox.create(self.prepare())
        before = len(commander.trace)
        for bad_epoch in (None, "1", 1.5, True):
            with self.subTest(epoch=bad_epoch):
                record = {**owned, "action_epoch": bad_epoch}
                report = sandbox.cleanup([record])
                self.assertEqual(report["removed"], [])
                self.assertEqual(report["failed"], [])
                self.assertEqual(len(report["refused"]), 1)
                self.assertIn("epoch", report["refused"][0]["reason"])
        self.assertEqual([argv[0] for argv in commander.trace[before:]], [])
        self.assertIn(owned["container_name"], commander.containers)

    def test_cleanup_refuses_a_name_that_does_not_match_the_created_record(self) -> None:
        """The exact association includes the name: a swapped name is not ownership proof."""
        commander, sandbox = self.build()
        owned = sandbox.create(self.prepare())
        before = len(commander.trace)
        impostor_name = f"{CONTAINER_NAME_PREFIX}impostor-1"
        commander.add_container(impostor_name, owner=EXPERIMENT_OWNER,
                                container_id=owned["container_id"])
        report = sandbox.cleanup([{**owned, "container_name": impostor_name}])
        self.assertEqual(report["removed"], [])
        self.assertEqual(report["failed"], [])
        self.assertEqual(len(report["refused"]), 1)
        self.assertIn("association", report["refused"][0]["reason"])
        self.assertEqual([argv[0] for argv in commander.trace[before:]], [])
        self.assertIn(impostor_name, commander.containers)

    def test_cleanup_refuses_an_ambiguous_created_record(self) -> None:
        """Two durable container_created records for one Action/epoch are ambiguous: refuse."""
        commander, sandbox = self.build()
        owned = sandbox.create(self.prepare())
        before = len(commander.trace)
        self.ledger.append(
            action_id=owned["action_id"], action_epoch=owned["action_epoch"],
            event="container_created", detail={**owned},
        )
        report = sandbox.cleanup([owned])
        self.assertEqual(report["removed"], [])
        self.assertEqual(report["failed"], [])
        self.assertEqual(len(report["refused"]), 1)
        self.assertIn("ambiguous", report["refused"][0]["reason"])
        self.assertEqual([argv[0] for argv in commander.trace[before:]], [])
        self.assertIn(owned["container_name"], commander.containers)

    def test_cleanup_refuses_when_the_ledger_cannot_be_read_and_continues(self) -> None:
        """An unreadable ownership proof must fail closed without touching any object.

        The read failure is per-record and must not stop the bounded attempts for the sibling
        record, and it must never be converted into a removal.
        """
        commander, sandbox = self.build()
        first = sandbox.create(self.prepare(action_id="action-001"))
        second = sandbox.create(self.prepare(action_id="action-002"))
        before = len(commander.trace)
        with mock.patch.object(self.ledger, "read", side_effect=OSError("ledger unreadable")):
            report = sandbox.cleanup([first, second])
        self.assertEqual(report["removed"], [])
        self.assertEqual(report["failed"], [])
        self.assertEqual(len(report["refused"]), 2)
        for entry in report["refused"]:
            self.assertIn("could not be read", entry["reason"])
        self.assertEqual({entry["container_name"] for entry in report["refused"]},
                         {first["container_name"], second["container_name"]})
        self.assertEqual([argv[0] for argv in commander.trace[before:]], [])
        self.assertIn(first["container_name"], commander.containers)
        self.assertIn(second["container_name"], commander.containers)
        self.assertEqual(report["ledger_errors"], [])

    def test_cleanup_still_removes_an_owned_record_after_a_forged_id_is_refused(self) -> None:
        """A forged record must not stop a genuinely owned record from being cleaned."""
        commander, sandbox = self.build()
        owned = sandbox.create(self.prepare(action_id="action-001"))
        foreign_id = fake_container_id("foreign-forged-id-2")
        foreign_name = f"{CONTAINER_NAME_PREFIX}foreign-1"
        commander.add_container(foreign_name, owner=EXPERIMENT_OWNER, container_id=foreign_id)
        forged = {"action_id": "foreign", "action_epoch": 1,
                  "container_name": foreign_name, "container_id": foreign_id}
        report = sandbox.cleanup([forged, owned])
        self.assertEqual(report["removed"], [owned["container_name"]])
        self.assertEqual(report["failed"], [])
        self.assertEqual(len(report["refused"]), 1)
        self.assertEqual(report["refused"][0]["container_id"], foreign_id)
        self.assertIn(foreign_name, commander.containers)
        self.assertNotIn(owned["container_name"], commander.containers)
        rm_targets = [argv[-1] for argv in commander.trace if argv[0] == "rm"]
        self.assertEqual(rm_targets, [owned["container_id"]])

    # -- wall deadline authority (TASK025) -------------------------------------------------

    def test_run_action_applies_the_prepared_digest_bound_wall_deadline(self) -> None:
        commander, box = self.build(exit_code=0)
        prepared = self.prepare(limits=Limits(wall_seconds=7))
        result = run_action(box, prepared)
        self.assertEqual(admitted_wall_seconds(prepared), 7)
        self.assertEqual([timeout for verb, timeout in commander.timeouts if verb == "wait"],
                         [7.0])
        self.assertEqual(result["record"]["wall_seconds"], 7)
        created = [event for event in self.ledger.read() if event["event"] == "container_created"]
        self.assertEqual(created[-1]["detail"]["wall_seconds"], 7)

    def test_a_matching_wall_confirmation_uses_the_prepared_value(self) -> None:
        commander, box = self.build(exit_code=0)
        prepared = self.prepare(limits=Limits(wall_seconds=7))
        result = run_action(box, prepared, wall_seconds=7)
        self.assertEqual([timeout for verb, timeout in commander.timeouts if verb == "wait"],
                         [7.0])
        self.assertEqual(result["record"]["wall_seconds"], 7)

    def test_a_mismatched_wall_confirmation_is_refused_before_any_docker_call(self) -> None:
        commander, box = self.build()
        prepared = self.prepare(limits=Limits(wall_seconds=60))
        with self.assertRaises(InvalidAction) as caught:
            run_action(box, prepared, wall_seconds=1)
        self.assertIn("does not match", str(caught.exception))
        self.assertEqual(commander.trace, [])
        self.assertEqual(commander.docker_created_containers, 0)

    def test_wait_refuses_a_record_without_the_prepared_intent_digest(self) -> None:
        commander, box = self.build()
        prepared = self.prepare(limits=Limits(wall_seconds=7))
        record = box.create(prepared)
        record.pop("intent_digest")
        before = list(commander.trace)
        with self.assertRaises(ExecutionError):
            box.wait_for_exit(prepared, record, deadline_monotonic=box.clock() + prepared.spec.limits.wall_seconds)
        self.assertEqual(commander.trace, before)

    def test_negative_zero_and_excess_wall_confirmations_are_refused_before_docker(self) -> None:
        commander, box = self.build()
        prepared = self.prepare()
        for bad in (-5, 0, 3600, True, 1.5, "5"):
            with self.subTest(wall_seconds=bad):
                with self.assertRaises(InvalidAction):
                    run_action(box, prepared, wall_seconds=bad)
        self.assertEqual(commander.trace, [])
        self.assertNotIn("create", commander.verbs())

    def test_a_hand_built_prepared_action_with_an_invalid_wall_limit_is_refused(self) -> None:
        commander, box = self.build()
        prepared = self.prepare()
        for bad in (-1, 0, 3600, True, 1.5):
            with self.subTest(wall_seconds=bad):
                broken = replace(prepared,
                                 spec=replace(prepared.spec, limits=Limits(wall_seconds=bad)))
                with self.assertRaises(InvalidAction):
                    run_action(box, broken)
                # The first Docker-issuing method validates the deadline before any verb.
                with self.assertRaises(InvalidAction):
                    box.create(broken)
        self.assertEqual(commander.trace, [])

    def test_a_lower_deadline_is_only_available_through_the_prepared_intent(self) -> None:
        commander, box = self.build(exit_code=0)
        short = self.prepare(limits=Limits(wall_seconds=1))
        long = self.prepare(limits=Limits(wall_seconds=60))
        self.assertNotEqual(short.intent_digest, long.intent_digest)
        self.assertEqual(short.spec.limits.wall_seconds, 1)
        self.assertEqual(long.spec.limits.wall_seconds, 60)
        run_action(box, short)
        self.assertEqual([timeout for verb, timeout in commander.timeouts if verb == "wait"][0],
                         1.0)
        # The one-second value cannot be applied to the sixty-second prepared intent.
        with self.assertRaises(InvalidAction):
            run_action(box, long, wall_seconds=1)

    def test_the_wall_deadline_recorded_on_exceeding_equals_the_prepared_limit(self) -> None:
        commander, box = self.build(wait_timeout_attempts=1, exit_code=137)
        prepared = self.prepare(limits=Limits(wall_seconds=3))
        run_action(box, prepared)
        waits = [timeout for verb, timeout in commander.timeouts if verb == "wait"]
        self.assertEqual(waits[0], 3.0)
        exceeded = [event for event in self.ledger.read()
                    if event["event"] == "wall_deadline_exceeded"]
        self.assertEqual(exceeded[-1]["detail"]["wall_seconds"], 3)

    # -- CLI wall deadline (TASK025) -------------------------------------------------------

    def _run_cli(self, arguments, *, workload=None, auto_output: bool = True):
        commander = FakeDockerCommander()
        selected = workload
        if selected is None and auto_output:
            selected = self._workload_writes_result
        if selected is not None:
            commander.on_command = selected
        output = io.StringIO()
        errors = io.StringIO()
        with mock.patch("sandbox.SubprocessCommander", lambda *a, **k: commander), \
             mock.patch("sandbox.HostFacts.detect",
                        return_value=HostFacts(system="linux", machine="x86_64")), \
             redirect_stdout(output), redirect_stderr(errors):
            code = sandbox._main(arguments)
        return commander, code, output.getvalue(), errors.getvalue()

    def _cli_base(self):
        return ["run", "--work-root", str(self.work_root), "--image", self.image,
                "--docker-host", "unix:///test-reviewed-daemon.sock", "--daemon-id", "test-reviewed-daemon",
                "--daemon-root", "/test-reviewed-daemon",
                "--admitted-image", self.image]

    # -- TASK026 workload simulation -------------------------------------------------------

    def _workload_writes_result(self, commander, argv) -> None:
        """Model the probe writing its one small result file when the command is waited on."""
        if argv[0] != "wait":
            return
        source = _mount_source(commander, OUTPUT_DESTINATION)
        if source is None:
            return
        (source / SYNTHETIC_OUTPUT_NAME).write_bytes(SYNTHETIC_OUTPUT_BYTES)

    def _workload_writes_bytes(self, payload: bytes):
        def writer(commander, argv) -> None:
            if argv[0] != "wait":
                return
            source = _mount_source(commander, OUTPUT_DESTINATION)
            if source is None:
                return
            (source / SYNTHETIC_OUTPUT_NAME).write_bytes(payload)
        return writer

    def _workload_writes_symlink(self, target: Path):
        def writer(commander, argv) -> None:
            if argv[0] != "wait":
                return
            source = _mount_source(commander, OUTPUT_DESTINATION)
            if source is None:
                return
            os.symlink(target, source / SYNTHETIC_OUTPUT_NAME)
        return writer

    def _workload_writes_oversized_tree(self, extra_bytes: int):
        def writer(commander, argv) -> None:
            if argv[0] != "wait":
                return
            source = _mount_source(commander, OUTPUT_DESTINATION)
            if source is None:
                return
            (source / SYNTHETIC_OUTPUT_NAME).write_bytes(SYNTHETIC_OUTPUT_BYTES)
            with open(source / "big.bin", "wb") as handle:
                handle.truncate(extra_bytes)
        return writer

    def _workload_swaps_output_directory(self):
        """Model a host writer replacing the output directory at the same path mid-run.

        The replacement receives the exact expected bytes, so only the directory identity can
        distinguish it from the directory ``prepare_action`` confined.
        """
        def writer(commander, argv) -> None:
            if argv[0] != "wait":
                return
            source = _mount_source(commander, OUTPUT_DESTINATION)
            if source is None:
                return
            relocated = source.with_name(source.name + "-original")
            source.rename(relocated)
            source.mkdir()
            (source / SYNTHETIC_OUTPUT_NAME).write_bytes(SYNTHETIC_OUTPUT_BYTES)
        return writer

    def test_the_cli_synthetic_default_uses_its_own_prepared_deadline(self) -> None:
        commander, code, output, errors = self._run_cli(self._cli_base())
        self.assertEqual(code, 0, errors)
        waits = [timeout for verb, timeout in commander.timeouts if verb == "wait"]
        self.assertEqual(len(waits), 1)
        self.assertGreater(waits[0], 0)
        self.assertLessEqual(waits[0], Limits().wall_seconds)
        config = json.loads(output)["config"]
        self.assertEqual(config["limits"]["wall_seconds"], Limits().wall_seconds)

    def test_the_cli_wall_seconds_is_folded_into_the_prepared_intent(self) -> None:
        commander, code, output, errors = self._run_cli(
            self._cli_base() + ["--wall-seconds", "5"])
        self.assertEqual(code, 0, errors)
        waits = [timeout for verb, timeout in commander.timeouts if verb == "wait"]
        self.assertEqual(len(waits), 1)
        self.assertGreater(waits[0], 0)
        self.assertLessEqual(waits[0], 5.0)
        config = json.loads(output)["config"]
        self.assertEqual(config["limits"]["wall_seconds"], 5)
        self.assertNotEqual(config["limits"]["wall_seconds"], Limits().wall_seconds)

    def test_the_cli_refuses_an_invalid_wall_seconds_before_any_docker_call(self) -> None:
        for bad in ("-5", "0", "3600"):
            with self.subTest(wall_seconds=bad):
                commander, code, output, errors = self._run_cli(
                    self._cli_base() + ["--wall-seconds", bad])
                self.assertEqual(code, 2)
                self.assertEqual(commander.trace, [])
                self.assertIn("refused", errors.lower())

    def test_the_cli_refuses_an_unsupported_host_before_creating_local_state(self) -> None:
        untouched_root = self.work_root / "unsupported-host"
        commander = FakeDockerCommander()
        errors = io.StringIO()
        arguments = ["run", "--work-root", str(untouched_root), "--image", self.image,
                     "--docker-host", "unix:///test-reviewed-daemon.sock", "--daemon-id", "test-reviewed-daemon",
                     "--daemon-root", "/test-reviewed-daemon",
                     "--admitted-image", self.image]
        with mock.patch("sandbox.SubprocessCommander", lambda *a, **k: commander), \
             mock.patch("sandbox.HostFacts.detect",
                        return_value=HostFacts(system="darwin", machine="arm64")), \
             redirect_stderr(errors):
            code = sandbox._main(arguments)
        self.assertEqual(code, 2)
        self.assertIn("not Linux isolation evidence", errors.getvalue())
        self.assertFalse(untouched_root.exists())
        self.assertEqual(commander.trace, [])

    # -- TASK026: output proof at the CLI entry --------------------------------------------

    def test_the_cli_refuses_a_missing_result_file(self) -> None:
        commander, code, output, errors = self._run_cli(self._cli_base(), auto_output=False)
        self.assertNotEqual(code, 0)
        self.assertNotIn("precursor passed", (output + errors).lower())
        self.assertEqual(commander.verbs().count("start"), 1)

    def test_the_cli_refuses_a_prior_actions_stale_output(self) -> None:
        first, first_code, _, first_errors = self._run_cli(self._cli_base())
        self.assertEqual(first_code, 0, first_errors)
        # The second Action produces nothing; the first Action's bytes are still on disk.
        second, second_code, output, errors = self._run_cli(
            self._cli_base() + ["--action-id", "another-action"], auto_output=False)
        self.assertNotEqual(second_code, 0)
        self.assertNotIn("precursor passed", (output + errors).lower())

    def test_the_cli_refuses_wrong_result_bytes(self) -> None:
        commander, code, output, errors = self._run_cli(
            self._cli_base(), workload=self._workload_writes_bytes(b"row,value\n7,WRONG\n"))
        self.assertNotEqual(code, 0)
        self.assertIn("expected bytes", errors)

    def test_the_cli_refuses_a_symlinked_result_file(self) -> None:
        target = self.work_root / "elsewhere.csv"
        target.write_bytes(SYNTHETIC_OUTPUT_BYTES)
        commander, code, output, errors = self._run_cli(
            self._cli_base(), workload=self._workload_writes_symlink(target))
        self.assertNotEqual(code, 0)
        self.assertIn("symlink", errors.lower())
        self.assertNotIn("precursor passed", (output + errors).lower())

    def test_the_cli_refuses_an_oversized_output_tree(self) -> None:
        # The result file is byte-exact, but the command also overflowed the admitted envelope.
        # A success claim must not be published from that tree.
        extra = Limits().output_mib * 1024 * 1024 + 1
        commander, code, output, errors = self._run_cli(
            self._cli_base(), workload=self._workload_writes_oversized_tree(extra))
        self.assertNotEqual(code, 0)
        self.assertIn("output", errors.lower())
        self.assertNotIn("precursor passed", (output + errors).lower())

    def test_the_cli_refuses_output_from_a_replaced_output_directory(self) -> None:
        # ACCEPTANCE_FEEDBACK_01 failure 2: a host actor renames the confined output directory,
        # creates a replacement at the same path and seeds it with the exact expected bytes. A
        # byte match in a directory that is not the prepared inode is not the Action's output.
        commander, code, output, errors = self._run_cli(
            self._cli_base(), workload=self._workload_swaps_output_directory())
        self.assertNotEqual(code, 0)
        self.assertIn("identity changed before collection", errors)
        self.assertNotIn("precursor passed", (output + errors).lower())

    def test_a_replaced_output_directory_is_refused_before_any_proof(self) -> None:
        # The independent counterexample called verify_expected_output directly with zero Docker
        # verbs: rename the prepared output directory, recreate the same path, write the exact
        # expected bytes. The directory identity check must refuse it.
        commander, box = self.build()
        prepared = self.prepare()
        original = prepared.spec.output_dir
        relocated = original.with_name("output-original")
        original.rename(relocated)
        original.mkdir()
        (original / SYNTHETIC_OUTPUT_NAME).write_bytes(SYNTHETIC_OUTPUT_BYTES)

        with self.assertRaises(ExecutionError) as caught:
            box.verify_expected_output(
                prepared,
                expected_name=SYNTHETIC_OUTPUT_NAME,
                expected_bytes=SYNTHETIC_OUTPUT_BYTES,
            )
        self.assertIn("replaced after prepare", str(caught.exception))
        self.assertEqual(commander.trace, [])

    # -- TASK026: data-path separation -----------------------------------------------------

    def test_a_data_directory_equal_to_the_working_root_is_refused(self) -> None:
        commander, _ = self.build()
        for label in ("input_dir", "output_dir"):
            with self.subTest(label):
                with self.assertRaises(InvalidAction):
                    self.prepare(**{label: self.work_root})
        self.assertEqual(commander.trace, [])

    def test_a_non_empty_output_directory_is_never_reused(self) -> None:
        commander, _ = self.build()
        output_dir = self.write_output_dir()
        stale = output_dir / SYNTHETIC_OUTPUT_NAME
        stale.write_bytes(SYNTHETIC_OUTPUT_BYTES)
        with self.assertRaises(InvalidAction) as caught:
            self.prepare(output_dir=output_dir)
        self.assertIn("not empty", str(caught.exception))
        self.assertEqual(commander.trace, [])
        # The stale file is refused, never deleted or overwritten to force a pass.
        self.assertEqual(stale.read_bytes(), SYNTHETIC_OUTPUT_BYTES)

    def test_input_and_output_parent_child_overlap_is_refused(self) -> None:
        commander, _ = self.build()
        input_dir = self.write_input()
        nested_output = input_dir / "nested"
        nested_output.mkdir()
        with self.assertRaises(InvalidAction) as caught:
            self.prepare(input_dir=input_dir, output_dir=nested_output)
        self.assertIn("overlap", str(caught.exception))

        output_dir = self.write_output_dir()
        nested_input = output_dir / "inner"
        nested_input.mkdir()
        (nested_input / "source.csv").write_bytes(SYNTHETIC_INPUT_BYTES)
        with self.assertRaises(InvalidAction):
            self.prepare(input_dir=nested_input, output_dir=output_dir)
        self.assertEqual(commander.trace, [])

    def test_a_data_directory_holding_the_ledger_is_refused_before_create(self) -> None:
        control = self.work_root / "control"
        control.mkdir()
        ledger = EventLedger(control / "events.jsonl")
        commander = FakeDockerCommander()
        box = CommandSandbox(
            cli=DockerCli(commander),
            work_root=self.work_root,
            ledger=ledger,
            host_facts=HostFacts(system="linux", machine="x86_64"),
            admitted_images=[self.image],
        )
        prepared = prepare_action(
            self.spec(input_dir=self.write_input(), output_dir=control),
            work_root=self.work_root,
        )
        with self.assertRaises(ExecutionError):
            box.create(prepared)
        self.assertEqual(commander.trace, [])

    def test_prepare_action_refuses_a_data_directory_over_the_control_paths(self) -> None:
        control = self.work_root / "control"
        control.mkdir()
        ledger = EventLedger(control / "events.jsonl")
        commander, _ = self.build()
        spec = self.spec(input_dir=self.write_input(), output_dir=control)
        with self.assertRaises(InvalidAction):
            prepare_action(
                spec,
                work_root=self.work_root,
                control_paths=[ledger.path,
                               ledger.path.parent / (ledger.path.name + ".lock")],
            )
        self.assertEqual(commander.trace, [])

    def test_the_synthetic_builder_refuses_an_unsafe_action_id(self) -> None:
        with self.assertRaises(InvalidAction):
            build_synthetic_spec(action_id="../escape", action_epoch=1, image=self.image,
                                 work_root=self.work_root, interpreter="python3")
        self.assertFalse((self.root / "escape").exists())

    def test_the_synthetic_builder_never_truncates_an_existing_hard_link(self) -> None:
        outside = self.root / "outside-source.csv"
        outside.write_bytes(b"original outside bytes")
        input_dir = self.work_root / "actions" / "shared-1" / "input"
        input_dir.mkdir(parents=True)
        os.link(outside, input_dir / SYNTHETIC_INPUT_NAME)
        with self.assertRaises(InvalidAction):
            build_synthetic_spec(action_id="shared", action_epoch=1, image=self.image,
                                 work_root=self.work_root)
        self.assertEqual(outside.read_bytes(), b"original outside bytes")

    def test_the_synthetic_builder_reuses_only_identical_private_input(self) -> None:
        spec = build_synthetic_spec(action_id="repeat", action_epoch=1, image=self.image,
                                    work_root=self.work_root)
        second = build_synthetic_spec(action_id="repeat", action_epoch=1, image=self.image,
                                      work_root=self.work_root)
        self.assertEqual(spec.input_dir, second.input_dir)
        self.assertEqual((spec.input_dir / SYNTHETIC_INPUT_NAME).read_bytes(),
                         SYNTHETIC_INPUT_BYTES)
        (spec.input_dir / SYNTHETIC_INPUT_NAME).write_bytes(b"changed")
        with self.assertRaises(InvalidAction):
            build_synthetic_spec(action_id="repeat", action_epoch=1, image=self.image,
                                 work_root=self.work_root)
        self.assertEqual((spec.input_dir / SYNTHETIC_INPUT_NAME).read_bytes(), b"changed")

    def test_the_synthetic_builder_refuses_a_symlinked_actions_directory(self) -> None:
        # ACCEPTANCE_FEEDBACK_01 failure 1: work_root/actions is a symlink to a directory outside
        # the working root. The builder must refuse before it writes source.csv, not create the
        # per-Action tree outside and rely on prepare_action to notice afterwards.
        outside = self.root / "outside-actions"
        outside.mkdir()
        os.symlink(outside, self.work_root / "actions")
        with self.assertRaises(InvalidAction):
            build_synthetic_spec(action_id="escape-attempt", action_epoch=1, image=self.image,
                                 work_root=self.work_root, interpreter="python3")
        self.assertEqual(sorted(p for p in outside.rglob("*") if p.is_file()), [])

    def test_the_cli_refuses_a_symlinked_actions_directory_before_create(self) -> None:
        outside = self.root / "outside-actions"
        outside.mkdir()
        os.symlink(outside, self.work_root / "actions")
        commander, code, output, errors = self._run_cli(self._cli_base())
        self.assertNotEqual(code, 0)
        self.assertNotIn("create", commander.verbs())
        self.assertNotIn("start", commander.verbs())
        self.assertNotIn("precursor passed", (output + errors).lower())
        self.assertEqual(sorted(p for p in outside.rglob("*") if p.is_file()), [])

    def test_synthetic_actions_use_distinct_per_action_data_directories(self) -> None:
        first = build_synthetic_spec(action_id="same-action", action_epoch=1, image=self.image,
                                     work_root=self.work_root, interpreter="python3")
        second = build_synthetic_spec(action_id="same-action", action_epoch=2, image=self.image,
                                      work_root=self.work_root, interpreter="python3")
        self.assertNotEqual(first.input_dir, second.input_dir)
        self.assertNotEqual(first.output_dir, second.output_dir)
        self.assertNotEqual(first.output_dir, self.work_root)

    # -- TASK026: input frozen immediately before create -----------------------------------

    def test_input_bytes_changed_after_prepare_are_refused_before_create(self) -> None:
        commander, box = self.build()
        prepared = self.prepare()
        (prepared.spec.input_dir / "source.csv").write_bytes(SYNTHETIC_INPUT_BYTES + b"tampered\n")
        with self.assertRaises(ExecutionError) as caught:
            box.create(prepared)
        self.assertIn("changed after prepare", str(caught.exception))
        self.assertEqual(commander.trace, [])

    def test_replacing_the_input_directory_after_prepare_is_refused(self) -> None:
        commander, box = self.build()
        prepared = self.prepare()
        original = prepared.spec.input_dir
        relocated = original.with_name("input-original")
        original.rename(relocated)
        replacement = self.work_root / "input-replacement"
        replacement.mkdir()
        (replacement / "source.csv").write_bytes(SYNTHETIC_INPUT_BYTES)
        os.symlink(replacement, original)
        with self.assertRaises(ExecutionError):
            box.create(prepared)
        self.assertEqual(commander.trace, [])

    # -- preflight -------------------------------------------------------------------------

    def test_preflight_refuses_a_non_linux_host_before_any_command(self) -> None:
        commander, sandbox = self.build(host_facts=HostFacts(system="darwin", machine="arm64"))
        with self.assertRaises(PreflightRefused) as caught:
            sandbox.preflight(self.image)
        self.assertIn("not Linux isolation evidence", str(caught.exception))
        self.assertEqual(commander.trace, [])

    def test_preflight_refuses_a_mismatched_engine_version(self) -> None:
        commander, sandbox = self.build(engine="29.5.2")
        with self.assertRaises(PreflightRefused) as caught:
            sandbox.preflight(self.image)
        self.assertIn("no automatic version fallback", str(caught.exception))
        self.assertNotIn("create", commander.verbs())

    def test_preflight_requires_runsc_and_does_not_fall_back_to_runc(self) -> None:
        info = {"OSType": "linux", "Architecture": "x86_64", "CgroupVersion": "2",
                "Runtimes": {"runc": {"path": "runc"}}}
        commander, sandbox = self.build(info=info)
        with self.assertRaises(PreflightRefused) as caught:
            sandbox.preflight(self.image)
        self.assertIn("will not fall back to runc", str(caught.exception))
        self.assertNotIn("create", commander.verbs())

    def test_preflight_requires_cgroup_v2(self) -> None:
        info = {"OSType": "linux", "Architecture": "x86_64", "CgroupVersion": "1",
                "Runtimes": {"runsc": {"path": "/usr/local/bin/runsc"}}}
        commander, sandbox = self.build(info=info)
        with self.assertRaises(PreflightRefused) as caught:
            sandbox.preflight(self.image)
        self.assertIn("cgroup v2", str(caught.exception))

    def test_preflight_requires_the_reviewed_image_digest_to_be_loaded(self) -> None:
        other = "registry.example/openbot-probe@sha256:" + "cd" * 32
        commander, sandbox = self.build(repo_digests=[other])
        with self.assertRaises(PreflightRefused) as caught:
            sandbox.preflight(self.image)
        self.assertIn("not the reviewed ones", str(caught.exception))

        missing, missing_sandbox = self.build(image_present=False)
        with self.assertRaises(PreflightRefused) as caught:
            missing_sandbox.preflight(self.image)
        self.assertIn("never pulls or builds", str(caught.exception))
        self.assertNotIn("create", missing.verbs())

    def test_preflight_refuses_an_image_that_was_not_admitted_by_the_operator(self) -> None:
        commander, sandbox = self.build(admitted=False)
        with self.assertRaises(PreflightRefused) as caught:
            sandbox.preflight(self.image)
        self.assertIn("--admitted-image", str(caught.exception))
        self.assertEqual(commander.trace, [])

    def test_preflight_accepts_the_reviewed_linux_profile(self) -> None:
        commander, sandbox = self.build()
        report = sandbox.preflight(self.image)
        self.assertEqual(report.docker_engine, REVIEWED_DOCKER_ENGINE_VERSION)
        self.assertEqual(report.ostype, "linux")
        self.assertEqual(report.architecture, "x86_64")
        self.assertEqual(report.cgroup_version, "2")
        self.assertEqual(report.runtime, "runsc")
        self.assertIn("runsc", report.runtimes)
        self.assertEqual(report.image_reference, self.image)
        self.assertEqual(report.host_system, "linux")
        self.assertNotIn("create", commander.verbs())

    # -- declared limits -------------------------------------------------------------------

    def test_unverified_output_refuses_create_before_any_docker_or_ledger_write(self) -> None:
        commander, boundary = self.build()
        prepared = self.prepare()
        self.capacity_verifier.side_effect = sandbox.OutputCapacityRefused("ordinary directory")
        with self.assertRaisesRegex(UnsupportedCapability, "ordinary directory"):
            boundary.create(prepared)
        self.assertEqual(commander.trace, [])
        self.assertEqual(self.ledger.read(), [])

    def test_changed_capacity_after_create_refuses_start_and_never_retries(self) -> None:
        commander, boundary = self.build()
        record = boundary.create(self.prepare())
        self.capacity_verifier.side_effect = lambda path, limit: {
            **self.capacity(path, limit), "mount_id": 99,
        }
        with self.assertRaisesRegex(UnsupportedCapability, "changed after create"):
            boundary.start_once(record)
        self.assertNotIn("start", commander.verbs())
        self.assertEqual(self.ledger.counters("action-001", 1).start_attempts, 1)
        self.capacity_verifier.side_effect = self.capacity
        with self.assertRaises(AlreadyStarted):
            boundary.start_once(record)
        self.assertNotIn("start", commander.verbs())

    def test_start_uses_durable_capacity_not_a_callers_forged_copy(self) -> None:
        commander, boundary = self.build()
        prepared = self.prepare()
        record = boundary.create(prepared)
        record["output_capacity"] = {"path": "/untrusted", "limit_bytes": 1024 ** 3}
        self.capacity_verifier.reset_mock()
        boundary.start_once(record)
        self.capacity_verifier.assert_called_once_with(prepared.spec.output_dir, 64 * 1024 * 1024)
        self.assertEqual(commander.verbs().count("start"), 1)

    def test_a_legacy_creation_record_without_capacity_cannot_start(self) -> None:
        commander, boundary = self.build()
        record = boundary.create(self.prepare())
        events = self.ledger.read()
        for event in events:
            if event["event"] == "container_created":
                del event["detail"]["output_capacity"]
        self.ledger.path.write_text("".join(json.dumps(event) + "\n" for event in events))
        with self.assertRaisesRegex(UnsupportedCapability, "no output capacity proof"):
            boundary.start_once(record)
        self.assertNotIn("start", commander.verbs())

    def test_unreadable_capacity_after_create_refuses_start(self) -> None:
        commander, boundary = self.build()
        record = boundary.create(self.prepare())
        self.capacity_verifier.side_effect = sandbox.OutputCapacityRefused("kernel facts missing")
        with self.assertRaisesRegex(UnsupportedCapability, "kernel facts missing"):
            boundary.start_once(record)
        self.assertNotIn("start", commander.verbs())

    def test_the_admitted_output_size_is_reported_as_an_observation(self) -> None:
        commander, sandbox = self.build(exit_code=0)
        prepared = self.prepare(limits=Limits(output_mib=1, memory_mib=512))
        record = sandbox.create(prepared)
        # The workload writes during the run, after create has validated the empty data path.
        (prepared.spec.output_dir / SYNTHETIC_OUTPUT_NAME).write_bytes(b"x" * 32)
        sandbox.start_once(record)
        sandbox.wait_for_exit(prepared, record, deadline_monotonic=sandbox.clock() + prepared.spec.limits.wall_seconds)
        result = sandbox.collect_output(prepared, record)
        self.assertFalse(result["enforced"])
        self.assertEqual(result["enforced"], False)
        self.assertIn("cannot stop the command from filling host storage",
                      result["enforcement_note"])
        self.assertFalse(result["exceeded_admitted_envelope"])
        self.assertEqual(result["bytes"], 32)
        self.assertEqual(result["container_id"], record["container_id"])

    def test_reviewed_daemon_identity_and_root_cannot_drift(self) -> None:
        commander, boundary = self.build()
        boundary.expected_daemon_id = 'another-daemon'
        with self.assertRaisesRegex(PreflightRefused, 'daemon identity'):
            boundary.preflight(self.image)
        boundary.expected_daemon_id = commander.info['ID']
        boundary.expected_daemon_root = '/other-root'
        with self.assertRaisesRegex(PreflightRefused, 'data root'):
            boundary.preflight(self.image)
        self.assertNotIn('create', commander.verbs())

    def test_created_resources_and_user_are_read_back_before_start(self) -> None:
        prepared = self.prepare()
        changes = [('PidsLimit', 0), ('MemorySwap', -1), ('NanoCpus', 0),
                   ('Ulimits', []), ('Tmpfs', {'/tmp': 'rw,size=999m'})]
        for key, value in changes:
            with self.subTest(field=key):
                commander, boundary = self.build()
                stored = commander._container(prepared.container_name)
                # Obtain the exact requested fake shape without consuming any lifecycle slot.
                argv = ('create', *boundary._create_arguments(prepared))
                commander._handle_create(argv, 10)
                stored = commander.containers[prepared.container_name]
                stored['HostConfig'][key] = value
                with self.assertRaises(ExecutionError):
                    boundary._assert_created_shape(prepared, stored)
                self.assertNotIn('start', commander.verbs())
        stored['Config']['User'] = '0:0'
        with self.assertRaisesRegex(ExecutionError, 'non-root'):
            boundary._assert_created_shape(prepared, stored)

    def test_created_mount_source_type_and_propagation_cannot_change(self) -> None:
        prepared = self.prepare()
        for key, value in [('Source', '/etc'), ('Type', 'volume'), ('RW', True),
                           ('Propagation', 'rshared')]:
            with self.subTest(field=key):
                commander, boundary = self.build()
                commander._handle_create(('create', *boundary._create_arguments(prepared)), 10)
                stored = commander.containers[prepared.container_name]
                stored['Mounts'][0][key] = value
                with self.assertRaisesRegex(ExecutionError, 'bind source'):
                    boundary._assert_created_shape(prepared, stored)

    def test_guest_process_limit_is_explicit_unique_integer_and_cannot_widen(self) -> None:
        prepared = self.prepare()
        commander, boundary = self.build()
        arguments = boundary._create_arguments(prepared)
        self.assertIn('nproc=512:512', arguments)
        commander._handle_create(('create', *arguments), 10)
        stored = commander.containers[prepared.container_name]
        original = stored['HostConfig']['Ulimits']
        boundary._assert_created_shape(prepared, stored)
        for changed in (original[:1], original + [original[-1]],
                        [original[0], dict(Name='nproc', Soft=512, Hard=513)],
                        [original[0], dict(Name='nproc', Soft=True, Hard=512)],
                        [original[0], dict(Name='nproc', Soft=512.0, Hard=512)],
                        [original[0], dict(Name='nproc', Soft=-1, Hard=-1)]):
            stored['HostConfig']['Ulimits'] = changed
            with self.assertRaisesRegex(ExecutionError, 'guest process'):
                boundary._assert_created_shape(prepared, stored)

    def test_mount_delimiter_is_refused_before_create_reservation(self) -> None:
        comma = self.work_root / 'input,bind-propagation=shared'
        comma.mkdir(); (comma / 'input').write_bytes(b'synthetic')
        prepared = self.prepare(input_dir=comma)
        commander, boundary = self.build()
        with self.assertRaisesRegex(InvalidAction, 'mount delimiters'):
            boundary.create(prepared)
        self.assertEqual(commander.trace, [])
        self.assertEqual(self.ledger.read(), [])

    def test_collection_rejects_sparse_size_before_any_payload_read(self) -> None:
        commander, boundary = self.build()
        prepared = self.prepare(limits=Limits(output_mib=1))
        record = boundary.create(prepared)
        with (prepared.spec.output_dir / 'sparse').open('wb') as handle:
            handle.truncate(100 * 1024**3)
        with mock.patch('sandbox.os.read', side_effect=AssertionError('sparse payload was read')):
            result = boundary.collect_output(prepared, record)
        self.assertTrue(result['exceeded_admitted_envelope'])
        self.assertEqual(result['files'], [])

    def test_collection_never_follows_output_links(self) -> None:
        _, boundary = self.build()
        prepared = self.prepare(); record = boundary.create(prepared)
        outside = self.work_root / 'private'; outside.mkdir()
        (outside / 'secret').write_bytes(b'not output')
        (prepared.spec.output_dir / 'dir-link').symlink_to(outside, target_is_directory=True)
        (prepared.spec.output_dir / 'file-link').symlink_to(outside / 'secret')
        result = boundary.collect_output(prepared, record)
        self.assertEqual(result['files'], [])

    def test_ledger_fsync_includes_its_directory_entry(self) -> None:
        observed = []
        actual = os.fsync
        def sync(fd):
            observed.append(sandbox.stat.S_ISDIR(os.fstat(fd).st_mode)); actual(fd)
        with mock.patch('sandbox.os.fsync', side_effect=sync):
            self.ledger.append(action_id='durable-001', action_epoch=1, event='create_attempt')
        self.assertFalse(observed[0])
        self.assertTrue(any(observed[1:]))

    def test_an_output_above_the_admitted_size_is_only_flagged_not_enforced(self) -> None:
        commander, sandbox = self.build(exit_code=0)
        prepared = self.prepare(limits=Limits(output_mib=1))
        record = sandbox.create(prepared)
        sandbox.start_once(record)
        sandbox.wait_for_exit(prepared, record, deadline_monotonic=sandbox.clock() + prepared.spec.limits.wall_seconds)
        (prepared.spec.output_dir / "big.bin").write_bytes(b"y" * (2 * 1024 * 1024))
        result = sandbox.collect_output(prepared, record)
        self.assertTrue(result["exceeded_admitted_envelope"])
        self.assertFalse(result["enforced"])

    def test_collection_hashes_files_incrementally_without_reading_them_whole(self) -> None:
        commander, sandbox = self.build(exit_code=0)
        prepared = self.prepare(limits=Limits(output_mib=1))
        record = sandbox.create(prepared)
        sandbox.start_once(record)
        sandbox.wait_for_exit(prepared, record, deadline_monotonic=sandbox.clock() + prepared.spec.limits.wall_seconds)
        payload = bytes(range(256)) * 4096  # 1 MiB
        (prepared.spec.output_dir / "payload.bin").write_bytes(payload)
        with mock.patch.object(Path, "read_bytes",
                               side_effect=AssertionError("a whole file was read")):
            result = sandbox.collect_output(prepared, record)
        self.assertEqual(result["bytes"], len(payload))
        self.assertEqual(result["files"][0]["sha256"], hashlib.sha256(payload).hexdigest())
        self.assertFalse(result["enforced"])

    def test_collection_measures_a_large_sparse_file_with_bounded_memory(self) -> None:
        commander, sandbox = self.build(exit_code=0)
        prepared = self.prepare(limits=Limits(output_mib=1))
        record = sandbox.create(prepared)
        sandbox.start_once(record)
        sandbox.wait_for_exit(prepared, record, deadline_monotonic=sandbox.clock() + prepared.spec.limits.wall_seconds)
        sparse_bytes = 32 * 1024 * 1024
        sparse = prepared.spec.output_dir / "sparse.bin"
        with sparse.open("wb") as handle:
            handle.truncate(sparse_bytes)
        tracemalloc.start()
        try:
            result = sandbox.collect_output(prepared, record)
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertEqual(result["bytes"], sparse_bytes)
        self.assertTrue(result["exceeded_admitted_envelope"])
        self.assertFalse(result["enforced"])
        # The whole 32 MiB sparse file is never materialized; the peak stays near the fixed chunk
        # buffer, far below the file's apparent size.
        self.assertLess(peak, 8 * 1024 * 1024)

    def test_input_tree_hashing_does_not_read_files_whole(self) -> None:
        with mock.patch.object(Path, "read_bytes",
                               side_effect=AssertionError("input hashing read a file whole")):
            prepared = self.prepare(input_payload=bytes(range(256)) * 8192)  # 2 MiB
        self.assertEqual(prepared.manifest.entries[0]["size"], 2 * 1024 * 1024)
        self.assertTrue(prepared.manifest.digest.startswith("sha256:"))

    def test_unimplemented_bounds_are_visible_and_refuse_explicit_requests(self) -> None:
        support = describe_support()
        self.assertEqual(set(support["unavailable"]), set(UNAVAILABLE_BOUNDS))
        self.assertNotIn("output_write_time_bound", support["enforced"])
        self.assertNotIn("wall_seconds", support["enforced"])
        self.assertIn("independent_wall_deadline", support["unavailable"])
        self.assertIn("tmp_mib", support["enforced"])
        with self.assertRaises(UnsupportedCapability) as caught:
            require_output_write_time_bound()
        self.assertIn("qualification remain open", str(caught.exception).lower())

    def test_the_intent_digest_binds_the_content_that_will_run(self) -> None:
        base = self.prepare()
        self.assertNotEqual(base.intent_digest, self.prepare(action_epoch=2).intent_digest)
        self.assertNotEqual(base.intent_digest,
                            self.prepare(command=("/usr/bin/probe", "--other")).intent_digest)
        self.assertNotEqual(base.intent_digest,
                            self.prepare(limits=Limits(memory_mib=256)).intent_digest)
        # Host paths are deliberately outside the digest: the same Action copied elsewhere has the
        # same intent identity.
        again = self.prepare()
        self.assertEqual(base.intent_digest, again.intent_digest)
        self.assertNotEqual(base.manifest.digest, "sha256:" + "0" * 64)

    def test_input_bytes_change_the_intent_digest(self) -> None:
        first = self.prepare()
        second = self.prepare(input_payload=b"row,value\n7,new\n")
        self.assertNotEqual(first.intent_digest, second.intent_digest)
        self.assertNotEqual(first.manifest.digest, second.manifest.digest)

    # -- adapter ---------------------------------------------------------------------------

    def test_the_subprocess_adapter_does_not_inherit_daemon_selection_variables(self) -> None:
        with mock.patch.dict(os.environ, {"DOCKER_HOST": "tcp://evil.invalid:2375",
                                          "DOCKER_CONFIG": "/tmp/evil",
                                          "PATH": os.environ.get("PATH", "/usr/bin:/bin")}):
            commander = SubprocessCommander()
        self.assertNotIn("DOCKER_HOST", commander.environment)
        self.assertNotIn("DOCKER_CONFIG", commander.environment)
        self.assertTrue(commander.binary.startswith("/"))
        self.assertEqual(set(commander.environment), {"PATH"})

    def test_the_adapter_reports_a_missing_docker_binary_instead_of_downloading_one(self) -> None:
        with self.assertRaises(DockerUnavailable) as caught:
            SubprocessCommander(binary="docker-does-not-exist")
        self.assertIn("never installs or downloads", str(caught.exception))

    def test_the_adapter_bounds_overlarge_cli_output_and_flags_it(self) -> None:
        limit = 4096
        commander = SubprocessCommander(binary=sys.executable, capture_limit_bytes=limit)
        script = ("import sys; sys.stdout.write('o' * (10 * 1024 * 1024)); "
                  "sys.stderr.write('e' * (10 * 1024 * 1024))")
        result = commander.run(("-c", script), timeout=60)
        self.assertTrue(result.output_truncated)
        self.assertFalse(result.ok)
        self.assertIsNone(result.status)
        retained = len(result.stdout.encode("utf-8")) + len(result.stderr.encode("utf-8"))
        self.assertLessEqual(retained, limit)
        self.assertEqual(result.captured_bytes, retained)

    def test_the_adapter_distinguishes_a_successful_command_from_truncation(self) -> None:
        commander = SubprocessCommander(binary=sys.executable, capture_limit_bytes=4096)
        result = commander.run(("-c", "print('hello')"), timeout=60)
        self.assertTrue(result.ok)
        self.assertFalse(result.output_truncated)
        self.assertFalse(result.timed_out)
        self.assertEqual(result.status, 0)
        self.assertEqual(result.stdout.strip(), "hello")

    def test_the_adapter_still_flags_a_timeout_as_uncertain(self) -> None:
        commander = SubprocessCommander(binary=sys.executable, capture_limit_bytes=4096)
        result = commander.run(("-c", "import time; time.sleep(30)"), timeout=0.5)
        self.assertTrue(result.timed_out)
        self.assertFalse(result.ok)

    def test_the_adapter_does_not_trust_a_pipe_held_open_after_cli_exit(self) -> None:
        commander = SubprocessCommander(binary=sys.executable, capture_limit_bytes=4096)
        script = ("import subprocess, sys; "
                  "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(2)'])")
        started = time.monotonic()
        result = commander.run(("-c", script), timeout=0.1)
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 1.5)
        self.assertTrue(result.uncertain)
        self.assertFalse(result.ok)
        self.assertIsNone(result.status)

    def test_image_inspect_does_not_treat_uncertain_capture_as_absence(self) -> None:
        class UncertainCommander(Commander):
            def run(self, argv, *, timeout):
                return CommandResult(tuple(argv), None, "", "", output_truncated=True)

        with self.assertRaises(DockerUnavailable):
            DockerCli(UncertainCommander()).image_inspect("example@sha256:" + "1" * 64)

    def test_the_adapter_rejects_a_non_positive_capture_limit(self) -> None:
        with self.assertRaises(ValueError):
            SubprocessCommander(binary=sys.executable, capture_limit_bytes=0)

    def test_the_synthetic_action_matches_the_reviewed_probe_shape(self) -> None:
        spec = build_synthetic_spec(action_id="synthetic-001", action_epoch=1, image=self.image,
                                   work_root=self.work_root, interpreter="python3")
        prepared = prepare_action(spec, work_root=self.work_root)
        self.assertEqual(prepared.spec.command[:2], ("python3", "-c"))
        self.assertIn("os.getuid() == 10001", prepared.spec.command[2])
        self.assertIn(b"row,value\n7,old\n", (prepared.spec.input_dir / "source.csv").read_bytes())
        self.assertEqual(prepared.container_name, f"{CONTAINER_NAME_PREFIX}synthetic-001-1")


class HostFactDefaultTest(unittest.TestCase):
    def test_detected_host_facts_are_lowercase_and_populated(self) -> None:
        facts = HostFacts.detect()
        self.assertTrue(facts.system)
        self.assertTrue(facts.machine)
        self.assertEqual(facts.system, facts.system.lower())


if __name__ == "__main__":
    unittest.main(verbosity=2)
