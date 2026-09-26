"""Pure command/readback tests. No Docker, systemd, network or application process is invoked."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location("browser_a1", HERE / "browser_a1.py")
a1 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a1)


def fixture(root):
    seccomp = {"defaultAction": "SCMP_ACT_ERRNO", "syscalls": []}
    (root / "input").mkdir()
    (root / "input/seccomp_profile.json").write_text(json.dumps(seccomp))
    image = {"Id": a1.MANIFEST, "Os": "linux", "Architecture": "amd64", "Descriptor": {"digest": a1.MANIFEST},
             "Config": {"Env": ["PATH=/usr/bin:/bin", "LANG=en_US.UTF-8"]}}
    container = {"Id": "a" * 64, "Image": image["Id"], "Name": "/" + root.name,
        "Config": {"User": "1001:1001", "Entrypoint": ["/usr/bin/node"], "Cmd": ["/qualification/probe.mjs"],
            "Image": image["Id"], "Labels": {"openbot.qualification": "browser-A1", "openbot.qualification.root": root.name},
            "Env": ["PATH=/usr/bin:/bin", "HOME=/tmp", "LANG=C.UTF-8"]},
        "HostConfig": {"Runtime": "runsc", "NetworkMode": "none", "IpcMode": "private", "ReadonlyRootfs": True,
            "Privileged": False, "Init": True, "PidsLimit": 1536, "Memory": 1536 * 1024**2,
            "MemorySwap": 1536 * 1024**2, "NanoCpus": 1500000000, "ShmSize": 256 * 1024**2,
            "CapDrop": ["ALL"], "RestartPolicy": {"Name": "no", "MaximumRetryCount": 0},
            "LogConfig": {"Type": "local", "Config": {"max-size": "1m", "max-file": "1", "compress": "false"}},
            "SecurityOpt": ["no-new-privileges", "seccomp=" + json.dumps(seccomp)],
            "Ulimits": [{"Name": "nofile", "Soft": 4096, "Hard": 4096}, {"Name": "nproc", "Soft": 256, "Hard": 256}],
            "Tmpfs": {p: "rw,nosuid,nodev,noexec,size=256m,uid=1001,gid=1001,mode=700" for p in ("/tmp", "/profiles")}},
        "Mounts": [{"Destination": "/qualification", "Source": str(root / "input"), "Type": "bind", "RW": False, "Propagation": "rprivate"}],
        "State": {"Status": "created", "Running": False, "Pid": 0, "StartedAt": "0001-01-01T00:00:00Z"}}
    return image, container


class Construction(unittest.TestCase):
    def test_explicit_runtime_configuration_does_not_change_frozen_helper(self):
        root = a1.owned_root("deadline-a1-test123")
        original, original_containerd = a1.native.configurations(root)
        changed, containerd = a1.configurations(root)
        self.assertEqual(original["runtimes"]["runsc"]["runtimeArgs"], ["--platform=systrap"])
        self.assertEqual(changed["runtimes"]["runsc"]["runtimeArgs"], a1.RUNTIME_ARGS)
        changed["runtimes"]["runsc"]["runtimeArgs"] = original["runtimes"]["runsc"]["runtimeArgs"]
        self.assertEqual(changed, original)
        self.assertEqual(containerd, original_containerd)

    def test_runtime_api_uses_exact_pinned_moby_fields_and_arguments(self):
        runtime = {"path": str(a1.BIN / "runsc"), "runtimeArgs": a1.RUNTIME_ARGS.copy()}
        a1.validate_runtime({"Runtimes": {"runsc": runtime}})
        for value in ({}, {"Path": runtime["path"], "Args": runtime["runtimeArgs"]},
                      {**runtime, "path": "/usr/bin/runsc"}, {**runtime, "runtimeArgs": ["--platform=systrap"]},
                      {**runtime, "runtimeArgs": ["--platform=systrap", "--oci-seccomp=false"]},
                      {**runtime, "runtimeArgs": runtime["runtimeArgs"] + ["--oci-seccomp=false"]}):
            with self.assertRaises(RuntimeError): a1.validate_runtime({"Runtimes": {"runsc": value}})

    def test_sentry_requires_normalized_single_flag_before_boot_and_exact_id(self):
        argv = ["runsc-sandbox", "--platform=systrap", "--oci-seccomp=true", "boot", "--bundle=/owned/bundle", "a" * 64]
        def observed(words): return {"processes": [{"argv": words}], "errors": []}
        a1.validate_runtime_arguments(observed(argv), "a" * 64)
        for changed in (["gvisor-sentry-prewarmer", *argv], argv[:2] + argv[3:],
                        [x.replace("--oci-seccomp=true", "--oci-seccomp=false") for x in argv],
                        argv[:2] + ["--oci-seccomp"] + argv[3:],
                        argv[:3] + ["--oci-seccomp=false"] + argv[3:],
                        argv[:2] + ["boot", "--oci-seccomp=true"] + argv[4:], argv[:-1] + ["b" * 64]):
            with self.assertRaises(RuntimeError): a1.validate_runtime_arguments(observed(changed), "a" * 64)
        with self.assertRaises(RuntimeError): a1.validate_runtime_arguments({"processes": [], "errors": []}, "a" * 64)
        with self.assertRaises(RuntimeError):
            a1.validate_runtime_arguments({"processes": [{"argv": argv}, {"argv": argv}], "errors": []}, "a" * 64)

    def test_proc_observation_only_emits_stable_owned_fixed_binary_arguments(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); binary = root / "bin"; proc = root / "proc"
            (binary / "gvisor-bin").mkdir(parents=True); (proc / "42").mkdir(parents=True)
            for name in ("runsc", "gvisor-bin/gvisor_sentry", "unrelated"): (binary / name).write_bytes(b"synthetic")
            process = proc / "42"; (process / "exe").symlink_to(binary / "gvisor-bin/gvisor_sentry")
            (process / "cgroup").write_text("0::/system.slice/owned/sandbox\n")
            (process / "stat").write_text("42 (name with spaces) " + " ".join(["S"] + ["0"] * 18 + ["99"]))
            (process / "cmdline").write_bytes(b"runsc-sandbox\0--oci-seccomp=true\0boot\0")
            members = [{"pid": 42, "cgroup": "/system.slice/owned/sandbox", "startTicks": "99"}]
            group = Path("/sys/fs/cgroup/system.slice/owned")
            with patch.object(a1, "BIN", binary):
                value = a1.runtime_arguments(group, members, proc=proc)
                self.assertEqual(value["processes"][0]["executable"], "gvisor-bin/gvisor_sentry")
                self.assertEqual(value["processes"][0]["argv"], ["runsc-sandbox", "--oci-seccomp=true", "boot"])
                self.assertEqual(value["errors"], [])
                for changed in ([{**members[0], "startTicks": "98"}], [{**members[0], "cgroup": "/outside"}]):
                    value = a1.runtime_arguments(group, changed, proc=proc)
                    self.assertEqual(value["processes"], []); self.assertTrue(value["errors"])
                (process / "cmdline").write_bytes(b"x" * 16385)
                value = a1.runtime_arguments(group, members, proc=proc)
                self.assertEqual(value["processes"], []); self.assertTrue(value["errors"])
                (process / "exe").unlink(); (process / "exe").symlink_to(binary / "unrelated")
                # A huge/unreadable unrelated command line is never read or emitted.
                value = a1.runtime_arguments(group, members, proc=proc)
                self.assertEqual(value, {"processes": [], "errors": []})

    def test_no_import_side_effect_and_distinct_native_budget(self):
        root = a1.owned_root("deadline-a1-test123")
        argv = a1.systemd_argv(root)
        self.assertIn("--property=RuntimeMaxSec=180", argv)
        self.assertNotIn("--property=RuntimeMaxSec=60", argv)
        self.assertEqual(a1.native.WALL, 60)
        self.assertEqual(a1.native.UNIT_PROPERTIES["RuntimeMaxSec"], "60")
        with tempfile.TemporaryDirectory() as temp:
            here = Path(temp) / "browser-execution"
            here.mkdir()
            sibling = here.parent / "linux-execution"
            sibling.mkdir()
            for name in a1.SOURCES: (sibling / name).touch()
            self.assertEqual(a1.reviewed_directory(here), sibling)
            local = here / "reviewed"
            local.mkdir()
            with self.assertRaises(RuntimeError): a1.reviewed_directory(here)
            for name in a1.SOURCES: (local / name).touch()
            self.assertEqual(a1.reviewed_directory(here), local)
            local.rename(here / "unrelated")
            (sibling / "sandbox.py").unlink()
            with self.assertRaises(RuntimeError): a1.reviewed_directory(here)
        for token in ("--property=KillSignal=SIGKILL", "--property=KillMode=control-group", "--property=Restart=no",
                      "--property=MemoryMax=2500M", "--property=CPUQuota=150%", "--property=TasksMax=1536"):
            self.assertIn(token, argv)
        self.assertEqual(argv[-4:], [str(root / "source/deadline_probe.py"), "daemon", "--root", str(root)])

    def test_create_has_no_start_pull_privilege_or_archive_mount(self):
        root = a1.owned_root("deadline-a1-test123")
        argv = a1.create_argv(root, a1.MANIFEST)
        self.assertEqual(argv[0], "create")
        self.assertEqual(argv[-2:], (a1.MANIFEST, "/qualification/probe.mjs"))
        self.assertIn("--pull=never", argv)
        self.assertEqual(argv[argv.index("--user") + 1], "1001:1001")
        self.assertEqual(argv[argv.index("--runtime") + 1], "runsc")
        self.assertEqual(argv[argv.index("--network") + 1], "none")
        self.assertEqual(argv.count("--mount"), 1)
        self.assertNotIn(str(a1.ARCHIVE), " ".join(argv))
        for forbidden in ("--no-sandbox", "--privileged", "--rm", "start", "unconfined", "SYS_ADMIN", "runc"):
            self.assertNotIn(forbidden, argv)
        with self.assertRaises(RuntimeError):
            a1.create_argv(root, "python:latest")

    def test_root_names_are_exact_and_confined(self):
        for name in ("../production", "deadline-a1-", "deadline-other", "deadline-a1-" + "x" * 13, "deadline-a1-a;b"):
            with self.assertRaises(RuntimeError): a1.owned_root(name)

    def test_image_pins_are_not_interchangeable_with_unreviewed_ids(self):
        for image_id in (a1.MANIFEST, a1.CONFIG):
            self.assertEqual(a1.validate_image({"Id": image_id, "Architecture": "amd64", "Os": "linux"}), image_id)
        for data in ({"Id": "sha256:" + "0" * 64, "Architecture": "amd64", "Os": "linux"},
                     {"Id": a1.MANIFEST, "Architecture": "arm64", "Os": "linux"},
                     {"Id": a1.MANIFEST, "Architecture": "amd64", "Os": "linux", "Descriptor": {"digest": a1.CONFIG}}):
            with self.assertRaises(RuntimeError): a1.validate_image(data)

    def test_container_exact_shape_and_downgrades(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image, original = fixture(root)
            self.assertEqual(a1.validate_container(root, image, original, created=True), "a" * 64)
            for key, value in (("Runtime", "runc"), ("Privileged", True), ("Init", 1), ("Memory", "1610612736"),
                               ("NetworkMode", "host"), ("MemorySwap", -1), ("PidsLimit", 0), ("CapAdd", ["SYS_ADMIN"]),
                               ("SecurityOpt", ["no-new-privileges", "seccomp=unconfined"]), ("PortBindings", {"80/tcp": [{}]})):
                changed = copy.deepcopy(original); changed["HostConfig"][key] = value
                with self.assertRaises((RuntimeError, ValueError), msg=key):
                    a1.validate_container(root, image, changed, created=True)
            for section, key, value in (("Config", "User", "0:0"), ("Config", "Cmd", ["/bin/sh"]),
                                        ("Config", "Env", ["HOME=/tmp", "API_KEY=bad"]), ("State", "Status", "exited")):
                changed = copy.deepcopy(original); changed[section][key] = value
                with self.assertRaises(RuntimeError, msg=key): a1.validate_container(root, image, changed, created=True)
            changed = copy.deepcopy(original); changed["Mounts"].append({"Destination": "/host", "Type": "bind"})
            with self.assertRaises(RuntimeError): a1.validate_container(root, image, changed, created=True)

    def test_unknown_result_retains_both_streams_and_is_not_success(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / "commands").mkdir()
            class Fake:
                def run(self, argv, *, timeout):
                    return a1.sandbox.CommandResult(tuple(argv), None, "actual stdout", "actual stderr", timed_out=True)
            recorded = a1.RecordingCommander(root, Fake()).run(("start", "a" * 64), timeout=1)
            self.assertFalse(recorded.ok)
            record = json.loads((root / "commands/0001.json").read_text())
            self.assertEqual(record["stdout"], "actual stdout")
            self.assertEqual(record["stderr"], "actual stderr")
            self.assertTrue(record["timed_out"])

    def test_expired_budget_never_becomes_a_fresh_timeout(self):
        with patch.object(a1.time, "monotonic", return_value=100):
            self.assertEqual(a1.remaining(110, 2), 8)
            with self.assertRaises(RuntimeError): a1.remaining(100)
            with self.assertRaises(RuntimeError): a1.remaining(110, 11)


    def test_typed_native_readback_requires_the_new_180_second_budget(self):
        root = a1.owned_root("deadline-a1-test123")
        value = {"Type": "exec", "KillMode": "control-group", "KillSignal": "9", "FinalKillSignal": "9",
            "SendSIGKILL": "yes", "Restart": "no", "NRestarts": "0", "NotifyAccess": "none", "ExecStop": "",
            "ExecStopPost": "", "TriggeredBy": "", "PrivateNetwork": "yes", "PrivateMounts": "yes",
            "DelegateSubgroup": "supervisor", "MemoryMax": str(2500 * 1024**2), "MemorySwapMax": "0",
            "TasksMax": "1536", "ControlGroup": "/system.slice/" + a1.native.unit_name(root),
            "RuntimeMaxUSec": "3min", "RuntimeRandomizedExtraUSec": "0", "TimeoutStopUSec": "1s",
            "CPUQuotaPerSecUSec": "1.500000s", "InvocationID": "a" * 32, "ActiveState": "active",
            "ActiveEnterTimestampMonotonic": "1000000"}
        self.assertEqual(a1.validate_unit(root, value), 181)
        for key, other in (("RuntimeMaxUSec", "1min"), ("Restart", "on-failure"), ("KillMode", "process"),
                           ("InvocationID", ""), ("ActiveState", "failed")):
            changed = {**value, key: other}
            with self.assertRaises(RuntimeError): a1.validate_unit(root, changed)

    def test_reviewed_files_and_frozen_inputs_match(self):
        for name, digest in a1.SOURCES.items():
            self.assertEqual(a1.native.digest(a1.REVIEWED / name), digest)
        packet = HERE
        for name, digest in a1.INPUTS.items(): self.assertEqual(a1.native.digest(packet / name), digest)


if __name__ == "__main__": unittest.main()
