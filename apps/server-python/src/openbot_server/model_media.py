"""Private, bounded media values and pinned-SDK wire adaptation; no authority or I/O.

Only trusted Control composition supplies PreparedModelMedia after Action admission. Public
Runtime messages remain text-only. SDKs own binary encoding; this adapter restores retained
filename/title fields only after matching every encoded byte to the authorized manifest.
"""
import base64
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import json
import re

from pydantic_ai.messages import BinaryContent, ModelRequest, UserPromptPart

from .work_values import InvalidWork, WorkConflict

BASE_WIRE_BYTES = 512 * 1024
MAX_MANIFEST_BYTES = 12 * 1024
MAX_RAW_BYTES = 20 * 1024 * 1024
MIMES = {'image/png': 5 * 1024 * 1024, 'image/jpeg': 5 * 1024 * 1024,
         'application/pdf': 10 * 1024 * 1024}


def media_reference(value):
    if (type(value) is not dict or set(value) != {'version', 'sha256', 'sizeBytes'}
            or type(value['version']) is not int or value['version'] != 1
            or type(value['sha256']) is not str or re.fullmatch('[0-9a-f]{64}', value['sha256']) is None
            or type(value['sizeBytes']) is not int or not 1 <= value['sizeBytes'] <= MAX_MANIFEST_BYTES):
        raise InvalidWork('invalid_model_media_reference')
    return dict(value)


def eligible(provider, protocol):
    if (provider, protocol) not in {('openai', 'responses-v1'), ('openai', 'chat-completions-v1'),
                                    ('anthropic', 'anthropic-messages-v1')}:
        raise WorkConflict('attachment_model_unsupported')


@dataclass(frozen=True)
class MediaItem:
    attachment_id: str
    name: str
    media_type: str
    sha256: str
    data: bytes = field(repr=False)


