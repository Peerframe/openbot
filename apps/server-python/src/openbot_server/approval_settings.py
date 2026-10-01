"""Additional Owner confirmation, never a replacement for adapter minimum authority (ADR-0049)."""
from contextlib import nullcontext
from ipaddress import ip_address
import json
import re
from typing import Annotated, Literal
from urllib.parse import unquote, urlsplit, urlunsplit
from uuid import UUID

from pydantic import Field, field_validator, model_validator, ValidationError
from psycopg.types.json import Jsonb

from .authority import OwnerTransactions
from .browser_protocol import Strict
from .control_errors import ControlError
from .work_values import WorkConflict

PROTECTED=('delete','install','permission_change','command','browser','plugin','unknown')

def exact_uuid(value):
    if str(UUID(value))!=value:raise ValueError('An exact UUID is required.')
    return value

def exact_page(value):
    url=urlsplit(value)
    if (url.scheme!='https' or not url.hostname or url.username is not None or url.password is not None
            or url.query or url.fragment or url.port not in (None,443)
            or url.hostname in ('localhost','localhost.localdomain') or url.hostname.endswith('.localhost')
            or any(c.isspace() or ord(c)<32 or c in '\\*' for c in value)
            or urlunsplit(url)!=value or url.netloc!=url.hostname or not url.path.startswith('/')
            or any(unquote(segment) in ('.','..') for segment in url.path.split('/'))
            or not re.fullmatch(r'[a-z0-9.-]+',url.hostname) or '.' not in url.hostname
            or re.search(r'(^|\.)(0x[0-9a-f]+|[0-9]+|local|internal|test|invalid|onion)$',url.hostname)
            or any(not part or len(part)>63 or part[0]=='-' or part[-1]=='-' for part in url.hostname.split('.'))
            or any(ord(c)>126 or ord(c)==127 for c in value)):
        raise ValueError('An exact canonical HTTPS page URL is required.')
    try: address=ip_address(url.hostname)
    except ValueError: address=None
    if address is not None:raise ValueError('Literal address exceptions are refused.')
    return value

class ExceptionTarget(Strict):
    kind: Literal['channel','attachment','page']
    value: Annotated[str,Field(min_length=1,max_length=2048)]
    @model_validator(mode='after')
    def exact(self):
        exact_page(self.value) if self.kind=='page' else exact_uuid(self.value)
        return self

class ApprovalException(Strict):
    botId: Annotated[str,Field(min_length=36,max_length=36)]
    category: Literal['product_read','public_web']
    target: ExceptionTarget
    @field_validator('botId')
    @classmethod
    def bot(cls,value):return exact_uuid(value)
    @model_validator(mode='after')
    def matched(self):
        if (self.category=='public_web')!=(self.target.kind=='page'):raise ValueError('Category/target mismatch.')
        return self

class ApprovalConfiguration(Strict):
    productRead: Literal['inherit','required']
    publicWeb: Literal['inherit','required']
    exceptions: Annotated[list[ApprovalException],Field(max_length=64)]
    @field_validator('exceptions')
    @classmethod
    def unique(cls,value):
        keys=[(e.botId,e.category,e.target.kind,e.target.value) for e in value]
        if len(set(keys))!=len(keys):raise ValueError('Duplicate exception.')
        return value

class ApprovalSettingsInput(ApprovalConfiguration):
    expectedRevision: Annotated[int,Field(ge=1,le=2147483647)]


def operation(intent):
    # Classification cannot grant authority: the live built-in adapter validates the entire intent.
    # Unknown/plugin/provider names never acquire an exception match.
    if type(intent) is not dict or set(intent)!={'kind','tool','arguments','effect'} or intent['kind']!='deferred_tool':return None
    effect=intent['effect'];tool=intent['tool']
    if type(effect) is not dict:return None
    if (effect.get('kind')=='work_reads' and effect.get('version')==1 and type(effect.get('version')) is int
            and effect.get('operation')==tool and tool in ('read_channel_context','read_task_status','list_channel_bots','read_attachment')):
        source=effect.get('source');args=intent['arguments']
        if type(source) is not dict or type(args) is not dict:return None
        target=dict(kind='attachment',value=args.get('attachmentId')) if tool=='read_attachment' else dict(kind='channel',value=source.get('channelId'))
        try:ExceptionTarget.model_validate(target)
        except (ValidationError,ValueError):return ('product_read',None)
        return ('product_read',target)
    if effect.get('kind')=='product_web' and tool in ('fetch','read_public_page','web_search'):
        target=None;selection=effect.get('selection')
        if tool!='web_search' and type(selection) is dict and selection.get('kind')=='page':
            candidate=dict(kind='page',value=selection.get('url'))
            try:ExceptionTarget.model_validate(candidate)
            except (ValidationError,ValueError):pass
            else:target=candidate
        return ('public_web',target)
    return None


