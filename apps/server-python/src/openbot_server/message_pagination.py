"""Bounded, channel-bound position cursors; a deleted anchor needs no lookup."""
from __future__ import annotations

import base64
import binascii
from datetime import datetime, timezone
import json
import re

from .control_errors import ControlError


def _invalid():
    return ControlError(422, 'invalid_message_pagination')


def pagination_query(items):
    values = {}
    for key, value in items:
        if key not in ('before', 'limit') or key in values:
            raise _invalid()
        values[key] = value
    limit = values.get('limit', '100')
    if re.fullmatch(r'[1-9][0-9]{0,2}', limit) is None or int(limit) > 100:
        raise _invalid()
    return values.get('before'), int(limit)


def encode_cursor(channel_id, row):
    time = row['created_at'].astimezone(timezone.utc).isoformat(timespec='microseconds').replace('+00:00', 'Z')
    value = dict(v=1, c=channel_id, t=time, i=row['id'])
    encoded = base64.urlsafe_b64encode(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()).decode().rstrip('=')
    # Public stored IDs must also be bounded, not just IDs decoded from a request.
    decode_cursor(encoded, channel_id)
    return encoded


def decode_cursor(value, channel_id):
    def unique(pairs):
        result = {}
        for key, item in pairs:
            if key in result:
                raise ValueError()
            result[key] = item
        return result
    try:
        if type(value) is not str or re.fullmatch(r'[A-Za-z0-9_-]{1,2048}', value) is None:
            raise ValueError()
        raw = base64.b64decode(value + '=' * (-len(value) % 4), altchars=b'-_', validate=True)
        if base64.urlsafe_b64encode(raw).decode().rstrip('=') != value:
            raise ValueError()
        item = json.loads(raw, object_pairs_hook=unique)
        if (type(item) is not dict or set(item) != {'v', 'c', 't', 'i'} or type(item['v']) is not int or item['v'] != 1
                or item['c'] != channel_id or type(item['i']) is not str or not 1 <= len(item['i']) <= 128
                or type(item['t']) is not str or re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z', item['t']) is None):
            raise ValueError()
        return datetime.fromisoformat(item['t']), item['i']
    except (ValueError, TypeError, UnicodeError, binascii.Error, RecursionError):
        raise _invalid() from None
