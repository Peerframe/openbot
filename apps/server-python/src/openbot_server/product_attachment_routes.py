"""Channel and Owner task-attachment HTTP registration over OwnerProduct's file authority.

The two families share only the plain download response; their authority never merges:
- Channel attachments prove the channel inside the Owner transaction (FOR SHARE) and stay
  downloadable after soft deletion, because retained message history still names them.
- Owner task attachments take the private file lock before the Owner transaction and refuse
  deleted content with 404. The fixed owner namespace is the existing single Owner control
  domain, never a new principal; an upload alone grants no Task access, creation must
  explicitly capture its ID and digest.
Mutations go through OwnerProduct.file_mutation, which owns lock/transaction order and rollback.
"""
from urllib.parse import quote

from fastapi.responses import Response

from .control_errors import ControlError
from .http_input import read_attachment_upload, request_signal
from .owner_files import MAX_BYTES

CHANNEL_BASE='/api/v1/channels/{channel_id}/attachments'
OWNER_BASE='/api/v1/task-attachments'


def download_response(data,*,name,media_type='application/octet-stream'):
    """Byte download with a UTF-8 filename; shared by attachments and verified Run artifacts."""
    return Response(data,media_type=media_type,headers={
        'Content-Disposition':"attachment; filename*=UTF-8''"+quote(name,safe=''),
        'Content-Length':str(len(data)),'X-Content-Type-Options':'nosniff'})


def register_attachment_routes(route,product,service):
    _register_owner(route,product,service)
    _register_channel(route,product,service)


def _register_owner(route,product,service):
    async def listing(token,*_):
        async with product.files.lock(),product.transactions.transaction(token):
            return {'attachments':product.files.owner_list()}
    route(OWNER_BASE,'GET',listing)

    async def upload(token,_path,_body,request):
        name,data=await read_attachment_upload(request,max_bytes=MAX_BYTES)
        item=await product.file_mutation(token,None,lambda:product.files.owner_persist(name,data),owner=True)
        return {'attachment':item}
    route(OWNER_BASE,'POST',upload,status=201)

    async def metadata(token,path,*_):
        async with product.files.lock(),product.transactions.transaction(token):
            return {'attachment':product.files.owner_metadata(path['attachment_id'])}
    route(OWNER_BASE+'/{attachment_id}','GET',metadata)

    async def content(token,path,*_):
        async with product.files.lock(),product.transactions.transaction(token):
            item,data=product.files.owner_read(path['attachment_id'])
            if item.get('deletedAt'): raise ControlError(404,'attachment_deleted')
            return download_response(data,name=item['name'])
    route(OWNER_BASE+'/{attachment_id}/content','GET',content)

    for method,suffix,deleted in (('DELETE','',True),('POST','/restore',False)):
        async def lifecycle(token,path,body,_request,deleted=deleted):
            if body not in (None,{}): raise ControlError(422,'invalid_attachment_command')
            identity=path['attachment_id']
            item=await product.file_mutation(token,None,lambda:product.files.owner_set_deleted(identity,deleted),identity,owner=True)
            return {'attachment':item}
        route(OWNER_BASE+'/{attachment_id}'+suffix,method,lifecycle)

    async def process(token,path,body,request):
        processing=service('processing')
        async with request_signal(request) as cancelled:
            result=await processing.process_owner(token,path['attachment_id'],body,cancelled=cancelled)
            return {'attachment':result}
    route(OWNER_BASE+'/{attachment_id}/process','POST',process,limit=4096)


def _register_channel(route,product,service):
    async def listing(token,path,*_):
        async with product.transactions.transaction(token) as db:
            await product.channel(db,path['channel_id'])
            return {'attachments':product.files.list(path['channel_id'])}
    route(CHANNEL_BASE,'GET',listing)

    async def upload(token,path,_body,request):
        name,data=await read_attachment_upload(request,max_bytes=MAX_BYTES)
        item=await product.file_mutation(token,path['channel_id'],lambda:product.files.persist(path['channel_id'],name,data))
        return {'attachment':item}
    route(CHANNEL_BASE,'POST',upload,status=201)

    async def metadata(token,path,*_):
        async with product.transactions.transaction(token) as db:
            await product.channel(db,path['channel_id'])
            return {'attachment':product.files.metadata(path['channel_id'],path['attachment_id'])}
    route(CHANNEL_BASE+'/{attachment_id}','GET',metadata)

    async def content(token,path,*_):
        async with product.transactions.transaction(token) as db:
            await product.channel(db,path['channel_id'])
            # Soft deletion refuses new Task references, not retained channel history downloads.
            item,data=product.files.read(path['channel_id'],path['attachment_id'])
            return download_response(data,name=item['name'])
    route(CHANNEL_BASE+'/{attachment_id}/content','GET',content)

    for method,suffix,deleted in (('DELETE','',True),('POST','/restore',False)):
        async def lifecycle(token,path,_body,_request,deleted=deleted):
            channel,identity=path['channel_id'],path['attachment_id']
            item=await product.file_mutation(token,channel,lambda:product.files.set_deleted(channel,identity,deleted),identity)
            return {'attachment':item}
        route(CHANNEL_BASE+'/{attachment_id}'+suffix,method,lifecycle)

    async def process(token,path,body,request):
        async with request_signal(request) as cancelled:
            result=await service('processing').process(token,path['channel_id'],path['attachment_id'],body,cancelled=cancelled)
            return {'attachment':result}
    route(CHANNEL_BASE+'/{attachment_id}/process','POST',process,limit=4096)
