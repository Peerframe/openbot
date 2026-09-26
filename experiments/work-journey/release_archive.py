"""Extract two pinned official Temporal 1.31.3 binaries for an owned upgrade fixture."""
from contextlib import suppress
import gzip
import hashlib
import os
from pathlib import Path
import stat
import tarfile

# Official release checksums and inspected regular-member hashes; see the upgrade research.
RELEASES = {
    'amd64': {
        'size': 93822307,
        'sha256': 'f2c3bf9f1115b506259e5972a62c38257296c043e15798358c3fb758625b96b8',
        'members': {
            'temporal-server': (131518626, '1277e5188925d0343d54d42dac697af370739bca6453cd18d0c894aa497c906e'),
            'temporal-sql-tool': (38658210, '5e025abb70ca29a4ada125eb73c2004c73b360997894f3614f5c0ef861dc853d'),
        },
    },
    'arm64': {
        'size': 85585324,
        'sha256': '9771a7930e2503e77510714d83b5e20f589ee846d270d4b352e1ee3fd487ed08',
        'members': {
            'temporal-server': (123011234, 'e2d9ae19ff7d5761ab64ca43a57b0c66c2ef44b2c190d5997f2f3a1de843d829'),
            'temporal-sql-tool': (36962466, 'e55bc47580a0d2e0ac01b4c60e774b8de88f808826d86b1d115c733f9f49c221'),
        },
    },
}
NAMES = ('temporal-server', 'temporal-sql-tool')
CHUNK_BYTES = 1024 * 1024
MAX_EXPANDED_BYTES = 512 * 1024 * 1024
MAX_MEMBERS = 128


class _BoundedReader:
    def __init__(self, stream, limit):
        self.stream, self.remaining = stream, limit

    def read(self, size=-1):
        # Check one byte beyond the allowance without an unbounded allocation, including EOF
        # checks after the exact limit. Both compressed input and expanded tar bytes are bounded.
        count = min(CHUNK_BYTES, self.remaining + 1)
        if size >= 0:
            count = min(count, size)
        data = self.stream.read(count)
        self.remaining -= len(data)
        if self.remaining < 0:
            raise ValueError('Release archive exceeds its byte bound')
        return data


def _verify_archive(stream, release):
    info = os.fstat(stream.fileno())
    if not stat.S_ISREG(info.st_mode) or info.st_size != release['size']:
        raise ValueError('Release archive size or file type differs from the pin')
    digest = hashlib.sha256()
    reader = _BoundedReader(stream, release['size'])
    while data := reader.read(CHUNK_BYTES):
        digest.update(data)
    if reader.remaining or digest.hexdigest() != release['sha256']:
        raise ValueError('Release archive SHA-256 differs from the pin')
    stream.seek(0)


def _extract_members(stream, release, directory_fd, created):
    seen, extracted = set(), set()
    compressed = _BoundedReader(stream, release['size'])
    with gzip.GzipFile(fileobj=compressed, mode='rb') as uncompressed:
        expanded = _BoundedReader(uncompressed, MAX_EXPANDED_BYTES)
        with tarfile.open(fileobj=expanded, mode='r|') as archive:
            for member in archive:
                if member.name in seen:
                    raise ValueError('Duplicate release archive member')
                seen.add(member.name)
                if len(seen) > MAX_MEMBERS or not 0 <= member.size <= MAX_EXPANDED_BYTES:
                    raise ValueError('Release archive exceeds its member bound')
                if member.name not in NAMES:
                    continue
                # isfile() also accepts some GNU special types. Permit only ordinary files,
                # never tarfile's link resolution or sparse-member reconstruction.
                if member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE) or member.sparse is not None:
                    raise ValueError('Expected a regular release binary member')
                expected_size, expected_hash = release['members'][member.name]
                if member.size != expected_size:
                    raise ValueError('Release binary size differs from the pin')
                fd = os.open(member.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=directory_fd)
                created.append(member.name)
                with os.fdopen(fd, 'wb') as output, archive.extractfile(member) as source:
                    digest, size = hashlib.sha256(), 0
                    while data := source.read(CHUNK_BYTES):
                        size += len(data)
                        if size > expected_size:
                            raise ValueError('Release binary exceeds its byte bound')
                        digest.update(data)
                        output.write(data)
                    if size != expected_size or digest.hexdigest() != expected_hash:
                        raise ValueError('Release binary SHA-256 differs from the pin')
                    output.flush()
                    os.fchmod(output.fileno(), 0o555)
                extracted.add(member.name)
        # Consume the gzip trailer and any remaining expanded bytes under the same bound.
        while expanded.read(CHUNK_BYTES):
            pass
    if extracted != set(NAMES):
        raise ValueError('Required release binaries are missing')


def extract_release(archive: Path, arch: str, destination: Path) -> dict[str, Path]:
    """Verify the pinned release and populate a new private directory, removing partial output."""
    if arch not in ('amd64', 'arm64'):
        raise ValueError('Expected amd64 or arm64 release architecture')
    release = RELEASES[arch]
    destination = Path(destination).absolute()
    if destination.exists() or destination.is_symlink():
        raise FileExistsError('Release destination must not exist')
    # Keep the verified input handle for extraction; a replaced path cannot substitute bytes.
    fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        _verify_archive(stream, release)
        destination.mkdir(mode=0o700)
        directory_fd, created = None, []
        try:
            directory_fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            _extract_members(stream, release, directory_fd, created)
        except BaseException:
            if directory_fd is not None:
                for name in created:
                    with suppress(FileNotFoundError):
                        os.unlink(name, dir_fd=directory_fd)
            with suppress(FileNotFoundError):
                destination.rmdir()
            raise
        finally:
            if directory_fd is not None:
                os.close(directory_fd)
    return {name: destination / name for name in NAMES}
