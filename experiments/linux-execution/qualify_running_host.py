"""Bounded real-host precursor checks; no product authority or host provisioning.

Run as the trusted operator inside an already isolated test daemon's network and
mount namespaces. The explicit root/unit must be disposable and operator-owned.
Only tracked container IDs, loop devices and private mounts are cleaned up.
"""
from __future__ import annotations

import argparse
import dataclasses
import errno
import hashlib
import json
import os
from pathlib import Path
import socketserver
import subprocess
import threading
import time

import sandbox
from output_capacity import verify_output_capacity

IMAGE = "python@sha256:6e13e65c55e33adf203d77ee371cf8bf5d81bd4902ef07565721f46bf44917af"
MIB = 1024 * 1024


def command(arguments: list[str]) -> str:
    return subprocess.check_output(arguments, text=True, timeout=30).strip()


class Canary(socketserver.TCPServer):
    allow_reuse_address = False
    hits = 0


class Handler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        self.server.hits += 1


class LostStartAck(sandbox.DockerCli):
    """Only discard the real CLI response; never synthesize runtime execution."""

    def start(self, name: str, *, timeout: float | None = None) -> sandbox.CommandResult:
        actual = super().start(name, timeout=timeout)
        if not actual.ok:
            raise AssertionError("Real start failed before ACK-loss injection")
        return dataclasses.replace(actual, status=None, stdout="", stderr="", timed_out=True)


