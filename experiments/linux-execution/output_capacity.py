"""Read-only prerequisite for a host-provisioned, bounded ext4 output filesystem.

This is not a quota provisioner, authority check, or proof of the Docker mount namespace.
See OUTPUT_CAPACITY_REVIEW.md for the trusted-host and qualification limits.
"""

import os
from pathlib import Path
import re
import sys
from typing import Any


class OutputCapacityRefused(RuntimeError):
    """The host cannot demonstrate the required persistent output capacity."""


def _read_text(path: Path, limit: int = 1024 * 1024) -> str:
    with path.open("r", encoding="utf-8", errors="strict") as handle:
        value = handle.read(limit + 1)
    if len(value) > limit:
        raise OutputCapacityRefused("kernel filesystem observation exceeded its capture limit")
    return value


def _unescape(value: str) -> str:
    # mountinfo escapes whitespace and backslashes even though they are legal path characters.
    return re.sub(r"\\(040|011|012|134)", lambda match: chr(int(match[1], 8)), value)


def _mounts(text: str) -> list[dict[str, Any]]:
    entries = []
    for line in text.splitlines():
        before, separator, after = line.partition(" - ")
        left, right = before.split(), after.split()
        if not separator or len(left) < 6 or len(right) != 3:
            raise OutputCapacityRefused("malformed kernel mountinfo")
        entries.append({
            "id": int(left[0]), "device": left[2], "root": _unescape(left[3]),
            "path": Path(_unescape(left[4])), "options": set(left[5].split(",")),
            "propagation": left[6:], "filesystem": right[0],
            "super_options": set(right[2].split(",")),
        })
    return entries


def _mount_id(fd: int) -> int:
    fields = [line.split(":", 1)[1].strip()
              for line in _read_text(Path(f"/proc/self/fdinfo/{fd}"), 4096).splitlines()
              if line.startswith("mnt_id:")]
    if len(fields) != 1:
        raise OutputCapacityRefused("descriptor mount identity is unavailable or ambiguous")
    return int(fields[0])


def verify_output_capacity(directory: Path, limit_bytes: int) -> dict[str, Any]:
    """Observe a dedicated small block device; reject free-space and ordinary-directory claims.

    The open directory descriptor binds fstatvfs, st_dev and fdinfo to the same mount. Both the
    device's complete size (including filesystem overhead) and the filesystem's data capacity
    must fit the admitted limit. No mount, resize, disk write or external command occurs here.
    """
    if sys.platform != "linux":
        raise OutputCapacityRefused("output capacity requires Linux kernel mount/device facts")
    if type(limit_bytes) is not int or not 0 < limit_bytes <= 64 * 1024 * 1024:
        raise OutputCapacityRefused("output capacity limit must be an integer within 64 MiB")
    fd = None
    try:
        path = Path(directory)
        if not path.is_absolute() or path.resolve(strict=True) != path:
            raise OutputCapacityRefused("output path must be absolute and contain no symlinks")
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        identity = os.fstat(fd)
        mount_id = _mount_id(fd)
        mountinfo = _read_text(Path("/proc/self/mountinfo"))
        mounts = _mounts(mountinfo)
        matches = [mount for mount in mounts if mount["id"] == mount_id]
        if len(matches) != 1:
            raise OutputCapacityRefused("output mount identity is unavailable or ambiguous")
        mount = matches[0]
        if mount["path"] != path or mount["root"] != "/":
            raise OutputCapacityRefused("output must be the root of its own dedicated filesystem")
        if mount["filesystem"] != "ext4":
            raise OutputCapacityRefused("output filesystem must be persistent ext4; tmpfs/overlay are refused")
        required = {"rw", "nodev", "nosuid", "noexec"}
        if not required <= mount["options"] or "ro" in mount["super_options"]:
            raise OutputCapacityRefused("output mount must be writable with nodev,nosuid,noexec")
        if any(field.startswith(("shared:", "master:", "propagate_from:"))
               for field in mount["propagation"]):
            raise OutputCapacityRefused("output mount propagation must be private")
        if any(path in entry["path"].parents for entry in mounts):
            raise OutputCapacityRefused("nested output mounts can bypass the capacity bound")
        device = f"{os.major(identity.st_dev)}:{os.minor(identity.st_dev)}"
        if mount["device"] != device:
            raise OutputCapacityRefused("output descriptor and mount device disagree")
        if any(entry["id"] != mount_id and entry["device"] == device for entry in mounts):
            raise OutputCapacityRefused("output device has another mount; dedicated storage is unproven")
        sectors = int(_read_text(Path(f"/sys/dev/block/{device}/size"), 64).strip())
        device_bytes = sectors * 512
        stats = os.fstatvfs(fd)
        filesystem_bytes = stats.f_blocks * stats.f_frsize
        if not 0 < filesystem_bytes <= device_bytes <= limit_bytes:
            raise OutputCapacityRefused("total output device capacity exceeds the admitted bound or is invalid")
        if stats.f_flag & os.ST_RDONLY:
            raise OutputCapacityRefused("output filesystem is read-only")
        current = os.stat(path, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (identity.st_dev, identity.st_ino):
            raise OutputCapacityRefused("output path changed during capacity inspection")
        if _mount_id(fd) != mount_id or _read_text(Path("/proc/self/mountinfo")) != mountinfo:
            raise OutputCapacityRefused("mount topology changed during capacity inspection")
        return {
            "version": 1, "path": str(path), "mount_id": mount_id,
            "device": device, "inode": identity.st_ino, "filesystem": "ext4",
            "device_bytes": device_bytes, "filesystem_bytes": filesystem_bytes,
            "limit_bytes": limit_bytes,
        }
    except (OSError, ValueError, UnicodeError) as error:
        raise OutputCapacityRefused("output kernel capacity facts could not be verified") from error
    finally:
        if fd is not None:
            os.close(fd)
