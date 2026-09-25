"""Explicit Python product composition for the retained Owner API; no implicit service selection."""
from contextlib import asynccontextmanager
from pathlib import Path
import asyncio
import hashlib
import json
import os
import re
import stat
from urllib.parse import quote, unquote

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, StrictBool, ValidationError
import psycopg

from .authority import AuthenticationRequired, OwnerTransactions
from .control_errors import ControlError
from .database import StoreUnavailable
from .http_input import authorize_owner, read_json
from .owner_files import OwnerFiles, MAX_BYTES
from .workspace import PostgresWorkspace


class AutomationEnabled(BaseModel):
    model_config = ConfigDict(extra='ignore')
    enabled: StrictBool


class OwnerProduct:
    def __init__(self, dsn, *, object_root, model_settings=None, knowledge=None, automations=None, interactions=None, portability=None, processing=None, plugins=None, model_connections=None, worker_identity=None, worker_registry=None, browser=None, nodes=lambda: []):
        self.transactions = OwnerTransactions(dsn)
        self.workspace = PostgresWorkspace(dsn,nodes=nodes)
        self.files = OwnerFiles(Path(object_root)/'attachments')
        self.object_root = Path(object_root)
        self.model, self.knowledge, self.automations, self.interactions = model_settings,knowledge,automations,interactions
        self.portability, self.processing = portability, processing
        self.plugins, self.model_connections = plugins, model_connections
        self.worker_identity, self.worker_registry = worker_identity, worker_registry
        self.browser = browser
        self.work_runtime = None
        self.write_routes = []
        self.revision = 0
        from .legacy_approvals import PostgresLegacyApprovals
        self.approvals=PostgresLegacyApprovals(dsn)

    async def verify_schema(self):
        await self.transactions.verify_schema()
        from .model_settings import _open_directory
        fd=_open_directory(self.files.root,create=True);os.close(fd)
        fd=self.files._directory();os.close(fd)
        for service in (self.plugins,self.model_connections,self.worker_identity):
            if service is not None: await service.verify_schema()

    async def close(self):
        if self.work_runtime is not None: await self.work_runtime.close()
        if self.browser is not None: await self.browser.stop()
        for service in (self.worker_registry,self.plugins):
            if service is not None: await service.close()

    async def start(self):
        if self.work_runtime is not None: await self.work_runtime.start()

    def permits_write(self,request):
        return any(request.method==method and pattern.fullmatch(request.url.path) for method,pattern in self.write_routes)

    async def channel(self,db,channel_id):
        if not await (await db.execute('SELECT id FROM channels WHERE id=%s FOR SHARE',(channel_id,))).fetchone():
            raise ControlError(404,'channel_not_found')

    async def artifact_content(self,token,identity):
        async with self.transactions.transaction(token) as db:
            row=await (await db.execute('SELECT * FROM artifacts WHERE id=%s',(identity,))).fetchone()
            if row is None: raise ControlError(404,'artifact_not_found')
            key=row['storage_key']
            if not re.fullmatch(r'runs/[0-9a-f-]+/[0-9a-f-]+\.(?:png|md)',key,re.I):
                raise ControlError(503,'artifact_storage_key_refused')
            # Every path component is opened relative to an owned descriptor, never followed.
            fd=os.open(self.object_root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            try:
                for part in key.split('/')[:-1]:
                    next_fd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                    os.close(fd);fd=next_fd
                file_fd=os.open(key.split('/')[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
                with os.fdopen(file_fd,'rb') as stream:
                    info=os.fstat(stream.fileno())
                    if not stat.S_ISREG(info.st_mode) or info.st_size>5*1024*1024: raise ValueError()
                    data=stream.read(5*1024*1024+1)
            finally: os.close(fd)
            if len(data)!=row['metadata'].get('sizeBytes') or hashlib.sha256(data).hexdigest()!=row['sha256']:
                raise ControlError(503,'artifact_integrity')
            return row,data

    async def file_mutation(self,token,channel_id,operation,identity=None,*,owner=False):
        # File lock precedes the Owner transaction, matching task-reference admission ordering.
        # Restore metadata if the final authority recheck or commit fails.
        async with self.files.lock():
            prior=None;created=None
            try:
                async with self.transactions.transaction(token) as db:
                    if not owner:await self.channel(db,channel_id)
                    if identity: prior=self.files._read(identity+'.json',4096)
                    result=operation()
                    if not identity: created=result['id']
                    return result
            except BaseException:
                if prior is not None: self.files._write(identity+'.json',prior)
                if created is not None:
                    self.files._remove(created+'.json');self.files._remove(created+'.bin')
                raise


def register_product_routes(app,product,read_store,*,secure_cookies,allowed_origins):
    if product.browser is not None:
        from .browser_routes import BROWSER_WRITE_ROUTES, register_browser_routes
        register_browser_routes(app,product.browser,secure_cookies=secure_cookies,allowed_origins=allowed_origins)
        product.write_routes.extend((method,re.compile(path)) for method,path in BROWSER_WRITE_ROUTES)
    cookie='__Host-openbot_session' if secure_cookies else 'openbot_session'

    async def token(request,write=False):
        if write:
            return await authorize_owner(request,read_store,cookie_name=cookie,allowed_origins=allowed_origins)
        value=request.cookies.get(cookie)
        if (await read_store.read(value,'session')).expires_at is None: raise HTTPException(401,'Authentication required.')
        return value

    async def guarded(operation):
        try: return await operation
        except ControlError as error: raise HTTPException(error.status,error.code) from None
        except AuthenticationRequired: raise HTTPException(401,'Authentication required.') from None
        except ValidationError: raise HTTPException(422,'Invalid request input.') from None
        except (psycopg.Error,OSError,ValueError,TypeError,KeyError):
            raise StoreUnavailable('product_operation_unavailable') from None

    def route(path,method,operation,*,limit=32768,status=200):
        async def endpoint(request:Request):
            value=await token(request,method!='GET')
            if any(not 1 <= len(item) <= 128 for item in request.path_params.values()):
                raise HTTPException(422,'Invalid resource identifier.')
            body=await read_json(request,max_bytes=limit) if method in ('POST','PATCH','PUT','DELETE') and request.headers.get('content-type','').startswith('application/json') else None
            result=await guarded(operation(value,request.path_params,body,request))
            if method!='GET': product.revision += 1
            return result
        app.add_api_route(path,endpoint,methods=[method],status_code=status)
        if method!='GET':
            product.write_routes.append((method,re.compile(re.sub(r'\{[^}]+\}',r'[^/]+',path))))

    from .work_native_attachments import register_native_attachment_routes
    register_native_attachment_routes(route,product)

    async def workspace(value,_path,_body,_request): return await product.workspace.snapshot(value)
    route('/api/v1/workspace','GET',workspace)
    async def bootstrap(value,*_):
        result=await product.workspace.snapshot(value)
        return dict(project='openbot',phase='m1',counts=result['counts'])
    route('/api/v1/bootstrap','GET',bootstrap)

    async def artifact(value,path,*_):
        row,data=await product.artifact_content(value,path['artifact_id'])
        return Response(data,media_type=row['media_type'],headers={
            'Content-Disposition': "attachment; filename*=UTF-8''"+quote(row['name'],safe=''),
            'Content-Length':str(len(data)),'X-Content-Type-Options':'nosniff'})
    route('/api/v1/artifacts/{artifact_id}/content','GET',artifact)

    async def attachment_list(value,path,*_):
        async with product.transactions.transaction(value) as db:
            await product.channel(db,path['channel_id'])
            return {'attachments':product.files.list(path['channel_id'])}
    route('/api/v1/channels/{channel_id}/attachments','GET',attachment_list)

    async def upload(value,path,_body,request):
        if request.headers.get('content-type')!='application/octet-stream': raise ControlError(415,'raw_attachment_required')
        encoded=request.headers.get('x-openbot-filename','')
        if not encoded or len(encoded)>2048: raise ControlError(400,'attachment_name_required')
        name=unquote(encoded,errors='strict')
        data=bytearray()
        async with asyncio.timeout(10):
            async for chunk in request.stream():
                data.extend(chunk)
                if len(data)>MAX_BYTES: raise ControlError(413,'attachment_size_limit')
        result=await product.file_mutation(value,path['channel_id'],lambda:product.files.persist(path['channel_id'],name,bytes(data)))
        return {'attachment':result}
    route('/api/v1/channels/{channel_id}/attachments','POST',upload,status=201)

    async def metadata(value,path,*_):
        async with product.transactions.transaction(value) as db:
            await product.channel(db,path['channel_id'])
            return {'attachment':product.files.metadata(path['channel_id'],path['attachment_id'])}
    route('/api/v1/channels/{channel_id}/attachments/{attachment_id}','GET',metadata)

    async def content(value,path,*_):
        async with product.transactions.transaction(value) as db:
            await product.channel(db,path['channel_id'])
            item,data=product.files.read(path['channel_id'],path['attachment_id'])
            return Response(data,media_type='application/octet-stream',headers={'Content-Disposition':"attachment; filename*=UTF-8''"+quote(item['name'],safe=''),
                'Content-Length':str(len(data)),'X-Content-Type-Options':'nosniff'})
    route('/api/v1/channels/{channel_id}/attachments/{attachment_id}/content','GET',content)
    for method,suffix,deleted in [('DELETE','',True),('POST','/restore',False)]:
        async def lifecycle(value,path,_body,_request,deleted=deleted):
            result=await product.file_mutation(value,path['channel_id'],lambda:product.files.set_deleted(path['channel_id'],path['attachment_id'],deleted),path['attachment_id'])
            return {'attachment':result}
        route('/api/v1/channels/{channel_id}/attachments/{attachment_id}'+suffix,method,lifecycle)

    async def model_summary(value,*_):
        if product.model is None: return {'status':'unavailable'}
        async with product.transactions.transaction(value): return await product.model.summary()
    route('/api/v1/settings/model','GET',model_summary)

    def service(name):
        result=getattr(product,name)
        if result is None: raise ControlError(503,name+'_unavailable')
        return result

    from .product_extensions import register_extensions
    register_extensions(route, service)
    if product.worker_registry is not None:
        from .worker_host_routes import register_worker_host_routes
        register_worker_host_routes(app,product.worker_identity,product.worker_registry,
            secure_cookies=secure_cookies,allowed_origins=allowed_origins)
        for path in ('/api/v1/nodes/enrollment-tokens','/api/v1/nodes/enroll','/api/v1/nodes/[^/]+/revoke'):
            product.write_routes.append(('POST',re.compile(path)))

    async def model_save(value,_path,body,_request):
        return await service('model').save(body,authority=lambda:product.transactions.transaction(value))
    route('/api/v1/settings/model','POST',model_save,limit=4096)
    async def model_discover(value,_path,body,_request):
        return {'models':await service('model').discover(body,authority=lambda:product.transactions.transaction(value))}
    route('/api/v1/settings/model/models','POST',model_discover,limit=4096)

    async def profile(value,path,*_):
        return {'profile':await service('knowledge').profile(value,path['bot_id'])}
    route('/api/v1/bots/{bot_id}/profile','GET',profile)
    for path,method,member,keys,status,limit in (
        ('/skills','POST','create_skill',(),201,32768),
        ('/skills/import','POST','import_skill',(),201,32768),
        ('/skills/{skill_id}/state','POST','set_skill_state',('skill_id',),200,32768),
        ('/memories','POST','create_memory',(),201,32768),
        ('/memories/{memory_id}','PATCH','update_memory',('memory_id',),200,32768),
        ('/memories/{memory_id}','DELETE','delete_memory',('memory_id',),200,32768),
        ('/knowledge-proposals/{proposal_id}/review','POST','review_proposal',('proposal_id',),200,16384),
    ):
        async def knowledge_write(value,path,body,_request,member=member,keys=keys):
            return await getattr(service('knowledge'),member)(value,path['bot_id'],*[path[key] for key in keys],body)
        route('/api/v1/bots/{bot_id}'+path,method,knowledge_write,status=status,limit=limit)
    async def proposals(value,path,*_):
        return {'proposals':await service('knowledge').proposals(value,path['bot_id'])}
    route('/api/v1/bots/{bot_id}/knowledge-proposals','GET',proposals)

    async def automations(value,*_): return {'automations':await service('automations').list(value)}
    route('/api/v1/automations','GET',automations)
    async def automation_create(value,_path,body,_request):
        return {'automation':await service('automations').create(value,body)}
    route('/api/v1/automations','POST',automation_create,status=201)
    async def automation_update(value,path,body,_request):
        enabled=AutomationEnabled.model_validate(body).enabled
        return {'automation':await service('automations').set_enabled(value,path['automation_id'],enabled)}
    route('/api/v1/automations/{automation_id}','PATCH',automation_update,limit=1024)
    async def automation_delete(value,path,*_):
        await service('automations').delete(value,path['automation_id'])
        return {'deleted':True}
    route('/api/v1/automations/{automation_id}','DELETE',automation_delete,limit=1024)

    async def reactions(value,path,*_):
        return {'reactions':await service('interactions').list_reactions(value,path['channel_id'])}
    route('/api/v1/channels/{channel_id}/reactions','GET',reactions)
    async def reaction_set(value,path,body,_request):
        return {'reactions':await service('interactions').set_reaction(value,path['channel_id'],path['message_id'],body)}
    route('/api/v1/channels/{channel_id}/messages/{message_id}/reactions','PUT',reaction_set,limit=1024)
    async def member_remove(value,path,*_):
        return await service('interactions').remove_member(value,path['channel_id'],path['bot_id'])
    route('/api/v1/channels/{channel_id}/bots/{bot_id}','DELETE',member_remove)

    def export_selection(request):
        values=request.query_params.getlist('includeSkillContent')
        if values and values!=['true']: raise ControlError(422,'invalid_employee_export_selection')
        return bool(values)
    async def export_preview(value,path,_body,request):
        return {'preview':await service('portability').export_preview(value,path['bot_id'],export_selection(request))}
    route('/api/v1/bots/{bot_id}/export/preview','GET',export_preview)
    async def export_download(value,path,_body,request):
        query=request.query_params
        if set(query)-{'packageId','generatedAt','includeSkillContent'} or any(len(query.getlist(key))!=1 for key in ('packageId','generatedAt')):
            raise ControlError(422,'invalid_employee_export_instance')
        result=await service('portability').export(value,path['bot_id'],package_id=query['packageId'],
            generated_at=query['generatedAt'],if_match=request.headers.get('if-match'),include_skill_content=export_selection(request))
        return Response(result['body'],media_type=result['mediaType'],headers={
            'ETag':result['etag'],'Content-Disposition':'attachment; filename="'+result['fileName']+'"'})
    route('/api/v1/bots/{bot_id}/export','GET',export_download)
    async def import_preview(value,_path,body,request):
        if body is None: body=await read_json(request,max_bytes=2*1024*1024)
        return {'preview':await service('portability').import_preview(value,body)}
    route('/api/v1/employees/import/preview','POST',import_preview,limit=2*1024*1024)
    async def import_activate(value,_path,body,_request):
        result=await service('portability').activate(value,body)
        return JSONResponse(result,status_code=200 if result['replayed'] else 201)
    route('/api/v1/employees/import/activate','POST',import_activate,limit=2*1024*1024+65536)

    async def process_attachment(value,path,body,request):
        cancelled=asyncio.Event()
        async def disconnect():
            while not await request.is_disconnected(): await asyncio.sleep(.1)
            cancelled.set()
        watcher=asyncio.create_task(disconnect())
        try:
            result=await service('processing').process(value,path['channel_id'],path['attachment_id'],body,cancelled=cancelled)
            return {'attachment':result}
        finally:
            watcher.cancel()
            await asyncio.gather(watcher,return_exceptions=True)
    route('/api/v1/channels/{channel_id}/attachments/{attachment_id}/process','POST',process_attachment,limit=4096)

    async def approval_decision(value,path,body,_request):
        result=await product.approvals.decide(value,path['approval_id'],body)
        if result['approval']['status']=='expired': raise ControlError(409,'approval_expired')
        return result
    route('/api/v1/approvals/{approval_id}/decision','POST',approval_decision)

    async def workspace_events(request:Request):
        value=await token(request)
        async def events():
            previous=None
            while not await request.is_disconnected():
                if (await read_store.read(value,'session')).expires_at is None: return
                snapshot=await guarded(product.workspace.snapshot(value))
                encoded=json.dumps([snapshot,product.revision],sort_keys=True,ensure_ascii=False)
                # The existing reconnect-ready contract asks clients to fetch authoritative state.
                # Emit only when facts change; this stream grants no write authority or execution retry.
                if encoded!=previous:
                    yield 'event: workspace.ready\nretry: 2000\ndata: '+json.dumps(dict(type='workspace.ready',nodes=snapshot['nodes']))+'\n\n'
                    previous=encoded
                else: yield 'event: heartbeat\ndata: alive\n\n'
                await asyncio.sleep(3)
        return StreamingResponse(events(),media_type='text/event-stream',headers={'Cache-Control':'no-store','X-Accel-Buffering':'no'})
    app.add_api_route('/api/v1/workspace/events',workspace_events,methods=['GET'])

    async def channel_events(request:Request,channel_id:str):
        value=await token(request)
        if not 1 <= len(channel_id) <= 128: raise HTTPException(422,'Invalid channel identifier.')
        async with product.transactions.transaction(value) as db: await product.channel(db,channel_id)
        async def events():
            previous=None
            while not await request.is_disconnected():
                messages=await read_store.read(value,'messages',channel_id=channel_id)
                if messages.expires_at is None or not messages.found: return
                runs=await read_store.read(value,'runs',channel_id=channel_id)
                if runs.expires_at is None: return
                state=json.dumps([messages.rows,runs.rows,product.revision],sort_keys=True,default=str)
                if state!=previous:
                    yield 'event: channel.ready\nretry: 2000\ndata: '+json.dumps({'type':'channel.ready','channelId':channel_id})+'\n\n'
                    previous=state
                else: yield 'event: heartbeat\ndata: alive\n\n'
                await asyncio.sleep(3)
        return StreamingResponse(events(),media_type='text/event-stream',headers={'Cache-Control':'no-store','X-Accel-Buffering':'no'})
    app.add_api_route('/api/v1/channels/{channel_id}/events',channel_events,methods=['GET'])
