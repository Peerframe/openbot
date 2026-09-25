"""Focused no-runtime observation and frozen-isolation checks."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from test_browser_a1 import a1

HERE = Path(__file__).parent


class CDPCandidate(unittest.TestCase):
    def test_actual_command_duration_and_native_relative_start_are_recorded_once(self):
        class Once:
            calls = 0
            def run(self, argv, *, timeout):
                self.calls += 1
                return a1.sandbox.CommandResult(tuple(argv), 0, "synthetic", "")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "commands").mkdir()
            delegate = Once()
            recorder = a1.RecordingCommander(root, delegate)
            recorder.native_started = 100
            with patch.object(a1.time, "monotonic", side_effect=[105, 105.25]):
                recorder.run(("load", "synthetic"), timeout=10)
            value = json.loads((root / "commands/0001.json").read_text())
            self.assertEqual(value["observation"], {"elapsedMs": 250, "nativeStartElapsedMs": 5000})
            self.assertEqual(value["stdout"], "synthetic")
            self.assertEqual(delegate.calls, 1)

    def test_no_invented_native_origin_before_unit_readback(self):
        class Once:
            def run(self, argv, *, timeout):
                return a1.sandbox.CommandResult(tuple(argv), None, "", "", timed_out=True)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "commands").mkdir()
            recorder = a1.RecordingCommander(root, Once())
            with patch.object(a1.time, "monotonic", side_effect=[10, 10.5]):
                result = recorder.run(("synthetic",), timeout=1)
            self.assertFalse(result.ok)
            value = json.loads((root / "commands/0001.json").read_text())
            self.assertEqual(value["observation"], {"elapsedMs": 500, "nativeStartElapsedMs": None})

    def test_policy_helpers_and_whole_native_budget_are_unchanged(self):
        self.assertEqual(hashlib.sha256((HERE / "seccomp_profile.json").read_bytes()).hexdigest(),
                         "d00ad84f5a67031fe2bb64de8d77a5ad9c06adb82935ebdb3c18b5f7ba60a5d0")
        self.assertEqual(a1.INPUTS["seccomp_profile.json"],
                         "d00ad84f5a67031fe2bb64de8d77a5ad9c06adb82935ebdb3c18b5f7ba60a5d0")
        for name, sha in a1.SOURCES.items():
            self.assertEqual(hashlib.sha256((a1.REVIEWED / name).read_bytes()).hexdigest(), sha)
        self.assertEqual(a1.WALL, 180)
        self.assertIn("remaining(deadline, 85)\n        native.durable(root / \"start-reserved.json\"", (HERE / "browser_a1.py").read_text())
        argv = a1.create_argv(a1.owned_root("deadline-a1-cdp1"), a1.MANIFEST)
        self.assertEqual(argv[argv.index("--cap-drop") + 1], "ALL")
        self.assertNotIn("--cap-add", argv)
        self.assertIn("no-new-privileges=true", argv)
        self.assertEqual(a1.RUNTIME_ARGS, ["--platform=systrap", "--oci-seccomp=true"])


if __name__ == "__main__":
    unittest.main()
