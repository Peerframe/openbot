"""Bounded work-domain inputs; hashes bind immutable intents, never confer authority."""
import hashlib
import json
import math
import re


class WorkConflict(Exception):
    pass


class WorkNotFound(Exception):
    pass


class InvalidWork(ValueError):
    pass


def text(value, limit):
    if type(value) is not str or not value.strip() or '\0' in value:
        raise InvalidWork('invalid_text')
    try:
        if len(value.encode('utf-8')) > limit:
            raise InvalidWork('text_limit')
    except UnicodeError:
        raise InvalidWork('invalid_text') from None
    return value


def tokens(value):
    if type(value) is not int or not 0 <= value <= 1_000_000_000:
        raise InvalidWork('invalid_token_limit')
    return value


def canonical(value):
    remaining = 4096
    def visit(item, depth):
        nonlocal remaining
        remaining -= 1
        if remaining < 0 or depth > 12:
            raise InvalidWork('intent_structure_limit')
        if item is None or type(item) is bool:
            return
        if type(item) is str:
            if '\0' in item:
                raise InvalidWork('invalid_json_text')
        elif type(item) is int:
            if abs(item) > 2**53 - 1:
                raise InvalidWork('json_integer_limit')
        elif type(item) is float:
            if not math.isfinite(item):
                raise InvalidWork('invalid_json_number')
        elif type(item) is list:
            for child in item:
                visit(child, depth + 1)
        elif type(item) is dict:
            for key, child in item.items():
                text(key, 128)
                visit(child, depth + 1)
        else:
            raise InvalidWork('invalid_json')
    visit(value, 0)
    try:
        data = json.dumps(value, ensure_ascii=False, sort_keys=True,
                          separators=(',', ':'), allow_nan=False).encode('utf-8')
    except (ValueError, TypeError, UnicodeError):
        raise InvalidWork('invalid_json') from None
    if len(data) > 16384:
        raise InvalidWork('intent_size_limit')
    return data, hashlib.sha256(data).hexdigest()


def receipt(value):
    # Only a trusted adapter resolver supplies this reference after verifying external facts.
    if type(value) is not dict or set(value) != {'source', 'reference', 'sha256'}:
        raise InvalidWork('invalid_evidence')
    text(value['source'], 128)
    text(value['reference'], 512)
    if type(value['sha256']) is not str or re.fullmatch('[0-9a-f]{64}', value['sha256']) is None:
        raise InvalidWork('invalid_evidence_digest')
    canonical(value)
    return value