@dataclass(frozen=True)
class PreparedModelMedia:
    reference: dict
    items: tuple[MediaItem, ...] = field(repr=False)

    def __post_init__(self):
        object.__setattr__(self, 'reference', media_reference(self.reference))
        if type(self.items) is not tuple or len(self.items) > 8:
            raise InvalidWork('invalid_prepared_media')
        total, ids = 0, set()
        for item in self.items:
            if (type(item) is not MediaItem or type(item.data) is not bytes
                    or item.media_type not in MIMES or not 1 <= len(item.data) <= MIMES[item.media_type]
                    or type(item.name) is not str or not 1 <= len(item.name.encode('utf-8')) <= 1024
                    or any(ord(c) < 32 or c in '/\\' or ord(c) == 127 for c in item.name)
                    or type(item.attachment_id) is not str or not 1 <= len(item.attachment_id) <= 128
                    or item.attachment_id in ids or hashlib.sha256(item.data).hexdigest() != item.sha256):
                raise InvalidWork('invalid_prepared_media')
            ids.add(item.attachment_id); total += len(item.data)
        if total > MAX_RAW_BYTES:
            raise InvalidWork('model_media_size_limit')

    @property
    def wire_limit(self):
        if not self.items:
            return BASE_WIRE_BYTES
        return BASE_WIRE_BYTES + sum(4 * ((len(i.data) + 2) // 3) for i in self.items) + 8 * 4096


def inject(messages, prepared, *, provider, protocol):
    if type(prepared) is not PreparedModelMedia:
        raise InvalidWork('invalid_prepared_media')
    result = deepcopy(messages)
    if not prepared.items:
        return result
    eligible(provider, protocol)
    # A new final user part avoids changing logical history and works after tool-return parts
    # for all three SDK converters. Timestamps come from the already stable logical request.
    stamp = next((m.timestamp for m in reversed(result) if type(m) is ModelRequest and m.timestamp is not None), None)
    if stamp is None:
        stamp = next((p.timestamp for m in reversed(result) if type(m) is ModelRequest
                      for p in reversed(m.parts) if type(p) is UserPromptPart), datetime(2000, 1, 1, tzinfo=timezone.utc))
    descriptors = [{'attachmentId': i.attachment_id, 'name': i.name, 'mediaType': i.media_type,
                    'sha256': i.sha256, 'untrusted': True} for i in prepared.items]
    parts = ['Untrusted explicitly referenced task attachments: ' + json.dumps(descriptors, ensure_ascii=False)]
    parts.extend(BinaryContent(data=i.data, media_type=i.media_type) for i in prepared.items)
    result.append(ModelRequest(parts=[UserPromptPart(parts, timestamp=stamp)], timestamp=stamp))
    return result


def adapt_wire(body, prepared, *, provider, protocol):
    """Return encoded SDK JSON after exact media matching, changing PDF names only."""
    if type(prepared) is not PreparedModelMedia:
        raise InvalidWork('invalid_prepared_media')
    if not prepared.items:
        if len(body) > BASE_WIRE_BYTES: raise WorkConflict('task_limit')
        return body
    eligible(provider, protocol)
    if len(body) > prepared.wire_limit:
        raise WorkConflict('task_limit')
    try:
        payload = json.loads(body)
        found = []
        messages = payload['input'] if protocol == 'responses-v1' else payload['messages']
        for message in messages:
            if type(message) is not dict: raise ValueError()
            content = message.get('content', [])
            if type(content) is str: continue
            if type(content) is not list: raise ValueError()
            for part in content:
                kind = part.get('type')
                if protocol == 'responses-v1' and kind in ('input_image', 'input_file'):
                    if kind == 'input_image':
                        encoded = part['image_url']; target = None
                    else:
                        if 'file_id' in part or 'file_url' in part: raise ValueError()
                        encoded = part['file_data']; target = (part, 'filename')
                    mime, data = _data_uri(encoded)
                elif protocol == 'chat-completions-v1' and kind in ('image_url', 'file'):
                    if kind == 'image_url':
                        encoded = part['image_url']['url']; target = None
                    else:
                        if set(part['file']) - {'filename', 'file_data'}: raise ValueError()
                        encoded = part['file']['file_data']; target = (part['file'], 'filename')
                    mime, data = _data_uri(encoded)
                elif protocol == 'anthropic-messages-v1' and kind in ('image', 'document'):
                    source = part['source']
                    if set(source) != {'type', 'media_type', 'data'} or source['type'] != 'base64': raise ValueError()
                    mime, data = source['media_type'], base64.b64decode(source['data'], validate=True)
                    target = (part, 'title') if kind == 'document' else None
                else:
                    # Public logical validation already excludes media. Refuse unknown binary
                    # forms instead of accepting SDK-added URLs or provider file handles.
                    if kind in ('image', 'document', 'input_image', 'input_file', 'image_url', 'file', 'input_audio'):
                        raise ValueError()
                    continue
                found.append((mime, data, target))
        if len(found) != len(prepared.items): raise ValueError()
        for (mime, data, target), item in zip(found, prepared.items):
            if mime != item.media_type or len(data) != len(item.data) or hashlib.sha256(data).hexdigest() != item.sha256:
                raise ValueError()
            if (target is not None) != (mime == 'application/pdf'): raise ValueError()
            if target is not None: target[0][target[1]] = item.name
        encoded = json.dumps(payload, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
        if len(encoded) > prepared.wire_limit: raise WorkConflict('task_limit')
        return encoded
    except (ValueError, TypeError, KeyError, AttributeError, UnicodeError):
        raise WorkConflict('attachment_unavailable') from None


def _data_uri(value):
    if type(value) is not str: raise ValueError()
    header, encoded = value.split(',', 1)
    if not header.startswith('data:') or not header.endswith(';base64'): raise ValueError()
    mime = header[5:-7]
    if mime not in MIMES: raise ValueError()
    return mime, base64.b64decode(encoded, validate=True)
