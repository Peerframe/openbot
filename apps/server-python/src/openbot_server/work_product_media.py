"""Server-owned original media binding for accepted Work model Activities.

Existing immutable Work blobs hold only a small manifest. OwnerFiles keeps the originals;
models, Runtime messages and Workflow history cannot select or replace a binary reference.
All mutable attachment reads run under files -> source/channel -> Task locking.
"""
from copy import deepcopy
import hashlib
import json

from .control_errors import ControlError
from .model_media import (MAX_MANIFEST_BYTES, MIMES, MediaItem, PreparedModelMedia,
                          eligible, media_reference)
from .task_store import attachment_ids, TooManyAttachments
from .work_model_activity import operation_key
from .work_product_binding import ProductWorkBinding
from .work_product_reads import _hash
from .work_values import InvalidWork, WorkConflict, canonical

_EVENT = 'model.media_bound'


def _encode(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()


class ProductWorkMedia:
    def __init__(self, store, client, scope, files, work_files, reads, *, reservation_per_binary=8192):
        if (reads.store is not store or reads.files is not files or files is None
                or type(reservation_per_binary) is not int or not 1 <= reservation_per_binary <= 65536):
            raise InvalidWork('invalid_product_media_configuration')
        self.store, self.files, self.work_files, self.reads = store, files, work_files, reads
        self.control = ProductWorkBinding(store, client, scope)
        self.reservation_per_binary = reservation_per_binary

    async def _source(self, db, context, *, write=False, require_fence=False):
        # Lock source/channel before Task. Never acquire files after entering this transaction.
        await self.store._task(db, context.task_id, read=not write)
        bound = await self.reads._facts()
        mapping = await (await db.execute('SELECT 1 FROM work_sources WHERE task_id=%s',
                                          (context.task_id,))).fetchone()
        if mapping:
            _, _, source, accepted, activity = await self.reads._source(db, context, bound, write=write)
        else:
            native=await self.control.check(db,context,require_fence=require_fence)
            from .work_native_scope import capabilities
            if 'attachments' in capabilities(native):
                _,_,source,accepted,activity=await self.reads._source(db,context,bound,write=write)
            else:source, accepted, activity = None, None, bound[1]
        await self.control.check(db, context, require_fence=require_fence)
        try:
            ids = attachment_ids(context.objective)
        except TooManyAttachments:
            raise WorkConflict('attachment_unavailable') from None
        if source is None and (ids or '[openbot attachment:' in context.objective.lower()):
            raise WorkConflict('attachment_outside_task')
        if source is not None and source.get('kind')=='task':
            if not set(ids)<=set(source['attachmentIds']):raise WorkConflict('attachment_outside_task')
            ids=source['attachmentIds']
        return source, ids, accepted, activity

    def _manifest(self, context, source, ids, *, include_bytes=False):
        try:
            if source.get('kind')=='task':
                from .work_native_scope import validate_attachments
                validate_attachments(self.files,dict(request=dict(attachmentIds=ids),attachments=source['attachments']))
            else:self.files.validate_references(source['channelId'], ids)
            items, binary = [], []
            for identity in ids:
                item,data=(self.files.owner_read(identity) if source.get('kind')=='task'
                           else self.files.read(source['channelId'],identity))
                if item.get('deletedAt'): raise WorkConflict('attachment_unavailable')
                entry = dict(id=identity, name=item['name'], mediaType=item['mediaType'],
                    sizeBytes=item['sizeBytes'], sha256=item['sha256'], metadataSha256=_hash(item),
                    mode='binary', derivedSha256=None)
                if item.get('processing') or item['mediaType'] == 'text/plain':
                    snapshot, _ = self.reads._attachment(context, source,
                        dict(attachmentId=identity, offset=0, limit=1))
                    entry.update(mode='derived' if item.get('processing') else 'text',
                                 derivedSha256=snapshot['derivedSha256'])
                elif item['mediaType'] not in MIMES:
                    raise WorkConflict('attachment_model_unsupported')
                elif include_bytes:
                    binary.append(MediaItem(identity, item['name'], item['mediaType'], item['sha256'], data))
                items.append(entry)
            manifest = dict(version=1, taskId=context.task_id, runId=context.run_id, source=source, items=items)
            data = _encode(manifest)
            if len(data) > MAX_MANIFEST_BYTES: raise WorkConflict('attachment_unavailable')
            return manifest, data, tuple(binary)
        except (ControlError, ValueError, TypeError, KeyError, OSError, UnicodeError):
            raise WorkConflict('attachment_unavailable') from None

    async def _anchor(self, db, context):
        rows = await (await db.execute('SELECT payload FROM work_events WHERE task_id=%s AND kind=%s '
            "AND payload->>'runId'=%s ORDER BY revision LIMIT 2", (context.task_id, _EVENT, context.run_id))).fetchall()
        if not rows: return None
        if len(rows) != 1: raise WorkConflict('model_media_binding_changed')
        value = rows[0]['payload']
        if type(value) is not dict or set(value) != {'runId', 'inputMedia'} or value['runId'] != context.run_id:
            raise WorkConflict('model_media_binding_changed')
        return media_reference(value['inputMedia'])

    def _read(self, ref):
        ref = media_reference(ref)
        try:
            data = self.work_files.read(ref['sha256'], ref['sizeBytes'])
            value = json.loads(data)
            if _encode(value) != data: raise ValueError()
            return value
        except (ValueError, TypeError, UnicodeError):
            raise WorkConflict('attachment_unavailable') from None

    async def _validate(self, db, context, *, reference=None, require_fence=False, include_bytes=False):
        source, ids, accepted, activity = await self._source(db, context, require_fence=require_fence)
        anchored = await self._anchor(db, context)
        if reference is not None and media_reference(reference) != anchored:
            raise WorkConflict('model_media_binding_changed')
        if not ids:
            if anchored is not None: raise WorkConflict('model_media_binding_changed')
            return None, None, (), accepted, activity
        if anchored is None: raise WorkConflict('model_media_binding_required')
        manifest, data, binary = self._manifest(context, source, ids, include_bytes=include_bytes)
        if (len(data) != anchored['sizeBytes'] or hashlib.sha256(data).hexdigest() != anchored['sha256']
                or self._read(anchored) != manifest):
            raise WorkConflict('attachment_unavailable')
        return anchored, manifest, binary, accepted, activity

    async def prepare(self, context):
        async with self.files.lock():
            async with self.store._transaction(trusted=True) as db:
                source, ids, _, _ = await self._source(db, context, write=True)
                anchored = await self._anchor(db, context)
                if not ids:
                    if anchored is not None: raise WorkConflict('model_media_binding_changed')
                    return None
                _, data, _ = self._manifest(context, source, ids)
                ref = media_reference(dict(version=1, **self.work_files.put(data)))
                if anchored is not None:
                    if ref != anchored: raise WorkConflict('attachment_unavailable')
                    return ref
                # Bootstrap alone may create the binding; a late first model must not silently
                # reinterpret an old history which never disclosed this attachment set.
                exists = await (await db.execute('SELECT 1 FROM work_actions WHERE task_id=%s AND run_id=%s LIMIT 1',
                                                 (context.task_id, context.run_id))).fetchone()
                if exists: raise WorkConflict('model_media_bootstrap_required')
                await self.store._event(db, context.task_id, _EVENT, dict(runId=context.run_id, inputMedia=ref))
                return ref

    async def binding(self, context):
        async with self.files.lock():
            async with self.store._transaction(trusted=True) as db:
                return (await self._validate(db, context))[0]

    def reservation(self, reference, configuration):
        if reference is None: return 0
        manifest = self._read(reference)
        count = sum(item['mode'] == 'binary' for item in manifest['items'])
        if count: eligible(configuration['provider'], configuration['protocol'])
        return count * self.reservation_per_binary

    async def admit_in_transaction(self, db, context, reference):
        # Admission already owns Task UPDATE. SQL identity/anchor checks only; original bytes
        # are freshly checked under files -> Task by hydrate and the before_send callback.
        _, ids, _, _ = await self._source(db, context, require_fence=True)
        anchored = await self._anchor(db, context)
        if anchored != reference or bool(ids) != bool(anchored):
            raise WorkConflict('model_media_binding_changed')
        return True

    async def hydrate(self, context, reference, configuration):
        async with self.files.lock():
            async with self.store._transaction(trusted=True) as db:
                ref, _, binary, accepted, activity = await self._validate(db, context,
                    reference=reference, require_fence=True, include_bytes=True)
                if ref is None or accepted is None: raise WorkConflict('model_media_binding_required')
                key = operation_key(accepted, activity)
                action = await (await db.execute('SELECT * FROM work_actions WHERE task_id=%s AND run_id=%s '
                    'AND action_key=%s FOR SHARE', (context.task_id, context.run_id, key))).fetchone()
                if (not action or action['intent'].get('inputMedia') != ref
                        or action['intent'].get('configuration') != configuration):
                    raise WorkConflict('model_media_binding_changed')
                await self.control.check(db, context, action_id=action['id'], intent=action['intent'])
                if binary: eligible(configuration['provider'], configuration['protocol'])
                return PreparedModelMedia(ref, binary)

    async def revalidate_in_transaction(self, db, context, reference=None):
        await self._validate(db, context, reference=reference, require_fence=True)
        return True

    async def revalidate(self, context, reference=None):
        async with self.files.lock():
            async with self.store._transaction(trusted=True) as db:
                return await self.revalidate_in_transaction(db, context, reference)

    async def evidence(self, context, producer_action):
        async with self.files.lock():
            async with self.store._transaction(trusted=True) as db:
                ref, manifest, _, _, _ = await self._validate(db, context, require_fence=True)
                if producer_action['intent'].get('inputMedia') != ref:
                    raise WorkConflict('result_media_not_read')
                return self._public(ref, manifest)

    async def describe(self, context):
        async with self.files.lock():
            async with self.store._transaction(trusted=True) as db:
                ref, manifest, _, _, _ = await self._validate(db, context)
                return self._public(ref, manifest)

    @staticmethod
    def _public(ref, manifest):
        return dict(inputMedia=deepcopy(ref), attachments=[] if manifest is None else [
            {k: item[k] for k in ('id', 'name', 'mediaType', 'sizeBytes', 'sha256', 'mode')}
            for item in manifest['items']])