def qualify(root: Path, unit: str, prefix: str) -> None:
    assert os.geteuid() == 0 and root.is_absolute() and root.is_dir()
    assert root.stat().st_uid == 0 and root.stat().st_mode & 0o077 == 0
    assert unit.startswith("openbot-qualification-") and unit.endswith(".service")
    assert sandbox.ACTION_ID_PATTERN.fullmatch(prefix)
    pid = int(command(["systemctl", "show", unit, "--property=MainPID", "--value"]))
    for namespace in ("mnt", "net"):
        own = os.readlink(f"/proc/self/ns/{namespace}")
        assert own == os.readlink(f"/proc/{pid}/ns/{namespace}")
        assert own != os.readlink(f"/proc/1/ns/{namespace}")
    facts = json.loads((root / "evidence/daemon.json").read_text())
    work = root / "work"
    commander = sandbox.SubprocessCommander(binary=str(root / "bin/docker"), global_arguments=(
        "--config", str(root / "docker-config"), "--host", "unix://" + str(root / "docker.sock")))
    ledger = sandbox.EventLedger(work / "events.jsonl")

    def box(*, lost_ack: bool = False) -> sandbox.CommandSandbox:
        return sandbox.CommandSandbox(cli=(LostStartAck if lost_ack else sandbox.DockerCli)(commander),
            work_root=work, ledger=ledger, admitted_images=[IMAGE],
            expected_daemon_id=facts["daemon"]["id"], expected_daemon_root=facts["daemon"]["root"])

    regular = box()
    regular.preflight(IMAGE)
    assert regular.cli.info()["Containerd"]["Address"] == str(root / "containerd.sock")
    results = []
    canary = Canary(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=canary.serve_forever, daemon=True)
    thread.start()
    boundary = '''import errno,json,os,pathlib,resource,socket,time
proof={'uid':os.getuid(),'nofile':resource.getrlimit(resource.RLIMIT_NOFILE),
       'interfaces':socket.if_nameindex()}
assert proof['uid']==10001 and proof['nofile']==(256,256)
for name,path in [('root','/forbidden'),('input','/input/forbidden')]:
 try:
  pathlib.Path(path).write_text('forbidden')
  raise AssertionError(name+' was writable')
 except OSError as error:
  assert error.errno in (errno.EROFS,errno.EACCES)
  proof[name+'WriteErrno']=error.errno
for label,address in [('supervisor',('127.0.0.1',CANARY_PORT)),('external',('192.0.2.1',9))]:
 client=socket.socket();client.settimeout(.5)
 try:
  client.connect(address)
  raise AssertionError(label+' network was reachable')
 except OSError as error:proof[label+'ConnectErrno']=error.errno
 finally:client.close()
assert not pathlib.Path('/var/run/docker.sock').exists()
assert not pathlib.Path('/run/containerd/containerd.sock').exists()
pathlib.Path('/output/ready').write_text('ready')
end=time.monotonic()+2
while time.monotonic()<end:pass
pathlib.Path('/output/proof.json').write_text(json.dumps(proof))
'''.replace("CANARY_PORT", str(canary.server_address[1]))
    enospc = '''import errno,json,os,pathlib
count=0
try:
 with open('/output/full','wb',buffering=0) as stream:
  for _ in range(96):count+=stream.write(b'x'*1048576)
  os.fsync(stream.fileno())
 raise AssertionError('Expected bounded output ENOSPC')
except OSError as error:assert error.errno==errno.ENOSPC
size=pathlib.Path('/output/full').stat().st_size
assert 0<size<=67108864
pathlib.Path('/output/full').unlink()
pathlib.Path('/output/proof.json').write_text(json.dumps({'errno':errno.ENOSPC,'writtenBytes':size}))
'''
    sparse = "with open('/output/sparse','wb') as stream:stream.truncate(100*1024**3)"
    ack = "with open('/output/one-effect','xb') as stream:stream.write(b'exactly-once\\n')"
    # RLIMIT_NPROC is measured separately from host cgroup tasks; a mapping is not presumed.
    guest_pids = '''import errno,json,os,pathlib,resource,signal,time
original=resource.getrlimit(resource.RLIMIT_NPROC)
assert original==(512,512)
try:
 resource.setrlimit(resource.RLIMIT_NPROC,(513,513))
 raise AssertionError('Guest widened its admitted hard limit')
except (ValueError,PermissionError):pass
resource.setrlimit(resource.RLIMIT_NPROC,(32,32))
children=[];refused=None
try:
 for _ in range(40):
  try:pid=os.fork()
  except OSError as error:refused=error.errno;break
  if pid==0:
   time.sleep(5);os._exit(0)
  children.append(pid)
finally:
 for pid in children:
  try:os.kill(pid,signal.SIGKILL)
  except ProcessLookupError:pass
 for pid in children:os.waitpid(pid,0)
assert len(children)==31 and refused==errno.EAGAIN
pathlib.Path('/output/proof.json').write_text(json.dumps({'originalNproc':original,'hardLimitIncreaseRefused':True,'requestedNproc':32,'children':len(children),'refusalErrno':refused}))
'''
    try:
        for name, code in (("boundary", boundary), ("enospc", enospc), ("sparse", sparse),
                           ("ack-loss", ack), ("guest-pids", guest_pids)):
            action = prefix + "-" + name
            current = box(lost_ack=name == "ack-loss")
            spec = sandbox.build_synthetic_spec(action_id=action, action_epoch=1, image=IMAGE,
                work_root=work, limits=sandbox.Limits(cpus=.5, wall_seconds=20))
            spec = dataclasses.replace(spec, command=("python3", "-c", code))
            disk = work / (action + ".ext4")
            with disk.open("xb") as stream:
                stream.truncate(64 * MIB); stream.flush(); os.fsync(stream.fileno())
            command(["mkfs.ext4", "-q", "-F", "-m", "0", str(disk)])
            loop = command(["losetup", "--find", "--show", str(disk)])
            assert loop.startswith("/dev/loop")
            record = None
            result = {"case": name}
            try:
                command(["mount", "-t", "ext4", "-o", "nodev,nosuid,noexec", loop, str(spec.output_dir)])
                command(["mount", "--make-private", str(spec.output_dir)])
                (spec.output_dir / "lost+found").rmdir()
                os.chown(spec.output_dir, 10001, 10001); spec.output_dir.chmod(0o700)
                capacity = verify_output_capacity(spec.output_dir, 64 * MIB)
                prepared = sandbox.prepare_action(spec, work_root=work)
                deadline = time.monotonic() + spec.limits.wall_seconds
                record = current.create(prepared)
                try:
                    current.start_once(record)
                    assert name != "ack-loss", "ACK-loss injection must be observable"
                except sandbox.ExecutionError:
                    if name != "ack-loss":
                        raise
                    result["lostRealStartResponse"] = True
                if name == "boundary":
                    group = Path("/sys/fs/cgroup/system.slice") / unit / record["container_id"]
                    result["kernelLimits"] = {field: (group / field).read_text().strip()
                        for field in ("cpu.max", "memory.max", "memory.swap.max", "pids.max")}
                    assert result["kernelLimits"] == {"cpu.max": "50000 100000", "memory.max": str(512*MIB),
                                                      "memory.swap.max": "0", "pids.max": "512"}
                observation = regular.wait_for_exit(prepared, record, deadline_monotonic=deadline)
                assert observation["outcome"] == "exited" and observation["exit_code"] == 0
                result["exitCode"] = 0
                recovered = box().recover(action, 1)
                assert recovered["outcome"] == "exited" and recovered["exit_code"] == 0
                try:
                    box().start_once(record)
                    raise AssertionError("Consumed start slot reopened")
                except sandbox.AlreadyStarted:
                    result["newControllerStartRefused"] = True
                started = time.monotonic()
                collection = regular.collect_output(prepared, {**record, **observation})
                result["collectionSeconds"] = round(time.monotonic() - started, 4)
                if name == "sparse":
                    assert collection["exceeded_admitted_envelope"] and collection["files"] == []
                    assert collection["bytes"] == 100*1024**3 and result["collectionSeconds"] < 2
                    result["sparseRejectedBeforeHashing"] = True
                else:
                    assert not collection["exceeded_admitted_envelope"]
                    result["outputFiles"] = collection["files"]
                if name == "ack-loss":
                    assert (spec.output_dir / "one-effect").read_bytes() == b"exactly-once\n"
                if (spec.output_dir / "proof.json").exists():
                    result["guestProof"] = json.loads((spec.output_dir / "proof.json").read_text())
                result["audit"] = regular.audit(action, 1)
                assert result["audit"]["start_attempts"] == 1 and not result["audit"]["duplicate_execution"]
                assert result["audit"]["docker_restart_count"] == 0
                result["capacityBytes"] = capacity["filesystem_bytes"]
            finally:
                if record:
                    result["cleanup"] = regular.cleanup([record])
                if os.path.ismount(spec.output_dir):
                    command(["umount", str(spec.output_dir)])
                command(["losetup", "-d", loop])
            results.append(result)
            print(json.dumps(result), flush=True)
        assert canary.hits == 0
        evidence = {"status": "passed", "scope": "real isolated command precursor; product admission and hard deadline unqualified",
                    "records": results, "canaryHits": canary.hits,
                    "sourceSha256": {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                                     for name in ("sandbox.py", "output_capacity.py", "qualify_running_host.py")}}
        destination = root / "evidence" / (prefix + ".json")
        destination.write_text(json.dumps(evidence, indent=2)); destination.chmod(0o600)
    finally:
        canary.shutdown(); canary.server_close(); thread.join(timeout=2)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--unit", required=True)
    parser.add_argument("--prefix", required=True)
    args = parser.parse_args()
    qualify(args.root, args.unit, args.prefix)
