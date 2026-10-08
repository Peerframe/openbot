"""Finite P3-to-P4 port; public ingress must refuse this private namespace.

The live registry remains P4-owned. This metadata read grants no Worker assignment or effect.
"""
import hashlib
import hmac
import json
import re
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import Request
from psycopg.types.json import Jsonb
from pydantic import TypeAdapter, ValidationError
import psycopg

from .authority import AuthenticationRequired
from .database import StoreUnavailable

from .control_errors import ControlError
from .http_input import read_json
from .worker_host_identity import digest_secret
from .worker_host_protocol import NodeId, parse_frame
from .worker_host_registry import BrowserHostBinding


def register_runtime_port(app, product, *, secure_cookies, allowed_origins):
    if product.worker_registry is not None:
        product.worker_registry.shared_identity_fence = product.worker_identity.shared_identity_fence
    cookie = '__Host-openbot_session' if secure_cookies else 'openbot_session'

    def route(path, operation, method):
        async def endpoint(request: Request):
            try:
                return await operation(request)
            except ControlError:
                raise
            except AuthenticationRequired:
                raise ControlError(401, 'Authentication required.') from None
            except (ValidationError, ValueError, TypeError, KeyError):
                raise ControlError(422, 'invalid_runtime_input') from None
            except (psycopg.Error, OSError, RuntimeError, TimeoutError):
                raise StoreUnavailable('worker_runtime_unavailable') from None
        app.add_api_route('/_openbot/p4/' + path, endpoint, methods=[method])

    async def snapshot(request: Request):
        if not request.scope.get('openbot.proxy_client'):
            raise ControlError(403, 'private_runtime_peer_required')
        async with product.transactions.transaction(request.cookies.get(cookie)):
            registry = product.worker_registry
            if registry is None:
                raise ControlError(503, 'worker_runtime_unavailable')
            nodes = registry.list()
            if len(nodes) > 4096:
                raise ControlError(503, 'worker_runtime_projection_limit')
            bindings = []
            for node in nodes:
                if not any(c['id']=='browser.session' and c['version']==1 and c['providerId']=='docker' for c in node['capabilityManifest']):
                    continue
                bound = registry.browser_binding(node['id'])
                if bound is not None:
                    bindings.append(dict(nodeId=bound.node_id, connectionId=bound.connection_id,
                                         credentialDigest=bound.credential_digest))
            browser = product.browser
            profiles = browser.profiles if browser is not None else None
            result = dict(nodes=nodes, revision=product.revision, bindings=bindings,
                          browserRoutes=dict(profiles.routes) if profiles is not None else {},
                          legacyHumanControl=bool(browser is not None and browser.agent_gate_configured),
                          humanControl=bool(browser is not None and (browser.agent_gate_configured
                              or profiles is not None and profiles.human_control)))
            if len(json.dumps(result, ensure_ascii=False).encode()) > 4*1024*1024:
                raise ControlError(503, 'worker_runtime_projection_limit')
            return result
    route('snapshot', snapshot, 'GET')

    async def detach(request: Request):
        if not request.scope.get('openbot.proxy_client'):
            raise ControlError(403, 'private_runtime_peer_required')
        value = await read_json(request, max_bytes=1024)
        if not isinstance(value,dict) or set(value)-{'nodeId','enrollmentToken'}:
            raise ControlError(422,'invalid_runtime_detach')
        node_id = TypeAdapter(NodeId).validate_python(value.get('nodeId'), strict=True)
        enrollment = value.get('enrollmentToken')
        if enrollment is not None:
            if not isinstance(enrollment,str) or not re.fullmatch(r'obenr_[A-Za-z0-9_-]{42,250}',enrollment):
                raise ControlError(422,'invalid_runtime_detach')
            async with product.worker_identity._trusted.transaction() as db:
                valid = await (await db.execute("SELECT id FROM node_enrollment_tokens WHERE node_id=%s AND token_digest=%s AND consumed_at IS NULL AND expires_at>clock_timestamp()",(node_id,digest_secret('enrollment',enrollment)))).fetchone()
                if valid is None: raise ControlError(401,'invalid_runtime_detach')
        else:
            if request.headers.get('origin') not in allowed_origins:
                raise ControlError(403,'Request origin is not allowed.')
            async with product.transactions.transaction(request.cookies.get(cookie)):
                pass
        # TS holds the cross-process identity fence. Do not acquire the local handshake lock:
        # an already queued handshake may hold it while waiting for that same fence.
        await product.worker_registry.disconnect(node_id)
        return {'detached': True}
    route('detach', detach, 'POST')
    product.write_routes.append(('POST',re.compile('/_openbot/p4/detach')))

    async def browser_command(request: Request):
        if not request.scope.get('openbot.proxy_client') or request.headers.get('origin') not in allowed_origins:
            raise ControlError(403,'private_runtime_peer_required')
        token=request.cookies.get(cookie)
        async with product.transactions.transaction(token):
            pass
        value=await read_json(request,max_bytes=100000)
        if not isinstance(value,dict) or set(value)!={'ticketId','wire'} or not isinstance(value['wire'],str) or len(value['wire'].encode())>65536:
            raise ControlError(422,'invalid_browser_dispatch')
        ticket_id=value['ticketId']
        if not isinstance(ticket_id,str) or not re.fullmatch(r'[a-f0-9-]{36}',ticket_id):
            raise ControlError(422,'invalid_browser_dispatch')
        document=json.loads(value['wire'])
        if not isinstance(document,dict) or set(document)!={'frame','binding'} or set(document['binding'])!={'nodeId','connectionId','credentialDigest'}:
            raise ControlError(422,'invalid_browser_dispatch')
        frame=parse_frame(document['frame'],server=True)
        if frame['type']!='browser.command' or frame['action']['kind']=='agent':
            raise ControlError(422,'invalid_browser_dispatch')
        binding=BrowserHostBinding(document['binding']['nodeId'],document['binding']['connectionId'],document['binding']['credentialDigest'])
        if binding.node_id!=frame['nodeId']:
            raise ControlError(422,'invalid_browser_dispatch')
        proof=hashlib.sha256(('openbot:browser-dispatch:v1\0'+token+'\0'+value['wire']).encode()).hexdigest()

        async def authority(db,message):
            row=await (await db.execute("SELECT bot_id,node_id,payload FROM run_events WHERE id=%s AND type='BROWSER_TRANSPORT_ADMITTED'",(ticket_id,))).fetchone()
            if row is None or row['bot_id']!=message['botId'] or row['node_id']!=message['nodeId'] or not hmac.compare_digest(str(row['payload'].get('proof','')),proof) or row['payload'].get('requestId')!=message['requestId']:
                raise ControlError(403,'browser_dispatch_not_admitted')
            current,expiry=await product.browser._authority(db,token,message['botId'])
            await product.browser._host_identity(db,binding)
            route=product.browser._route(message['botId'])
            if row['payload'].get('route')!=route or route is not None and route!=message['nodeId']:
                raise ControlError(409,'browser_route_changed')
            pid=row['payload'].get('gatePid')
            if type(pid) is not int: raise ControlError(409,'browser_gate_expired')
            held=await (await db.execute("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted AND pid=%s AND classid=1326850642 AND objid=(hashtext(%s)::bigint & 4294967295)::oid AND objsubid=2 AND database=(SELECT oid FROM pg_database WHERE datname=current_database())",(pid,message['botId']))).fetchone()
            if held is None: raise ControlError(409,'browser_gate_expired')
            expires=datetime.fromisoformat(message['expiresAt'])
            if not 0 < (expires-current).total_seconds() <= 25.1:
                raise ControlError(409,'browser_dispatch_expired')
            message['expiresAt']=min(expires,expiry).isoformat(timespec='milliseconds').replace('+00:00','Z')
            kind=message['action']['kind']
            state=await product.browser.gate.state(db,message['botId'])
            if kind=='maintenance':
                if message['action']['operation']!='status' and state.get('paused') is not True:
                    raise ControlError(409,'browser_control_required')
            elif kind!='observe':
                profiles=product.browser.profiles
                if not product.browser.agent_gate_configured and not(profiles is not None and profiles.human_control and route==message['nodeId']):
                    raise ControlError(503,'browser_agent_gate_not_configured')
                if not state.get('paused') or state.get('sessionId')!=message['sessionId'] or not product.browser._active(state,current):
                    raise ControlError(409,'browser_control_required')
            if 'controlExpiresAt' in message:
                message['controlExpiresAt']=min(datetime.fromisoformat(message['controlExpiresAt']),expiry).isoformat(timespec='milliseconds').replace('+00:00','Z')

        # Claim commits before socket dispatch. The request UUID is a single-use primary key:
        # an uncertain send/commit response cannot make the same ticket executable again.
        async with product.transactions.transaction(token) as db:
            await authority(db,frame)
            claimed=await (await db.execute("INSERT INTO run_events(id,bot_id,node_id,type,payload,created_at) VALUES(%s,%s,%s,'BROWSER_TRANSPORT_CLAIMED',%s,clock_timestamp()) ON CONFLICT(id) DO NOTHING RETURNING id",(frame['requestId'],frame['botId'],frame['nodeId'],Jsonb({'ticketId':ticket_id})))).fetchone()
            if claimed is None: raise ControlError(409,'browser_dispatch_already_claimed')

        @asynccontextmanager
        async def dispatch_guard(message):
            async with product.transactions.transaction(token) as db:
                await authority(db,message)
                yield
        return await product.worker_registry.browser_command(frame,binding=binding,dispatch_guard=dispatch_guard)
    route('browser-command', browser_command, 'POST')
    product.write_routes.append(('POST',re.compile('/_openbot/p4/browser-command')))
