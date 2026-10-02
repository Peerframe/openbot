"""Owner trash authority, durable retry receipts, and default-off Server maintenance."""
import asyncio
from collections import defaultdict
from datetime import datetime, timedelta
import json
import os
from uuid import uuid4

from psycopg.types.json import Jsonb

from .attachment_purge_files import PurgeFiles, marker
from .attachment_references import with_reference_counts
from .authority import OwnerTransactions, PostgresTransactions
from .control_errors import AttachmentReferenceConflict, ControlError
from .models import iso_timestamp
from .owner_files import UUID

RETAINED_LIMIT = 100


def referenced(item):
    return any(item['referenceCount'].values())


def settings_projection(row):
    if row is None: raise ControlError(503, 'storage_settings_unavailable')
    return dict(revision=row['revision'], trashAutoPurgeDays=row['trash_auto_purge_days'],
        updatedAt=iso_timestamp(row['updated_at']),
        lastAutoPurgeAt=iso_timestamp(row['last_auto_purge_at']) if row['last_auto_purge_at'] else None)


class StorageService:
    def __init__(self, dsn, files, object_root):
        self.transactions = OwnerTransactions(dsn, application_name='openbot-storage-owner')
        self.internal = PostgresTransactions(dsn, application_name='openbot-storage-maintenance')
        self.files, self.object_root = files, object_root
        self.journal = PurgeFiles(files)
        self.artifact_root = None
        self._task = None
        self._wake = asyncio.Event()
        files.recover_pending = self.recover_locked

    async def recover_locked(self):
        # This hook already holds the cross-process file lock, including in another live Server.
        for name in self.journal.journals():
            try: value = self.journal.read_journal(name)
            except FileNotFoundError:
                self.journal.discard_unstarted(name)
                continue
            async with self.internal.transaction() as db:
                rows = await (await db.execute('SELECT id,channel_id FROM attachment_purges WHERE operation_id=%s',
                    (value['operation'],))).fetchall()
                expected = {item['id']: item['channelId'] for item in value['entries']}
                if any(expected.get(row['id']) != row['channel_id'] for row in rows):
                    raise ControlError(503, 'purge_receipt_refused')
            self.journal.resolve(name, value, {row['id'] for row in rows})

    async def _channel(self, db, identity):
        if type(identity) is not str or not UUID.fullmatch(identity): raise ControlError(404, 'channel_not_found')
        row = await (await db.execute('SELECT id FROM channels WHERE id=%s AND deleted_at IS NULL FOR SHARE', (identity,))).fetchone()
        if row is None: raise ControlError(404, 'channel_not_found')

    def catalog(self):
        directory = self.files._directory()
        try:
            names = os.listdir(directory)
            if len(names) > 10000: raise ControlError(503, 'storage_entry_limit')
        finally: os.close(directory)
        identities = sorted(name[:-5] for name in names if name.endswith('.json') and UUID.fullmatch(name[:-5]))
        if len(identities) > 1024: raise ControlError(503, 'attachment_count_limit')
        channel, owner = [], []
        for identity in identities:
            try:
                value = json.loads(self.files._read(identity + '.json', 4096))
                if 'channelId' in value: channel.append(self.files.metadata(value['channelId'], identity))
                else: owner.append(self.files.owner_metadata(identity))
            except Exception: raise ControlError(503, 'storage_attachment_catalog_unavailable') from None
        return channel, owner

    async def _counts(self, db, items):
        groups = defaultdict(list)
        for item in items: groups[item['channelId']].append(item)
        result = []
        for channel in sorted(groups): result.extend(await with_reference_counts(db, channel, groups[channel]))
        return sorted(result, key=lambda item: item['id'])

    async def _remove(self, db, items, *, actor, reason, single=False):
        if not items:
            return dict(removed=0, retained=[], retainedCount=0, retainedHasMore=False, freedBytes=0)
        first = await self._counts(db, items)
        if single and referenced(first[0]): raise AttachmentReferenceConflict(first[0]['referenceCount'])
        operation = self.journal.stage(first)
        # C19's predicate reads do not block phantom INSERT/UPDATE from non-admission writers.
        # Hold final SHARE locks through commit; normal file-reference admission holds flock too.
        await db.execute('LOCK TABLE messages,runs IN SHARE MODE')
        final = await self._counts(db, items)
        if single and referenced(final[0]): raise AttachmentReferenceConflict(final[0]['referenceCount'])
        removed = [item for item in final if not referenced(item)]
        retained = [item for item in final if referenced(item)]
        freed = []
        if removed:
            value = self.journal.read_journal('.purge-' + operation)
            # Sizes are read from the staged regular files, never a client-supplied byte count.
            directory = self.files._directory()
            fd = None
            try:
                fd = self.journal._open(directory, '.purge-' + operation)
                entries = {item['id']: item for item in value['entries']}
                for item in removed:
                    total = sum(os.stat(item['id'] + suffix, dir_fd=fd, follow_symlinks=False).st_size for suffix in entries[item['id']]['suffixes'])
                    freed.append(max(0, total - len(marker(item))))
            finally:
                if fd is not None: os.close(fd)
                os.close(directory)
        if removed:
            await db.execute('INSERT INTO attachment_purges(id,channel_id,operation_id,freed_bytes) '
                'SELECT id,channel_id,%s,freed_bytes FROM unnest(%s::text[],%s::text[],%s::integer[]) AS x(id,channel_id,freed_bytes)',
                (operation, [item['id'] for item in removed], [item['channelId'] for item in removed], freed))
            payloads = [Jsonb(dict(actor=actor, reason=reason, attachmentId=item['id'], fileName=item['name'],
                sizeBytes=item['sizeBytes'], freedBytes=freed[index])) for index, item in enumerate(removed)]
            await db.execute("INSERT INTO run_events(id,channel_id,type,payload) SELECT id,channel_id,'CHANNEL_ATTACHMENT_PURGED',payload "
                'FROM unnest(%s::text[],%s::text[],%s::jsonb[]) AS x(id,channel_id,payload)',
                ([str(uuid4()) for _ in removed], [item['channelId'] for item in removed], payloads))
        return dict(removed=len(removed), retained=[dict(id=item['id'], name=item['name'], referenceCount=item['referenceCount'])
            for item in retained[:RETAINED_LIMIT]], retainedCount=len(retained), retainedHasMore=len(retained)>RETAINED_LIMIT,
            freedBytes=sum(freed))

    async def purge(self, token, channel, identity):
        async with self.files.lock():
            try:
                async with self.transactions.transaction(token) as db:
                    await self._channel(db, channel)
                    prior = await (await db.execute('SELECT freed_bytes FROM attachment_purges WHERE id=%s AND channel_id=%s',
                        (identity, channel))).fetchone()
                    if prior: result = dict(id=identity, purged=True, freedBytes=prior['freed_bytes'])
                    else:
                        item = self.files.metadata(channel, identity)
                        if not item.get('deletedAt'): raise ControlError(409, 'attachment_not_in_trash')
                        outcome = await self._remove(db, [item], actor='owner', reason='permanent_delete', single=True)
                        result = dict(id=identity, purged=True, freedBytes=outcome['freedBytes'])
                await self.recover_locked()
                return result
            except BaseException:
                # A failed COMMIT reply is not proof of rollback. Lookup before restoring bytes.
                await self.recover_locked()
                raise

    async def cleanup(self, token, channel, command):
        async with self.files.lock():
            try:
                async with self.transactions.transaction(token) as db:
                    await self._channel(db, channel)
                    if (type(command) is not dict or set(command) != {'requestKey'} or type(command['requestKey']) is not str
                            or not UUID.fullmatch(command['requestKey'])): raise ControlError(422, 'invalid_cleanup_request')
                    key = command['requestKey'].lower()
                    prior = await (await db.execute('SELECT response FROM attachment_cleanup_receipts WHERE channel_id=%s AND request_key=%s',
                        (channel, key))).fetchone()
                    if prior: result = prior['response']
                    else:
                        items, _ = self.catalog()
                        result = await self._remove(db, [item for item in items if item['channelId']==channel and item.get('deletedAt')],
                            actor='owner', reason='empty_trash')
                        await db.execute('INSERT INTO attachment_cleanup_receipts(channel_id,request_key,response) VALUES(%s,%s,%s)',
                            (channel, key, Jsonb(result)))
                await self.recover_locked()
                return result
            except BaseException:
                await self.recover_locked()
                raise

    async def settings(self, token):
        async with self.transactions.transaction(token) as db:
            return settings_projection(await (await db.execute("SELECT * FROM owner_storage_settings WHERE owner_id='owner'")).fetchone())

    async def save_settings(self, token, command):
        async with self.transactions.transaction(token) as db:
            if (type(command) is not dict or set(command) != {'expectedRevision', 'trashAutoPurgeDays'}
                    or type(command['expectedRevision']) is not int or not 1<=command['expectedRevision']<=2147483647
                    or command['trashAutoPurgeDays'] is not None and (type(command['trashAutoPurgeDays']) is not int or command['trashAutoPurgeDays'] != 30)):
                raise ControlError(422, 'invalid_storage_settings')
            row = await (await db.execute("SELECT * FROM owner_storage_settings WHERE owner_id='owner' FOR UPDATE")).fetchone()
            if row is None: raise ControlError(503, 'storage_settings_unavailable')
            if row['revision'] != command['expectedRevision']: raise ControlError(409, 'storage_settings_revision_conflict')
            if row['trash_auto_purge_days'] != command['trashAutoPurgeDays']:
                if row['revision'] == 2147483647: raise ControlError(409, 'storage_settings_revision_exhausted')
                row = await (await db.execute("UPDATE owner_storage_settings SET trash_auto_purge_days=%s,revision=revision+1,"
                    "last_auto_purge_at=NULL,updated_at=clock_timestamp() WHERE owner_id='owner' RETURNING *", (command['trashAutoPurgeDays'],))).fetchone()
                await db.execute("INSERT INTO run_events(id,type,payload) VALUES(%s,'SETTINGS_STORAGE_UPDATED',%s)",
                    (str(uuid4()), Jsonb(dict(actor='owner', revision=row['revision'], trashAutoPurgeDays=row['trash_auto_purge_days']))))
            result = settings_projection(row)
        self._wake.set()
        return result

    async def usage(self, token):
        from .storage_usage import measured_usage
        async with self.files.lock(), self.transactions.transaction(token) as db:
            channel, owner = self.catalog()
            trash = await self._counts(db, [item for item in channel if item.get('deletedAt')])
            return await measured_usage(db, self.files, self.object_root, self.artifact_root, channel, owner, trash)

    async def run_due(self):
        run_id = None
        async with self.files.lock():
            try:
                # Persist a daily claim and audit before any filesystem staging. A crash leaves
                # a visible started run; another Server must not guess that it safely finished.
                async with self.internal.transaction() as db:
                    row = await (await db.execute("SELECT *,clock_timestamp() AS now FROM owner_storage_settings WHERE owner_id='owner' FOR UPDATE")).fetchone()
                    if row is None: raise ControlError(503, 'storage_settings_unavailable')
                    if row['trash_auto_purge_days'] is None: return None
                    if row['last_auto_purge_at'] is not None and row['now'] - row['last_auto_purge_at'] < timedelta(days=1): return None
                    run_id = str(uuid4())
                    await db.execute("UPDATE owner_storage_settings SET last_auto_purge_at=%s WHERE owner_id='owner'", (row['now'],))
                    await db.execute("INSERT INTO run_events(id,type,payload) VALUES(%s,'SETTINGS_TRASH_AUTO_PURGE_RUN',%s)",
                        (str(uuid4()), Jsonb(self._run_payload('started', None, run_id))))
                async with self.internal.transaction() as db:
                    policy = await (await db.execute("SELECT * FROM owner_storage_settings WHERE owner_id='owner' FOR UPDATE")).fetchone()
                    if policy is None: raise ControlError(503, 'storage_settings_unavailable')
                    if policy['revision'] != row['revision'] or policy['trash_auto_purge_days'] != 30:
                        result = dict(removed=0, retained=[], retainedCount=0, retainedHasMore=False, freedBytes=0)
                        outcome = 'policy_changed'
                    else:
                        items, _ = self.catalog()
                        eligible = []
                        for item in items:
                            if not item.get('deletedAt'): continue
                            instant = datetime.fromisoformat(item['deletedAt'])
                            if instant.tzinfo is None: raise ControlError(503, 'trash_timestamp_unavailable')
                            if instant <= row['now'] - timedelta(days=30): eligible.append(item)
                        if eligible:
                            active = await (await db.execute('SELECT id FROM channels WHERE id=ANY(%s) AND deleted_at IS NULL ORDER BY id FOR SHARE',
                                (sorted({item['channelId'] for item in eligible}),))).fetchall()
                            allowed = {item['id'] for item in active}
                            eligible = [item for item in eligible if item['channelId'] in allowed]
                        result = await self._remove(db, eligible, actor='server', reason='trash_auto_purge')
                        outcome = 'completed'
                    await self._finish_run(db, run_id, outcome, result)
                await self.recover_locked()
                return dict(outcome=outcome, **result)
            except BaseException as error:
                # An unavailable lookup leaves the journal and started audit unresolved. It
                # cannot be reported as a failed run with zero effects after a lost COMMIT.
                await self.recover_locked()
                if run_id is not None:
                    async with self.internal.transaction() as db:
                        audit = await (await db.execute('SELECT payload FROM run_events WHERE id=%s FOR UPDATE', (run_id,))).fetchone()
                        if audit:
                            if isinstance(error, asyncio.CancelledError): raise
                            return audit['payload']
                        else:
                            await self._finish_run(db, run_id,
                                'cancelled' if isinstance(error, asyncio.CancelledError) else 'failed',
                                dict(removed=0, freedBytes=0, retainedCount=0))
                if isinstance(error, asyncio.CancelledError): raise
                return dict(outcome='failed', removed=0, freedBytes=0)

    @staticmethod
    def _run_payload(outcome, result, operation_id):
        return dict(actor='server', operationId=operation_id, reason='trash_auto_purge', trashAutoPurgeDays=30, outcome=outcome,
            removed=result['removed'] if result else None, freedBytes=result['freedBytes'] if result else None,
            retainedCount=result['retainedCount'] if result else None)

    async def _finish_run(self, db, run_id, outcome, result):
        await db.execute("INSERT INTO run_events(id,type,payload) VALUES(%s,'SETTINGS_TRASH_AUTO_PURGE_RUN',%s)",
            (run_id, Jsonb(self._run_payload(outcome, result, run_id))))

    async def start(self):
        if self._task is not None: raise RuntimeError('storage_maintenance_already_started')
        async with self.files.lock(): pass
        self._task = asyncio.create_task(self._loop(), name='openbot-storage-maintenance')

    async def _loop(self):
        while True:
            self._wake.clear()
            try: await self.run_due()
            except asyncio.CancelledError: raise
            except Exception: pass  # No raw SQL/path exception may enter a public log.
            try:
                async with asyncio.timeout(3600): await self._wake.wait()
            except TimeoutError: pass

    async def close(self):
        if self._task is not None:
            self._task.cancel()
            try: await self._task
            except asyncio.CancelledError: pass
            self._task = None