def required_for(intent,minimum,configuration,bot_id):
    if minimum:return True
    matched=operation(intent)
    if matched is None:return False # Trusted adapter minimum only; no new exception authority.
    category,target=matched
    mode=configuration['productRead' if category=='product_read' else 'publicWeb']
    if mode=='inherit':return False
    return not (target is not None and any(e['botId']==bot_id and e['category']==category and e['target']==target
                                            for e in configuration['exceptions']))

async def locked_policy(db):
    row=await (await db.execute("SELECT revision,configuration FROM owner_approval_settings WHERE owner_id='owner' FOR SHARE")).fetchone()
    if row is None:raise WorkConflict('approval_policy_unavailable')
    try:value=ApprovalConfiguration.model_validate(row['configuration']).model_dump()
    except (ValidationError,ValueError,TypeError):raise WorkConflict('approval_policy_unavailable') from None
    return row['revision'],value

async def required_in_transaction(db,task,intent,minimum):
    if minimum or operation(intent) is None:return minimum
    _,configuration=await locked_policy(db)
    return required_for(intent,minimum,configuration,task['bot_id'])

async def assert_current(db,task,action):
    # Approved supported reads still require intact policy storage; approval is not a corruption bypass.
    required=await required_in_transaction(db,task,action['intent'],action['baseline_requires_approval'])
    if action['decision']=='approved':return
    if required:
        raise WorkConflict('approval_policy_changed')


def read_decision(action):
    return action['baseline_requires_approval'] is False and action['decision']==('approved' if action['requires_approval'] else 'not_required')

class OwnerApprovalSettings:
    def __init__(self,dsn,files):
        self.transactions=OwnerTransactions(dsn,application_name='openbot-owner-approval-settings')
        self.files=files
    @staticmethod
    def view(revision,value):return dict(revision=revision,**value,protectedExceptionCategories=list(PROTECTED))
    async def snapshot(self,token):
        async with self.transactions.transaction(token) as db:
            try:revision,value=await locked_policy(db)
            except WorkConflict:raise ControlError(503,'approval_policy_unavailable') from None
            return self.view(revision,value)
    async def save(self,token,body):
        value=ApprovalSettingsInput.model_validate(body)
        configuration=value.model_dump(exclude={'expectedRevision'})
        # File lock -> Bot/target -> policy, same authority ordering as task-source admission.
        async with (self.files.lock() if any(e.target.kind=='attachment' for e in value.exceptions) else nullcontext()),self.transactions.transaction(token) as db:
            for entry in value.exceptions:
                bot=await (await db.execute('SELECT id FROM bots WHERE id=%s AND deleted_at IS NULL FOR SHARE',(entry.botId,))).fetchone()
                if not bot:raise ControlError(404,'bot_not_found')
                if entry.target.kind=='channel':
                    if not await (await db.execute('SELECT id FROM channels WHERE id=%s AND deleted_at IS NULL FOR SHARE',(entry.target.value,))).fetchone():
                        raise ControlError(404,'channel_not_found')
                elif entry.target.kind=='attachment':
                    try: item=self.files.owner_metadata(entry.target.value)
                    except ControlError:
                        item=json.loads(self.files._read(entry.target.value+'.json',4096))
                        channel=item.get('channelId')
                        if not isinstance(channel,str):raise ControlError(404,'attachment_not_found')
                        if not await (await db.execute('SELECT id FROM channels WHERE id=%s AND deleted_at IS NULL FOR SHARE',(channel,))).fetchone():raise ControlError(404,'channel_not_found')
                        item=self.files.metadata(channel,entry.target.value)
                    if item.get('deletedAt'):raise ControlError(404,'attachment_not_found')
            row=await (await db.execute("SELECT revision,configuration FROM owner_approval_settings WHERE owner_id='owner' FOR UPDATE")).fetchone()
            if not row:raise ControlError(503,'approval_policy_unavailable')
            try:ApprovalConfiguration.model_validate(row['configuration'])
            except ValidationError:raise ControlError(503,'approval_policy_unavailable') from None
            if row['revision']!=value.expectedRevision:raise ControlError(409,'approval_policy_revision_changed')
            revision=row['revision']
            if row['configuration']!=configuration:
                if revision>=2147483647:raise ControlError(409,'approval_policy_revision_exhausted')
                revision+=1
                await db.execute("UPDATE owner_approval_settings SET configuration=%s,revision=%s WHERE owner_id='owner'",(Jsonb(configuration),revision))
                # Do not copy private target URLs/attachments into generic audit payloads.
                await db.execute("INSERT INTO run_events(id,type,payload,created_at) VALUES(gen_random_uuid()::text,'SETTINGS_APPROVAL_UPDATED',%s,clock_timestamp())",
                    (Jsonb(dict(revision=revision,productRead=value.productRead,publicWeb=value.publicWeb,exceptionCount=len(value.exceptions))),))
            return self.view(revision,configuration)
