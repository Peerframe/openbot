"""Disposable, single-Action native lifetime qualification; never product authority.

Run on the reviewed Linux host as root. Fixed reviewed binaries/archive are read only.
Every case creates a new root/unit/private daemon tree, then observes PID1 expiry.
No production endpoint is contacted. Unknown execution is never retried.
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import time

import sandbox
from output_capacity import verify_output_capacity

BASE = Path("/opt/openbot-qualification-20260925-c8b2")
BIN = BASE / "bin"
ARCHIVE = BASE / "downloads/python-amd64.tar"
ARCHIVE_SHA = "b6a087a833e6d00409197b8ba06071a1890df84eb52b770b757f092b7d2e8788"
IMAGE = "python@sha256:6e13e65c55e33adf203d77ee371cf8bf5d81bd4902ef07565721f46bf44917af"
CASES = ("baseline", "controller-gone", "daemon-stopped", "queued-start")
WALL = 60
ENV = {"PATH": str(BIN) + ":/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"}
SOURCES = ("deadline_probe.py", "sandbox.py", "output_capacity.py")
BINARY_FILES = ("docker", "dockerd", "containerd", "containerd-shim-runsc-v1", "runsc",
                "gvisor-bin/checkpointgofer", "gvisor-bin/gvisor-sentry-prewarmer",
                "gvisor-bin/gvisor_sentry", "gvisor-bin/runsc-fd-parking",
                "gvisor-bin/runsc-metric-server")
NAME = re.compile(r"deadline-[a-z0-9][a-z0-9-]{0,47}\Z")
UNIT_PROPERTIES = {
    "PrivateNetwork": "yes", "PrivateMounts": "yes", "Delegate": "yes",
    "DelegateSubgroup": "supervisor", "MemoryMax": "2500M", "MemorySwapMax": "0",
    "CPUQuota": "150%", "TasksMax": "1536", "RuntimeMaxSec": str(WALL),
    "RuntimeRandomizedExtraSec": "0", "TimeoutStartSec": "10", "TimeoutStopSec": "1",
    "KillMode": "control-group", "KillSignal": "SIGKILL", "FinalKillSignal": "SIGKILL",
    "SendSIGKILL": "yes", "Restart": "no", "NotifyAccess": "none",
}
SHOW = ("LoadState", "ActiveState", "SubState", "Result", "MainPID", "InvocationID",
        "ControlGroup", "ActiveEnterTimestampMonotonic", "RuntimeMaxUSec",
        "RuntimeRandomizedExtraUSec", "TimeoutStopUSec", "KillMode", "KillSignal",
        "FinalKillSignal", "SendSIGKILL", "Restart", "NRestarts", "Type", "NotifyAccess",
        "ExecStop", "ExecStopPost", "TriggeredBy", "PrivateNetwork", "PrivateMounts",
        "DelegateSubgroup", "MemoryMax", "MemorySwapMax", "TasksMax", "CPUQuotaPerSecUSec")
WORKLOAD = """import os,pathlib,time
with open('/output/started','xb') as f:f.write(b'one-start\\n');f.flush();os.fsync(f.fileno())
with open('/output/heartbeat','ab',buffering=0) as f:
 while True:
  f.write((str(time.monotonic_ns())+'\\n').encode());os.fsync(f.fileno());time.sleep(.1)
