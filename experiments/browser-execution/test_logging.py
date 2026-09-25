"""Pure logging contract regressions; no daemon, unit, container or socket is started."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from test_browser_a1 import a1, fixture


class Logging(unittest.TestCase):
    def test_one_file_explicitly_disables_compression_without_widening_retention(self):
        argv = a1.create_argv(a1.owned_root("deadline-a1-r3"), a1.MANIFEST)
        options = [argv[i + 1] for i, value in enumerate(argv) if value == "--log-opt"]
        self.assertEqual(options, ["max-size=1m", "max-file=1", "compress=false"])
        self.assertEqual(argv.count("--log-driver"), 1)
        self.assertEqual(argv[argv.index("--log-driver") + 1], "local")

    def test_readback_rejects_implicit_enabled_typed_or_extra_compression_options(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image, original = fixture(root)
            good = original["HostConfig"]["LogConfig"]["Config"]
            a1.validate_container(root, image, original, created=True)
            bad = [{k: v for k, v in good.items() if k != "compress"},
                   {**good, "compress": "true"}, {**good, "compress": False},
                   {**good, "compress": "0"}, {**good, "max-file": "2"},
                   {**good, "max-file": 1}, {**good, "max-size": "2m"},
                   {**good, "max-size": "1048576"}, {**good, "mode": "non-blocking"}]
            for options in bad:
                with self.subTest(options=options):
                    changed = copy.deepcopy(original)
                    changed["HostConfig"]["LogConfig"]["Config"] = options
                    with self.assertRaises(RuntimeError):
                        a1.validate_container(root, image, changed, created=True)

    def test_all_other_create_arguments_and_daemon_helpers_stay_identical_to_v3(self):
        baseline = Path(__file__).parent / "fixtures/v3-construction.json"
        self.assertEqual(hashlib.sha256(baseline.read_bytes()).hexdigest(),
                         "7a917941604c293eec6d4887cdcefbd9a4fda06c3225a43760a69d7d931d22eb")
        prior = json.loads(baseline.read_text())
        self.assertEqual(prior["provenance"]["sourceSha256"],
                         "b63b641f2b5ae3dfb1692a131241234a9d790a58dfa62ddc544447df3958392a")
        root = a1.owned_root("deadline-a1-r3")
        actual = list(a1.create_argv(root, a1.MANIFEST))
        index = actual.index("compress=false")
        self.assertEqual(actual[index - 1], "--log-opt")
        del actual[index - 1:index + 1]
        self.assertEqual(actual, prior["createArgv"])
        self.assertEqual(list(a1.configurations(root)), prior["configurations"])
        self.assertEqual(a1.systemd_argv(root), prior["systemdArgv"])
        for name, expected in a1.SOURCES.items():
            self.assertEqual(hashlib.sha256((a1.REVIEWED / name).read_bytes()).hexdigest(), expected)

    def test_current_native_adapter_explicitly_retains_two_file_policy(self):
        for capture_kib in (1, 16, 128, 256):
            size, count = a1.sandbox._docker_log_options(a1.sandbox.Limits(captured_output_kib=capture_kib))
            self.assertEqual(count, 2)
            self.assertEqual(size, max(8, (capture_kib + 1) // 2))


if __name__ == "__main__":
    unittest.main()
