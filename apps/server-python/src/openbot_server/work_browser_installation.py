"""Explicit private Bot-to-Node routes; loading this file grants no execution authority."""
import json
from pathlib import Path

from .model_connections import ModelConnectionsService
from .work_browser_profiles import BrowserProfiles
from .work_engine_client import read_owned_file
from .work_values import InvalidWork


def browser_profiles_from_file(path, connections):
    if path is None:
        return None
    try:
        if type(connections) is not ModelConnectionsService:
            raise ValueError()
        path = Path(path)
        if not path.is_absolute() or path.resolve(strict=True) != path:
            raise ValueError()
        def pairs(items):
            result = {}
            for key, value in items:
                if key in result: raise ValueError()
                result[key] = value
            return result
        value = json.loads(read_owned_file(path, private=True, maximum=16384), object_pairs_hook=pairs)
        if (type(value) is not dict or not {'version','routes'} <= set(value)
                or set(value) - {'version','routes','humanControl','pageOrigins'}
                or type(value['version']) is not int or value['version'] != 1):
            raise ValueError()
        return BrowserProfiles(connections, routes=value['routes'], human_control=value.get('humanControl', False),
                               page_origins=value.get('pageOrigins'))
    except Exception:
        raise InvalidWork('browser_installation_invalid') from None
