"""Owner-only storage and explicit permanent channel trash commands."""
from .control_errors import ControlError


def register_storage_routes(route, product):
    async def usage(token, _path, _body, request):
        if request.query_params: raise ControlError(422, 'invalid_storage_query')
        return await product.storage.usage(token)
    route('/api/v1/storage', 'GET', usage)

    async def settings(token, *_): return await product.storage.settings(token)
    async def save(token, _path, body, _request): return await product.storage.save_settings(token, body)
    route('/api/v1/settings/storage', 'GET', settings)
    route('/api/v1/settings/storage', 'PUT', save, limit=4096)

    async def purge(token, path, body, _request):
        if body not in (None, {}): raise ControlError(422, 'invalid_attachment_command')
        return await product.storage.purge(token, path['channel_id'], path['attachment_id'])
    route('/api/v1/channels/{channel_id}/attachments/{attachment_id}/purge', 'DELETE', purge)

    async def cleanup(token, path, body, _request):
        return await product.storage.cleanup(token, path['channel_id'], body)
    route('/api/v1/channels/{channel_id}/attachments/cleanup', 'POST', cleanup, limit=4096)
