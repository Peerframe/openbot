"""Bounded original-connection exchanges around the existing command authority service."""
import asyncio
import base64
from contextlib import asynccontextmanager
import hashlib
from uuid import uuid4

from .work_command_contract import Command, parse
from .work_command_crypto import _parts
from .work_command_frames import parse_command_frame
from .work_command_store import now_ms
from .work_command_v2_contract import PreparationBinding
from .work_values import WorkConflict
from .worker_host_commands import CommandChannelConfiguration, CommandChannelError


class CommandInbox:
    """A bounded correlation inbox, not an authority cache or background execution loop."""
    def __init__(self):
        self.transport=None
        self.sessions={}
        self.configuration=CommandChannelConfiguration(self.receive,on_disconnected=self.disconnected)

    def attach(self,transport):
        if self.transport is not None or transport is None:
            raise WorkConflict('command_channel_composition_changed')
        self.transport=transport

    def receive(self,pending):
        frame=pending.frame
        session=self.sessions.get((pending.connection,frame['preparationId']))
        if session is None or session.closed or session.queue.full():return False
        session.queue.put_nowait(pending)
        return True

    def disconnected(self,connection):
        for (original,_),session in tuple(self.sessions.items()):
            if original is connection:session.close()

    @asynccontextmanager
    async def exchange(self,connection,binding):
        binding=parse(PreparationBinding,binding).model_dump()
        key=(connection,binding['preparationId'])
        if self.transport is None or key in self.sessions or len(self.sessions)>=64:
            raise WorkConflict('command_exchange_unavailable')
        session=_Exchange(self,connection,binding)
        self.sessions[key]=session
        try:yield session
        finally:
            session.close()
            if self.sessions.get(key) is session:del self.sessions[key]


class _Exchange:
    def __init__(self,inbox,connection,binding):
        self.inbox,self.connection,self.binding=inbox,connection,binding
        self.queue=asyncio.Queue(maxsize=4)
        self.closed=False
        self.active=None

    def close(self):
        if self.closed:return
        self.closed=True
        while not self.queue.empty():
            pending=self.queue.get_nowait()
            if pending is not None:self.complete(pending)
        self.queue.put_nowait(None)

    def complete(self,pending):
        try:self.inbox.transport.complete(pending)
        except CommandChannelError:
            if not self.closed:raise

    def frame(self,kind,request,payload):
        return parse_command_frame(dict(type='work.command.'+kind,protocolVersion='0.10.0',
            nodeId=self.binding['nodeId'],preparationId=self.binding['preparationId'],
            requestId=request,payload=payload),server=True)

    async def send(self,kind,request,payload):
        if self.closed:raise WorkConflict('command_exchange_closed')
        await self.inbox.transport.send(self.connection,self.frame(kind,request,payload))

    @asynccontextmanager
    async def take(self,kind,request=None,*,timeout=5):
        if self.closed or self.active is not None:raise WorkConflict('command_exchange_closed')
        async with asyncio.timeout(timeout):pending=await self.queue.get()
        if pending is None:raise WorkConflict('command_exchange_closed')
        self.active=pending
        try:
            frame=pending.frame
            if (frame['type']!='work.command.'+kind or frame['nodeId']!=self.binding['nodeId']
                    or frame['preparationId']!=self.binding['preparationId']
                    or request is not None and frame['requestId']!=request):
                raise WorkConflict('command_exchange_changed')
            yield pending,frame
        finally:
            self.active=None
            self.complete(pending)

    async def reply(self,pending,kind,payload):
        await self.inbox.transport.reply(pending,self.frame(kind,pending.frame['requestId'],payload))


