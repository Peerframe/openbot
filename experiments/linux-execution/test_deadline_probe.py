"""Pure contract checks and synthetic Unix HTTP; never systemd, Docker or VPS."""
import copy
import json
from pathlib import Path
import socket
import tempfile
import threading
import types
import unittest
from unittest import mock

import deadline_probe as p
import compare_production as production


class ProbeTests(unittest.TestCase):
    def root(self):
        return p.BASE / "units/deadline-fixture"

    def properties(self):
        return {"Type": "exec", "KillMode": "control-group", "KillSignal": "9",
            "FinalKillSignal": "9", "SendSIGKILL": "yes", "Restart": "no", "NRestarts": "0",
            "NotifyAccess": "none", "ExecStop": "", "ExecStopPost": "", "TriggeredBy": "",
            "PrivateNetwork": "yes", "PrivateMounts": "yes", "DelegateSubgroup": "supervisor",
            "MemoryMax": str(2500 * 1024**2), "MemorySwapMax": "0", "TasksMax": "1536",
            "ControlGroup": "/system.slice/" + p.unit_name(self.root()), "RuntimeMaxUSec": "1min",
            "RuntimeRandomizedExtraUSec": "0", "TimeoutStopUSec": "1s", "CPUQuotaPerSecUSec": "1.500000s",
            "ActiveEnterTimestampMonotonic": "100000000", "InvocationID": "a" * 32,
            "ActiveState": "active"}

    def test_config_isolated_and_matches_supplied_snapshotter_profile(self):
        daemon, containerd = p.configurations(self.root())
        self.assertNotIn("storage-driver", daemon)
        self.assertFalse(daemon["live-restore"])
        for key in ("data-root", "exec-root", "pidfile", "containerd"):
            self.assertTrue(daemon[key].startswith(str(self.root()) + "/"))
        self.assertEqual(daemon["runtimes"]["runsc"], {"path": str(p.BIN / "runsc"), "runtimeArgs": ["--platform=systrap"]})
        self.assertIn(str(self.root() / "containerd-state"), containerd)
        self.assertNotIn("/run/containerd/containerd.sock", containerd)
        for key in ("iptables", "ip6tables", "ip-forward", "ip-masq", "userland-proxy"):
            self.assertFalse(daemon[key])

    def test_each_root_gets_distinct_unit_and_daemon_state(self):
        first, _ = p.configurations(self.root())
        other, _ = p.configurations(p.BASE / "units/deadline-other")
        for key in ("data-root", "exec-root", "pidfile", "containerd", "cgroup-parent", "hosts"):
            self.assertNotEqual(first[key], other[key])

    def test_unit_arms_native_expiry_and_immediate_whole_tree_kill(self):
        argv = p.systemd_argv(self.root())
        for argument in ("--service-type=exec", "--property=RuntimeMaxSec=60",
                         "--property=KillSignal=SIGKILL", "--property=KillMode=control-group",
                         "--property=Restart=no", "--property=NotifyAccess=none",
                         "--property=MemoryMax=2500M", "--property=TasksMax=1536"):
            self.assertIn(argument, argv)
        self.assertFalse(any("ExecStop" in arg or "14400" in arg for arg in argv))

    def test_original_unit_timestamp_is_deadline_origin(self):
        self.assertEqual(p.validate_unit(self.root(), self.properties()), 160.0)

    def test_refuses_long_lifetime_stop_grace_or_escaping_cgroup(self):
        for field, value in {"RuntimeMaxUSec": "4h", "TimeoutStopUSec": "45s",
            "KillSignal": "15", "Restart": "always", "ExecStop": "docker kill",
            "ControlGroup": "/system.slice/other.service", "TasksMax": "9999",
            "InvocationID": "", "NotifyAccess": "all", "NRestarts": "1"}.items():
            with self.subTest(field=field):
                values = self.properties(); values[field] = value
                with self.assertRaises(RuntimeError):
                    p.validate_unit(self.root(), values)

    def test_duration_parser_handles_public_formats_and_rejects_infinity(self):
        for text, value in (("0", 0), ("0s", 0), ("1min", 60), ("1.500000s", 1.5), ("250ms", .25)):
            self.assertEqual(p.seconds(text), value)
        for text in ("infinity", "nan", "-1s", "60s trailing"):
            with self.assertRaises(RuntimeError):
                p.seconds(text)

    def test_stop_hooks_require_explicit_typed_empty_arrays(self):
        found = json.dumps({"type": "o", "data": ["/org/freedesktop/systemd1/unit/fixture"]})
        empty = json.dumps({"type": "a(sasbttttuii)", "data": []})
        with mock.patch.object(p, "command", side_effect=[found, empty + "\n" + empty]):
            self.assertEqual(p.stop_hooks("fixture.service"), {"ExecStop": "", "ExecStopPost": ""})
        for raw in (empty, empty + "\n{}", empty + "\n" + json.dumps({
                "type": "a(sasbttttuii)", "data": [["/bin/sleep", ["sleep", "99"]]]})):
            with mock.patch.object(p, "command", side_effect=[found, raw]):
                with self.assertRaises(RuntimeError):
                    p.stop_hooks("fixture.service")

    def test_receipt_exclusive_and_not_replaceable(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "receipt.json"
            p.durable(path, {"attempts": 1})
            with self.assertRaises(FileExistsError):
                p.durable(path, {"attempts": 2})
            self.assertEqual(json.loads(path.read_text()), {"attempts": 1})

    def test_name_and_unix_socket_bound(self):
        for name in ("production", "deadline-../other", "deadline-" + "a" * 48):
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                p.unit_name(p.BASE / "units" / name)

    def test_show_missing_unit_allows_only_explicit_not_found(self):
        answer = p.sandbox.CommandResult(("show",), 1, "LoadState=not-found\n", "")
        fake = mock.Mock(); fake.run.return_value = answer
        with mock.patch.object(p.sandbox, "SubprocessCommander", return_value=fake):
            self.assertEqual(p.show("fixture.service"), {"LoadState": "not-found"})
            fake.run.return_value = p.sandbox.CommandResult(("show",), 1, "", "permission denied")
            with self.assertRaises(RuntimeError): p.show("fixture.service")

    def queued(self, send_response):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            p.durable(root / "deadline.json", {"deadline": p.time.monotonic() + 3})
            p.durable(root / "daemon.json", {"ApiVersion": "1.54"})
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(str(root / "docker.sock")); server.listen(1); server.settimeout(3)
            requests = []; errors = []
            def receive():
                try:
                    client, _ = server.accept()
                    with client:
                        client.settimeout(3); data = b""
                        while b"\r\n\r\n" not in data:
                            data += client.recv(4096)
                        requests.append(data)
                        if send_response:
                            client.sendall(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                except BaseException as error:
                    errors.append(error)
            thread = threading.Thread(target=receive); thread.start()
            try:
                with mock.patch.object(p, "docker", return_value=types.SimpleNamespace(commander=object())):
                    result = p.QueuedStart(root).start("a" * 64)
                thread.join(timeout=4)
                self.assertFalse(thread.is_alive()); self.assertEqual(errors, [])
                self.assertEqual(len(requests), 1)
                self.assertTrue(requests[0].startswith(b"POST /v1.54/containers/" + b"a" * 64 + b"/start HTTP/1.1\r\n"))
                receipt = p.read_json(root / "start-bytes-sent.json")
                self.assertFalse(receipt["responseObserved"])
                return result
            finally:
                server.close(); thread.join(timeout=4)

    def test_single_actual_unix_http_start_has_no_negotiation_request(self):
        self.assertTrue(self.queued(True).ok)

    def test_lost_response_stays_unknown_and_does_not_resend(self):
        self.assertTrue(self.queued(False).uncertain)

    def test_production_comparison_uses_real_supplied_values(self):
        before = {"containers": [{"id": "a" * 64, "startedAt": "2026-09-25T00:00:00Z", "status": "running"}],
                  "firewallSha256": {"iptables": "b" * 64}}
        self.assertTrue(production.compare(before, copy.deepcopy(before))["productionUnchanged"])
        for target, key in (("containers", "startedAt"), ("containers", "status"), ("firewallSha256", "iptables")):
            after = copy.deepcopy(before)
            if target == "containers": after[target][0][key] = "changed"
            else: after[target][key] = "c" * 64
            with self.assertRaises(ValueError): production.compare(before, after)

    def test_empty_or_missing_firewall_proof_refuses(self):
        for snapshot in ({"containers": []}, {"containers": [], "firewallSha256": {}}):
            with self.assertRaises(ValueError): production.compare(snapshot, snapshot)

    def test_workload_is_valid_python_and_uses_exclusive_start_marker(self):
        compile(p.WORKLOAD, "synthetic-workload", "exec")
        self.assertIn("'/output/started','xb'", p.WORKLOAD)

    def cgroup_fixture(self, escaped=False):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name); group = root / "cgroup"; group.mkdir()
        proc = root / "proc"; proc.mkdir()
        (group / "cgroup.procs").write_text("123\n124\n")
        for pid, role in ((123, "boot"), (124, "gofer")):
            process = proc / str(pid); process.mkdir()
            (process / "cgroup").write_text("0::" + ("/outside" if escaped else str(group)) + "\n")
            (process / "comm").write_text("gvisor-bin\n")
            (process / "cmdline").write_bytes(b"gvisor-bin\0" + role.encode() + b"\0")
            (process / "stat").write_text(str(pid) + " (gvisor-bin) " + " ".join(["S"] + ["0"] * 18 + ["12345"]))
        return group, proc

    def test_owned_cgroup_roles_omit_full_process_arguments(self):
        group, proc = self.cgroup_fixture()
        with mock.patch.object(p, "Path", side_effect=lambda x: proc if x == "/proc" else Path(x)):
            values = p.cgroup_members(group)
        self.assertEqual({value["role"] for value in values}, {"sentry", "gofer"})
        self.assertTrue(all("argv" not in value for value in values))
        self.assertEqual(len(values), 2)

    def test_changed_process_cgroup_refuses_observation(self):
        group, proc = self.cgroup_fixture(escaped=True)
        with mock.patch.object(p, "Path", side_effect=lambda x: proc if x == "/proc" else Path(x)):
            with self.assertRaisesRegex(RuntimeError, "escaped"):
                p.cgroup_members(group)


if __name__ == "__main__":
    unittest.main(verbosity=2)
