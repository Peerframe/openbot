"""Byte accounting and one-JSON-value checks.

Bounds are measured on the exact UTF-8 bytes the boundary would carry, not on
character counts, because a character-count limit is trivially defeated by
non-ASCII text and would silently disagree with the Server's byte policies.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Iterator
from typing import Any


def utf8_size(value: str) -> int:
    """UTF-8 byte length of a string."""
    return len(value.encode("utf-8"))


def json_utf8_size(value: Any) -> int:
    """UTF-8 byte length of a compact, canonical JSON rendering of ``value``.

    Raises ``ValueError`` for NaN/Infinity, which are not valid JSON, and
    ``TypeError`` for values with no JSON representation. Both are treated as
    invalid by callers so an unbounded or non-JSON payload fails closed.
    """
    return utf8_size(
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False, default=None)
    )


def is_stream_like(value: Any) -> bool:
    """True when ``value`` is a generator/iterator rather than one JSON value.

    The SDK accepts generator tool results; a partial or iterable result must
    never be mistaken for a completed single value, so these are refused.
    """
    if isinstance(value, (Iterator, AsyncIterator)):
        return True
    return hasattr(value, "__aiter__") or hasattr(value, "__anext__")
