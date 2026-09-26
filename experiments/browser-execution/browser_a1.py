"""Prepared A1 qualification only. No product authority, alternate engine or network fallback."""
from __future__ import annotations

import argparse
from dataclasses import asdict
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import time

def reviewed_directory(here):
    """Only the frozen packet layout or the repository's explicit sibling is valid."""
    local = here / "reviewed"
    selected = local if local.exists() or local.is_symlink() else here.parent / "linux-execution"
    if not selected.is_dir() or any(not (selected / name).is_file()
                                   for name in ("deadline_probe.py", "sandbox.py", "output_capacity.py")):
        raise RuntimeError("complete reviewed packet or sibling linux-execution helpers required")
    return selected


REVIEWED = reviewed_directory(Path(__file__).resolve().parent)
sys.path.insert(0, str(REVIEWED))
import deadline_probe as native
import sandbox

BASE, BIN, ENV = native.BASE, native.BIN, native.ENV
RUNTIME_ARGS = ["--platform=systrap", "--oci-seccomp=true"]
UNIX_PATH_BYTES = 107  # Linux pathname sockaddr_un reserves one byte for NUL.
LINUX_SIGNED_INT_MAX = 2**31 - 1  # Conservative maximum decimal PID and FD widths.
WALL = 180  # New qualification budget, not the existing 60-second qualification evidence.
ARCHIVE = BASE / "downloads/playwright-1.62.1-linux-amd64.tar"
ARCHIVE_SHA = "3f40f8c47fb570b8236014eda17d49d5020a5d9bc01a4a49606471cc82288f89"
ARCHIVE_BYTES = 949432320
MANIFEST = "sha256:c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac"
CONFIG = "sha256:fee853fafa59550d162cef52bca02d907694b44ebf6ef9fb075bcc0c65d8dedb"
INPUTS = {
    "PINS.json": "6834e2c0beedff5ab8a7d8565e28f62e03c16e5495d1bed8797aa10daa9c5543",
    "probe.mjs": "2613e9740c9574baf9ee68d6b562d9451daae02148ef46c054fbd22d66f29cfc",
    "seccomp_profile.json": "d00ad84f5a67031fe2bb64de8d77a5ad9c06adb82935ebdb3c18b5f7ba60a5d0",
}
SOURCES = {
    "deadline_probe.py": "ef19d46fd24bc5512ae880bcc895da8639f0d895e22347edf832d0a1a7950bb4",
    "sandbox.py": "5859262340afb15ca7ac3153a586dbc96339fc71576fa4cd1a01151423fa7465",
    "output_capacity.py": "1d25ff9f64ff1110d555c1431a0d1cfcf023c6338cd949b38fb88a79ed794ab6",
}
require = native.require


def owned_root(name):
    require(re.fullmatch(r"deadline-a1-[a-z0-9]{1,12}", name) is not None, "invalid fresh A1 name")
    root = BASE / "units" / name
    native.unit_name(root)  # Reuse exact socket length/unit name constraints.
    return root



def host_socket_path_bounds(root):
    """Pure upper bounds for this exact pinned no-TTY/no-build A1; see SOCKET_RESEARCH.md."""
    controller = "f" * 12  # Moby stringid.TruncateID, not a PID.
    digest = "f" * 64  # Container ID / SHA256 width, never the future object's identity.
    descriptor = str(LINUX_SIGNED_INT_MAX)
    # gVisor actually uses /proc/self/fd. Budget the longer numeric-PID spelling too,
    # without changing its upstream descriptor-relative bind/connect implementation.
    proc_fd = Path("/proc") / descriptor / "fd" / descriptor
    return {
        "docker_api": root / "docker.sock",
        "containerd_grpc": root / "containerd.sock",
        "containerd_ttrpc": root / "containerd.sock.ttrpc",
        "docker_metrics": root / "docker-exec/metrics.sock",
        "libnetwork_external_key": root / "docker-exec/libnetwork" / (controller + ".sock"),
        "containerd_shim_ttrpc": Path("/run/containerd/s") / digest,
        "containerd_shim_debug": Path("/run/containerd/s") / digest,
        "runsc_control_bind_proc_alias_bound": proc_fd / ("runsc-" + digest + ".sock"),
        "runsc_control_connect_proc_alias_bound": proc_fd,
        **{"runsc_control_" + label: Path(directory) / ("runsc-" + digest + ".sock")
           for label, directory in (("var_run", "/var/run"), ("run", "/run"), ("tmp", "/tmp"))},
    }


