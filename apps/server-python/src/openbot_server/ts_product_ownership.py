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

READ_ROUTES = (('GET','/api/v1/audit'),('GET','/api/v1/audit/export'),('GET','/api/v1/runs/[^/]+/progress'))

FILE_ROUTES = tuple((method, base + suffix) for base in ('/api/v1/task-attachments', '/api/v1/channels/[^/]+/attachments') for method,suffix in (('GET',''),('POST',''),('GET','/[^/]+'),('GET','/[^/]+/content'),('DELETE','/[^/]+'),('POST','/[^/]+/restore'),('POST','/[^/]+/process'))) + (('GET','/api/v1/channels/[^/]+/attachments/[^/]+/references'),('GET','/api/v1/artifacts/[^/]+/content'))

STORAGE_ROUTES = (('GET','/api/v1/storage'),('GET','/api/v1/settings/storage'),('PUT','/api/v1/settings/storage'),('POST','/api/v1/storage/trash/cleanup'),('POST','/api/v1/channels/[^/]+/attachments/cleanup'),('DELETE','/api/v1/channels/[^/]+/attachments/[^/]+/purge'))

KNOWLEDGE_ROUTES = tuple((method, '/api/v1/bots/[^/]+' + suffix) for method,suffix in (('GET','/profile'),('POST','/skills'),('POST','/skills/import'),('POST','/skills/[^/]+/state'),('POST','/memories'),('PATCH','/memories/[^/]+'),('DELETE','/memories/[^/]+'),('GET','/knowledge-proposals'),('POST','/knowledge-proposals/[^/]+/review')))

APPROVAL_ROUTES = (('GET','/api/v1/settings/approvals'),('PUT','/api/v1/settings/approvals'),('POST','/api/v1/approvals/[^/]+/decision'))
AUTOMATION_ROUTES = (('GET','/api/v1/automations'),('POST','/api/v1/automations'),('PATCH','/api/v1/automations/[^/]+'),('DELETE','/api/v1/automations/[^/]+'))

PLUGIN_ROUTES = (('GET','/api/v1/plugins'),('POST','/api/v1/plugins'),('GET','/api/v1/plugins/catalog'),('POST','/api/v1/plugins/preview'),('POST','/api/v1/plugins/[^/]+/update/preview'),('POST','/api/v1/plugins/[^/]+/update'),('PATCH','/api/v1/plugins/[^/]+'),('DELETE','/api/v1/plugins/[^/]+'),('PUT','/api/v1/plugins/[^/]+/grants/[^/]+'),('POST','/api/v1/plugin-calls/[^/]+/decision'),('GET','/api/v1/channels/[^/]+/bots/[^/]+/plugin-content'),('POST','/api/v1/channels/[^/]+/bots/[^/]+/plugin-content'))

CREATION_LIFECYCLE_ROUTES = (("POST","/api/v1/bots"),("POST","/api/v1/bots/quick"),("DELETE","/api/v1/bots/[^/]+"),("DELETE","/api/v1/channels/[^/]+"),("DELETE","/api/v1/channels/[^/]+/bots/[^/]+"))

WORKSPACE_ROUTES = (("GET","/api/v1/workspace"),("GET","/api/v1/bootstrap"),("GET","/api/v1/workspace/events"),("GET","/api/v1/channels/[^/]+/events"))

PORTABILITY_ROUTES = (("GET","/api/v1/bots/[^/]+/export/preview"),("GET","/api/v1/bots/[^/]+/export"),("POST","/api/v1/employees/import/preview"),("POST","/api/v1/employees/import/activate"))

NODE_ROUTES = (("GET","/api/v1/nodes"),("GET","/api/v1/node-identities"),("POST","/api/v1/nodes/enrollment-tokens"),("POST","/api/v1/nodes/enroll"),("POST","/api/v1/nodes/[^/]+/revoke"))

BROWSER_ROUTES = (("POST","/api/v1/bots/[^/]+/browser"),("POST","/api/v1/bots/[^/]+/browser/maintenance"),("POST","/api/v1/browser-sessions/[^/]+/commands"),("DELETE","/api/v1/browser-sessions/[^/]+"))

def owns(method, path, group='identity'):
    return any(method == verb and re.fullmatch(pattern, path) for verb, pattern in (ROUTES + MODEL_ROUTES + READ_ROUTES + FILE_ROUTES + STORAGE_ROUTES + KNOWLEDGE_ROUTES + APPROVAL_ROUTES + AUTOMATION_ROUTES + PLUGIN_ROUTES + CREATION_LIFECYCLE_ROUTES + WORKSPACE_ROUTES + PORTABILITY_ROUTES + NODE_ROUTES + BROWSER_ROUTES if group == 'p3' else ROUTES + MODEL_ROUTES if group == 'identity-models' else ROUTES))


# Explicit P4 candidate quarantine. Retained internal adapters and old Temporal queues still drain.
WORK_ROUTES = (('POST','/api/v1/tasks'),('GET','/api/v1/tasks/[^/]+'),
    ('GET','/api/v1/tasks/[^/]+/scope'),('POST','/api/v1/tasks/[^/]+/cancel'),
    ('POST','/api/v1/tasks/[^/]+/corrections'),('POST','/api/v1/actions/[^/]+/decision'),
    ('POST','/api/v1/actions/[^/]+/reconcile'),('GET','/api/v1/artifacts/[^/]+'),
    ('POST','/api/v1/channels/[^/]+/messages'),('POST','/api/v1/runs/[^/]+/cancel'),('POST','/api/v1/runs/[^/]+/steer'))

def work_owns(method, path):
    return any(method == verb and re.fullmatch(pattern, path) for verb, pattern in WORK_ROUTES)