class CommandChannelDriver:
    """No retry or new Work authority. All prepare/admit/consume gates stay in CommandDispatches."""
    def __init__(self,service,inbox):
        if type(inbox) is not CommandInbox or service.transport is not inbox.transport:
            raise WorkConflict('command_channel_composition_changed')
        self.service,self.inbox=service,inbox

    @staticmethod
    def _blobs(command,blobs):
        checked=parse(Command,command)
        if type(blobs) is not dict or set(blobs)!={item.path for item in checked.inputManifest}:
            raise WorkConflict('command_input_manifest_changed')
        for item in checked.inputManifest:
            data=blobs[item.path]
            if (type(data) is not bytes or len(data)!=item.size
                    or hashlib.sha256(data).hexdigest()!=item.sha256):
                raise WorkConflict('command_input_manifest_changed')
        return checked

    async def execute(self,context,action_id,*,fence,connection,command,attachments,blobs):
        """Single preparation, admission and delivery. A missing ACK never restarts this path."""
        checked=self._blobs(command,blobs)
        reserved=await self.service.reserve(context,action_id,fence=fence,connection=connection,
            command=checked.model_dump(),attachments=attachments)
        if reserved['status']!='reserved':return dict(status='lookup_required')
        binding=reserved['binding'];prep=binding['preparationId']
        async with self.inbox.exchange(connection,binding) as session:
            async with asyncio.timeout(self.service.timing_policy.prepareBudgetMs/1000):
                await session.send('prepare_open',prep,binding)
                async with session.take('prepare_challenge',prep) as (pending,frame):
                    result=await self.service.authorize_preparation(connection,action_id,frame['payload']['token'])
                    if result['status']!='authorized':raise WorkConflict('command_preparation_refused')
                    await session.reply(pending,'prepare_authorize',dict(token=result['authorization']))
                for index,item in enumerate(checked.inputManifest):
                    data=blobs[item.path]
                    for offset in range(0,len(data),16384):
                        chunk=data[offset:offset+16384]
                        await session.send('input_chunk',prep,dict(fileIndex=index,offset=offset,
                            data=base64.b64encode(chunk).decode('ascii')))
                        async with session.take('input_ack',prep,timeout=self.service.timing_policy.prepareBudgetMs/1000) as (_,frame):
                            if frame['payload']!=dict(fileIndex=index,nextOffset=offset+len(chunk)):
                                raise WorkConflict('command_input_ack_changed')
                async with session.take('ready',prep,timeout=self.service.timing_policy.prepareBudgetMs/1000) as (_,frame):
                    result=await self.service.accept_ready(connection,action_id,frame['payload']['token'])
                    if result['status']!='ready':raise WorkConflict('command_preparation_refused')
            issued=await self.service.admit(context,action_id,fence=fence,connection=connection,preparation_id=prep)
            if issued['status']!='issued':return dict(status='lookup_required')
            # The token is issued by this service; its fixed ID is only wire correlation.
            dispatch=_parts(issued['ticket'])[1]['dispatchId']
            await session.send('dispatch',dispatch,dict(ticket=issued['ticket'],operation=issued['operation']))
            async with session.take('consume') as (pending,frame):
                token=frame['payload']['token'];payload=_parts(token)[1]
                result=await self.service.consume(connection,action_id,token,
                    request_id=frame['requestId'],nonce=payload.get('nonce'))
                if result['status']!='consumed':raise WorkConflict('command_consume_refused')
                await session.reply(pending,'consume_result',result)
            return dict(status='dispatched')

    async def lookup(self,connection,action_id,*,include_output):
        """Return only a fresh original signed receipt plus exact hashed bounded bytes."""
        original=await self.service.original(action_id)
        binding={k:original['binding'][k] for k in PreparationBinding.model_fields}
        request=str(uuid4())
        async with self.inbox.exchange(connection,binding) as session:
            await session.send('control_open',request,dict(binding=binding,operation='lookup'))
            async with session.take('control_challenge',request) as (pending,frame):
                challenge=frame['payload']['token'];nonce=_parts(challenge)[1].get('nonce')
                authorized=await self.service.authorize_lookup(connection,action_id,challenge,
                    request_id=request,nonce=nonce,include_output=include_output)
                await session.reply(pending,'lookup',dict(token=authorized['token']))
            async with session.take('lookup_result',request) as (_,frame):
                token=frame['payload']['token']
                async with self.service.store._transaction(trusted=True) as db:current=await now_ms(db)
                receipt=self.service.verifier.verify(token,purpose='work_command_receipt',
                    issuer=self.service.enforcement_issuer,audience=self.service.control_issuer,
                    expected_binding=original['binding'],expected_request=dict(requestId=request,nonce=nonce),now_ms=current)
                if receipt.permitDigest!=original['permitDigest']:
                    raise WorkConflict('command_permit_record_changed')
                observation=receipt.observation
                if observation.outputs and not include_output:raise WorkConflict('command_output_scope_changed')
            output=b''
            if observation.outputs:
                observed=observation.outputs[0];expected=original['operation']['command']['output']
                if (observed.name!=expected['name'] or observed.mediaType!=expected['mediaType']
                        or observed.sizeBytes>expected['maxBytes']):raise WorkConflict('command_output_changed')
                while len(output)<observed.sizeBytes:
                    async with session.take('output_chunk',request) as (pending,frame):
                        chunk=frame['payload'];data=base64.b64decode(chunk['data'],validate=True)
                        if chunk['fileIndex']!=0 or chunk['offset']!=len(output) or len(output)+len(data)>observed.sizeBytes:
                            raise WorkConflict('command_output_changed')
                        output+=data
                        await session.reply(pending,'output_ack',dict(fileIndex=0,nextOffset=len(output)))
                if hashlib.sha256(output).hexdigest()!=observed.sha256:
                    raise WorkConflict('command_output_changed')
                output.decode('utf-8','strict')
            # Recheck receipt signature/binding/expiry after chunk I/O. This is observation only;
            # the caller must separately revalidate current Work authority before publication.
            async with self.service.store._transaction(trusted=True) as db:current=await now_ms(db)
            self.service.verifier.verify(token,purpose='work_command_receipt',issuer=self.service.enforcement_issuer,
                audience=self.service.control_issuer,expected_binding=original['binding'],
                expected_request=dict(requestId=request,nonce=nonce),now_ms=current)
            return dict(token=token,receipt=receipt.model_dump(),output=output)
