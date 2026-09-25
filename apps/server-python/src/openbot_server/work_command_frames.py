"""Strict command-only frame exports for the existing Worker socket, without authority."""
import base64
from typing import Annotated, Literal
from pydantic import Field, model_validator
from .work_command_contract import Strict, Identity, Uuid, DispatchOperation, bounded_value, parse
from .work_command_v2_contract import PreparationBinding, invalid

PROTOCOL_VERSION='0.10.0'
Token=Annotated[str,Field(min_length=1,max_length=8192,pattern=r'^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')]

class TokenPayload(Strict): token: Token
class ControlOpenPayload(Strict):
    binding: PreparationBinding
    operation: Literal['lookup','stop']
class DispatchPayload(Strict):
    ticket: Token
    operation: DispatchOperation
class Consumed(Strict):
    status: Literal['consumed']
    permit: Token
class Refused(Strict):
    status: Literal['denied','lookup_required']
    code: Literal['authority_changed','connection_changed','invalid_request','expired','unavailable','lookup_required']
class Chunk(Strict):
    fileIndex: Annotated[int,Field(ge=0,le=7)]
    offset: Annotated[int,Field(ge=0,le=20*1024*1024)]
    data: Annotated[str,Field(min_length=4,max_length=21848,pattern=r'^[A-Za-z0-9+/]+={0,2}$')]
    @model_validator(mode='after')
    def bounded_chunk(self):
        try: raw=base64.b64decode(self.data,validate=True)
        except Exception: invalid()
        if not 1<=len(raw)<=16384 or base64.b64encode(raw).decode()!=self.data or self.offset+len(raw)>20*1024*1024: invalid()
        return self
class ChunkAck(Strict):
    fileIndex: Annotated[int,Field(ge=0,le=7)]
    nextOffset: Annotated[int,Field(ge=1,le=20*1024*1024)]
class Frame(Strict):
    protocolVersion: Literal['0.10.0']
    nodeId: Identity
    requestId: Uuid
    preparationId: Uuid
class PrepareExchangeFrame(Frame):
    @model_validator(mode='after')
    def request(self):
        if self.requestId!=self.preparationId: invalid()
        return self
class PrepareOpen(PrepareExchangeFrame):
    type: Literal['work.command.prepare_open']
    payload: PreparationBinding
    @model_validator(mode='after')
    def binding(self):
        if self.nodeId!=self.payload.nodeId or self.preparationId!=self.payload.preparationId: invalid()
        return self
class ChallengeFrame(PrepareExchangeFrame):
    type: Literal['work.command.prepare_challenge']
    payload: TokenPayload
class AuthorizeFrame(PrepareExchangeFrame):
    type: Literal['work.command.prepare_authorize']
    payload: TokenPayload
class ReadyFrame(PrepareExchangeFrame):
    type: Literal['work.command.ready']
    payload: TokenPayload
class DispatchFrame(Frame):
    type: Literal['work.command.dispatch']
    payload: DispatchPayload
class ConsumeFrame(Frame):
    type: Literal['work.command.consume']
    payload: TokenPayload
class ConsumeResultFrame(Frame):
    type: Literal['work.command.consume_result']
    payload: Annotated[Consumed|Refused,Field(discriminator='status')]
class ControlOpenFrame(Frame):
    type: Literal['work.command.control_open']
    payload: ControlOpenPayload
    @model_validator(mode='after')
    def binding(self):
        if self.nodeId!=self.payload.binding.nodeId or self.preparationId!=self.payload.binding.preparationId: invalid()
        return self
class ControlChallengeFrame(Frame):
    type: Literal['work.command.control_challenge']
    payload: TokenPayload
class LookupFrame(Frame):
    type: Literal['work.command.lookup']
    payload: TokenPayload
class LookupResultFrame(Frame):
    type: Literal['work.command.lookup_result']
    payload: TokenPayload
class StopFrame(Frame):
    type: Literal['work.command.stop']
    payload: TokenPayload
class InputChunkFrame(Frame):
    type: Literal['work.command.input_chunk']
    payload: Chunk
class OutputChunkFrame(Frame):
    type: Literal['work.command.output_chunk']
    payload: Chunk
    @model_validator(mode='after')
    def output(self):
        if self.payload.fileIndex!=0 or self.payload.offset+len(base64.b64decode(self.payload.data))>1024*1024: invalid()
        return self
class InputAckFrame(Frame):
    type: Literal['work.command.input_ack']
    payload: ChunkAck
class OutputAckFrame(Frame):
    type: Literal['work.command.output_ack']
    payload: ChunkAck
    @model_validator(mode='after')
    def output(self):
        if self.payload.fileIndex!=0 or self.payload.nextOffset>1024*1024: invalid()
        return self
class ErrorFrame(Frame):
    type: Literal['work.command.error']
    payload: Refused
SERVER_MODELS={k:v for k,v in [('work.command.control_open',ControlOpenFrame),('work.command.prepare_open',PrepareOpen),('work.command.prepare_authorize',AuthorizeFrame),
    ('work.command.dispatch',DispatchFrame),('work.command.consume_result',ConsumeResultFrame),('work.command.lookup',LookupFrame),
    ('work.command.stop',StopFrame),('work.command.input_chunk',InputChunkFrame),('work.command.output_ack',OutputAckFrame),
    ('work.command.error',ErrorFrame)]}
NODE_MODELS={k:v for k,v in [('work.command.control_challenge',ControlChallengeFrame),('work.command.prepare_challenge',ChallengeFrame),('work.command.ready',ReadyFrame),
    ('work.command.consume',ConsumeFrame),('work.command.lookup_result',LookupResultFrame),('work.command.output_chunk',OutputChunkFrame),
    ('work.command.input_ack',InputAckFrame),('work.command.error',ErrorFrame)]}
def parse_command_frame(value,*,server):
    bounded_value(value,maximum=32768)
    if type(value) is not dict: invalid()
    model=(SERVER_MODELS if server else NODE_MODELS).get(value.get('type'))
    if model is None: invalid()
    try:
        result=model.model_validate(value,strict=True).model_dump()
        if bounded_value(result,maximum=32768)!=bounded_value(value,maximum=32768): invalid()
        return result
    except Exception: invalid()
