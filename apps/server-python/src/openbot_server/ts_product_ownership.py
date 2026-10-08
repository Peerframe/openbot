"""Explicit HTTP quarantine; internal Python readers remain available until P4."""
import re

ROUTES = (('POST', '/api/v1/channels'), ('POST', '/api/v1/bots/[^/]+/conversation'), ('POST', '/api/v1/channels/[^/]+/bots'), ('PATCH', '/api/v1/bots/[^/]+/profile'), ('PATCH', '/api/v1/bots/[^/]+/appearance'), ('PATCH', '/api/v1/bots/[^/]+'), ('PATCH', '/api/v1/channels/[^/]+'), ('POST', '/api/v1/channels/[^/]+/read'), ('GET', '/api/v1/channels/unread'), ('GET', '/api/v1/channels/[^/]+/reactions'), ('PUT', '/api/v1/channels/[^/]+/messages/[^/]+/reactions'))

def owns(method, path):
    return any(method == verb and re.fullmatch(pattern, path) for verb, pattern in ROUTES)
