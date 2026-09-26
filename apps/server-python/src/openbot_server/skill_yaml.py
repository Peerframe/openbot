"""YAML syntax from PyYAML; the retained core-schema string/map contract grants no authority."""
import re

import yaml
from yaml.events import (
    AliasEvent, DocumentEndEvent, DocumentStartEvent, MappingEndEvent, MappingStartEvent,
    ScalarEvent, StreamEndEvent, StreamStartEvent,
)

# YAML 1.2 core scalars. Typed values are invalid in the retained metadata contract, so no
# number/bool/null conversion or object constructor is needed. YAML 1.1 words stay strings.
_TYPED = re.compile(r'(?:|~|null|Null|NULL|true|True|TRUE|false|False|FALSE|'
    r'[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+|'
    r'[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?|'
    r'[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))')


def metadata(header):
    if len(header.encode('utf-8')) > 4096 or re.search(r'^%', header, re.M):
        raise ValueError('invalid YAML header')
    events=[]
    for event in yaml.parse(header, Loader=yaml.BaseLoader):
        if len(events) >= 520 or isinstance(event,AliasEvent) or getattr(event,'anchor',None) or getattr(event,'tag',None):
            raise ValueError('invalid YAML event')
        events.append(event)
    cursor=0
    nodes=0

    def take(kind):
        nonlocal cursor
        if cursor >= len(events) or not isinstance(events[cursor],kind):
            raise ValueError('invalid YAML structure')
        result=events[cursor];cursor+=1
        return result

    def value(depth):
        nonlocal nodes
        nodes+=1
        if nodes > 256 or depth > 8 or cursor >= len(events):
            raise ValueError('YAML structure limit')
        if isinstance(events[cursor],ScalarEvent):
            scalar=take(ScalarEvent)
            if scalar.style is None and _TYPED.fullmatch(scalar.value):
                raise ValueError('typed YAML scalar')
            return scalar.value
        take(MappingStartEvent)
        result={}
        while cursor < len(events) and not isinstance(events[cursor],MappingEndEvent):
            key=value(depth+1)
            if type(key) is not str or key in result: raise ValueError('invalid YAML key')
            result[key]=value(depth+1)
        take(MappingEndEvent)
        return result

    take(StreamStartEvent)
    document=take(DocumentStartEvent)
    if document.version or document.tags: raise ValueError('YAML directive refused')
    result=value(0)
    take(DocumentEndEvent);take(StreamEndEvent)
    if cursor != len(events) or type(result) is not dict: raise ValueError('invalid YAML document')
    return result
