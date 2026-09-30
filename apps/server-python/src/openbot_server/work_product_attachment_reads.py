"""Shared bounded attachment text read for Work consumers; callers own every lock.

The caller already holds files -> identity -> source/Task locks and supplies a source it
checked in its own transaction. This reads one explicitly referenced attachment, checks any
derived text against its metadata, and returns the checked snapshot plus one UTF-16 page.
It never acquires a lock, caches authority, charges a read budget or settles a receipt.
"""
from dataclasses import dataclass
import hashlib
import json

from .control_errors import ControlError
from .task_store import attachment_ids, TooManyAttachments
from .text_compat import ECMASCRIPT_WHITESPACE
from .text_compat import utf16_unit_count as _units
from .work_tool_results import encode_result
from .work_values import InvalidWork, WorkConflict


@dataclass(frozen=True, slots=True)
class AttachmentRead:
    """One validated read: snapshot for intents/receipts, page for results, original size."""
    snapshot: dict
    page: dict
    size_bytes: int


def page_attachment(item, value, truncated, request):
    encoded = value.encode('utf-16-le')
    offset, limit = request['offset'], request['limit']
    total = len(encoded) // 2
    if offset > total:
        raise InvalidWork('attachment_offset_past_end')
    available = encoded[offset * 2:(offset + limit) * 2]
    # The persisted JSON codec refuses lone surrogates. Reject a mid-scalar start and
    # leave an incomplete final scalar for the next page instead of rewriting its bytes.
    if available and 0xDC00 <= int.from_bytes(available[:2], 'little') <= 0xDFFF:
        raise InvalidWork('attachment_offset_splits_character')
    if available and 0xD800 <= int.from_bytes(available[-2:], 'little') <= 0xDBFF:
        available = available[:-2]
    excerpt, utf8, escaped = [], 0, 0
    for character in available.decode('utf-16-le'):
        size = len(character.encode())
        quoted = len(json.dumps(character, ensure_ascii=False).encode()) - 2
        if utf8 + size > 8192 or escaped + quoted > 10240:
            break
        excerpt.append(character); utf8 += size; escaped += quoted
    value = ''.join(excerpt)
    following = offset + _units(value)
    if not value and offset < total:
        raise InvalidWork('attachment_page_splits_character')
    return dict(attachmentId=item['id'], name=item['name'], sha256=item['sha256'], offset=offset,
                text=value, totalCharacters=total, nextOffset=following if following < total else None,
                truncated=following < total or truncated, untrusted=True)


def read_attachment(files, context, source, request) -> AttachmentRead:
    """Read under caller-owned locks; source kind 'task' selects the native Owner scope."""
    try:
        ids = source['attachmentIds'] if source.get('kind')=='task' else attachment_ids(context.objective)
        identity = request['attachmentId']
        if identity not in ids:
            raise WorkConflict('attachment_outside_task')
        if source.get('kind')=='task':
            from .work_native_scope import validate_attachments
            validate_attachments(files,dict(request=dict(attachmentIds=ids),attachments=source['attachments']))
            item,data=files.owner_read(identity)
        else:
            files.validate_references(source['channelId'], ids)
            item, data = files.read(source['channelId'], identity)
        if item.get('deletedAt'):
            raise WorkConflict('attachment_unavailable')
        derived_hash, truncated = None, False
        if item.get('processing'):
            raw = files._read(identity + '.text.json', 2 * 1024 * 1024)
            derived = json.loads(raw)
            required = {'text', 'truncated', 'sha256', 'operation', 'processedAt'}
            processing = item['processing']
            if (type(derived) is not dict or set(derived) != required
                    or type(derived['text']) is not str or not derived['text'].strip(ECMASCRIPT_WHITESPACE)
                    or _units(derived['text']) > 262144 or type(derived['truncated']) is not bool
                    or derived['sha256'] != item['sha256'] or type(processing) is not dict
                    or set(processing) != {'operation', 'characters', 'truncated', 'processedAt'}
                    or processing['operation'] not in ('extract', 'ocr', 'transcribe')
                    or processing['operation'] != derived['operation']
                    or processing['processedAt'] != derived['processedAt']
                    or type(processing['truncated']) is not bool
                    or processing['truncated'] != derived['truncated']
                    or type(processing['characters']) is not int or processing['characters'] != _units(derived['text'])):
                raise WorkConflict('attachment_derived_invalid')
            value, truncated = derived['text'], derived['truncated']
            derived_hash = hashlib.sha256(raw).hexdigest()
        elif item['mediaType'] == 'text/plain':
            value = data.decode('utf-8')
        else:
            raise WorkConflict('attachment_text_required')
        snapshot = dict(id=identity, sha256=item['sha256'], metadataSha256=encode_result(item)[1],
                        derivedSha256=derived_hash)
        return AttachmentRead(snapshot, page_attachment(item, value, truncated, request), len(data))
    except (ControlError, TooManyAttachments, ValueError, KeyError, TypeError, OSError):
        raise WorkConflict('attachment_unavailable') from None