"""


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def durable(path, payload):
    """Exclusive durable receipts; a second caller never replaces the first decision."""
    data = json.dumps(payload, sort_keys=True).encode() + b"\n"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(data); stream.flush(); os.fsync(fd)
    finally:
        os.close(fd)
    fd = os.open(Path(path).parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def read_json(path):
    require(path.stat().st_size <= 1024 * 1024, "oversized trusted receipt")
    return json.loads(path.read_text())


def command(argv, timeout=10):
    """Bound output using the existing reviewed subprocess boundary, never a shell."""
    runner = sandbox.SubprocessCommander(binary=argv[0], extra_environment=ENV,
                                        capture_limit_bytes=1024 * 1024)
    result = runner.run(tuple(argv[1:]), timeout=timeout)
    require(result.ok, "bounded host command failed or became unknown: " + Path(argv[0]).name)
    return result.stdout.strip()


def trusted_file(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
            "trusted regular root-owned file required")


def unit_name(root):
    require(NAME.fullmatch(root.name) is not None, "invalid owned root name")
    require(len(os.fsencode(root / "containerd.sock")) < 104, "owned Unix socket path is too long")
    return "openbot-qualification-" + root.name + ".service"


def check_root(root):
    require(root.parent == BASE / "units" and root.resolve() == root, "root is outside fixed units directory")
    info = root.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700,
            "owned root must be private and root-owned")
    owner = read_json(root / "ownership.json")
    require(owner["root"] == str(root) and owner["unit"] == unit_name(root), "ownership mismatch")
    return owner


def docker(root):
    return sandbox.DockerCli(sandbox.SubprocessCommander(binary=str(BIN / "docker"),
        extra_environment=ENV, global_arguments=("--config", str(root / "docker-config"),
                                                "--host", "unix://" + str(root / "docker.sock"))),
        default_timeout=10)


def configurations(root):
    unit = unit_name(root)
    daemon = {"hosts": ["unix://" + str(root / "docker.sock")],
        "data-root": str(root / "docker-data"), "exec-root": str(root / "docker-exec"),
        "pidfile": str(root / "dockerd.pid"), "bridge": "none", "iptables": False,
        "ip6tables": False, "ip-forward": False, "ip-masq": False, "userland-proxy": False,
        "live-restore": False, "runtimes": {"runsc": {"path": str(BIN / "runsc"),
                                                     "runtimeArgs": ["--platform=systrap"]}},
        "default-runtime": "runsc", "exec-opts": ["native.cgroupdriver=cgroupfs"],
        "cgroup-parent": "/system.slice/" + unit, "log-driver": "local",
        "log-opts": {"max-size": "1m", "max-file": "1"},
        "containerd": str(root / "containerd.sock"),
        "containerd-namespace": "openbot-qualification",
        "containerd-plugins-namespace": "openbot-qualification-plugins"}
    containerd = (f'version = 3\nroot = "{root}/containerd-data"\nstate = "{root}/containerd-state"\n'
        'disabled_plugins = ["io.containerd.cri.v1.images", "io.containerd.cri.v1.runtime"]\n'
        f'[grpc]\n  address = "{root}/containerd.sock"\n')
    return daemon, containerd


def systemd_argv(root):
    return ["/usr/bin/systemd-run", "--unit=" + unit_name(root), "--service-type=exec",
        *("--property=" + key + "=" + value for key, value in UNIT_PROPERTIES.items()),
        "--setenv=PATH=" + ENV["PATH"], "/usr/bin/python3", str(root / "source/deadline_probe.py"),
        "daemon", "--root", str(root)]


def show(unit):
    runner = sandbox.SubprocessCommander(binary="/usr/bin/systemctl", extra_environment=ENV,
                                        capture_limit_bytes=65536)
    result = runner.run(("show", unit, "--all", "--no-pager", "--property=" + ",".join(SHOW)), timeout=3)
    require(not result.uncertain, "systemd observation unknown")
    value = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    require(result.ok or (result.status == 1 and value.get("LoadState") == "not-found"),
            "systemd observation failed")
    return value


def seconds(value):
    # systemctl's public property format uses combined values such as 1min or 1.500000s.
    if value == "0":
        return 0.0
    units = {"us": .000001, "ms": .001, "s": 1, "min": 60, "h": 3600}
    parts = re.findall(r"([0-9]+(?:\.[0-9]+)?)(us|ms|s|min|h)", value)
    require(parts and "".join(n + u for n, u in parts) == value.replace(" ", ""),
            "unrecognized finite systemd duration")
    return sum(float(n) * units[u] for n, u in parts)


def stop_hooks(unit):
    # systemctl omits empty execution-command arrays even with --all. Read the
    # typed D-Bus properties so missing text cannot silently stand for no hook.
    service = "org.freedesktop.systemd1"
    found = json.loads(command(["/usr/bin/busctl", "--json=short", "call", service,
        "/org/freedesktop/systemd1", service + ".Manager", "GetUnit", "s", unit]))
    require(found.get("type") == "o" and len(found.get("data", [])) == 1,
            "unit object lookup differs")
    path = found["data"][0]
    require(type(path) is str and path.startswith("/org/freedesktop/systemd1/unit/"),
            "unit object path differs")
    raw = command(["/usr/bin/busctl", "--json=short", "get-property", service, path,
                   service + ".Service", "ExecStop", "ExecStopPost"])
    values = [json.loads(line) for line in raw.splitlines()]
    require(len(values) == 2 and all(value == {"type": "a(sasbttttuii)", "data": []}
                                   for value in values), "native stop hooks are not empty")
    return {"ExecStop": "", "ExecStopPost": ""}


def validate_unit(root, value):
    exact = {"Type": "exec", "KillMode": "control-group", "KillSignal": "9",
        "FinalKillSignal": "9", "SendSIGKILL": "yes", "Restart": "no", "NRestarts": "0",
        "NotifyAccess": "none", "ExecStop": "", "ExecStopPost": "", "TriggeredBy": "",
        "PrivateNetwork": "yes", "PrivateMounts": "yes", "DelegateSubgroup": "supervisor",
        "MemoryMax": str(2500 * 1024**2), "MemorySwapMax": "0", "TasksMax": "1536",
        "ControlGroup": "/system.slice/" + unit_name(root)}
    require(all(value.get(k) == v for k, v in exact.items()), "native unit contract differs")
    require(seconds(value["RuntimeMaxUSec"]) == WALL
            and seconds(value["RuntimeRandomizedExtraUSec"]) == 0
            and seconds(value["TimeoutStopUSec"]) == 1
            and seconds(value["CPUQuotaPerSecUSec"]) == 1.5, "native duration/resource contract differs")
    require(re.fullmatch(r"[a-f0-9]{32}", value["InvocationID"]) is not None, "missing invocation identity")
    active_us = int(value["ActiveEnterTimestampMonotonic"])
    require(active_us > 0 and value["ActiveState"] == "active", "unit has no active lifetime")
    return active_us / 1_000_000 + WALL


def cgroup_members(group):
    if not group.exists():
        return []
    result = []
    paths = list(group.rglob("cgroup.procs")) + [group / "cgroup.procs"]
    require(len(paths) <= 4096, "unexpected cgroup tree size")
    seen = set()
    for path in paths:
        try:
            contents = path.read_text()
        except FileNotFoundError:
            continue
        for text in contents.split():
            pid = int(text)
            if pid in seen:
                continue
            seen.add(pid)
            try:
                process = Path("/proc") / str(pid)
                cg = (process / "cgroup").read_text().strip().removeprefix("0::")
                require(cg == str(group).removeprefix("/sys/fs/cgroup")
                        or cg.startswith(str(group).removeprefix("/sys/fs/cgroup") + "/"),
                        "runtime process escaped owned cgroup")
                comm = (process / "comm").read_text().strip()
                with (process / "cmdline").open("rb") as stream:
                    args = stream.read(16385)
                require(len(args) <= 16384, "owned process command metadata too large")
                # Read only processes already in this exact owned tree; never emit full argv.
                words = args.decode("utf-8", errors="replace").split("\0")
                role = ("shim" if comm.startswith("containerd-shim") else
                        "gofer" if "gofer" in words or "gofer" in comm else
                        "sentry" if "boot" in words or "sandbox" in comm else "supervisor")
                result.append({"pid": pid, "comm": comm, "role": role,
                               "cgroup": cg, "startTicks": (process / "stat").read_text().rsplit(")", 1)[1].split()[19]})
            except FileNotFoundError:
                continue
    require(len(result) <= 1536, "outer PID bound differs")
    return result


def wait_until(predicate, deadline, label):
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(.05)
    raise RuntimeError("bounded wait expired: " + label)


def daemon_main(root):
    check_root(root)
    group = Path("/sys/fs/cgroup/system.slice") / unit_name(root)
    require((group / "cgroup.procs").read_text().strip() == "", "delegated parent is occupied")
    own = Path("/proc/self/cgroup").read_text().strip()
    require(own == "0::/system.slice/" + unit_name(root) + "/supervisor", "wrapper outside delegated subgroup")
    controllers = {"cpu", "memory", "pids", "io", "cpuset"}
    require(controllers.issubset((group / "cgroup.controllers").read_text().split()), "missing delegated controllers")
    (group / "cgroup.subtree_control").write_text(" ".join("+" + x for x in sorted(controllers)))
    child = subprocess.Popen([str(BIN / "containerd"), "--config", str(root / "config/containerd.toml")], env=ENV)
    durable(root / "containerd-pid.json", {"pid": child.pid})
    def ready():
        require(child.poll() is None, "private containerd exited")
        return (root / "containerd.sock").exists()
    wait_until(ready, time.monotonic() + 8, "private containerd")
    os.execve(BIN / "dockerd", [str(BIN / "dockerd"), "--config-file=" + str(root / "config/daemon.json")], ENV)


def mount_main(root):
    check_root(root)
    output_dir = Path(read_json(root / "input.json")["output"])
    require(output_dir.is_relative_to(root / "work"), "output directory outside owned work")
    disk = root / "output.ext4"
    loop = command(["/usr/sbin/losetup", "--find", "--show", str(disk)])
    require(re.fullmatch(r"/dev/loop[0-9]+", loop) is not None, "unexpected loop device")
    durable(root / "loop.json", {"device": loop, "backing": str(disk),
                               "inode": disk.stat().st_ino, "output": str(output_dir)})
    command(["/usr/bin/mount", "-t", "ext4", "-o", "nodev,nosuid,noexec", loop, str(output_dir)])
    command(["/usr/bin/mount", "--make-private", str(output_dir)])
    (output_dir / "lost+found").rmdir()
    os.chown(output_dir, 10001, 10001); output_dir.chmod(0o700)
    verify_output_capacity(output_dir, 64 * 1024**2)
    durable(root / "output-mounted.json", {"output": str(output_dir)})


def box(root, cli=None):
    facts = read_json(root / "daemon.json")
    return sandbox.CommandSandbox(cli=cli or docker(root), work_root=root / "work",
        ledger=sandbox.EventLedger(root / "work/events.jsonl"), admitted_images=[IMAGE],
        expected_daemon_id=facts["ID"], expected_daemon_root=str(root / "docker-data"))


class QueuedStart(sandbox.DockerCli):
    def __init__(self, root):
        original = docker(root)
        super().__init__(original.commander, default_timeout=3)
        self.root = root

    def start(self, name, *, timeout=None):
        require(sandbox.CONTAINER_ID_PATTERN.fullmatch(name) is not None, "invalid start ID")
        proof = read_json(self.root / "deadline.json")
        require(time.monotonic() < proof["deadline"], "deadline elapsed before queued request")
        api = read_json(self.root / "daemon.json")["ApiVersion"]
        require(re.fullmatch(r"[0-9]+\.[0-9]+", api) is not None, "invalid API version")
        conn = http.client.HTTPConnection("docker", timeout=max(.1, proof["deadline"] - time.monotonic() + 3))
        conn.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        conn.sock.settimeout(conn.timeout)
        try:
            conn.sock.connect(str(self.root / "docker.sock"))
            conn.request("POST", f"/v{api}/containers/{name}/start", body=b"", headers={"Content-Length": "0"})
            durable(self.root / "start-bytes-sent.json", {"monotonic": time.monotonic(),
                    "containerId": name, "method": "POST", "responseObserved": False})
            response = conn.getresponse()
            return sandbox.CommandResult(("start", name), 0 if response.status == 204 else 1,
                                         "", "HTTP status " + str(response.status))
        except (OSError, http.client.HTTPException):
            return sandbox.CommandResult(("start", name), None, "", "queued response unknown", timed_out=True)
        finally:
            conn.close()


def controller_main(root):
    owner = check_root(root)
    current = box(root, QueuedStart(root) if owner["case"] == "queued-start" else None)
    current.preflight(IMAGE)
    spec = sandbox.ActionSpec(action_id=root.name, action_epoch=1, image=IMAGE,
        command=("python3", "-c", WORKLOAD), input_dir=Path(read_json(root / "input.json")["input"]),
        output_dir=Path(read_json(root / "output-mounted.json")["output"]),
        limits=sandbox.Limits(cpus=.5, wall_seconds=WALL))
    prepared = sandbox.prepare_action(spec, work_root=root / "work")
    deadline = read_json(root / "deadline.json")["deadline"]
    require(time.monotonic() < deadline, "deadline elapsed before create")
    record = current.create(prepared)
    durable(root / "container.json", record)
    if owner["case"] == "queued-start":
        durable(root / "created-ready.json", {"ready": True})
        wait_until(lambda: (root / "daemon-stopped.json").exists(), deadline, "daemon pause")
    require(time.monotonic() < deadline, "deadline elapsed before start")
    try:
        current.start_once(record)
        inspected = current.cli.inspect(record["container_id"])
        require(inspected is not None and inspected.get("Id") == record["container_id"], "started object identity differs")
        host_pid = (inspected.get("State") or {}).get("Pid")
        require(type(host_pid) is int and host_pid > 0, "runtime host PID missing")
        durable(root / "runtime-pid.json", {"pid": host_pid, "containerId": record["container_id"]})
        durable(root / "controller-started.json", {"responseObserved": True})
    except sandbox.ExecutionError:
        durable(root / "controller-start-unknown.json", {"outcome": "unknown"})
        if owner["case"] != "queued-start":
            raise
    # Keep the supervisor observable, but do no Docker polling or deadline kill. PID1 is tested.
    while time.monotonic() < deadline + 4:
        time.sleep(.1)


def output_main(root):
    check_root(root)
    output = Path(read_json(root / "output-mounted.json")["output"])
    result = {}
    for name in ("started", "heartbeat"):
        path = output / name
        try:
            info = path.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_size <= 65536, "invalid synthetic output")
            result[name] = {"bytes": info.st_size, "sha256": digest(path)}
        except FileNotFoundError:
            result[name] = None
    print(json.dumps(result))


def cleanup_mount_main(root):
    check_root(root)
    if (root / "loop.json").exists():
        value = read_json(root / "loop.json")
        require(value["backing"] == str(root / "output.ext4")
                and (root / "output.ext4").stat().st_ino == value["inode"], "output backing identity changed")
        if os.path.ismount(value["output"]):
            command(["/usr/bin/umount", value["output"]])


def inside(root, mnt_fd, net_fd, mode):
    prefix = ["/usr/bin/nsenter", "--mount=/proc/" + str(os.getpid()) + "/fd/" + str(mnt_fd)]
    if net_fd is not None:
        prefix.append("--net=/proc/" + str(os.getpid()) + "/fd/" + str(net_fd))
    return prefix + ["--", "/usr/bin/python3", str(root / "source/deadline_probe.py"), mode, "--root", str(root)]


def run_case(name, case):
    require(os.geteuid() == 0 and sys.platform == "linux", "reviewed Linux root environment required")
    require(NAME.fullmatch(name) is not None and case in CASES, "invalid synthetic case")
    for path in (BASE, BIN, BIN / "gvisor-bin", BASE / "units"):
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                "fixed base directories must be root-owned and not writable by others")
    for entry in BINARY_FILES:
        trusted_file(BIN / entry)
    trusted_file(ARCHIVE)
    require(digest(ARCHIVE) == ARCHIVE_SHA, "offline archive digest differs")
    root = BASE / "units" / name
    root.mkdir(mode=0o700)  # Exclusive: rerun cannot reuse an Action root or reservation.
    for part in ("source", "config", "docker-config", "work"):
        (root / part).mkdir(mode=0o700)
    for source in SOURCES:
        path = Path(__file__).with_name(source)
        trusted_file(path)
        shutil.copyfile(path, root / "source" / source)
        (root / "source" / source).chmod(0o600)
    owner = {"root": str(root), "unit": unit_name(root), "case": case, "archiveSha256": ARCHIVE_SHA,
             "sourceSha256": {name: digest(root / "source" / name) for name in SOURCES},
             "binarySha256": {name: digest(BIN / name) for name in BINARY_FILES}}
    durable(root / "ownership.json", owner)
    unit = owner["unit"]
    require(show(unit).get("LoadState") == "not-found", "unit already exists; never reuse")
    config, containerd = configurations(root)
    durable(root / "config/daemon.json", config)
    (root / "config/containerd.toml").write_text(containerd)
    (root / "config/containerd.toml").chmod(0o600)
    spec = sandbox.build_synthetic_spec(action_id=name, action_epoch=1, image=IMAGE,
        work_root=root / "work", limits=sandbox.Limits(cpus=.5, wall_seconds=WALL))
    durable(root / "input.json", {"input": str(spec.input_dir), "output": str(spec.output_dir)})
    disk = root / "output.ext4"
    with disk.open("xb") as stream:
        stream.truncate(64 * 1024**2); stream.flush(); os.fsync(stream.fileno())
    command(["/usr/sbin/mkfs.ext4", "-q", "-F", "-m", "0", str(disk)])
    controller = None; mnt_fd = net_fd = daemon_fd = None; unit_request_ack = False
    armed = None; owned_group = None; result = {"case": case, "status": "failed", "businessOutcome": "unknown"}
    try:
        durable(root / "unit-start-reserved.json", {"unit": unit, "monotonic": time.monotonic()})
        # Failure/ACK loss remains consumed. The finally block may stop this exact reserved unit.
        command(systemd_argv(root), timeout=10)
        unit_request_ack = True
        def active():
            value = show(unit)
            require(value.get("ActiveState") not in ("failed", "inactive"), "unit stopped before setup")
            return value if value.get("ActiveState") == "active" else None
        value = wait_until(active, time.monotonic() + 5, "native active unit")
        durable(root / "unit-observed.json", value)
        hooks = stop_hooks(unit)
        durable(root / "stop-hooks.json", hooks)
        value.update(hooks)
        deadline = validate_unit(root, value)
        require(deadline - time.monotonic() > 5, "preparation exhausted native budget")
        group = Path("/sys/fs/cgroup") / value["ControlGroup"].lstrip("/")
        owned_group = (group, group.stat().st_ino)
        armed = {"unit": unit, "invocation": value["InvocationID"], "deadline": deadline,
                 "activeMonotonicUs": int(value["ActiveEnterTimestampMonotonic"]), "runtimeSeconds": WALL,
                 "bootId": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
                 "cgroupInode": owned_group[1], "properties": value}
        durable(root / "deadline.json", armed)
        def daemon_ready():
            try:
                facts = docker(root).info()
                return facts
            except sandbox.ExecutionError:
                return None
        facts = wait_until(daemon_ready, deadline - 4, "owned Docker API")
        require(facts["DockerRootDir"] == str(root / "docker-data")
                and facts["Containerd"]["Address"] == str(root / "containerd.sock")
                and facts.get("LiveRestoreEnabled") is False, "private daemon binding differs")
        facts["ApiVersion"] = command([str(BIN / "docker"), "--config", str(root / "docker-config"),
            "--host", "unix://" + str(root / "docker.sock"), "version", "--format", "{{.Server.APIVersion}}"], timeout=3)
        durable(root / "daemon.json", facts)
        pid = int((root / "dockerd.pid").read_text())
        current = show(unit)
        require(current["InvocationID"] == armed["invocation"] and int(current["MainPID"]) == pid,
                "daemon PID is not the original service main process")
        daemon_fd = os.pidfd_open(pid)
        mnt_fd = os.open(f"/proc/{pid}/ns/mnt", os.O_RDONLY)
        net_fd = os.open(f"/proc/{pid}/ns/net", os.O_RDONLY)
        for namespace in ("mnt", "net"):
            require(os.readlink(f"/proc/{pid}/ns/{namespace}") != os.readlink(f"/proc/1/ns/{namespace}"),
                    "private namespace was not established")
        durable(root / "image-load-reserved.json", {"monotonic": time.monotonic()})
        load = docker(root).commander.run(("load", "--input", str(ARCHIVE)),
                                        timeout=max(.1, deadline - time.monotonic() - 4))
        require(load.ok, "single offline image load failed or became unknown")
        # The reviewed OCI archive has an untagged manifest. Name that exact loaded
        # digest locally; preflight then verifies the repository digest independently.
        tagged = docker(root).commander.run(("image", "tag", IMAGE.split("@", 1)[1],
            "python:3.12.13-slim-bookworm"), timeout=max(.1, deadline - time.monotonic() - 4))
        require(tagged.ok, "exact offline manifest tag failed or became unknown")
        box(root).preflight(IMAGE)
        # build_synthetic_spec was already called outside the unit; mount helper must not rebuild it.
        command(inside(root, mnt_fd, net_fd, "mount"), timeout=max(.1, deadline - time.monotonic() - 3))
        require(time.monotonic() < deadline - 2, "preparation left insufficient test budget")
        log = (root / "controller.log").open("xb")
        controller = subprocess.Popen(inside(root, mnt_fd, net_fd, "controller"), env=ENV,
                                      stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        log.close()
        def controller_ok():
            require(controller.poll() is None, "controller failed before test checkpoint")
            return True
        if case == "queued-start":
            wait_until(lambda: controller_ok() and (root / "created-ready.json").exists(), deadline - 1, "created checkpoint")
            signal.pidfd_send_signal(daemon_fd, signal.SIGSTOP)
            durable(root / "daemon-stopped.json", {"monotonic": time.monotonic()})
            wait_until(lambda: controller_ok() and (root / "start-bytes-sent.json").exists(), deadline, "one queued POST")
        else:
            wait_until(lambda: controller_ok() and (root / "controller-started.json").exists(), deadline - 1, "real start response")
            def marker():
                state = json.loads(command(inside(root, mnt_fd, None, "output"), timeout=2))
                return state if state["started"] else None
            wait_until(marker, deadline, "synthetic start marker")
            if case == "controller-gone":
                controller.kill(); controller.wait(timeout=3)
            if case == "daemon-stopped":
                signal.pidfd_send_signal(daemon_fd, signal.SIGSTOP)
                durable(root / "daemon-stopped.json", {"monotonic": time.monotonic()})
        members = cgroup_members(group)
        require(any(x["pid"] == pid for x in members), "private daemon outside unit subtree")
        containerd_pid = read_json(root / "containerd-pid.json")["pid"]
        require(any(x["pid"] == containerd_pid for x in members), "private containerd outside unit subtree")
        if case != "queued-start":
            require({"shim", "sentry", "gofer"}.issubset({x["role"] for x in members}),
                    "shim/Sentry/gofer roles were not all observed in the owned tree")
            require(any(x["pid"] == read_json(root / "runtime-pid.json")["pid"] for x in members),
                    "Docker-reported runtime PID is outside the owned tree")
        result["runtimeMembers"] = members
        # Only observe. Do not call docker kill or systemctl stop until after the verdict.
        def stopped():
            try:
                if group.exists():
                    require(group.stat().st_ino == owned_group[1], "cgroup identity replaced")
                    contents = (group / "cgroup.events").read_text()
                    populated = dict(line.split() for line in contents.splitlines())["populated"]
                    if populated != "0":
                        return None
            except FileNotFoundError:
                pass  # Require the same terminal invocation below before accepting disappearance.
            current = show(unit)
            require(current.get("InvocationID") == armed["invocation"], "unit invocation changed")
            return current if current["ActiveState"] in ("failed", "inactive") else None
        stopped_value = wait_until(stopped, deadline + 5, "native tree cessation")
        observed = time.monotonic()
        require(stopped_value["Result"] == "timeout" and stopped_value["NRestarts"] == "0",
                "unit did not terminate through its native timeout")
        require(not cgroup_members(group), "runtime descendants remain")
        require(controller.poll() is not None or case != "controller-gone", "killed controller survived")
        first = json.loads(command(inside(root, mnt_fd, None, "output"), timeout=2))
        time.sleep(.3)
        second = json.loads(command(inside(root, mnt_fd, None, "output"), timeout=2))
        require(first == second, "synthetic output still changes after native cessation")
        if case == "queued-start":
            require(first["started"] is None, "queued start produced a marker after stopped consumer")
        counters = sandbox.EventLedger(root / "work/events.jsonl").counters(name, 1)
        require(counters.start_attempts == 1, "start reservation count differs")
        result.update(status="passed", nominalDeadline=deadline, stoppedObserved=observed,
            observedStopLatencySeconds=round(observed - deadline, 6), runtimeSeconds=WALL,
            nativeResult=stopped_value["Result"], startAttempts=counters.start_attempts,
            output=first, noResend=True, productionReview="required separately from root")
    except BaseException as error:
        result["failureType"] = type(error).__name__
        result["failure"] = str(error)[:400]
        raise
    finally:
        cleanup = []
        if (root / "unit-start-reserved.json").exists() and not unit_request_ack:
            cleanup.append("native unit creation ACK unknown; preserve reservation and reconcile, never reissue")
        if controller is not None:
            try:
                if controller.poll() is None:
                    os.killpg(controller.pid, signal.SIGKILL)
                controller.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                cleanup.append("controller cleanup incomplete")
        if (root / "unit-start-reserved.json").exists():
            try:
                current = show(unit)
                if armed:
                    require(current.get("InvocationID") in (armed["invocation"], ""), "refuse changed unit cleanup")
                if current.get("ActiveState") not in ("failed", "inactive"):
                    command(["/usr/bin/systemctl", "stop", unit], timeout=5)
                if owned_group:
                    require(not cgroup_members(owned_group[0]), "refuse live-runtime mount cleanup")
                if mnt_fd is not None:
                    command(inside(root, mnt_fd, None, "cleanup-mount"), timeout=5)
            except BaseException as error:
                cleanup.append(type(error).__name__ + ": native/mount cleanup incomplete")
        for fd in (mnt_fd, net_fd, daemon_fd):
            if fd is not None:
                os.close(fd)
        if not cleanup and (root / "loop.json").exists():
            try:
                loop = read_json(root / "loop.json")
                actual = command(["/usr/sbin/losetup", "--list", "--noheadings", "--output", "BACK-FILE", loop["device"]])
                require(actual == loop["backing"] and disk.stat().st_ino == loop["inode"], "loop backing changed")
                command(["/usr/sbin/losetup", "--detach", loop["device"]])
                disk.unlink()
            except BaseException as error:
                cleanup.append(type(error).__name__ + ": exact loop cleanup incomplete")
        elif disk.exists() and not (root / "loop.json").exists():
            # A lost losetup receipt cannot prove that no device was allocated. Keep the small
            # backing file for exact read-only reconciliation; never repeat mount/attach.
            cleanup.append("backing file retained; no durable loop receipt, exact reconciliation required")
        if not cleanup:
            for name in ("docker-data", "docker-exec", "containerd-data", "containerd-state"):
                path = root / name
                try:
                    if path.exists():
                        require(not path.is_symlink(), "refuse symlink runtime root cleanup")
                        shutil.rmtree(path)
                except (OSError, RuntimeError):
                    cleanup.append("exact runtime directory cleanup incomplete: " + name)
            try:
                command(["/usr/bin/systemctl", "reset-failed", unit], timeout=3)
            except RuntimeError:
                pass  # Already garbage-collected is not evidence of execution success.
        result["cleanupProblems"] = cleanup
        if cleanup:
            result["status"] = "failed"
        durable(root / "result.json", result)
        print(json.dumps({k: v for k, v in result.items() if k not in ("runtimeMembers", "failure")}), flush=True)
    require(result["status"] == "passed", "qualification or exact cleanup failed")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("run", "daemon", "mount", "controller", "output", "cleanup-mount"))
    parser.add_argument("--root", type=Path)
    parser.add_argument("--name")
    parser.add_argument("--case", choices=CASES)
    args = parser.parse_args()
    if args.mode == "run":
        require(args.name is not None and args.case is not None and args.root is None, "run requires name/case only")
        run_case(args.name, args.case)
    else:
        require(args.root is not None and args.name is None and args.case is None, "internal mode requires root only")
        {"daemon": daemon_main, "mount": mount_main, "controller": controller_main,
         "output": output_main, "cleanup-mount": cleanup_mount_main}[args.mode](args.root)


if __name__ == "__main__":
    main()
