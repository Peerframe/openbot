"""Kernel-observation counterexamples; injected ext4 facts are not real mount evidence."""

from contextlib import ExitStack
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest import mock

import output_capacity as capacity

READ_KERNEL_TEXT = capacity._read_text


class OutputCapacityTest(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.output = self.root / "output space"
        self.output.mkdir()
        self.identity = self.output.stat()
        self.device = f"{os.major(self.identity.st_dev)}:{os.minor(self.identity.st_dev)}"
        self.limit = 64 * 1024 * 1024
        self.sectors = str(self.limit // 512)
        self.filesystem = "ext4"
        self.mount_root = "/"
        self.mountpoint = self.output
        self.options = "rw,nodev,nosuid,noexec"
        self.propagation = ""
        self.super_options = "rw"
        self.nested = ""
        self.stats = SimpleNamespace(f_blocks=8192, f_frsize=4096, f_flag=0,
                                     f_bfree=1, f_bavail=1)
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(capacity.sys, "platform", "linux"))
        self.reader = self.stack.enter_context(mock.patch.object(capacity, "_read_text",
                                                                side_effect=self.read_kernel))
        self.stack.enter_context(mock.patch.object(capacity.os, "fstatvfs", return_value=self.stats))

    def mountinfo(self) -> str:
        point = str(self.mountpoint).replace("\\", "\\134").replace(" ", "\\040")
        return (f"42 1 {self.device} {self.mount_root} {point} {self.options} "
                f"{self.propagation} - {self.filesystem} /dev/loop0 {self.super_options}\n"
                + self.nested)

    def read_kernel(self, path: Path, limit: int = 1024 * 1024) -> str:
        if str(path).startswith("/proc/self/fdinfo/"):
            return "mnt_id:\t42\n"
        if path == Path("/proc/self/mountinfo"):
            return self.mountinfo()
        if path == Path(f"/sys/dev/block/{self.device}/size"):
            return self.sectors
        raise AssertionError(f"unexpected kernel read: {path}")

    def verify(self) -> dict:
        return capacity.verify_output_capacity(self.output, self.limit)

    def test_bounded_dedicated_ext4_and_escaped_path_are_observed(self) -> None:
        observed = self.verify()
        self.assertEqual(observed["path"], str(self.output))
        self.assertEqual(observed["device_bytes"], self.limit)
        self.assertEqual(observed["filesystem_bytes"], 32 * 1024 * 1024)
        self.assertEqual(observed["inode"], self.identity.st_ino)

    def test_low_free_space_does_not_make_a_large_device_bounded(self) -> None:
        self.sectors = str(1024 ** 4 // 512)
        with self.assertRaisesRegex(capacity.OutputCapacityRefused, "total output device"):
            self.verify()

    def test_ordinary_directory_and_bind_subtree_are_refused(self) -> None:
        for point, root in ((self.root, "/"), (self.output, "/subtree")):
            with self.subTest(point=point, root=root):
                self.mountpoint, self.mount_root = point, root
                with self.assertRaisesRegex(capacity.OutputCapacityRefused, "dedicated filesystem"):
                    self.verify()

    def test_volatile_overlay_and_network_filesystems_are_refused(self) -> None:
        for filesystem in ("tmpfs", "overlay", "nfs", "fuse"):
            with self.subTest(filesystem=filesystem):
                self.filesystem = filesystem
                with self.assertRaisesRegex(capacity.OutputCapacityRefused, "persistent ext4"):
                    self.verify()

    def test_unsafe_mount_options_and_propagation_are_refused(self) -> None:
        for options, propagation in (("rw,nodev,nosuid", ""), ("ro,nodev,nosuid,noexec", ""),
                                      ("rw,nodev,nosuid,noexec", "shared:3"),
                                      ("rw,nodev,nosuid,noexec", "master:3")):
            with self.subTest(options=options, propagation=propagation):
                self.options, self.propagation = options, propagation
                with self.assertRaises(capacity.OutputCapacityRefused):
                    self.verify()

    def test_nested_mount_cannot_bypass_capacity(self) -> None:
        child = str(self.output / "nested").replace(" ", "\\040")
        self.nested = f"43 42 0:1 / {child} rw - tmpfs tmpfs rw\n"
        with self.assertRaisesRegex(capacity.OutputCapacityRefused, "nested output mounts"):
            self.verify()

    def test_missing_or_ambiguous_descriptor_mount_identity_is_refused(self) -> None:
        for fdinfo in ("", "mnt_id: 1\n", "mnt_id: 42\nmnt_id: 42\n", "mnt_id: bad\n"):
            with self.subTest(fdinfo=fdinfo):
                self.reader.side_effect = lambda path, limit=0: (
                    fdinfo if str(path).startswith("/proc/self/fdinfo/") else self.read_kernel(path))
                with self.assertRaises(capacity.OutputCapacityRefused):
                    self.verify()

    def test_mount_device_must_match_open_directory(self) -> None:
        self.device = "8:999"
        with self.assertRaisesRegex(capacity.OutputCapacityRefused, "device disagree"):
            self.verify()

    def test_another_mount_of_the_same_device_is_refused(self) -> None:
        self.nested = f"43 1 {self.device} / /other-action rw - ext4 /dev/loop0 rw\n"
        with self.assertRaisesRegex(capacity.OutputCapacityRefused, "another mount"):
            self.verify()

    def test_kernel_io_errors_fail_closed(self) -> None:
        self.reader.side_effect = PermissionError("kernel facts unavailable")
        with self.assertRaisesRegex(capacity.OutputCapacityRefused, "could not be verified"):
            self.verify()

    def test_invalid_or_inconsistent_capacity_is_refused(self) -> None:
        for sectors in ("-1", "0", "bad", "1"):
            with self.subTest(sectors=sectors):
                self.sectors = sectors
                with self.assertRaises(capacity.OutputCapacityRefused):
                    self.verify()

    def test_read_only_superblock_is_refused(self) -> None:
        self.stats.f_flag = os.ST_RDONLY
        with self.assertRaisesRegex(capacity.OutputCapacityRefused, "read-only"):
            self.verify()

    def test_symlink_source_is_refused(self) -> None:
        link = self.root / "link"
        link.symlink_to(self.output, target_is_directory=True)
        with self.assertRaisesRegex(capacity.OutputCapacityRefused, "no symlinks"):
            capacity.verify_output_capacity(link, self.limit)

    def test_mount_topology_change_during_observation_is_refused(self) -> None:
        reads = 0

        def changed(path, limit=0):
            nonlocal reads
            value = self.read_kernel(path)
            if path == Path("/proc/self/mountinfo"):
                reads += 1
                if reads == 2:
                    value += "43 1 0:1 / /other rw - tmpfs tmpfs rw\n"
            return value

        self.reader.side_effect = changed
        with self.assertRaisesRegex(capacity.OutputCapacityRefused, "topology changed"):
            self.verify()

    def test_non_linux_and_invalid_limits_refuse_without_kernel_reads(self) -> None:
        with mock.patch.object(capacity.sys, "platform", "darwin"):
            with self.assertRaises(capacity.OutputCapacityRefused):
                self.verify()
        for value in (True, 0, -1, 1.5, self.limit + 1):
            with self.subTest(value=value):
                with self.assertRaises(capacity.OutputCapacityRefused):
                    capacity.verify_output_capacity(self.output, value)
        self.reader.assert_not_called()

    def test_kernel_capture_is_bounded(self) -> None:
        path = self.root / "capture"
        path.write_text("x" * 9)
        with self.assertRaisesRegex(capacity.OutputCapacityRefused, "capture limit"):
            READ_KERNEL_TEXT(path, limit=8)


if __name__ == "__main__":
    unittest.main()
