"""Strict shape parsing for a deferred tool proposal; correlation only, never authority."""
import json

from openbot_server.work_values import InvalidWork, canonical, text


FIELDS = frozenset({'call_id', 'tool', 'arguments'})
MAX_JSON_ARGUMENT_BYTES = 65536


def _reject_constant(_literal):
    raise ValueError('rejected_json_constant')


def _decode_json_object(raw):
    # Duplicate keys are a shape failure at any depth; a malformed object never survives to use.
    def object_pairs(pairs):
        seen = set()
        for key, _value in pairs:
            if key in seen:
                raise ValueError('rejected_duplicate_key')
            seen.add(key)
        return dict(pairs)

    try:
        # utf-8 is strict: invalid Unicode bytes fail closed here.
        parsed = json.loads(raw.encode('utf-8'), object_pairs_hook=object_pairs,
                            parse_constant=_reject_constant)
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise InvalidWork('invalid_json_arguments') from None
    if type(parsed) is not dict:
        raise InvalidWork('invalid_json_arguments')
    return parsed


def parse_proposal(value, *, large_arguments=False):
    """Return a detached exact-dict proposal; call_id is correlation metadata, not authority."""
    if type(large_arguments) is not bool or type(value) is not dict or set(value) != FIELDS:
        raise InvalidWork('invalid_proposal')
    call_id = text(value['call_id'], 128)
    tool = text(value['tool'], 128)

    arguments = value['arguments']
    if type(arguments) is str:
        try:
            encoded = arguments.encode('utf-8')
        except UnicodeError:
            raise InvalidWork('invalid_json_arguments') from None
        if len(encoded) > MAX_JSON_ARGUMENT_BYTES:
            raise InvalidWork('invalid_json_arguments')
        arguments = _decode_json_object(arguments)
    elif type(arguments) is not dict:
        raise InvalidWork('invalid_arguments')

    # canonical enforces depth, node, key-shape and size limits on the structure.
    data, _digest = canonical(arguments,max_bytes=65536 if large_arguments else 16384)
    # Detach by canonical encoding/JSON decode so no nested input object is aliased.
    try:
        detached = json.loads(data)
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise InvalidWork('invalid_json_arguments') from None
    return {'call_id': call_id, 'tool': tool, 'arguments': detached}
