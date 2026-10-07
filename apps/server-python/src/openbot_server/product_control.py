"""Explicit Python product composition for the retained Owner API; no implicit service selection."""
from pathlib import Path
import hashlib
import json
import os
import re
import stat

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, StrictBool, ValidationError
import psycopg

from .authority import AuthenticationRequired, OwnerTransactions
from .control_errors import ControlError
from .database import StoreUnavailable
from .http_input import authorize_owner, read_json
from .owner_files import OwnerFiles
from .product_attachment_routes import download_response, register_attachment_routes
from .product_events import event_stream, poll_events
from .workspace import PostgresWorkspace


class AutomationEnabled(BaseModel):
    model_config = ConfigDict(extra='ignore')
    enabled: StrictBool


class OwnerProduct:
    def __init__(self, dsn, *, object_root, knowledge=None, automations=None, interactions=None, portability=None, processing=None, plugins=None, model_connections=None, worker_identity=None, worker_registry=None, browser=None, plugin_catalog_path=None, nodes=lambda: []):
        from .transcription_settings import TranscriptionSettings
        self.transcription = TranscriptionSettings(dsn, model_connections)
        self.transactions = OwnerTransactions(dsn)
        self.workspace = PostgresWorkspace(dsn,nodes=nodes)
        from .workspace_settings import WorkspaceSettings
        self.workspace_settings = WorkspaceSettings(dsn)
        self.files = OwnerFiles(Path(object_root)/'attachments')
        self.object_root = Path(object_root)
        from .storage_service import StorageService
        self.storage = StorageService(dsn, self.files, self.object_root)
        self.knowledge, self.automations, self.interactions = knowledge,automations,interactions
        self.portability, self.processing = portability, processing
        self.plugins, self.model_connections = plugins, model_connections
        self.worker_identity, self.worker_registry = worker_identity, worker_registry
        from .approval_settings import OwnerApprovalSettings
        self.approval_settings=OwnerApprovalSettings(dsn,self.files)

        from .owner_preferences import OwnerPreferences
        self.preferences = OwnerPreferences(dsn,model_connections=model_connections)

        from .plugin_catalog import ReviewedPluginCatalog
        self.plugin_catalog = ReviewedPluginCatalog(dsn,plugin_catalog_path)
        self.browser = browser
        from .bot_greeting import BotGreetings
        self.greetings = BotGreetings(dsn, model_connections)
        self.work_runtime = None
        self.write_routes = []
        self.revision = 0
        from .legacy_approvals import PostgresLegacyApprovals
        self.approvals=PostgresLegacyApprovals(dsn)
        from .identity_lifecycle import PostgresIdentityLifecycle
        self.lifecycle=PostgresIdentityLifecycle(dsn)

    async def verify_schema(self):
        await self.transactions.verify_schema()
        from .model_settings import _open_directory
        fd=_open_directory(self.files.root,create=True);os.close(fd)
        fd=self.files._directory();os.close(fd)
        for service in (self.plugins,self.model_connections,self.worker_identity):
            if service is not None: await service.verify_schema()

    async def close(self):
        await self.greetings.close()
        await self.storage.close()
        if self.work_runtime is not None: await self.work_runtime.close()
        if self.browser is not None: await self.browser.stop()
        for service in (self.worker_registry,self.plugins):
            if service is not None: await service.close()

    async def start(self):
        await self.storage.start()
        if self.work_runtime is not None: await self.work_runtime.start()

    def permits_write(self,request):
        return any(request.method==method and pattern.fullmatch(request.url.path) for method,pattern in self.write_routes)

    async def channel(self,db,channel_id):
        if not await (await db.execute('SELECT id FROM channels WHERE id=%s AND deleted_at IS NULL FOR SHARE',(channel_id,))).fetchone():
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

    async def purge_deleted_channel_files(self,token,channel_ids):
        """Remove attachment files of tombstoned channels after the delete committed (ADR-0047).

        Same lock order as uploads: files lock, then an Owner transaction that proves every
        channel is already a tombstone, so a live channel's files can never be removed here.
        """
        async with self.files.lock(), self.transactions.transaction(token) as db:
            rows=await (await db.execute('SELECT id FROM channels WHERE id=ANY(%s) AND deleted_at IS NOT NULL',
                                         (list(channel_ids),))).fetchall()
            if len(rows)!=len(set(channel_ids)): raise ControlError(404,'channel_not_found')
            return sum(self.files.purge_channel(channel_id) for channel_id in channel_ids)



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
        except ControlError: raise
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

    async def workspace(value,_path,_body,_request): return await product.workspace.snapshot(value)
    route('/api/v1/workspace','GET',workspace)
    async def primary_bot(value,_path,body,_request):
        return await product.workspace_settings.update(value,body)
    route('/api/v1/workspace/primary-bot','PUT',primary_bot,limit=1024)
    from .run_progress import PostgresRunProgress, selected_steps
    progress_store = PostgresRunProgress(product.transactions._dsn)
    async def run_progress(value,path,_body,request):
        if set(request.query_params) - {'steps'} or len(request.query_params.getlist('steps')) > 1:
            raise ControlError(422,'invalid_progress_steps')
        return await progress_store.read(value,path['run_id'],selected_steps(request.query_params.get('steps')))
    route('/api/v1/runs/{run_id}/progress','GET',run_progress)
    async def bootstrap(value,*_):
        result=await product.workspace.snapshot(value)
        return dict(project='openbot',phase='m1',counts=result['counts'])
    route('/api/v1/bootstrap','GET',bootstrap)
    from .storage_routes import register_storage_routes
    register_storage_routes(route, product)

    async def artifact(value,path,*_):
        row,data=await product.artifact_content(value,path['artifact_id'])
        return download_response(data,name=row['name'],media_type=row['media_type'])
    route('/api/v1/artifacts/{artifact_id}/content','GET',artifact)

    async def approval_settings(value,*_):return await product.approval_settings.snapshot(value)
    async def approval_save(value,_path,body,_request):return await product.approval_settings.save(value,body)
    route('/api/v1/settings/approvals','GET',approval_settings)
    route('/api/v1/settings/approvals','PUT',approval_save,limit=16384)

    async def owner_preferences(value,*_): return await product.preferences.get(value)
    route('/api/v1/settings/general','GET',owner_preferences)
    async def owner_preferences_save(value,_path,body,_request): return await product.preferences.update(value,body)
    route('/api/v1/settings/general','PUT',owner_preferences_save,limit=2048)

    async def plugin_catalog(value,_path,_body,request):
        if request.query_params: raise HTTPException(422,'Catalog query parameters are not accepted.')
        return await product.plugin_catalog.snapshot(value)
    route('/api/v1/plugins/catalog','GET',plugin_catalog)

    async def transcription_get(value,*_): return await product.transcription.get(value)
    route('/api/v1/settings/transcription','GET',transcription_get)
    async def transcription_put(value,_path,body,_request): return await product.transcription.update(value,body)
    route('/api/v1/settings/transcription','PUT',transcription_put,limit=1024)

    def service(name):
        result=getattr(product,name)
        if result is None: raise ControlError(503,name+'_unavailable')
        return result

    register_attachment_routes(route,product,service)
    from .product_extensions import register_extensions
    register_extensions(route, service)
    if product.worker_registry is not None:
        from .worker_host_routes import register_worker_host_routes
        register_worker_host_routes(app,product.worker_identity,product.worker_registry,
            secure_cookies=secure_cookies,allowed_origins=allowed_origins)
        for path in ('/api/v1/nodes/enrollment-tokens','/api/v1/nodes/enroll','/api/v1/nodes/[^/]+/revoke'):
            product.write_routes.append(('POST',re.compile(path)))

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

    # ADR-0047 identity lifecycle. Unread must be registered before the parameterized channel routes.
    async def unread(value,*_):
        return {'unread':await product.lifecycle.unread(value)}
    route('/api/v1/channels/unread','GET',unread)
    async def channel_rename(value,path,body,_request):
        return {'channel':await product.lifecycle.rename_channel(value,path['channel_id'],body)}
    route('/api/v1/channels/{channel_id}','PATCH',channel_rename,limit=1024)
    async def cleanup(value,channel_ids):
        # File cleanup follows the committed tombstone. A failure leaves files that no live route can
        # read (every attachment route checks a live channel) and is reported, not hidden.
        if not channel_ids: return True
        try: await product.purge_deleted_channel_files(value,channel_ids)
        except (ControlError,AuthenticationRequired,OSError,TimeoutError): return False
        return True
    async def channel_delete(value,path,*_):
        result=await product.lifecycle.delete_channel(value,path['channel_id'])
        return {**result,'attachmentsRemoved':await cleanup(value,[path['channel_id']])}
    route('/api/v1/channels/{channel_id}','DELETE',channel_delete,limit=1024)
    async def channel_read(value,path,*_):
        return await product.lifecycle.mark_read(value,path['channel_id'])
    route('/api/v1/channels/{channel_id}/read','POST',channel_read,limit=1024)
    async def bot_rename(value,path,body,_request):
        return {'bot':await product.lifecycle.rename_bot(value,path['bot_id'],body)}
    route('/api/v1/bots/{bot_id}','PATCH',bot_rename,limit=1024)
    async def bot_delete(value,path,*_):
        result=await product.lifecycle.delete_bot(value,path['bot_id'])
        direct=result.pop('directChannelId',None)
        attachments=await cleanup(value,[direct] if direct else [])
        # Grants live in the encrypted plugin file, so they are removed after the tombstone commits.
        # A failure leaves inert grants (a tombstoned Bot cannot run) and is reported, not hidden.
        removed=True
        if product.plugins is not None:
            try: await product.plugins.forget_bot(value,path['bot_id'])
            except (ControlError,AuthenticationRequired): removed=False
        return {**result,'pluginGrantsRemoved':removed,'attachmentsRemoved':attachments}
    route('/api/v1/bots/{bot_id}','DELETE',bot_delete,limit=1024)
    async def audit_list(value,_path,_body,request):
        from .audit_records import parse_query
        return await product.lifecycle.audit(value,**parse_query(request.query_params))
    route('/api/v1/audit','GET',audit_list)
    async def audit_export(value,_path,_body,request):
        from .audit_records import export_csv,parse_query
        page=await product.lifecycle.audit(value,maximum=1000,**parse_query(request.query_params,export=True))
        return Response(export_csv(page['events']),media_type='text/csv; charset=utf-8',headers={
            'Content-Disposition':'attachment; filename="openbot-audit.csv"',
            **({'X-OpenBot-Next-Before':page['nextBefore']} if page.get('nextBefore') else {})})
    route('/api/v1/audit/export','GET',audit_export)

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

    async def approval_decision(value,path,body,_request):
        result=await product.approvals.decide(value,path['approval_id'],body)
        if result['approval']['status']=='expired': raise ControlError(409,'approval_expired')
        return result
    route('/api/v1/approvals/{approval_id}/decision','POST',approval_decision)

    async def workspace_events(request:Request):
        value=await token(request)
        previous_bots = None
        invalidations = []
        async def observe():
            nonlocal previous_bots
            # Every poll re-checks the session; authorization is never cached by the stream.
            if (await read_store.read(value,'session')).expires_at is None: return None
            snapshot=await guarded(product.workspace.snapshot(value))
            current_bots = {bot['id']: bot.get('appearance') for bot in snapshot['bots']}
            if previous_bots is not None:
                from datetime import datetime, timezone
                from .models import iso_timestamp
                occurred = iso_timestamp(datetime.now(timezone.utc))
                invalidations.extend(dict(type='employee.profile.changed',botId=bot_id,
                    sections=['identity'],occurredAt=occurred) for bot_id,appearance in current_bots.items()
                    if bot_id in previous_bots and previous_bots[bot_id] != appearance)
            previous_bots = current_bots
            # The existing reconnect-ready contract asks clients to fetch authoritative state.
            # Emit only when facts change; this stream grants no write authority or execution retry.
            return (json.dumps([snapshot,product.revision],sort_keys=True,ensure_ascii=False),
                dict(type='workspace.ready',nodes=snapshot['nodes']))
        async def frames():
            from .product_events import ready_event
            async for frame in poll_events(request,'workspace.ready',observe):
                for payload in invalidations:
                    yield ready_event('employee.profile.changed',payload)
                invalidations.clear()
                yield frame
        return event_stream(frames())
    app.add_api_route('/api/v1/workspace/events',workspace_events,methods=['GET'])

    async def channel_events(request:Request,channel_id:str):
        value=await token(request)
        if not 1 <= len(channel_id) <= 128: raise HTTPException(422,'Invalid channel identifier.')
        async with product.transactions.transaction(value) as db: await product.channel(db,channel_id)
        previous_ids = None
        created = []
        async def observe():
            nonlocal previous_ids
            # Messages first: a missing channel or lapsed session ends the stream before Runs are read.
            messages=await read_store.read(value,'messages',channel_id=channel_id)
            if messages.expires_at is None or not messages.found: return None
            runs=await read_store.read(value,'runs',channel_id=channel_id)
            if runs.expires_at is None: return None
            current_ids = {row['id'] for row in messages.rows if row.get('id') is not None}
            if previous_ids is not None:
                from .message_models import project_messages
                created.extend(dict(type='message.created', channelId=channel_id,
                    message=message.model_dump(mode='json',exclude_none=True))
                    for message in project_messages([row for row in messages.rows
                        if row.get('id') is not None and row['id'] not in previous_ids]))
            previous_ids = current_ids
            return (json.dumps([messages.rows,runs.rows,product.revision],sort_keys=True,default=str),
                {'type':'channel.ready','channelId':channel_id})
        async def frames():
            from .product_events import ready_event
            async for frame in poll_events(request,'channel.ready',observe):
                for payload in created:
                    yield ready_event('message.created',payload)
                created.clear()
                yield frame
        return event_stream(frames())
    app.add_api_route('/api/v1/channels/{channel_id}/events',channel_events,methods=['GET'])
