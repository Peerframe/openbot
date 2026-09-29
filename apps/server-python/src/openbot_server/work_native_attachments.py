"""Owner-native uploads through existing private files, authenticated product routes and parsers.

The fixed owner namespace is the existing single Owner control domain, never a new principal.
An upload alone grants no Task access: creation must explicitly capture its ID and digest.
"""
from urllib.parse import quote
from fastapi.responses import Response
from .control_errors import ControlError
from .http_input import read_attachment_upload, request_signal
from .owner_files import MAX_BYTES


def register_native_attachment_routes(route,product):
    base='/api/v1/task-attachments'
    async def listing(token,*_):
        async with product.files.lock(),product.transactions.transaction(token):
            return dict(attachments=product.files.owner_list())
    route(base,'GET',listing)

    async def upload(token,path,body,request):
        name,data=await read_attachment_upload(request,max_bytes=MAX_BYTES)
        item=await product.file_mutation(token,None,lambda:product.files.owner_persist(name,data),owner=True)
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
        async with request_signal(request) as cancelled:
            result=await product.processing.process_owner(token,path['attachment_id'],body,cancelled=cancelled)
            return dict(attachment=result)
    route(base+'/{attachment_id}/process','POST',process,limit=4096)
