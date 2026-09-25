"""Pure source-derived path-budget regressions; no network, socket, daemon or systemd call."""
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import browser_a1 as a1


class SocketPaths(unittest.TestCase):
    def test_original_real_failure_and_proposed_name(self):
        old = a1.owned_root('deadline-a1-0925a1r1')
        self.assertEqual(len(bytes(a1.host_socket_path_bounds(old)['libnetwork_external_key'])), 108)
        with self.assertRaisesRegex(RuntimeError, 'libnetwork_external_key'):
            a1.validate_socket_path_bounds(a1.host_socket_path_bounds(old))
        new = a1.owned_root('deadline-a1-r2')
        bounds = a1.validate_socket_path_bounds(a1.host_socket_path_bounds(new))
        self.assertEqual(bounds['libnetwork_external_key']['bytes'], 102)
        self.assertEqual(bounds['runsc_control_bind_proc_alias_bound']['bytes'], 106)
        self.assertTrue(all(v['bytes'] <= 107 for v in bounds.values()))

    def test_linux_exact_boundary_and_unicode_byte_budget(self):
        a1.validate_socket_path_bounds({'exact': Path('/' + 'x' * 106)})
        for path in (Path('/' + 'x' * 107), Path('/' + '你' * 36), Path('relative.sock'), Path('/nul\0.sock')):
            with self.assertRaises(RuntimeError):
                a1.validate_socket_path_bounds({'bad': path})
        a1.validate_socket_path_bounds({'unicode': Path('/' + '你' * 35)})

    def test_full_configuration_paths_and_dynamic_widths(self):
        root = a1.owned_root('deadline-a1-r2')
        paths = a1.host_socket_path_bounds(root)
        daemon, config = a1.configurations(root)
        self.assertEqual(daemon['hosts'], ['unix://' + str(paths['docker_api'])])
        self.assertEqual(daemon['containerd'], str(paths['containerd_grpc']))
        self.assertIn('address = "' + str(paths['containerd_grpc']) + '"', config)
        self.assertEqual(str(paths['containerd_ttrpc']), str(paths['containerd_grpc']) + '.ttrpc')
        self.assertEqual(paths['libnetwork_external_key'].name, 'f' * 12 + '.sock')
        self.assertEqual(paths['containerd_shim_ttrpc'].name, 'f' * 64)
        proc = paths['runsc_control_bind_proc_alias_bound']
        self.assertEqual(proc.parts[2:5], ('2147483647', 'fd', '2147483647'))
        self.assertEqual(proc.name, 'runsc-' + 'f' * 64 + '.sock')
        self.assertEqual(a1.RUNTIME_ARGS, ['--platform=systrap', '--oci-seccomp=true'])

    def test_rejection_precedes_any_root_or_unit_mutation(self):
        with patch.object(a1.os, 'geteuid', return_value=0), patch.object(a1.sys, 'platform', 'linux'), \
             patch.object(a1.os, 'uname', return_value=SimpleNamespace(machine='x86_64')), \
             patch.object(Path, 'mkdir', side_effect=AssertionError('no mkdir')) as mkdir, \
             patch.object(a1, 'host', side_effect=AssertionError('no command')) as host, \
             patch.object(a1.native, 'trusted_file', side_effect=AssertionError('no trusted-file read')) as trusted:
            with self.assertRaisesRegex(RuntimeError, 'libnetwork_external_key'):
                a1.run('deadline-a1-0925a1r1', Path('/synthetic-inputs'))
            mkdir.assert_not_called(); host.assert_not_called(); trusted.assert_not_called()

    def test_every_inventory_path_has_the_same_limit(self):
        original = a1.host_socket_path_bounds(a1.owned_root('deadline-a1-r2'))
        for label in original:
            changed = {**original, label: Path('/' + 'x' * 107)}
            with self.assertRaisesRegex(RuntimeError, label):
                a1.validate_socket_path_bounds(changed)


if __name__ == '__main__':
    unittest.main()
