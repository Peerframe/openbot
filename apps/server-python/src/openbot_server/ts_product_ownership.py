"""Explicit HTTP quarantine; internal Python readers remain available until P4."""
import re

ROUTES = (('POST', '/api/v1/channels'), ('POST', '/api/v1/bots/[^/]+/conversation'), ('POST', '/api/v1/channels/[^/]+/bots'), ('PATCH', '/api/v1/bots/[^/]+/profile'), ('PATCH', '/api/v1/bots/[^/]+/appearance'), ('PATCH', '/api/v1/bots/[^/]+'), ('PATCH', '/api/v1/channels/[^/]+'), ('POST', '/api/v1/channels/[^/]+/read'), ('GET', '/api/v1/channels/unread'), ('GET', '/api/v1/channels/[^/]+/reactions'), ('PUT', '/api/v1/channels/[^/]+/messages/[^/]+/reactions'))

MODEL_ROUTES = (
    ('GET', '/api/v1/model-services'), ('POST', '/api/v1/model-connections'),
    ('PATCH', '/api/v1/model-connections/[^/]+'), ('DELETE', '/api/v1/model-connections/[^/]+'),
    ('POST', '/api/v1/model-connections/verify'), ('POST', '/api/v1/model-connections/[^/]+/models'),
    ('POST', '/api/v1/model-connections/[^/]+/test'), ('PATCH', '/api/v1/bots/[^/]+/model'),
    ('GET', '/api/v1/settings/general'), ('PUT', '/api/v1/settings/general'),
    ('PUT', '/api/v1/settings/transcription'),
)

def owns(method, path, group='identity'):
    return any(method == verb and re.fullmatch(pattern, path) for verb, pattern in (ROUTES + MODEL_ROUTES if group == 'identity-models' else ROUTES))
