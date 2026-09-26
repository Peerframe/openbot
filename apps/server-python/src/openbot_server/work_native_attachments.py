"""Owner-native uploads through existing private files, authenticated product routes and parsers.

The fixed owner namespace is the existing single Owner control domain, never a new principal.
An upload alone grants no Task access: creation must explicitly capture its ID and digest.
"""
import asyncio
from urllib.parse import unquote,quote
from fastapi.responses import Response
from .control_errors import ControlError
from .owner_files import MAX_BYTES


def register_native_attachment_routes(route,product):
    base='/api/v1/task-attachments'
    async def listing(token,*_):
        async with product.files.lock(),product.transactions.transaction(token):
            return dict(attachments=product.files.owner_list())
    route(base,'GET',listing)

    async def upload(token,path,body,request):
        if request.headers.get('content-type')!='application/octet-stream':raise ControlError(415,'raw_attachment_required')
        encoded=request.headers.get('x-openbot-filename','')
        if not encoded or len(encoded)>2048:raise ControlError(400,'attachment_name_required')
        name=unquote(encoded,errors='strict');data=bytearray()
        async with asyncio.timeout(10):
            async for chunk in request.stream():
                data.extend(chunk)
                if len(data)>MAX_BYTES:raise ControlError(413,'attachment_size_limit')
        item=await product.file_mutation(token,None,lambda:product.files.owner_persist(name,bytes(data)),owner=True)
        return dict(attachment=item)
    route(base,'POST',upload,status=201)

    async def metadata(token,path,*_):
        async with product.files.lock(),product.transactions.transaction(token):
            return dict(attachment=product.files.owner_metadata(path['attachment_id']))
    route(base+'/{attachment_id}','GET',metadata)

    async def content(token,path,*_):
        async with product.files.lock(),product.transactions.transaction(token):
            item,data=product.files.owner_read(path['attachment_id'])
            if item.get('deletedAt'):raise ControlError(404,'attachment_deleted')
            return Response(data,media_type='application/octet-stream',headers={
                'Content-Disposition':"attachment; filename*=UTF-8''"+quote(item['name'],safe=''),
                'Content-Length':str(len(data)),'X-Content-Type-Options':'nosniff'})
    route(base+'/{attachment_id}/content','GET',content)

    for method,suffix,deleted in [('DELETE','',True),('POST','/restore',False)]:
        async def lifecycle(token,path,body,request,deleted=deleted):
            if body not in (None,{}):raise ControlError(422,'invalid_attachment_command')
            identity=path['attachment_id']
            item=await product.file_mutation(token,None,lambda:product.files.owner_set_deleted(identity,deleted),identity,owner=True)
            return dict(attachment=item)
        route(base+'/{attachment_id}'+suffix,method,lifecycle)

    async def process(token,path,body,request):
        if product.processing is None:raise ControlError(503,'processing_unavailable')
        cancelled=asyncio.Event()
        async def disconnect():
            while not await request.is_disconnected():await asyncio.sleep(.1)
            cancelled.set()
        watcher=asyncio.create_task(disconnect())
        try:
            result=await product.processing.process_owner(token,path['attachment_id'],body,cancelled=cancelled)
            return dict(attachment=result)
        finally:
            watcher.cancel();await asyncio.gather(watcher,return_exceptions=True)
    route(base+'/{attachment_id}/process','POST',process,limit=4096)
