"""Measured managed-root/database bytes, bounded traversal and no remote-host estimates."""
from collections import defaultdict
import os
from pathlib import Path
import re
import stat

from .control_errors import ControlError
from .models import iso_timestamp

TOP_CHANNEL_LIMIT = 20
MAX_ENTRIES = 10000


def tree_bytes(path):
    result = {}
    count = 0
    def walk(fd, prefix):
        nonlocal count
        if len(prefix) > 8: raise ControlError(503, 'storage_depth_limit')
        for name in os.listdir(fd):
            count += 1
            if count > MAX_ENTRIES: raise ControlError(503, 'storage_entry_limit')
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if info.st_uid != os.geteuid(): raise ControlError(503, 'storage_path_refused')
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                try: walk(child, (*prefix, name))
                finally: os.close(child)
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                result[(*prefix, name)] = info.st_size
            else: raise ControlError(503, 'storage_path_refused')
    root = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(root)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode)&0o077:
            raise ControlError(503, 'private_storage_root_required')
        walk(root, ())
    finally: os.close(root)
    return result


async def measured_usage(db, files, object_root, artifact_root, channel, owner, trash):
    objects = tree_bytes(object_root)
    attachment_prefix = files.root.relative_to(object_root).parts
    claimed = set()
    channel_active = channel_trash = owner_bytes = 0
    channels = defaultdict(lambda: dict(sizeBytes=0, fileCount=0))
    for item in [*channel, *owner]:
        total = 0
        for suffix in ('.bin', '.json', '.text.json'):
            key = (*attachment_prefix, item['id'] + suffix)
            if key not in objects:
                if suffix != '.text.json': raise ControlError(503, 'storage_attachment_unavailable')
                continue
            claimed.add(key); total += objects[key]
        if item.get('scopeKind') == 'owner': owner_bytes += total
        else:
            channels[item['channelId']]['sizeBytes'] += total
            channels[item['channelId']]['fileCount'] += 1
            if item.get('deletedAt'): channel_trash += total
            else: channel_active += total
    task_bytes = task_count = 0
    for key, size in objects.items():
        if key[0] == 'runs':
            if key in claimed: raise ControlError(503, 'storage_root_overlap')
            claimed.add(key); task_bytes += size; task_count += 1
    output_known = artifact_root is not None
    extra_other = extra_total = extra_other_count = 0
    if artifact_root is not None:
        artifact_root = Path(artifact_root)
        if artifact_root == Path(object_root) or Path(object_root).is_relative_to(artifact_root):
            raise ControlError(503, 'storage_root_overlap')
        if artifact_root.is_relative_to(object_root):
            prefix = artifact_root.relative_to(object_root).parts
            candidates = {key: size for key, size in objects.items() if key[:len(prefix)] == prefix}
            for key, size in candidates.items():
                if key in claimed: raise ControlError(503, 'storage_root_overlap')
                if len(key) == len(prefix)+1 and re.fullmatch('[a-f0-9]{64}', key[-1]):
                    claimed.add(key); task_bytes += size; task_count += 1
        else:
            external = tree_bytes(artifact_root)
            extra_total = sum(external.values())
            for key, size in external.items():
                if len(key) == 1 and re.fullmatch('[a-f0-9]{64}', key[0]): task_bytes += size; task_count += 1
                else:
                    extra_other += size; extra_other_count += 1
    observed = await (await db.execute('SELECT pg_database_size(current_database()) AS bytes,clock_timestamp() AS now')).fetchone()
    other = sum(size for key, size in objects.items() if key not in claimed) + extra_other
    total = sum(objects.values()) + extra_total + observed['bytes']
    if not 0 <= total <= 9007199254740991: raise ControlError(503, 'storage_size_limit')
    rows = await (await db.execute('SELECT id,name,deleted_at FROM channels WHERE id=ANY(%s)', (list(channels),))).fetchall() if channels else []
    names = {row['id']: row for row in rows}
    if len(names) != len(channels): raise ControlError(503, 'storage_channel_unavailable')
    top = sorted(channels, key=lambda identity: (-channels[identity]['sizeBytes'], identity))[:TOP_CHANNEL_LIMIT]
    return dict(totalBytes=total, measuredAt=iso_timestamp(observed['now']),
        categories=dict(channelFiles=dict(sizeBytes=channel_active, fileCount=len(channel)-len(trash)),
            taskOutputs=dict(sizeBytes=task_bytes, fileCount=task_count) if output_known else None,
            retainedRunOutputs=dict(sizeBytes=task_bytes, fileCount=task_count) if not output_known else None,
            trash=dict(sizeBytes=channel_trash, fileCount=len(trash)),
            ownerTaskFiles=dict(sizeBytes=owner_bytes, fileCount=len(owner)),
            other=dict(sizeBytes=other, fileCount=sum(key not in claimed for key in objects)+extra_other_count),
            database=dict(sizeBytes=observed['bytes']), workingComputerBrowserData=None),
        trash=dict(fileCount=len(trash), sizeBytes=channel_trash,
            referencedFileCount=sum(any(item['referenceCount'].values()) for item in trash)),
        topChannels=[dict(id=identity, name=names[identity]['name'], deleted=names[identity]['deleted_at'] is not None,
            **channels[identity]) for identity in top], topChannelsLimit=TOP_CHANNEL_LIMIT)
