"""Server-owned plugin installation, scopes, approvals and untrusted content lifecycle."""
import asyncio
import json
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from .authority import OwnerTransactions, AuthenticationRequired
from .control_errors import ControlError
from .plugin_inputs import (PluginError, Endpoint, Install, Revision, Update, Enabled, Grant, Call, Content,
    Decision, ResourceResult, PromptResult, LegacyManifestCodec, parse, bounded, clone, public, audit, check_schema)
from .plugin_store import FilePluginStore
from .plugin_transport import MCPConnector, normalize_endpoint


def field(value,name):
    return value.get(name) if isinstance(value,dict) else getattr(value,name,None)


class PluginService:
    """Owner methods are token-first; runtime methods require an injected real Run guard.

    ``connector(endpoint, token)`` is an async context manager, so the official SDK's AnyIO
    scopes enter/exit in one task. ``signal`` is an optional asyncio.Event set on cancellation.
    No network operation holds an Owner SQL transaction. ``run_authority(run)`` optionally
    supplies the native runtime's scope-lock context across durable audit publication.
    """
    def __init__(self,dsn,store_path,*,local_endpoints=(),assert_run_scope=None,run_authority=None,
                 connector=None,codec=None,approval_timeout_ms=60000):
        self.owners=OwnerTransactions(dsn,application_name='openbot-plugins')
        self.store=FilePluginStore(store_path)
        self.local_endpoints=tuple(local_endpoints)
        self.connector=connector or MCPConnector(local_endpoints)
        self.codec=codec or LegacyManifestCodec()
        self.assert_run_scope=assert_run_scope
        self.run_authority=run_authority
        self.approval_timeout=min(60,max(.001,approval_timeout_ms/1000))
        self._pending={}
        self._active={}
        self._closed=False

    async def verify_schema(self):
        await self.owners.verify_schema()

    @asynccontextmanager
    async def _owner_guard(self,token,scope=None,bot_id=None):
        async with self.owners.transaction(token) as connection:
            if scope is not None:
                channel,bot=field(scope,'channelId'),field(scope,'botId')
                if not channel or not bot:raise PluginError('forbidden')
                cursor=await connection.execute('SELECT bot_id FROM channel_bots WHERE channel_id=%s AND bot_id=%s FOR SHARE',(channel,bot))
                if await cursor.fetchone() is None:raise PluginError('forbidden')
            if bot_id is not None:
                cursor=await connection.execute('SELECT id FROM bots WHERE id=%s FOR SHARE',(bot_id,))
                if await cursor.fetchone() is None:raise PluginError('not_found')
            yield

    async def _owner(self,token,scope=None):
        async with self._owner_guard(token,scope):pass

    async def _run(self,run):
        if self.assert_run_scope is None:raise PluginError('forbidden')
        await self.assert_run_scope(run)

    @asynccontextmanager
    async def _run_guard(self,run):
        if self.run_authority is not None:
            async with self.run_authority(run):yield
        else:
            await self._run(run)
            yield
            await self._run(run)

    @staticmethod
    def _find(state,identity,revision):
        plugin=next((p for p in state['plugins'] if p['id']==identity),None)
        if plugin is None:raise PluginError('not_found')
        if plugin['revision']!=revision:raise PluginError('conflict')
        return plugin

    @classmethod
    def _authorize(cls,state,value,bot_id,content=False):
        plugin=cls._find(state,value['pluginId'],value['revision'])
        grant=next((g for g in plugin['grants'] if g['botId']==bot_id),{})
        if not plugin['enabled']:raise PluginError('forbidden')
        if content:
            allowed=value['name'] in grant.get('resources' if value['kind']=='resource' else 'prompts',[])
        else:
            allowed=next((g for g in grant.get('tools',[]) if g['name']==value['toolName']),None)
        if not allowed:raise PluginError('forbidden')
        return plugin,allowed

    def _revoke(self,identity):
        for active in tuple(self._active.values()):
            if active['pluginId']==identity:active['task'].cancel()

    @asynccontextmanager
    async def _operation(self,identity,timeout,signal=None):
        if self._closed or len(self._active)>=16:raise PluginError('unavailable')
        if signal is not None and signal.is_set():raise PluginError('unavailable')
        identifier=str(uuid4()); task=asyncio.current_task(); watcher=None
        self._active[identifier]={'pluginId':identity,'task':task}
        if signal is not None:
            async def watch():
                await signal.wait()
                task.cancel()
            watcher=asyncio.create_task(watch())
        try:
            async with asyncio.timeout(timeout):yield identifier
        except (asyncio.CancelledError,TimeoutError):
            raise PluginError('unavailable') from None
        except (ControlError,AuthenticationRequired):raise
        except Exception:raise PluginError('unavailable') from None
        finally:
            if watcher is not None:
                watcher.cancel()
                await asyncio.gather(watcher,return_exceptions=True)
            self._pending.pop(identifier,None)
            self._active.pop(identifier,None)

    async def _manifest(self,name,endpoint,client):
        tools=await client.tools()
        resources=await client.resources()
        prompts=await client.prompts()
        return self.codec.manifest(name,endpoint,tools,resources,prompts)

    async def _preview(self,token,value,signal=None):
        endpoint=normalize_endpoint(value['endpoint'],self.local_endpoints)
        await self._owner(token)
        async with self._operation(None,30,signal):
            async with self.connector(endpoint,value.get('token')) as client:
                manifest=await self._manifest(value['name'],endpoint,client)
        await self._owner(token)
        return manifest

    async def snapshot(self,token):
        async with self._owner_guard(token):
            state=await self.store.read()
            now=datetime.now(timezone.utc)
            calls=[clone(p['view']) for p in self._pending.values()
                   if p['expires']>now and not p['future'].done()]
            return {'plugins':[public(p) for p in state['plugins']], 'pendingCalls':calls}

    async def preview(self,token,value,*,signal=None):
        return await self._preview(token,parse(Endpoint,value),signal)

    async def install(self,token,value,*,signal=None):
        value=parse(Install,value)
        manifest=await self._preview(token,value,signal)
        if manifest['digest']!=value['reviewedDigest']:raise PluginError('conflict')
        def change(state):
            if signal is not None and signal.is_set():raise PluginError('unavailable')
            if len(state['plugins'])>=16 or any(p['endpoint']==manifest['endpoint'] for p in state['plugins']):
                raise PluginError('conflict')
            plugin={**manifest,'id':str(uuid4()),'revision':str(uuid4()),'enabled':False,'grants':[],
                    'createdAt':datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')}
            if value.get('token'):plugin['token']=value['token']
            state['plugins'].append(plugin)
            audit(state,'installed',plugin['id'])
            return public(plugin)
        return await self.store.transaction(change,authority=lambda:self._owner_guard(token))

    async def preview_update(self,token,identity,value,*,signal=None):
        value=parse(Revision,value)
        await self._owner(token)
        plugin=self._find(await self.store.read(),identity,value['revision'])
        manifest=await self._preview(token,plugin,signal)
        return {'currentDigest':plugin['digest'],'revision':value['revision'],
                'changed':manifest['digest']!=plugin['digest'],'manifest':manifest}

    async def apply_update(self,token,identity,value,*,signal=None):
        value=parse(Update,value)
        preview=await self.preview_update(token,identity,{'revision':value['revision']},signal=signal)
        if preview['manifest']['digest']!=value['reviewedDigest']:raise PluginError('conflict')
        def change(state):
            if signal is not None and signal.is_set():raise PluginError('unavailable')
            plugin=self._find(state,identity,value['revision'])
            plugin.pop('resources',None);plugin.pop('prompts',None)
            plugin.update(preview['manifest']);plugin.update(revision=str(uuid4()),enabled=False,grants=[])
            audit(state,'updated',identity)
            return public(plugin)
        result=await self.store.transaction(change,authority=lambda:self._owner_guard(token))
        self._revoke(identity)
        return result

    async def set_enabled(self,token,identity,value):
        value=parse(Enabled,value)
        def change(state):
            plugin=self._find(state,identity,value['revision'])
            plugin.update(enabled=value['enabled'],revision=str(uuid4()))
            audit(state,'enabled' if value['enabled'] else 'disabled',identity)
            return public(plugin)
        result=await self.store.transaction(change,authority=lambda:self._owner_guard(token))
        self._revoke(identity)
        return result

    async def grant(self,token,identity,bot_id,value):
        value=parse(Grant,value)
        for entries,key in ((value['tools'],'name'),(value['resources'],None),(value['prompts'],None)):
            names=[e[key] if key else e for e in entries]
            if len(set(names))!=len(names):raise PluginError('invalid')
        def change(state):
            plugin=self._find(state,identity,value['revision'])
            for selected,declared in (([t['name'] for t in value['tools']],[t['name'] for t in plugin['tools']]),
                    (value['resources'],[r['uri'] for r in plugin.get('resources',[])]),
                    (value['prompts'],[p['name'] for p in plugin.get('prompts',[])])):
                if not set(selected)<=set(declared):raise PluginError('invalid')
            plugin['grants']=[g for g in plugin['grants'] if g['botId']!=bot_id]
            if value['tools'] or value['resources'] or value['prompts']:
                plugin['grants'].append({'botId':bot_id,'tools':value['tools'],'resources':value['resources'],'prompts':value['prompts']})
            if len(plugin['grants'])>128:raise PluginError('invalid')
            plugin['revision']=str(uuid4());audit(state,'grants_changed',identity,botId=bot_id)
            return public(plugin)
        result=await self.store.transaction(change,authority=lambda:self._owner_guard(token,bot_id=bot_id))
        self._revoke(identity)
        return result

    async def remove(self,token,identity,value):
        value=parse(Revision,value)
        def change(state):
            self._find(state,identity,value['revision'])
            state['plugins']=[p for p in state['plugins'] if p['id']!=identity]
            audit(state,'removed',identity)
            return {'deleted':True}
        result=await self.store.transaction(change,authority=lambda:self._owner_guard(token))
        self._revoke(identity)
        return result

    async def catalog(self,run):
        await self._run(run)
        tools=[];truncated=False
        for plugin in (await self.store.read())['plugins']:
            if not plugin['enabled']:continue
            grant=next((g for g in plugin['grants'] if g['botId']==field(run,'botId')), {})
            for allowed in grant.get('tools',[]):
                tool=next((t for t in plugin['tools'] if t['name']==allowed['name']),None)
                if tool is None:continue
                item={'pluginId':plugin['id'],'revision':plugin['revision'],'pluginName':plugin['name'],
                      'toolName':tool['name'],'description':tool['description'][:500],
                      'inputSchema':tool['inputSchema'],'mode':allowed['mode']}
                if len(tools)>=16 or len(bounded(tools+[item],128*1024))>12*1024:
                    truncated=True;continue
                tools.append(item)
        return {'tools':tools,'truncated':truncated}

    async def _content_catalog(self,bot_id):
        items=[];truncated=False
        for plugin in (await self.store.read())['plugins']:
            if not plugin['enabled']:continue
            grant=next((g for g in plugin['grants'] if g['botId']==bot_id),{})
            selected=[]
            for resource in plugin.get('resources',[]):
                if resource['uri'] in grant.get('resources',[]):
                    selected.append({'kind':'resource','name':resource['uri'],'description':resource['description'],
                        **({'mimeType':resource['mimeType']} if 'mimeType' in resource else {})})
            for prompt in plugin.get('prompts',[]):
                if prompt['name'] in grant.get('prompts',[]):
                    selected.append({'kind':'prompt','name':prompt['name'],'description':prompt['description'],'arguments':prompt['arguments']})
            for item in selected:
                entry={'pluginId':plugin['id'],'revision':plugin['revision'],'pluginName':plugin['name'],**item}
                if len(items)>=32 or len(bounded(items+[entry],256*1024))>12*1024:truncated=True;continue
                items.append(entry)
        return {'items':items,'truncated':truncated}

    async def content_catalog(self,run):
        await self._run(run)
        return await self._content_catalog(field(run,'botId'))

    async def owner_content_catalog(self,token,scope):
        async with self._owner_guard(token,scope):
            return await self._content_catalog(field(scope,'botId'))

    async def read_content(self,run,value,*,signal=None):
        return await self._read_content(run,value,lambda:self._run_guard(run),signal)

    async def owner_read_content(self,token,scope,value,*,signal=None):
        return await self._read_content(scope,value,lambda:self._owner_guard(token,scope),signal)

    async def _read_content(self,scope,value,authority,signal):
        value=parse(Content,value,12*1024);bot_id=field(scope,'botId')
        async with authority():pass
        plugin,_=self._authorize(await self.store.read(),value,bot_id,True)
        if value['kind']=='resource' and value['arguments']:raise PluginError('invalid')
        if value['kind']=='prompt':
            prompt=next((p for p in plugin.get('prompts',[]) if p['name']==value['name']),None)
            if prompt is None or not set(value['arguments'])<={a['name'] for a in prompt['arguments']} or any(a.get('required') and a['name'] not in value['arguments'] for a in prompt['arguments']):
                raise PluginError('invalid')
        async with self._operation(plugin['id'],30,signal) as identifier:
            async with self.connector(plugin['endpoint'],plugin.get('token')) as client:
                current=await self._manifest(plugin['name'],plugin['endpoint'],client)
                if current['digest']!=plugin['digest']:raise PluginError('conflict')
                def record(state,phase):
                    self._authorize(state,value,bot_id,True)
                    audit(state,phase,plugin['id'],botId=bot_id,callId=identifier,
                          **({'runId':field(scope,'id')} if field(scope,'id') else {}))
                await self.store.transaction(lambda s:record(s,value['kind']+'_reading'),authority=authority)
                if value['kind']=='resource':
                    raw=await client.read_resource(value['name']);result=parse(ResourceResult,raw,160*1024)
                else:
                    raw=await client.get_prompt(value['name'],value['arguments']);result=parse(PromptResult,raw,12*1024)
                is_app=value['kind']=='resource' and any(r['uri']==value['name'] and r.get('mimeType')=='text/html;profile=mcp-app' for r in plugin.get('resources',[]))
                bounded(result,160*1024 if is_app else 12*1024)
                if any(c['uri']!=value['name'] or (c.get('mimeType')=='text/html;profile=mcp-app' and not is_app) for c in result.get('contents',[])):
                    raise PluginError('invalid')
                if is_app and (not value['name'].startswith('ui://') or len(result.get('contents',[]))!=1 or result['contents'][0].get('mimeType')!='text/html;profile=mcp-app'):
                    raise PluginError('invalid')
                await self.store.transaction(lambda s:record(s,value['kind']+'_read'),authority=authority)
                return {'plugin':plugin['name'],'kind':value['kind'],'name':value['name'],'result':result,'untrusted':True}

    async def call(self,run,value,*,signal=None):
        value=parse(Call,value,16*1024);bounded(value['arguments'],8*1024)
        await self._run(run)
        bot_id=field(run,'botId');run_id=field(run,'id')
        plugin,grant=self._authorize(await self.store.read(),value,bot_id)
        tool=next((t for t in plugin['tools'] if t['name']==value['toolName']),None)
        if tool is None or not check_schema(tool['inputSchema']).is_valid(value['arguments']):raise PluginError('invalid')
        async with self._operation(plugin['id'],120,signal) as identifier:
            def record(state,phase):
                self._authorize(state,value,bot_id)
                audit(state,phase,plugin['id'],botId=bot_id,runId=run_id,callId=identifier,toolName=value['toolName'])
            try:
                async with self.connector(plugin['endpoint'],plugin.get('token')) as client:
                    manifest=await self._manifest(plugin['name'],plugin['endpoint'],client)
                    if manifest['digest']!=plugin['digest']:raise PluginError('conflict')
                    await self._run(run)
                    self._authorize(await self.store.read(),value,bot_id)
                    if grant['mode']=='confirm':
                        await self.store.transaction(lambda s:record(s,'approval_requested'),authority=lambda:self._run_guard(run))
                        expires=datetime.now(timezone.utc)+timedelta(seconds=self.approval_timeout)
                        future=asyncio.get_running_loop().create_future()
                        view={'id':identifier,'pluginId':plugin['id'],'pluginName':plugin['name'],
                              'toolName':value['toolName'],'botId':bot_id,'channelId':field(run,'channelId'),
                              'runId':run_id,'arguments':clone(value['arguments']),
                              'expiresAt':expires.isoformat(timespec='milliseconds').replace('+00:00','Z')}
                        self._pending[identifier]={'view':view,'run':run,'value':value,'expires':expires,'future':future}
                        try:
                            try:decision=await asyncio.wait_for(future,self.approval_timeout)
                            except TimeoutError:raise PluginError('expired') from None
                            if decision!='approve':raise PluginError('rejected')
                        finally:self._pending.pop(identifier,None)
                        manifest=await self._manifest(plugin['name'],plugin['endpoint'],client)
                        if manifest['digest']!=plugin['digest']:raise PluginError('conflict')
                    await self.store.transaction(lambda s:record(s,'dispatching'),authority=lambda:self._run_guard(run))
                    result=await client.call(value['toolName'],value['arguments']);bounded(result,12*1024)
                    await self.store.transaction(lambda s:record(s,'completed'),authority=lambda:self._run_guard(run))
                    return {'plugin':plugin['name'],'tool':value['toolName'],'result':result,'untrusted':True}
            except BaseException:
                # The audit contains only identifiers, even if an external operation had unknown completion.
                try:
                    await self.store.transaction(lambda state:audit(state,'failed',plugin['id'],botId=bot_id,
                                        runId=run_id,callId=identifier,toolName=value['toolName']))
                except Exception:pass
                raise

    @staticmethod
    def _work_equal(left, right):
        # Python mapping equality aliases true/1 and 1/1.0; dispatch binds exact JSON values.
        return json.dumps(left,sort_keys=True,ensure_ascii=False,separators=(',',':'),allow_nan=False)==json.dumps(
            right,sort_keys=True,ensure_ascii=False,separators=(',',':'),allow_nan=False)

    @staticmethod
    def _work_input(tool, value):
        if tool == 'call_plugin':
            value=parse(Call,value,16*1024);bounded(value['arguments'],8*1024)
            return value
        if tool == 'read_plugin_resource' and type(value) is dict and set(value)=={'pluginId','revision','name'}:
            return parse(Content,{**value,'kind':'resource'},12*1024)
        raise PluginError('invalid')

    @classmethod
    def _work_snapshot(cls, state, bot_id, tool_name, arguments):
        value=cls._work_input(tool_name,arguments)
        resource=tool_name=='read_plugin_resource'
        plugin,grant=cls._authorize(state,value,bot_id,resource)
        if resource:
            declaration=next((r for r in plugin.get('resources',[]) if r['uri']==value['name']),None)
            if (declaration is None or value['name'].startswith('ui://')
                    or declaration.get('mimeType')=='text/html;profile=mcp-app'):
                raise PluginError('forbidden')
            mode='read'
        else:
            declaration=next((t for t in plugin['tools'] if t['name']==value['toolName']),None)
            if declaration is None or not check_schema(declaration['inputSchema']).is_valid(value['arguments']):
                raise PluginError('invalid')
            mode=grant['mode']
        return plugin,dict(pluginId=plugin['id'],revision=plugin['revision'],manifestDigest=plugin['digest'],
                           tool=tool_name,mode=mode,declaration=clone(declaration))

    @asynccontextmanager
    async def _work_state(self, authority):
        if not callable(authority) or self._closed:raise PluginError('forbidden')
        # Match dispatch's file -> SQL lock order; Task -> file could deadlock a concurrent
        # dispatch holding the file lease while acquiring its Task UPDATE lock.
        async with self.store._lock:
            with self.store._lease() as root:
                self.store._recover(root)
                async with authority():
                    yield self.store._load(root)

    async def prepare_work(self, bot_id, tool, arguments, *, authority):
        """Trusted Work composition only. Snapshot grants/schema; no approval or network I/O."""
        async with self._work_state(authority) as state:
            _,snapshot=self._work_snapshot(state,bot_id,tool,arguments)
            return snapshot

    @asynccontextmanager
    async def locked_work_validation(self):
        """Hold a read lease before the caller's SQL transaction; confer no tool authority.

        The yielded checker only compares an already-recorded grant. It cannot return private
        state or dispatch anything, and is invalid once the lease ends. The Work adapter still
        checks actual Activity identity, Task authority and receipts in the caller's transaction.
        """
        if self._closed: raise PluginError('forbidden')
        live=True
        async with self.store._lock:
            with self.store._lease() as root:
                self.store._recover(root)
                state=self.store._load(root)
                def check(bot_id, tool, arguments, snapshot):
                    if not live: raise PluginError('forbidden')
                    _,fresh=self._work_snapshot(state,bot_id,tool,arguments)
                    if not self._work_equal(fresh,snapshot): raise PluginError('conflict')
                    return True
                try: yield check
                finally: live=False

    async def catalog_work(self, bot_id, *, authority):
        """Retained bounded model catalog under current Work scope; no prompt/app HTML tool."""
        async with self._work_state(authority) as state:
            tools=[];resources=[];truncated=False
            for plugin in state['plugins']:
                if not plugin['enabled']:continue
                grant=next((g for g in plugin['grants'] if g['botId']==bot_id),{})
                prefix=dict(pluginId=plugin['id'],revision=plugin['revision'],pluginName=plugin['name'])
                for allowed in grant.get('tools',[]):
                    tool=next((t for t in plugin['tools'] if t['name']==allowed['name']),None)
                    if tool is None:continue
                    entry={**prefix,'toolName':tool['name'],'description':tool['description'][:500],
                           'inputSchema':clone(tool['inputSchema']),'mode':allowed['mode']}
                    if len(tools)>=16 or len(bounded(tools+[entry],128*1024))>12*1024:truncated=True
                    else:tools.append(entry)
                for resource in plugin.get('resources',[]):
                    if (resource['uri'] not in grant.get('resources',[]) or resource['uri'].startswith('ui://')
                            or resource.get('mimeType')=='text/html;profile=mcp-app'):continue
                    entry={**prefix,'kind':'resource','name':resource['uri'],'description':resource['description'],
                           **({'mimeType':resource['mimeType']} if 'mimeType' in resource else {})}
                    if len(resources)>=32 or len(bounded(resources+[entry],256*1024))>12*1024:truncated=True
                    else:resources.append(entry)
            return dict(tools=tools,resources=resources,truncated=truncated)

    async def invoke_work(self, bot_id, run_id, action_id, snapshot, arguments, *, authority):
        """One Work-admitted transport operation, with no pending Future or approval bypass flag.

        ``authority`` is an injected control async-context-manager factory, not model input.
        It must validate and consume the exact admitted Action in one transaction, committing
        before transport starts. The reviewed MCP connector invokes it at the actual POST seam.
        A received response may be recorded as historical observation after authority is revoked.
        """
        if not callable(authority) or type(snapshot) is not dict:raise PluginError('forbidden')
        tool=snapshot.get('tool')
        plugin,current=self._work_snapshot(await self.store.read(),bot_id,tool,arguments)
        if not self._work_equal(current,snapshot):raise PluginError('conflict')
        value=self._work_input(tool,arguments)
        method='resources/read' if tool=='read_plugin_resource' else 'tools/call'
        params={'uri':value['name']} if method=='resources/read' else {'name':value['toolName'],'arguments':value['arguments']}
        dispatched=False
        async def before_request(message):
            nonlocal dispatched
            if dispatched or message.get('method')!=method or not self._work_equal(message.get('params'),params):
                raise PluginError('forbidden')
            def consume(state):
                _,fresh=self._work_snapshot(state,bot_id,tool,arguments)
                if not self._work_equal(fresh,snapshot):raise PluginError('conflict')
                audit(state,'work_dispatching',plugin['id'],botId=bot_id,runId=run_id,callId=action_id)
            # File publication and the Work dispatch marker commit together under the existing
            # rollback journal; no long-lived SQL transaction survives into network I/O.
            await self.store.transaction(consume,authority=authority)
            dispatched=True
        async with self._operation(plugin['id'],30):
            async with self.connector(plugin['endpoint'],plugin.get('token'),before_request=before_request) as client:
                manifest=await self._manifest(plugin['name'],plugin['endpoint'],client)
                if manifest['digest']!=snapshot['manifestDigest']:raise PluginError('conflict')
                if method=='tools/call':
                    result=await client.call_observed(value['toolName'],value['arguments'])
                    bounded(result,12*1024)
                    output={'plugin':plugin['name'],'tool':value['toolName'],'result':result,'untrusted':True}
                else:
                    result=parse(ResourceResult,await client.read_resource(value['name']),12*1024)
                    if any(c['uri']!=value['name'] or c.get('mimeType')=='text/html;profile=mcp-app' for c in result['contents']):
                        raise PluginError('invalid')
                    output={'plugin':plugin['name'],'kind':'resource','name':value['name'],'result':result,'untrusted':True}
                if not dispatched:raise PluginError('forbidden')
                # The durable ToolResults receipt is the authoritative observation/audit record.
                # A late response does not renew plugin grants or authorize another effect.
                return output

    async def decide(self,token,identifier,value):
        value=parse(Decision,value)
        await self._owner(token)
        pending=self._pending.get(identifier)
        if pending is None:raise PluginError('not_found')
        await self._run(pending['run'])
        def change(state):
            if self._pending.get(identifier) is not pending or pending['future'].done():raise PluginError('not_found')
            if pending['expires']<=datetime.now(timezone.utc):raise PluginError('expired')
            self._authorize(state,pending['value'],field(pending['run'],'botId'))
            audit(state,'approved' if value['decision']=='approve' else 'rejected',pending['value']['pluginId'],
                  botId=field(pending['run'],'botId'),runId=field(pending['run'],'id'),callId=identifier,
                  toolName=pending['value']['toolName'])
        await self.store.transaction(change,authority=lambda:self._owner_guard(token))
        if self._pending.get(identifier) is not pending or pending['future'].done():raise PluginError('not_found')
        self._pending.pop(identifier,None)
        pending['future'].set_result(value['decision'])
        return {'decided':True}

    async def close(self):
        self._closed=True
        tasks={a['task'] for a in self._active.values()}
        for task in tasks:task.cancel()
        if tasks:await asyncio.gather(*tasks,return_exceptions=True)
