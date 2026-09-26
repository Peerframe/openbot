"""Small real tar/gzip fixtures exercise verification, type safety, bounds and cleanup."""
import hashlib
import io
from pathlib import Path
import stat
import tarfile
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import release_archive


class ReleaseArchiveTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.archive = self.root / 'release.tar.gz'
        self.destination = self.root / 'binaries'
        self.contents = {'temporal-server': b'fixture-server', 'temporal-sql-tool': b'fixture-sql-tool'}

    def regular_entries(self):
        return [(name, data, tarfile.REGTYPE, '') for name, data in self.contents.items()]

    def fixture(self, entries=None):
        with tarfile.open(self.archive, 'w:gz') as archive:
            for name, data, kind, target in self.regular_entries() if entries is None else entries:
                member = tarfile.TarInfo(name)
                member.type, member.linkname = kind, target
                member.size = len(data) if kind == tarfile.REGTYPE else 0
                archive.addfile(member, io.BytesIO(data) if kind == tarfile.REGTYPE else None)
        raw = self.archive.read_bytes()
        pin = {'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(), 'members': {
            name: (len(data), hashlib.sha256(data).hexdigest()) for name, data in self.contents.items()}}
        replacement = patch.dict(release_archive.RELEASES, {'amd64': pin})
        replacement.start()
        self.addCleanup(replacement.stop)
        return pin

    def extract(self):
        return release_archive.extract_release(self.archive, 'amd64', self.destination)

    def rejected(self, message):
        with self.assertRaisesRegex(ValueError, message):
            self.extract()
        self.assertFalse(self.destination.exists(), 'Failed extraction must remove partial output')

    def test_valid_release_extracts_only_exact_binaries_with_read_execute_modes(self):
        self.fixture(self.regular_entries() + [
            ('../outside', b'ignored', tarfile.REGTYPE, ''),
            ('config/development.yaml', b'', tarfile.SYMTYPE, '../../outside'),
            ('other-binary', b'ignored', tarfile.REGTYPE, ''),
        ])
        paths = self.extract()
        self.assertEqual(set(paths), set(self.contents))
        self.assertEqual({p.name for p in self.destination.iterdir()}, set(self.contents))
        self.assertFalse((self.root / 'outside').exists())
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o700)
        for name, path in paths.items():
            self.assertTrue(path.is_absolute())
            self.assertEqual(path.parent, self.destination)
            self.assertEqual(path.read_bytes(), self.contents[name])
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o555)

    def test_bad_archive_digest_is_rejected_before_creating_destination(self):
        pin = self.fixture()
        pin['sha256'] = '0' * 64
        self.rejected('archive SHA-256')

    def test_bad_archive_size_is_rejected(self):
        pin = self.fixture()
        pin['size'] += 1
        self.rejected('archive size')

    def test_bad_binary_digest_removes_already_verified_first_binary(self):
        pin = self.fixture()
        size, _ = pin['members']['temporal-sql-tool']
        pin['members']['temporal-sql-tool'] = (size, '0' * 64)
        self.rejected('binary SHA-256')

    def test_binary_size_mismatch_is_rejected(self):
        pin = self.fixture()
        size, digest = pin['members']['temporal-sql-tool']
        pin['members']['temporal-sql-tool'] = (size + 1, digest)
        self.rejected('binary size')

    def test_symlink_hardlink_and_directory_cannot_supply_binary(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.DIRTYPE):
            with self.subTest(kind=kind):
                self.fixture([self.regular_entries()[0], ('temporal-sql-tool', b'', kind, 'temporal-server')])
                self.rejected('regular release binary')

    def test_duplicate_target_after_both_valid_binaries_is_rejected(self):
        self.fixture(self.regular_entries() + [self.regular_entries()[0]])
        self.rejected('Duplicate')

    def test_duplicate_ignored_member_is_rejected(self):
        extra = ('config/extra', b'ignored', tarfile.REGTYPE, '')
        self.fixture(self.regular_entries() + [extra, extra])
        self.rejected('Duplicate')

    def test_missing_exact_member_is_rejected_without_accepting_path_alias(self):
        entries = self.regular_entries()
        entries[1] = ('./temporal-sql-tool', entries[1][1], tarfile.REGTYPE, '')
        self.fixture(entries)
        self.rejected('missing')

    def test_existing_destination_is_preserved(self):
        self.fixture()
        self.destination.mkdir()
        existing = self.destination / 'keep'
        existing.write_bytes(b'owned-existing-content')
        with self.assertRaises(FileExistsError):
            self.extract()
        self.assertEqual(list(self.destination.iterdir()), [existing])
        self.assertEqual(existing.read_bytes(), b'owned-existing-content')

    def test_symlink_destination_and_archive_are_rejected(self):
        self.fixture()
        target = self.root / 'untouched'
        self.destination.symlink_to(target)
        with self.assertRaises(FileExistsError):
            self.extract()
        self.assertFalse(target.exists())
        self.destination.unlink()
        original = self.root / 'original.tar.gz'
        self.archive.rename(original)
        self.archive.symlink_to(original)
        with self.assertRaises(OSError):
            self.extract()
        self.assertFalse(self.destination.exists())

    def test_expanded_byte_limit_covers_ignored_data(self):
        self.fixture(self.regular_entries() + [('large-ignored', b'x' * 32768, tarfile.REGTYPE, '')])
        with patch.object(release_archive, 'MAX_EXPANDED_BYTES', 16384):
            self.rejected('bound')

    def test_member_count_limit_removes_partial_output(self):
        self.fixture(self.regular_entries() + [('extra', b'x', tarfile.REGTYPE, '')])
        with patch.object(release_archive, 'MAX_MEMBERS', 2):
            self.rejected('member bound')

    def test_gzip_trailer_is_checked_after_tar_end(self):
        pin = self.fixture()
        raw = self.archive.read_bytes()[:-5]
        self.archive.write_bytes(raw)
        pin.update(size=len(raw), sha256=hashlib.sha256(raw).hexdigest())
        with self.assertRaises(EOFError):
            self.extract()
        self.assertFalse(self.destination.exists())

    def test_unknown_architecture_is_rejected_without_output(self):
        self.fixture()
        with self.assertRaisesRegex(ValueError, 'architecture'):
            release_archive.extract_release(self.archive, 'other', self.destination)
        self.assertFalse(self.destination.exists())


if __name__ == '__main__':
    unittest.main()