def validate_socket_path_bounds(paths):
    """Check full encoded bind pathnames, not Unix URL strings or character counts."""
    inventory = {}
    for label, path in paths.items():
        raw = os.fsencode(path)
        require(path.is_absolute() and b"\0" not in raw and len(raw) <= UNIX_PATH_BYTES,
                "host Unix socket path exceeds 107 bytes or is invalid: " + label)
        inventory[label] = {"upperBoundPath": str(path), "bytes": len(raw)}
    return inventory


def systemd_argv(root):
    properties = dict(native.UNIT_PROPERTIES, RuntimeMaxSec=str(WALL))
    return ["/usr/bin/systemd-run", "--unit=" + native.unit_name(root), "--service-type=exec",
        *("--property=" + k + "=" + v for k, v in properties.items()),
        "--setenv=PATH=" + ENV["PATH"], "/usr/bin/python3", str(root / "source/deadline_probe.py"),
        "daemon", "--root", str(root)]


def configurations(root):
    daemon, containerd = native.configurations(root)
    daemon["runtimes"]["runsc"]["runtimeArgs"] = list(RUNTIME_ARGS)
    return daemon, containerd


def validate_runtime(info):
    runtime = info.get("Runtimes", {}).get("runsc", {})
    require(runtime.get("path") == str(BIN / "runsc") and runtime.get("runtimeArgs") == RUNTIME_ARGS,
            "daemon runsc path/OCI seccomp arguments differ")


