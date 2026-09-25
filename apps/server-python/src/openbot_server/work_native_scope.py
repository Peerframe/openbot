"""Explicit native Task scope, captured only in the existing single Owner transaction.

Scope declares permitted resources, not standalone authority. Every consumer still needs its
accepted SDK Task/Run, current correction, generation/fence and the resource's live checks.
"""
from contextlib import nullcontext
from copy import deepcopy
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator
from psycopg.types.json import Jsonb

from .control_errors import ControlError
from .work_values import InvalidWork, WorkConflict, canonical


class NativeTaskScope(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    version: int = Field(ge=1,le=1)
    attachmentIds: list[str] = Field(max_length=8)
    collaboratorBotIds: list[str] = Field(max_length=32)
    knowledge: bool
    plugins: bool
    web: bool

    @field_validator('attachmentIds','collaboratorBotIds')
    @classmethod
    def identities(cls,value):
        try:
            parsed=[str(UUID(item)) for item in value]
            if len(set(parsed))!=len(parsed):raise ValueError()
            return sorted(parsed)
        except (ValueError,TypeError,AttributeError):raise ValueError('Invalid native scope identities') from None


def scope_input(value):
    if value is None:return None
    try:return NativeTaskScope.model_validate(value).model_dump()
    except (ValueError,TypeError):raise InvalidWork('invalid_native_task_scope') from None


def scope_lock(files,value):
    if value is not None and value['attachmentIds']:
        if files is None:raise WorkConflict('native_attachment_storage_required')
        return files.lock()
    return nullcontext()


def _attachment(item):
    return dict(id=item['id'],name=item['name'],mediaType=item['mediaType'],sizeBytes=item['sizeBytes'],
                sha256=item['sha256'],metadataSha256=canonical(item)[1])


def validate_attachments(files,scope):
    if files is None:raise WorkConflict('native_attachment_storage_required')
    try:
        files.owner_validate_references(scope['request']['attachmentIds'])
        fresh=[_attachment(files.owner_metadata(identity)) for identity in scope['request']['attachmentIds']]
        if fresh!=scope['attachments']:raise WorkConflict('native_attachment_changed')
        return fresh
    except ControlError:raise WorkConflict('native_attachment_unavailable') from None


async def capture_scope(db,task_id,bot_id,value,files):
    value=scope_input(value)
    if value is None:return
    if bot_id in value['collaboratorBotIds']:raise InvalidWork('native_collaborator_self')
    for identity in value['collaboratorBotIds']:
        bot=await (await db.execute('SELECT computer_profile FROM bots WHERE id=%s FOR SHARE',(identity,))).fetchone()
        if bot is None or bot['computer_profile'] not in ('none','model'):
            raise WorkConflict('native_collaborator_unavailable')
    attachments=[]
    if value['attachmentIds']:
        if files is None:raise WorkConflict('native_attachment_storage_required')
        try:
            files.owner_validate_references(value['attachmentIds'])
            attachments=[_attachment(files.owner_metadata(identity)) for identity in value['attachmentIds']]
        except ControlError:raise WorkConflict('native_attachment_unavailable') from None
    scope=dict(version=1,taskId=task_id,botId=bot_id,request=value,attachments=attachments)
    _,digest=canonical(scope)
    await db.execute('INSERT INTO work_task_scopes(task_id,scope,scope_digest) VALUES(%s,%s,%s)',
                     (task_id,Jsonb(scope),digest))


async def read_scope(db,task_id,bot_id):
    row=await (await db.execute('SELECT scope,scope_digest FROM work_task_scopes WHERE task_id=%s FOR SHARE',(task_id,))).fetchone()
    if row is None:return None
    value=row['scope']
    try:
        if (type(value) is not dict or set(value)!={'version','taskId','botId','request','attachments'}
                or type(value['version']) is not int or value['version']!=1 or value['taskId']!=task_id
                or value['botId']!=bot_id or scope_input(value['request'])!=value['request']
                or type(value['attachments']) is not list or len(value['attachments'])>8
                or [x['id'] for x in value['attachments']]!=value['request']['attachmentIds']
                or canonical(value)[1]!=row['scope_digest']):raise ValueError()
        for item in value['attachments']:
            if (type(item) is not dict or set(item)!={'id','name','mediaType','sizeBytes','sha256','metadataSha256'}
                    or type(item['sizeBytes']) is not int or not 0<item['sizeBytes']<=10*1024*1024
                    or any(type(item[x]) is not str for x in ('id','name','mediaType','sha256','metadataSha256'))):raise ValueError()
        if bot_id in value['request']['collaboratorBotIds']:raise ValueError()
    except (ValueError,TypeError,KeyError,InvalidWork):raise WorkConflict('native_task_scope_changed') from None
    return dict(value=deepcopy(value),sha256=row['scope_digest'])


def capabilities(source):
    native=source.get('native_scope')
    if native is None:return frozenset()
    value=native['value']['request']
    return frozenset([key for key in ('knowledge','plugins','web') if value[key]]+
                     (['attachments'] if value['attachmentIds'] else [])+
                     (['collaboration'] if value['collaboratorBotIds'] else []))


def provenance(source,capability):
    if source.get('source_kind')!='task' or capability not in capabilities(source):
        raise WorkConflict('native_task_capability_unavailable')
    return dict(kind='task',taskId=source['task_id'],profileSha256=source['profile_digest'],
                scopeSha256=source['native_scope']['sha256'])


def public_scope(value):
    if value is None:return dict(scope=None)
    scope=value['value']
    return dict(scope=dict(deepcopy(scope['request']),sha256=value['sha256'],attachments=deepcopy(scope['attachments'])))


async def tool_source(db,task,run,context,capability,*,historical=False):
    """Shared native adapter gate; caller already owns Task and actual SDK correlation.

    Native provenance never impersonates a channel/source Run. Returning it alone grants no
    dispatch: the adapter must still perform its original admission, fence and resource checks.
    """
    from .work_task_profiles import resolve_product_source
    from .work_corrections import check_context
    if (not run or task['bot_id']!=context.bot_id or task['objective']!=context.objective
            or task['token_limit']!=context.token_limit or run['status'] not in ('queued','running')):
        raise WorkConflict('native_task_context_changed')
    source=await resolve_product_source(db,task,context.bot_id)
    result=provenance(source,capability)
    await check_context(db,task,context.run_id,context.correction_token,current=not historical)
    return result
