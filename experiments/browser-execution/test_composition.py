"""Regress the actual pre-start sockaddr_un failure without any remote/native execution."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('composition',HERE/'composition/run.py')
composition=importlib.util.module_from_spec(spec)
spec.loader.exec_module(composition)

class CompositionPaths(unittest.TestCase):
    def test_containerd_store_uses_reviewed_manifest_without_config_alias(self):
        image={'Id':composition.browser.MANIFEST,'Os':'linux','Architecture':'amd64'}
        cli=Mock();cli.image_inspect.return_value=image
        self.assertEqual(composition.loaded_browser_image(cli),image)
        cli.image_inspect.assert_called_once_with(composition.browser.MANIFEST)

    def test_legacy_store_config_identity_is_a_read_only_fallback(self):
        image={'Id':composition.browser.CONFIG,'Os':'linux','Architecture':'amd64'}
        cli=Mock();cli.image_inspect.side_effect=[None,image]
        self.assertEqual(composition.loaded_browser_image(cli),image)
        self.assertEqual(cli.image_inspect.call_count,2)

    def test_other_platform_cannot_substitute_for_the_fixed_archive(self):
        cli=Mock();cli.image_inspect.return_value={'Id':composition.browser.MANIFEST,'Os':'linux','Architecture':'arm64'}
        with self.assertRaisesRegex(RuntimeError,'identity/platform'):
            composition.loaded_browser_image(cli)

    def test_all_actual_native_paths_fit_before_allocation(self):
        actual=composition.browser.host_socket_path_bounds(composition.ROOT)
        observed=composition.browser.validate_socket_path_bounds(actual)
        self.assertTrue(observed)
        self.assertLessEqual(max(item['bytes'] for item in observed.values()),107)

    def test_long_name_reproduces_rejected_libnetwork_path(self):
        original=composition.BASE/'units/deadline-a1-compose1'
        with self.assertRaisesRegex(RuntimeError,'libnetwork_external_key'):
            composition.browser.validate_socket_path_bounds(composition.browser.host_socket_path_bounds(original))

if __name__=='__main__':unittest.main()
