"""Retained plugin and model-connection HTTP composition; authority stays in the services."""
import asyncio
from contextlib import asynccontextmanager

from .control_errors import ControlError


@asynccontextmanager
async def request_signal(request):
    signal = asyncio.Event()
    async def watch():
        while not await request.is_disconnected():
            await asyncio.sleep(.1)
        signal.set()
    watcher = asyncio.create_task(watch())
    try:
        yield signal
    finally:
        watcher.cancel()
        await asyncio.gather(watcher, return_exceptions=True)


async def connected_request(request, operation, *, timeout=120):
    """A disconnected Owner cannot leave a provider probe running to its normal deadline."""
    async with request_signal(request) as signal, asyncio.timeout(timeout):
        task = asyncio.create_task(operation())
        stopped = asyncio.create_task(signal.wait())
        try:
            done, _ = await asyncio.wait((task, stopped), return_when=asyncio.FIRST_COMPLETED)
            if stopped in done:
                raise ControlError(409, 'request_cancelled')
            return await task
        finally:
            task.cancel(); stopped.cancel()
            await asyncio.gather(task, stopped, return_exceptions=True)


def register_extensions(route, service):
    async def plugins(token, *_):
        return await service('plugins').snapshot(token)
    route('/api/v1/plugins', 'GET', plugins)

    for path, method, name, wrapped, network, status in (
        ('/plugins/preview','POST','preview',False,True,200),
        ('/plugins','POST','install',True,True,201),
        ('/plugins/{plugin_id}/update/preview','POST','preview_update',False,True,200),
        ('/plugins/{plugin_id}/update','POST','apply_update',True,True,200),
        ('/plugins/{plugin_id}','PATCH','set_enabled',True,False,200),
        ('/plugins/{plugin_id}/grants/{bot_id}','PUT','grant',True,False,200),
        ('/plugins/{plugin_id}','DELETE','remove',False,False,200),
        ('/plugin-calls/{call_id}/decision','POST','decide',False,False,200),
    ):
        async def operation(token, params, body, request, name=name, wrapped=wrapped, network=network):
            args=[token]
            for key in ('plugin_id','bot_id','call_id'):
                if key in params: args.append(params[key])
            args.append(body)
            method=getattr(service('plugins'), name)
            if network:
                async with request_signal(request) as signal:
                    result=await method(*args,signal=signal)
            else:
                result=await method(*args)
            return {'plugin':result} if wrapped else result
        route('/api/v1'+path, method, operation, limit=24576, status=status)

    async def catalog(token, params, *_):
        return await service('plugins').owner_content_catalog(token,
            {'channelId':params['channel_id'],'botId':params['bot_id']})
    async def content(token, params, body, request):
        async with request_signal(request) as signal:
            return await service('plugins').owner_read_content(token,
                {'channelId':params['channel_id'],'botId':params['bot_id']},body,signal=signal)
    route('/api/v1/channels/{channel_id}/bots/{bot_id}/plugin-content','GET',catalog)
    route('/api/v1/channels/{channel_id}/bots/{bot_id}/plugin-content','POST',content,limit=24576)

    async def models(token,*_):
        return await service('model_connections').snapshot(token)
    async def create(token,_params,body,_request):
        return {'connection':await service('model_connections').create(token,body)}
    async def update(token,params,body,_request):
        return {'connection':await service('model_connections').update(token,params['connection_id'],body)}
    async def discover(token,params,_body,request):
        result=await connected_request(request,lambda:service('model_connections').discover(token,params['connection_id']))
        return {'models':result}
    async def test(token,params,body,request):
        return await connected_request(request,lambda:service('model_connections').test(token,params['connection_id'],body))
    async def employee(token,params,body,_request):
        return await service('model_connections').update_employee_model(token,params['bot_id'],body)
    route('/api/v1/model-services','GET',models)
    route('/api/v1/model-connections','POST',create,limit=8192,status=201)
    route('/api/v1/model-connections/{connection_id}','PATCH',update,limit=4096)
    route('/api/v1/model-connections/{connection_id}/models','POST',discover,limit=1024)
    route('/api/v1/model-connections/{connection_id}/test','POST',test,limit=1024)
    route('/api/v1/bots/{bot_id}/model','PATCH',employee,limit=2048)