def runtime_arguments(group, members, *, proc=Path("/proc")):
    """Observe only original members and fixed runtime executables; never read environments."""
    owned = str(group).removeprefix("/sys/fs/cgroup")
    identity = lambda value: (value.st_dev, value.st_ino)
    binaries = {identity((BIN / name).stat()): name for name in ("runsc", "gvisor-bin/gvisor_sentry")}
    result = {"processes": [], "errors": []}
    for member in members:
        fd = None
        try:
            fd = os.open(proc / str(member["pid"]), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            def read(name):
                file = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
                with os.fdopen(file, "rb") as stream:
                    data = stream.read(16385)
                require(len(data) <= 16384, "runtime metadata exceeds bound")
                return data
            def scope():
                cg = read("cgroup").decode().strip().removeprefix("0::")
                ticks = read("stat").decode().rsplit(")", 1)[1].split()[19]
                require((cg == owned or cg.startswith(owned + "/")) and cg == member["cgroup"]
                        and ticks == member["startTicks"], "runtime PID/cgroup changed")
                return identity(os.stat("exe", dir_fd=fd))
            executable = scope()
            if executable not in binaries:
                continue
            data = read("cmdline")
            require(scope() == executable, "runtime executable changed during observation")
            require(data.endswith(b"\0"), "runtime argv missing terminator")
            result["processes"].append({"pid": member["pid"], "startTicks": member["startTicks"],
                "cgroup": member["cgroup"], "executable": binaries[executable],
                "argv": data[:-1].decode().split("\0")})
        except (OSError, RuntimeError, UnicodeError, IndexError) as error:
            result["errors"].append({"pid": member["pid"], "type": type(error).__name__, "error": str(error)})
        finally:
            if fd is not None:
                os.close(fd)
    return result


def validate_runtime_arguments(observed, container_id):
    candidates = [p for p in observed["processes"] if p["argv"] and p["argv"][0] == "runsc-sandbox"]
    require(len(candidates) == 1, "exact owned Sentry argv was not observed")
    argv = candidates[0]["argv"]
    require(argv.count("boot") == 1 and argv[-1] == container_id, "Sentry boot/container identity differs")
    boot = argv.index("boot")
    for name, expected in (("oci-seccomp", "--oci-seccomp=true"), ("platform", "--platform=systrap")):
        positions = [i for i, word in enumerate(argv) if word.lstrip("-").split("=", 1)[0] == name]
        require(len(positions) == 1 and positions[0] < boot and argv[positions[0]] == expected,
                "Sentry runtime flag missing, conflicting or misplaced: " + name)
    return candidates[0]


def create_argv(root, image):
    require(image in (MANIFEST, CONFIG), "unreviewed image identity")
    return ("create", "--pull=never", "--name", root.name, "--label", "openbot.qualification=browser-A1",
        "--label", "openbot.qualification.root=" + root.name, "--runtime", "runsc", "--restart", "no",
        "--network", "none", "--user", "1001:1001", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges=true", "--security-opt", "seccomp=" + str(root / "input/seccomp_profile.json"),
        "--ipc", "private", "--shm-size", "256m", "--init", "--cpus", "1.5", "--memory", "1536m",
        "--memory-swap", "1536m", "--pids-limit", "1536", "--ulimit", "nproc=256:256",
        "--ulimit", "nofile=4096:4096", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=256m,uid=1001,gid=1001,mode=700",
        "--tmpfs", "/profiles:rw,nosuid,nodev,noexec,size=256m,uid=1001,gid=1001,mode=700",
        "--mount", "type=bind,src=" + str(root / "input") + ",dst=/qualification,readonly",
        "--env", "HOME=/tmp", "--env", "LANG=C.UTF-8", "--log-driver", "local", "--log-opt", "max-size=1m",
        "--log-opt", "max-file=1", "--log-opt", "compress=false",
        "--entrypoint", "/usr/bin/node", image, "/qualification/probe.mjs")


class RecordingCommander(sandbox.Commander):
    """Same bounded subprocess adapter; preserve its separate streams and uncertainty verbatim."""
    def __init__(self, root, commander):
        self.root, self.commander, self.sequence = root, commander, 0
        self.native_started = None

    def run(self, argv, *, timeout):
        self.sequence += 1
        started = time.monotonic()
        result = self.commander.run(argv, timeout=timeout)
        finished = time.monotonic()
        observation = {"elapsedMs": round((finished - started) * 1000, 3),
            "nativeStartElapsedMs": (round((started - self.native_started) * 1000, 3)
                                     if self.native_started is not None else None)}
        native.durable(self.root / f"commands/{self.sequence:04d}.json", {**asdict(result), "observation": observation})
        return result


def host(root, label, argv, timeout=5):
    result = sandbox.SubprocessCommander(binary=argv[0], extra_environment=ENV,
        capture_limit_bytes=1024 * 1024).run(argv[1:], timeout=timeout)
    native.durable(root / (label + ".json"), asdict(result))
    require(result.ok, label + " failed or unknown; see its recorded stdout/stderr/exit")
    return result.stdout


def validate_unit(root, value):
    # Same typed contract as reviewed validate_unit, with a separately declared A1 lifetime.
    expected = {"Type": "exec", "KillMode": "control-group", "KillSignal": "9", "FinalKillSignal": "9",
        "SendSIGKILL": "yes", "Restart": "no", "NRestarts": "0", "NotifyAccess": "none", "ExecStop": "",
        "ExecStopPost": "", "TriggeredBy": "", "PrivateNetwork": "yes", "PrivateMounts": "yes",
        "DelegateSubgroup": "supervisor", "MemoryMax": str(2500 * 1024**2), "MemorySwapMax": "0",
        "TasksMax": "1536", "ControlGroup": "/system.slice/" + native.unit_name(root)}
    require(all(value.get(k) == v for k, v in expected.items()), "native unit contract differs")
    for key, expected_seconds in (("RuntimeMaxUSec", WALL), ("RuntimeRandomizedExtraUSec", 0),
                                  ("TimeoutStopUSec", 1), ("CPUQuotaPerSecUSec", 1.5)):
        require(native.seconds(value[key]) == expected_seconds, "native duration/resource differs: " + key)
    require(re.fullmatch(r"[a-f0-9]{32}", value.get("InvocationID", "")) is not None, "missing invocation")
    require(value.get("ActiveState") == "active" and int(value["ActiveEnterTimestampMonotonic"]) > 0,
            "unit has no active lifetime")
    return int(value["ActiveEnterTimestampMonotonic"]) / 1_000_000 + WALL


def validate_image(image):
    require(image.get("Id") in (MANIFEST, CONFIG) and image.get("Architecture") == "amd64"
            and image.get("Os") == "linux", "loaded image identity/platform differs")
    descriptor = image.get("Descriptor")
    if descriptor is not None:
        require(descriptor.get("digest") == MANIFEST, "loaded platform descriptor differs")
    return image["Id"]


def validate_container(root, image, value, *, created):
    require(sandbox.CONTAINER_ID_PATTERN.fullmatch(value.get("Id", "")) is not None, "invalid immutable container ID")
    require(value.get("Name") == "/" + root.name and value.get("Image") == image["Id"], "container identity differs")
    config, host_config = value["Config"], value["HostConfig"]
    require(config.get("User") == "1001:1001" and config.get("Entrypoint") == ["/usr/bin/node"]
            and config.get("Cmd") == ["/qualification/probe.mjs"] and config.get("Image") == image["Id"],
            "guest identity/command differs")
    require(config.get("Labels", {}).get("openbot.qualification") == "browser-A1"
            and config["Labels"].get("openbot.qualification.root") == root.name, "container ownership differs")
    expected_env = {x.split("=", 1)[0]: x for x in image.get("Config", {}).get("Env", [])}
    expected_env.update(HOME="HOME=/tmp", LANG="LANG=C.UTF-8")
    require(sorted(config.get("Env", [])) == sorted(expected_env.values()), "container environment differs")
    require(not any(x.split("=", 1)[0].upper().startswith(sandbox.SECRET_ENV_PREFIXES)
                    for x in config.get("Env", [])), "secret-like image environment refused")
    exact = {"Runtime": "runsc", "NetworkMode": "none", "IpcMode": "private", "ReadonlyRootfs": True,
        "Privileged": False, "Init": True, "PidsLimit": 1536, "Memory": 1536 * 1024**2,
        "MemorySwap": 1536 * 1024**2, "NanoCpus": 1500000000, "ShmSize": 256 * 1024**2,
        "CapDrop": ["ALL"], "RestartPolicy": {"Name": "no", "MaximumRetryCount": 0},
        "LogConfig": {"Type": "local", "Config": {"max-size": "1m", "max-file": "1", "compress": "false"}}}
    require(all(type(host_config.get(k)) is type(v) and host_config[k] == v for k, v in exact.items()),
            "container isolation/resource contract differs")
    for key in ("CapAdd", "Devices", "DeviceRequests", "DeviceCgroupRules", "PortBindings", "Binds", "VolumesFrom",
                "ExtraHosts", "Links", "Dns", "DnsSearch", "DnsOptions", "Sysctls", "GroupAdd", "PidMode", "UTSMode"):
        require(not host_config.get(key), "unexpected host option: " + key)
    require(not host_config.get("PublishAllPorts") and not host_config.get("AutoRemove"), "unexpected lifecycle/ports")
    options = host_config.get("SecurityOpt", [])
    require(len(options) == 2 and len(set(options)) == 2, "unexpected security options")
    require(any(x in ("no-new-privileges", "no-new-privileges=true") for x in options), "no-new-privileges absent")
    seccomp = [x.removeprefix("seccomp=") for x in options if x.startswith("seccomp=")]
    require(len(seccomp) == 1 and json.loads(seccomp[0]) == native.read_json(root / "input/seccomp_profile.json"),
            "daemon stored a different seccomp policy")
    ulimits = host_config.get("Ulimits", [])
    require(len(ulimits) == 2 and sorted((x.get("Name"), x.get("Soft"), x.get("Hard")) for x in ulimits)
            == [("nofile", 4096, 4096), ("nproc", 256, 256)]
            and all(type(x[field]) is int for x in ulimits for field in ("Soft", "Hard")), "guest rlimits differ")
    tmpfs = host_config.get("Tmpfs", {})
    require(set(tmpfs) == {"/tmp", "/profiles"}, "temporary destinations differ")
    for options in tmpfs.values():
        fields = options.split(",")
        sizes = {"size=256m", "size=262144k", "size=268435456"}
        require(len(fields) == 8 and len(set(fields)) == 8 and len(set(fields) & sizes) == 1
                and set(fields) - sizes == {"rw", "nosuid", "nodev", "noexec", "uid=1001", "gid=1001", "mode=700"},
                "bounded private tmpfs differs")
    mounts = value.get("Mounts", [])
    binds = [x for x in mounts if x.get("Destination") == "/qualification"]
    require(len(binds) == 1 and binds[0].get("Source") == str(root / "input") and binds[0].get("Type") == "bind"
            and binds[0].get("RW") is False and binds[0].get("Propagation") == "rprivate", "readonly input bind differs")
    require(all(x.get("Destination") == "/qualification" or
                (x.get("Destination") in tmpfs and x.get("Type") == "tmpfs") for x in mounts), "extra container mount")
    require(not config.get("Volumes") and not config.get("ExposedPorts"), "image requests volumes or exposed ports")
    require(set((value.get("NetworkSettings") or {}).get("Networks", {})) <= {"none"}, "unexpected network attachment")
    if created:
        state = value["State"]
        require(state.get("Status") == "created" and state.get("Running") is False and state.get("Pid") == 0
                and state.get("StartedAt", "").startswith("0001-"), "container already started")
    return value["Id"]


def remaining(deadline, reserve=0):
    result = deadline - time.monotonic() - reserve
    require(result > 0, "native A1 lifetime exhausted; no retry or longer replacement unit")
    return result


def observe_expiry(root, armed):
    group = Path("/sys/fs/cgroup") / armed["group"].lstrip("/")
    def stopped():
        if group.exists():
            require(group.stat().st_ino == armed["inode"], "original cgroup was replaced")
            if dict(x.split() for x in (group / "cgroup.events").read_text().splitlines())["populated"] != "0":
                return None
        value = native.show(armed["unit"])
        require(value.get("InvocationID") == armed["invocation"], "original unit invocation changed")
        return value if value.get("ActiveState") in ("inactive", "failed") else None
    value = native.wait_until(stopped, armed["deadline"] + 5, "A1 native lifetime")
    native.durable(root / "native-terminal-readback.json", value)
    require(value.get("Result") == "timeout" and value.get("NRestarts") == "0", "not original native timeout")
    require(not native.cgroup_members(group), "owned native tree is not empty")
    proof = {"unit": value, "cgroupEmpty": True, "observedStopLatencySeconds": time.monotonic() - armed["deadline"]}
    native.durable(root / "native-expiry.json", proof)
    return proof


def run(name, inputs):
    require(os.geteuid() == 0 and sys.platform == "linux" and os.uname().machine == "x86_64", "Linux x86-64 root required")
    root = owned_root(name)
    socket_bounds = validate_socket_path_bounds(host_socket_path_bounds(root))
    for directory in (BASE, BIN, BIN / "gvisor-bin", BASE / "units", REVIEWED, inputs):
        info = directory.lstat()
        require(directory.resolve() == directory and stat.S_ISDIR(info.st_mode) and info.st_uid == 0
                and not info.st_mode & 0o022, "trusted root-owned directory required")
    for source, expected in SOURCES.items():
        native.trusted_file(REVIEWED / source)
        require(native.digest(REVIEWED / source) == expected, "reviewed helper source changed")
    for name, expected in INPUTS.items():
        native.trusted_file(inputs / name)
        require(native.digest(inputs / name) == expected, "frozen A1 input changed: " + name)
    for name in (*native.BINARY_FILES, "docker-init"):
        native.trusted_file(BIN / name)
    native.trusted_file(ARCHIVE)
    require(ARCHIVE.stat().st_size == ARCHIVE_BYTES and native.digest(ARCHIVE) == ARCHIVE_SHA, "offline archive differs")
    root.mkdir(mode=0o700)  # Exclusive allocation forbids reuse after any unknown result.
    for part in ("source", "config", "docker-config", "commands", "input"):
        (root / part).mkdir(mode=0o700)
    for name in SOURCES:
        shutil.copyfile(REVIEWED / name, root / "source" / name)
    for name in INPUTS:
        shutil.copyfile(inputs / name, root / "input" / name)
        (root / "input" / name).chmod(0o444)
    (root / "input").chmod(0o555)
    unit = native.unit_name(root)
    native.durable(root / "socket-path-preflight.json", {"version": 1, "maxPathBytes": UNIX_PATH_BYTES,
        "dynamicIdentifierIntMax": LINUX_SIGNED_INT_MAX, "bounds": socket_bounds})
    native.durable(root / "ownership.json", {"root": str(root), "unit": unit, "case": "browser-A1",
        "runtimeSeconds": WALL, "archiveSha256": ARCHIVE_SHA, "sources": SOURCES, "inputs": INPUTS,
        "binarySha256": {name: native.digest(BIN / name) for name in (*native.BINARY_FILES, "docker-init")}})
    require(native.show(unit).get("LoadState") == "not-found", "unit already exists; never reuse")
    daemon, containerd = configurations(root)
    native.durable(root / "config/daemon.json", daemon)
    (root / "config/containerd.toml").write_text(containerd)
    original = native.docker(root)
    cli = sandbox.DockerCli(RecordingCommander(root, original.commander), default_timeout=3)
    armed = None
    result = {"kind": "browser-A1-native-qualification", "runtimeSeconds": WALL, "accepted": False,
              "nativeExpiryVerified": False, "startAttempts": 0, "cleanupProblems": []}
    try:
        native.durable(root / "unit-start-reserved.json", {"unit": unit})
        host(root, "systemd-start", systemd_argv(root), 10)
        value = native.wait_until(lambda: (v if (v := native.show(unit)).get("ActiveState") == "active" else None),
                                  time.monotonic() + 5, "A1 unit active")
        value.update(native.stop_hooks(unit))
        native.durable(root / "unit-readback.json", value)
        deadline = validate_unit(root, value)
        cli.commander.native_started = int(value["ActiveEnterTimestampMonotonic"]) / 1_000_000
        group = Path("/sys/fs/cgroup") / value["ControlGroup"].lstrip("/")
        armed = {"unit": unit, "invocation": value["InvocationID"], "deadline": deadline,
                 "group": value["ControlGroup"], "inode": group.stat().st_ino}
        native.durable(root / "native-unit.json", {"armed": armed, "properties": value})
        def ready():
            try:
                return cli.info()
            except sandbox.ExecutionError:
                return None
        info = native.wait_until(ready, min(deadline - 90, time.monotonic() + 15), "private Docker")
        require(cli.version() == "29.8.1" and info.get("DockerRootDir") == str(root / "docker-data")
                and info.get("Containerd", {}).get("Address") == str(root / "containerd.sock")
                and info.get("LiveRestoreEnabled") is False and str(info.get("CgroupVersion")) == "2"
                and info.get("OSType") == "linux" and info.get("Architecture") in ("amd64", "x86_64")
                and info.get("DefaultRuntime") == "runsc" and "runsc" in info.get("Runtimes", {}), "private daemon facts differ")
        native.durable(root / "daemon-readback.json", info)
        validate_runtime(info)
        pid = int((root / "dockerd.pid").read_text())
        current = native.show(unit)
        require(current["InvocationID"] == armed["invocation"] and int(current["MainPID"]) == pid, "daemon identity differs")
        for ns in ("mnt", "net"):
            require(os.readlink(f"/proc/{pid}/ns/{ns}") != os.readlink(f"/proc/1/ns/{ns}"), "private namespace absent")
        native.durable(root / "load-reserved.json", {"archiveSha256": ARCHIVE_SHA})
        require(cli.commander.run(("load", "--input", str(ARCHIVE)), timeout=remaining(deadline, 85)).ok,
                "single offline load failed/unknown; inspect recorded command output")
        image = cli.image_inspect(MANIFEST)
        if image is None:
            image = cli.image_inspect(CONFIG)  # Read-only lookup of the other pinned identity representation.
        require(image is not None, "reviewed offline image not found")
        image_id = validate_image(image)
        native.durable(root / "image-readback.json", image)
        remaining(deadline, 80)
        native.durable(root / "create-reserved.json", {"imageId": image_id})
        created = cli.commander.run(create_argv(root, image_id), timeout=min(10, remaining(deadline, 75)))
        require(created.ok and sandbox.CONTAINER_ID_PATTERN.fullmatch(created.stdout.strip()) is not None,
                "single create failed/unknown; never recreate")
        container_id = created.stdout.strip()
        inspected = cli.inspect(container_id)
        require(inspected is not None, "created container missing")
        require(validate_container(root, image, inspected, created=True) == container_id, "created ID differs")
        native.durable(root / "container-created.json", inspected)
        # Final native identity and remaining-budget check precede the single consumed start attempt.
        current = native.show(unit)
        require(current.get("InvocationID") == armed["invocation"] and current.get("ActiveState") == "active", "native fence changed")
        # Reserve worst-case start10s + guest65s + final inspection/logging10s.
        remaining(deadline, 85)
        native.durable(root / "start-reserved.json", {"containerId": container_id, "deadline": deadline})
        result["startAttempts"] = 1
        started = cli.start(container_id, timeout=min(10, remaining(deadline, 5)))
        running = cli.inspect(container_id, timeout=min(3, remaining(deadline, 3)))
        native.durable(root / "container-after-start.json", running)
        members = native.cgroup_members(group)
        native.durable(root / "runtime-members.json", members)
        try:
            require(group.stat().st_ino == armed["inode"], "original cgroup replaced before argv observation")
            arguments = runtime_arguments(group, members)
            require(group.stat().st_ino == armed["inode"], "original cgroup replaced during argv observation")
        except (OSError, RuntimeError) as error:
            arguments = {"processes": [], "errors": [{"type": type(error).__name__, "error": str(error)}]}
        native.durable(root / "runtime-arguments.json", arguments)
        waited = cli.wait(container_id, timeout=remaining(deadline, 4))
        final = cli.inspect(container_id, timeout=min(2, remaining(deadline, 2)))
        native.durable(root / "container-final.json", final)
        logs = cli.commander.run(("logs", container_id), timeout=min(2, remaining(deadline)))
        # Streams are separately retained by RecordingCommander even for a failing Chromium process.
        require(final is not None and validate_container(root, image, final, created=False) == container_id, "final container differs")
        state = final["State"]
        record = json.loads(logs.stdout) if logs.ok else None
        result.update(containerId=container_id, exitCode=state.get("ExitCode"), browserRecord=record)
        require(started.ok and waited.ok and logs.ok and final.get("RestartCount") == 0
                and state.get("Status") == "exited" and state.get("Running") is False
                and state.get("OOMKilled") is False and state.get("ExitCode") == 0 and type(state.get("ExitCode")) is int,
                "browser execution failed/unknown; actual streams and exit are retained")
        require(isinstance(record, dict) and record.get("accepted") is True and record.get("uid") == 1001
                and record.get("gid") == 1001, "A1 browser evidence not accepted")
        require({"shim", "sentry", "gofer"}.issubset({x["role"] for x in members})
                and running is not None and any(x["pid"] == running["State"].get("Pid") for x in members),
                "runtime membership was not observed in the original native group")
        validate_runtime_arguments(arguments, container_id)
        result["accepted"] = True
    except BaseException as error:
        result.update(failureType=type(error).__name__, failure=str(error))
    finally:
        if armed:
            try:
                result["nativeExpiry"] = observe_expiry(root, armed)
                result["nativeExpiryVerified"] = True
                host(root, "native-journal", ["/usr/bin/journalctl", "--no-pager", "-o", "short-monotonic",
                     "_SYSTEMD_INVOCATION_ID=" + armed["invocation"]], 3)
                native.check_root(root)
                for name in ("docker-data", "docker-exec", "containerd-data", "containerd-state"):
                    path = root / name
                    if path.exists():
                        require(not path.is_symlink(), "refuse symlink cleanup")
                        shutil.rmtree(path)
                host(root, "native-reset-failed", ["/usr/bin/systemctl", "reset-failed", unit], 3)
            except BaseException as error:
                result["cleanupProblems"].append(str(error))
        else:
            result["cleanupProblems"].append("Native start/identity unconfirmed; preserve exact root and reservation, never retry start.")
        result["accepted"] = bool(result["accepted"] and result["nativeExpiryVerified"] and not result["cleanupProblems"])
        native.durable(root / "result.json", result)
        print(json.dumps({k: v for k, v in result.items() if k not in ("browserRecord", "nativeExpiry")}))
    return 0 if result["accepted"] else 2


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", required=True, help="fresh deadline-a1- suffix, at most 12 lowercase letters/digits")
    parser.add_argument("--inputs", type=Path, required=True, help="absolute root-owned frozen A1 compatibility directory")
    args = parser.parse_args()
    raise SystemExit(run(args.name, args.inputs))
